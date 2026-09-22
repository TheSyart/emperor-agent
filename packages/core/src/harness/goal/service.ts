/**
 * Same-session goal domain (ported from dsh-goal GoalService): event-sourced
 * state, compare-and-set mutations, and process-local continuation
 * activation. The session log is the only durable authority.
 *
 * Activation is never persisted: a session first observed by this service
 * (fresh process, resume, fork) starts `disarmed` even when its durable goal
 * is `active`; an explicit resume rearms it.
 */

import { randomUUID } from 'node:crypto'
import type { Session } from '../../session-log/session'
import { logger } from '../../util/log'
import type { Agent } from '../agent/agent'
import {
  completionAuthority,
  goalToolExecution,
  requireDirectHuman,
  type GoalToolAuthority,
} from './authority'
import { GOAL_CHANGE_VERSION, GoalError, GoalToolError } from './errors'
import {
  applyGoalEvent,
  emptyGoalFoldState,
  goalChangeRef,
  type GoalFoldState,
} from './fold'
import type {
  CreateGoalRequest,
  EditGoalRequest,
  GoalActivation,
  GoalAuthority,
  GoalBlockReason,
  GoalChangeMeta,
  GoalChanged,
  GoalClearChangeMeta,
  GoalOperation,
  GoalPhase,
  GoalRef,
  GoalSnapshot,
  GoalSnapshotChangeMeta,
  GoalView,
  UpdateGoalRequest,
} from './types'

export const DEFAULT_MAX_GOAL_ROUNDS = 256
export const DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS = 3

export interface GoalServiceOptions {
  /** Round cap used when a create request omits its own (dsh default 256). */
  defaultMaxGoalRounds?: number
  /** Minimum admitted rounds before the model may self-report `blocked` (dsh-tool-goal default 3). */
  blockedAfterConsecutiveRounds?: number
}

/** Host notification after one durable mutation commits. */
export interface GoalChangeEvent {
  readonly agent: Agent
  readonly change: GoalChanged
}

export type GoalChangeListener = (event: GoalChangeEvent) => void

/** How an `update()` was authorized (the tool uses `goal-round` to add the wrap-up). */
export type GoalUpdateAuthority = { readonly kind: 'user' } | GoalToolAuthority

interface GoalCache {
  readonly state: GoalFoldState
  activation: GoalActivation
  observedSeq: number
  pendingActivation:
    { readonly seq: number; readonly activation: GoalActivation } | undefined
}

function resolveMaxGoalRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError(
      'maxGoalRounds must be a positive safe integer',
      'GOAL_INVALID_MAX_ROUNDS',
    )
  }
  return value
}

function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError(
      'goal objective must be a non-empty string',
      'GOAL_INVALID_OBJECTIVE',
    )
  }
  return value.trim()
}

function resolveBlockReason(reason: unknown): GoalBlockReason {
  const record =
    typeof reason === 'object' && reason !== null && !Array.isArray(reason)
      ? (reason as Record<string, unknown>)
      : undefined
  const code = record?.['code']
  const message = record?.['message']
  if (
    typeof code !== 'string' ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code) ||
    typeof message !== 'string' ||
    message.trim().length === 0
  ) {
    throw new GoalError(
      'goal block reason requires a lower-kebab-case code and a non-empty message',
      'GOAL_INVALID_BLOCK_REASON',
    )
  }
  return { code, message: message.trim() }
}

/** Whether optional text is meaningful rather than a strict-schema empty filler. */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

/** Whether an optional round cap is meaningful rather than a strict-schema zero filler. */
function hasRoundCap(value: number | undefined): value is number {
  return value !== undefined && value !== 0
}

function validatedRef(goalId: string, revision: number): GoalRef {
  if (
    goalId.length === 0 ||
    goalId !== goalId.trim() ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new GoalToolError(
      'goal_id must be non-empty and revision must be a positive safe integer',
      'GOAL_TOOL_INVALID_UPDATE',
    )
  }
  return { id: goalId, revision }
}

export class GoalService {
  readonly defaultMaxGoalRounds: number
  readonly blockedAfterConsecutiveRounds: number
  private readonly caches = new WeakMap<Session, GoalCache>()
  private readonly listeners = new Set<GoalChangeListener>()

  constructor(options: GoalServiceOptions = {}) {
    this.defaultMaxGoalRounds = resolveMaxGoalRounds(
      options.defaultMaxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS,
    )
    const blockedAfter =
      options.blockedAfterConsecutiveRounds ??
      DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS
    if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) {
      throw new TypeError(
        'blockedAfterConsecutiveRounds must be a positive safe integer',
      )
    }
    this.blockedAfterConsecutiveRounds = blockedAfter
  }

  /** Observe committed mutations (UI events, the round driver). Listener failures are contained. */
  onChange(listener: GoalChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The current goal of one session, or `undefined` when none is current. */
  current(session: Session): GoalView | undefined {
    const cache = this.cache(session)
    this.sync(session, cache)
    return this.view(cache)
  }

  /** `current(agent.session)`. */
  get(agent: Agent): GoalView | undefined {
    return this.current(agent.session)
  }

  /**
   * Remove process-local continuation authority without writing a revision
   * or emitting a change. A later resume records the new activation edge.
   */
  disarm(agent: Agent): GoalView | undefined {
    const cache = this.prepare(agent)
    cache.activation = 'disarmed'
    return this.view(cache)
  }

  /**
   * Create and arm a goal. A completed goal may be replaced; any other
   * current phase must be cleared or resumed instead. Model authority
   * requires a direct human message in the calling root agent's open turn.
   */
  create(
    agent: Agent,
    request: CreateGoalRequest,
    authority: GoalAuthority = 'user',
  ): GoalView {
    if (authority === 'model') requireDirectHuman(goalToolExecution(agent))
    const objective = resolveObjective(request.objective)
    const maxGoalRounds = resolveMaxGoalRounds(
      request.maxGoalRounds ?? this.defaultMaxGoalRounds,
    )
    const cache = this.prepare(agent)
    const current = cache.state.goal
    if (current !== undefined && current.phase !== 'complete') {
      throw new GoalError(
        `goal "${current.id}" already exists with phase "${current.phase}"`,
        'GOAL_ALREADY_EXISTS',
      )
    }
    const now = Date.now()
    const goal: GoalSnapshot = {
      id: `goal-${randomUUID()}`,
      revision: 1,
      objective,
      phase: 'active',
      maxGoalRounds,
    }
    return this.commitSnapshot(
      agent,
      cache,
      'create',
      goal,
      0,
      now,
      now,
      'armed',
    )
  }

  /**
   * `update_goal` semantics: one action against the exact current revision.
   * `edit`/`pause`/`resume` under model authority require a direct human
   * turn; `complete`/`blocked` also accept the current goal round (and
   * `blocked` from a goal round needs the configured minimum round count).
   */
  update(
    agent: Agent,
    request: UpdateGoalRequest,
    authority: GoalAuthority = 'user',
  ): GoalView {
    return this.updateDetailed(agent, request, authority).goal
  }

  /** {@link update} plus how it was authorized. */
  updateDetailed(
    agent: Agent,
    request: UpdateGoalRequest,
    authority: GoalAuthority = 'user',
  ): { goal: GoalView; authority: GoalUpdateAuthority } {
    const execution =
      authority === 'model' ? goalToolExecution(agent) : undefined
    const ref = validatedRef(request.goalId, request.revision)
    const replacements: EditGoalRequest = {
      ...(hasText(request.objective) ? { objective: request.objective } : {}),
      ...(hasRoundCap(request.maxGoalRounds)
        ? { maxGoalRounds: request.maxGoalRounds }
        : {}),
    }
    const user = { kind: 'user' } as const
    if (request.action === 'edit') {
      if (execution !== undefined) requireDirectHuman(execution)
      if (hasText(request.blockedReason)) {
        throw new GoalToolError(
          'blocked_reason is valid only with action blocked',
          'GOAL_TOOL_INVALID_UPDATE',
        )
      }
      const goal = this.edit(agent, ref, replacements)
      return {
        goal,
        authority: execution === undefined ? user : { kind: 'direct-human' },
      }
    }
    if (request.action === 'pause' || request.action === 'resume') {
      if (execution !== undefined) requireDirectHuman(execution)
      if (
        hasText(request.objective) ||
        hasRoundCap(request.maxGoalRounds) ||
        hasText(request.blockedReason)
      ) {
        throw new GoalToolError(
          'objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked',
          'GOAL_TOOL_INVALID_UPDATE',
        )
      }
      const goal =
        request.action === 'pause'
          ? this.pause(agent, ref)
          : this.resume(agent, ref)
      return {
        goal,
        authority: execution === undefined ? user : { kind: 'direct-human' },
      }
    }
    const granted: GoalUpdateAuthority =
      execution === undefined
        ? user
        : completionAuthority(execution, this.get(agent))
    if (hasText(request.objective) || hasRoundCap(request.maxGoalRounds)) {
      throw new GoalToolError(
        'objective and max_goal_rounds are valid only with action edit',
        'GOAL_TOOL_INVALID_UPDATE',
      )
    }
    if (request.action === 'complete' && hasText(request.blockedReason)) {
      throw new GoalToolError(
        'blocked_reason is valid only with action blocked',
        'GOAL_TOOL_INVALID_UPDATE',
      )
    }
    if (
      request.action === 'blocked' &&
      (request.blockedReason === undefined ||
        request.blockedReason.trim().length === 0)
    ) {
      throw new GoalToolError(
        'blocked_reason is required with action blocked',
        'GOAL_TOOL_INVALID_UPDATE',
      )
    }
    if (
      request.action === 'blocked' &&
      granted.kind === 'goal-round' &&
      granted.goal.roundsStarted < this.blockedAfterConsecutiveRounds
    ) {
      throw new GoalToolError(
        `blocked requires at least ${this.blockedAfterConsecutiveRounds} consecutive goal rounds; ` +
          `current round is ${granted.goal.roundsStarted}`,
        'GOAL_TOOL_BLOCK_THRESHOLD',
      )
    }
    const goal =
      request.action === 'complete'
        ? this.complete(agent, ref)
        : this.block(agent, ref, {
            code: 'model-reported',
            message: request.blockedReason as string,
          })
    return { goal, authority: granted }
  }

  /** Edit objective and/or round cap without changing phase or activation. */
  edit(agent: Agent, ref: GoalRef, request: EditGoalRequest): GoalView {
    const cache = this.prepare(agent)
    const current = this.expectCurrent(cache, ref)
    if (
      request.objective === undefined &&
      request.maxGoalRounds === undefined
    ) {
      throw new GoalError(
        'goal edit requires objective and/or maxGoalRounds',
        'GOAL_INVALID_EDIT',
      )
    }
    const goal: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      ...(request.objective === undefined
        ? {}
        : { objective: resolveObjective(request.objective) }),
      ...(request.maxGoalRounds === undefined
        ? {}
        : { maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds) }),
    }
    return this.commitCurrent(agent, cache, 'edit', goal, cache.activation)
  }

  /** Pause an active goal and disarm automatic continuation. */
  pause(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(
      agent,
      ref,
      'pause',
      ['active'],
      'paused',
      'disarmed',
    )
  }

  /**
   * Resume and arm a stopped goal, or rearm a disarmed active goal, while its
   * round budget still has capacity. Clears any blocker reason.
   */
  resume(agent: Agent, ref: GoalRef): GoalView {
    const cache = this.prepare(agent)
    const current = this.expectCurrent(cache, ref)
    const resumable: readonly GoalPhase[] = ['active', 'paused', 'blocked']
    if (!resumable.includes(current.phase))
      throw this.transitionError(current, 'resume', resumable)
    if (current.phase === 'active' && cache.activation === 'armed') {
      throw new GoalError(
        `goal "${current.id}" is already active and armed`,
        'GOAL_INVALID_TRANSITION',
      )
    }
    if (cache.state.roundsStarted >= current.maxGoalRounds) {
      throw new GoalError(
        `goal "${current.id}" exhausted ${current.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
        'GOAL_INVALID_TRANSITION',
      )
    }
    return this.commitCurrent(
      agent,
      cache,
      'resume',
      this.withPhase(current, 'active'),
      'armed',
    )
  }

  /** Mark a current non-complete goal complete and disarm it. */
  complete(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(
      agent,
      ref,
      'complete',
      ['active', 'paused', 'blocked'],
      'complete',
      'disarmed',
    )
  }

  /** Mark an active goal blocked (policy-owned code + explanation) and disarm it. */
  block(agent: Agent, ref: GoalRef, reason: GoalBlockReason): GoalView {
    const cache = this.prepare(agent)
    const current = this.expectCurrent(cache, ref)
    if (current.phase !== 'active')
      throw this.transitionError(current, 'block', ['active'])
    return this.commitCurrent(
      agent,
      cache,
      'block',
      {
        ...this.withPhase(current, 'blocked'),
        blockedReason: resolveBlockReason(reason),
      },
      'disarmed',
    )
  }

  /** Clear the current goal through a revisioned tombstone; history stays in the log. */
  clear(agent: Agent, ref: GoalRef): GoalRef {
    const cache = this.prepare(agent)
    const current = this.expectCurrent(cache, ref)
    const tombstone: GoalRef = {
      id: current.id,
      revision: current.revision + 1,
    }
    const change: GoalClearChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: this.nextMutationTime(cache),
    }
    this.commit(agent, cache, change, 'disarmed')
    return { ...tombstone }
  }

  private prepare(agent: Agent): GoalCache {
    const cache = this.cache(agent.session)
    this.sync(agent.session, cache)
    return cache
  }

  private expectCurrent(cache: GoalCache, ref: GoalRef): GoalSnapshot {
    const current = cache.state.goal
    if (current === undefined)
      throw new GoalError('no current goal', 'GOAL_NOT_FOUND')
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new GoalError(
        `stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        'GOAL_STALE_REVISION',
      )
    }
    return current
  }

  private cache(session: Session): GoalCache {
    let cache = this.caches.get(session)
    if (cache !== undefined) return cache
    const state = emptyGoalFoldState()
    for (const event of session.events) applyGoalEvent(state, event)
    cache = {
      state,
      activation: 'disarmed',
      observedSeq: session.seq,
      pendingActivation: undefined,
    }
    this.caches.set(session, cache)
    return cache
  }

  private sync(session: Session, cache: GoalCache): void {
    if (cache.observedSeq >= session.seq) return
    for (const event of session.events.slice(cache.observedSeq)) {
      applyGoalEvent(cache.state, event)
      if (event.type === 'goal/change') {
        cache.activation =
          cache.pendingActivation?.seq === event.seq
            ? cache.pendingActivation.activation
            : 'disarmed'
      }
      cache.observedSeq += 1
    }
  }

  private withPhase(current: GoalSnapshot, phase: GoalPhase): GoalSnapshot {
    return {
      id: current.id,
      revision: current.revision + 1,
      objective: current.objective,
      phase,
      maxGoalRounds: current.maxGoalRounds,
    }
  }

  private transition(
    agent: Agent,
    ref: GoalRef,
    operation: Exclude<GoalOperation, 'create' | 'edit' | 'clear'>,
    allowed: readonly GoalPhase[],
    phase: GoalPhase,
    activation: GoalActivation,
  ): GoalView {
    const cache = this.prepare(agent)
    const current = this.expectCurrent(cache, ref)
    if (!allowed.includes(current.phase))
      throw this.transitionError(current, operation, allowed)
    return this.commitCurrent(
      agent,
      cache,
      operation,
      this.withPhase(current, phase),
      activation,
    )
  }

  private transitionError(
    current: GoalSnapshot,
    operation: GoalOperation,
    allowed: readonly GoalPhase[],
  ): GoalError {
    return new GoalError(
      `cannot ${operation} goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      'GOAL_INVALID_TRANSITION',
    )
  }

  private commitCurrent(
    agent: Agent,
    cache: GoalCache,
    operation: Exclude<GoalOperation, 'create' | 'clear'>,
    goal: GoalSnapshot,
    activation: GoalActivation,
  ): GoalView {
    const createdAt = cache.state.createdAt
    if (createdAt === undefined)
      throw new Error('current goal cache lacks createdAt')
    return this.commitSnapshot(
      agent,
      cache,
      operation,
      goal,
      cache.state.roundsStarted,
      createdAt,
      this.nextMutationTime(cache),
      activation,
    )
  }

  /** Clamp the next timestamp across backward wall-clock movement. */
  private nextMutationTime(cache: GoalCache): number {
    const updatedAt = cache.state.updatedAt
    if (updatedAt === undefined)
      throw new Error('current goal cache lacks updatedAt')
    return Math.max(Date.now(), updatedAt)
  }

  private commitSnapshot(
    agent: Agent,
    cache: GoalCache,
    operation: Exclude<GoalOperation, 'clear'>,
    goal: GoalSnapshot,
    roundsStarted: number,
    createdAt: number,
    updatedAt: number,
    activation: GoalActivation,
  ): GoalView {
    const change: GoalSnapshotChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation,
      goal,
      roundsStarted,
      createdAt,
      updatedAt,
    }
    this.commit(agent, cache, change, activation)
    const view = this.view(cache)
    if (view === undefined)
      throw new Error('snapshot commit cleared the goal unexpectedly')
    return view
  }

  private commit(
    agent: Agent,
    cache: GoalCache,
    change: GoalChangeMeta,
    activation: GoalActivation,
  ): void {
    const ref = goalChangeRef(change)
    cache.pendingActivation = { seq: agent.session.seq, activation }
    try {
      agent.session.append('goal/change', change)
      this.sync(agent.session, cache)
    } finally {
      cache.pendingActivation = undefined
    }
    const goal = this.view(cache)
    const notification: GoalChanged = {
      operation: change.operation,
      ref: { ...ref },
      ...(goal === undefined ? {} : { goal }),
    }
    for (const listener of [...this.listeners]) {
      try {
        listener({ agent, change: notification })
      } catch (error: unknown) {
        logger.warn('goal change listener threw', {
          session: agent.id,
          error: String(error),
        })
      }
    }
  }

  private view(cache: GoalCache): GoalView | undefined {
    const { goal, createdAt, updatedAt } = cache.state
    if (goal === undefined) return undefined
    if (createdAt === undefined || updatedAt === undefined)
      throw new Error(`goal "${goal.id}" cache lacks timestamps`)
    return {
      ...goal,
      roundsStarted: cache.state.roundsStarted,
      createdAt,
      updatedAt,
      activation: cache.activation,
    }
  }
}
