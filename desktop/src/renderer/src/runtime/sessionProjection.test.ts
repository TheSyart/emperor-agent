import { describe, expect, it } from 'vitest'
import type { WsEvent } from '../types'
import {
  createSessionProjectionState,
  reduceSessionProjection,
} from './sessionProjection'

describe('session action reducer', () => {
  it('is immutable and emits one session-scoped subscription effect on switch', () => {
    const initial = createSessionProjectionState()
    const frozen = structuredClone(initial)

    const transition = reduceSessionProjection(initial, {
      type: 'session_switched',
      sessionId: 's1',
    })

    expect(initial).toEqual(frozen)
    expect(transition.state).toMatchObject({
      activeSessionId: 's1',
      activeLastSeq: 0,
      transport: 'connecting',
    })
    expect(transition.effects).toEqual([
      expect.objectContaining({
        domain: 'session',
        type: 'subscribe_core_events',
        key: 'session:core-events',
        sessionId: 's1',
      }),
    ])
  })

  it('keeps terminal session state under duplicate and out-of-order events', () => {
    let state = reduceSessionProjection(createSessionProjectionState(), {
      type: 'session_switched',
      sessionId: 's1',
    }).state
    const terminal = event({
      event: 'assistant_done',
      seq: 2,
      session_id: 's1',
      turn_id: 't1',
      content: 'done',
    })
    const olderRunning = event({
      event: 'message_delta',
      seq: 1,
      session_id: 's1',
      turn_id: 't1',
      delta: 'old',
    })

    state = reduceSessionProjection(state, {
      type: 'runtime_event_received',
      origin: 'live',
      event: terminal,
    }).state
    state = reduceSessionProjection(state, {
      type: 'runtime_event_received',
      origin: 'live',
      event: olderRunning,
    }).state
    const duplicate = reduceSessionProjection(state, {
      type: 'runtime_event_received',
      origin: 'live',
      event: terminal,
    })

    expect(duplicate.meta).toMatchObject({ accepted: false, duplicate: true })
    expect(duplicate.state.sessions.s1).toEqual({
      running: false,
      attention: false,
      lastSeq: 2,
    })
    expect(duplicate.state.activeLastSeq).toBe(2)
  })

  it('tracks foreign completion without moving the active cursor and clears attention on switch', () => {
    let state = reduceSessionProjection(createSessionProjectionState(), {
      type: 'session_switched',
      sessionId: 's1',
    }).state
    const foreign = reduceSessionProjection(state, {
      type: 'runtime_event_received',
      origin: 'live',
      event: event({
        event: 'assistant_done',
        seq: 9,
        session_id: 's2',
        turn_id: 't2',
        content: 'done',
      }),
    })

    expect(foreign.meta).toMatchObject({ accepted: false, foreign: true })
    expect(foreign.state.activeLastSeq).toBe(0)
    expect(foreign.state.sessions.s2).toMatchObject({
      running: false,
      attention: true,
      lastSeq: 9,
    })

    state = reduceSessionProjection(foreign.state, {
      type: 'session_switched',
      sessionId: 's2',
    }).state
    expect(state.sessions.s2?.attention).toBe(false)
  })

  it('accepts draft materialization even when the event is owned by the new real session', () => {
    let state = reduceSessionProjection(createSessionProjectionState(), {
      type: 'session_switched',
      sessionId: 'draft:local-1',
    }).state
    const received = reduceSessionProjection(state, {
      type: 'runtime_event_received',
      origin: 'live',
      event: event({
        event: 'session_created',
        seq: 1,
        session_id: 'session-real',
        client_draft_id: 'draft:local-1',
        session: {
          id: 'session-real',
          title: 'Draft materialized',
          created_at: '2026-07-19T00:00:00.000Z',
          updated_at: '2026-07-19T00:00:00.000Z',
          preview: '',
          version: 1,
        },
      }),
    })
    expect(received.meta).toMatchObject({ accepted: true, foreign: false })

    state = reduceSessionProjection(received.state, {
      type: 'session_draft_materialized',
      draftId: 'draft:local-1',
      sessionId: 'session-real',
    }).state
    expect(state.activeSessionId).toBe('session-real')
    expect(state.activeLastSeq).toBe(1)
  })

  it('keeps the highest terminal sequence across deterministic event permutations', () => {
    const source = Array.from({ length: 20 }, (_, index) =>
      index === 19
        ? event({
            event: 'assistant_done',
            seq: 20,
            session_id: 's1',
            turn_id: 't1',
            content: 'done',
          })
        : event({
            event: 'message_delta',
            seq: index + 1,
            session_id: 's1',
            turn_id: 't1',
            delta: String(index),
          }),
    )

    for (let seed = 1; seed <= 100; seed += 1) {
      let state = reduceSessionProjection(createSessionProjectionState(), {
        type: 'session_switched',
        sessionId: 's1',
      }).state
      for (const runtimeEvent of shuffled([...source, source[19]!], seed))
        state = reduceSessionProjection(state, {
          type: 'runtime_event_received',
          origin: 'live',
          event: runtimeEvent,
        }).state
      expect(state.sessions.s1).toEqual({
        running: false,
        attention: false,
        lastSeq: 20,
      })
    }
  })
})

function event<T extends WsEvent>(value: T): T {
  return value
}

function shuffled<T>(values: T[], seed: number): T[] {
  let state = seed >>> 0
  for (let index = values.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    const target = state % (index + 1)
    ;[values[index], values[target]] = [values[target]!, values[index]!]
  }
  return values
}
