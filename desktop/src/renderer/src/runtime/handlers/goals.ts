import type {
  GoalEvidenceProjection,
  GoalGateProjection,
  GoalProjectionState,
  RuntimeGoalSummary,
} from '../../types'
import type { GoalRuntimeEvent } from '../events'

export type { GoalProjectionState } from '../../types'

const TERMINAL_EVENTS = new Set<GoalRuntimeEvent['event']>([
  'goal_completed',
  'goal_blocked',
  'goal_cancelled',
  'goal_policy_stopped',
])

export function createGoalProjectionState(): GoalProjectionState {
  return {
    byId: {},
    activeBySession: {},
    latestGateByGoal: {},
    latestEvidenceByGoal: {},
  }
}

export function applyGoalEvent(
  projection: GoalProjectionState,
  event: GoalRuntimeEvent,
): GoalProjectionState {
  const goalId = String(event.goal_id || '').trim()
  const sessionId = String(event.session_id || '').trim()
  const lastEventSeq = Number(event.last_event_seq)
  if (!goalId || !sessionId || !Number.isSafeInteger(lastEventSeq)) {
    return projection
  }

  const current = projection.byId[goalId]
  const eventGoal = 'goal' in event && event.goal ? event.goal : null
  if (!current && !eventGoal) return projection
  if (current && lastEventSeq < current.lastEventSeq) return projection
  if (current && lastEventSeq === current.lastEventSeq && eventGoal)
    return projection

  const updatedAt = String(event.updated_at || '')
  const nextSummary = eventGoal
    ? normalizeSummary(eventGoal, {
        goalId,
        sessionId,
        lastEventSeq,
        updatedAt,
      })
    : {
        ...current!,
        lastEventSeq,
        updatedAt: updatedAt || current!.updatedAt,
      }
  const byId = { ...projection.byId, [goalId]: nextSummary }
  const activeBySession = { ...projection.activeBySession }
  if (
    TERMINAL_EVENTS.has(event.event) ||
    isTerminalStatus(nextSummary.status)
  ) {
    if (activeBySession[sessionId] === goalId) delete activeBySession[sessionId]
  } else {
    activeBySession[sessionId] = goalId
  }

  let latestEvidenceByGoal = projection.latestEvidenceByGoal
  if (event.event === 'goal_evidence_recorded') {
    const evidence: GoalEvidenceProjection = {
      goalId,
      sessionId,
      lastEventSeq,
      criterionId: event.criterion_id,
      verdict: event.verdict,
      sourceCount: Math.max(0, Number(event.source_count || 0)),
      summary: event.summary,
      recordedAt: updatedAt,
    }
    latestEvidenceByGoal = {
      ...latestEvidenceByGoal,
      [goalId]: evidence,
    }
  }

  let latestGateByGoal = projection.latestGateByGoal
  if (event.event === 'goal_gate_evaluated') {
    const gate: GoalGateProjection = {
      goalId,
      sessionId,
      lastEventSeq,
      passed: event.passed,
      reasonCodes: event.reason_codes.slice(0, 20),
      reasonCount: Math.max(0, Number(event.reason_count || 0)),
      evaluatedAt: updatedAt,
    }
    latestGateByGoal = { ...latestGateByGoal, [goalId]: gate }
  }

  return { byId, activeBySession, latestGateByGoal, latestEvidenceByGoal }
}

function normalizeSummary(
  goal: RuntimeGoalSummary,
  identity: {
    goalId: string
    sessionId: string
    lastEventSeq: number
    updatedAt: string
  },
): RuntimeGoalSummary {
  return {
    ...goal,
    id: identity.goalId,
    sessionId: identity.sessionId,
    lastEventSeq: identity.lastEventSeq,
    createdAt: goal.createdAt || goal.updatedAt || identity.updatedAt,
    updatedAt: identity.updatedAt || goal.updatedAt,
  }
}

function isTerminalStatus(status: RuntimeGoalSummary['status']): boolean {
  return (
    status === 'completed' ||
    status === 'blocked' ||
    status === 'cancelled' ||
    status === 'stopped_by_policy'
  )
}
