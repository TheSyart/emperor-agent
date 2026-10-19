// Compaction: token meter, pruner, range selection (never splits a tool
// pair), pressure-triggered summary replacement, overflow recovery, and
// manual /compact (ports the behavior of dsh compaction-basic specs).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { serializeRequest } from '../../llm/adapters/deepseek/serialize'
import { piReasoningLevel } from '../../llm/adapters/pi-ai/adapter'
import { userText } from '../../llm/message'
import { estimateTextTokens } from '../../llm/token-estimate'
import type { GenerateOptions, StreamChunk } from '../../llm/types'
import type { SessionEvent } from '../../session-log/types'
import { createTestHarness, replyChunks, testRoute } from '../testing'
import { defineTool } from '../tools/definition'
import {
  CompactionEngine,
  COMPACTION_INSTRUCTION,
  selectCompactableRange,
} from './engine'
import { PRUNE_MARKER, ToolResultPruner } from './pruner'
import { estimateMessage, TokenMeter } from './token-meter'

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

/** Rough request size under the meter's own heuristic. */
function requestTokens(request: GenerateOptions): number {
  return (
    estimateTextTokens(request.system ?? '') +
    estimateTextTokens(JSON.stringify(request.tools ?? [])) +
    request.messages.reduce((sum, message) => sum + estimateMessage(message), 0)
  )
}

const failure = (code: string): StreamChunk[] => [
  {
    type: 'finish',
    reason: { kind: 'error', failure: { message: code, code } },
  },
]

/**
 * Answer every request through one function: summary requests by
 * `compaction`, conversation requests by `loop`.
 */
function dispatch(
  h: ReturnType<typeof createTestHarness>,
  handlers: {
    compaction: (request: GenerateOptions) => StreamChunk[]
    loop: (request: GenerateOptions) => StreamChunk[]
  },
  count = 60,
): void {
  for (let index = 0; index < count; index += 1)
    h.adapter.push((request) =>
      request.purpose === 'compaction'
        ? handlers.compaction(request)
        : handlers.loop(request),
    )
}

describe('CompactionEngine (KRN-05)', () => {
  it('compacts at W − O − 65536 on a 128K window (KRN-05 #1)', async () => {
    const h = createTestHarness({
      route: { contextWindow: 128_000, maxTokens: 8_000 },
    })
    const agent = h.agent()
    for (let round = 0; round < 3; round += 1) {
      h.adapter.push({ text: 'b'.repeat(40_000) })
      agent.followup(userText('a'.repeat(40_000)))
      await agent.whenIdle()
    }
    const engine = new CompactionEngine(h.llm, new ToolResultPruner())
    engine.install(h.middleware)
    // ~60K estimated tokens: above 54,464, below the old 102,400 line.
    expect(engine.measure(agent.session).totalTokens).toBeGreaterThan(54_464)
    expect(engine.measure(agent.session).totalTokens).toBeLessThan(102_400)
    h.adapter.push(summaryReply(), { text: 'after' })
    agent.followup(userText('next'))
    await agent.whenIdle()
    expect(
      agent.session.events.some((e) => e.type === 'compaction/summary'),
    ).toBe(true)
    expect(agent.session.lastOf('compaction/summary')?.data.maxTokens).toBe(
      8_000,
    )
  })

  it('sends the summary request without thinking (KRN-05 #3)', async () => {
    const h = createTestHarness({
      route: {
        adapter: 'deepseek',
        reasoning: true,
        reasoningEfforts: ['off', 'low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        maxTokens: 8_000,
      },
    })
    const engine = new CompactionEngine(h.llm, undefined, { auto: false })
    h.adapter.push({ text: 'w'.repeat(3000) }, { text: 'second answer' })
    const agent = h.agent()
    agent.followup(userText('hello'))
    await agent.whenIdle()
    agent.followup(userText('again'))
    await agent.whenIdle()
    h.adapter.push(summaryReply('short'))
    await engine.compactNow(agent)
    const request = h.adapter.requests.at(-1)!
    expect(request.purpose).toBe('compaction')
    const body = await serializeRequest(request, { reasoningEffort: 'high' })
    expect({
      thinking: body.thinking,
      reasoning_effort: body.reasoning_effort,
      max_tokens: body.max_tokens,
    }).toMatchInlineSnapshot(`
      {
        "max_tokens": 8000,
        "reasoning_effort": undefined,
        "thinking": {
          "type": "disabled",
        },
      }
    `)
    expect(piReasoningLevel({ ...request, reasoningEffort: 'high' })).toBe(
      undefined,
    )
    expect(
      piReasoningLevel({
        ...request,
        purpose: undefined,
        reasoningEffort: 'high',
      }),
    ).toBe('high')
  })

  it('skips three steps after a failed compaction and warns after three failures in a row (KRN-05 #4)', async () => {
    const h = createTestHarness({ route: { contextWindow: 600 } })
    h.tools.register(bigTool)
    const engine = new CompactionEngine(h.llm, new ToolResultPruner())
    engine.install(h.middleware)
    const loop: Parameters<typeof replyChunks>[0][] = [
      ...Array.from({ length: 10 }, () => ({
        tools: [{ name: 'big', args: { n: 200 } }],
      })),
      { text: 'done' },
    ]
    let summaries = 0
    dispatch(h, {
      compaction: () => {
        summaries += 1
        return failure('BAD_REQUEST')
      },
      loop: () => replyChunks(loop.shift()!),
    })
    const agent = h.agent()
    agent.followup(userText('x'.repeat(2000)))
    await agent.whenIdle()
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
    const events = agent.session.events
    const attemptedSteps = events
      .filter((event) => event.type === 'compaction/start')
      .map(
        (start) =>
          (
            events.find(
              (event) => event.seq > start.seq && event.type === 'step/start',
            ) as SessionEvent<'step/start'>
          ).data.step,
      )
    expect(attemptedSteps).toEqual([2, 6, 10])
    expect(summaries).toBe(3)
    const warnings = events.filter(
      (event) => event.type === 'compaction/warning',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.data).toEqual({ failures: 3 })
  })

  it('never prunes the tool results the model has not read yet (KRN-05 #7)', async () => {
    // ~5K tokens of fresh result: above the old 0.8 × W line, so the old
    // pruner cut it before the model saw it.
    const h = createTestHarness({ route: { contextWindow: 6_000 } })
    h.tools.register(bigTool)
    const engine = new CompactionEngine(h.llm, new ToolResultPruner())
    engine.install(h.middleware)
    const loop: Parameters<typeof replyChunks>[0][] = [
      { tools: [{ id: 'fresh', name: 'big', args: { n: 20_000 } }] },
      { text: 'read it' },
    ]
    dispatch(h, {
      compaction: summaryReply('short'),
      loop: () => replyChunks(loop.shift()!),
    })
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    const second = h.adapter.requests.filter(
      (request) => request.purpose === undefined,
    )[1]!
    const result = second.messages.at(-1)!.content[0] as {
      content: Array<{ text: string }>
    }
    expect(result.content[0]!.text).toBe('x'.repeat(20_000))
    expect(
      agent.session.events.some((event) => event.type === 'compaction/prune'),
    ).toBe(false)
  })

  it('recovers from an overflow on a history twice the window by summarizing in chunks (KRN-05 #12)', async () => {
    const window = 6_000
    const h = createTestHarness()
    h.llm.setRoutes(
      [
        testRoute({ id: 'wide', contextWindow: 1_000_000 }),
        testRoute({ id: 'narrow', contextWindow: window, maxTokens: 500 }),
      ],
      'wide',
    )
    const agent = h.agent()
    for (let round = 0; round < 12; round += 1) {
      h.adapter.push({ text: 'b'.repeat(2_000) })
      agent.followup(userText(`${round}:${'a'.repeat(2_000)}`))
      await agent.whenIdle()
    }
    expect(new TokenMeter().measure(agent.session).totalTokens).toBeGreaterThan(
      2 * window,
    )
    h.llm.setRoutes(h.llm.listRoutes(), 'narrow')
    const engine = new CompactionEngine(h.llm, new ToolResultPruner())
    engine.install(h.middleware)
    let summaries = 0
    let largestSummaryRequest = 0
    dispatch(h, {
      compaction: (request) => {
        summaries += 1
        // The pre-step attempt fails: the request then overflows the window.
        if (summaries === 1) return failure('BAD_REQUEST')
        largestSummaryRequest = Math.max(
          largestSummaryRequest,
          requestTokens(request),
        )
        if (requestTokens(request) > window)
          return failure('CONTEXT_WINDOW_EXCEEDED')
        return replyChunks({
          text: `## Primary Request and Intent\n- part ${summaries}`,
        })
      },
      loop: (request) =>
        requestTokens(request) > window
          ? failure('CONTEXT_WINDOW_EXCEEDED')
          : replyChunks({ text: 'recovered' }),
    })
    agent.followup(userText('continue'))
    await agent.whenIdle()
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
    expect(
      agent.session.lastOf('assistant/message')?.data.message.content,
    ).toEqual([{ type: 'text', text: 'recovered' }])
    // At least two chunk summaries and one merge after the failed attempt.
    expect(summaries).toBeGreaterThanOrEqual(4)
    expect(largestSummaryRequest).toBeLessThanOrEqual(window)
    expect(
      agent.session.events.filter((e) => e.type === 'compaction/summary'),
    ).toHaveLength(1)
  })
})

describe('ToolResultPruner protection (KRN-05 #7)', () => {
  it('protects the current and the previous step, and prunes older results', async () => {
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
    // The result came from turn 1, step 1.
    expect(
      pruner.pruneSession(agent.session, { turn: 1, step: 2 }).pruned,
    ).toHaveLength(0)
    expect(
      pruner.pruneSession(agent.session, { turn: 1, step: 3 }).pruned,
    ).toHaveLength(1)
  })
})
