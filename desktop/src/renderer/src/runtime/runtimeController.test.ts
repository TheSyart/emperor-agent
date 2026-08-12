import { RUNTIME_EVENT_NAMES } from '@emperor/core/runtime-contract'
import { describe, expect, it } from 'vitest'
import type { WsEvent } from '../types'
import {
  RUNTIME_EVENT_DISPATCHERS,
  runtimeEventDescriptor,
} from './runtimeDispatcher'
import {
  RuntimeControllerManager,
  SessionRuntimeController,
} from './runtimeController'

describe('typed runtime dispatcher', () => {
  it('registers every Core wire event with at least one pure projector', () => {
    expect(Object.keys(RUNTIME_EVENT_DISPATCHERS).sort()).toEqual(
      [...RUNTIME_EVENT_NAMES].sort(),
    )
    for (const name of RUNTIME_EVENT_NAMES)
      expect(runtimeEventDescriptor(name)?.projectors.length).toBeGreaterThan(0)
  })
})

describe('SessionRuntimeController', () => {
  it('produces the same projection digest for live delivery and replay', () => {
    const events = sessionEvents('s1')
    const live = new SessionRuntimeController('s1')
    const liveEffects = events.flatMap(
      (event) => live.accept(event, 'live').effects,
    )
    const replay = new SessionRuntimeController('s1')
    const replayResult = replay.replay([...events].reverse())

    expect(replay.digest()).toBe(live.digest())
    expect(replayResult.effects).toEqual([])
    expect(liveEffects).toContainEqual(
      expect.objectContaining({ type: 'refresh_memory', sessionId: 's1' }),
    )
  })

  it('fences duplicate, stale, and foreign events without regressing terminal state', () => {
    const controller = new SessionRuntimeController('s1')
    const terminal = event({
      event: 'assistant_done',
      seq: 3,
      session_id: 's1',
      turn_id: 't1',
      content: 'done',
    })

    expect(controller.accept(terminal, 'live').accepted).toBe(true)
    expect(controller.accept(terminal, 'live')).toMatchObject({
      accepted: false,
      duplicate: true,
    })
    expect(
      controller.accept(
        event({
          event: 'message_delta',
          seq: 2,
          session_id: 's1',
          turn_id: 't1',
          delta: 'stale',
        }),
        'live',
      ),
    ).toMatchObject({ accepted: false, stale: true })
    expect(
      controller.accept(
        event({
          event: 'message_delta',
          seq: 4,
          session_id: 's2',
          turn_id: 't2',
          delta: 'foreign',
        }),
        'live',
      ),
    ).toMatchObject({ accepted: false, foreign: true })
    expect(controller.state.running).toBe(false)
    expect(controller.state.chat.messages.join('')).not.toContain('stale')
  })

  it('settles a streaming session when its partial assistant is tombstoned', () => {
    const controller = new SessionRuntimeController('s1')
    controller.accept(
      event({
        event: 'message_delta',
        seq: 1,
        session_id: 's1',
        turn_id: 't1',
        delta: 'partial',
      }),
      'live',
    )
    const result = controller.accept(
      event({
        event: 'message_tombstoned',
        seq: 2,
        session_id: 's1',
        turn_id: 't1',
        reason: 'interjected',
      }),
      'live',
    )

    expect(result.accepted).toBe(true)
    expect(controller.state.running).toBe(false)
    expect(controller.state.chat.messages.at(-1)).toMatchObject({
      role: 'assistant',
      streaming: false,
      tombstoned: true,
    })
  })
})

describe('RuntimeControllerManager', () => {
  it('updates two sessions independently and exposes cached background state on switch', () => {
    const manager = new RuntimeControllerManager()
    manager.select('s1')

    manager.accept(
      event({
        event: 'message_delta',
        seq: 1,
        session_id: 's1',
        turn_id: 't1',
        delta: 'foreground',
      }),
      'live',
    )
    const background = manager.accept(
      event({
        event: 'message_delta',
        seq: 1,
        session_id: 's2',
        turn_id: 't2',
        delta: 'background',
      }),
      'live',
    )
    manager.accept(
      event({
        event: 'assistant_done',
        seq: 2,
        session_id: 's2',
        turn_id: 't2',
        content: 'background done',
      }),
      'live',
    )

    expect(background).toMatchObject({ accepted: true, foreign: true })
    expect(manager.controller('s1').state.chat.messages).not.toEqual(
      manager.controller('s2').state.chat.messages,
    )
    expect(manager.controller('s2').state.attention).toBe(true)

    const selected = manager.select('s2')
    expect(selected.state.attention).toBe(false)
    expect(
      selected.state.chat.messages.map((message) => message.content).join('\n'),
    ).toContain('background done')
  })

  it('never emits presentation effects during replay, including terminal events', () => {
    const manager = new RuntimeControllerManager()
    manager.select('s1')
    const result = manager.replay('s1', sessionEvents('s1'))

    expect(result.effects).toEqual([])
    expect(manager.controller('s1').state.pending).toEqual({
      label: '',
      detail: '',
      tone: 'running',
    })
  })
})

function sessionEvents(sessionId: string): WsEvent[] {
  return [
    event({
      event: 'user_message',
      seq: 1,
      session_id: sessionId,
      turn_id: 't1',
      content: 'hello',
    }),
    event({
      event: 'message_delta',
      seq: 2,
      session_id: sessionId,
      turn_id: 't1',
      delta: 'done',
    }),
    event({
      event: 'task_started',
      seq: 3,
      session_id: sessionId,
      task: {
        id: 'task-1',
        kind: 'subagent',
        status: 'running',
        title: 'inspect',
        source: 'dispatch_subagent',
      },
    }),
    event({
      event: 'task_done',
      seq: 4,
      session_id: sessionId,
      task: {
        id: 'task-1',
        kind: 'subagent',
        status: 'completed',
        title: 'inspect',
        source: 'dispatch_subagent',
      },
    }),
    event({
      event: 'assistant_done',
      seq: 5,
      session_id: sessionId,
      turn_id: 't1',
      content: 'done',
    }),
  ]
}

function event<T extends WsEvent>(value: T): T {
  return value
}
