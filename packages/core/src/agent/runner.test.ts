/**
 * AgentRunner 回合状态机契约 (MIG-CORE-008/009)。
 * 移植 Python:
 *  - tests/unit/test_runner_state.py (turn-phase 序列、tool batch、结构化结果、error 结果、context_projection 发射)
 *  - tests/unit/test_control.py::test_runner_* (pause-on-ask、plan-mode wrap、ask-guard、plan-guard、answer-resume)
 * 注: ToolResultStore 相关断言（large tool result 替换、registered budget）依赖 ContextPipeline 升级，单列。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
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
    expect(toolResultEvent.artifacts).toEqual([{ path: 'memory/tool-results/large.txt', kind: 'text', bytes: 9, metadata: {} }])
    expect(completedEvent.summary).toBe('summary:large')
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

  it('default context pipeline supplies approved plan runtime context', async () => {
    const manager = new ControlManager(tmp('emperor-runner-plan-context-'))
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
