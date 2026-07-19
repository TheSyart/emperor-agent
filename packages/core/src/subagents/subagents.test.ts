import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskManager } from '../tasks/manager'
import { TaskKind, TaskStatus } from '../tasks/models'
import { TaskRuntimeRegistry } from '../tasks/runtime'
import { SidechainTranscript } from '../tasks/sidechain'
import { TokenTracker } from '../memory/token-tracker'
import type { ModelRouter, ProviderSnapshot } from '../model/router'
import type { LLMResponse } from '../providers/base'
import { Tool, type ToolExecutionContext } from '../tools/base'
import { S, toolParamsSchema } from '../tools/schema'
import { ToolRegistry } from '../tools/registry'
import {
  DispatchSubagentTool,
  composeSubagentTask,
  extractEvidenceFiles,
  extractEvidenceRefs,
} from '../tools/dispatch'
import { buildDispatchRunnerFactory } from './dispatch-runner'
import { SubagentRegistry } from './registry'
import { ExecutionEnvironment } from '../environment/snapshot'

const TEMPLATES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'templates',
  'subagents',
)

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function withEnv(
  name: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

class ReadTool extends Tool {
  override name = 'read_file'
  override description = 'read'
  override parameters = toolParamsSchema({}, [])
  override readOnly = true
  execute(): string {
    return 'ok'
  }
}

class PolicyProbeTool extends Tool {
  override readonly description = 'policy probe'
  override readonly parameters = toolParamsSchema(
    { name: S('optional resource name') },
    [],
  )
  override readonly name: string
  readonly mcpServerName?: string

  constructor(name: string, readOnly: boolean, mcpServerName?: string) {
    super()
    this.name = name
    this.readOnly = readOnly
    this.mcpServerName = mcpServerName
  }

  execute(args: Record<string, unknown>): string {
    return `${this.name}:${String(args.name ?? 'ok')}`
  }
}

class FakeRunner {
  history: Array<Record<string, unknown>> = []
  constructor(private readonly final: string) {}
  step(history: Array<Record<string, unknown>>): string {
    this.history = history
    return this.final
  }
}

describe('SubagentRegistry (W08)', () => {
  it('keeps builtin agents when legacy callers pass the templates parent or a missing override', () => {
    const fromParent = new SubagentRegistry(join(TEMPLATES, '..'))
    const fromMissingOverride = new SubagentRegistry(
      join(tmp('emperor-subagent-missing-'), 'templates', 'subagents'),
    )

    expect(fromParent.get('verification_reviewer')?.name).toBe(
      'verification_reviewer',
    )
    expect(fromMissingOverride.get('sili_suitang')?.name).toBe('sili_suitang')
    expect(fromMissingOverride.snapshot().sources[0]).toMatchObject({
      kind: 'builtin',
      trust: 'system',
      active: true,
    })
  })

  it('loads builtin specs, aliases, templates, and skill summaries', () => {
    const registry = new SubagentRegistry(TEMPLATES, {
      buildSkillsSummary: () => '- **demo**: skill summary',
    })

    expect(registry.names()).toEqual([
      'dongchang_tanshi',
      'neiguan_yingzao',
      'shangbao_dianbu',
      'sili_suitang',
      'verification_reviewer',
      'xiaohuangmen',
    ])
    expect(registry.names({ includeAliases: true })).toContain('researcher')
    expect(registry.aliases()).toEqual({
      general: 'neiguan_yingzao',
      researcher: 'dongchang_tanshi',
      reviewer: 'verification_reviewer',
    })
    expect(registry.get('researcher')?.name).toBe('dongchang_tanshi')
    expect(registry.get('sili_suitang')?.systemPrompt).toContain('司礼监随堂')
    expect(registry.get('sili_suitang')?.systemPrompt).toContain('demo')
    expect(registry.snapshot()).toMatchObject({
      schemaVersion: 1,
      sources: [
        {
          id: 'emperor-builtin-agents',
          kind: 'builtin',
          trust: 'system',
          active: true,
        },
      ],
      diagnostics: [],
    })
    expect(registry.get('sili_suitang')).toMatchObject({
      source: { kind: 'builtin', trust: 'system' },
      definition: {
        schemaVersion: 1,
        tools: { allow: ['load_skill', 'read_file', 'glob', 'grep'] },
        skills: { allow: ['*'] },
        hooks: { allow: ['SubagentStart', 'SubagentStop'] },
        mcp: { servers: [] },
        memory: { mode: 'none', scopes: [] },
        completion: { maxTurns: 12 },
        sandbox: {
          filesystem: 'read-only',
          network: 'deny',
          process: 'deny',
        },
      },
    })
    for (const name of registry.names()) {
      const tools = registry.get(name)!.toolNames
      expect(tools).not.toContain('dispatch_subagent')
      expect(tools).not.toContain('update_todos')
    }
  })

  it('materializes valid additional definitions and applies session restrictions without losing builtins', () => {
    const userRoot = tmp('emperor-agent-definition-user-')
    const builtinBundle = JSON.parse(
      readFileSync(join(TEMPLATES, 'agents.json'), 'utf8'),
    ) as { agents: Array<Record<string, unknown>> }
    const custom = {
      ...builtinBundle.agents[0],
      name: 'custom_agent',
      aliases: ['custom'],
      prompt: 'custom.md',
    }
    writeFileSync(join(userRoot, 'custom.md'), 'custom prompt', 'utf8')
    writeFileSync(
      join(userRoot, 'agents.json'),
      JSON.stringify({ schemaVersion: 1, agents: [custom] }),
      'utf8',
    )
    writeFileSync(join(userRoot, 'corrupt.json'), '{bad json', 'utf8')

    const registry = new SubagentRegistry(TEMPLATES, null, {
      additionalSources: [
        {
          id: 'user-agents',
          kind: 'user',
          root: userRoot,
          manifests: ['agents.json', 'corrupt.json'],
          trusted: true,
        },
      ],
      sessionPolicy: {
        toolNames: ['read_file'],
        maxTurns: 5,
        sandbox: {
          filesystem: 'read-only',
          network: 'deny',
          process: 'deny',
        },
      },
    })

    expect(registry.names()).toContain('sili_suitang')
    expect(registry.get('custom')).toMatchObject({
      name: 'custom_agent',
      toolNames: ['read_file'],
      maxTurns: 5,
      source: { id: 'user-agents', kind: 'user', trust: 'user' },
      definition: {
        sandbox: {
          filesystem: 'read-only',
          network: 'deny',
          process: 'deny',
        },
      },
    })
    expect(registry.snapshot().diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'user-agents',
          code: 'invalid_manifest_json',
        }),
      ]),
    )
  })
})

describe('DispatchSubagentTool (W04-014/W08)', () => {
  it('enforces Skill, Hook, and sandbox restrictions from the materialized definition', async () => {
    const registry = new SubagentRegistry(TEMPLATES, null, {
      sessionPolicy: {
        toolNames: ['load_skill', 'write_file'],
        skillNames: ['skill-a'],
        hookIds: [],
        sandbox: {
          filesystem: 'read-only',
          network: 'deny',
          process: 'deny',
        },
      },
    })
    const parent = new ToolRegistry()
    parent.register(new PolicyProbeTool('load_skill', true))
    parent.register(new PolicyProbeTool('write_file', false))
    const observed: string[] = []
    let hookBegins = 0
    let hookEnds = 0
    const tool = new DispatchSubagentTool({
      parentRegistry: parent,
      subagentRegistry: registry,
      runnerFactory: ({ subRegistry }) => ({
        step: async () => {
          observed.push(
            await subRegistry.execute('load_skill', { name: 'skill-a' }),
          )
          observed.push(
            await subRegistry.execute('load_skill', { name: 'skill-b' }),
          )
          observed.push(await subRegistry.execute('write_file', {}))
          return '结论: policy checked'
        },
      }),
      hooks: {
        begin: async () => {
          hookBegins += 1
          return {
            decision: 'allow',
            reason: '',
            results: [],
            additionalContext: '',
          }
        },
        end: () => {
          hookEnds += 1
        },
      },
    })

    await expect(
      tool.execute({ agent_type: 'neiguan_yingzao', task: 'policy probe' }),
    ).resolves.toBe('结论: policy checked')
    expect(observed).toEqual([
      'load_skill:skill-a',
      '[ERR] AgentDefinition denied Skill: skill-b',
      '[ERR] AgentDefinition read-only sandbox denied destructive tool: write_file',
    ])
    expect(hookBegins).toBe(0)
    expect(hookEnds).toBe(0)
  })

  it('materializes only MCP tools from explicitly allowed server identities', async () => {
    const sourceRoot = tmp('emperor-agent-definition-mcp-')
    const builtinBundle = JSON.parse(
      readFileSync(join(TEMPLATES, 'agents.json'), 'utf8'),
    ) as { agents: Array<Record<string, unknown>> }
    const mcpAgent = {
      ...builtinBundle.agents[0],
      name: 'mcp_agent',
      prompt: 'mcp_agent.md',
      tools: { allow: ['read_file'] },
      mcp: { servers: ['docs'] },
      sandbox: {
        filesystem: 'read-only',
        network: 'policy',
        process: 'deny',
      },
    }
    writeFileSync(join(sourceRoot, 'mcp_agent.md'), 'mcp prompt', 'utf8')
    writeFileSync(
      join(sourceRoot, 'agents.json'),
      JSON.stringify({ schemaVersion: 1, agents: [mcpAgent] }),
      'utf8',
    )
    const registry = new SubagentRegistry(TEMPLATES, null, {
      userSourceRoot: sourceRoot,
    })
    const parent = new ToolRegistry()
    parent.register(new PolicyProbeTool('read_file', true))
    parent.register(new PolicyProbeTool('mcp_docs_search', true, 'docs'))
    parent.register(
      new PolicyProbeTool('mcp_docs_private_search', true, 'docs_private'),
    )
    let toolNames: string[] = []
    const tool = new DispatchSubagentTool({
      parentRegistry: parent,
      subagentRegistry: registry,
      runnerFactory: ({ subRegistry }) => ({
        step: () => {
          toolNames = subRegistry.getDefinitions().map((item) => item.name)
          return '结论: mcp policy checked'
        },
      }),
    })

    await tool.execute({ agent_type: 'mcp_agent', task: 'mcp probe' })

    expect(toolNames).toEqual(['read_file', 'mcp_docs_search'])
  })

  it('composes contract text and extracts evidence refs', () => {
    const task = composeSubagentTask('阅读核心流程', {
      expectedOutput: '列出结论',
      evidenceRequired: '文件路径/行号',
      scopeLimit: '只读 agent/',
    })
    expect(task).toContain('## 差事契约')
    expect(task).toContain('期望产物: 列出结论')
    const refs = extractEvidenceRefs(
      '证据: agent/runner.py:10 docs/migration/ts/README.md https://example.com',
    )
    expect(refs).toEqual(['agent/runner.py:10', 'docs/migration/ts/README.md'])
    expect(extractEvidenceFiles(refs)).toEqual([
      'agent/runner.py',
      'docs/migration/ts/README.md',
    ])
  })

  it('records task and sidechain while running an isolated fake runner', async () => {
    const root = tmp('emperor-dispatch-')
    const subagents = new SubagentRegistry(TEMPLATES)
    const parent = new ToolRegistry()
    parent.register(new ReadTool())
    const manager = new TaskManager(root)
    const captured: Record<string, unknown> = {}
    const emitted: Array<Record<string, unknown>> = []
    const fakeRunner = new FakeRunner(
      '结论: done\n证据: agent/runner.py:10\n风险: none\n建议下一步: none',
    )
    const executionEnvironment = new ExecutionEnvironment(
      {
        revision: 'a'.repeat(64),
        catalogRevision: 'b'.repeat(64),
        projectFingerprint: 'c'.repeat(64),
        createdAt: '2026-07-11T02:00:00.000Z',
        platform: 'darwin',
        pathEntries: ['/snapshot/bin'],
        env: { PATH: '/snapshot/bin' },
        toolPaths: {},
      },
      {},
    )

    const tool = new DispatchSubagentTool({
      parentRegistry: parent,
      subagentRegistry: subagents,
      runnerFactory: (args) => {
        captured.task = args.task
        captured.taskId = args.taskId
        captured.agentId = args.agentId
        captured.turnId = args.turnId
        captured.precreated = Boolean(
          args.taskId && manager.store.inspect(args.taskId).record,
        )
        captured.tools = args.subRegistry
          .getDefinitions()
          .map((def) => def.name)
        captured.executionEnvironment = args.executionEnvironment
        return fakeRunner
      },
      taskManager: manager,
    })

    const result = await tool.execute(
      {
        agent_type: 'sili_suitang',
        task: '阅读核心流程',
        purpose: 'read files',
        expected_output: '结论/证据',
        evidence_required: '文件路径',
        scope_limit: '只读',
      },
      {
        root: root,
        arguments: {},
        parentCallId: 'call_1',
        sessionId: 'sess_d',
        executionEnvironment,
        emit: (event) => {
          emitted.push(event)
        },
      },
    )

    expect(result).toContain('结论: done')
    expect(captured.task).toContain('期望产物: 结论/证据')
    expect(captured).toMatchObject({
      taskId: expect.any(String),
      agentId: expect.any(String),
      turnId: expect.any(String),
      precreated: true,
    })
    expect(captured.tools).toEqual(['read_file'])
    expect(captured.executionEnvironment).toBe(executionEnvironment)
    const [record] = manager.store.list()
    expect(record!.kind).toBe(TaskKind.SUBAGENT)
    expect(record!.status).toBe(TaskStatus.COMPLETED)
    expect(record!.tool_call_id).toBe('call_1')
    expect(record!.session_id).toBe('sess_d')
    expect(record!.metadata).toMatchObject({
      agent_definition_revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      agent_source_id: 'emperor-builtin-agents',
      agent_source_kind: 'builtin',
      agent_source_trust: 'system',
    })
    expect(record!.output_path).toMatch(/output\.log$/)
    expect(readFileSync(join(root, record!.output_path!), 'utf8')).toContain(
      '结论: done',
    )
    expect(emitted.map((event) => event.event)).toEqual([
      'task_started',
      'task_done',
    ])
    const page = new SidechainTranscript(root, record!.id).read()
    expect(page.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(page.messages[0]!.content).toBe(captured.task)
  })

  it('does not overwrite a subagent task that was cancelled before the runner returns', async () => {
    const root = tmp('emperor-dispatch-cancelled-')
    const subagents = new SubagentRegistry(TEMPLATES)
    const parent = new ToolRegistry()
    parent.register(new ReadTool())
    const manager = new TaskManager(root)
    const taskRuntime = new TaskRuntimeRegistry(manager)
    const runnerSignal: { value: AbortSignal | null } = { value: null }

    const tool = new DispatchSubagentTool({
      parentRegistry: parent,
      subagentRegistry: subagents,
      runnerFactory: () => ({
        step: (_history, opts) => {
          runnerSignal.value = opts?.signal ?? null
          const [record] = manager.store.list()
          manager.cancelTask(record!.id, { reason: 'user stopped subagent' })
          return '结论: should not complete'
        },
      }),
      taskManager: manager,
      taskRuntime,
    })

    const result = await tool.execute(
      {
        agent_type: 'sili_suitang',
        task: '阅读核心流程',
        purpose: 'read files',
        expected_output: '结论/证据',
        evidence_required: '文件路径',
        scope_limit: '只读',
      },
      { root: root, arguments: {}, parentCallId: 'call_cancelled' },
    )

    const [record] = manager.store.list()
    expect(result).toContain('cancelled')
    expect(record!.status).toBe(TaskStatus.CANCELLED)
    expect(record!.progress.reason).toBe('user stopped subagent')
    expect(runnerSignal.value?.aborted).toBe(true)
    const page = new SidechainTranscript(root, record!.id).read()
    expect(page.messages.map((m) => m.role)).toEqual(['user'])
  })

  it('propagates the parent tool signal into the dispatch runner', async () => {
    const root = tmp('emperor-dispatch-parent-cancel-')
    const subagents = new SubagentRegistry(TEMPLATES)
    const parent = new ToolRegistry()
    parent.register(new ReadTool())
    const manager = new TaskManager(root)
    const taskRuntime = new TaskRuntimeRegistry(manager)
    const parentAbort = new AbortController()
    const runnerSignal: { value: AbortSignal | null } = { value: null }
    const tool = new DispatchSubagentTool({
      parentRegistry: parent,
      subagentRegistry: subagents,
      taskManager: manager,
      taskRuntime,
      runnerFactory: () => ({
        step: (_history, opts) => {
          runnerSignal.value = opts?.signal ?? null
          return new Promise<string>((_resolve, reject) => {
            opts?.signal?.addEventListener(
              'abort',
              () => reject(new Error('runner aborted')),
              { once: true },
            )
          })
        },
      }),
    })

    const running = tool.execute(
      {
        agent_type: 'sili_suitang',
        task: '等待父任务取消',
        expected_output: '结论',
        evidence_required: '路径',
        scope_limit: '只读',
      },
      {
        root,
        arguments: {},
        parentCallId: 'call_parent_cancel',
        signal: parentAbort.signal,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    parentAbort.abort('parent turn cancelled')

    await expect(running).resolves.toContain('cancelled')
    expect(runnerSignal.value?.aborted).toBe(true)
    expect(manager.store.list()[0]?.status).toBe(TaskStatus.CANCELLED)
  })

  it('returns background ownership immediately and detaches it from parent cancellation', async () => {
    const root = tmp('emperor-dispatch-background-')
    const manager = new TaskManager(root)
    const taskRuntime = new TaskRuntimeRegistry(manager)
    const parentAbort = new AbortController()
    const executionSignal: { value: AbortSignal | null } = { value: null }
    const tool = new DispatchSubagentTool({
      parentRegistry: new ToolRegistry(),
      subagentRegistry: new SubagentRegistry(TEMPLATES),
      taskManager: manager,
      taskRuntime,
      runnerFactory: () => ({
        step: (_history, opts) => {
          executionSignal.value = opts?.signal ?? null
          return new Promise<string>(() => {})
        },
      }),
    })

    const result = await tool.execute(
      {
        agent_type: 'sili_suitang',
        task: 'background research',
        mode: 'background',
      },
      {
        root,
        arguments: {},
        sessionId: 'session_background',
        signal: parentAbort.signal,
      },
    )
    const task = manager.store.list()[0]!

    expect(result).toContain(`background task started: ${task.id}`)
    expect(task.status).toBe(TaskStatus.RUNNING)
    parentAbort.abort('parent finished')
    await Promise.resolve()
    expect(executionSignal.value?.aborted).toBe(false)

    await taskRuntime.cancel(task.id, 'owner session closed')
    expect(manager.store.get(task.id)).toMatchObject({
      status: TaskStatus.CANCELLED,
      progress: { reason: 'owner session closed' },
    })
  })

  it('rejects recursive dispatch before creating a task', async () => {
    const root = tmp('emperor-dispatch-depth-')
    const manager = new TaskManager(root)
    const tool = new DispatchSubagentTool({
      parentRegistry: new ToolRegistry(),
      subagentRegistry: new SubagentRegistry(TEMPLATES),
      taskManager: manager,
      runnerFactory: () => new FakeRunner('unreachable'),
    })

    await expect(
      tool.execute(
        { agent_type: 'sili_suitang', task: 'nested dispatch' },
        { root, arguments: {}, subagentDepth: 1 },
      ),
    ).resolves.toContain('maximum depth is 1')
    expect(manager.store.list()).toEqual([])
  })

  it('enforces plan mode readonly explorer contract', () => {
    const subagents = new SubagentRegistry(TEMPLATES)
    const tool = new DispatchSubagentTool({
      parentRegistry: new ToolRegistry(),
      subagentRegistry: subagents,
      runnerFactory: () => new FakeRunner('unused'),
      controlManager: { mode: 'plan' },
    })

    expect(
      tool.isReadOnly({
        agent_type: 'sili_suitang',
        task: 'read',
        expected_output: 'summary',
        evidence_required: 'files',
        scope_limit: 'only docs',
      }),
    ).toBe(true)
    expect(tool.isReadOnly({ agent_type: 'sili_suitang', task: 'read' })).toBe(
      false,
    )
    expect(
      tool.isReadOnly({
        agent_type: 'neiguan_yingzao',
        task: 'write',
        expected_output: 'x',
        evidence_required: 'x',
        scope_limit: 'x',
      }),
    ).toBe(false)
  })

  it('uses the one active model for subagents and records model_entry_id', async () => {
    const root = tmp('emperor-dispatch-routed-')
    const subagents = new SubagentRegistry(TEMPLATES)
    const tracker = new TokenTracker(join(root, 'memory', 'tokens.jsonl'))
    const calls: Array<Record<string, unknown>> = []
    const modelRouter = {
      route: (
        useCase: string,
        agentType?: string | null,
        task?: string | null,
      ) => {
        calls.push({ useCase, agentType, task })
        return {
          snapshot: {
            ...snapshot('active-model', 'main'),
            modelEntryId: 'active-entry',
            entryName: 'active-entry',
          },
          useCase,
          reason: `${useCase}:${agentType}:lightweight`,
          estimatedTokens: 10,
        }
      },
    } as unknown as ModelRouter
    const factory = buildDispatchRunnerFactory({
      modelRouter,
      tokenTracker: tracker,
    })
    const spec = subagents.get('sili_suitang')!
    const runner = factory({
      spec,
      subRegistry: new ToolRegistry(),
      task: '阅读 docs',
    })

    const result = await runner.step([{ role: 'user', content: '阅读 docs' }])
    expect(result).toBe('结论: routed')
    expect(calls[0]).toMatchObject({
      useCase: 'subagent',
      agentType: 'sili_suitang',
      task: '阅读 docs',
    })
    expect(requireTokenLedger(tracker.logFile)).toContain(
      '"model_entry_id":"active-entry"',
    )
    expect(requireTokenLedger(tracker.logFile)).not.toContain('"model_role"')
    expect(requireTokenLedger(tracker.logFile)).toContain(
      '"usage_type":"subagent:sili_suitang"',
    )
  })

  it('inherits the parent execution snapshot in the routed subagent runner', async () => {
    let calls = 0
    const seen: string[] = []
    const seenDepths: number[] = []
    const environment = new ExecutionEnvironment(
      {
        revision: 'd'.repeat(64),
        catalogRevision: 'e'.repeat(64),
        projectFingerprint: 'f'.repeat(64),
        createdAt: '2026-07-11T02:00:00.000Z',
        platform: 'darwin',
        pathEntries: ['/snapshot/bin'],
        env: { PATH: '/snapshot/bin' },
        toolPaths: {},
      },
      {},
    )
    const registry = new ToolRegistry()
    registry.register(
      new (class extends Tool {
        override name = 'inspect_environment'
        override description = 'inspect environment'
        override parameters = toolParamsSchema({}, [])
        execute(
          _args: Record<string, unknown>,
          context?: ToolExecutionContext,
        ): string {
          const revision = context?.executionEnvironment?.revision ?? 'missing'
          seen.push(revision)
          seenDepths.push(context?.subagentDepth ?? -1)
          return revision
        }
      })(),
    )
    const provider = {
      chat: async (): Promise<LLMResponse> => {
        calls += 1
        return calls === 1
          ? {
              ...response(''),
              content: null,
              finishReason: 'tool_calls',
              toolCalls: [
                {
                  id: 'call-environment',
                  name: 'inspect_environment',
                  arguments: {},
                },
              ],
            }
          : response('done')
      },
    }
    const modelRouter = {
      route: () => ({
        snapshot: {
          ...snapshot('secondary-model', 'secondary'),
          provider,
        },
        fallback: null,
        useCase: 'subagent',
        reason: 'snapshot inheritance',
        estimatedTokens: null,
      }),
    } as unknown as ModelRouter
    const runner = buildDispatchRunnerFactory({ modelRouter })({
      spec: new SubagentRegistry(TEMPLATES).get('sili_suitang')!,
      subRegistry: registry,
      task: 'inspect environment',
      executionEnvironment: environment,
    })

    await runner.step([{ role: 'user', content: 'inspect' }])

    expect(seen).toEqual(['d'.repeat(64)])
    expect(seenDepths).toEqual([1])
  })

  it('routed dispatch runner adopts the route context window for compaction checks', async () => {
    const subagents = new SubagentRegistry(TEMPLATES)
    const seenMaxContext: number[] = []
    const modelRouter = {
      route: () => ({
        snapshot: {
          ...snapshot('secondary-model', 'secondary'),
          contextWindowTokens: 64_000,
        },
        fallback: null,
        useCase: 'subagent',
        reason: 'test',
        estimatedTokens: null,
      }),
    } as unknown as ModelRouter
    const factory = buildDispatchRunnerFactory({
      modelRouter,
      tokenTracker: {
        record: () => undefined,
        shouldCompact: (maxContext: number) => {
          seenMaxContext.push(maxContext)
          return false
        },
      },
      compactor: { compactAsync: async (history) => history },
    })
    const spec = subagents.get('sili_suitang')!
    const runner = factory({
      spec,
      subRegistry: new ToolRegistry(),
      task: '阅读 docs',
    })

    await withEnv('EMPEROR_AUTO_MEMORY_COMPACT', '1', async () => {
      await runner.step([{ role: 'user', content: '阅读 docs' }])
    })
    expect(seenMaxContext.length).toBeGreaterThan(0)
    // 有效上限 = 路由窗口 64_000 − 预留输出 maxTokens 2_000
    expect(seenMaxContext[0]).toBe(62_000)
  })

  it('fails closed when the active model is outside the AgentDefinition allowlist', () => {
    const spec = new SubagentRegistry(TEMPLATES, null, {
      sessionPolicy: { allowedModelProfiles: ['safe-profile'] },
    }).get('sili_suitang')!
    const modelRouter = {
      route: () => ({
        snapshot: {
          ...snapshot('unsafe-model', 'secondary'),
          modelEntryId: 'unsafe-profile',
          entryName: 'unsafe-profile',
        },
        fallback: null,
        useCase: 'subagent',
        reason: 'test',
        estimatedTokens: null,
      }),
    } as unknown as ModelRouter

    expect(() =>
      buildDispatchRunnerFactory({ modelRouter })({
        spec,
        subRegistry: new ToolRegistry(),
        task: 'must use safe profile',
      }),
    ).toThrow(/AgentDefinition model policy denied active profile/i)
  })

  it('fails the subagent when cumulative model usage exceeds its token budget', async () => {
    const modelRouter = {
      route: () => ({
        snapshot: {
          ...snapshot('budgeted-model', 'secondary'),
          provider: {
            chat: async (): Promise<LLMResponse> => ({
              ...response('too expensive'),
              usage: { input: 8, output: 5 },
            }),
          },
        },
        fallback: null,
        useCase: 'subagent',
        reason: 'token budget test',
        estimatedTokens: null,
      }),
    } as unknown as ModelRouter
    const runner = buildDispatchRunnerFactory({
      modelRouter,
      tokenBudget: 10,
    })({
      spec: new SubagentRegistry(TEMPLATES).get('sili_suitang')!,
      subRegistry: new ToolRegistry(),
      task: 'bounded research',
    })

    await expect(
      runner.step([{ role: 'user', content: 'bounded research' }]),
    ).rejects.toMatchObject({ code: 'agent_token_budget_exceeded' })
  })
})

function snapshot(model: string, role: 'main' | 'secondary'): ProviderSnapshot {
  return {
    provider: {
      chat: async (): Promise<LLMResponse> => response('结论: routed'),
    } as never,
    providerName: 'fake',
    providerLabel: 'Fake',
    model,
    apiBase: null,
    generation: { maxTokens: 2000, temperature: 0.1, reasoningEffort: null },
    contextWindowTokens: 100_000,
    config: {},
    supportsVision: false,
    entryName: 'fake',
    entryLabel: 'Fake',
    modelRole: role,
    routeReason: role === 'secondary' ? 'secondary_model' : 'fallback_main',
  }
}

function response(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { input: 2, output: 1 },
    reasoningContent: null,
    thinkingBlocks: null,
  }
}

function requireTokenLedger(path: string): string {
  return readFileSync(path, 'utf8')
}
