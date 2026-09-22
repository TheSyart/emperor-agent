/**
 * Pure replay fold and strict decoder for durable goal changes (ported from
 * dsh-goal fold.ts). `goal/change` is validated fail-loud exactly as dsh
 * does; round admission follows the `goal/round` reservation → matching
 * `user/message` link (see ./types.ts).
 */

import type { SessionEvent } from '../../session-log/types'
import { GOAL_CHANGE_VERSION } from './errors'
import type {
  FoldedGoal,
  GoalBlockReason,
  GoalChangeMeta,
  GoalClearChangeMeta,
  GoalOperation,
  GoalPhase,
  GoalRef,
  GoalRoundReservation,
  GoalSnapshot,
  GoalSnapshotChangeMeta,
} from './types'

const SNAPSHOT_OPERATIONS: ReadonlySet<string> = new Set([
  'create',
  'edit',
  'pause',
  'resume',
  'complete',
  'block',
])
const PHASES: ReadonlySet<string> = new Set([
  'active',
  'paused',
  'blocked',
  'complete',
])
const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Mutable accumulator kept private to the fold. */
export interface GoalFoldState {
  goal: GoalSnapshot | undefined
  roundsStarted: number
  createdAt: number | undefined
  updatedAt: number | undefined
  lastRef: GoalRef | undefined
  seenGoalIds: Set<string>
  /** Reserved but not yet admitted rounds, by message id. */
  reservations: Map<string, GoalRoundReservation>
}

export function emptyGoalFoldState(): GoalFoldState {
  return {
    goal: undefined,
    roundsStarted: 0,
    createdAt: undefined,
    updatedAt: undefined,
    lastRef: undefined,
    seenGoalIds: new Set(),
    reservations: new Map(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`goal change ${field} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`goal change ${field} must be a non-negative safe integer`)
  }
  return value
}

function decodeBlockReason(value: unknown): GoalBlockReason {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'code,message'
  ) {
    throw new Error(
      'goal change goal.blockedReason must have exactly code and message fields',
    )
  }
  if (typeof value['code'] !== 'string' || !KEBAB.test(value['code'])) {
    throw new Error(
      'goal change goal.blockedReason.code must be lower-kebab-case',
    )
  }
  if (
    typeof value['message'] !== 'string' ||
    value['message'].trim().length === 0 ||
    value['message'] !== value['message'].trim()
  ) {
    throw new Error(
      'goal change goal.blockedReason.message must be non-empty and normalized',
    )
  }
  return { code: value['code'], message: value['message'] }
}

function decodeSnapshot(value: unknown): GoalSnapshot {
  if (!isRecord(value)) throw new Error('goal change goal must be a record')
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('goal change goal.id must be a non-empty string')
  }
  if (
    typeof value['objective'] !== 'string' ||
    value['objective'].trim().length === 0 ||
    value['objective'] !== value['objective'].trim()
  ) {
    throw new Error(
      'goal change goal.objective must be non-empty and normalized',
    )
  }
  if (typeof value['phase'] !== 'string' || !PHASES.has(value['phase'])) {
    throw new Error('goal change goal.phase is invalid')
  }
  const phase = value['phase'] as GoalPhase
  const expectedKeys =
    phase === 'blocked'
      ? 'blockedReason,id,maxGoalRounds,objective,phase,revision'
      : 'id,maxGoalRounds,objective,phase,revision'
  if (Object.keys(value).sort().join(',') !== expectedKeys) {
    throw new Error(
      `goal change goal for phase ${phase} must have exactly ${expectedKeys} fields`,
    )
  }
  return {
    id: value['id'],
    revision: positiveInteger(value['revision'], 'goal.revision'),
    objective: value['objective'],
    phase,
    maxGoalRounds: positiveInteger(
      value['maxGoalRounds'],
      'goal.maxGoalRounds',
    ),
    ...(phase === 'blocked'
      ? { blockedReason: decodeBlockReason(value['blockedReason']) }
      : {}),
  }
}

function decodeRef(value: unknown): GoalRef {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'id,revision'
  ) {
    throw new Error(
      'goal clear tombstone must have exactly id and revision fields',
    )
  }
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('goal clear tombstone id must be a non-empty string')
  }
  return {
    id: value['id'],
    revision: positiveInteger(value['revision'], 'cleared.revision'),
  }
}

/**
 * Decode a value that declares itself as a goal change. Unrelated values
 * return `undefined`; malformed goal changes fail replay loudly.
 */
export function decodeGoalChange(value: unknown): GoalChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'goal/change') return undefined
  if (value['version'] !== GOAL_CHANGE_VERSION) {
    throw new Error(
      `unsupported goal change version ${String(value['version'])}`,
    )
  }
  if (value['operation'] === 'clear') {
    const allowed = ['cleared', 'clearedAt', 'kind', 'operation', 'version']
    if (Object.keys(value).sort().join(',') !== allowed.join(',')) {
      throw new Error(
        `goal clear change must have exactly ${allowed.join(',')} fields`,
      )
    }
    return {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: decodeRef(value['cleared']),
      clearedAt: nonNegativeInteger(value['clearedAt'], 'clearedAt'),
    } satisfies GoalClearChangeMeta
  }
  if (
    typeof value['operation'] !== 'string' ||
    !SNAPSHOT_OPERATIONS.has(value['operation'])
  ) {
    throw new Error('goal change operation is invalid')
  }
  const allowed = [
    'createdAt',
    'goal',
    'kind',
    'operation',
    'roundsStarted',
    'updatedAt',
    'version',
  ]
  if (Object.keys(value).sort().join(',') !== allowed.join(',')) {
    throw new Error(
      `goal snapshot change must have exactly ${allowed.join(',')} fields`,
    )
  }
  const createdAt = nonNegativeInteger(value['createdAt'], 'createdAt')
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'updatedAt')
  if (updatedAt < createdAt)
    throw new Error('goal change updatedAt cannot precede createdAt')
  return {
    kind: 'goal/change',
    version: GOAL_CHANGE_VERSION,
    operation: value['operation'] as Exclude<GoalOperation, 'clear'>,
    goal: decodeSnapshot(value['goal']),
    roundsStarted: nonNegativeInteger(value['roundsStarted'], 'roundsStarted'),
    createdAt,
    updatedAt,
  } satisfies GoalSnapshotChangeMeta
}

/** Decode one `goal/round` reservation. */
export function decodeGoalRound(value: unknown): GoalRoundReservation {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'goalId,messageId,revision,round'
  ) {
    throw new Error(
      'goal round reservation must have exactly goalId, messageId, revision, and round fields',
    )
  }
  if (
    typeof value['goalId'] !== 'string' ||
    value['goalId'].length === 0 ||
    typeof value['messageId'] !== 'string' ||
    value['messageId'].length === 0
  ) {
    throw new Error('goal round reservation ids must be non-empty strings')
  }
  return {
    goalId: value['goalId'],
    revision: positiveInteger(value['revision'], 'round.revision'),
    round: positiveInteger(value['round'], 'round.round'),
    messageId: value['messageId'],
  }
}

function requireSameDefinition(
  current: GoalSnapshot,
  next: GoalSnapshot,
  operation: GoalOperation,
): void {
  if (
    next.objective !== current.objective ||
    next.maxGoalRounds !== current.maxGoalRounds
  ) {
    throw new Error(
      `goal ${operation} cannot change objective or maxGoalRounds`,
    )
  }
}

function requireNextRevision(
  current: GoalSnapshot,
  next: GoalRef,
  operation: GoalOperation,
): void {
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new Error(
      `goal ${operation} must advance the current goal by one revision`,
    )
  }
}

function validateSnapshotTransition(
  state: GoalFoldState,
  change: GoalSnapshotChangeMeta,
  current: GoalSnapshot,
): void {
  const next = change.goal
  requireNextRevision(current, next, change.operation)
  if (state.updatedAt === undefined)
    throw new Error('current goal fold lacks updatedAt')
  if (
    change.createdAt !== state.createdAt ||
    change.updatedAt < state.updatedAt ||
    change.roundsStarted !== state.roundsStarted
  ) {
    throw new Error(
      `goal ${change.operation} does not preserve the current counters and timestamps`,
    )
  }
  switch (change.operation) {
    case 'edit':
      if (
        next.phase !== current.phase ||
        JSON.stringify(next.blockedReason) !==
          JSON.stringify(current.blockedReason)
      ) {
        throw new Error('goal edit cannot change phase or blocked reason')
      }
      break
    case 'pause':
      requireSameDefinition(current, next, change.operation)
      if (current.phase !== 'active' || next.phase !== 'paused')
        throw new Error('goal pause has an invalid phase transition')
      break
    case 'resume':
      requireSameDefinition(current, next, change.operation)
      if (
        current.phase === 'complete' ||
        next.phase !== 'active' ||
        state.roundsStarted >= next.maxGoalRounds
      ) {
        throw new Error(
          'goal resume has an invalid phase transition or exhausted round budget',
        )
      }
      break
    case 'complete':
      requireSameDefinition(current, next, change.operation)
      if (current.phase === 'complete' || next.phase !== 'complete')
        throw new Error('goal complete has an invalid phase transition')
      break
    case 'block':
      requireSameDefinition(current, next, change.operation)
      if (current.phase !== 'active' || next.phase !== 'blocked')
        throw new Error('goal block has an invalid phase transition')
      break
    case 'create':
      throw new Error(
        'goal create cannot be validated as a current-goal transition',
      )
  }
}

/** The revision identity carried by a snapshot or tombstone. */
export function goalChangeRef(change: GoalChangeMeta): GoalRef {
  return change.operation === 'clear'
    ? change.cleared
    : { id: change.goal.id, revision: change.goal.revision }
}

/** Validate and apply one decoded change. */
export function applyGoalChange(
  state: GoalFoldState,
  change: GoalChangeMeta,
): void {
  const ref = goalChangeRef(change)
  if (change.operation === 'clear') {
    const current = state.goal
    if (current === undefined)
      throw new Error('goal clear requires a current goal')
    requireNextRevision(current, change.cleared, change.operation)
    if (state.updatedAt === undefined)
      throw new Error('current goal fold lacks updatedAt')
    if (change.clearedAt < state.updatedAt)
      throw new Error(
        'goal clear timestamp cannot precede the current goal update',
      )
    state.goal = undefined
    state.roundsStarted = 0
    state.createdAt = undefined
    state.updatedAt = undefined
    state.lastRef = ref
    return
  }
  if (change.operation === 'create') {
    if (
      change.goal.revision !== 1 ||
      change.goal.phase !== 'active' ||
      change.roundsStarted !== 0 ||
      (state.goal !== undefined && state.goal.phase !== 'complete') ||
      state.seenGoalIds.has(change.goal.id)
    ) {
      throw new Error(
        'goal create requires a fresh active revision-one goal with zero rounds',
      )
    }
    state.seenGoalIds.add(change.goal.id)
  } else {
    const current = state.goal
    if (current === undefined)
      throw new Error(`goal ${change.operation} requires a current goal`)
    validateSnapshotTransition(state, change, current)
  }
  state.goal = change.goal
  state.roundsStarted = change.roundsStarted
  state.createdAt = change.createdAt
  state.updatedAt = change.updatedAt
  state.lastRef = ref
}

/**
 * Whether a reservation is exactly the next admissible round of the current
 * active goal.
 */
export function isNextRound(
  state: Pick<GoalFoldState, 'goal' | 'roundsStarted'>,
  round: Omit<GoalRoundReservation, 'messageId'>,
): boolean {
  const current = state.goal
  return (
    current !== undefined &&
    current.phase === 'active' &&
    round.goalId === current.id &&
    round.revision === current.revision &&
    round.round === state.roundsStarted + 1 &&
    round.round <= current.maxGoalRounds
  )
}

/** Apply one session event to the goal fold. */
export function applyGoalEvent(
  state: GoalFoldState,
  event: SessionEvent,
): void {
  switch (event.type) {
    case 'goal/change': {
      const change = decodeGoalChange(event.data)
      if (change === undefined)
        throw new Error(
          `goal change at session event ${event.seq} has an invalid kind`,
        )
      applyGoalChange(state, change)
      return
    }
    case 'goal/round': {
      const reservation = decodeGoalRound(event.data)
      state.reservations.set(reservation.messageId, reservation)
      return
    }
    case 'user/message': {
      const reservation = state.reservations.get(event.data.id)
      if (reservation === undefined) return
      state.reservations.delete(event.data.id)
      // A stale admission is dropped by the round driver's pre-step gate;
      // one that slips through (no gate installed) never counts.
      if (isNextRound(state, reservation))
        state.roundsStarted = reservation.round
      return
    }
    default:
  }
}

/** Fold current goal state from a contiguous session event log. */
export function foldGoal(events: readonly SessionEvent[]): FoldedGoal {
  const state = emptyGoalFoldState()
  for (const event of events) applyGoalEvent(state, event)
  return {
    ...(state.goal === undefined ? {} : { goal: { ...state.goal } }),
    roundsStarted: state.roundsStarted,
    ...(state.createdAt === undefined ? {} : { createdAt: state.createdAt }),
    ...(state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt }),
    ...(state.lastRef === undefined ? {} : { lastRef: { ...state.lastRef } }),
  }
}
