import { describe, expect, it } from 'vitest'
import { deepEqual } from './assembler'
import {
  describeNodes,
  loadKernelLog,
  nodeOf,
  replay,
  stream,
  structural,
} from './testing/fixtures'

describe('chat assembly over the recorded kernel log', () => {
  const log = loadKernelLog()

  it('projects the root session into the expected chat rows', () => {
    const { snapshot } = replay(log.root.events)
    expect(describeNodes(snapshot)).toEqual([
      'user: pick a color (shown)',
      'context: runtime-context',
      'context: memory',
      'retry: 1:started',
      'assistant[settled]: reasoning=I should look first. | text=Checking. | call=bash | call=bash',
      'tool[settled]: bash',
      'tool[settled]: bash',
      'tool[settled]: ask_user_question question=answered',
      'tool[settled]: subagent subagent=settled',
      'assistant[settled]: text=Blue it is.',
      'turnTail: turn 1 steps=4',
      'compaction[done]: Summary: the user picked blue.',
    ])
    expect(snapshot.running).toBe(false)
    expect(snapshot.turnStatus).toBeNull()
    expect(snapshot.todos).toEqual([])
  })

  it('merges host/user-meta into the user row', () => {
    const { snapshot } = replay(log.root.events)
    const user = nodeOf(snapshot, 'user')
    expect(user.data).toMatchObject({
      text: 'pick a color (shown)',
      clientMessageId: 'client-1',
      steering: false,
      content: [{ type: 'text', text: 'pick a color' }],
    })
    expect(user.turn).toBe(1)
  })

  it('attaches results, subagent and question to their tool rows', () => {
    const { snapshot } = replay(log.root.events)
    const bashA = nodeOf(snapshot, 'tool', 0)
    expect(bashA.data).toMatchObject({
      callId: 'call_bash_a',
      status: 'settled',
      turn: 1,
      step: 1,
      result: {
        isError: false,
        content: [{ type: 'text', text: 'alpha\n' }],
      },
    })
    expect(nodeOf(snapshot, 'tool', 1).data.callId).toBe('call_bash_b')
    const ask = nodeOf(snapshot, 'tool', 2)
    expect(ask.data.question).toMatchObject({
      outcome: 'answered',
      answers: { color: { selected: ['blue'] } },
    })
    const delegate = nodeOf(snapshot, 'tool', 3)
    expect(delegate.data.subagent).toMatchObject({
      description: 'research',
      mode: 'spawn',
      background: false,
      status: 'settled',
      stopReason: 'completed',
      text: 'child found x',
    })
    expect(delegate.data.subagent?.subagentId).toMatch(/^sub-/)
  })

  it('records the retry chain, compaction facts and turn metrics', () => {
    const { snapshot } = replay(log.root.events)
    const retry = nodeOf(snapshot, 'retry')
    expect(retry.data.current).toMatchObject({
      retry: 1,
      maxRetries: 2,
      state: 'started',
      code: 'SERVER',
      message: 'upstream exploded',
    })
    const compaction = nodeOf(snapshot, 'compaction')
    expect(compaction.data).toMatchObject({
      turn: null,
      status: 'done',
      shadowedItemCount: 10,
      // The golden normalizes this estimate: it depends on the length of
      // the machine's temporary path.
      shadowedTokenCount: 0,
    })
    const tail = nodeOf(snapshot, 'turnTail')
    expect(tail.data).toMatchObject({
      turn: 1,
      steps: 4,
      closingText: 'Blue it is.',
      usage: { inputTokens: 340, outputTokens: 62, cacheReadTokens: 30 },
    })
    expect(tail.data.ttftMs).toBeGreaterThan(0)
    expect(tail.data.tokensPerSecond).toBeGreaterThan(0)
    expect(snapshot.contextUsage).toMatchObject({
      usedTokens: 212,
      contextWindow: 100_000,
      provider: 'test-route',
      model: 'test-model',
    })
  })

  it('streams to the same snapshot as a full replay', () => {
    const replayed = replay(log.root.events).snapshot
    const streamed = stream(log.root.events).snapshot
    expect(deepEqual(structural(streamed), structural(replayed))).toBe(true)
  })

  it('projects the delegated child session', () => {
    const child = log.children[0]
    expect(child).toBeDefined()
    const { snapshot } = replay(child?.events ?? [])
    expect(describeNodes(snapshot)).toEqual([
      'context: subagent',
      'context: runtime-context',
      'assistant[settled]: text=child found x',
      'turnTail: turn 1 steps=1',
    ])
  })
})
