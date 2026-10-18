import { expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { createTestHarness } from '../testing'
import { WorkflowEngine } from '../workflow/engine'
import type {
  ChildProvider,
  ChildProviderStartRequest,
  WorkflowAgentInfo,
} from '../workflow/types'
import { createRoutingChildProvider } from './workflow-provider'
import { fixture } from './service-test-fixture'
import { FakeExecutorAdapter } from './testing'
import { DelegationError } from './types'
function setup() {
  const f = fixture(),
    parent = createTestHarness().agent('root'),
    internalStart = vi.fn(async (_request: ChildProviderStartRequest) => ({
      id: 'sub-internal',
      result: Promise.resolve({
        output: [{ type: 'text' as const, text: 'internal result' }],
        stopReason: 'completed',
      }),
      dispose: async () => {},
    }))
  const internal: ChildProvider = {
    name: 'spawn',
    capabilities: { outputSchema: true },
    inheritsParentContext: false,
    start: internalStart,
  }
  const claude = new FakeExecutorAdapter('claude-code', async function* (
    turn,
    open,
  ) {
    yield {
      delegationId: open.delegationId,
      runId: turn.runId,
      generation: open.generation,
      type: 'turn_finished',
      status: 'completed',
      text: 'claude result',
      structured: { checked: true },
    }
  })
  f.options.adapters.set('claude-code', claude)
  const provider = createRoutingChildProvider({
    internal,
    delegations: () => f.service,
    ownerResolver: () => f.owner,
    readOnly: () => true,
  })
  return { ...f, parent, provider, internalStart, claude }
}
it('routes mixed worker calls independently and preserves legacy internal provider/model options', async () => {
  const f = setup(),
    engine = new WorkflowEngine([f.provider], {
      maxConcurrentAgents: 4,
      disposeGraceMs: 500,
    })
  const members: WorkflowAgentInfo[] = []
  engine.observe({ agentStart: (_info, agent) => members.push(agent) })
  const run = engine.start({
    parent: f.parent,
    meta: { name: 'mixed-routing', description: 'all backends' },
    script:
      'return await parallel([()=>agent("internal",{provider:"legacy-route",model:"legacy-model"}),()=>agent("implement",{backend:"claude-code",profileId:"claude-default"}),()=>agent("review",{backend:"codex"})]);',
  })
  try {
    const result = await run.result
    expect(result.stopReason, JSON.stringify(result)).toBe('completed')
    expect(result.value).toHaveLength(3)
    expect(f.internalStart).toHaveBeenCalledTimes(1)
    expect(f.internalStart.mock.calls[0]?.[0]).toMatchObject({
      provider: 'legacy-route',
      model: 'legacy-model',
    })
    expect(f.claude.submitted).toHaveLength(1)
    expect(f.adapter.submitted).toHaveLength(1)
    expect(
      members.filter((m) => m.externalRunId?.startsWith('dgr-')),
    ).toHaveLength(2)
    expect(members.filter((m) => m.backend === 'claude-code')).toHaveLength(1)
  } finally {
    await run.dispose()
    f.cleanup()
  }
})
it('returns validated external schema objects and leaves artifacts/conversation after dispose', async () => {
  const f = setup(),
    run = await f.provider.start({
      parent: f.parent,
      signal: new AbortController().signal,
      prompt: 'check',
      backend: 'claude-code',
      outputSchema: {
        type: 'object',
        properties: { checked: { type: 'boolean' } },
        required: ['checked'],
        additionalProperties: false,
      },
      clientRequestId: 'schema',
    })
  const result = await run.result
  expect(result.structured).toEqual({ checked: true })
  expect(result.stopReason, JSON.stringify(result)).toBe('completed')
  expect(run.id).toMatch(/^dlg-/)
  await run.dispose()
  expect(existsSync(f.root)).toBe(true)
  expect(f.service.inspect(run.id).record?.availability).toBe('idle')
  f.cleanup()
})
it('does not treat an external provider option as an LLM route or allow unknown worker options', async () => {
  const f = setup()
  await expect(
    f.provider.start({
      parent: f.parent,
      signal: new AbortController().signal,
      prompt: 'invalid',
      backend: 'codex',
      provider: 'legacy-route',
    }),
  ).rejects.toThrow('UNSUPPORTED_OPTION')
  const engine = new WorkflowEngine([f.provider], { disposeGraceMs: 500 }),
    run = engine.start({
      parent: f.parent,
      meta: { name: 'bad-option', description: 'reject unknown' },
      script:
        'return await agent("task",{backend:"codex",permissions:"allow"});',
    })
  try {
    expect((await run.result).stopReason).toBe('error')
    expect(f.adapter.submitted).toHaveLength(0)
  } finally {
    await run.dispose()
    f.cleanup()
  }
})
it('cancels a child waiting for the global/profile slot so it never submits after capacity is released', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r)),
    f = fixture(async function* (turn, open) {
      await gate
      yield {
        delegationId: open.delegationId,
        runId: turn.runId,
        generation: open.generation,
        type: 'turn_finished',
        status: 'completed',
      }
    }),
    parent = createTestHarness().agent('root'),
    internal: ChildProvider = {
      name: 'spawn',
      capabilities: { outputSchema: true },
      inheritsParentContext: false,
      start: async () => {
        throw new Error('unexpected internal')
      },
    }
  const provider = createRoutingChildProvider({
    internal,
    delegations: () => f.service,
    ownerResolver: () => f.owner,
    readOnly: () => true,
  })
  const a = await provider.start({
    parent,
    signal: new AbortController().signal,
    prompt: 'first',
    backend: 'codex',
    clientRequestId: 'first',
  })
  await vi.waitFor(() => expect(f.adapter.submitted).toHaveLength(1))
  const controller = new AbortController(),
    b = await provider.start({
      parent,
      signal: controller.signal,
      prompt: 'second',
      backend: 'codex',
      clientRequestId: 'second',
    })
  controller.abort()
  release()
  expect((await b.result).stopReason).not.toBe('completed')
  await a.result
  expect(f.adapter.submitted).toHaveLength(1)
  await Promise.all([a.dispose(), b.dispose()])
  f.cleanup()
})
it('collects foreground workflow output without scheduling a duplicate parent followup', async () => {
  const f = setup(),
    wake = vi.spyOn(f.parent, 'wakeInbox').mockImplementation(() => {})
  f.options.notices = {
    parent: () => f.parent,
    canWake: () => true,
    flush: () => {},
  }
  const run = await f.provider.start({
    parent: f.parent,
    signal: new AbortController().signal,
    prompt: 'collect here',
    backend: 'codex',
  })
  await run.result
  await f.service.dispatchNotices(run.id)
  expect(wake).not.toHaveBeenCalled()
  expect(Object.values(f.service.inspect(run.id).outbox)[0]?.recipient).toBe(
    'collector',
  )
  await run.dispose()
  f.cleanup()
})
it('preserves null for ordinary external/schema failures and passes implementation metadata into the next external stage', async () => {
  const f = setup(),
    engine = new WorkflowEngine([f.provider], { disposeGraceMs: 500 }),
    run = engine.start({
      parent: f.parent,
      meta: { name: 'external-stages', description: 'dependent stages' },
      script:
        'const reviewed=await pipeline(["task"],()=>agent("implement",{backend:"claude-code"}),prev=>agent("Review retained result: "+prev,{backend:"codex"}));const bad=await agent("invalid schema result",{backend:"claude-code",schema:{type:"object",properties:{checked:{type:"boolean",const:false}},required:["checked"]}});return {reviewed,bad};',
    })
  try {
    const result = await run.result
    expect(result.stopReason, JSON.stringify(result)).toBe('completed')
    expect(result.value).toMatchObject({ bad: null })
    expect(f.adapter.submitted[0]?.text).toContain('claude result')
    expect(f.adapter.submitted[0]?.text).toContain('workspace ' + f.root)
    expect(f.claude.submitted).toHaveLength(2)
  } finally {
    await run.dispose()
    f.cleanup()
  }
})
it('keeps workflow concurrency inside the global/profile limits and records native failure as an ordinary null result', async () => {
  const f = setup()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve)),
    live = { total: 0, codex: 0, claude: 0 },
    peak = { total: 0, codex: 0, claude: 0 }
  for (const backend of ['claude-code', 'codex'] as const)
    f.options.adapters.set(
      backend,
      new FakeExecutorAdapter(backend, async function* (turn, open) {
        const key = backend === 'codex' ? 'codex' : 'claude'
        live.total++
        live[key]++
        peak.total = Math.max(peak.total, live.total)
        peak[key] = Math.max(peak[key], live[key])
        try {
          await gate
          yield {
            delegationId: open.delegationId,
            runId: turn.runId,
            generation: open.generation,
            type: 'turn_finished',
            status: turn.text.includes('ordinary failure')
              ? 'failed'
              : 'completed',
            error: 'fixture native failure',
            text: turn.text.includes('ordinary failure')
              ? undefined
              : 'native complete',
          }
        } finally {
          live.total--
          live[key]--
        }
      }),
    )
  const engine = new WorkflowEngine([f.provider], {
      maxConcurrentAgents: 4,
      disposeGraceMs: 500,
    }),
    run = engine.start({
      parent: f.parent,
      meta: { name: 'quota-intersection', description: 'shared budgets' },
      script:
        'return await parallel([()=>agent("ordinary failure",{backend:"codex"}),()=>agent("second",{backend:"codex"}),()=>agent("third",{backend:"claude-code"})]);',
    })
  try {
    await vi.waitFor(() => expect(live.total).toBe(2))
    expect(peak).toEqual({ total: 2, codex: 1, claude: 1 })
    release()
    const result = await run.result
    expect(result.stopReason, JSON.stringify(result)).toBe('completed')
    expect((result.value as unknown[])[0]).toBe(null)
    expect(
      f.service
        .list()
        .some((state) =>
          Object.values(state.runs).some(
            (r) =>
              r.failureCode === 'EXECUTOR_TURN_FAILED' &&
              r.summary === 'fixture native failure',
          ),
        ),
    ).toBe(true)
  } finally {
    release()
    await run.dispose()
    f.cleanup()
  }
})

it('a workflow step whose external executor the user did not allow runs as an internal subagent', async () => {
  const f = setup()
  vi.spyOn(f.service, 'start').mockRejectedValueOnce(
    new DelegationError('EXECUTOR_CONSENT_DENIED', 'the user said no'),
  )
  const child = await f.provider.start({
    parent: f.parent,
    prompt: 'review',
    label: 'review',
    backend: 'codex',
    callId: 'call-consent',
  } as ChildProviderStartRequest)
  expect(child.id).toBe('sub-internal')
  expect(f.internalStart).toHaveBeenCalledWith(
    expect.objectContaining({ backend: 'internal', prompt: 'review' }),
  )
  f.cleanup()
})
