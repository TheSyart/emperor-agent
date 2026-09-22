// Agent loop semantics (ports the behavior of dsh agent-loop specs: loop,
// tool-order, cancel, request-reconstruction, request-error, resume,
// interception) onto the plain harness.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { userText } from '../../llm/message'
import type { SessionEvent } from '../../session-log/types'
import { createTestHarness } from '../testing'
import { defineTool } from '../tools/definition'

function types(
  events: readonly SessionEvent[],
  exclude: string[] = ['assistant/chunk', 'agent/inbox/spliced'],
): string[] {
  return events
    .map((event) => event.type)
    .filter((type) => !exclude.includes(type))
}

function echoTool(
  options: {
    name?: string
    parallel?: boolean
    delayMs?: number
    log?: string[]
  } = {},
) {
  return defineTool({
    name: options.name ?? 'echo',
    description: 'Echo the input.',
    input: z.object({ value: z.string() }),
    isConcurrencySafe: () => options.parallel ?? false,
    async execute(args, context) {
      options.log?.push(`start:${args.value}`)
      if (options.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const id = setTimeout(resolve, options.delayMs)
          context.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(id)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        })
      }
      options.log?.push(`end:${args.value}`)
      return `echo:${args.value}`
    },
  })
}

describe('Agent loop', () => {
  it('runs one text turn and logs the canonical event order', async () => {
    const h = createTestHarness({ replies: [{ text: 'hello there' }] })
    const agent = h.agent()
    agent.followup(userText('hi'))
    await agent.whenIdle()
    expect(types(agent.session.events)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'request/header',
      'request/context',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
    expect(agent.session.deriveMessages().map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ])
    expect(agent.status).toBe('idle')
  })

  it('executes tool calls and builds each request only from the derived surface', async () => {
    const h = createTestHarness({
      replies: [
        { tools: [{ id: 'c1', name: 'echo', args: { value: 'x' } }] },
        { text: 'done' },
      ],
    })
    h.tools.register(echoTool())
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    const second = h.adapter.requests[1]!
    expect(second.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
    expect(second.messages).toEqual(agent.session.deriveMessages().slice(0, 3))
    const result = agent.session.lastOf('tool/result')!
    expect(result.data.message.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'c1',
      content: [{ type: 'text', text: 'echo:x' }],
    })
    expect(result.sourceEventSeqs).toEqual([
      agent.session.lastOf('tool/call')!.seq,
    ])
    expect(second.tools?.map((t) => t.name)).toEqual(['echo'])
  })

  it('overlaps parallel-safe bodies but commits results in model order', async () => {
    const log: string[] = []
    const h = createTestHarness({
      replies: [
        {
          tools: [
            { id: 'a', name: 'slow', args: { value: 'a' } },
            { id: 'b', name: 'fast', args: { value: 'b' } },
          ],
        },
        { text: 'ok' },
      ],
    })
    h.tools.register(
      echoTool({ name: 'slow', parallel: true, delayMs: 30, log }),
    )
    h.tools.register(
      echoTool({ name: 'fast', parallel: true, delayMs: 1, log }),
    )
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(log).toEqual(['start:a', 'start:b', 'end:b', 'end:a'])
    const results = agent.session.events
      .filter((e) => e.type === 'tool/result')
      .map((e) => (e as SessionEvent<'tool/result'>).data.message.source.callId)
    expect(results).toEqual(['a', 'b'])
  })

  it('runs exclusive calls as barriers', async () => {
    const log: string[] = []
    const h = createTestHarness({
      replies: [
        {
          tools: [
            { id: 'a', name: 'excl', args: { value: 'a' } },
            { id: 'b', name: 'par', args: { value: 'b' } },
          ],
        },
        { text: 'ok' },
      ],
    })
    h.tools.register(
      echoTool({ name: 'excl', parallel: false, delayMs: 10, log }),
    )
    h.tools.register(echoTool({ name: 'par', parallel: true, log }))
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })

  it('turns invalid arguments and unknown tools into error results the model reads', async () => {
    const h = createTestHarness({
      replies: [
        {
          tools: [
            { id: 'a', name: 'echo', args: { value: 3 } },
            { id: 'b', name: 'nope' },
          ],
        },
        { text: 'ok' },
      ],
    })
    h.tools.register(echoTool())
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    const results = agent.session.events.filter(
      (e): e is SessionEvent<'tool/result'> => e.type === 'tool/result',
    )
    expect(results[0]!.data.error?.code).toBe('INVALID_ARGS')
    expect(results[1]!.data.error?.code).toBe('UNKNOWN_TOOL')
    expect(
      results.every(
        (r) =>
          r.data.message.content[0]!.type === 'tool-result' &&
          r.data.message.content[0].isError,
      ),
    ).toBe(true)
  })

  it('logs an interrupted assistant message and an aborted turn on cancel mid-stream', async () => {
    const h = createTestHarness({ replies: [{ hang: true }] })
    const agent = h.agent()
    agent.followup(userText('go'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    const message = agent.session.lastOf('assistant/message')!
    expect(message.data.interrupted).toBe(true)
    expect(message.data.message.content).toEqual([
      { type: 'text', text: 'partial' },
    ])
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'aborted',
      reason: { kind: 'user' },
    })
  })

  it('gives never-started calls ABORTED_BEFORE_DISPATCH results on cancel', async () => {
    const h = createTestHarness({
      replies: [
        {
          tools: [
            { id: 'a', name: 'slow', args: { value: 'a' } },
            { id: 'b', name: 'slow', args: { value: 'b' } },
          ],
        },
      ],
    })
    h.tools.register(echoTool({ name: 'slow', parallel: false, delayMs: 1000 }))
    const agent = h.agent()
    agent.followup(userText('go'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    const results = agent.session.events.filter(
      (e): e is SessionEvent<'tool/result'> => e.type === 'tool/result',
    )
    expect(results.map((r) => r.data.error?.code)).toEqual([
      'ABORTED',
      'ABORTED_BEFORE_DISPATCH',
    ])
    expect(agent.session.hasOpenTurn()).toBe(false)
  })

  it('enters a steered message at the next step and queues a followup for the next turn', async () => {
    const h = createTestHarness()
    h.tools.register(echoTool({ delayMs: 20 }))
    h.adapter.push(
      { tools: [{ id: 'a', name: 'echo', args: { value: 'a' } }] },
      { text: 'first done' },
      { text: 'second turn' },
    )
    const agent = h.agent()
    agent.followup(userText('one'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    agent.steer(userText('steer'))
    agent.followup(userText('two'))
    await agent.whenIdle()
    const turns = agent.session.events.filter(
      (e) => e.type === 'turn/start',
    ).length
    expect(turns).toBe(2)
    const secondRequest = h.adapter.requests[1]!
    const texts = secondRequest.messages.map((m) =>
      m.content.map((b) => (b.type === 'text' ? b.text : b.type)).join(''),
    )
    expect(texts.at(-1)).toBe('steer')
    const third = h.adapter.requests[2]!
    expect(third.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'two' },
    ])
  })

  it('retries retryable request errors inside the step and logs llm/retry', async () => {
    const h = createTestHarness({
      replies: [{ error: 'overloaded', code: 'SERVER' }, { text: 'ok' }],
    })
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(types(agent.session.events)).toContain('llm/retry')
    expect(types(agent.session.events)).toContain('llm/retry-started')
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'completed',
    })
    expect(
      agent.session.events.filter((e) => e.type === 'step/start'),
    ).toHaveLength(1)
  })

  it('ends the turn with the failure when the error is not retryable', async () => {
    const h = createTestHarness({
      replies: [{ error: 'bad key', code: 'AUTH' }],
    })
    const agent = h.agent()
    const errors: unknown[] = []
    agent.observe({
      error: (_agent, error) => {
        errors.push(error)
      },
    })
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(agent.session.lastOf('turn/end')?.data.reason).toMatchObject({
      kind: 'error',
      error: { code: 'AUTH' },
    })
    expect(errors).toHaveLength(1)
  })

  it('enters the runtime context only when it changes and logs header changes', async () => {
    const h = createTestHarness({
      replies: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
    })
    let mode = 'plan'
    h.prompt.context({ name: 'mode', order: 1, text: () => `mode: ${mode}` })
    h.prompt.section({
      name: 'persona',
      order: 0,
      text: 'You are a test agent in {{cwd}}.',
    })
    h.prompt.variable('cwd', ({ agent }) => agent?.session.header.cwd)
    const agent = h.agent()
    agent.followup(userText('1'))
    await agent.whenIdle()
    agent.followup(userText('2'))
    await agent.whenIdle()
    mode = 'default'
    agent.followup(userText('3'))
    await agent.whenIdle()
    const snapshots = agent.session.events.filter(
      (e) => e.type === 'user/message' && e.data.source.kind === 'context',
    )
    expect(snapshots).toHaveLength(2)
    expect(h.adapter.requests[0]!.system).toBe(
      'You are a test agent in /workspace.',
    )
    const headers = agent.session.events.filter(
      (e): e is SessionEvent<'request/header'> => e.type === 'request/header',
    )
    expect(headers.map((e) => e.data.reason)).toEqual(['initial'])
  })

  it('max-tokens drops tool calls and is sticky for the turn', async () => {
    const h = createTestHarness({
      replies: [
        {
          text: 'cut',
          tools: [{ name: 'echo', args: { value: 'x' } }],
          finish: 'max-tokens',
        },
      ],
    })
    h.tools.register(echoTool())
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(
      agent.session.lastOf('assistant/message')?.data.message.content,
    ).toEqual([{ type: 'text', text: 'cut' }])
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'max-tokens',
    })
    expect(types(agent.session.events)).not.toContain('tool/call')
  })

  it('lets turn-stopping middleware steer another step', async () => {
    const h = createTestHarness({
      replies: [{ text: 'first' }, { text: 'second' }],
    })
    let fired = false
    h.middleware.turnStopping.push(({ agent }) => {
      if (fired) return
      fired = true
      agent.steer(userText('keep going'))
    })
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(
      agent.session.events.filter((e) => e.type === 'step/start'),
    ).toHaveLength(2)
    expect(
      agent.session.events.filter((e) => e.type === 'turn/start'),
    ).toHaveLength(1)
  })

  it('pre-step rejection blocks the turn', async () => {
    const h = createTestHarness()
    h.middleware.preStep.push(() => ({ kind: 'reject' }))
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(agent.session.lastOf('turn/end')?.data.reason).toEqual({
      kind: 'blocked',
    })
    expect(h.adapter.requests).toHaveLength(0)
  })

  it('routes ask decisions through the approval handler', async () => {
    const h = createTestHarness({
      replies: [
        {
          tools: [
            { id: 'a', name: 'echo', args: { value: 'a' } },
            { id: 'b', name: 'echo', args: { value: 'b' } },
          ],
        },
        { text: 'ok' },
      ],
    })
    h.tools.register(echoTool())
    h.tools.preExecute.push(() => ({ kind: 'ask', reason: 'confirm' }))
    let asked = 0
    h.tools.setApprovalHandler(async () =>
      ++asked === 1 ? 'allowed-once' : 'rejected',
    )
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    const results = agent.session.events.filter(
      (e): e is SessionEvent<'tool/result'> => e.type === 'tool/result',
    )
    expect(results[0]!.data.message.content[0]).toMatchObject({
      isError: false,
    })
    expect(results[1]!.data.message.content[0]).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Error: the user rejected tool "echo"' }],
    })
  })

  it('enforces tool timeouts', async () => {
    const h = createTestHarness({
      replies: [{ tools: [{ id: 'a', name: 'sleepy' }] }, { text: 'ok' }],
    })
    h.tools.register(
      defineTool({
        name: 'sleepy',
        description: 'never returns',
        input: z.object({}),
        timeoutMs: 10,
        execute: () => new Promise(() => {}),
      }),
    )
    const agent = h.agent()
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(agent.session.lastOf('tool/result')?.data.error?.code).toBe(
      'TOOL_TIMEOUT',
    )
  })

  it('resumes from the persisted log: header reason, turn numbering, and inbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-resume-'))
    const h = createTestHarness({ root, replies: [{ text: 'one' }] })
    const agent = h.agent('s')
    agent.followup(userText('first'))
    await agent.whenIdle()
    agent.inject(userText('pending'))
    agent.dispose()
    h.sessions.close('s')
    const h2 = createTestHarness({ root, replies: [{ text: 'two' }] })
    const resumed = h2.agent('s')
    expect(resumed.inbox.nextStep.map((m) => m.content)).toEqual([
      [{ type: 'text', text: 'pending' }],
    ])
    resumed.followup(userText('second'))
    await resumed.whenIdle()
    const headers = resumed.session.events.filter(
      (e): e is SessionEvent<'request/header'> => e.type === 'request/header',
    )
    expect(headers.map((e) => e.data.reason)).toEqual(['initial', 'resume'])
    expect(resumed.session.lastOf('turn/start')?.data.turn).toBe(2)
    const texts = h2.adapter.requests[0]!.messages.map((m) =>
      m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    )
    expect(texts).toEqual(['first', 'one', 'pending', 'second'])
  })
})
