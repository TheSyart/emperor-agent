// `workflow` / `ralph` tool contracts over a scripted engine (ported from
// dsh-tool-workflow `tool-workflow.spec.ts` and dsh-tool-ralph
// `tool-ralph.spec.ts`): request shape, rendering, stop-reason mapping,
// abort bridging, disposal on every path, durable records, Ralph config and
// terminal-value validation.
import { describe, expect, it } from 'vitest'
import { textOf } from '../tools/definition'
import { createTestHarness } from '../testing'
import type { WorkflowEngine } from './engine'
import { WorkflowRunFold, WorkflowRunRegistry } from './records'
import {
  createRalphTool,
  createWorkflowTool,
  installWorkflow,
  RALPH_META,
  RALPH_SCRIPT,
  resolveRalphConfig,
} from './tools'
import type {
  ChildProvider,
  WorkflowResult,
  WorkflowRun,
  WorkflowStartRequest,
} from './types'

interface ScriptedRun extends WorkflowRun {
  cancelled: string[]
  disposed: number
  settle(result: WorkflowResult): void
}

function scriptedEngine(
  options: {
    result?: WorkflowResult
    throws?: Error
    provider?: Partial<ChildProvider> | null
  } = {},
): {
  engine: WorkflowEngine
  requests: WorkflowStartRequest[]
  runs: ScriptedRun[]
} {
  const requests: WorkflowStartRequest[] = []
  const runs: ScriptedRun[] = []
  const provider: ChildProvider | undefined =
    options.provider === null
      ? undefined
      : ({
          name: 'spawn',
          capabilities: { outputSchema: true },
          inheritsParentContext: false,
          start: async () => {
            throw new Error('unused')
          },
          ...options.provider,
        } as ChildProvider)
  const engine = {
    getProvider: (name: string) =>
      provider !== undefined && name === provider.name ? provider : undefined,
    observe: () => () => {},
    start(request: WorkflowStartRequest): WorkflowRun {
      if (options.throws !== undefined) throw options.throws
      requests.push(request)
      let settle!: (result: WorkflowResult) => void
      const result = new Promise<WorkflowResult>((resolve) => {
        settle = resolve
      })
      const run: ScriptedRun = {
        id: `run-${runs.length + 1}`,
        meta: request.meta,
        result,
        cancelled: [],
        disposed: 0,
        settle,
        cancel(reason) {
          run.cancelled.push(reason ?? '')
          settle({
            value: null,
            stopReason: 'cancelled',
            error: `workflow run cancelled: ${reason}`,
            agentsStarted: 0,
          })
        },
        async dispose() {
          run.disposed += 1
        },
      }
      runs.push(run)
      if (options.result !== undefined) settle(options.result)
      return run
    },
  } as unknown as WorkflowEngine
  return { engine, requests, runs }
}

const meta = { name: 'demo', description: 'a demo' }

async function call(
  tool: ReturnType<typeof createWorkflowTool>,
  args: unknown,
  signal = new AbortController().signal,
): Promise<{ text: string; isError: boolean; meta: unknown; agentId: string }> {
  const h = createTestHarness()
  h.tools.register(tool)
  const agent = h.agent('caller')
  const result = await h.tools.execute({
    callId: 'call-1',
    name: tool.name,
    arguments: args,
    agent,
    signal,
  })
  return {
    text: textOf(result.content),
    isError: result.isError,
    meta: result.meta,
    agentId: agent.id,
  }
}

describe('workflow tool', () => {
  it('starts a run with script/args/parent/signal/callId and renders the completed value', async () => {
    const { engine, requests, runs } = scriptedEngine({
      result: { value: { n: 1 }, stopReason: 'completed', agentsStarted: 1 },
    })
    const registry = new WorkflowRunRegistry()
    const tool = createWorkflowTool({ engine, runs: registry })
    const out = await call(tool, { script: 'return 1', meta, args: { a: 1 } })
    expect(out.isError).toBe(false)
    expect(out.text).toBe(
      'workflow "demo" completed (1 agent).\nReturn value:\n{\n  "n": 1\n}',
    )
    expect(requests[0]).toMatchObject({
      script: 'return 1',
      meta,
      args: { a: 1 },
      callId: 'call-1',
    })
    expect(requests[0]!.parent.id).toBe(out.agentId)
    expect(out.meta).toMatchObject({
      kind: 'workflow',
      runId: 'run-1',
      agentsStarted: 1,
      result: { n: 1 },
    })
    expect(runs[0]!.disposed).toBe(1)
  })

  it('records run-start → run-end in the calling session after disposal', async () => {
    const { engine } = scriptedEngine({
      result: { value: 'v', stopReason: 'completed', agentsStarted: 0 },
    })
    const registry = new WorkflowRunRegistry()
    const h = createTestHarness()
    h.tools.register(createWorkflowTool({ engine, runs: registry }))
    const agent = h.agent('rec')
    await h.tools.execute({
      callId: 'c',
      name: 'workflow',
      arguments: { script: 'return 1', meta },
      agent,
      signal: new AbortController().signal,
    })
    expect(
      agent.session.events
        .map((event) => event.type)
        .filter((type) => type.startsWith('tool-workflow/')),
    ).toEqual(['tool-workflow/run-start', 'tool-workflow/run-end'])
    const [record] = WorkflowRunFold.fold(agent.session.events)
    expect(record).toMatchObject({
      name: 'demo',
      status: 'completed',
      callId: 'c',
      result: expect.stringContaining('workflow "demo" completed (0 agents)'),
    })
    expect(registry.isLive('run-1')).toBe(false)
  })

  it('maps non-completed stop reasons to error results and still disposes', async () => {
    const cases: Array<[WorkflowResult, string]> = [
      [
        { value: null, stopReason: 'error', error: 'boom', agentsStarted: 0 },
        'Error: workflow run failed: boom',
      ],
      [
        { value: null, stopReason: 'error', agentsStarted: 0 },
        'Error: workflow run failed: unknown error',
      ],
      [
        {
          value: null,
          stopReason: 'cancelled',
          error: 'why',
          agentsStarted: 0,
        },
        'Error: workflow run was cancelled (why)',
      ],
      [
        { value: null, stopReason: 'cancelled', agentsStarted: 0 },
        'Error: workflow run was cancelled',
      ],
    ]
    for (const [result, text] of cases) {
      const { engine, runs } = scriptedEngine({ result })
      const out = await call(
        createWorkflowTool({ engine, runs: new WorkflowRunRegistry() }),
        { script: 'x', meta },
      )
      expect(out).toMatchObject({ isError: true, text })
      expect(runs[0]!.disposed).toBe(1)
    }
  })

  it('cancels the run when the signal aborts mid-flight', async () => {
    const { engine, runs } = scriptedEngine()
    const controller = new AbortController()
    const pending = call(
      createWorkflowTool({ engine, runs: new WorkflowRunRegistry() }),
      { script: 'x', meta },
      controller.signal,
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    const out = await pending
    expect(runs[0]!.cancelled).toEqual(['parent step aborted'])
    expect(out.isError).toBe(true)
    expect(runs[0]!.disposed).toBe(1)
  })

  it('a synchronous engine start throw becomes an error result', async () => {
    const { engine } = scriptedEngine({ throws: new Error('invalid meta: x') })
    const out = await call(
      createWorkflowTool({ engine, runs: new WorkflowRunRegistry() }),
      { script: 'x', meta },
    )
    expect(out).toMatchObject({ isError: true, text: 'Error: invalid meta: x' })
  })

  it('validates its own arguments (missing script)', async () => {
    const { engine, requests } = scriptedEngine()
    const out = await call(
      createWorkflowTool({ engine, runs: new WorkflowRunRegistry() }),
      { meta },
    )
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/invalid arguments for tool "workflow"/)
    expect(requests).toHaveLength(0)
  })

  it('truncates an oversized rendered value with a notice (maxResultChars)', async () => {
    const { engine } = scriptedEngine({
      result: {
        value: 'x'.repeat(100),
        stopReason: 'completed',
        agentsStarted: 0,
      },
    })
    const out = await call(
      createWorkflowTool({
        engine,
        runs: new WorkflowRunRegistry(),
        maxResultChars: 10,
      }),
      { script: 'x', meta },
    )
    expect(out.text).toContain('… [truncated: 92 more characters]')
    expect(out.meta).not.toHaveProperty('result')
  })

  it('installs workflow + ralph with their prompt sections (visible to every agent)', () => {
    const h = createTestHarness()
    const { engine } = scriptedEngine()
    installWorkflow(h.tools, h.prompt, {
      engine,
      runs: new WorkflowRunRegistry(),
    })
    const names = h.tools.schemas(h.agent('a')).map((schema) => schema.name)
    expect(names).toEqual(expect.arrayContaining(['workflow', 'ralph']))
    const child = h.agent('child', { owner: h.agent('p') })
    expect(h.tools.get('workflow', child)).toBeDefined()
    expect(h.tools.get('ralph', child)).toBeDefined()
  })
})

describe('ralph tool', () => {
  const report = (status: string, extra: Record<string, unknown> = {}) => ({
    status,
    summary: 'did work',
    evidence: status === 'continue' ? [] : ['tests pass'],
    nextSteps: status === 'continue' ? ['next'] : [],
    blocker: status === 'blocked' ? 'need input' : '',
    ...extra,
  })

  async function ralph(
    args: unknown,
    options: Parameters<typeof scriptedEngine>[0] = {},
    config: Parameters<typeof createRalphTool>[0]['config'] = { maxRounds: 64 },
    signal?: AbortSignal,
  ) {
    const scripted = scriptedEngine(options)
    const tool = createRalphTool({
      engine: scripted.engine,
      runs: new WorkflowRunRegistry(),
      config,
    })
    const out = await call(tool, args, signal)
    return { ...scripted, out }
  }

  it('starts the fixed workflow through the fresh provider and renders completion', async () => {
    const { out, requests, runs } = await ralph(
      { objective: '  ship it  ', maxRounds: 3 },
      {
        result: {
          value: {
            status: 'complete',
            roundsStarted: 2,
            report: report('complete'),
          },
          stopReason: 'completed',
          agentsStarted: 2,
        },
      },
    )
    expect(out.isError).toBe(false)
    expect(out.text).toMatch(
      /^Ralph worker reported completion after 2 rounds\.\nFinal report:\n/,
    )
    expect(requests[0]).toMatchObject({
      script: RALPH_SCRIPT,
      meta: RALPH_META,
      args: { objective: 'ship it', maxRounds: 3, maxHandoffChars: 16_384 },
      subagentProvider: 'spawn',
      maxTotalAgents: 3,
    })
    expect(runs[0]!.disposed).toBe(1)
  })

  it('renders blocked and budget-limited outcomes as bounded successes', async () => {
    const blocked = await ralph(
      { objective: 'x' },
      {
        result: {
          value: {
            status: 'blocked',
            roundsStarted: 1,
            report: report('blocked'),
          },
          stopReason: 'completed',
          agentsStarted: 1,
        },
      },
    )
    expect(blocked.out.text).toMatch(
      /^Ralph worker reported a blocker after 1 round\./,
    )
    const budget = await ralph(
      { objective: 'x', maxRounds: 2 },
      {
        result: {
          value: {
            status: 'budget-limited',
            roundsStarted: 2,
            report: report('continue'),
          },
          stopReason: 'completed',
          agentsStarted: 2,
        },
      },
    )
    expect(budget.out.text).toMatch(
      /^Ralph reached its 2 rounds limit; the worker reported work remaining\./,
    )
    const bounded = await ralph(
      { objective: 'x' },
      {
        result: {
          value: {
            status: 'complete',
            roundsStarted: 1,
            report: report('complete'),
          },
          stopReason: 'completed',
          agentsStarted: 1,
        },
      },
      { maxRounds: 64, maxResultChars: 40 },
    )
    expect(bounded.out.text).toHaveLength(40)
    expect(bounded.out.text.endsWith('\n… [truncated]')).toBe(true)
  })

  it('reports an ordinary child failure with the failed round and last handoff', async () => {
    const first = await ralph(
      { objective: 'x' },
      {
        result: {
          value: { status: 'round-failed', roundsStarted: 1, lastReport: null },
          stopReason: 'completed',
          agentsStarted: 1,
        },
      },
    )
    expect(first.out).toMatchObject({
      isError: true,
      text: 'Error: Ralph round 1 child failed before producing a structured report.\nNo previous handoff was available.',
    })
    const later = await ralph(
      { objective: 'x' },
      {
        result: {
          value: {
            status: 'round-failed',
            roundsStarted: 3,
            lastReport: report('continue'),
          },
          stopReason: 'completed',
          agentsStarted: 3,
        },
      },
    )
    expect(later.out.text).toContain('Last successful handoff:')
  })

  it('maps workflow error and cancellation to tool errors and always disposes', async () => {
    const failed = await ralph(
      { objective: 'x' },
      {
        result: {
          value: null,
          stopReason: 'error',
          error: 'bad',
          agentsStarted: 0,
        },
      },
    )
    expect(failed.out.text).toBe('Error: Ralph workflow failed: bad')
    expect(failed.runs[0]!.disposed).toBe(1)
    const controller = new AbortController()
    const pending = ralph(
      { objective: 'x' },
      {},
      { maxRounds: 64 },
      controller.signal,
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    const cancelled = await pending
    // The registry reports an aborted call; the run itself was cancelled and disposed.
    expect(cancelled.out.isError).toBe(true)
    expect(cancelled.runs[0]!.disposed).toBe(1)
    expect(cancelled.runs[0]!.cancelled).toEqual(['parent step aborted'])
  })

  it('rejects empty objectives, bad round caps, and invalid calls before start', async () => {
    const empty = await ralph({ objective: '   ' })
    expect(empty.out.text).toBe(
      'Error: Ralph objective must be a non-empty string',
    )
    const zero = await ralph({ objective: 'x', maxRounds: 0 })
    expect(zero.out.text).toBe(
      'Error: Ralph maxRounds must be a positive safe integer',
    )
    const over = await ralph({ objective: 'x', maxRounds: 65 })
    expect(over.out.text).toBe(
      'Error: Ralph maxRounds 65 exceeds the deployment ceiling 64',
    )
    const invalid = await ralph({})
    expect(invalid.out.text).toMatch(/invalid arguments for tool "ralph"/)
    for (const result of [empty, zero, over, invalid])
      expect(result.requests).toHaveLength(0)
  })

  it('rejects missing, unstructured, and parent-context-inheriting providers', async () => {
    const missing = await ralph({ objective: 'x' }, { provider: null })
    expect(missing.out.text).toBe(
      'Error: Ralph subagent provider "spawn" is not registered',
    )
    const unstructured = await ralph(
      { objective: 'x' },
      { provider: { capabilities: { outputSchema: false } } },
    )
    expect(unstructured.out.text).toMatch(/does not support structured output/)
    const inheriting = await ralph(
      { objective: 'x' },
      { provider: { inheritsParentContext: true } },
    )
    expect(inheriting.out.text).toMatch(/Ralph requires a fresh provider/)
  })

  it('rejects invalid config before touching the engine', () => {
    expect(() => resolveRalphConfig({ maxRounds: 0 })).toThrow(/maxRounds/)
    expect(() => resolveRalphConfig({ subagentProvider: ' spawn' })).toThrow(
      /normalized/,
    )
    expect(() => resolveRalphConfig({ maxHandoffChars: 1.5 })).toThrow(
      /maxHandoffChars/,
    )
    expect(resolveRalphConfig()).toEqual({
      subagentProvider: 'spawn',
      maxRounds: 256,
      maxHandoffChars: 16_384,
      maxResultChars: 16_384,
    })
  })

  it('turns malformed terminal values and reports into errors', async () => {
    const malformed: unknown[] = [
      null,
      { status: 'complete', roundsStarted: 0, report: report('complete') },
      { status: 'complete', roundsStarted: 99, report: report('complete') },
      {
        status: 'complete',
        roundsStarted: 1,
        report: report('complete'),
        extra: 1,
      },
      { status: 'complete', roundsStarted: 1, report: report('continue') },
      {
        status: 'complete',
        roundsStarted: 1,
        report: report('complete', { nextSteps: ['x'] }),
      },
      {
        status: 'budget-limited',
        roundsStarted: 1,
        report: report('continue'),
      },
      {
        status: 'round-failed',
        roundsStarted: 1,
        lastReport: report('continue'),
      },
      { status: 'round-failed', roundsStarted: 2, lastReport: null },
      { status: 'weird', roundsStarted: 1 },
    ]
    for (const value of malformed) {
      const { out } = await ralph(
        { objective: 'x', maxRounds: 3 },
        { result: { value, stopReason: 'completed', agentsStarted: 1 } },
      )
      expect(out.isError, JSON.stringify(value)).toBe(true)
      expect(out.text).toMatch(/^Error: Ralph workflow returned/)
    }
  })
})
