import { describe, expect, it } from 'vitest'
import type {
  HookAggregateDecision,
  HookEventName,
  HookRuntimeRunOptions,
} from '../hooks'
import {
  LLMProvider,
  type ChatArgs,
  type ChatStreamArgs,
  type LLMResponse,
} from '../providers/base'
import { Tool } from '../tools/base'
import { ToolRegistry } from '../tools/registry'
import { S, toolParamsSchema } from '../tools/schema'
import {
  AgentRunner,
  type AgentRunnerHookHost,
  type ControlManagerRunnerHost,
} from './runner'

type Dict = Record<string, unknown>

class SequenceProvider extends LLMProvider {
  readonly seenMessages: ChatArgs['messages'][] = []
  constructor(private readonly responses: LLMResponse[]) {
    super({ defaultModel: 'fake' })
  }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.seenMessages.push(args.messages.map((message) => ({ ...message })))
    const response = this.responses.shift()
    if (!response) throw new Error('missing response')
    return response
  }
}

class GuardedTool extends Tool {
  readonly name: string
  readonly description = 'tool hook test'
  readonly parameters = toolParamsSchema(
    { mode: S('read or write'), value: S('value') },
    ['mode', 'value'],
  )
  executions: Dict[] = []

  constructor(name = 'guarded') {
    super()
    this.name = name
  }
  override isReadOnly(args: Dict): boolean {
    return args.mode === 'read'
  }
  execute(args: Dict): string {
    this.executions.push({ ...args })
    return `executed:${String(args.mode)}:${String(args.value)}`
  }
}

class EarlyReadTool extends GuardedTool {
  override readOnly = true
  override concurrencySafe = true
}

class StreamingGateProvider extends LLMProvider {
  private calls = 0
  private releaseFirst!: () => void
  readonly enqueued: Promise<void>
  private readonly markEnqueued: () => void

  constructor(private readonly call: LLMResponse['toolCalls'][number]) {
    super({ defaultModel: 'fake' })
    let mark!: () => void
    this.enqueued = new Promise<void>((resolve) => {
      mark = resolve
    })
    this.markEnqueued = mark
  }

  release(): void {
    this.releaseFirst()
  }

  async chat(_args: ChatArgs): Promise<LLMResponse> {
    this.calls += 1
    return this.calls === 1 ? response(null, [this.call]) : response('done')
  }

  override async chatStream(args: ChatStreamArgs): Promise<LLMResponse> {
    this.calls += 1
    if (this.calls > 1) return response('done')
    await args.onToolCallComplete?.(this.call)
    this.markEnqueued()
    await new Promise<void>((resolve) => {
      this.releaseFirst = resolve
    })
    return response(null, [this.call])
  }
}

function response(
  content: string | null,
  toolCalls: LLMResponse['toolCalls'] = [],
): LLMResponse {
  return {
    content,
    toolCalls,
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    usage: {},
    reasoningContent: null,
    thinkingBlocks: null,
  }
}

function toolCall(
  name: string,
  arguments_: Dict,
  id = 'call-1',
): LLMResponse['toolCalls'][number] {
  return { id, name, arguments: arguments_ }
}

function decision(
  overrides: Partial<HookAggregateDecision> & Dict = {},
): HookAggregateDecision {
  return {
    decision: 'passthrough',
    reason: '',
    results: [],
    additionalContext: '',
    ...overrides,
  }
}

function hooks(
  run: (
    event: HookEventName,
    opts: HookRuntimeRunOptions,
  ) => HookAggregateDecision | Promise<HookAggregateDecision>,
): {
  host: AgentRunnerHookHost
  events: Array<{ event: HookEventName; opts: HookRuntimeRunOptions }>
} {
  const events: Array<{ event: HookEventName; opts: HookRuntimeRunOptions }> =
    []
  return {
    events,
    host: {
      run: async (event, opts) => {
        events.push({ event, opts })
        return await run(event, opts)
      },
    },
  }
}

function control(
  assess: (name: string, args: Dict) => Dict,
  planDecision: Dict | null = null,
): ControlManagerRunnerHost {
  return {
    systemPrompt: () => '',
    toolDefinitions: (registry) => registry.getDefinitions(),
    assessPermission: (name, args) => assess(name, args) as never,
    permissionApprovalResult: () => 'Error: permission approval required',
    assessClarification: () => ({
      required: false,
      reason: '',
      questions: [],
      categories: [],
    }),
    assessPlanDecision: () => planDecision,
    shouldEnforcePlanFinal: () => false,
    createAsk: () => {
      throw new Error('not expected')
    },
    createPlanFromText: () => {
      throw new Error('not expected')
    },
  }
}

async function runTool(opts: {
  tool?: GuardedTool
  hookHost?: AgentRunnerHookHost | null
  controlManager?: ControlManagerRunnerHost | null
  arguments?: Dict
}): Promise<{
  tool: GuardedTool
  provider: SequenceProvider
  history: Dict[]
}> {
  const tool = opts.tool ?? new GuardedTool()
  const registry = new ToolRegistry('/repo')
  registry.register(tool)
  const provider = new SequenceProvider([
    response(null, [
      toolCall(
        tool.name,
        opts.arguments ?? { mode: 'read', value: 'original' },
      ),
    ]),
    response('done'),
  ])
  const runner = new AgentRunner({
    provider,
    model: 'fake',
    registry,
    systemPrompt: 'system',
    hooks: opts.hookHost ?? null,
    controlManager: opts.controlManager ?? null,
    workspaceRoot: '/repo',
  })
  const history: Dict[] = [{ role: 'user', content: 'perform test operation' }]
  await runner.stepAsync(history)
  return { tool, provider, history }
}

describe('AgentRunner hooks v2 tool pipeline', () => {
  it('never lets PermissionRequest hook allow bypass a core approval', async () => {
    const hook = hooks((event) =>
      event === 'PermissionRequest'
        ? decision({ decision: 'allow', reason: 'approved by hook' })
        : decision(),
    )
    const manager = control(() => ({
      allowed: false,
      requiresApproval: true,
      risk: 'high',
      reason: 'needs approval',
      rule: 'test.ask',
      trace: [],
    }))

    const { tool, provider } = await runTool({
      hookHost: hook.host,
      controlManager: manager,
    })

    expect(tool.executions).toEqual([])
    expect(hook.events.map((entry) => entry.event)).toContain(
      'PermissionRequest',
    )
    const request = hook.events.find(
      (entry) => entry.event === 'PermissionRequest',
    )
    expect(request?.opts).toMatchObject({
      toolUseId: 'call-1',
      toolName: 'guarded',
    })
    expect(request?.opts.permission).toMatchObject({
      risk: 'high',
      rule: 'test.ask',
      trace: [],
    })
    expect(JSON.stringify(provider.seenMessages[1])).toContain(
      'permission approval required',
    )
  })

  it('never lets a hook allow override a core permission deny', async () => {
    const hook = hooks(() =>
      decision({ decision: 'allow', reason: 'try allow' }),
    )
    const manager = control(() => ({
      allowed: false,
      requiresApproval: false,
      risk: 'high',
      reason: 'workspace denied',
      rule: 'workspace',
      trace: [{ rule: 'workspace', outcome: 'deny', detail: '/outside' }],
    }))

    const { tool, provider } = await runTool({
      hookHost: hook.host,
      controlManager: manager,
    })

    expect(tool.executions).toHaveLength(0)
    expect(hook.events.map((entry) => entry.event)).not.toContain(
      'PermissionRequest',
    )
    expect(hook.events.map((entry) => entry.event)).toContain(
      'PermissionDenied',
    )
    expect(JSON.stringify(provider.seenMessages[1])).toContain(
      'workspace denied',
    )
  })

  it('revalidates hook-updated input against the tool schema', async () => {
    const hook = hooks((event) =>
      event === 'PreToolUse'
        ? decision({ decision: 'allow', updatedInput: { mode: 'write' } })
        : decision(),
    )

    const { tool, provider } = await runTool({ hookHost: hook.host })

    expect(tool.executions).toHaveLength(0)
    expect(JSON.stringify(provider.seenMessages[1])).toMatch(
      /schema|required|value/i,
    )
  })

  it('validates original input before invoking PreToolUse', async () => {
    const hook = hooks(() => decision({ decision: 'allow' }))

    const { tool, provider } = await runTool({
      hookHost: hook.host,
      arguments: { mode: 'read' },
    })

    expect(tool.executions).toHaveLength(0)
    expect(hook.events.map((entry) => entry.event)).not.toContain('PreToolUse')
    expect(JSON.stringify(provider.seenMessages[1])).toMatch(
      /schema|required|value/i,
    )
  })

  it('reruns Plan Guard after PreToolUse transforms a read into a write', async () => {
    const hook = hooks((event) =>
      event === 'PreToolUse'
        ? decision({
            decision: 'allow',
            updatedInput: { mode: 'write', value: 'changed' },
          })
        : decision(),
    )
    const manager = control(
      () => ({
        allowed: true,
        requiresApproval: false,
        risk: 'low',
        reason: '',
        rule: '',
        trace: [],
      }),
      {
        behavior: 'required',
        reason: 'architecture change',
        triggers: ['architecture'],
        recommended_readonly_scopes: ['src/**'],
      },
    )

    const { tool, provider } = await runTool({
      hookHost: hook.host,
      controlManager: manager,
    })

    expect(tool.executions).toHaveLength(0)
    expect(JSON.stringify(provider.seenMessages[1])).toContain(
      'PLAN_GUARD_REQUIRED',
    )
  })

  it('reassesses permission after PermissionRequest updates input', async () => {
    const hook = hooks((event) =>
      event === 'PermissionRequest'
        ? decision({
            decision: 'allow',
            updatedInput: { mode: 'write', value: 'blocked' },
          })
        : decision(),
    )
    const manager = control((_name, args) =>
      args.value === 'blocked'
        ? {
            allowed: false,
            requiresApproval: false,
            risk: 'high',
            reason: 'transformed deny',
            rule: 'test.deny',
            trace: [],
          }
        : {
            allowed: false,
            requiresApproval: true,
            risk: 'high',
            reason: 'ask',
            rule: 'test.ask',
            trace: [],
          },
    )

    const { tool } = await runTool({
      hookHost: hook.host,
      controlManager: manager,
    })

    expect(tool.executions).toHaveLength(0)
    expect(hook.events.map((entry) => entry.event)).toContain(
      'PermissionDenied',
    )
  })

  it('sends failure-specific input and only applies output replacement to MCP tools', async () => {
    const regularHook = hooks((event, _opts) => {
      if (event === 'PostToolUse')
        return decision({ updatedToolOutput: 'replaced' } as never)
      return decision()
    })
    const regular = await runTool({ hookHost: regularHook.host })
    expect(JSON.stringify(regular.provider.seenMessages[1])).toContain(
      'executed:read:original',
    )
    expect(JSON.stringify(regular.provider.seenMessages[1])).not.toContain(
      'replaced',
    )

    const mcpTool = new GuardedTool('mcp_guarded')
    const mcpHook = hooks((event) =>
      event === 'PostToolUse'
        ? decision({ updatedToolOutput: 'mcp-replaced' } as never)
        : decision(),
    )
    const mcp = await runTool({ tool: mcpTool, hookHost: mcpHook.host })
    expect(JSON.stringify(mcp.provider.seenMessages[1])).toContain(
      'mcp-replaced',
    )

    class FailingTool extends GuardedTool {
      override execute(): string {
        return 'Error: failed deliberately'
      }
    }
    const failureHook = hooks(() => decision())
    await runTool({ tool: new FailingTool(), hookHost: failureHook.host })
    const failure = failureHook.events.find(
      (entry) => entry.event === 'PostToolUseFailure',
    )
    expect(failure?.opts).toMatchObject({
      toolName: 'guarded',
      error: 'Error: failed deliberately',
    })
    expect(failure?.opts.toolResult).toBeUndefined()
  })

  it('cancels the turn while a blocking hook is running', async () => {
    const tool = new GuardedTool()
    const registry = new ToolRegistry('/repo')
    registry.register(tool)
    const provider = new SequenceProvider([
      response(null, [
        toolCall(tool.name, { mode: 'read', value: 'original' }),
      ]),
      response('done'),
    ])
    let started!: () => void
    const hookStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const host: AgentRunnerHookHost = {
      run: async (event, opts) => {
        if (event !== 'PreToolUse') return decision()
        started()
        const signal = opts.signal as AbortSignal
        return await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        )
      },
    }
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      hooks: host,
      workspaceRoot: '/repo',
    })
    const controller = new AbortController()
    const running = runner.stepAsync([{ role: 'user', content: 'run' }], {
      signal: controller.signal,
    })
    await hookStarted
    controller.abort()

    await expect(running).rejects.toThrow()
    expect(tool.executions).toHaveLength(0)
  })

  it('requires a snapshot proof before streaming tools start ahead of the model response', async () => {
    async function scenario(
      provesNoMatch: boolean,
    ): Promise<{ beforeRelease: number; after: number }> {
      const tool = new EarlyReadTool()
      const registry = new ToolRegistry('/repo')
      registry.register(tool)
      const provider = new StreamingGateProvider(
        toolCall(tool.name, { mode: 'read', value: 'early' }),
      )
      const host: AgentRunnerHookHost = {
        run: async () => decision(),
        ...(provesNoMatch ? { mayMatch: () => false } : {}),
      }
      const runner = new AgentRunner({
        provider,
        model: 'fake',
        registry,
        systemPrompt: 'system',
        hooks: host,
        workspaceRoot: '/repo',
        streamingToolExecution: true,
      })
      const running = runner.stepAsync([{ role: 'user', content: 'read' }])
      await provider.enqueued
      await new Promise((resolve) => setTimeout(resolve, 5))
      const beforeRelease = tool.executions.length
      provider.release()
      await running
      return { beforeRelease, after: tool.executions.length }
    }

    expect(await scenario(false)).toEqual({ beforeRelease: 0, after: 1 })
    expect(await scenario(true)).toEqual({ beforeRelease: 1, after: 1 })
  })
})
