/**
 * Execute one command hook (replaces dsh's `ctx.shell` executor with a
 * direct spawn): `sh -c <command>` (`cmd.exe /d /s /c` on win32) in the
 * session cwd, the JSON payload on stdin, a per-hook timeout, and
 * process-group cancellation. Never throws: infrastructure failures, kills,
 * and timeouts become an outcome with no exit code (a non-blocking error).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { parseHookOutput } from './codec'
import type { CommandHook, HookOutput } from './types'

/** Reference default per-hook timeout (10 minutes, the Claude Code default). */
export const DEFAULT_HOOK_TIMEOUT_MS = 600_000

/** Captured stdout/stderr are each capped to keep a runaway hook bounded. */
const MAX_CAPTURE_BYTES = 1024 * 1024
/** Grace between SIGTERM and SIGKILL when a hook is cancelled or times out. */
const KILL_GRACE_MS = 2_000

export interface RunHookOptions {
  /** JSON payload written to stdin. */
  payload: unknown
  /** Extra env vars merged over `process.env`. */
  env?: Record<string, string>
  /** Working directory (defaults to the process cwd). */
  cwd?: string
  /** Owning-operation signal; firing it kills the hook. */
  readonly signal: AbortSignal
  /** Append a trailing newline to the stdin payload (Claude Code: yes). */
  trailingNewline: boolean
  /** Timeout when the hook sets no `timeout` of its own. */
  defaultTimeoutMs: number
  /** Guard `hookSpecificOutput` against a different event (see {@link parseHookOutput}). */
  expectedEventName?: string
}

export interface RunHookResult {
  output: HookOutput
  durationMs: number
}

interface ProcessOutcome {
  exitCode: number | undefined
  stdout: string
  stderr: string
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${command}"`],
    }
  }
  return { file: '/bin/sh', args: ['-c', command] }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

function collect(stream: NodeJS.ReadableStream | null): { text(): string } {
  const chunks: Buffer[] = []
  let size = 0
  stream?.on('data', (chunk: Buffer) => {
    if (size >= MAX_CAPTURE_BYTES) return
    const slice = chunk.subarray(0, MAX_CAPTURE_BYTES - size)
    chunks.push(slice)
    size += slice.length
  })
  return { text: () => Buffer.concat(chunks).toString('utf8') }
}

function runProcess(
  command: string,
  stdin: string,
  timeoutMs: number,
  options: RunHookOptions,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    if (options.signal.aborted) {
      resolve({
        exitCode: undefined,
        stdout: '',
        stderr: 'hook cancelled before start',
      })
      return
    }
    const { file, args } = shellInvocation(command)
    let child: ChildProcess
    try {
      child = spawn(file, args, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: process.platform === 'win32',
      })
    } catch (error: unknown) {
      resolve({
        exitCode: undefined,
        stdout: '',
        stderr: `hook could not start: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    let note: string | undefined
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const terminate = (why: string): void => {
      if (note === undefined) note = why
      killTree(child, 'SIGTERM')
      killTimer ??= setTimeout(() => {
        killTree(child, 'SIGKILL')
      }, KILL_GRACE_MS)
      killTimer.unref()
    }
    const timer = setTimeout(() => {
      terminate(`hook timed out after ${timeoutMs}ms`)
    }, timeoutMs)
    const onAbort = (): void => {
      terminate('hook cancelled')
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    const finish = (exitCode: number | undefined, spawnError?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      options.signal.removeEventListener('abort', onAbort)
      const err = stderr.text()
      const extra =
        spawnError !== undefined
          ? `hook could not start: ${spawnError.message}`
          : note
      resolve({
        exitCode: note !== undefined ? undefined : exitCode,
        stdout: stdout.text(),
        stderr:
          extra === undefined
            ? err
            : err.length > 0
              ? `${err}\n${extra}`
              : extra,
      })
    }
    child.on('error', (error) => {
      finish(undefined, error)
    })
    child.on('close', (code) => {
      finish(code ?? undefined)
    })
    child.stdin?.on('error', () => {
      /* a hook that ignores stdin may close it early (EPIPE) */
    })
    child.stdin?.end(stdin)
  })
}

/**
 * Run `hook` with the serialized payload on stdin and decode its outcome.
 * A per-hook `timeoutSec` overrides `defaultTimeoutMs`.
 */
export async function runHook(
  hook: CommandHook,
  options: RunHookOptions,
  now: () => number = () => performance.now(),
): Promise<RunHookResult> {
  const started = now()
  const timeoutMs =
    hook.timeoutSec !== undefined && hook.timeoutSec > 0
      ? hook.timeoutSec * 1000
      : options.defaultTimeoutMs
  const stdin =
    JSON.stringify(options.payload ?? null) +
    (options.trailingNewline ? '\n' : '')
  const outcome = await runProcess(hook.command, stdin, timeoutMs, options)
  return {
    output: parseHookOutput(
      outcome.exitCode,
      outcome.stdout,
      outcome.stderr,
      outcome.exitCode === undefined ? undefined : options.expectedEventName,
    ),
    durationMs: Math.max(0, now() - started),
  }
}
