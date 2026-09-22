// Recorded reference scenarios (ported from the dsh web snapshot suite): the
// chat rows Emperor's assembly produces for each recorded session, mirroring
// the conversation part of the reference `*.expected.md` snapshots (without
// the reference UI's system-prompt context row and message chrome).
import { describe, expect, it } from 'vitest'
import { deepEqual } from './assembler'
import {
  nodeOf,
  replay,
  stream,
  structural,
  visibleNodes,
} from './testing/fixtures'
import { loadScenario } from './testing/scenario'
import type { ChatSnapshot } from './types'

function kinds(snapshot: ChatSnapshot): string[] {
  return visibleNodes(snapshot).map((node) =>
    node.kind === 'tool'
      ? `tool:${node.data.name}`
      : node.kind === 'assistant'
        ? `assistant:${node.data.blocks.map((block) => block.kind).join('+')}`
        : node.kind,
  )
}

function expectConverges(name: string): void {
  const events = loadScenario(name)
  expect(
    deepEqual(
      structural(stream(events).snapshot),
      structural(replay(events).snapshot),
    ),
  ).toBe(true)
}

describe('recorded scenarios', () => {
  it('fresh-round-trip: bash tool round and DONE', () => {
    const { snapshot } = replay(loadScenario('fresh-round-trip'))
    expect(kinds(snapshot)).toEqual([
      'user',
      'assistant:reasoning+tool-call',
      'tool:bash',
      'assistant:reasoning+text',
      'turnTail',
    ])
    expect(nodeOf(snapshot, 'tool').data.result?.content).toEqual([
      { type: 'text', text: 'WEB_E2E_OK\n' },
    ])
    const tail = nodeOf(snapshot, 'turnTail').data
    expect(tail.closingText).toBe('DONE')
    expect(tail.ttftMs).toBeGreaterThan(0)
    expect(tail.tokensPerSecond).toBeGreaterThan(0)
    expect(snapshot.running).toBe(false)
    expectConverges('fresh-round-trip')
  })

  it('fresh-round-trip mid-stream: running reasoning, then the tool call', () => {
    const events = loadScenario('fresh-round-trip')
    const firstToolDelta = events.findIndex(
      (event) =>
        event.type === 'assistant/chunk' &&
        (event.data as { chunk: { type: string } }).chunk.type ===
          'tool-call-delta',
    )
    const { snapshot } = stream(events.slice(0, firstToolDelta + 1))
    expect(snapshot.running).toBe(true)
    const assistant = nodeOf(snapshot, 'assistant')
    expect(assistant.data.status).toBe('running')
    expect(assistant.data.blocks).toEqual([
      {
        kind: 'reasoning',
        text: 'The user wants me to run a simple bash command and reply with "DONE".',
      },
      {
        kind: 'tool-call',
        callId: 'call_00_BYXlxjFaalMg95YVqEeF2495',
        name: 'bash',
      },
    ])
  })

  it('steering: answered question, then the interjection and reply', () => {
    const { snapshot } = replay(loadScenario('steering'))
    expect(kinds(snapshot)).toEqual([
      'user',
      'assistant:reasoning+tool-call',
      'tool:ask_user_question',
      'user',
      'assistant:reasoning+text',
      'turnTail',
    ])
    expect(nodeOf(snapshot, 'user', 1).data.text).toBe(
      'Interjection: include the word BANANA in your final reply.',
    )
    expectConverges('steering')
  })

  it('approval-composer: denied write, escalation approved once, verify', () => {
    const { snapshot } = replay(loadScenario('approval-composer'))
    expect(kinds(snapshot)).toEqual([
      'user',
      'assistant:reasoning+tool-call',
      'tool:bash',
      'assistant:reasoning+tool-call',
      'tool:bash',
      'assistant:reasoning+tool-call',
      'tool:read',
      'assistant:reasoning+text',
      'turnTail',
    ])
    const escalated = nodeOf(snapshot, 'tool', 1).data
    expect(escalated.approvals).toEqual([
      expect.objectContaining({
        toolName: 'bash',
        outcome: 'allowed-once',
        reason: expect.stringContaining('escalate sandbox to workspace-write'),
      }),
    ])
    expect(nodeOf(snapshot, 'tool', 0).data.approvals).toEqual([])
    expectConverges('approval-composer')
  })

  it('plan-review: exit_plan_mode round then DONE', () => {
    const { snapshot } = replay(loadScenario('plan-review'))
    expect(kinds(snapshot)).toEqual([
      'user',
      'assistant:reasoning+text+tool-call',
      'tool:exit_plan_mode',
      'assistant:reasoning+text',
      'turnTail',
    ])
    expect(nodeOf(snapshot, 'tool').data.argsRaw).toContain('--greeting')
    expectConverges('plan-review')
  })
})
