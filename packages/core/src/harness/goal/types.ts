/**
 * Goal domain vocabulary (ported from dsh-goal types.ts + domain.ts).
 *
 * One current goal per session, event-sourced from the session log:
 *
 * - `goal/change` (dsh name and payload, version 1): every mutation carries
 *   the complete post-change snapshot; `clear` writes a revisioned tombstone.
 * - `goal/round` (Emperor addition): reserves one continuation round for a
 *   specific inbox message. dsh attributed rounds by a `goal` message source,
 *   which Emperor's closed `MessageSource` union does not have; the round
 *   prompt is a `context` message (`producer: 'goal'`), and the reservation
 *   event links its message id to the goal identity. Only the matching
 *   `user/message` entering a step admits (counts) the round.
 *
 * Continuation activation (`armed` / `disarmed`) is process-local and never
 * persisted.
 */

/** Stable goal identity across its durable revisions. */
export type GoalId = string

/** Compare-and-set identity for one exact goal revision. */
export interface GoalRef {
  readonly id: GoalId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/** Input whose omitted round cap is resolved by the service configuration. */
export interface CreateGoalRequest {
  readonly objective: string
  readonly maxGoalRounds?: number
}

/** Fields changed by an edit; at least one must be present. */
export interface EditGoalRequest {
  readonly objective?: string
  readonly maxGoalRounds?: number
}

/** Durable continuation phase. Activation is process-local and separate. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Machine-routable and human-readable explanation for a blocked goal. */
export interface GoalBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

/** Full durable state written by every non-clear goal mutation. */
export interface GoalSnapshot extends GoalRef {
  readonly objective: string
  readonly phase: GoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: GoalBlockReason
  /** Total admitted goal-round cap. */
  readonly maxGoalRounds: number
}

/** Whether this live process may automatically continue an active goal. */
export type GoalActivation = 'armed' | 'disarmed'

/** Current goal view (UI and tool facing), including log-derived values. */
export interface GoalView extends GoalSnapshot {
  /** Highest admitted round number for this goal. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: GoalActivation
}

/** Goal state-changing verbs recorded in the durable change. */
export type GoalOperation =
  'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear'

/** Full-snapshot goal mutation committed by a durable `goal/change` event. */
export interface GoalSnapshotChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: Exclude<GoalOperation, 'clear'>
  readonly goal: GoalSnapshot
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Tombstone retained when the current goal is cleared. */
export interface GoalClearChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: GoalRef
  readonly clearedAt: number
}

export type GoalChangeMeta = GoalSnapshotChangeMeta | GoalClearChangeMeta

/** Durable reservation of one continuation round for one inbox message. */
export interface GoalRoundReservation {
  readonly goalId: GoalId
  readonly revision: number
  /** Positive round number this message admits when it enters a step. */
  readonly round: number
  /** Id of the queued `<goal_round>` context message. */
  readonly messageId: string
}

declare module '../../session-log/types' {
  interface SessionEventMap {
    /** Complete post-mutation goal state or clear tombstone. */
    'goal/change': GoalChangeMeta
    /** Reservation linking a queued goal-round message to its goal round. */
    'goal/round': GoalRoundReservation
  }
}

/** Pure replay fold of durable goal facts. */
export interface FoldedGoal {
  /** Current goal, absent after a clear or before the first create. */
  readonly goal?: GoalSnapshot
  /** Highest admitted round for the current goal. */
  readonly roundsStarted: number
  readonly createdAt?: number
  readonly updatedAt?: number
  /** Latest mutation ref, including a clear tombstone. */
  readonly lastRef?: GoalRef
}

/** Live notification after one durable goal mutation commits. */
export interface GoalChanged {
  readonly operation: GoalOperation
  readonly ref: GoalRef
  /** Absent for a clear tombstone. */
  readonly goal?: GoalView
}

/** Stable error codes for rejected goal reads and mutations. */
export type GoalErrorCode =
  | 'GOAL_AGENT_NOT_LIVE'
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_TRANSITION'

/** Who is asking: a host-attested human command, or a model tool call. */
export type GoalAuthority = 'user' | 'model'

/** Model-facing update actions (`update_goal.action`). */
export type GoalUpdateAction =
  'edit' | 'pause' | 'resume' | 'complete' | 'blocked'

/** `update_goal`-shaped request; empty strings / zero are strict-schema fillers. */
export interface UpdateGoalRequest {
  readonly goalId: string
  readonly revision: number
  readonly action: GoalUpdateAction
  readonly objective?: string
  readonly maxGoalRounds?: number
  readonly blockedReason?: string
}
