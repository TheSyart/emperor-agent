import { describe, expect, it } from 'vitest'
import { AcpEventProjector } from './projector'

describe('ACP runtime-event projector', () => {
  it('projects user-visible Core events in order with stable correlation', () => {
    const projector = new AcpEventProjector({
      sessionId: 'session-a',
      turnId: 'turn-a',
    })

    const updates = [
      ...projector.project({
        event: 'message_delta',
        seq: 1,
        event_id: 'evt-1',
        delta: 'hello ',
      }),
      ...projector.project({
        event: 'tool_call',
        seq: 2,
        event_id: 'evt-2',
        id: 'call-1',
        name: 'read_file',
      }),
      ...projector.project({
        event: 'tool_run_started',
        seq: 3,
        event_id: 'evt-3',
        id: 'call-1',
        name: 'read_file',
      }),
      ...projector.project({
        event: 'tool_result',
        seq: 4,
        event_id: 'evt-4',
        id: 'call-1',
        name: 'read_file',
        result: 'ok',
      }),
      ...projector.project({
        event: 'context_usage',
        seq: 5,
        event_id: 'evt-5',
        used: 10,
        max: 100,
      }),
    ]

    expect(updates.map((item) => item.update.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'tool_call_update',
      'usage_update',
    ])
    expect(updates[0]).toMatchObject({
      sessionId: 'session-a',
      update: {
        messageId: 'turn-a',
        content: { type: 'text', text: 'hello ' },
      },
      _meta: {
        emperor: { eventId: 'evt-1', sequence: 1, turnId: 'turn-a' },
      },
    })
    expect(updates[1]).toMatchObject({
      update: {
        toolCallId: 'call-1',
        title: 'read_file',
        kind: 'read',
        status: 'pending',
      },
    })
    expect(updates[3]).toMatchObject({
      update: { toolCallId: 'call-1', status: 'completed' },
    })
  })

  it('uses assistant_done only as a no-delta fallback and omits diagnostics', () => {
    const fallback = new AcpEventProjector({
      sessionId: 's',
      turnId: 't',
    })
    expect(
      fallback.project({ event: 'assistant_done', content: 'whole answer' }),
    ).toMatchObject([
      { update: { content: { type: 'text', text: 'whole answer' } } },
    ])

    const streamed = new AcpEventProjector({
      sessionId: 's',
      turnId: 't',
    })
    streamed.project({ event: 'message_delta', delta: 'already streamed' })
    expect(
      streamed.project({ event: 'assistant_done', content: 'duplicate' }),
    ).toEqual([])
    expect(
      streamed.project({
        event: 'model_attempt_started',
        request_id: 'secret-correlation',
      }),
    ).toEqual([])
    expect(
      streamed.project({ event: 'context_projection', report: { raw: 'x' } }),
    ).toEqual([])
  })

  it('bounds individual content, total events and terminal late arrivals', () => {
    const projector = new AcpEventProjector({
      sessionId: 's',
      turnId: 't',
      maxTextBytes: 8,
      maxEvents: 2,
      maxTotalBytes: 16,
    })
    const first = projector.project({
      event: 'message_delta',
      delta: '123456789',
    })
    expect(first[0]?.update).toMatchObject({
      content: { type: 'text', text: '12345678' },
    })
    projector.project({ event: 'message_delta', delta: 'x' })
    expect(() =>
      projector.project({ event: 'message_delta', delta: 'y' }),
    ).toThrow('ACP projection event budget exceeded')

    projector.terminate()
    expect(
      projector.project({ event: 'message_delta', delta: 'late' }),
    ).toEqual([])
  })

  it('projects replayed user messages without exposing hidden or diagnostic rows', () => {
    const projector = new AcpEventProjector({
      sessionId: 's',
      turnId: 'replay',
      replay: true,
    })
    expect(
      projector.project({
        event: 'user_message',
        turn_id: 'old-turn',
        content: 'question',
      }),
    ).toMatchObject([
      {
        update: {
          sessionUpdate: 'user_message_chunk',
          messageId: 'old-turn',
          content: { type: 'text', text: 'question' },
        },
      },
    ])
    expect(
      projector.project({
        event: 'user_message',
        content: 'hidden',
        ui_hidden: true,
      }),
    ).toEqual([])
  })

  it('emits one terminal tool update and preserves Emperor cancellation semantics', () => {
    const projector = new AcpEventProjector({
      sessionId: 's',
      turnId: 't',
    })
    const completed = projector.project({
      event: 'tool_run_completed',
      id: 'call-complete',
      result: 'first terminal fact',
    })
    expect(completed).toMatchObject([
      { update: { toolCallId: 'call-complete', status: 'completed' } },
    ])
    expect(
      projector.project({
        event: 'tool_result',
        id: 'call-complete',
        result: 'duplicate model-facing fact',
      }),
    ).toEqual([])

    const cancelled = projector.project({
      event: 'tool_run_cancelled',
      id: 'call-cancelled',
    })
    expect(cancelled).toMatchObject([
      {
        update: { toolCallId: 'call-cancelled', status: 'failed' },
        _meta: { emperor: { terminalReason: 'cancelled' } },
      },
    ])
    expect(
      projector.project({ event: 'tool_error', id: 'call-cancelled' }),
    ).toEqual([])
  })
})
