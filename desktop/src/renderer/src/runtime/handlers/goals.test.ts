import { describe, expect, it } from 'vitest'
import type {
  RuntimeEventEnvelope,
  RuntimeGoalView,
  WsEvent,
} from '../../types'
import { applyGoalEvent, createGoalProjectionState } from './goals'
import { isGoalRuntimeEvent, sortRuntimeEvents } from '../events'
import { activeGoalForSession, hasProjectedGoal } from '../selectors'

/** Replay 路径：先按 seq 排序，再逐条喂给同一个 handler。 */
function replayGoals(events: RuntimeEventEnvelope[]) {
  let projection = createGoalProjectionState()
  for (const event of sortRuntimeEvents(events))
    if (isGoalRuntimeEvent(event))
      projection = applyGoalEvent(projection, event)
  return projection
}

function view(overrides: Partial<RuntimeGoalView> = {}): RuntimeGoalView {
  return {
    id: 'goal_1',
    revision: 1,
    objective: 'Ship Goal mode',
    phase: 'active',
    maxGoalRounds: 10,
    roundsStarted: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function updated(
  goal: RuntimeGoalView | null,
  seq: number,
  sessionId = 'session_1',
): Extract<WsEvent, { event: 'goal_updated' }> {
  return { event: 'goal_updated', goal, seq, session_id: sessionId, ts: seq }
}

describe('Goal runtime projection', () => {
  it('tracks the current goal per session and clears it on null', () => {
    let state = createGoalProjectionState()
    state = applyGoalEvent(state, updated(view(), 16))
    state = applyGoalEvent(
      state,
      updated(view({ revision: 2, roundsStarted: 1 }), 32),
    )
    expect(activeGoalForSession(state, 'session_1')).toMatchObject({
      revision: 2,
      roundsStarted: 1,
    })
    state = applyGoalEvent(state, updated(null, 48))
    expect(activeGoalForSession(state, 'session_1')).toBeNull()
    expect(hasProjectedGoal(state, 'session_1')).toBe(true)
    expect(hasProjectedGoal(state, 'session_2')).toBe(false)
  })

  it('ignores stale revisions of the same goal and isolates sessions', () => {
    let state = createGoalProjectionState()
    state = applyGoalEvent(state, updated(view({ revision: 3 }), 16))
    state = applyGoalEvent(state, updated(view({ revision: 2 }), 17))
    state = applyGoalEvent(
      state,
      updated(view({ id: 'goal_2', phase: 'paused' }), 18, 'session_2'),
    )
    expect(activeGoalForSession(state, 'session_1')?.revision).toBe(3)
    expect(activeGoalForSession(state, 'session_2')?.phase).toBe('paused')
  })

  it('produces the same state for live reduction and sorted replay', () => {
    const events = [
      updated(view(), 16),
      updated(view({ revision: 2, phase: 'paused' }), 32),
      updated(view({ revision: 3, phase: 'active', roundsStarted: 2 }), 48),
    ]
    let live = createGoalProjectionState()
    for (const event of events) live = applyGoalEvent(live, event)
    expect(
      replayGoals([...events].reverse() as unknown as RuntimeEventEnvelope[]),
    ).toEqual(live)
  })

  it('drops malformed goal payloads', () => {
    const state = applyGoalEvent(
      createGoalProjectionState(),
      updated({ nope: true } as unknown as RuntimeGoalView, 16),
    )
    expect(activeGoalForSession(state, 'session_1')).toBeNull()
  })
})
