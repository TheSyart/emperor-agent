// Compaction: token meter, pruner, range selection (never splits a tool
// pair), pressure-triggered summary replacement, overflow recovery, and
// manual /compact (ports the behavior of dsh compaction-basic specs).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { userText } from '../../llm/message'
import type { GenerateOptions } from '../../llm/types'
import type { SessionEvent } from '../../session-log/types'
import { createTestHarness } from '../testing'
import { defineTool } from '../tools/definition'
import {
  CompactionEngine,
  COMPACTION_INSTRUCTION,
  selectCompactableRange,
} from './engine'
import { PRUNE_MARKER, ToolResultPruner } from './pruner'
import { TokenMeter } from './token-meter'

const bigTool = defineTool({
  name: 'big',
  description: 'returns a lot of text',
  input: z.object({ n: z.number() }),
  execute: async ({ n }) => 'x'.repeat(n),
})

function summaryReply(text = '## Primary Request and Intent\n- test') {
  return (request: GenerateOptions) => {
    const last = request.messages.at(-1)
    expect(last?.content[0]).toMatchObject({
      type: 'text',
      text: COMPACTION_INSTRUCTION,
    })
    expect(request.purpose).toBe('compaction')
    return [
      { type: 'block-start' as const, index: 0, blockType: 'text' as const },
      { type: 'text-delta' as const, index: 0, text },
      { type: 'usage' as const, usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish' as const, reason: { kind: 'stop' as const } },
    ]
  }
}

describe('ToolResultPruner', () => {
  it('keeps head and tail around the marker and replaces only that node', async () => {
    const h = createTestHarness({
      replies: [
        { tools: [{ id: 'c', name: 'big', args: { n: 20000 } }] },
        { text: 'ok' },
      ],
    })
    h.tools.register(bigTool)
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    const pruner = new ToolResultPruner()
    const result = pruner.pruneSession(agent.session)
    expect(result.pruned).toHaveLength(1)
    const replacement = agent.session.lastOf('tool/result')!
    const text = (
      replacement.data.message.content[0].content[0] as { text: string }
    ).text
    expect(text).toContain(PRUNE_MARKER)
    expect(text.length).toBe(4096 + PRUNE_MARKER.length + 1024)
    expect(replacement.surfaceOp).toMatchObject({ op: 'replace' })
    expect(
      agent.session.events.some((e) => e.type === 'compaction/prune'),
    ).toBe(true)
    expect(pruner.pruneSession(agent.session).pruned).toHaveLength(0)
  })
})

describe('selectCompactableRange', () => {
  it('retains the tail budget and never splits a tool call from its result', async () => {
    const h = createTestHarness({
      replies: [
        { text: 'a' },
        { tools: [{ id: 't', name: 'big', args: { n: 10 } }] },
        { text: 'b' },
      ],
    })
    h.tools.register(bigTool)
    const agent = h.agent()
    agent.followup(userText('one'))
    await agent.whenIdle()
    agent.followup(userText('two'))
    await agent.whenIdle()
    const measurement = new TokenMeter().measure(agent.session)
    const nodes = agent.session.surface.nodes
    const lastTwo = measurement.nodes
      .slice(-2)
      .reduce((sum, node) => sum + node.tokens, 0)
    const range = selectCompactableRange(agent.session, measurement, lastTwo)!
    expect(range.start).toBe(nodes[0])
    const cutIdx = nodes.indexOf(range.end)
    const kept = nodes
      .slice(cutIdx + 1)
      .map((seq) => agent.session.events[seq]!.type)
    expect(kept[0]).not.toBe('tool/result')
    expect(
      selectCompactableRange(
        agent.session,
        measurement,
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBeNull()
  })
})

describe('CompactionEngine', () => {
  it('summarizes under pressure at pre-step and replaces the compacted range', async () => {
    const h = createTestHarness({ route: { contextWindow: 400 } })
    h.tools.register(bigTool)
    h.adapter.push({ text: 'x'.repeat(800) }, { text: 'y'.repeat(200) })
    const agent = h.agent()
    agent.followup(userText('first question'))
    await agent.whenIdle()
    agent.followup(userText('second'))
    await agent.whenIdle()
    const engine = new CompactionEngine(h.llm, new ToolResultPruner(), {
      thresholdRatio: 0.5,
      retainRatio: 0.05,
    })
    engine.install(h.middleware)
    h.adapter.push(summaryReply(), { text: 'after compaction' })
    agent.followup(userText('third'))
    await agent.whenIdle()
    const types = agent.session.events.map((e) => e.type)
    expect(types).toContain('compaction/start')
    expect(types).toContain('compaction/summary')
    expect(types).toContain('compaction/end')
    const checkpoint = agent.session.events.find(
      (e): e is SessionEvent<'user/message'> =>
        e.type === 'user/message' && e.surfaceOp !== 'append',
    )!
    expect(
      checkpoint.data.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join(''),
    ).toContain('<compacted-summary>')
    const lastRequest = h.adapter.requests.at(-1)!
    expect(lastRequest.messages[0]?.content[0]).toMatchObject({ type: 'text' })
    expect(
      (lastRequest.messages[0]!.content[0] as { text: string }).text,
    ).toContain('<compacted-summary>')
  })

  it('recovers from CONTEXT_WINDOW_EXCEEDED by compacting and retrying once', async () => {
    const h = createTestHarness({ route: { contextWindow: 1_000_000 } })
    const engine = new CompactionEngine(h.llm, new ToolResultPruner())
    engine.install(h.middleware)
    h.adapter.push({ text: 'z'.repeat(2000) })
    const agent = h.agent()
    agent.followup(userText('one'))
    await agent.whenIdle()
    h.adapter.push(
      { error: 'context length exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' },
      summaryReply(),
      { text: 'recovered' },
    )
    agent.followup(userText('two'))
    await agent.whenIdle()
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
    expect(
      agent.session.events.some((e) => e.type === 'compaction/summary'),
    ).toBe(true)
    expect(agent.session.events.some((e) => e.type === 'llm/retry')).toBe(false)
  })

  it('compacts manually while idle and rejects a summary that is not smaller', async () => {
    const h = createTestHarness()
    const engine = new CompactionEngine(h.llm, undefined, { auto: false })
    h.adapter.push({ text: 'w'.repeat(3000) }, { text: 'second answer' })
    const agent = h.agent()
    agent.followup(userText('hello'))
    await agent.whenIdle()
    agent.followup(userText('again'))
    await agent.whenIdle()
    h.adapter.push(summaryReply('short'))
    const result = await engine.compactNow(agent)
    expect(result?.shadowedSeqs.length).toBeGreaterThan(0)
    expect(agent.session.lastOf('compaction/start')?.data.turn).toBeNull()
    h.adapter.push(summaryReply('v'.repeat(50_000)))
    await expect(engine.compactNow(agent)).rejects.toThrow(/not smaller/)
    expect(agent.session.lastOf('compaction/end')?.data.error).toMatch(
      /not smaller/,
    )
  })
})
