import type { GoalProjectionState, RuntimeGoalView } from '../types'

export function activeGoalForSession(
  projection: GoalProjectionState,
  sessionId: string,
): RuntimeGoalView | null {
  return projection.bySession[sessionId] ?? null
}

export function hasProjectedGoal(
  projection: GoalProjectionState,
  sessionId: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(projection.bySession, sessionId)
}
