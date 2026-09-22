/**
 * The shell tool (ported from dsh-tool-bash with the executor semantics of
 * dsh-bash-local and dsh-bash-sandbox). Not persistent: every call is a
 * fresh `bash -c` (`pwsh -NoProfile -Command` on win32, tool name `pwsh`).
 *
 * One call: validate → resolve the session's sandbox policy → optional
 * one-shot escalation (approved by the user) → confine the argv for
 * read-only / workspace-write (fail closed: SANDBOX_UNAVAILABLE, the command
 * never runs unconfined) → spawn a detached process group under a timeout →
 * render stdout/stderr tails + markers. `run_in_background` hands the same
 * process to the {@link JobRegistry} instead.
 */

import { statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { z } from 'zod'
import { clampTimeout, deadline, timeoutOf } from '../../../../util/timeout'
import type { JobOutcome, JobRegistry } from '../../../jobs/registry'
import type { SystemPromptAssembler } from '../../../prompt/assembler'
import {
  classifyConfinedStderr,
  type ConfinedArgv,
} from '../../../sandbox/backend'
import {
  approveEscalation,
  escalationFields,
} from '../../../sandbox/escalation'
import {
  canonicalPath,
  SandboxUnavailableError,
  validateEscalationArgs,
  type SandboxExecutionPolicy,
  type SandboxMode,
} from '../../../sandbox/policy'
import {
  defineTool,
  TOOL_ABORTED,
  ToolError,
  type ToolDefinition,
  type ToolRunContext,
} from '../../definition'
import type { ToolServices } from '../../services'
import { buildShellEnv, EMPEROR_ENV_PREFIX } from './env'
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_SPILL_BYTES } from './output'
import { DEFAULT_GRACE_MS, spawnManaged, type ManagedProcess } from './process'
import {
  renderProcessRead,
  renderResult,
  type ShellRunResult,
  type ShellSandboxInfo,
} from './render'

export const DEFAULT_SHELL_TIMEOUT_MS = 60_000
export const MAX_SHELL_TIMEOUT_MS = 600_000
export const SHELL_TIMEOUT = 'BASH_TIMEOUT'

export interface ShellToolOptions {
  /** Background job registry; absent → `run_in_background` is rejected. */
  jobs?: JobRegistry
  /** Platform override (tests); selects bash vs pwsh. */
  platform?: NodeJS.Platform
  defaultTimeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  maxSpillBytes?: number
  graceMs?: number
}

export function shellToolName(
  platform: NodeJS.Platform = process.platform,
): 'bash' | 'pwsh' {
  return platform === 'win32' ? 'pwsh' : 'bash'
}

function shellArgv(platform: NodeJS.Platform, command: string): string[] {
  return platform === 'win32'
    ? ['pwsh', '-NoProfile', '-Command', command]
    : ['bash', '-c', command]
}

export const SHELL_PROMPT_SECTION =
  'Check the [exit code: N] marker on every {shell} result; investigate failures before moving on. ' +
  'Each call runs in a fresh shell: pass `workdir` instead of using `cd`, and do not rely on variables or functions from earlier calls.'

/** Contribute the cross-call shell guidance (order 105). */
export function installShellPromptSection(
  prompt: SystemPromptAssembler,
  options: { platform?: NodeJS.Platform } = {},
): () => void {
  const name = shellToolName(options.platform)
  return prompt.section({
    name: `tool:${name}`,
    order: 105,
    text: SHELL_PROMPT_SECTION.replace('{shell}', name),
  })
}

function shellDescription(
  platform: NodeJS.Platform,
  background: boolean,
): string {
  const invocation =
    platform === 'win32'
      ? 'Execute a PowerShell command (`pwsh -NoProfile -Command`) and return its stdout/stderr. '
      : 'Execute a bash command (`bash -c`) and return its stdout/stderr. '
  const backgroundText = background
    ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
    : 'Background execution is not available; long-running commands must finish within the timeout.'
  return (
    invocation +
    'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — ' +
    'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. ' +
    `Current harness environment facts are exposed through managed \`$${EMPEROR_ENV_PREFIX}*\` variables; inspect them when needed. ` +
    'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. ' +
    'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. ' +
    backgroundText +
    ' Attempting a command the sandbox may deny is safe and expected: run it and read the ' +
    'marker rather than assuming the denial. When a command is denied and a wider mode would let it ' +
    'succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry ' +
    'the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) ' +
    'plus a one-sentence `justification`. Do not detour through chat to ask permission first — the ' +
    'approval prompt raised by that retry is how the user consents. If the session states approval ' +
    'prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. ' +
    'Never escalate speculatively: ground the request in a real denial — normally the one this command ' +
    'just hit; escalating up front is fine only when this session already denied the same access. ' +
    'A rejected escalation is final for that command — stop and explain, never work around ' +
    'it — but it does not forbid attempting or escalating other commands later.'
  )
}

const shellInput = z.object({
  command: z.string().describe('The command to execute.'),
  description: z
    .string()
    .describe(
      'Clear, concise description of what this command does in active voice, ' +
        '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; ' +
        '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
    ),
  timeoutMs: z
    .number()
    .optional()
    .describe(
      `Timeout in milliseconds (default ${DEFAULT_SHELL_TIMEOUT_MS}, max ${MAX_SHELL_TIMEOUT_MS}); the command is killed on expiry.`,
    ),
  workdir: z
    .string()
    .optional()
    .describe(
      'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
    ),
  ...escalationFields,
})

export type ShellToolArgs = z.output<typeof shellInput>

function validateArgs(args: ShellToolArgs): void {
  if (args.command.trim().length === 0)
    throw new ToolError(
      'invalid command: expected a non-empty string',
      'INVALID_ARGS',
    )
  if (args.description.trim().length === 0)
    throw new ToolError(
      'invalid description: expected a non-empty string',
      'INVALID_ARGS',
    )
  if (
    args.timeoutMs !== undefined &&
    (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)
  ) {
    throw new ToolError(
      `invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`,
      'INVALID_ARGS',
    )
  }
  validateEscalationArgs(args.sandbox_permissions, args.justification)
}

function abortedError(): ToolError {
  const error = new ToolError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

/** Explicit workdir (relative → against the policy root), else the policy root (session cwd). */
export function resolveWorkdir(
  modelWorkdir: string | undefined,
  workspaceRoot: string,
): string {
  if (modelWorkdir === undefined) return workspaceRoot
  return isAbsolute(modelWorkdir)
    ? modelWorkdir
    : resolvePath(workspaceRoot, modelWorkdir)
}

function assertDirectory(path: string): void {
  let isDirectory = false
  try {
    isDirectory = statSync(path).isDirectory()
  } catch {
    // reported below
  }
  if (!isDirectory)
    throw new ToolError(
      `workdir does not exist or is not a directory: ${path}`,
      'INVALID_WORKDIR',
    )
}

/** Runner failure: a fatal runner diagnostic on a non-zero exit means the command never ran. */
function runnerFailed(
  confined: ConfinedArgv,
  stderr: string,
  exitCode: number | null,
): boolean {
  if (exitCode === null || exitCode === 0) return false
  return classifyConfinedStderr(confined, stderr, exitCode).runnerFailed
}

function deniedBySandbox(
  confined: ConfinedArgv,
  stderr: string,
  exitCode: number | null,
): boolean {
  if (exitCode === null || exitCode === 0) return false
  return classifyConfinedStderr(confined, stderr, exitCode).denied
}

/** Whether a spawn rejection is the sandbox runner itself failing to launch. */
function isRunnerSpawnFailure(
  error: unknown,
  runner: string | undefined,
): boolean {
  if (runner === undefined || typeof error !== 'object' || error === null)
    return false
  const { code, path, syscall } = error as {
    code?: unknown
    path?: unknown
    syscall?: unknown
  }
  if (code !== 'ENOENT' && code !== 'EACCES') return false
  return path === runner || syscall === `spawn ${runner}`
}

function processOutcome(
  outcome:
    { exitCode: number | null; signal: NodeJS.Signals | null } | undefined,
  killed: boolean,
  sandbox: ShellSandboxInfo | undefined,
  spawnError: unknown,
): JobOutcome {
  if (spawnError !== undefined)
    return { status: 'failed', detail: `spawn failed: ${String(spawnError)}` }
  if (sandbox?.runnerFailed)
    return {
      status: 'failed',
      detail: `sandbox runner failed under ${sandbox.mode} mode`,
    }
  if (outcome === undefined) return { status: 'failed', detail: 'no outcome' }
  if (killed || outcome.signal !== null) {
    return {
      status: 'killed',
      detail:
        outcome.signal !== null
          ? `signal: ${outcome.signal}`
          : 'killed before exit',
      ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
    }
  }
  return {
    status: 'completed',
    detail: `exit code: ${outcome.exitCode ?? 0}`,
    exitCode: outcome.exitCode ?? 0,
  }
}

export function createShellTool(
  services: ToolServices,
  options: ShellToolOptions = {},
): ToolDefinition<ShellToolArgs> {
  const platform = options.platform ?? process.platform
  const toolName = shellToolName(platform)
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS
  const maxTimeoutMs = options.maxTimeoutMs ?? MAX_SHELL_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const maxSpillBytes = options.maxSpillBytes ?? DEFAULT_MAX_SPILL_BYTES
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const jobs = options.jobs

  /** Resolve argv + sandbox facts for one policy (throws SANDBOX_UNAVAILABLE for unusable confinement). */
  const prepareArgv = (
    command: string,
    policy: SandboxExecutionPolicy,
  ): { argv: string[]; confined?: ConfinedArgv } => {
    const argv = shellArgv(platform, command)
    if (policy.mode === 'danger-full-access') return { argv }
    const confined = services.sandboxBackend.confine(argv, {
      ...policy,
      mode: policy.mode,
    })
    return { argv: confined.argv, confined }
  }

  const spawnFor = (
    argv: string[],
    workdir: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): ManagedProcess =>
    spawnManaged({
      argv,
      cwd: workdir,
      env,
      maxOutputBytes,
      maxSpillBytes,
      spillDir: services.spillRoot,
      graceMs,
      platform,
      ...(signal === undefined ? {} : { signal }),
    })

  const runForeground = async (
    args: ShellToolArgs,
    context: ToolRunContext,
    policy: SandboxExecutionPolicy,
    escalated: boolean,
    workdir: string,
    env: NodeJS.ProcessEnv,
  ) => {
    const timeoutMs = clampTimeout(
      args.timeoutMs,
      defaultTimeoutMs,
      maxTimeoutMs,
    )
    const { argv, confined } = prepareArgv(args.command, policy)
    const started = Date.now()
    const limit = deadline(context.signal, timeoutMs, SHELL_TIMEOUT)
    let proc: ManagedProcess
    let outcome: { exitCode: number | null; signal: NodeJS.Signals | null }
    try {
      try {
        proc = spawnFor(argv, workdir, env, limit.signal)
        outcome = await proc.done
      } catch (error: unknown) {
        if (context.signal.aborted) throw abortedError()
        if (confined !== undefined && isRunnerSpawnFailure(error, argv[0])) {
          throw new SandboxUnavailableError(
            policy.mode as Exclude<SandboxMode, 'danger-full-access'>,
            String(error),
          )
        }
        throw error
      }
    } finally {
      limit.dispose()
    }
    const timedOut = timeoutOf(limit.signal, SHELL_TIMEOUT) !== undefined
    const aborted = limit.signal.aborted && !timedOut
    if (aborted) throw abortedError()
    const stdout = proc.stdout.finalize()
    const stderr = proc.stderr.finalize()
    let sandbox: ShellSandboxInfo | undefined
    if (confined !== undefined) {
      if (runnerFailed(confined, stderr.text, outcome.exitCode)) {
        const signatures = confined.runnerFailureRules.flatMap((rule) =>
          rule.fatalSignatures.map((s) => s.toLowerCase()),
        )
        const line = stderr.text
          .split(/\r?\n/)
          .find((text) =>
            signatures.some((s) => text.toLowerCase().startsWith(s)),
          )
        throw new SandboxUnavailableError(
          policy.mode as Exclude<SandboxMode, 'danger-full-access'>,
          line,
        )
      }
      sandbox = {
        mode: policy.mode,
        denied: deniedBySandbox(confined, stderr.text, outcome.exitCode),
      }
    } else {
      sandbox = { mode: policy.mode, denied: false }
    }
    const result: ShellRunResult = {
      ...outcome,
      timedOut,
      aborted,
      timeoutMs,
      stdout,
      stderr,
      sandbox,
    }
    const spillPath = stdout.spillPath ?? stderr.spillPath
    return {
      content: renderResult(result),
      meta: {
        kind: 'foreground',
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        ...(spillPath === undefined ? {} : { spillPath }),
        ...(stdout.spillPath !== undefined && stderr.spillPath !== undefined
          ? { stderrSpillPath: stderr.spillPath }
          : {}),
        sandbox: { mode: policy.mode, escalated, denied: sandbox.denied },
      },
    }
  }

  const startBackground = (
    args: ShellToolArgs,
    context: ToolRunContext,
    policy: SandboxExecutionPolicy,
    escalated: boolean,
    workdir: string,
    env: NodeJS.ProcessEnv,
  ) => {
    if (jobs === undefined)
      throw new ToolError(
        'background jobs unavailable: no job registry is composed',
        'JOBS_UNAVAILABLE',
      )
    if (context.signal.aborted) throw abortedError()
    const { argv, confined } = prepareArgv(args.command, policy)
    const jobId = jobs.start({
      kind: 'bash',
      label: args.command,
      description: args.description,
      ...(context.agent === undefined ? {} : { owner: context.agent }),
      run: () => {
        // Background work is detached from the tool-call signal once the id is returned.
        const proc = spawnFor(argv, workdir, env)
        let killed = false
        let sandbox: ShellSandboxInfo | undefined
        let spawnError: unknown
        let stdoutOffset = 0
        let stderrOffset = 0
        let spawnNote: string | undefined
        const done = proc.done.then(
          (outcome) => {
            const stderrText = proc.stderr.readFrom(0).text
            if (confined !== undefined) {
              const failed = runnerFailed(
                confined,
                stderrText,
                outcome.exitCode,
              )
              sandbox = {
                mode: policy.mode,
                denied:
                  !failed &&
                  deniedBySandbox(confined, stderrText, outcome.exitCode),
                ...(failed ? { runnerFailed: true } : {}),
              }
            }
            return processOutcome(outcome, killed, sandbox, undefined)
          },
          (error: unknown) => {
            spawnError = error
            spawnNote = `spawn failed: ${String(error)}`
            if (
              confined !== undefined &&
              isRunnerSpawnFailure(error, argv[0])
            ) {
              sandbox = { mode: policy.mode, denied: false, runnerFailed: true }
            }
            return processOutcome(undefined, killed, sandbox, spawnError)
          },
        )
        return {
          cancel: () => {
            killed = true
            proc.terminate()
          },
          done,
          peekOutput: () => {
            const out = proc.stdout.readFrom(0)
            const err = proc.stderr.readFrom(0)
            const separator =
              out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
            const errText = err.text.length > 0 ? err.text : (spawnNote ?? '')
            return (
              out.text +
              (errText.length > 0 ? `${separator}[stderr]\n${errText}` : '')
            )
          },
          readOutput: () => {
            const out = proc.stdout.readFrom(stdoutOffset)
            const err = proc.stderr.readFrom(stderrOffset)
            stdoutOffset = out.nextOffset
            stderrOffset = err.nextOffset
            let errText = err.text
            if (errText.length === 0 && spawnNote !== undefined) {
              errText = spawnNote
              spawnNote = undefined
            }
            const separator =
              out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
            const delta =
              out.text +
              (errText.length > 0 ? `${separator}[stderr]\n${errText}` : '')
            return renderProcessRead(
              {
                delta,
                lossy: out.lossy || err.lossy,
                ...(out.spillPath === undefined
                  ? {}
                  : { stdoutSpillPath: out.spillPath }),
                ...(err.spillPath === undefined
                  ? {}
                  : { stderrSpillPath: err.spillPath }),
              },
              sandbox,
            )
          },
        }
      },
    })
    return {
      content: `started background job ${jobId}`,
      meta: {
        kind: 'background',
        jobId,
        sandbox: { mode: policy.mode, escalated },
      },
    }
  }

  return defineTool({
    name: toolName,
    description: shellDescription(platform, jobs !== undefined),
    input: shellInput,
    isConcurrencySafe: () => false,
    async execute(args, context) {
      validateArgs(args)
      if (args.run_in_background === true && jobs === undefined) {
        throw new ToolError(
          'background jobs unavailable: no job registry is composed',
          'JOBS_UNAVAILABLE',
        )
      }
      const session = context.agent?.session
      const standing = services.sandbox.resolve(
        session === undefined ? {} : { session },
      )
      let policy = standing
      let escalated = false
      if (
        args.sandbox_permissions !== undefined &&
        args.justification !== undefined
      ) {
        const mode = await approveEscalation(
          {
            requestedMode: args.sandbox_permissions,
            justification: args.justification,
            effectiveMode: standing.mode,
            subject: 'command',
          },
          {
            service: services.approval,
            agent: context.agent,
            callId: context.callId,
            toolName,
            signal: context.signal,
          },
        )
        policy = services.sandbox.resolve({
          ...(session === undefined ? {} : { session }),
          mode,
        })
        escalated = true
      }
      const workdir = canonicalPath(
        resolveWorkdir(args.workdir, policy.workspaceRoot),
      )
      assertDirectory(workdir)
      const env = buildShellEnv(services.shellEnv?.() ?? process.env, {
        ...(policy.sessionId === undefined
          ? {}
          : { sessionId: policy.sessionId }),
        workspaceRoot: policy.workspaceRoot,
      })
      if (args.run_in_background === true)
        return startBackground(args, context, policy, escalated, workdir, env)
      return runForeground(args, context, policy, escalated, workdir, env)
    },
  })
}
