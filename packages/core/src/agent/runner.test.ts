/**
 * AgentRunner 回合状态机契约 (MIG-CORE-008/009)。
 * 移植 Python:
 *  - tests/unit/test_runner_state.py (turn-phase 序列、tool batch、结构化结果、error 结果、context_projection 发射)
 *  - tests/unit/test_control.py::test_runner_* (pause-on-ask、plan-mode wrap、ask-guard、plan-guard、answer-resume)
 * 注: ToolResultStore 相关断言（large tool result 替换、registered budget）依赖 ContextPipeline 升级，单列。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentRunner, type MemoryStoreLike } from './runner'
import { TurnPhase, TurnState } from './turn-state'
import { LLMProvider, type ChatArgs, type ChatStreamArgs, type LLMResponse, type ToolCallRequest } from '../providers/base'
import { Tool } from '../tools/base'
import { okResult, type ToolResult } from '../tools/base'
import { toolParamsSchema, S } from '../tools/schema'
import { ToolRegistry } from '../tools/registry'
import { ControlManager } from '../control/manager'
import { AskUserTool, ProposePlanTool } from '../control/tools'
import { TodoStore, UpdateTodos } from '../tools/builtin'

type Msg = Record<string, unknown>

function makeResponse(p: Partial<LLMResponse> & { content: string | null }): LLMResponse {
  return {
    content: p.content,
    toolCalls: p.toolCalls ?? [],
    finishReason: p.finishReason ?? 'stop',
    usage: p.usage ?? {},
    reasoningContent: p.reasoningContent ?? null,
    thinkingBlocks: p.thinkingBlocks ?? null,
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCallRequest {
  return { id, name, arguments: args }
}

function memoryDouble(): MemoryStoreLike & { cleared: boolean } {
  return {
    cleared: false,
    writeCheckpoint: () => undefined,
    clearCheckpoint() { this.cleared = true },
    readCheckpoint: () => null,
    appendHistory: () => undefined,
  }
}

class FakeProvider extends LLMProvider {
  responses: LLMResponse[]
  seenMessages: ChatArgs['messages'][] = []
  seenTools: string[][] = []
  constructor(responses: LLMResponse[]) {
    super({ defaultModel: 'fake' })
    this.responses = responses
  }
  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.seenMessages.push(args.messages)
    this.seenTools.push(((args.tools as Array<Record<string, unknown>>) ?? []).map((t) => String(t.name)))
    return this.responses.length ? this.responses.shift()! : makeResponse({ content: 'done' })
  }
}

class ContextOverflowOnceProvider extends LLMProvider {
  seenMessages: ChatArgs['messages'][] = []
  calls = 0
  constructor(private readonly mode: 'once' | 'always' = 'once') {
    super({ defaultModel: 'fake' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls++
    this.seenMessages.push(args.messages)
    if (this.mode === 'always' || this.calls === 1) {
      throw Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded' })
    }
    return makeResponse({ content: 'done', usage: { input: 80, output: 4 } })
  }
}

class FlakyProvider extends LLMProvider {
  seenMessages: ChatArgs['messages'][] = []
  calls = 0
  constructor(private readonly failuresBeforeSuccess: number, private readonly errorFactory: () => Error) {
    super({ defaultModel: 'fake' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls++
    this.seenMessages.push(args.messages)
    if (this.calls <= this.failuresBeforeSuccess) throw this.errorFactory()
    return makeResponse({ content: 'done', usage: { input: 90, output: 4 } })
  }
}

class StreamingToolDeltaProvider extends LLMProvider {
  constructor() {
    super({ defaultModel: 'fake' })
  }

  async chat(): Promise<LLMResponse> {
    return makeResponse({ content: 'unused' })
  }

  override async chatStream(args: ChatStreamArgs): Promise<LLMResponse> {
    const partial = '{"title":"迁移计划","summary":"迁移 TS"}'
    const full = JSON.stringify(streamingPlanArgs())
    await args.onToolCallDelta?.({ index: 0, id: 'call_plan', name: 'propose_plan', argumentsText: partial })
    await args.onToolCallDelta?.({ index: 0, id: 'call_plan', name: 'propose_plan', argumentsText: full })
    return makeResponse({
      content: '',
      toolCalls: [toolCall('call_plan', 'propose_plan', streamingPlanArgs())],
      finishReason: 'tool_calls',
    })
  }
}

function streamingPlanArgs(): Record<string, unknown> {
  return {
    title: '迁移计划',
    summary: '迁移 TS',
    plan_markdown: '# 计划\n\n## Steps\n- 改 UI\n- 跑测试',
    risk_level: 'medium',
    assumptions: ['保持现有 Electron-only 架构'],
    steps: [
      {
        id: 'step_1',
        title: '更新 Ask Plan UI',
        description: '调整 renderer 时间线与底部控制面板，保持 plan 卡片单一来源。',
        files: ['desktop/src/renderer/src/views/ChatView.vue'],
        commands: ['npm --prefix desktop run test'],
        acceptance: ['底部只显示决策面板，时间线保留单张计划卡'],
        risk: 'medium',
      },
    ],
  }
}

class EchoTool extends Tool {
  override name = 'echo'
  override description = 'Echo a value.'
  override parameters = toolParamsSchema({ value: S('value') }, ['value'])
  execute(args: Record<string, unknown>): string { return String(args.value) }
}

class SafeEchoTool extends Tool {
  override name = 'safe_echo'
  override description = 'Read-only concurrency-safe echo.'
  override parameters = toolParamsSchema({ value: S('value') }, ['value'])
  override readOnly = true
  override concurrencySafe = true
  execute(args: Record<string, unknown>): string { return String(args.value) }
}

class LatchEchoTool extends Tool {
  override name = 'latch_echo'
  override description = 'Read-only echo that signals when it starts.'
  override parameters = toolParamsSchema({ value: S('value') }, ['value'])
  override readOnly = true
  override concurrencySafe = true
  constructor(private readonly onStart: () => void) { super() }
  execute(args: Record<string, unknown>): string { this.onStart(); return String(args.value) }
}

class EarlyToolProvider extends LLMProvider {
  private streamCalls = 0
  constructor(private readonly toolCalls: ToolCallRequest[], private readonly gate: Promise<void>) {
    super({ defaultModel: 'fake' })
  }
  async chat(): Promise<LLMResponse> { return makeResponse({ content: 'done' }) }
  override async chatStream(args: ChatStreamArgs): Promise<LLMResponse> {
    this.streamCalls += 1
    if (this.streamCalls > 1) return makeResponse({ content: 'done' })
    for (const call of this.toolCalls) await args.onToolCallComplete?.(call)
    await this.gate
    return makeResponse({ content: '', toolCalls: this.toolCalls, finishReason: 'tool_calls' })
  }
}

class BudgetedEchoTool extends Tool {
  override name = 'budgeted_echo'
  override description = 'Echo with a small context budget.'
  override parameters = toolParamsSchema({}, [])
  override maxResultChars = 2000
  execute(): string { return '' }
}

class StructuredEchoTool extends Tool {
  override name = 'structured_echo'
  override description = 'Structured echo.'
  override parameters = toolParamsSchema({ value: S('value') }, ['value'])
  override readOnly = true
  execute(): string { return '' }
  override mapResult(_raw: string, ctx: { arguments: Record<string, unknown> }): ToolResult {
    const value = String(ctx.arguments.value)
    return {
      modelContent: `model:${value}`,
      displaySummary: `summary:${value}`,
      rawContent: `model:${value}`,
      artifacts: [{ path: `memory/tool-results/${value}.txt`, kind: 'text', bytes: 9, metadata: {} }],
      metadata: { source: 'runner-test' },
      isError: false,
    }
  }
}

class MediaArtifactTool extends Tool {
  override name = 'media_result'
  override description = 'Return an image artifact.'
  override parameters = toolParamsSchema({}, [])
  override readOnly = true
  execute(): string { return '' }
  override mapResult(): ToolResult {
    return {
      modelContent: 'image imported',
      displaySummary: 'image imported',
      rawContent: 'image imported',
      artifacts: [{
        path: '/Users/me/Desktop/screen.png',
        kind: 'media',
        bytes: 512,
        media: {
          id: 'media_2026-06_abcdef12',
          kind: 'image',
          mime: 'image/png',
          name: 'screen.png',
          relPath: 'memory/media/2026-06/abcdef12-screen.png',
          originalPath: '/Users/me/Desktop/screen.png',
        },
        metadata: {},
      }],
      metadata: {},
      isError: false,
    }
  }
}

class ErrorResultTool extends Tool {
  override name = 'error_result'
  override description = 'Return a structured tool error.'
  override parameters = toolParamsSchema({}, [])
  override readOnly = true
  execute(): string { return 'Error: blocked by policy' }
  override mapResult(raw: string): ToolResult {
    return { ...okResult(raw), isError: true }
  }
}

// ── test_runner_state.py (TurnState) ──

describe('TurnState (test_runner_state.py)', () => {
  it('transitions to runtime events', () => {
    const state = new TurnState({ turnId: 'turn_1' })
    state.startIteration()
    const event = state.transition(TurnPhase.MODEL_REQUEST, { detail: { history_length: 2 } })
    expect(event.toRuntimeEvent()).toEqual({
      event: 'turn_phase',
      phase: 'model_request',
      sequence: 1,
      iteration: 1,
      turn_id: 'turn_1',
      detail: { history_length: 2 },
    })
  })
})

// ── test_runner_state.py (AgentRunner) ──

describe('AgentRunner turn phases (test_runner_state.py)', () => {
  it('emits turn_phase sequence for final reply', async () => {
    const runner = new AgentRunner({ provider: new FakeProvider([makeResponse({ content: 'done' })]), model: 'fake', registry: new ToolRegistry(), systemPrompt: 'system' })
    const emitted: Msg[] = []
    const reply = await runner.stepAsync([{ role: 'user', content: 'hi' }], { emit: (e) => { emitted.push(e) }, turnId: 'turn_1' })
    expect(reply).toBe('done')
    const phases = emitted.filter((e) => e.event === 'turn_phase')
    expect(phases.map((e) => e.phase)).toEqual(['started', 'model_request', 'model_response', 'compact_check', 'completed'])
    expect(phases.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(phases.every((e) => e.turn_id === 'turn_1')).toBe(true)
  })

  it('records compaction failure as degraded runtime state without failing a completed reply', async () => {
    const emitted: Msg[] = []
    const memory = memoryDouble()
    const runner = new AgentRunner({
      provider: new FakeProvider([makeResponse({ content: 'done' })]),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      memoryStore: memory,
      tokenTracker: {
        record: () => undefined,
        shouldCompact: () => true,
      },
      compactor: {
        compactAsync: async () => {
          throw new Error('compact failed')
        },
      },
      maxContext: 100,
    })

    const reply = await runner.stepAsync([{ role: 'user', content: 'hi' }], { emit: (event) => { emitted.push(event) }, turnId: 'turn_compact_fail' })

    expect(reply).toBe('done')
    expect(memory.cleared).toBe(true)
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'record_degraded',
        kind: 'memory_compaction',
        taskId: 'turn_compact_fail',
      }),
      expect.objectContaining({ event: 'turn_phase', phase: 'completed' }),
    ]))
  })

  it('reserves output headroom when checking compaction threshold', async () => {
    const seenMaxContext: number[] = []
    const runner = new AgentRunner({
      provider: new FakeProvider([makeResponse({ content: 'done' })]),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      tokenTracker: {
        record: () => undefined,
        shouldCompact: (maxContext: number) => {
          seenMaxContext.push(maxContext)
          return false
        },
      },
      compactor: { compactAsync: async (history) => history },
      maxContext: 10_000,
      maxTokens: 2_000,
    })

    await runner.stepAsync([{ role: 'user', content: 'hi' }])

    // 有效上限 = maxContext 10_000 − 预留输出 maxTokens 2_000
    expect(seenMaxContext[0]).toBe(8_000)
  })

  it('keeps at least half the context window when output reserve is oversized', async () => {
    const seenMaxContext: number[] = []
    const runner = new AgentRunner({
      provider: new FakeProvider([makeResponse({ content: 'done' })]),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      tokenTracker: {
        record: () => undefined,
        shouldCompact: (maxContext: number) => {
          seenMaxContext.push(maxContext)
          return false
        },
      },
      compactor: { compactAsync: async (history) => history },
      maxContext: 8_000,
      maxTokens: 20_000,
    })

    await runner.stepAsync([{ role: 'user', content: 'hi' }])

    expect(seenMaxContext[0]).toBe(4_000)
  })

  it('emits context usage with the active route context window', async () => {
    const runner = new AgentRunner({
      provider: new FakeProvider([makeResponse({ content: 'done', usage: { input: 120, output: 3 } })]),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      maxContext: 1_000,
    })
    const emitted: Msg[] = []

    await runner.stepAsync([{ role: 'user', content: 'hi' }], { emit: (event) => { emitted.push(event) } })

    expect(emitted.find((event) => event.event === 'context_usage')).toMatchObject({
      used: 120,
      max: 1_000,
      threshold: 700,
    })
  })

  it('recovers once from provider context overflow with emergency projection shrink', async () => {
    const provider = new ContextOverflowOnceProvider('once')
    const runner = new AgentRunner({ provider, model: 'fake', registry: new ToolRegistry(), systemPrompt: 'system' })
    const emitted: Msg[] = []
    const history: Msg[] = [{ role: 'user', content: 'overflow '.repeat(3000) }]

    const reply = await runner.stepAsync(history, { emit: (event) => { emitted.push(event) } })

    const firstUser = provider.seenMessages[0]!.find((message) => message.role === 'user')!
    const secondUser = provider.seenMessages[1]!.find((message) => message.role === 'user')!
    const projectionReports = emitted.filter((event) => event.event === 'context_projection').map((event) => event.report as Record<string, unknown>)

    expect(reply).toBe('done')
    expect(provider.calls).toBe(2)
    expect(String(firstUser.content).length).toBeGreaterThan(20_000)
    expect(String(secondUser.content)).toContain('[local_microcompact]')
    expect(String(secondUser.content).length).toBeLessThan(String(firstUser.content).length)
    expect(projectionReports[1]).toMatchObject({ context_overflow_retry: 1, emergency_context_shrink: 1 })
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'record_degraded', kind: 'context_overflow' }),
    ]))
    expect(history.filter((message) => message.role === 'assistant')).toHaveLength(1)
  })

  it('returns a domain context_overflow error after the emergency retry also overflows', async () => {
    const provider = new ContextOverflowOnceProvider('always')
    const runner = new AgentRunner({ provider, model: 'fake', registry: new ToolRegistry(), systemPrompt: 'system' })
    const history: Msg[] = [{ role: 'user', content: 'overflow '.repeat(3000) }]

    await expect(runner.stepAsync(history)).rejects.toMatchObject({
      code: 'context_overflow',
    })

    expect(provider.calls).toBe(2)
    expect(history.filter((message) => message.role === 'assistant')).toHaveLength(0)
  })

  it('retries retryable provider errors before succeeding', async () => {
    const provider = new FlakyProvider(2, () => Object.assign(new Error('temporarily unavailable'), { status: 503 }))
    const runner = new AgentRunner({ provider, model: 'fake', registry: new ToolRegistry(), systemPrompt: 'system' })
    const emitted: Msg[] = []

    const reply = await runner.stepAsync([{ role: 'user', content: 'hi' }], { emit: (event) => { emitted.push(event) } })

    expect(reply).toBe('done')
    expect(provider.calls).toBe(3)
    expect(emitted.filter((event) => event.event === 'model_provider_retry')).toHaveLength(2)
    expect(emitted.find((event) => event.event === 'context_usage')).toMatchObject({ provider_retry_count: 2 })
  })

  it('does not retry non-retryable auth provider errors', async () => {
    const provider = new FlakyProvider(1, () => Object.assign(new Error('invalid api key'), { status: 401, code: 'invalid_api_key' }))
    const runner = new AgentRunner({ provider, model: 'fake', registry: new ToolRegistry(), systemPrompt: 'system' })

    await expect(runner.stepAsync([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ status: 401 })

    expect(provider.calls).toBe(1)
  })

  it('degrades to a configured fallback provider without mutating the main route', async () => {
    const primary = new FlakyProvider(3, () => Object.assign(new Error('temporarily unavailable'), { status: 503 }))
    const fallback = new FakeProvider([makeResponse({ content: 'fallback done', usage: { input: 70, output: 5 } })])
    const runner = new AgentRunner({
      provider: primary,
      model: 'main-model',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      fallbackProvider: fallback,
      fallbackModel: 'fallback-model',
      fallbackProviderName: 'fallback-provider',
      usageType: 'scheduler',
    })
    const emitted: Msg[] = []

    const reply = await runner.stepAsync([{ role: 'user', content: 'hi' }], { emit: (event) => { emitted.push(event) } })

    expect(reply).toBe('fallback done')
    expect(primary.calls).toBe(3)
    expect(fallback.seenMessages).toHaveLength(1)
    expect(runner.model).toBe('main-model')
    expect(runner.provider).toBe(primary)
    expect(emitted.find((event) => event.event === 'model_route_fallback')).toMatchObject({
      from_model: 'main-model',
      to_model: 'fallback-model',
      usage_type: 'scheduler',
    })
    expect(emitted.find((event) => event.event === 'context_usage')).toMatchObject({
      model: 'fallback-model',
      provider_retry_count: 2,
      used_fallback: true,
    })
  })

  it('writes a redacted prompt snapshot for each turn', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'emperor-prompt-snapshot-'))
    const runner = new AgentRunner({
      provider: new FakeProvider([makeResponse({ content: 'done' })]),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'secret bootstrap',
      promptSections: [
        { name: 'bootstrap', content: 'secret bootstrap', source: 'templates/SOUL.md', priority: 100, budgetChars: null, version: 'test' },
      ],
      promptSnapshotDir: snapshotDir,
      sessionId: 'session_1',
    })

    await runner.stepAsync([{ role: 'user', content: 'hi' }], { turnId: 'turn_prompt' })

    const snapshotPath = join(snapshotDir, 'turn_prompt.json')
    expect(existsSync(snapshotPath)).toBe(true)
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
    expect(snapshot).toMatchObject({ sessionId: 'session_1', turnId: 'turn_prompt', model: 'fake' })
    expect(snapshot.sections[0]).toMatchObject({
      name: 'bootstrap',
      source: 'templates/SOUL.md',
      charCount: 'secret bootstrap'.length,
      redacted: true,
    })
    expect(snapshot.sections[0].hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(snapshot)).not.toContain('secret bootstrap')
  })

  it('streaming tool execution produces the same final reply and tool messages as batch (Wave5 golden)', async () => {
    async function runTurn(streaming: boolean): Promise<{ reply: string; toolContents: string[] }> {
      const registry = new ToolRegistry()
      registry.register(new SafeEchoTool())
      const runner = new AgentRunner({
        provider: new FakeProvider([
          makeResponse({ content: '', toolCalls: [toolCall('call_1', 'safe_echo', { value: 'a' }), toolCall('call_2', 'safe_echo', { value: 'b' })], finishReason: 'tool_calls' }),
          makeResponse({ content: 'done' }),
        ]),
        model: 'fake',
        registry,
        systemPrompt: 'system',
        streamingToolExecution: streaming,
      })
      const history: Msg[] = [{ role: 'user', content: 'hi' }]
      const reply = await runner.stepAsync(history)
      const toolContents = history.filter((m) => m.role === 'tool').map((m) => String(m.content))
      return { reply, toolContents }
    }
    const batch = await runTurn(false)
    const streamed = await runTurn(true)
    expect(streamed.reply).toBe(batch.reply)
    expect(streamed.toolContents).toEqual(batch.toolContents)
    expect(streamed.toolContents).toEqual(['a', 'b'])
  })

  it('streaming tool execution starts a read-only tool before the model call resolves (Wave5)', async () => {
    const registry = new ToolRegistry()
    let started = false
    registry.register(new LatchEchoTool(() => { started = true }))
    let resolveModel: (() => void) | null = null
    const provider = new EarlyToolProvider(
      [toolCall('call_1', 'latch_echo', { value: 'x' })],
      new Promise<void>((resolve) => { resolveModel = resolve }),
    )
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      streamingToolExecution: true,
    })
    const turn = runner.stepAsync([{ role: 'user', content: 'hi' }])
    // 让 onToolCallComplete 触发的早启动有机会跑起来（模型调用尚未 resolve）
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(started).toBe(true)
    resolveModel!()
    await turn
  })

  it('emits tool batch phases', async () => {
    const registry = new ToolRegistry()
    registry.register(new EchoTool())
    const runner = new AgentRunner({
      provider: new FakeProvider([
        makeResponse({ content: '', toolCalls: [toolCall('call_1', 'echo', { value: 'ok' })], finishReason: 'tool_calls' }),
        makeResponse({ content: 'done' }),
      ]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []
    const reply = await runner.stepAsync([{ role: 'user', content: 'hi' }], { emit: (e) => { emitted.push(e) } })
    expect(reply).toBe('done')
    const phases = emitted.filter((e) => e.event === 'turn_phase')
    expect(phases.map((e) => e.phase)).toContain('tool_batch_start')
    expect(phases.map((e) => e.phase)).toContain('tool_batch_done')
    expect(phases.filter((e) => e.phase === 'model_request').map((e) => e.iteration)).toEqual([1, 2])
  })

  it('emits audit thoughts before and after tool batches', async () => {
    const registry = new ToolRegistry()
    registry.register(new EchoTool())
    registry.register(new ErrorResultTool())
    registry.register(new MediaArtifactTool())
    const runner = new AgentRunner({
      provider: new FakeProvider([
        makeResponse({
          content: '',
          toolCalls: [
            toolCall('call_1', 'echo', { value: 'ok' }),
            toolCall('call_2', 'error_result', {}),
            toolCall('call_3', 'media_result', {}),
          ],
          finishReason: 'tool_calls',
        }),
        makeResponse({ content: 'handled' }),
      ]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []

    await runner.stepAsync([{ role: 'user', content: 'hi' }], { emit: (e) => { emitted.push(e) }, turnId: 'turn_audit' })

    const intentIndex = emitted.findIndex((e) => e.event === 'agent_thought' && e.stage === 'tool_intent')
    const firstToolIndex = emitted.findIndex((e) => e.event === 'tool_call')
    const resultSummaryIndex = emitted.findIndex((e) => e.event === 'agent_thought' && e.stage === 'tool_result_summary')
    const lastToolResultIndex = emitted.reduce((last, event, index) => event.event === 'tool_result' ? index : last, -1)

    expect(intentIndex).toBeGreaterThanOrEqual(0)
    expect(intentIndex).toBeLessThan(firstToolIndex)
    expect(resultSummaryIndex).toBeGreaterThan(lastToolResultIndex)
    expect(emitted[intentIndex]).toMatchObject({
      event: 'agent_thought',
      label: '思考参考',
      source: 'audit',
      status: 'done',
      tool_call_ids: ['call_1', 'call_2', 'call_3'],
      tool_names: ['echo', 'error_result', 'media_result'],
    })
    expect(String(emitted[intentIndex]!.summary)).toContain('准备调用')
    expect(String(emitted[intentIndex]!.summary)).toContain('echo')
    expect(String(emitted[resultSummaryIndex]!.summary)).not.toContain('echo 成功')
    expect(String(emitted[resultSummaryIndex]!.summary)).toContain('error_result 失败')
    expect(String(emitted[resultSummaryIndex]!.summary)).toContain('media_result 成功，识别到 1 个图片 artifact')
    expect(emitted[resultSummaryIndex]).toMatchObject({
      source: 'audit',
      status: 'done',
      tool_call_ids: ['call_1', 'call_2', 'call_3'],
      tool_names: ['echo', 'error_result', 'media_result'],
    })
  })

  it('does not emit visible result audit summaries for plain successful tools', async () => {
    const registry = new ToolRegistry()
    registry.register(new EchoTool())
    const runner = new AgentRunner({
      provider: new FakeProvider([
        makeResponse({
          content: '',
          toolCalls: [
            toolCall('call_1', 'echo', { value: 'ok' }),
          ],
          finishReason: 'tool_calls',
        }),
        makeResponse({ content: 'handled' }),
      ]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []

    await runner.stepAsync([{ role: 'user', content: 'hi' }], { emit: (e) => { emitted.push(e) }, turnId: 'turn_success_audit' })

    expect(emitted.some((e) => e.event === 'agent_thought' && e.stage === 'tool_result_summary')).toBe(false)
  })

  it('does not emit audit thoughts for plain replies without tools', async () => {
    const runner = new AgentRunner({
      provider: new FakeProvider([makeResponse({ content: 'done' })]),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []

    await runner.stepAsync([{ role: 'user', content: 'hi' }], { emit: (e) => { emitted.push(e) }, turnId: 'turn_plain' })

    expect(emitted.some((e) => e.event === 'agent_thought')).toBe(false)
  })

  it('uses structured tool result for history + runtime summary', async () => {
    const registry = new ToolRegistry()
    registry.register(new StructuredEchoTool())
    const runner = new AgentRunner({
      provider: new FakeProvider([
        makeResponse({ content: '', toolCalls: [toolCall('call_1', 'structured_echo', { value: 'large' })], finishReason: 'tool_calls' }),
        makeResponse({ content: 'done' }),
      ]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const history: Msg[] = [{ role: 'user', content: 'hi' }]
    const emitted: Msg[] = []
    await runner.stepAsync(history, { emit: (e) => { emitted.push(e) } })
    const toolMessage = history.find((m) => m.role === 'tool')!
    const toolResultEvent = emitted.find((e) => e.event === 'tool_result')!
    const completedEvent = emitted.find((e) => e.event === 'tool_run_completed')!
    expect(toolMessage.content).toBe('model:large')
    expect(toolResultEvent.summary).toBe('summary:large')
    expect(toolResultEvent.output).toBe('model:large')
    expect(toolResultEvent.artifacts).toEqual([{ path: 'memory/tool-results/large.txt', kind: 'text', bytes: 9, metadata: {} }])
    expect(completedEvent.summary).toBe('summary:large')
    expect(completedEvent.output).toBe('model:large')
    expect(completedEvent.metadata).toEqual({ source: 'runner-test' })
  })

  it('emits error tool result and failed run event', async () => {
    const registry = new ToolRegistry()
    registry.register(new ErrorResultTool())
    const runner = new AgentRunner({
      provider: new FakeProvider([
        makeResponse({ content: '', toolCalls: [toolCall('call_1', 'error_result', {})], finishReason: 'tool_calls' }),
        makeResponse({ content: 'handled' }),
      ]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []
    await runner.stepAsync([{ role: 'user', content: 'hi' }], { emit: (e) => { emitted.push(e) } })
    const toolResultEvent = emitted.find((e) => e.event === 'tool_result')!
    const failedEvent = emitted.find((e) => e.event === 'tool_run_failed')!
    expect(toolResultEvent.id).toBe('call_1')
    expect(toolResultEvent.is_error).toBe(true)
    expect(String(toolResultEvent.summary)).toContain('blocked by policy')
    expect(String(toolResultEvent.output)).toContain('blocked by policy')
    expect(failedEvent.id).toBe('call_1')
    expect(String(failedEvent.message)).toContain('blocked by policy')
  })

  it('emits context projection (paired missing tool result)', async () => {
    const provider = new FakeProvider([makeResponse({ content: 'done' })])
    const runner = new AgentRunner({ provider, model: 'fake', registry: new ToolRegistry(), systemPrompt: 'system' })
    const emitted: Msg[] = []
    await runner.stepAsync(
      [
        { role: 'user', content: 'inspect' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      ],
      { emit: (e) => { emitted.push(e) } },
    )
    const contextEvents = emitted.filter((e) => e.event === 'context_projection')
    expect((contextEvents[0]!.report as Record<string, unknown>).paired_missing_tool_results).toBe(1)
    expect(contextEvents[0]!.message_count).toBe(3)
    const lastSeen = provider.seenMessages[0]!
    expect((lastSeen[lastSeen.length - 1] as Record<string, unknown>).tool_call_id).toBe('call_1')
  })

  it('default context pipeline replaces large tool results using registered tool budgets', async () => {
    const root = tmp('emperor-runner-tool-result-')
    const content = 'x'.repeat(3000)
    const memory = new MemoryFake() as MemoryFake & { memoryDir: string }
    memory.memoryDir = join(root, 'memory')
    const provider = new FakeProvider([makeResponse({ content: 'done' })])
    const registry = new ToolRegistry()
    registry.register(new BudgetedEchoTool())
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system', memoryStore: memory })
    const emitted: Msg[] = []

    await runner.stepAsync(
      [
        { role: 'user', content: 'inspect' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'budgeted_echo', arguments: '{}' } }] },
        { role: 'tool', turn_id: 'turn_1', tool_call_id: 'call_1', name: 'budgeted_echo', content },
      ],
      { emit: (e) => { emitted.push(e) } },
    )

    const contextEvent = emitted.find((e) => e.event === 'context_projection')!
    const report = contextEvent.report as Record<string, unknown>
    const replacement = (report.tool_result_replacements as Array<Record<string, unknown>>)[0]!
    const projectedTool = provider.seenMessages[0]!.at(-1) as Record<string, unknown>

    expect(replacement.tool_name).toBe('budgeted_echo')
    expect(String(projectedTool.content)).toContain('original_chars: 3000')
    expect(readFileSync(join(root, String(replacement.artifact_path)), 'utf8')).toBe(content)
  })

  it('default context pipeline reports aggregate tool result replacements', async () => {
    const root = tmp('emperor-runner-aggregate-tool-result-')
    const memory = new MemoryFake() as MemoryFake & { memoryDir: string }
    memory.memoryDir = join(root, 'memory')
    const provider = new FakeProvider([makeResponse({ content: 'done', usage: { input: 100, output: 4 } })])
    const runner = new AgentRunner({ provider, model: 'fake', registry: new ToolRegistry(), systemPrompt: 'system', memoryStore: memory })
    const emitted: Msg[] = []
    const toolCalls = Array.from({ length: 10 }, (_, index) => ({
      id: `call_${index + 1}`,
      type: 'function',
      function: { name: 'grep', arguments: '{}' },
    }))
    const toolMessages = toolCalls.map((call, index) => ({
      role: 'tool',
      turn_id: 'turn_aggregate',
      tool_call_id: call.id,
      name: 'grep',
      content: String.fromCharCode(97 + index).repeat(3000),
    }))

    await runner.stepAsync(
      [
        { role: 'user', content: 'inspect many results' },
        { role: 'assistant', content: '', tool_calls: toolCalls },
        ...toolMessages,
      ],
      { emit: (event) => { emitted.push(event) } },
    )

    const contextEvent = emitted.find((event) => event.event === 'context_projection')!
    const usageEvent = emitted.find((event) => event.event === 'context_usage')!
    const report = contextEvent.report as Record<string, unknown>
    const aggregateRecords = report.aggregate_tool_result_replacements as Array<Record<string, unknown>>
    const projectedTools = provider.seenMessages[0]!.filter((message) => message.role === 'tool')

    expect(report.aggregate_replaced_tool_results).toBeGreaterThan(0)
    expect(report.replaced_tool_results).toBe(aggregateRecords.length)
    expect(usageEvent).toMatchObject({
      replaced_tool_results: aggregateRecords.length,
      aggregate_replaced_tool_results: aggregateRecords.length,
      aggregate_tool_result_budget: 24_000,
    })
    expect(String(projectedTools[0]!.content)).toContain('Tool result stored outside the model context')
    expect(String(projectedTools.at(-1)!.content)).toBe(String(toolMessages.at(-1)!.content))
    expect(readFileSync(join(root, String(aggregateRecords[0]!.artifact_path)), 'utf8')).toBe(toolMessages[0]!.content)
  })

  it('default context pipeline supplies approved plan runtime context', async () => {
    const manager = new ControlManager(tmp('emperor-runner-plan-context-'))
    manager.setRuntimeScope({ sessionId: 'session_plan', projectId: 'project_plan', workspaceRoot: '/tmp/plan-project' })
    const interaction = manager.createPlan({
      title: 'Continue approved plan',
      summary: 'Keep executing the active step.',
      planMarkdown: '# Plan\n\n- Continue approved plan',
      assumptions: [],
      riskLevel: 'low',
      steps: [{
        id: 'step_1',
        title: 'Continue approved plan',
        description: 'Run the next implementation step.',
        acceptance: ['model receives plan runtime context'],
        verification: [{ id: 'manual_context', kind: 'manual', required: false }],
      }],
    })
    manager.approve(interaction.id)
    const provider = new FakeProvider([makeResponse({ content: 'done' })])
    const runner = new AgentRunner({ provider, model: 'fake', registry: new ToolRegistry(), systemPrompt: 'system', controlManager: manager, maxTurns: 1 })

    await runner.stepAsync([{ role: 'user', content: 'continue approved plan' }])

    const contents = provider.seenMessages[0]!.map((message) => String(message.content ?? ''))
    const planContext = contents.find((content) => content.includes('[PLAN_RUNTIME_CONTEXT]')) ?? ''
    expect(planContext).toContain('plan_id:')
    expect(planContext).toContain('status: approved')
  })

  it('update_todos completion projects into plan steps without evidence gating (2026-07-05 B1)', async () => {
    const manager = new ControlManager(tmp('emperor-runner-todo-decoupled-'))
    const todoStore = new TodoStore()
    manager.setTodoStore(todoStore)
    const interaction = manager.createPlan({
      title: 'Decoupled todo plan',
      summary: 'Plan is approval context, todo is execution checklist.',
      planMarkdown: '# Plan\n\n- Run matrix',
      assumptions: [],
      riskLevel: 'low',
      steps: [{
        id: 'step_1',
        title: 'Run matrix',
        description: 'Execute the task.',
        commands: ['npm test'],
        acceptance: ['todo update succeeds without plan evidence'],
      }],
    })
    manager.approve(interaction.id)
    const planId = String(interaction.meta.plan_id)
    expect(manager.planStore.get(planId)!.steps[0]!.status).toBe('active')

    const registry = new ToolRegistry()
    registry.register(new UpdateTodos(todoStore))
    const provider = new FakeProvider([
      makeResponse({
        content: '',
        toolCalls: [toolCall('todo_1', 'update_todos', {
          todos: [{ id: 1, plan_step_id: 'step_1', content: 'Run matrix', status: 'completed' }],
        })],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: 'done' }),
    ])
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system', controlManager: manager, todoStore, maxTurns: 4 })
    const emitted: Msg[] = []

    const reply = await runner.stepAsync([{ role: 'user', content: 'continue' }], { emit: (event) => { emitted.push(event) } })

    expect(reply).toBe('done')
    const todoResult = emitted.find((event) => event.event === 'tool_result' && event.name === 'update_todos')
    expect(todoResult).toMatchObject({
      event: 'tool_result',
      name: 'update_todos',
      todos: [{ id: 1, plan_step_id: 'step_1', content: 'Run matrix', status: 'completed' }],
    })
    expect(JSON.stringify(todoResult)).not.toContain('PLAN_EVIDENCE_REQUIRED')
    // B1：todo 完成投影进计划步骤并收口计划（投影 ≠ 证据闸门，闸门保持解耦）
    const finished = manager.planStore.get(planId)!
    expect(finished.steps[0]!.status).toBe('done')
    expect(finished.status).toBe('completed')
    expect(finished.completedAt).not.toBeNull()
    expect(finished.steps[0]!.evidence.at(-1)).toMatchObject({ source: 'update_todos', tool_call_id: 'todo_1' })
  })

  it('escalates a strategy nudge when the same safety refusal repeats within a turn', async () => {
    class DeniedTool extends Tool {
      override name = 'deny_echo'
      override description = 'always refused by safety policy'
      override parameters = toolParamsSchema({}, [])
      async execute(): Promise<string> {
        return 'Error: command refused by safety policy (matches dangerous pattern: /\\bpython3?\\s+-c\\b/)'
      }
    }
    const registry = new ToolRegistry()
    registry.register(new DeniedTool())
    const provider = new FakeProvider([
      makeResponse({ content: '', toolCalls: [toolCall('deny_1', 'deny_echo', {})], finishReason: 'tool_calls' }),
      makeResponse({ content: '', toolCalls: [toolCall('deny_2', 'deny_echo', {})], finishReason: 'tool_calls' }),
      makeResponse({ content: 'done' }),
    ])
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system' })
    const history: Msg[] = [{ role: 'user', content: 'run it' }]

    await runner.stepAsync(history)

    const toolMessages = history.filter((message) => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(String(toolMessages[0]!.content)).not.toContain('已被拒绝')
    expect(String(toolMessages[1]!.content)).toContain('已被拒绝 2 次')
    expect(String(toolMessages[1]!.content)).toContain('改变策略')
  })

  it('escalates the nudge even when the model switches to a different denied pattern (2026-07-05 B4.1)', async () => {
    class NodeDeniedTool extends Tool {
      override name = 'deny_node'
      override description = 'refused: node -e'
      override parameters = toolParamsSchema({}, [])
      async execute(): Promise<string> {
        return 'Error: command refused by safety policy (matches dangerous pattern: /\\bnode\\s+-e\\b/)'
      }
    }
    class PythonDeniedTool extends Tool {
      override name = 'deny_python'
      override description = 'refused: python3 -c'
      override parameters = toolParamsSchema({}, [])
      async execute(): Promise<string> {
        return 'Error: command refused by safety policy (matches dangerous pattern: /\\bpython3?\\s+-c\\b/)'
      }
    }
    const registry = new ToolRegistry()
    registry.register(new NodeDeniedTool())
    registry.register(new PythonDeniedTool())
    const provider = new FakeProvider([
      makeResponse({ content: '', toolCalls: [toolCall('deny_1', 'deny_node', {})], finishReason: 'tool_calls' }),
      makeResponse({ content: '', toolCalls: [toolCall('deny_2', 'deny_python', {})], finishReason: 'tool_calls' }),
      makeResponse({ content: 'done' }),
    ])
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system' })
    const history: Msg[] = [{ role: 'user', content: 'run it' }]

    await runner.stepAsync(history)

    const toolMessages = history.filter((message) => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(String(toolMessages[0]!.content)).not.toContain('已被拒绝')
    // 换解释器重试同类行为同样计数——per-pattern 计数会被换马甲绕过
    expect(String(toolMessages[1]!.content)).toContain('已被拒绝 2 次')
    expect(String(toolMessages[1]!.content)).toContain('改变策略')
  })

  it('marks safety refusals with reason_kind on tool_run_failed events (2026-07-05 B4.3)', async () => {
    class DeniedTool2 extends Tool {
      override name = 'deny_cmd'
      override description = 'refused by safety policy'
      override parameters = toolParamsSchema({}, [])
      async execute(): Promise<string> {
        return 'Error: command refused by safety policy (matches dangerous pattern: /x/)'
      }
    }
    class BoomTool extends Tool {
      override name = 'boom'
      override description = 'plain failure'
      override parameters = toolParamsSchema({}, [])
      async execute(): Promise<string> { return 'Error: boom' }
    }
    const registry = new ToolRegistry()
    registry.register(new DeniedTool2())
    registry.register(new BoomTool())
    const provider = new FakeProvider([
      makeResponse({ content: '', toolCalls: [toolCall('c1', 'deny_cmd', {}), toolCall('c2', 'boom', {})], finishReason: 'tool_calls' }),
      makeResponse({ content: 'done' }),
    ])
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system' })
    const emitted: Msg[] = []

    await runner.stepAsync([{ role: 'user', content: 'go' }], { emit: (event) => { emitted.push(event) } })

    const failures = emitted.filter((event) => event.event === 'tool_run_failed')
    expect(failures).toHaveLength(2)
    const byName = Object.fromEntries(failures.map((event) => [event.name, event]))
    expect(byName.deny_cmd).toMatchObject({ reason_kind: 'safety_refusal' })
    expect(byName.boom).toMatchObject({ reason_kind: 'error' })
  })

  it('max_turns terminal reply is a structured delivery summary instead of the flat failure line', async () => {
    const todoStore = new TodoStore()
    todoStore.todos = [
      { id: 1, content: '实现功能', status: 'completed' },
      { id: 2, content: '补文档', status: 'pending' },
    ]
    const provider = new FakeProvider([makeResponse({ content: '第一轮进展：功能已实现。' })])
    const runner = new AgentRunner({ provider, model: 'fake', registry: new ToolRegistry(), systemPrompt: 'system', todoStore, maxTurns: 1 })

    const reply = await runner.stepAsync([{ role: 'user', content: '把事情办完' }])

    expect(reply).toContain('max_turns=1')
    expect(reply).toContain('已完成 1/2')
    expect(reply).toContain('补文档')
    expect(reply).toContain('恢复')
    expect(reply).not.toContain('未办妥')
  })

  it('injects a single wrap-up reminder when the turn budget is nearly exhausted', async () => {
    const todoStore = new TodoStore()
    todoStore.todos = [{ id: 1, content: '永远做不完', status: 'pending' }]
    const provider = new FakeProvider([
      makeResponse({ content: '继续 1' }),
      makeResponse({ content: '继续 2' }),
      makeResponse({ content: '继续 3' }),
      makeResponse({ content: '继续 4' }),
      makeResponse({ content: '继续 5' }),
    ])
    const runner = new AgentRunner({ provider, model: 'fake', registry: new ToolRegistry(), systemPrompt: 'system', todoStore, maxTurns: 5 })
    const history: Msg[] = [{ role: 'user', content: '一直干' }]

    await runner.stepAsync(history)

    const reminders = history.filter((message) => message.role === 'user' && String(message.content ?? '').includes('回合上限'))
    expect(reminders).toHaveLength(1)
    const lastCall = provider.seenMessages[provider.seenMessages.length - 1]!
    expect(lastCall.some((message) => String(message.content ?? '').includes('回合上限'))).toBe(true)
  })

  it('does not project runtime plan context from another project scope', async () => {
    const manager = new ControlManager(tmp('emperor-runner-cross-project-plan-context-'))
    manager.setRuntimeScope({ sessionId: 'session_old', projectId: 'project_old', workspaceRoot: '/tmp/old-project' })
    const interaction = manager.createPlan({
      title: 'Old project plan',
      summary: 'This plan belongs to another project.',
      planMarkdown: '# Plan\n\n- Continue old project',
      assumptions: [],
      riskLevel: 'low',
      steps: [{
        id: 'step_1',
        title: 'Continue old project',
        description: 'Should not appear in the new project context.',
        commands: ['echo old'],
        acceptance: ['old only'],
      }],
    })
    manager.approve(interaction.id)
    manager.setRuntimeScope({ sessionId: 'session_new', projectId: 'project_new', workspaceRoot: '/tmp/new-project' })
    const provider = new FakeProvider([makeResponse({ content: 'new project only' })])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      controlManager: manager,
      maxTurns: 1,
    })
    const emitted: Msg[] = []

    await runner.stepAsync([{ role: 'user', content: 'report files' }], { emit: (event) => { emitted.push(event) } })

    const contextEvent = emitted.find((event) => event.event === 'context_projection')!
    expect((contextEvent.report as Record<string, unknown>).plan_context_attached).toBe(0)
    const contents = provider.seenMessages[0]!.map((message) => String(message.content ?? ''))
    expect(contents.some((content) => content.includes('[PLAN_RUNTIME_CONTEXT]'))).toBe(false)
  })

  it('does not inject plan incomplete followups for active approved plan steps', async () => {
    const manager = new ControlManager(tmp('emperor-runner-plan-loop-'))
    const interaction = manager.createPlan({
      title: 'Stuck Plan',
      summary: 'Keep executing a step.',
      planMarkdown: '# Plan\n\n- Finish step',
      assumptions: [],
      riskLevel: 'low',
      steps: [{
        id: 'step_1',
        title: 'Finish step',
        description: 'This step remains active to exercise followup loop protection.',
        commands: ['echo verify'],
        acceptance: ['runner does not loop forever'],
      }],
    })
    manager.approve(interaction.id)
    const provider = new FakeProvider([
      makeResponse({ content: 'step already done' }),
      makeResponse({ content: 'still blocked by stale plan' }),
      makeResponse({ content: 'should not be called' }),
    ])
    const memory = new MemoryFake()
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      controlManager: manager,
      memoryStore: memory,
      maxTurns: 20,
    })
    const emitted: Msg[] = []

    const reply = await runner.stepAsync([{ role: 'user', content: 'continue' }], { emit: (event) => { emitted.push(event) }, turnId: 'turn_plan_loop' })

    expect(reply).toBe('step already done')
    expect(provider.seenMessages.length).toBe(1)
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'turn_phase', phase: 'completed' }),
    ]))
    expect(emitted.some((event) => event.event === 'turn_phase' && event.phase === 'plan_followup')).toBe(false)
    expect(emitted.some((event) => event.event === 'turn_phase' && event.phase === 'max_turns')).toBe(false)
    expect(memory.history.filter((item) => item.role === 'assistant')).toHaveLength(1)
    expect(memory.history.find((item) => item.role === 'assistant')!.content).toBe(reply)
  })
})

// ── test_control.py::test_runner_* (deferred from W05) ──

class MemoryFake implements MemoryStoreLike {
  checkpoint: Msg[] | null = null
  history: Array<{ role: string; content: string }> = []
  writeCheckpoint(history: Msg[]): void { this.checkpoint = [...history] }
  clearCheckpoint(): void { this.checkpoint = null }
  readCheckpoint(): Msg[] | null { return this.checkpoint }
  appendHistory(role: string, content: string): void { this.history.push({ role, content }) }
}

function tmp(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)) }

function makeQuestion(): Record<string, unknown> {
  return {
    id: 'scope',
    header: '范围',
    question: '本次范围怎么定？',
    options: [
      { label: '最小', description: '只做核心路径' },
      { label: '完整', description: '连同文档测试一起做' },
    ],
  }
}

function controlRegistry(manager: ControlManager): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(new AskUserTool(manager))
  registry.register(new ProposePlanTool(manager))
  return registry
}

describe('AgentRunner control integration (test_control.py::test_runner_*)', () => {
  it('pauses on ask and writes checkpoint', async () => {
    const manager = new ControlManager(tmp('emperor-runner-ask-'))
    const registry = controlRegistry(manager)
    const memory = new MemoryFake()
    const provider = new FakeProvider([
      makeResponse({ content: '', toolCalls: [toolCall('call_ask', 'ask_user', { questions: [makeQuestion()] })], finishReason: 'tool_calls' }),
    ])
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system', memoryStore: memory, controlManager: manager })
    const history: Msg[] = [{ role: 'user', content: 'do work' }]
    const emitted: Msg[] = []
    await expect(runner.stepAsync(history, { emit: (e) => { emitted.push(e) } })).rejects.toThrow()
    expect((manager.payload().pending as Record<string, unknown>).kind).toBe('ask')
    expect(memory.readCheckpoint()).not.toBeNull()
    expect(emitted.some((e) => e.event === 'ask_request')).toBe(true)
    expect(emitted.some((e) => e.event === 'turn_paused')).toBe(true)
    expect(history[history.length - 1]!.role).toBe('tool')
    expect(String(history[history.length - 1]!.content)).toContain('waiting for user')
  })

  it('plan mode wraps plain final as plan', async () => {
    const manager = new ControlManager(tmp('emperor-runner-plan-'))
    manager.setMode('plan')
    const registry = controlRegistry(manager)
    const provider = new FakeProvider([makeResponse({ content: '我会先读代码，然后实现并测试。' })])
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system', controlManager: manager })
    const emitted: Msg[] = []
    await expect(runner.stepAsync([{ role: 'user', content: '做一个计划' }], { emit: (e) => { emitted.push(e) } })).rejects.toThrow()
    expect((manager.payload().pending as Record<string, unknown>).kind).toBe('plan')
    expect(emitted.some((e) => e.event === 'plan_draft')).toBe(true)
    expect(emitted.some((e) => e.event === 'assistant_done')).toBe(false)
  })

  it('streams partial propose_plan arguments as plan_draft_delta events', async () => {
    const manager = new ControlManager(tmp('emperor-runner-plan-stream-'))
    manager.setMode('plan')
    const registry = controlRegistry(manager)
    const provider = new StreamingToolDeltaProvider()
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system', controlManager: manager })
    const emitted: Msg[] = []

    await expect(
      runner.stepAsync([{ role: 'user', content: '做一个计划' }], { emit: (e) => { emitted.push(e) }, turnId: 'turn-plan-stream' }),
    ).rejects.toThrow()

    const deltas = emitted.filter((event) => event.event === 'plan_draft_delta')
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.at(-1)).toMatchObject({
      event: 'plan_draft_delta',
      tool_call_id: 'call_plan',
      interaction: expect.objectContaining({
        id: 'provisional-plan-call_plan',
        kind: 'plan',
        status: 'waiting',
        title: '迁移计划',
        summary: '迁移 TS',
        plan_markdown: '# 计划\n\n## Steps\n- 改 UI\n- 跑测试',
      }),
    })
    expect(emitted.some((event) => event.event === 'plan_draft')).toBe(true)
  })

  it('ask guard pauses plain final for ambiguous task', async () => {
    const manager = new ControlManager(tmp('emperor-runner-askguard-'))
    const registry = controlRegistry(manager)
    const provider = new FakeProvider([makeResponse({ content: '我直接开始改。' })])
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system', controlManager: manager })
    const emitted: Msg[] = []
    await expect(
      runner.stepAsync([{ role: 'user', content: '阅读项目找到问题作出修改，不要打补丁，要工程化实现' }], { emit: (e) => { emitted.push(e) } }),
    ).rejects.toThrow()
    expect((manager.payload().pending as Record<string, unknown>).kind).toBe('ask')
    expect(emitted.some((e) => e.event === 'ask_request')).toBe(true)
  })

  it('plan guard blocks high-impact write before planning', async () => {
    const root = tmp('emperor-runner-planguard-')
    const manager = new ControlManager(root)
    const registry = new ToolRegistry()
    registry.register(new (class extends Tool {
      override name = 'write_file'
      override description = 'write'
      override parameters = toolParamsSchema({ path: S('p'), content: S('c') }, ['path', 'content'])
      override getPath(args: Record<string, unknown>): string { return String(args.path ?? '') }
      execute(): string { return 'wrote' }
    })())
    registry.register(new AskUserTool(manager))
    registry.register(new ProposePlanTool(manager))
    const provider = new FakeProvider([
      makeResponse({ content: '', toolCalls: [toolCall('call_write', 'write_file', { path: 'auth.py', content: 'new auth' })], finishReason: 'tool_calls' }),
      makeResponse({ content: '我需要先进入计划模式。' }),
    ])
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system', controlManager: manager })
    const history: Msg[] = [{ role: 'user', content: 'Redesign authentication architecture across modules' }]
    await runner.stepAsync(history)
    const toolMessage = history.find((m) => m.role === 'tool')!
    expect(String(toolMessage.content)).toContain('PLAN_GUARD_REQUIRED')
    expect(String(toolMessage.content)).toContain('request_plan_mode')
    expect(String(toolMessage.content)).toContain('readonly_scopes:')
    expect(String(toolMessage.content).toLowerCase()).toMatch(/auth|authentication/)
  })

  it('emits plan entry decision contract', async () => {
    const manager = new ControlManager(tmp('emperor-runner-decision-'))
    const registry = controlRegistry(manager)
    const provider = new FakeProvider([makeResponse({ content: '我会先说明需要计划。' })])
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system', controlManager: manager })
    const emitted: Msg[] = []
    await expect(
      runner.stepAsync([{ role: 'user', content: 'Add a dashboard feature with UI state management and tests' }], { emit: (e) => { emitted.push(e) } }),
    ).rejects.toThrow()
    const decisionEvent = emitted.find((e) => e.event === 'plan_entry_decision')!
    expect(decisionEvent.decision).toBe('recommended')
    expect(decisionEvent.triggers).toEqual(['feature', 'multi_step'])
    expect((decisionEvent.recommended_readonly_scopes as unknown[]).length).toBeGreaterThan(0)
    expect((decisionEvent.suggested_questions as unknown[]).length).toBeGreaterThan(0)
  })

  it('answer resume injects user message', async () => {
    const manager = new ControlManager(tmp('emperor-runner-resume-'))
    const interaction = manager.createAsk({ questions: [makeQuestion()] })
    const resume = manager.answer(interaction.id, { scope: { choice: '最小', freeform: '' } })
    const provider = new FakeProvider([makeResponse({ content: 'resumed' })])
    const registry = controlRegistry(manager)
    const history: Msg[] = [{ role: 'user', content: resume.message }]
    const runner = new AgentRunner({ provider, model: 'fake', registry, systemPrompt: 'system', controlManager: manager })
    expect(await runner.stepAsync(history)).toBe('resumed')
    const lastSeen = provider.seenMessages[provider.seenMessages.length - 1]!
    expect(lastSeen.some((m) => String((m as Record<string, unknown>).content).includes('ASK_ANSWERED'))).toBe(true)
  })
})
