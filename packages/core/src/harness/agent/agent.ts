/**
 * `Agent`: the ReAct loop driver for one session (ported from
 * dsh-agent-loop `ReactLoopAgent`).
 *
 * Phases: `idle`, `maintenance` (e.g. /compact), `running`. Waking input
 * while idle starts the driver, which runs turns until the inbox is empty.
 *
 * One turn: `turn/start` → steps → `turn/end` (always, in `finally`).
 * One step: claim the inbox (all of next-step, plus one next-turn message on
 * the first step) → assemble prompt → runtime-context snapshot if changed →
 * pre-step middleware → `step/start` → `user/message` per entering message →
 * request built ONLY from `session.deriveMessages()` + the logged
 * `request/header` → every chunk logged as `assistant/chunk` →
 * `assistant/message` → tool calls → `step/end`. A turn may stop when a
 * step completes (no tool calls, `concludesTurn`, or sticky max-tokens) and
 * next-step is empty; turn-stopping middleware can steer another step.
 *
 * There is deliberately no max-steps limit.
 */

import { BlockAssembler } from '../../llm/assembler'
import type { LlmCallConfig } from '../../llm/call-config'
import type { LlmClient, PreparedLlmCall } from '../../llm/client'
import { errorChain, LlmError } from '../../llm/error'
import { deepFreeze } from '../../llm/freeze'
import { createAssistantMessage, type UserMessage } from '../../llm/message'
import type { GenerateOptions, Message, ToolSchema } from '../../llm/types'
import { canonicalHeader, headerEquals } from '../../session-log/request-header'
import type { Session } from '../../session-log/session'
import type {
  AgentCancelCause,
  EpochHeader,
  RequestContext,
  TurnEndReason,
} from '../../session-log/types'
import { logger } from '../../util/log'
import {
  joinContextSections,
  renderContextSections,
  renderPrompt,
  type PromptAssembly,
  type SystemPromptAssembler,
} from '../prompt/assembler'
import type { ToolFilter, ToolRegistry } from '../tools/registry'
import { Inbox, type InboxTarget } from './inbox'
import type { AgentMiddleware, PreStepDecision } from './middleware'
import { RuntimeContextProjection } from './runtime-context'
import { executeToolCalls } from './tool-calls'

export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10

export type AgentStatus = 'idle' | 'running'

/** Shared services every agent of one host uses. */
export interface AgentDeps {
  llm: LlmClient
  tools: ToolRegistry
  prompt: SystemPromptAssembler
  middleware: AgentMiddleware
  maxParallelToolCalls?: number
}

export interface AgentOptions {
  /** Base request config; defaults to the active model route at each request. */
  callConfig?: () => LlmCallConfig
  /** Tool visibility for this agent (subagents narrow it). */
  toolFilter?: ToolFilter
  /** Owning (parent) agent for delegated agents. */
  owner?: Agent
}

export interface CancelOptions {
  /** Keep pending inbox messages (default: discard them). */
  keepInbox?: boolean
}

export interface AgentObserver {
  status?(agent: Agent, status: AgentStatus): void
  error?(
    agent: Agent,
    error: unknown,
    position: { turn: number; step: number },
  ): void
}

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
      kind: 'maintenance'
      abort: AbortController
      lastTurn: number
      wakeRequested: boolean
    }
  | {
      kind: 'running'
      abort: AbortController
      turn: number
      step: number
      wakeRequested: boolean
    }

type StepEndReason = Extract<
  TurnEndReason,
  { kind: 'completed' | 'max-tokens' }
>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; assembly: PromptAssembly }

/** Strip adapter-materialized defaults so a changed route can re-default them. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true)
    delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

export class Agent {
  readonly inbox: Inbox
  readonly toolFilter: ToolFilter | undefined
  readonly owner: Agent | undefined
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  private requestHeaderLogged = false
  private readonly runtimeContext: RuntimeContextProjection
  private readonly observers = new Set<AgentObserver>()
  private disposed = false

  constructor(
    readonly session: Session,
    private readonly deps: AgentDeps,
    private readonly options: AgentOptions = {},
  ) {
    this.toolFilter = options.toolFilter
    this.owner = options.owner
    this.inbox = new Inbox(session)
    let lastTurn = 0
    for (let index = session.events.length - 1; index >= 0; index--) {
      const event = session.events[index]
      if (event?.type === 'turn/start') {
        lastTurn = event.data.turn
        break
      }
    }
    this.phase = { kind: 'idle', lastTurn }
    this.runtimeContext = new RuntimeContextProjection(session)
  }

  get id(): string {
    return this.session.id
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  /** Current (or last) turn number and step, for diagnostics. */
  get position(): { turn: number; step: number } {
    return this.phase.kind === 'running'
      ? { turn: this.phase.turn, step: this.phase.step }
      : { turn: this.phase.lastTurn, step: 0 }
  }

  /** Delegation depth: 0 for a root agent. */
  get depth(): number {
    return this.session.header.delegationDepth ?? 0
  }

  observe(observer: AgentObserver): () => void {
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
    }
  }

  private setPhase(next: Phase): void {
    const previous = this.status
    this.phase = next
    const status = this.status
    if (status !== previous) {
      for (const observer of this.observers) {
        try {
          observer.status?.(this, status)
        } catch {
          // Observers never affect the driver.
        }
      }
    }
  }

  /** Queue a message; `wakeup` starts the driver when idle. */
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.disposed) throw new Error(`agent "${this.id}" is disposed`)
    const wakingAfterAbort =
      wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  /** A new prompt: starts a turn when idle, else waits for the next turn. */
  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  /** Enter at the very next step of the running turn (or start one). */
  steer(message: UserMessage): void {
    this.send(message, 'next-step', true)
  }

  /** Enter at the next step without waking an idle agent. */
  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  /** Run one maintenance job (e.g. manual compaction) while idle. */
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle')
      throw new Error(`agent "${this.id}" already has active work`)
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending)
          this.wakeDriver()
        resolveDone()
      }
    })()
  }

  /** Resolve once the driver (and any work it chained) has gone idle. */
  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Cancel with `disposed` and stop observing the session. */
  dispose(): void {
    if (this.disposed) return
    this.cancel({ kind: 'disposed' }, { keepInbox: true })
    this.disposed = true
    this.runtimeContext.dispose()
  }

  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = this.phase.abort.signal.reason as
        AgentCancelCause | undefined
      if (
        reason?.kind !== 'disposed' &&
        (this.phase.kind === 'maintenance' || wakeAfterAbort)
      ) {
        this.phase.wakeRequested = true
      }
      return
    }
    let resolveDriver!: () => void
    this.activityDone = new Promise<void>((resolve) => {
      resolveDriver = resolve
    })
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    void this.kick().then(resolveDriver, resolveDriver)
  }

  private reportError(error: unknown): void {
    const position = this.position
    for (const observer of this.observers) {
      try {
        observer.error?.(this, error, position)
      } catch {
        // ignore
      }
    }
    if (!(error instanceof LlmError))
      logger.warn('agent turn failed', {
        session: this.id,
        error: errorChain(error),
      })
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {
        // keep running turns while the inbox has work
      }
    } catch {
      // Already recorded in turn/end and reported to observers.
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending && !this.disposed)
          this.wakeDriver()
      }
    }
  }

  private async preStep(
    target: InboxTarget,
    position: { turn: number; step: number },
  ): Promise<PreparedStep> {
    if (this.phase.kind !== 'running')
      throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const assembly = this.deps.prompt.assemble({ agent: this, signal })
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(
      joinContextSections(sections),
      sections,
    )
    let decision: PreStepDecision = {
      kind: 'enter',
      messages: context === undefined ? claimed : [...claimed, context],
    }
    for (const middleware of this.deps.middleware.preStep) {
      if (decision.kind === 'reject') break
      const next = await middleware({
        agent: this,
        messages: decision.messages,
        ...position,
        signal,
      })
      signal.throwIfAborted()
      if (next !== undefined) decision = next
    }
    return decision.kind === 'reject' ? decision : { ...decision, assembly }
  }

  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running')
      throw new Error(`agent "${this.id}": turn without driver reservation`)
    const phase = this.phase
    const signal = phase.abort.signal
    signal.throwIfAborted()
    const turn = phase.turn + 1
    this.session.append('turn/start', { turn })
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          for (const message of decision.messages) {
            this.session.append('user/message', message, {
              surfaceOp: 'append',
            })
          }
          const stepEnd = await this.step(decision.assembly)
          // max-tokens is sticky: later steps cannot downgrade the turn result.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens')
            turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          for (const middleware of this.deps.middleware.turnStopping) {
            await middleware({ agent: this, turn, signal })
            signal.throwIfAborted()
          }
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = {
          kind: 'aborted',
          reason: signal.reason as AgentCancelCause,
        }
        throw error
      }
      turnEnds = {
        kind: 'error',
        error:
          error instanceof LlmError
            ? error.failure
            : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.reportError(error)
      throw error
    } finally {
      this.session.append('turn/end', {
        turn,
        reason: turnEnds ?? { kind: 'completed' },
      })
    }
    if (!this.inbox.hasPending || this.disposed) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(assembly: PromptAssembly): Promise<StepEndReason | null> {
    if (this.phase.kind !== 'running')
      throw new Error(`agent "${this.id}": step outside running phase`)
    const {
      turn,
      step,
      abort: { signal },
    } = this.phase
    signal.throwIfAborted()
    const system = renderPrompt(assembly)
    while (true) {
      const { request, prepared } = this.buildRequest(
        turn,
        step,
        assembly.tools,
        system,
        this.session.deriveMessages(),
        signal,
      )
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      try {
        const stream =
          prepared?.stream(request) ?? this.deps.llm.stream(request)
        signal.throwIfAborted()
        for await (const chunk of stream) {
          signal.throwIfAborted()
          chunkSeqs.push(
            this.session.append('assistant/chunk', { turn, step, chunk }).seq,
          )
          assembler.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (signal.aborted) {
          const content = assembler.interruptedBlocks()
          if (content.length > 0) {
            this.session.append(
              'assistant/message',
              {
                turn,
                step,
                message: createAssistantMessage({
                  content,
                  source: { provider: request.provider, model: request.model },
                }),
                interrupted: true,
                ...(assembler.usage === undefined
                  ? {}
                  : { usage: assembler.usage }),
              },
              { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
            )
          }
        }
        throw error
      }
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        let action: 'retry' | undefined
        for (const middleware of this.deps.middleware.requestError) {
          action = await middleware({
            agent: this,
            turn,
            step,
            provider: request.provider,
            failure: finish.failure,
            retryPolicy: prepared?.retryPolicy,
            signal,
          })
          signal.throwIfAborted()
          if (action === 'retry') break
        }
        if (action !== 'retry') {
          throw new LlmError(finish.failure.message, finish.failure.code, {
            ...(finish.failure.status === undefined
              ? {}
              : { status: finish.failure.status }),
            ...(finish.failure.providerRetryAfterMs === undefined
              ? {}
              : { providerRetryAfterMs: finish.failure.providerRetryAfterMs }),
            ...(finish.failure.requestId === undefined
              ? {}
              : { requestId: finish.failure.requestId }),
          })
        }
        continue
      }
      const message = createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: request.provider,
          model: request.model,
          ...(assembler.replayState !== undefined
            ? { replayState: assembler.replayState }
            : {}),
        },
      })
      this.session.append(
        'assistant/message',
        {
          turn,
          step,
          message,
          ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
        },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )
      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }
      const toolCalls = message.content.filter(
        (block): block is Extract<typeof block, { type: 'tool-call' }> =>
          block.type === 'tool-call',
      )
      if (toolCalls.length === 0) return { kind: 'completed' }
      const { concluded } = await executeToolCalls(
        {
          agent: this,
          tools: this.deps.tools,
          maxParallel:
            this.deps.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS,
          turn,
          step,
          signal,
          acceptContext: (context) =>
            this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [
              context,
            ]),
        },
        toolCalls,
      )
      return concluded ? { kind: 'completed' } : null
    }
  }

  private buildRequest(
    turn: number,
    step: number,
    tools: ToolSchema[],
    system: string,
    messages: Message[],
    signal: AbortSignal,
  ): { request: GenerateOptions; prepared?: PreparedLlmCall } {
    const session = this.session
    const persisted = session.requestHeader()
    const base =
      this.options.callConfig?.() ?? this.deps.llm.defaultCallConfig()
    // A resumed session keeps its explicitly chosen effort while the route is unchanged.
    const reasoningEffort =
      persisted?.config.provider === base.provider &&
      persisted.config.model === base.model &&
      persisted.adapterDefaults?.reasoningEffort !== true
        ? persisted.config.reasoningEffort
        : undefined
    let proposed: LlmCallConfig = deepFreeze(
      structuredClone(
        this.requestHeaderLogged &&
          persisted !== undefined &&
          persisted.config.provider === base.provider &&
          persisted.config.model === base.model
          ? requestProposal(persisted)
          : {
              ...base,
              ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            },
      ),
    )
    for (const middleware of this.deps.middleware.requestConfig) {
      const next = middleware({ agent: this, turn, step, config: proposed })
      if (next !== undefined) proposed = next
    }
    if (!proposed.provider || !proposed.model)
      throw new Error(`agent "${this.id}" has no model route configured`)
    let config: LlmCallConfig
    let prepared: PreparedLlmCall | undefined
    try {
      prepared = this.deps.llm.prepareCall(proposed)
      config = prepared.config
    } catch (error: unknown) {
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER')
        throw error
      config = proposed
    }
    const header = canonicalHeader({
      config,
      ...(prepared === undefined
        ? {}
        : { adapterDefaults: prepared.adapterDefaults }),
      ...(system ? { system } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    })
    const baseline = session.requestHeader()
    if (!this.requestHeaderLogged) {
      session.append('request/header', {
        header,
        reason: baseline === undefined ? 'initial' : 'resume',
      })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      session.append('request/header', { header, reason: 'change' })
    }
    const contextWindow = prepared?.context?.contextWindow
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    }
    const previous = session.requestContext()
    if (
      previous?.provider !== requestContext.provider ||
      previous.model !== requestContext.model ||
      previous.contextWindow !== requestContext.contextWindow
    ) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()
    const request: GenerateOptions = {
      ...header.config,
      messages,
      ...(header.system !== undefined ? { system: header.system } : {}),
      ...(header.tools !== undefined ? { tools: header.tools } : {}),
      sessionId: session.id,
      signal,
    }
    return { request, ...(prepared === undefined ? {} : { prepared }) }
  }
}
