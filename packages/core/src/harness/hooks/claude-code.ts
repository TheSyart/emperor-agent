/**
 * Claude Code hooks bridge (ported from dsh-hooks-claude-code, without the
 * Cordis plugin machinery). Runs the supported subset of unmodified Claude
 * Code command hooks at the kernel's middleware arrays:
 *
 * | CC event         | Kernel point                     | Mapping |
 * |------------------|----------------------------------|---------|
 * | SessionStart     | `sessionStarted()` (detached)    | additionalContext → `agent.inject()` |
 * | UserPromptSubmit | `middleware.preStep` (step 1)    | deny → reject; additionalContext → extra context message |
 * | PreToolUse       | `tools.preExecute`               | deny → deny; ask → ask |
 * | PostToolUse      | `tools.postExecute`              | deny/block → block with feedback; additionalContext → accept |
 * | Stop             | `middleware.turnStopping`        | block → `agent.steer()` (capped per turn) |
 * | SubagentStart    | `subagentStarted()` (detached)   | additionalContext → `child.inject()` |
 * | SubagentStop     | `subagentStopped()` (detached)   | observe only |
 *
 * Hooks run serially in config order inside the session cwd and fold
 * most-restrictively. In-turn points log `hook/invoked` + `hook/result`
 * pairs; detached points (outside any turn) do not. `updatedInput`,
 * `systemMessage` and `continue:false` are parsed and warned about but not
 * honored (same as dsh).
 */

import { existsSync, readFileSync } from 'node:fs'
import type { ContentBlock } from '../../llm/types'
import { contextMessage, type UserMessage } from '../../llm/message'
import type { Session } from '../../session-log/session'
import { logger as defaultLogger, type Logger } from '../../util/log'
import type { Agent } from '../agent/agent'
import type {
  AgentMiddleware,
  PreStepDecision,
  PreStepMiddleware,
  TurnStoppingMiddleware,
} from '../agent/middleware'
import type {
  PostExecuteMiddleware,
  PostToolDecision,
  PreExecuteMiddleware,
  PreToolDecision,
  ToolCallInfo,
  ToolRegistry,
} from '../tools/registry'
import {
  parseClaudeCodeConfig,
  type ClaudeCodeHookConfig,
  type ClaudeHookEvent,
} from './config'
import { createDetachedRuns, type DetachedRuns } from './detached'
import {
  appendHookInvoked,
  appendHookResult,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
} from './events'
import { matchesMatcher } from './matcher'
import { mergeHookOutputs, type MergedHookOutcome } from './merge'
import { DEFAULT_HOOK_TIMEOUT_MS, runHook } from './runner'
import type { HookOutput } from './types'

/** Producer stamped on every context message this bridge injects. */
export const HOOKS_CONTEXT_PRODUCER = 'hooks'

/** Default cap on consecutive Stop-hook forced continuations within one turn. */
export const DEFAULT_MAX_STOP_CONTINUATIONS = 3

/**
 * `agent_type` reported for SubagentStart/Stop: the kernel carries no
 * per-kind label, so the Claude Code Task-tool default is used.
 */
const SUBAGENT_TYPE = 'general-purpose'

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

export interface ClaudeCodeHooksOptions {
  /** Config files read in order; missing files contribute no hooks. See `defaultHookConfigPaths`. */
  configPaths: string[]
  /** Replaces `${CLAUDE_PLUGIN_ROOT}` and is exported as `CLAUDE_PLUGIN_ROOT`. */
  pluginRoot?: string
  /** Replaces `${CLAUDE_PROJECT_DIR}` and is exported as `CLAUDE_PROJECT_DIR` (else the session cwd). */
  projectDir?: string
  /** Per-hook timeout when a hook sets none (default 600000 ms). */
  defaultTimeoutMs?: number
  /** Cap for the persisted `hook/result.stderrSummary` (default 500 chars). */
  stderrSummaryMaxChars?: number
  /** Max consecutive Stop-hook forced continuations per turn (default 3). */
  maxStopContinuations?: number
  /** Resolves `transcript_path` for a session; `''` when omitted. */
  transcriptPath?: (session: Session) => string
  logger?: Logger
}

export interface ClaudeCodeHooksDescription {
  /** Number of runnable command hooks per event. */
  events: Record<string, number>
  /** Config files that were read and parsed successfully. */
  files: string[]
  /** Per-file read/parse errors of the last reload. */
  errors: string[]
}

interface RunPointOptions {
  agent?: Agent
  /** Open turn to log `hook/*` events into; omitted for detached points. */
  turn?: number
  signal: AbortSignal
}

let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `claude-code:${point}:${++handlerCounter}`
}

function blocksToText(content: readonly ContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The open turn a tool call runs inside, or undefined when none (host-initiated / idle). */
function openTurn(agent: Agent | undefined): number | undefined {
  if (agent === undefined || agent.status !== 'running') return undefined
  const { turn } = agent.position
  return turn > 0 ? turn : undefined
}

export class ClaudeCodeHooks {
  private config: ClaudeCodeHookConfig = {}
  private files: string[] = []
  private errors: string[] = []
  private readonly log: Logger
  private readonly defaultTimeoutMs: number
  private readonly stderrSummaryMaxChars: number
  private readonly maxStopContinuations: number
  private readonly detached: DetachedRuns = createDetachedRuns()
  private readonly stopState = new WeakMap<
    Agent,
    { turn: number; forced: number }
  >()
  private disposed = false

  constructor(private readonly options: ClaudeCodeHooksOptions) {
    this.log = options.logger ?? defaultLogger
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
    this.stderrSummaryMaxChars =
      options.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
    this.maxStopContinuations =
      options.maxStopContinuations ?? DEFAULT_MAX_STOP_CONTINUATIONS
    for (const [name, value] of [
      ['stderrSummaryMaxChars', this.stderrSummaryMaxChars],
      ['maxStopContinuations', this.maxStopContinuations],
    ] as const) {
      if (
        !Number.isInteger(value) ||
        value < (name === 'maxStopContinuations' ? 0 : 1)
      ) {
        throw new Error(
          `ClaudeCodeHooks: ${name} must be a ${name === 'maxStopContinuations' ? 'non-negative' : 'positive'} integer`,
        )
      }
    }
    if (!(this.defaultTimeoutMs > 0))
      throw new Error('ClaudeCodeHooks: defaultTimeoutMs must be positive')
    this.reload()
  }

  /** The most recent read/parse error of the last reload, if any. */
  get lastError(): string | undefined {
    return this.errors.at(-1)
  }

  /**
   * Re-read every config file. A missing file contributes nothing; a file
   * that fails to read or parse (including an invalid matcher regex) is
   * skipped as a whole and reported, without affecting the other files.
   */
  reload(): void {
    const merged: ClaudeCodeHookConfig = {}
    const files: string[] = []
    const errors: string[] = []
    const vars = {
      ...(this.options.pluginRoot !== undefined
        ? { pluginRoot: this.options.pluginRoot }
        : {}),
      ...(this.options.projectDir !== undefined
        ? { projectDir: this.options.projectDir }
        : {}),
    }
    for (const path of this.options.configPaths) {
      if (!existsSync(path)) continue
      try {
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
        const parsed = parseClaudeCodeConfig(raw, vars)
        for (const skipped of parsed.skipped) {
          this.log.warn(
            `hooks: skipping unsupported "${skipped.type}" hook on ${skipped.event} in ${path} (only command hooks run)`,
          )
        }
        for (const [event, groups] of Object.entries(parsed.config) as Array<
          [ClaudeHookEvent, NonNullable<ClaudeCodeHookConfig[ClaudeHookEvent]>]
        >) {
          merged[event] = [...(merged[event] ?? []), ...groups]
        }
        files.push(path)
      } catch (error: unknown) {
        const message = `${path}: ${errorText(error)}`
        errors.push(message)
        this.log.warn(
          `hooks: could not load hook config ${message} — file ignored`,
        )
      }
    }
    this.config = merged
    this.files = files
    this.errors = errors
  }

  describe(): ClaudeCodeHooksDescription {
    const events: Record<string, number> = {}
    for (const [event, groups] of Object.entries(this.config)) {
      events[event] = (groups ?? []).reduce(
        (sum, group) => sum + group.hooks.length,
        0,
      )
    }
    return { events, files: [...this.files], errors: [...this.errors] }
  }

  /** Whether any hook is configured for `event`. */
  has(event: ClaudeHookEvent): boolean {
    return (this.config[event]?.length ?? 0) > 0
  }

  /** Register the in-turn hook points; returns the uninstaller. */
  install(middleware: AgentMiddleware, tools: ToolRegistry): () => void {
    const preStep: PreStepMiddleware = (input) => this.userPromptSubmit(input)
    const turnStopping: TurnStoppingMiddleware = (input) => this.stop(input)
    const preExecute: PreExecuteMiddleware = (call) => this.preToolUse(call)
    const postExecute: PostExecuteMiddleware = (call, result) =>
      this.postToolUse(call, result)
    middleware.preStep.push(preStep)
    middleware.turnStopping.push(turnStopping)
    tools.preExecute.push(preExecute)
    tools.postExecute.push(postExecute)
    return () => {
      remove(middleware.preStep, preStep)
      remove(middleware.turnStopping, turnStopping)
      remove(tools.preExecute, preExecute)
      remove(tools.postExecute, postExecute)
    }
  }

  /**
   * SessionStart (detached): a slow hook may miss the first request. The
   * matcher subject is `source`.
   */
  sessionStarted(agent: Agent, source: SessionStartSource): void {
    if (this.disposed || !this.has('SessionStart')) return
    this.detached.track(
      this.runPoint(
        'SessionStart',
        source,
        { ...this.base(agent, 'SessionStart'), source },
        { agent, signal: this.detached.signal },
      )
        .then((merged) => {
          const context = this.contextFrom(merged)
          if (context !== undefined && !this.disposed) agent.inject(context)
        })
        .catch((error: unknown) => {
          this.log.warn(`hooks: SessionStart hook failed: ${errorText(error)}`)
        }),
    )
  }

  /** SubagentStart (detached): additionalContext is injected into the child. */
  subagentStarted(child: Agent): void {
    if (this.disposed || !this.has('SubagentStart')) return
    const payload = {
      ...this.base(child, 'SubagentStart'),
      agent_id: child.id,
      agent_type: SUBAGENT_TYPE,
    }
    this.detached.track(
      this.runPoint('SubagentStart', SUBAGENT_TYPE, payload, {
        agent: child,
        signal: this.detached.signal,
      })
        .then((merged) => {
          const context = this.contextFrom(merged)
          if (context !== undefined && !this.disposed) child.inject(context)
        })
        .catch((error: unknown) => {
          this.log.warn(`hooks: SubagentStart hook failed: ${errorText(error)}`)
        }),
    )
  }

  /** SubagentStop (detached): observe only. */
  subagentStopped(child: Agent): void {
    if (this.disposed || !this.has('SubagentStop')) return
    const payload = {
      ...this.base(child, 'SubagentStop'),
      agent_id: child.id,
      agent_type: SUBAGENT_TYPE,
      stop_hook_active: false,
    }
    this.detached.track(
      this.runPoint('SubagentStop', SUBAGENT_TYPE, payload, {
        agent: child,
        signal: this.detached.signal,
      }).catch((error: unknown) => {
        this.log.warn(`hooks: SubagentStop hook failed: ${errorText(error)}`)
      }),
    )
  }

  /** Abort running hooks (detached and in-turn) and wait for detached chains to settle. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.detached.drain()
  }

  // --- extension points -------------------------------------------------

  private async userPromptSubmit(
    input: Parameters<PreStepMiddleware>[0],
  ): Promise<PreStepDecision | undefined> {
    if (this.disposed || input.step !== 1 || !this.has('UserPromptSubmit'))
      return undefined
    const prompts = input.messages.filter(
      (message) => message.source.kind === 'user',
    )
    if (prompts.length === 0) return undefined
    const prompt = prompts
      .map((message) => blocksToText(message.content))
      .join('\n\n')
    const merged = await this.runPoint(
      'UserPromptSubmit',
      '',
      { ...this.base(input.agent, 'UserPromptSubmit'), prompt },
      {
        agent: input.agent,
        turn: input.turn,
        signal: input.signal,
      },
    )
    if (merged.decision === 'deny') {
      this.log.warn(
        `hooks: UserPromptSubmit blocked the prompt: ${merged.reason ?? 'blocked by UserPromptSubmit hook'}`,
        { session: input.agent.id, turn: input.turn },
      )
      return { kind: 'reject' }
    }
    const context = this.contextFrom(merged)
    return context === undefined
      ? undefined
      : { kind: 'enter', messages: [...input.messages, context] }
  }

  private async preToolUse(
    call: ToolCallInfo,
  ): Promise<PreToolDecision | undefined> {
    if (this.disposed || !this.has('PreToolUse')) return undefined
    const payload = {
      ...this.base(call.agent, 'PreToolUse'),
      tool_name: call.name,
      tool_input: call.arguments,
      tool_use_id: call.callId,
    }
    const merged = await this.runPoint(
      'PreToolUse',
      call.name,
      payload,
      this.callOptions(call),
    )
    if (merged.decision === 'deny')
      return {
        kind: 'deny',
        reason: merged.reason ?? 'blocked by PreToolUse hook',
      }
    if (merged.decision === 'ask')
      return {
        kind: 'ask',
        ...(merged.reason !== undefined ? { reason: merged.reason } : {}),
      }
    return undefined
  }

  private async postToolUse(
    call: ToolCallInfo,
    result: Parameters<PostExecuteMiddleware>[1],
  ): Promise<PostToolDecision | undefined> {
    if (this.disposed || !this.has('PostToolUse')) return undefined
    const payload = {
      ...this.base(call.agent, 'PostToolUse'),
      tool_name: call.name,
      tool_input: call.arguments,
      tool_use_id: call.callId,
      tool_response: blocksToText(result.content),
    }
    const merged = await this.runPoint(
      'PostToolUse',
      call.name,
      payload,
      this.callOptions(call),
    )
    const context = this.contextFrom(merged)
    const contexts =
      context === undefined ? {} : { additionalContexts: [context] }
    if (merged.decision === 'deny') {
      return {
        kind: 'block',
        feedback: [
          {
            type: 'text',
            text: merged.reason ?? 'blocked by PostToolUse hook',
          },
        ],
        ...contexts,
      }
    }
    return context === undefined ? undefined : { kind: 'accept', ...contexts }
  }

  private async stop(
    input: Parameters<TurnStoppingMiddleware>[0],
  ): Promise<void> {
    if (this.disposed || !this.has('Stop')) return
    const { agent, turn, signal } = input
    let state = this.stopState.get(agent)
    if (state === undefined || state.turn !== turn) {
      state = { turn, forced: 0 }
      this.stopState.set(agent, state)
    }
    const payload = {
      ...this.base(agent, 'Stop'),
      stop_hook_active: state.forced > 0,
    }
    const merged = await this.runPoint('Stop', '', payload, {
      agent,
      turn,
      signal,
    })
    if (merged.decision !== 'deny') {
      state.forced = 0
      return
    }
    if (state.forced >= this.maxStopContinuations) {
      this.log.warn(
        `hooks: Stop hook blocked ${state.forced + 1} consecutive times; letting the turn stop (cap ${this.maxStopContinuations})`,
        { session: agent.id, turn },
      )
      return
    }
    state.forced++
    agent.steer(
      contextMessage(
        HOOKS_CONTEXT_PRODUCER,
        merged.reason ?? 'continue: blocked by Stop hook',
      ),
    )
  }

  // --- execution --------------------------------------------------------

  private callOptions(call: ToolCallInfo): RunPointOptions {
    const turn = openTurn(call.agent)
    return {
      ...(call.agent !== undefined ? { agent: call.agent } : {}),
      ...(turn !== undefined ? { turn } : {}),
      signal: call.signal,
    }
  }

  private base(
    agent: Agent | undefined,
    event: ClaudeHookEvent,
  ): Record<string, unknown> {
    let transcriptPath = ''
    if (agent !== undefined && this.options.transcriptPath !== undefined) {
      try {
        transcriptPath = this.options.transcriptPath(agent.session)
      } catch (error: unknown) {
        this.log.warn(
          `hooks: transcriptPath resolver failed: ${errorText(error)}`,
        )
      }
    }
    return {
      session_id: agent?.session.id ?? '',
      transcript_path: transcriptPath,
      cwd: this.workdir(agent),
      hook_event_name: event,
    }
  }

  private workdir(agent: Agent | undefined): string {
    return agent?.session.header.cwd ?? this.options.projectDir ?? process.cwd()
  }

  /**
   * Run every hook of `point` whose matcher selects `matchQuery`, serially in
   * config order, and fold the outcomes. Logs a `hook/invoked`/`hook/result`
   * pair per hook when `opts.turn` names an open turn.
   */
  private async runPoint(
    point: ClaudeHookEvent,
    matchQuery: string,
    payload: unknown,
    opts: RunPointOptions,
  ): Promise<MergedHookOutcome> {
    const groups = this.config[point] ?? []
    const outputs: HookOutput[] = []
    const cwd = this.workdir(opts.agent)
    const env: Record<string, string> = {
      CLAUDE_PROJECT_DIR: this.options.projectDir ?? cwd,
      ...(this.options.pluginRoot !== undefined
        ? { CLAUDE_PLUGIN_ROOT: this.options.pluginRoot }
        : {}),
    }
    const signal = AbortSignal.any([opts.signal, this.detached.signal])
    const session = opts.agent?.session
    for (const group of groups) {
      if (!matchesMatcher(group.matcher, matchQuery, 'claude-code')) continue
      for (const hook of group.hooks) {
        if (signal.aborted) break
        const handlerId = nextHandlerId(point)
        if (session !== undefined && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn,
            point,
            dialect: 'claude-code',
            handlerId,
            ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
          })
        }
        const { output, durationMs } = await runHook(hook, {
          payload,
          env,
          cwd,
          signal,
          trailingNewline: true,
          defaultTimeoutMs: this.defaultTimeoutMs,
          expectedEventName: point,
        })
        outputs.push(output)
        if (output.updatedInput !== undefined)
          this.log.warn(
            `hooks: ${point} hook requested updatedInput, which is not honored (ignored)`,
          )
        if (output.systemMessage !== undefined)
          this.log.warn(
            `hooks: ${point} hook emitted a systemMessage, which is not surfaced (ignored)`,
          )
        if (output.continue === false)
          this.log.warn(
            `hooks: ${point} hook returned continue:false, which is not honored (ignored)`,
          )
        if (session !== undefined && opts.turn !== undefined) {
          appendHookResult(session, {
            turn: opts.turn,
            point,
            handlerId,
            output,
            stderrSummaryMaxChars: this.stderrSummaryMaxChars,
            durationMs,
          })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  private contextFrom(merged: MergedHookOutcome): UserMessage | undefined {
    if (merged.additionalContext.length === 0) return undefined
    return contextMessage(
      HOOKS_CONTEXT_PRODUCER,
      merged.additionalContext.join('\n\n'),
    )
  }
}

function remove<T>(list: T[], item: T): void {
  const index = list.indexOf(item)
  if (index >= 0) list.splice(index, 1)
}
