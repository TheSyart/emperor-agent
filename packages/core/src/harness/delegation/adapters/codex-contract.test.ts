import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeCodexNotification } from './codex'
it('maps only public agent text and tool state; reasoning never crosses the normalized boundary', () => {
  expect(
    normalizeCodexNotification('item/agentMessage/delta', { delta: 'hello' }),
  ).toEqual([{ type: 'text_delta', text: 'hello' }])
  expect(
    normalizeCodexNotification('item/reasoning/textDelta', {
      delta: 'private',
    }),
  ).toEqual([])
  expect(
    normalizeCodexNotification('item/started', {
      item: {
        id: 'cmd',
        type: 'commandExecution',
        command: 'python3 tests.py',
      },
    }),
  ).toEqual([
    {
      type: 'tool_started',
      id: 'cmd',
      name: 'commandExecution',
      detail: 'python3 tests.py',
    },
  ])
  expect(
    normalizeCodexNotification('item/completed', {
      item: {
        id: 'cmd',
        type: 'commandExecution',
        status: 'completed',
        exitCode: 0,
      },
    }),
  ).toEqual([{ type: 'tool_finished', id: 'cmd', status: 'completed' }])
  expect(
    normalizeCodexNotification('turn/completed', {
      turn: { id: 'turn', status: 'interrupted', items: [] },
    }),
  ).toEqual([{ type: 'turn_finished', status: 'interrupted' }])
})
it('uses per-turn last token usage rather than cumulative thread totals and never invents USD cost', () => {
  expect(
    normalizeCodexNotification('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { inputTokens: 1000, outputTokens: 500 },
        last: { inputTokens: 10, outputTokens: 5 },
      },
    }),
  ).toEqual([{ type: 'usage', inputTokens: 10, outputTokens: 5 }])
})
it('pinned generated schemas require expectedTurnId and distinct question answers', () => {
  const root = join(__dirname, '..', 'protocol', 'codex-0.153.4')
  const steer = JSON.parse(
    readFileSync(join(root, 'v2', 'TurnSteerParams.json'), 'utf8'),
  )
  expect(steer.required).toContain('expectedTurnId')
  expect(steer.properties).toHaveProperty('clientUserMessageId')
  const response = JSON.parse(
    readFileSync(join(root, 'ToolRequestUserInputResponse.json'), 'utf8'),
  )
  expect(response.required).toEqual(['answers'])
  expect(response.definitions.ToolRequestUserInputAnswer.required).toEqual([
    'answers',
  ])
})
