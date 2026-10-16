import { expect, it } from 'vitest'
import { normalizeClaudeMessage } from './claude'
it('maps pinned init, streamed text, tool call and result without reasoning', () => {
  expect(
    normalizeClaudeMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'session',
    }),
  ).toEqual([{ type: 'session_bound', sessionId: 'session' }])
  expect(
    normalizeClaudeMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
    }),
  ).toEqual([{ type: 'text_delta', text: 'hello' }])
  expect(
    normalizeClaudeMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'private' },
      },
    }),
  ).toEqual([])
  expect(
    normalizeClaudeMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool',
            name: 'Read',
            input: { file_path: 'a' },
          },
        ],
      },
    }),
  ).toEqual([{ type: 'tool_started', id: 'tool', name: 'Read' }])
  expect(
    normalizeClaudeMessage({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool',
            content: 'file bytes',
            is_error: false,
          },
        ],
      },
    }),
  ).toEqual([{ type: 'tool_finished', id: 'tool', status: 'completed' }])
  expect(
    normalizeClaudeMessage({
      type: 'result',
      subtype: 'success',
      result: 'done',
      usage: { input_tokens: 12, output_tokens: 5 },
      total_cost_usd: 0.01,
    }),
  ).toEqual(
    expect.arrayContaining([
      { type: 'turn_finished', status: 'completed', text: 'done' },
      { type: 'usage', inputTokens: 12, outputTokens: 5, estimatedUsd: 0.01 },
    ]),
  )
})
it('never promotes malformed structured JSON or non-object output into a result', () => {
  const events = normalizeClaudeMessage({
    type: 'result',
    subtype: 'success',
    result: 'partial',
    structured_output: '{"ok":',
    usage: {},
  })
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'turn_finished', status: 'failed' }),
  )
  expect(
    events.some((e) => e.type === 'turn_finished' && 'structured' in e),
  ).toBe(false)
})
it('startup error result maps to explicit failure and missing schema output stays absent', () => {
  const events = normalizeClaudeMessage({
    type: 'result',
    subtype: 'error_during_execution',
    errors: ['not authenticated'],
    usage: {},
  })
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'turn_finished', status: 'failed' }),
  )
  expect(
    normalizeClaudeMessage({
      type: 'result',
      subtype: 'success',
      result: 'plain',
      usage: {},
    }),
  ).toContainEqual({
    type: 'turn_finished',
    status: 'completed',
    text: 'plain',
  })
})
