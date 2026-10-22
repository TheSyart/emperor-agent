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
 * pre-step middleware → commit the claim → `step/start` → `user/message`
 * per entering message → request built ONLY from `session.deriveMessages()`
 * + the logged `request/header` → every chunk logged as `assistant/chunk` →
 * `assistant/message` → tool calls → `step/end`. A turn may stop when a
 * step completes (no tool calls, `concludesTurn`, or sticky max-tokens) and
 * next-step is empty; turn-stopping middleware can steer another step.
 *
 * Message lifecycle (KRN-02): a message is consumed only once its
 * `user/message` is logged. The claim reserves messages; a pre-step that
 * rejects, is stopped or throws releases them at the head of the queue.
 * Every message has one outcome (`outcome(id)`): consumed at the `turn/end`
 * of the turn that took it, not consumed (held: the turn before it failed
 * or was stopped, so it waits for the user to send it again), or discarded.
 *
 * Budget (KRN-03): before each step (and before claiming its messages)
 * the `budget` middleware may end the turn (`turn/end` reason `budget`: a
 * step limit, or a task's spent cost cap), after logging a notice the model
 * reads with its next request. Every request attempt, a failed one
 * included, is reported to `requestEnd` so its usage is charged. An
 * optional admission gate (`AgentOptions.admission`) may keep an idle
 * agent from starting: its messages stay queued until the gate wakes it.
 */

import { BlockAssembler } from '../../llm/assembler'
import type { LlmCallConfig } from '../../llm/call-config'
import type { LlmClient, PreparedLlmCall } from '../../llm/client'
import { errorChain, LlmError } from '../../llm/error'
import { deepFreeze } from '../../llm/freeze'
import {
  contextMessage,
  createAssistantMessage,
  type UserMessage,
} from '../../llm/message'
import type { GenerateOptions, TokenUsage, ToolSchema } from '../../llm/types'
import { ToolCallRecovery } from '../../session-log/repair'
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
import {
  Inbox,
  isUserTyped,
  type Claim,
  type DiscardReason,
  type HoldReason,
  type InboxTarget,
  type QueueChange,
} from './inbox'
import { offloadImages } from './image-offload'
import type { AgentMiddleware, BudgetStop, PreStepDecision } from './middleware'
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
  /** Whether the agent may start running now (KRN-03 task tree pool). */
  admission?: AgentAdmission
}

/**
 * Decides when an idle agent may start running. A refused agent stays idle
 * with its messages queued; the gate calls `wakeInbox()` once it may run.
 */
export interface AgentAdmission {
  admit(agent: Agent): boolean
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
  /** A pending message changed queue state (reserved, released, held, sent again, discarded). */
  queue?(agent: Agent, change: QueueChange): void
}

/** What became of one message (KRN-02). */
export type MessageOutcome =
  /** A turn took it; resolved at that turn's `turn/end`. */
  | { kind: 'consumed'; turn: number; reason: TurnEndReason }
  /** Still in the inbox, held until the user sends it again. */
  | { kind: 'not-consumed'; reason: HoldReason }
  /** Removed from the inbox without entering a step. */
  | { kind: 'discarded'; reason: DiscardReason }

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
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
      /** Ids of the messages the current turn consumed. */
      consumed: Set<string>
      /** A stop is unwinding the turn: released messages are held or discarded. */
      stopping: boolean
      /** How the last turn of this run ended. */
      lastEnd?: TurnEndReason['kind']
    }

type StepEndReason = Extract<
  TurnEndReason,
  { kind: 'completed' | 'max-tokens' | 'plan-dismissed' }
>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; assembly: PromptAssembly }

/**
 * The cause `cancel()` passed when it aborted a signal this agent owns,
 * copied field by field. The live reason stays the caller's object, which a
 * transport may decorate once it sees the abort (Node's fetch assigns an
 * enumerable `stack`), and `turn/end` must record only the cause itself.
 * Returns undefined while the signal is live.
 */
function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  // `cancel()` is the only aborter of these signals; anything else reads as the user's stop.
  const cause = signal.reason as Partial<AgentCancelCause> | undefined
  switch (cause?.kind) {
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return {
        kind: 'hook',
        reason: typeof cause.reason === 'string' ? cause.reason : '',
      }
    default:
      return { kind: 'user' }
  }
}

/** Producer of the context notice logged when another model takes over. */
export const MODEL_SWITCH_PRODUCER = 'model-switch'

function modelSwitchNotice(from: string, to: string): UserMessage {
  return contextMessage(
    MODEL_SWITCH_PRODUCER,
    `From this step on, the ${to} model continues this conversation (earlier replies came from ${from}).`,
    { form: 'notice', summary: `本步起由 ${to} 继续` },
  )
}

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
  private readonly outcomes = new Map<string, Deferred<MessageOutcome>>()
  private readonly turnWaiters = new Set<{
    turn: number
    resolve: () => void
  }>()
  private disposed = false

  constructor(
    readonly session: Session,
    private readonly deps: AgentDeps,
    private readonly options: AgentOptions = {},
  ) {
    this.toolFilter = options.toolFilter
    this.owner = options.owner
    this.inbox = new Inbox(session, {
      changed: (change) => {
        this.queueChanged(change)
      },
    })
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

  /**
   * The call config this agent's next request starts from: its own route
   * when it has one, else the active route (throws when none is configured).
   * Request-config middleware (e.g. a turn's fallback) may still replace it.
   */
  proposedCallConfig(): LlmCallConfig {
    return this.options.callConfig?.() ?? this.deps.llm.defaultCallConfig()
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
    this.releaseTurnWaiters()
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
    this.inbox.append(resolvedTarget, message)
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  /** Wake an already durable inbox without inserting another message. */
  wakeInbox(): void {
    if (this.disposed) throw new Error(`agent "${this.id}" is disposed`)
    if (this.inbox.hasClaimable()) this.wakeDriver()
  }

  /**
   * What becomes of one message. Ask before sending it (or while it is
   * pending); a message already settled in the log resolves from the log.
   */
  outcome(messageId: string): Promise<MessageOutcome> {
    const waiting = this.outcomes.get(messageId)
    if (waiting !== undefined) return waiting.promise
    const known = this.knownOutcome(messageId)
    if (known !== undefined) return Promise.resolve(known)
    const pending = deferred<MessageOutcome>()
    this.outcomes.set(messageId, pending)
    return pending.promise
  }

  /**
   * A submitter cancelled one message: while it waits it is discarded;
   * once a turn reserved or consumed it, only that turn is cancelled and
   * whatever else is queued still runs.
   */
  cancelMessage(messageId: string): 'discarded' | 'cancelled' | 'not-found' {
    const state = this.inbox.stateOf(messageId)
    if (state === 'queued' || state === 'failed-previous')
      return this.inbox.discard(messageId, 'cancelled')
        ? 'discarded'
        : 'not-found'
    if (this.phase.kind !== 'running') return 'not-found'
    if (state === 'sending') this.inbox.withdraw(messageId)
    else if (!this.phase.consumed.has(messageId)) return 'not-found'
    this.phase.wakeRequested = !this.disposed
    this.phase.abort.abort({ kind: 'user' } satisfies AgentCancelCause)
    return 'cancelled'
  }

  /** The user sends a held message again (发送): it runs like a new prompt. */
  sendQueued(messageId: string): boolean {
    if (this.disposed || !this.inbox.unhold(messageId)) return false
    this.wakeDriver(true)
    return true
  }

  /** Move a queued (or held) `next-turn` message into the next step (插入当前执行). */
  interjectQueued(messageId: string): boolean {
    if (this.disposed) return false
    const state = this.inbox.stateOf(messageId)
    if (state !== 'queued' && state !== 'failed-previous') return false
    if (!this.inbox.promote(messageId)) return false
    if (state === 'failed-previous') {
      this.inbox.unhold(messageId)
      this.wakeDriver(true)
    }
    return true
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

  /**
   * Cancel the active work. Without `keepInbox` this is a stop: harness
   * context waiting in the inbox is discarded and the user's queued
   * messages are held (they wait for the user to send or discard them).
   */
  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.discardWhere((message) => !isUserTyped(message), 'stopped')
      this.holdUnsent('previous-turn-stopped')
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
      if (this.phase.kind === 'running') this.phase.stopping = true
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
        if (maintenance.wakeRequested && this.inbox.hasClaimable())
          this.wakeDriver()
        resolveDone()
      }
    })()
  }

  /**
   * Resolve once the driver is past `turn` (default: the turn running now):
   * idle, or into a later turn. Unlike `whenIdle`, never waits for turns
   * queued behind it.
   */
  whenTurnSettled(turn?: number): Promise<void> {
    const target =
      turn ?? (this.phase.kind === 'running' ? this.phase.turn : -1)
    if (this.turnSettled(target)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.turnWaiters.add({ turn: target, resolve })
    })
  }

  private turnSettled(turn: number): boolean {
    return this.phase.kind !== 'running' || this.phase.turn > turn
  }

  private releaseTurnWaiters(): void {
    for (const waiter of this.turnWaiters) {
      if (!this.turnSettled(waiter.turn)) continue
      this.turnWaiters.delete(waiter)
      waiter.resolve()
    }
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
      const reason = abortedCancelCause(this.phase.abort.signal)
      if (
        reason?.kind !== 'disposed' &&
        (this.phase.kind === 'maintenance' || wakeAfterAbort)
      ) {
        this.phase.wakeRequested = true
      }
      return
    }
    // Parked: the gate wakes it (wakeInbox) once it may run.
    if (this.options.admission?.admit(this) === false) return
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
      consumed: new Set(),
      stopping: false,
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
        const { turn, wakeRequested, lastEnd } = this.phase
        const restart =
          wakeRequested && this.inbox.hasClaimable() && !this.disposed
        // The driver stops with user messages still waiting: they never run
        // on their own; the user sends or discards them.
        if (!restart)
          this.holdUnsent(
            lastEnd === 'error' || lastEnd === 'blocked'
              ? 'previous-turn-failed'
              : 'previous-turn-stopped',
          )
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (restart) this.wakeDriver()
      }
    }
  }

  /** Hold every waiting user message that is neither held nor reserved. */
  private holdUnsent(reason: HoldReason): void {
    for (const message of [...this.inbox.nextStep, ...this.inbox.nextTurn])
      if (isUserTyped(message)) this.inbox.hold(message.id, reason)
  }

  private queueChanged(change: QueueChange): void {
    if (change.state === 'failed-previous')
      this.settleOutcome(change.message.id, {
        kind: 'not-consumed',
        reason: change.reason,
      })
    else if (change.state === 'discarded')
      this.settleOutcome(change.message.id, {
        kind: 'discarded',
        reason: change.reason,
      })
    for (const observer of this.observers) {
      try {
        observer.queue?.(this, change)
      } catch {
        // Observers never affect the driver.
      }
    }
  }

  private settleOutcome(messageId: string, outcome: MessageOutcome): void {
    const waiting = this.outcomes.get(messageId)
    if (waiting === undefined) return
    this.outcomes.delete(messageId)
    waiting.resolve(outcome)
  }

  /** The outcome of a message no longer pending, read from the log. */
  private knownOutcome(messageId: string): MessageOutcome | undefined {
    const held = this.inbox.holdReason(messageId)
    if (held !== undefined) return { kind: 'not-consumed', reason: held }
    if (this.inbox.locate(messageId) !== undefined) return undefined
    if (this.phase.kind === 'running' && this.phase.consumed.has(messageId))
      return undefined
    let turn: number | undefined
    let consumedIn: number | undefined
    for (const event of this.session.events) {
      if (event.type === 'turn/start') turn = event.data.turn
      else if (event.type === 'user/message' && event.data.id === messageId)
        consumedIn = turn
      else if (
        event.type === 'turn/end' &&
        consumedIn !== undefined &&
        event.data.turn === consumedIn
      )
        return { kind: 'consumed', turn: consumedIn, reason: event.data.reason }
      else if (
        event.type === 'agent/inbox/discarded' &&
        event.data.messageIds.includes(messageId)
      )
        return { kind: 'discarded', reason: event.data.reason }
    }
    return undefined
  }

  /** A claimed step did not enter: its messages stay queued. */
  private releaseClaim(
    claim: Claim,
    reason: 'aborted' | 'rejected' | 'failed',
  ): void {
    const released = claim.release(reason)
    if (this.phase.kind !== 'running' || !this.phase.stopping) return
    // Stopped while the step was being prepared: same as a stop while queued.
    const ids = new Set(released.map((message) => message.id))
    this.inbox.discardWhere(
      (message) => ids.has(message.id) && !isUserTyped(message),
      'stopped',
    )
    for (const message of released)
      if (isUserTyped(message))
        this.inbox.hold(message.id, 'previous-turn-stopped')
  }

  /** Resolve the turn's consumed messages; a failed turn holds the rest. */
  private settleTurn(turn: number, reason: TurnEndReason): void {
    if (this.phase.kind === 'running') {
      this.phase.lastEnd = reason.kind
      for (const messageId of this.phase.consumed)
        this.settleOutcome(messageId, { kind: 'consumed', turn, reason })
    }
    if (reason.kind === 'error' || reason.kind === 'blocked')
      this.holdUnsent('previous-turn-failed')
  }

  /** The first budget that ends the turn before `step`, if one is spent. */
  private budgetStop(turn: number, step: number): BudgetStop | undefined {
    for (const middleware of this.deps.middleware.budget) {
      const stop = middleware({ agent: this, turn, step })
      if (stop !== undefined) return stop
    }
    return undefined
  }

  /** Report one finished request attempt (its usage is charged, KRN-03). */
  private requestEnded(
    turn: number,
    step: number,
    provider: string,
    usage: TokenUsage | undefined,
    attempt: 'ok' | 'failed',
  ): void {
    for (const middleware of this.deps.middleware.requestEnd) {
      try {
        middleware({ agent: this, turn, step, provider, usage, attempt })
      } catch (error: unknown) {
        logger.warn('request-end middleware failed', {
          session: this.id,
          error: errorChain(error),
        })
      }
    }
  }

  private async preStep(
    claimed: readonly UserMessage[],
    position: { turn: number; step: number },
  ): Promise<PreparedStep> {
    if (this.phase.kind !== 'running')
      throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    for (const hook of this.deps.middleware.preAssemble) {
      await hook({ agent: this, ...position, signal })
      signal.throwIfAborted()
    }
    const assembly = this.deps.prompt.assemble({ agent: this, signal })
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(
      joinContextSections(sections),
      sections,
    )
    let decision: PreStepDecision = {
      kind: 'enter',
      messages: context === undefined ? [...claimed] : [...claimed, context],
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
    phase.consumed = new Set()
    this.releaseTurnWaiters()
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const stop = this.budgetStop(turn, step)
        if (stop !== undefined) {
          // Nothing is claimed: whatever waits stays queued for later.
          if (stop.notice !== undefined)
            this.session.append('user/message', stop.notice, {
              surfaceOp: 'append',
            })
          turnEnds = stop.reason
          return false
        }
        const claim = this.inbox.claim(target)
        let decision: PreparedStep
        try {
          decision = await this.preStep(claim.messages, { turn, step })
          signal.throwIfAborted()
        } catch (error: unknown) {
          this.releaseClaim(claim, signal.aborted ? 'aborted' : 'failed')
          throw error
        }
        if (decision.kind === 'reject') {
          this.releaseClaim(claim, 'rejected')
          turnEnds = { kind: 'blocked' }
          return false
        }
        // Consumed from here: the messages leave the inbox right before
        // their user/message (one synchronous block, one log batch).
        const entered = new Set(decision.messages.map((message) => message.id))
        for (const messageId of claim.commit(entered))
          phase.consumed.add(messageId)
        if (turnEnds && decision.messages.length === 0) break
        if (phase.step === 0 && decision.messages.length === 0) {
          // Nothing to run (e.g. a dropped stale goal round): an empty turn.
          turnEnds = { kind: 'completed' }
          break
        }
        const stepStartSeq = this.session.append('step/start', {
          turn,
          step,
        }).seq
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
        } catch (error: unknown) {
          this.answerOpenToolCalls(stepStartSeq, error)
          throw error
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && !this.inbox.hasClaimable('next-step')) {
          for (const middleware of this.deps.middleware.turnStopping) {
            await middleware({ agent: this, turn, signal })
            signal.throwIfAborted()
          }
        }
        if (turnEnds && !this.inbox.hasClaimable('next-step')) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      const cause = abortedCancelCause(signal)
      if (cause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cause }
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
      const reason = turnEnds ?? { kind: 'completed' as const }
      this.session.append('turn/end', { turn, reason })
      this.settleTurn(turn, reason)
    }
    if (!this.inbox.hasClaimable() || this.disposed) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  /**
   * A step that throws must not leave assistant tool calls without results:
   * the next request would replay them dangling and strict providers reject
   * the whole transcript. Calls that never got a `tool/call` are answered as
   * not started; started ones as outcome unknown (the crash-repair results).
   */
  private answerOpenToolCalls(stepStartSeq: number, cause: unknown): void {
    const recovery = new ToolCallRecovery()
    for (const event of this.session.events.slice(stepStartSeq))
      recovery.observe(event)
    try {
      for (const result of recovery.results(this.session.seq, Date.now())) {
        this.session.append('tool/result', result.data, {
          surfaceOp: 'append',
          ...(result.sourceEventSeqs === undefined
            ? {}
            : { sourceEventSeqs: result.sourceEventSeqs }),
        })
      }
    } catch (recoveryError: unknown) {
      throw new AggregateError(
        [cause, recoveryError],
        'step failed and its open tool calls could not be answered',
        { cause },
      )
    }
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
        if (assembler.usage !== undefined)
          this.requestEnded(
            turn,
            step,
            request.provider,
            assembler.usage,
            'failed',
          )
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
      const failed = finish.kind === 'error' || finish.kind === 'aborted'
      this.requestEnded(
        turn,
        step,
        request.provider,
        assembler.usage,
        failed ? 'failed' : 'ok',
      )
      if (failed) {
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
      const { concluded, conclusion } = await executeToolCalls(
        {
          agent: this,
          tools: this.deps.tools,
          maxParallel:
            this.deps.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS,
          turn,
          step,
          signal,
          acceptContext: (context) => {
            this.inbox.append('next-step', context)
          },
        },
        toolCalls,
      )
      if (!concluded) return null
      return { kind: conclusion ?? 'completed' }
    }
  }

  private buildRequest(
    turn: number,
    step: number,
    tools: ToolSchema[],
    system: string,
    signal: AbortSignal,
  ): { request: GenerateOptions; prepared?: PreparedLlmCall } {
    const session = this.session
    const persisted = session.requestHeader()
    const base = this.proposedCallConfig()
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
    // A different model takes over from here (the user switched, or a
    // fallback): say so in the log, so the model knows earlier replies were
    // another model's. The first request of a session has nothing to compare.
    if (previous !== undefined && previous.model !== requestContext.model) {
      session.append(
        'user/message',
        modelSwitchNotice(previous.model, requestContext.model),
        { surfaceOp: 'append' },
      )
    }
    if (
      previous?.provider !== requestContext.provider ||
      previous.model !== requestContext.model ||
      previous.contextWindow !== requestContext.contextWindow
    ) {
      session.append('request/context', requestContext)
    }
    // Images past the route's inline budget leave the requests for good (logged).
    if (prepared?.imageBudgetBytes !== undefined)
      offloadImages(session, prepared.imageBudgetBytes)
    signal.throwIfAborted()
    const request: GenerateOptions = {
      ...header.config,
      messages: session.deriveMessages(),
      ...(header.system !== undefined ? { system: header.system } : {}),
      ...(header.tools !== undefined ? { tools: header.tools } : {}),
      sessionId: session.id,
      signal,
    }
    return { request, ...(prepared === undefined ? {} : { prepared }) }
  }
}
