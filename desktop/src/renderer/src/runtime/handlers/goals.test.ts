import { describe, expect, it } from 'vitest'
import type { RuntimeEventEnvelope, WsEvent } from '../../types'
import {
  applyGoalEvent,
  createGoalProjectionState,
  type GoalProjectionState,
} from './goals'
import type { GoalRuntimeEvent } from '../events'
import { replayGoalRuntimeEvents } from '../reducer'
import { activeGoalForSession } from '../selectors'

function summary(
  overrides: Partial<Extract<WsEvent, { event: 'goal_created' }>['goal']> = {},
) {
  return {
    id: 'goal_1',
    status: 'active' as const,
    phase: 'executing' as const,
    outcome: 'Ship Goal mode',
    sessionId: 'session_1',
    currentPlanId: 'plan_1',
    cyclesUsed: 1,
    acceptance: { passed: 0, failed: 0, missing: 2, total: 2 },
    createdAt: '2026-07-16T00:58:00.000Z',
    updatedAt: '2026-07-16T01:00:00.000Z',
    lastEventSeq: 1,
    ...overrides,
  }
}

function apply(
  state: GoalProjectionState,
  event: Extract<WsEvent, { event: `goal_${string}` }>,
) {
  return applyGoalEvent(state, event)
}

describe('Goal runtime projection', () => {
  it('projects lifecycle, evidence, gate and terminal history', () => {
    let state = createGoalProjectionState()
    state = apply(state, {
      event: 'goal_created',
      goal_id: 'goal_1',
      session_id: 'session_1',
      last_event_seq: 1,
      updated_at: '2026-07-16T01:00:00.000Z',
      goal: summary(),
    })
    state = apply(state, {
      event: 'goal_evidence_recorded',
      goal_id: 'goal_1',
      session_id: 'session_1',
      last_event_seq: 2,
      updated_at: '2026-07-16T01:01:00.000Z',
      criterion_id: 'ac_1',
      verdict: 'pass',
      source_count: 2,
      summary: 'tests passed',
    })
    state = apply(state, {
      event: 'goal_gate_evaluated',
      goal_id: 'goal_1',
      session_id: 'session_1',
      last_event_seq: 3,
      updated_at: '2026-07-16T01:02:00.000Z',
      passed: false,
      reason_codes: ['criterion_missing_evidence'],
      reason_count: 1,
    })
    state = apply(state, {
      event: 'goal_completed',
      goal_id: 'goal_1',
      session_id: 'session_1',
      last_event_seq: 4,
      updated_at: '2026-07-16T01:03:00.000Z',
      goal: summary({
        status: 'completed',
        phase: 'terminal',
        lastEventSeq: 4,
        updatedAt: '2026-07-16T01:03:00.000Z',
        acceptance: { passed: 2, failed: 0, missing: 0, total: 2 },
      }),
      summary: 'done',
    })

    expect(state.byId.goal_1).toMatchObject({
      status: 'completed',
      lastEventSeq: 4,
    })
    expect(state.activeBySession).toEqual({})
    expect(state.latestEvidenceByGoal.goal_1).toMatchObject({
      criterionId: 'ac_1',
      sourceCount: 2,
    })
    expect(state.latestGateByGoal.goal_1).toMatchObject({
      passed: false,
      reasonCodes: ['criterion_missing_evidence'],
    })
  })

  it('is idempotent, keeps paused Goals active, and isolates sessions', () => {
    let state = createGoalProjectionState()
    state = apply(state, {
      event: 'goal_created',
      goal_id: 'g1',
      session_id: 's1',
      last_event_seq: 5,
      updated_at: '2026-07-16T01:05:00.000Z',
      goal: summary({ id: 'g1', sessionId: 's1', lastEventSeq: 5 }),
    })
    state = apply(state, {
      event: 'goal_created',
      goal_id: 'g2',
      session_id: 's2',
      last_event_seq: 1,
      updated_at: '2026-07-16T01:00:00.000Z',
      goal: summary({ id: 'g2', sessionId: 's2', lastEventSeq: 1 }),
    })
    const beforeOld = state
    state = apply(state, {
      event: 'goal_runtime_update',
      goal_id: 'g1',
      session_id: 's1',
      last_event_seq: 4,
      updated_at: '2026-07-16T01:04:00.000Z',
      goal: summary({ id: 'g1', sessionId: 's1', lastEventSeq: 4 }),
    })
    expect(state).toBe(beforeOld)

    state = apply(state, {
      event: 'goal_paused',
      goal_id: 'g1',
      session_id: 's1',
      last_event_seq: 6,
      updated_at: '2026-07-16T01:06:00.000Z',
      goal: summary({
        id: 'g1',
        sessionId: 's1',
        phase: 'paused',
        lastEventSeq: 6,
      }),
      reason: 'user pause',
    })
    expect(state.activeBySession).toEqual({ s1: 'g1', s2: 'g2' })
    expect(activeGoalForSession(state, 's1')?.phase).toBe('paused')
  })

  it('produces the same state for live reduction and sorted replay', () => {
    const events: Array<GoalRuntimeEvent & RuntimeEventEnvelope> = [
      {
        event: 'goal_completed',
        seq: 4,
        goal_id: 'goal_1',
        session_id: 'session_1',
        last_event_seq: 3,
        updated_at: '2026-07-16T01:03:00.000Z',
        goal: summary({
          status: 'completed',
          phase: 'terminal',
          lastEventSeq: 3,
        }),
      },
      {
        event: 'goal_created',
        seq: 1,
        goal_id: 'goal_1',
        session_id: 'session_1',
        last_event_seq: 1,
        updated_at: '2026-07-16T01:00:00.000Z',
        goal: summary(),
      },
      {
        event: 'goal_runtime_update',
        seq: 3,
        goal_id: 'goal_1',
        session_id: 'session_1',
        last_event_seq: 2,
        updated_at: '2026-07-16T01:02:00.000Z',
        goal: summary({ cyclesUsed: 2, lastEventSeq: 2 }),
      },
    ]
    let live = createGoalProjectionState()
    for (const event of [...events].sort(
      (a, b) => Number(a.seq) - Number(b.seq),
    )) {
      live = applyGoalEvent(live, event)
    }

    expect(replayGoalRuntimeEvents(events)).toEqual(live)
  })

  it('ignores evidence and gate diagnostics for an unknown Goal', () => {
    const initial = createGoalProjectionState()
    const next = apply(initial, {
      event: 'goal_evidence_recorded',
      goal_id: 'missing',
      session_id: 'session_1',
      last_event_seq: 2,
      updated_at: '2026-07-16T01:00:00.000Z',
      criterion_id: 'ac_1',
      verdict: 'pass',
      source_count: 1,
      summary: 'orphan',
    })

    expect(next).toBe(initial)
    expect(next.byId).toEqual({})
    expect(next.activeBySession).toEqual({})
  })
})
