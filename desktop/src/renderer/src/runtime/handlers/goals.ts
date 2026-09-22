import type { GoalProjectionState, RuntimeGoalView } from '../../types'
import type { GoalRuntimeEvent } from '../events'

export type { GoalProjectionState } from '../../types'

export function createGoalProjectionState(): GoalProjectionState {
  return { bySession: {} }
}

/** `goal_updated` carries the full current goal (or `null` after a clear). */
export function applyGoalEvent(
  projection: GoalProjectionState,
  event: GoalRuntimeEvent,
): GoalProjectionState {
  const sessionId = String(event.session_id || '').trim()
  if (!sessionId) return projection
  return setSessionGoal(projection, sessionId, normalizeGoal(event.goal))
}

export function setSessionGoal(
  projection: GoalProjectionState,
  sessionId: string,
  goal: RuntimeGoalView | null,
): GoalProjectionState {
  const current = projection.bySession[sessionId]
  // A stale revision of the same goal never overwrites a newer one.
  if (
    current &&
    goal &&
    current.id === goal.id &&
    Number(goal.revision) < Number(current.revision)
  )
    return projection
  return { bySession: { ...projection.bySession, [sessionId]: goal } }
}

export function normalizeGoal(value: unknown): RuntimeGoalView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = String(record.id ?? '').trim()
  if (!id) return null
  const blocked =
    record.blockedReason && typeof record.blockedReason === 'object'
      ? (record.blockedReason as Record<string, unknown>)
      : null
  return {
    id,
    revision: Number(record.revision ?? 0) || 0,
    objective: String(record.objective ?? ''),
    phase: String(record.phase ?? 'active'),
    ...(blocked
      ? {
          blockedReason: {
            code: String(blocked.code ?? ''),
            message: String(blocked.message ?? ''),
          },
        }
      : {}),
    maxGoalRounds: Number(record.maxGoalRounds ?? 0) || 0,
    roundsStarted: Number(record.roundsStarted ?? 0) || 0,
    createdAt: Number(record.createdAt ?? 0) || 0,
    updatedAt: Number(record.updatedAt ?? 0) || 0,
    ...(typeof record.activation === 'string'
      ? { activation: record.activation }
      : {}),
  }
}
