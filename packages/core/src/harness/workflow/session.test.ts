// Worker-side session driven IN-PROCESS over a MessageChannel (ported from
// dsh-workflow-worker-thread `session.spec.ts`): the same serialized factories
// the worker evals, exercised where main-process assertions can see them.
import * as vm from 'node:vm'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { createJsonSchemaKit } from '../tools/json-schema'
import { createRealmKit } from './realm'
import { createExecutionKit } from './runtime'
import { createSessionKit } from './session'
import type {
  ChildResult,
  ChildStartRequest,
  HostToWorkerMessage,
  WorkerInit,
  WorkerToHostMessage,
  WorkflowResult,
} from './types'

const realm = createRealmKit()
const execution = createExecutionKit({
  vm,
  realm,
  schema: createJsonSchemaKit(),
})
const { runWorkerSession } = createSessionKit({ execution, realm })

function init(
  body: string,
  args?: unknown,
  limits: Partial<WorkerInit['limits']> = {},
): WorkerInit {
  return {
    meta: { name: 'test-flow', description: 'a test workflow' },
    body,
    ...(args === undefined ? {} : { args }),
    limits: {
      maxConcurrentAgents: 8,
      maxTotalAgents: 1000,
      maxItemsPerCall: 4096,
      syncTimeoutMs: 5000,
      ...limits,
    },
  }
}

interface FakeHost {
  port: MessagePort
  messages: WorkerToHostMessage[]
  ofType<T extends WorkerToHostMessage['type']>(
    type: T,
  ): Array<Extract<WorkerToHostMessage, { type: T }>>
  send(message: HostToWorkerMessage): void
  result(): Promise<WorkflowResult>
  close(): void
}

function fakeHost(
  options: {
    reply?: (
      request: ChildStartRequest,
      index: number,
    ) => ChildResult | undefined
    refuse?: (index: number) => string | undefined
    go?: boolean
    manual?: boolean
  } = {},
): FakeHost {
  const channel = new MessageChannel()
  const messages: WorkerToHostMessage[] = []
  let resolveResult!: (result: WorkflowResult) => void
  const resultGate = new Promise<WorkflowResult>((resolve) => {
    resolveResult = resolve
  })
  let childIndex = 0
  const post = (message: HostToWorkerMessage): void => {
    channel.port1.postMessage(message)
  }
  channel.port1.on('message', (message: WorkerToHostMessage) => {
    messages.push(message)
    switch (message.type) {
      case 'ready':
        if (options.go !== false) post({ type: 'go' })
        break
      case 'child-start': {
        if (options.manual === true) break
        const index = childIndex++
        const refusal = options.refuse?.(index)
        if (refusal !== undefined) {
          post({
            type: 'child-start-error',
            callId: message.callId,
            rendered: refusal,
          })
          break
        }
        post({
          type: 'child-started',
          callId: message.callId,
          childId: `child-${index}`,
        })
        const reply = options.reply?.(message.request, index)
        if (reply !== undefined)
          post({ type: 'child-settled', callId: message.callId, result: reply })
        break
      }
      case 'child-dispose':
        post({ type: 'child-disposed', callId: message.callId })
        break
      case 'result':
        resolveResult(message.result)
        break
      default:
        break
    }
  })
  return {
    port: channel.port2,
    messages,
    ofType: (type) =>
      messages.filter((message) => message.type === type) as never,
    send: post,
    result: () => resultGate,
    close: () => {
      channel.port1.close()
      channel.port2.close()
    },
  }
}

function text(reply: string): ChildResult {
  return { output: [{ type: 'text', text: reply }], stopReason: 'completed' }
}

async function run(
  host: FakeHost,
  workerInit: WorkerInit,
): Promise<WorkflowResult> {
  void runWorkerSession(host.port, workerInit)
  try {
    return await host.result()
  } finally {
    host.close()
  }
}

describe('runWorkerSession over an in-process MessageChannel', () => {
  it('runs a script end to end: ready/go handshake, phases, log, agents, result', async () => {
    const host = fakeHost({ reply: (request) => text(`r:${request.prompt}`) })
    const result = await run(
      host,
      init(
        `phase('one'); log('hi ' + args.n)
         const a = await agent('p1')
         return { a }`,
        { n: 3 },
      ),
    )
    expect(result).toEqual({
      value: { a: 'r:p1' },
      stopReason: 'completed',
      agentsStarted: 1,
    })
    expect(host.messages[0]).toEqual({ type: 'ready' })
    expect(host.ofType('phase')).toEqual([{ type: 'phase', title: 'one' }])
    expect(host.ofType('log')).toEqual([{ type: 'log', message: 'hi 3' }])
    expect(host.ofType('agent-start')[0]!.info).toEqual({
      seq: 1,
      label: 'p1',
      phase: 'one',
      childId: 'child-0',
    })
    expect(host.ofType('agent-end')[0]!.info.outcome).toBe('completed')
    expect(host.ofType('child-dispose')).toHaveLength(1)
  })

  it('cancel before go: the body never runs and the result is cancelled', async () => {
    const host = fakeHost({ go: false })
    void runWorkerSession(host.port, init(`log('ran'); return 1`))
    await new Promise((resolve) => setTimeout(resolve, 10))
    host.send({ type: 'cancel', reason: 'early' })
    host.send({ type: 'cancel', reason: 'second' })
    const result = await host.result()
    host.close()
    expect(result).toMatchObject({
      stopReason: 'cancelled',
      error: 'workflow run cancelled: early',
    })
    expect(host.ofType('log')).toHaveLength(0)
  })

  it('cancel mid-run: hooks throw at entry and the run reports cancelled', async () => {
    const host = fakeHost({ manual: true })
    void runWorkerSession(
      host.port,
      init(`
        try { await agent('never answered') } catch (e) {}
        log('after')
        return 'unreachable'`),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    host.send({ type: 'cancel', reason: 'stop' })
    const start = host.ofType('child-start')[0]!
    host.send({ type: 'child-started', callId: start.callId, childId: 'c' })
    const result = await host.result()
    host.close()
    expect(result.stopReason).toBe('cancelled')
    expect(host.ofType('log')).toHaveLength(0)
  })

  it('a start refusal is a fatal AGENT_START that kills the script through a combinator', async () => {
    const host = fakeHost({ refuse: () => 'nope' })
    const result = await run(
      host,
      init(`return await parallel([() => agent('x'), () => 1])`),
    )
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/AGENT_START|could not start a child/)
  })

  it('a child-failed message is fatal AGENT_RESULT with the paired failed outcome', async () => {
    const host = fakeHost({ manual: true })
    void runWorkerSession(host.port, init(`return await agent('x')`))
    // Wait for the start request itself: a fixed 10 ms was too short on a
    // loaded CI runner.
    const start = await vi.waitFor(
      () => {
        const message = host.ofType('child-start')[0]
        if (!message) throw new Error('no child-start yet')
        return message
      },
      { timeout: 5_000 },
    )
    host.send({ type: 'child-started', callId: start.callId, childId: 'c' })
    host.send({
      type: 'child-failed',
      callId: start.callId,
      rendered: 'broken',
    })
    const result = await host.result()
    host.close()
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/child agent run failed: .*broken/s)
    expect(host.ofType('agent-end')[0]!.info.outcome).toBe('failed')
  })

  it('an unparseable body settles an error result instead of dying without one', async () => {
    const result = await run(fakeHost(), init('return (('))
    expect(result).toMatchObject({ stopReason: 'error', agentsStarted: 0 })
    expect(result.error).toMatch(/does not parse/)
  })

  it('caps and malformed hook arguments reject loud', async () => {
    const cases: Array<[string, RegExp, Partial<WorkerInit['limits']>?]> = [
      [`await agent('')`, /non-empty prompt string/],
      [`await agent('x', 3)`, /options must be an object/],
      [`await agent('x', { label: 1 })`, /option "label" must be a string/],
      [`await agent('x', { bogus: 1 })`, /option "bogus" is not recognized/],
      [
        `await agent('x', { schema: { type: 'string' } })`,
        /structured output is object-rooted/,
      ],
      [
        `await agent('x', { schema: { type: 'object', pattern: 'x' } })`,
        /outside the supported subset/,
      ],
      [`await parallel(3)`, /array of zero-argument functions/],
      [`await parallel([1])`, /item 0 is not a function/],
      [`await pipeline([1])`, /at least one stage function/],
      [`await pipeline(3, (x) => x)`, /requires an items array/],
      [
        `await parallel([() => 1, () => 2])`,
        /over the per-call cap \(1\)/,
        { maxItemsPerCall: 1 },
      ],
      [`phase('')`, /non-empty title string/],
      [`log(3)`, /message string/],
    ]
    for (const [body, pattern, limits] of cases) {
      const result = await run(
        fakeHost({ reply: () => text('ok') }),
        init(body, undefined, limits),
      )
      expect(result.stopReason, body).toBe('error')
      expect(result.error, body).toMatch(pattern)
    }
  })

  it('combinator semantics: thrown items are null, a forged fatal-shaped object stays null, real fatals propagate', async () => {
    const result = await run(
      fakeHost({ reply: () => text('ok') }),
      init(`
        const p = await parallel([
          () => { throw new Error('ordinary') },
          () => { throw { name: 'WorkflowError', code: 'AGENT_CAP', fatal: true } },
          () => 'kept',
        ])
        const q = await pipeline([1, 2], (x) => { if (x === 1) throw new Error('drop'); return x * 10 }, (x) => x + 1)
        return { p, q }`),
    )
    expect(result.value).toEqual({ p: [null, null, 'kept'], q: [null, 21] })
  })

  it('trips the total-agent cap with a message naming the config knob', async () => {
    const result = await run(
      fakeHost({ reply: () => text('ok') }),
      init(
        `for (let i = 0; i < 3; i++) await agent('x'); return 1`,
        undefined,
        {
          maxTotalAgents: 2,
        },
      ),
    )
    expect(result.error).toMatch(/total agent cap \(2\).*maxTotalAgents/s)
  })

  it('queued agents proceed through the concurrency semaphore in FIFO order', async () => {
    const host = fakeHost({ reply: (request) => text(request.prompt) })
    const result = await run(
      host,
      init(
        `return await parallel(['a', 'b', 'c', 'd'].map((p) => () => agent(p)))`,
        undefined,
        { maxConcurrentAgents: 1 },
      ),
    )
    expect(result.value).toEqual(['a', 'b', 'c', 'd'])
    expect(host.ofType('child-start').map((m) => m.request.prompt)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })

  it('labels default from the prompt first line, truncated; explicit label/phase win', async () => {
    const long = 'x'.repeat(60)
    const host = fakeHost({ reply: () => text('ok') })
    await run(
      host,
      init(
        `await agent('first line\\nsecond'); await agent('${long}'); await agent('p', { label: 'L', phase: 'P' })`,
      ),
    )
    const infos = host.ofType('agent-start').map((message) => message.info)
    expect(infos[0]!.label).toBe('first line')
    expect(infos[1]!.label).toBe(`${'x'.repeat(47)}…`)
    expect(infos[2]).toMatchObject({ label: 'L', phase: 'P' })
  })

  it('non-text output blocks are filtered out of the text result', async () => {
    const result = await run(
      fakeHost({
        reply: () => ({
          output: [
            { type: 'reasoning', text: 'hidden' } as never,
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
          stopReason: 'completed',
        }),
      }),
      init(`return await agent('x')`),
    )
    expect(result.value).toBe('ab')
  })
})
