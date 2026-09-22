// Worker-thread engine over a REAL worker (the eval'd serialized source):
// ported from dsh-workflow-worker-thread `workflow-worker-thread.spec.ts`
// (execution, provider routing, caps, fatal errors, start/result faults,
// cancellation, forced termination, disposal, strays, worker death, lifecycle
// pairing) with a scripted in-memory child provider in place of ctx.subagents.
import { describe, expect, it } from 'vitest'
import type { Agent } from '../agent/agent'
import { WorkflowEngine, type WorkflowEngineConfig } from './engine'
import { WorkflowError } from './errors'
import { workerSpawnEnv } from './host'
import type {
  ChildProvider,
  ChildProviderStartRequest,
  ChildResult,
  ChildRun,
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowResultInfo,
  WorkflowRunInfo,
  WorkflowStartRequest,
} from './types'
import { workflowWorkerSource } from './worker-source'

const parent = { id: 'parent-agent' } as unknown as Agent
const meta = { name: 'test-flow', description: 'a test workflow' }

function text(reply: string): ChildResult {
  return { output: [{ type: 'text', text: reply }], stopReason: 'completed' }
}

interface FakeChild {
  request: ChildProviderStartRequest
  disposed: number
  settle(result: ChildResult): void
  fail(error: unknown): void
}

interface FakeProvider extends ChildProvider {
  children: FakeChild[]
}

/**
 * A scripted provider: `reply` answers each child (undefined leaves it
 * pending until the test settles it); `refuse` rejects the start.
 */
function fakeProvider(
  options: {
    name?: string
    reply?: (
      request: ChildProviderStartRequest,
      index: number,
    ) => ChildResult | undefined
    refuse?: (index: number) => string | undefined
    honorSignal?: boolean
    disposeThrows?: boolean
  } = {},
): FakeProvider {
  const children: FakeChild[] = []
  return {
    name: options.name ?? 'spawn',
    capabilities: { outputSchema: true },
    inheritsParentContext: false,
    children,
    async start(request): Promise<ChildRun> {
      const index = children.length
      const refusal = options.refuse?.(index)
      if (refusal !== undefined) throw new Error(refusal)
      let settle!: (result: ChildResult) => void
      let fail!: (error: unknown) => void
      const result = new Promise<ChildResult>((resolve, reject) => {
        settle = resolve
        fail = reject
      })
      result.catch(() => {})
      const child: FakeChild = { request, disposed: 0, settle, fail }
      children.push(child)
      if (options.honorSignal !== false)
        request.signal.addEventListener('abort', () => {
          settle({ output: [], stopReason: 'aborted' })
        })
      const reply = options.reply?.(request, index)
      if (reply !== undefined) settle(reply)
      return {
        id: `child-${index}`,
        result,
        dispose: async () => {
          child.disposed += 1
          settle({ output: [], stopReason: 'aborted' })
          if (options.disposeThrows === true) throw new Error('dispose broke')
        },
      }
    },
  }
}

interface Recorded {
  events: Array<[string, ...unknown[]]>
  starts: WorkflowAgentInfo[]
  ends: WorkflowAgentEndInfo[]
  end?: WorkflowResultInfo
}

function engineWith(
  provider: ChildProvider | ChildProvider[],
  config: WorkflowEngineConfig = {},
): { engine: WorkflowEngine; recorded: Recorded } {
  const engine = new WorkflowEngine(
    Array.isArray(provider) ? provider : [provider],
    { maxConcurrentAgents: 4, disposeGraceMs: 300, ...config },
  )
  const recorded: Recorded = { events: [], starts: [], ends: [] }
  engine.observe({
    start: (info: WorkflowRunInfo) => recorded.events.push(['start', info.id]),
    phase: (_info, title) => recorded.events.push(['phase', title]),
    log: (_info, message) => recorded.events.push(['log', message]),
    agentStart: (_info, agent) => {
      recorded.starts.push(agent)
      recorded.events.push(['agent-start', agent.seq])
    },
    agentEnd: (_info, agent) => {
      recorded.ends.push(agent)
      recorded.events.push(['agent-end', agent.seq, agent.outcome])
    },
    end: (_info, result) => {
      recorded.end = result
      recorded.events.push(['end', result.stopReason])
    },
  })
  return { engine, recorded }
}

function request(
  script: string,
  extra: Partial<WorkflowStartRequest> = {},
): WorkflowStartRequest {
  return { script, meta, parent, ...extra }
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('workflow worker source', () => {
  it('serializes self-contained factories with no transpiler helpers', () => {
    const source = workflowWorkerSource()
    expect(source).toContain("require('node:worker_threads')")
    expect(source).not.toMatch(/\b__name\(|\b__publicField\(/)
    // Parses as a script.
    expect(() => new Function(source)).not.toThrow()
  })

  it('scrubs the worker environment (Windows keeps only its temp path)', () => {
    expect(workerSpawnEnv('darwin', '/tmp')).toEqual({})
    expect(workerSpawnEnv('win32', 'C:\\tmp')).toEqual({
      TMP: 'C:\\tmp',
      TEMP: 'C:\\tmp',
    })
  })
})

describe('WorkflowEngine over a real worker thread', () => {
  it('runs a script end to end: text results, phases, log, args, return value, events', async () => {
    const provider = fakeProvider({
      reply: (req) => text(`echo:${req.prompt}`),
    })
    const { engine, recorded } = engineWith(provider)
    const run = engine.start(
      request(
        `phase('scan')
         log('starting ' + args.files.length)
         const results = await parallel(args.files.map((f) => () => agent('read ' + f, { label: f })))
         return { results }`,
        { args: { files: ['a', 'b'] }, callId: 'call-1' },
      ),
    )
    const result = await run.result
    await run.dispose()
    expect(result).toEqual({
      value: { results: ['echo:read a', 'echo:read b'] },
      stopReason: 'completed',
      agentsStarted: 2,
    })
    expect(provider.children.map((child) => child.request.label)).toEqual([
      'a',
      'b',
    ])
    expect(provider.children[0]!.request.callId).toBe('call-1')
    expect(provider.children[0]!.request.parent).toBe(parent)
    expect(recorded.starts.map((agent) => agent.phase)).toEqual([
      'scan',
      'scan',
    ])
    expect(recorded.ends.map((agent) => agent.outcome)).toEqual([
      'completed',
      'completed',
    ])
    expect(recorded.events[0]).toEqual(['start', run.id])
    expect(recorded.events).toContainEqual(['phase', 'scan'])
    expect(recorded.events).toContainEqual(['log', 'starting 2'])
    expect(recorded.events.at(-1)).toEqual(['end', 'completed'])
    // Every child was disposed after collection.
    expect(provider.children.every((child) => child.disposed === 1)).toBe(true)
  })

  it('forwards schema/model/provider options and returns the structured value', async () => {
    const provider = fakeProvider({
      reply: () => ({
        output: [],
        structured: { ok: true },
        stopReason: 'completed',
      }),
    })
    const { engine } = engineWith(provider)
    const run = engine.start(
      request(
        `return await agent('x', { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, model: 'm1', provider: 'p1' })`,
      ),
    )
    expect((await run.result).value).toEqual({ ok: true })
    await run.dispose()
    expect(provider.children[0]!.request).toMatchObject({
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
      },
      model: 'm1',
      provider: 'p1',
    })
  })

  it('a schema child completing without a structured value, or failing, resolves null', async () => {
    const provider = fakeProvider({
      reply: (_req, index) =>
        index === 0 ? text('no capture') : { output: [], stopReason: 'error' },
    })
    const { engine, recorded } = engineWith(provider)
    const run = engine.start(
      request(
        `const a = await agent('x', { schema: { type: 'object' } })
         const b = await agent('y')
         return [a, b]`,
      ),
    )
    expect((await run.result).value).toEqual([null, null])
    await run.dispose()
    expect(recorded.ends.map((agent) => agent.outcome)).toEqual([
      'failed',
      'failed',
    ])
  })

  it('routes every child through a start-request provider override and validates routes before publishing', async () => {
    const spawn = fakeProvider({ reply: () => text('spawn') })
    const fresh = fakeProvider({ name: 'fresh', reply: () => text('fresh') })
    const { engine, recorded } = engineWith([spawn, fresh])
    const run = engine.start(
      request(`return await agent('x')`, { subagentProvider: 'fresh' }),
    )
    expect((await run.result).value).toBe('fresh')
    await run.dispose()
    expect(spawn.children).toHaveLength(0)
    const before = recorded.events.length
    expect(() =>
      engine.start(request('return 1', { subagentProvider: 'missing' })),
    ).toThrow(/no subagent provider registered for "missing"/)
    expect(() =>
      engine.start(request('return 1', { subagentProvider: ' fresh' })),
    ).toThrow(/non-empty normalized string/)
    expect(recorded.events.length).toBe(before)
  })

  it('rejects invalid per-run total-agent caps and enforces a lower cap', async () => {
    const { engine } = engineWith(fakeProvider({ reply: () => text('ok') }), {
      maxTotalAgents: 5,
    })
    expect(() =>
      engine.start(request('return 1', { maxTotalAgents: 0 })),
    ).toThrow(/positive safe integer/)
    expect(() =>
      engine.start(request('return 1', { maxTotalAgents: 6 })),
    ).toThrow(/exceeds the engine ceiling 5/)
    const run = engine.start(
      request(
        `for (let i = 0; i < 3; i++) await agent('x' + i)
         return 'unreachable'`,
        { maxTotalAgents: 2 },
      ),
    )
    const result = await run.result
    await run.dispose()
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/total agent cap \(2\)/)
    expect(result.agentsStarted).toBe(2)
  })

  it('start() throws synchronously for invalid meta or an unparseable body', () => {
    const { engine } = engineWith(fakeProvider())
    expect(() =>
      engine.start({ script: 'return 1', meta: {} as never, parent }),
    ).toThrow(WorkflowError)
    expect(() => engine.start(request('return (('))).toThrow(
      /workflow script does not parse/,
    )
    expect(() =>
      engine.start(request('export const meta = {}\nreturn 1')),
    ).toThrow(/meta rides the `meta` request field/)
  })

  it('a fatal hook error inside the worker kills the script through combinators', async () => {
    const { engine } = engineWith(fakeProvider({ reply: () => text('ok') }))
    const run = engine.start(
      request(`return await parallel([() => agent('x', { effort: 'high' })])`),
    )
    const result = await run.result
    await run.dispose()
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/option "effort" is deferred/)
  })

  it('classifies provider start rejection as AGENT_START with no lifecycle pair', async () => {
    const { engine, recorded } = engineWith(
      fakeProvider({ refuse: () => 'provider down' }),
    )
    const run = engine.start(request(`return await agent('x')`))
    const result = await run.result
    await run.dispose()
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/could not start a child: .*provider down/s)
    expect(recorded.starts).toHaveLength(0)
    expect(recorded.ends).toHaveLength(0)
  })

  it('a child result rejection crosses back as fatal AGENT_RESULT, paired as failed', async () => {
    const provider = fakeProvider()
    const { engine, recorded } = engineWith(provider)
    const run = engine.start(
      request(`return await parallel([() => agent('x')])`),
    )
    await waitFor(
      () => provider.children.length === 1 && recorded.starts.length === 1,
    )
    provider.children[0]!.fail(new Error('transport broke'))
    const result = await run.result
    await run.dispose()
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/child agent run failed: .*transport broke/s)
    expect(recorded.ends).toEqual([
      expect.objectContaining({ seq: 1, outcome: 'failed' }),
    ])
  })

  it('maps a non-JSON child result to fatal AGENT_RESULT instead of wedging', async () => {
    const { engine } = engineWith(
      fakeProvider({
        reply: () => ({
          output: [],
          structured: { bad: Number.NaN },
          stopReason: 'completed',
        }),
      }),
    )
    const run = engine.start(request(`return await agent('x')`))
    const result = await run.result
    await run.dispose()
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/could not cross the worker boundary/)
  })

  it('a child whose dispose() throws cannot wedge the script', async () => {
    const { engine } = engineWith(
      fakeProvider({ reply: () => text('ok'), disposeThrows: true }),
    )
    const run = engine.start(request(`return await agent('x')`))
    expect((await run.result).value).toBe('ok')
    await run.dispose()
  })

  it('an escaped script finds no ambient credentials in the worker environment', async () => {
    process.env.WORKFLOW_TEST_SECRET = 'leak'
    try {
      const { engine } = engineWith(fakeProvider())
      const run = engine.start(
        request(
          `const P = this.constructor.constructor('return process')()
           return P.env.WORKFLOW_TEST_SECRET ?? 'absent'`,
        ),
      )
      const result = await run.result
      await run.dispose()
      expect(result.value).toBe('absent')
    } finally {
      delete process.env.WORKFLOW_TEST_SECRET
    }
  })
})

describe('WorkflowEngine lifecycle: cancellation, termination, disposal', () => {
  it('cancel() aborts in-flight children and settles cancelled with paired ends', async () => {
    const provider = fakeProvider()
    const { engine, recorded } = engineWith(provider)
    const run = engine.start(request(`return await agent('x')`))
    await waitFor(() => recorded.starts.length === 1)
    run.cancel('user stop')
    const result = await run.result
    await run.dispose()
    expect(result).toMatchObject({
      stopReason: 'cancelled',
      error: 'workflow run cancelled: user stop',
    })
    expect(provider.children[0]!.request.signal.aborted).toBe(true)
    expect(recorded.ends).toEqual([
      expect.objectContaining({ seq: 1, outcome: 'cancelled' }),
    ])
    expect(recorded.end?.stopReason).toBe('cancelled')
  })

  it('an already-aborted start signal cancels before the body ever runs', async () => {
    const provider = fakeProvider({ reply: () => text('ok') })
    const { engine, recorded } = engineWith(provider)
    const controller = new AbortController()
    controller.abort()
    const run = engine.start(
      request(`log('ran'); return await agent('x')`, {
        signal: controller.signal,
      }),
    )
    const result = await run.result
    await run.dispose()
    expect(result.stopReason).toBe('cancelled')
    expect(provider.children).toHaveLength(0)
    expect(recorded.events.some(([name]) => name === 'log')).toBe(false)
  })

  it('the request signal aborting mid-run cancels like cancel()', async () => {
    const { engine, recorded } = engineWith(fakeProvider())
    const controller = new AbortController()
    const run = engine.start(
      request(`return await agent('x')`, { signal: controller.signal }),
    )
    await waitFor(() => recorded.starts.length === 1)
    controller.abort()
    expect((await run.result).stopReason).toBe('cancelled')
    await run.dispose()
  })

  it('force-settles a script parked on a promise no hook owns, and terminates its worker', async () => {
    const { engine } = engineWith(fakeProvider(), { disposeGraceMs: 100 })
    const run = engine.start(request(`await new Promise(() => {}); return 1`))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    run.cancel('stuck')
    const result = await run.result
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.stopReason).toBe('cancelled')
    await run.dispose()
  })

  it('a synchronous spin in the initial slice dies by the in-worker vm timeout', async () => {
    const { engine } = engineWith(fakeProvider(), { syncTimeoutMs: 50 })
    const run = engine.start(request(`while (true) {}`))
    const result = await run.result
    await run.dispose()
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(/timed out/i)
  })

  it('dispose() on a stuck script returns within the grace; dispose is idempotent', async () => {
    const { engine } = engineWith(fakeProvider(), { disposeGraceMs: 100 })
    const run = engine.start(request(`await new Promise(() => {})`))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const first = run.dispose()
    expect(run.dispose()).toBe(first)
    await first
    expect((await run.result).stopReason).toBe('cancelled')
  })

  it('strays fired without await are aborted and disposed once the script settles', async () => {
    const provider = fakeProvider()
    const { engine, recorded } = engineWith(provider)
    const run = engine.start(
      request(`agent('stray'); await new Promise((r) => r()); return 'done'`),
    )
    const result = await run.result
    expect(result.value).toBe('done')
    await run.dispose()
    await waitFor(() => provider.children.every((child) => child.disposed > 0))
    expect(provider.children.length).toBeLessThanOrEqual(1)
    // Pairing holds: every start has exactly one end.
    expect(recorded.ends.length).toBe(recorded.starts.length)
  })

  it('a non-JSON return value fails loud as RESULT_UNSERIALIZABLE; no return is null', async () => {
    const { engine } = engineWith(fakeProvider())
    const bad = engine.start(request(`return { f: () => 1 }`))
    const badResult = await bad.result
    await bad.dispose()
    expect(badResult.stopReason).toBe('error')
    expect(badResult.error).toMatch(/not plain JSON data/)
    const none = engine.start(request(`log('x')`))
    expect((await none.result).value).toBeNull()
    await none.dispose()
  })

  it('an uncaught exception inside the worker surfaces as an error result', async () => {
    const { engine } = engineWith(fakeProvider())
    const run = engine.start(
      request(
        `const P = this.constructor.constructor('return process')()
         P.nextTick(() => { throw new Error('boom outside the script') })
         await new Promise(() => {})`,
      ),
    )
    const result = await run.result
    await run.dispose()
    expect(result.stopReason).toBe('error')
    expect(result.error).toMatch(
      /workflow worker failed: .*boom outside the script/s,
    )
  })

  it('run ids are unique and lifecycle info carries the validated meta', async () => {
    const { engine } = engineWith(fakeProvider())
    const infos: WorkflowRunInfo[] = []
    engine.observe({ start: (info) => infos.push(info) })
    const a = engine.start(request('return 1'))
    const b = engine.start(request('return 2'))
    await Promise.all([a.result, b.result])
    await Promise.all([a.dispose(), b.dispose()])
    expect(a.id).not.toBe(b.id)
    expect(infos.map((info) => info.meta)).toEqual([meta, meta])
  })

  it('contains a throwing observer without starving peers or changing execution', async () => {
    const { engine, recorded } = engineWith(fakeProvider())
    engine.observe({
      start: () => {
        throw new Error('listener broke')
      },
    })
    const run = engine.start(request('return 7'))
    expect((await run.result).value).toBe(7)
    await run.dispose()
    await waitFor(() => recorded.end !== undefined)
  })
})
