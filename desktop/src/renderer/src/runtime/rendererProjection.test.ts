import { describe, expect, it } from 'vitest'
import type { RuntimeEventEnvelope } from '../types'
import {
  createRendererProjectionState,
  replayRendererProjection,
} from './rendererProjection'

describe('renderer runtime replay reducer', () => {
  it('sorts replay, deduplicates events, and never emits live effects', () => {
    const events: RuntimeEventEnvelope[] = [
      {
        event: 'assistant_done',
        seq: 4,
        session_id: 's1',
        turn_id: 't1',
      },
      {
        event: 'task_done',
        seq: 3,
        session_id: 's1',
        task: {
          id: 'task_1',
          kind: 'subagent',
          status: 'completed',
          title: 'inspect',
          source: 'dispatch_subagent',
          endedAt: 3,
        },
      },
      {
        event: 'message_delta',
        seq: 2,
        session_id: 's1',
        turn_id: 't1',
        delta: 'working',
      },
      {
        event: 'task_started',
        seq: 1,
        session_id: 's1',
        task: {
          id: 'task_1',
          kind: 'subagent',
          status: 'running',
          title: 'inspect',
          source: 'dispatch_subagent',
          startedAt: 1,
        },
      },
      {
        event: 'task_done',
        seq: 3,
        session_id: 's1',
        task: {
          id: 'task_1',
          kind: 'subagent',
          status: 'completed',
          title: 'inspect',
          source: 'dispatch_subagent',
          endedAt: 3,
        },
      },
    ]

    const result = replayRendererProjection(
      createRendererProjectionState('s1'),
      events,
    )

    expect(result.effects).toEqual([])
    expect(result.state.session.activeLastSeq).toBe(4)
    expect(result.state.session.sessions.s1).toMatchObject({
      running: false,
      lastSeq: 4,
    })
    expect(result.state.tasks.tasks).toEqual([
      expect.objectContaining({
        id: 'task_1',
        status: 'completed',
        startedAt: 1,
        endedAt: 3,
      }),
    ])
  })
})
