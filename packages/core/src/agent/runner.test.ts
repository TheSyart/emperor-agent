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
import { ContextPipeline } from '../context/pipeline'
import { TurnPhase, TurnState } from './turn-state'
import {
  LLMProvider,
  type ChatArgs,
  type ChatStreamArgs,
  type LLMResponse,
  type ToolCallRequest,
} from '../providers/base'
import { Tool, type ToolExecutionContext } from '../tools/base'
import { okResult, type ToolResult } from '../tools/base'
import { toolParamsSchema, S } from '../tools/schema'
import { ToolRegistry } from '../tools/registry'
import { ControlManager } from '../control/manager'
import { AskUserTool, ProposePlanTool } from '../control/tools'
import { TodoStore, UpdateTodos } from '../tools/builtin'
import { MemoryStore } from '../memory/store'
import { ExecutionEnvironment } from '../environment/snapshot'
import { CancelledTaskError } from '../runtime/active'
import { PlanGenerationFailedError } from '../control/exceptions'

type Msg = Record<string, unknown>

function makeResponse(
  p: Partial<LLMResponse> & { content: string | null },
): LLMResponse {
  return {
    content: p.content,
    toolCalls: p.toolCalls ?? [],
    finishReason: p.finishReason ?? 'stop',
    usage: p.usage ?? {},
    reasoningContent: p.reasoningContent ?? null,
    thinkingBlocks: p.thinkingBlocks ?? null,
  }
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolCallRequest {
  return { id, name, arguments: args }
}

function memoryDouble(): MemoryStoreLike & {
  cleared: boolean
  appended: Array<{ role: string; content: string }>
} {
  return {
    cleared: false,
    appended: [],
    writeCheckpoint: () => undefined,
    clearCheckpoint() {
      this.cleared = true
    },
    readCheckpoint: () => null,
    appendHistory(role: string, content: string) {
      this.appended.push({ role, content })
    },
  }
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
    this.seenTools.push(
      ((args.tools as Array<Record<string, unknown>>) ?? []).map((t) =>
        String(t.name),
      ),
    )
    return this.responses.length
      ? this.responses.shift()!
      : makeResponse({ content: 'done' })
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
      throw Object.assign(new Error('maximum context length exceeded'), {
        code: 'context_length_exceeded',
      })
    }
    return makeResponse({ content: 'done', usage: { input: 80, output: 4 } })
  }
}

class FlakyProvider extends LLMProvider {
  seenMessages: ChatArgs['messages'][] = []
  calls = 0
  constructor(
    private readonly failuresBeforeSuccess: number,
    private readonly errorFactory: () => Error,
  ) {
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
    await args.onToolCallDelta?.({
      index: 0,
      id: 'call_plan',
      name: 'propose_plan',
      argumentsText: partial,
    })
    await args.onToolCallDelta?.({
      index: 0,
      id: 'call_plan',
      name: 'propose_plan',
      argumentsText: full,
    })
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
        description:
          '调整 renderer 时间线与底部控制面板，保持 plan 卡片单一来源。',
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
  execute(args: Record<string, unknown>): string {
    return String(args.value)
  }
}

class SafeEchoTool extends Tool {
  override name = 'safe_echo'
  override description = 'Read-only concurrency-safe echo.'
  override parameters = toolParamsSchema({ value: S('value') }, ['value'])
  override readOnly = true
  override concurrencySafe = true
  execute(args: Record<string, unknown>): string {
    return String(args.value)
  }
}

class SnapshotContextTool extends Tool {
  override name = 'snapshot_context'
  override description = 'Return the execution environment revision.'
  override parameters = toolParamsSchema({}, [])
  override readOnly = true
  override concurrencySafe = true
  readonly revisions: string[] = []
  execute(
    _args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): string {
    const revision = context?.executionEnvironment?.revision ?? 'missing'
    this.revisions.push(revision)
    return revision
  }
}

class LatchEchoTool extends Tool {
  override name = 'latch_echo'
  override description = 'Read-only echo that signals when it starts.'
  override parameters = toolParamsSchema({ value: S('value') }, ['value'])
  override readOnly = true
  override concurrencySafe = true
  constructor(private readonly onStart: () => void) {
    super()
  }
  execute(args: Record<string, unknown>): string {
    this.onStart()
    return String(args.value)
  }
}

class AbortAwareStreamingTool extends Tool {
  override name = 'abort_aware_streaming'
  override description = 'Wait until the per-tool signal is aborted.'
  override parameters = toolParamsSchema({}, [])
  override readOnly = true
  override concurrencySafe = true
  aborted = false
  private markStarted: (() => void) | null = null
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve
  })

  execute(
    _args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    this.markStarted?.()
    return new Promise((resolve) => {
      context?.signal?.addEventListener(
        'abort',
        () => {
          this.aborted = true
          resolve('cancelled')
        },
        { once: true },
      )
    })
  }
}

class EarlyToolProvider extends LLMProvider {
  private streamCalls = 0
  constructor(
    private readonly toolCalls: ToolCallRequest[],
    private readonly gate: Promise<void>,
  ) {
    super({ defaultModel: 'fake' })
  }
  async chat(): Promise<LLMResponse> {
    return makeResponse({ content: 'done' })
  }
  override async chatStream(args: ChatStreamArgs): Promise<LLMResponse> {
    this.streamCalls += 1
    if (this.streamCalls > 1) return makeResponse({ content: 'done' })
    for (const call of this.toolCalls) await args.onToolCallComplete?.(call)
    await this.gate
    return makeResponse({
      content: '',
      toolCalls: this.toolCalls,
      finishReason: 'tool_calls',
    })
  }
}

class ToolCallbackProbeProvider extends LLMProvider {
  sawDeltaCallback = false
  sawCompleteCallback = false
  sawTools = false

  constructor() {
    super({ defaultModel: 'fake' })
  }

  async chat(): Promise<LLMResponse> {
    return makeResponse({ content: 'plain response' })
  }

  override async chatStream(args: ChatStreamArgs): Promise<LLMResponse> {
    this.sawDeltaCallback = Boolean(args.onToolCallDelta)
    this.sawCompleteCallback = Boolean(args.onToolCallComplete)
    this.sawTools = Boolean(args.tools?.length)
    return makeResponse({
      content: 'plain response',
      toolCalls: [toolCall('unexpected', 'read_file', { path: 'secret' })],
    })
  }
}

class BudgetedEchoTool extends Tool {
  override name = 'budgeted_echo'
  override description = 'Echo with a small context budget.'
  override parameters = toolParamsSchema({}, [])
  override maxResultChars = 2000
  execute(): string {
    return ''
  }
}

class StructuredEchoTool extends Tool {
  override name = 'structured_echo'
  override description = 'Structured echo.'
  override parameters = toolParamsSchema({ value: S('value') }, ['value'])
  override readOnly = true
  execute(): string {
    return ''
  }
  override mapResult(
    _raw: string,
    ctx: { arguments: Record<string, unknown> },
  ): ToolResult {
    const value = String(ctx.arguments.value)
    return {
      modelContent: `model:${value}`,
      displaySummary: `summary:${value}`,
      rawContent: `model:${value}`,
      artifacts: [
        {
          path: `memory/tool-results/${value}.txt`,
          kind: 'text',
          bytes: 9,
          metadata: {},
        },
      ],
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
  execute(): string {
    return ''
  }
  override mapResult(): ToolResult {
    return {
      modelContent: 'image imported',
      displaySummary: 'image imported',
      rawContent: 'image imported',
      artifacts: [
        {
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
        },
      ],
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
  execute(): string {
    return 'Error: blocked by policy'
  }
  override mapResult(raw: string): ToolResult {
    return { ...okResult(raw), isError: true }
  }
}

class InterjectionProbeTool extends Tool {
  override name = 'interjection_probe'
  override description = 'Must not run after an interjection supersedes it.'
  override parameters = toolParamsSchema({}, [])
  calls = 0
  execute(): string {
    this.calls += 1
    return 'obsolete tool result'
  }
}

// ── test_runner_state.py (TurnState) ──

describe('TurnState (test_runner_state.py)', () => {
  it('transitions to runtime events', () => {
    const state = new TurnState({ turnId: 'turn_1' })
    state.startIteration()
    const event = state.transition(TurnPhase.MODEL_REQUEST, {
      detail: { history_length: 2 },
    })
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
    const runner = new AgentRunner({
      provider: new FakeProvider([makeResponse({ content: 'done' })]),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []
    const reply = await runner.stepAsync([{ role: 'user', content: 'hi' }], {
      emit: (e) => {
        emitted.push(e)
      },
      turnId: 'turn_1',
    })
    expect(reply).toBe('done')
    const phases = emitted.filter((e) => e.event === 'turn_phase')
    expect(phases.map((e) => e.phase)).toEqual([
      'started',
      'model_request',
      'model_response',
      'compact_check',
      'completed',
    ])
    expect(phases.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(phases.every((e) => e.turn_id === 'turn_1')).toBe(true)
  })

  it('normalizes a provider AbortError only when this turn signal is aborted', async () => {
    let started: (() => void) | null = null
    const provider = new (class extends LLMProvider {
      constructor() {
        super({ defaultModel: 'fake' })
      }

      async chat(args: ChatArgs): Promise<LLMResponse> {
        started?.()
        return await new Promise<LLMResponse>((_resolve, reject) => {
          args.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new DOMException('The operation was aborted', 'AbortError'),
              ),
            { once: true },
          )
        })
      }
    })()
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })
    ;(
      runner as unknown as {
        samplingCoordinator: {
          execute<T>(request: {
            signal?: AbortSignal | null
            invoke(context: {
              requestId: string
              attemptId: string
              attempt: number
              maxAttempts: number
              signal: AbortSignal
            }): Promise<T>
          }): Promise<{
            value: T
            requestId: string
            attempts: number
            retryCount: number
            lastErrorKind: ''
          }>
        }
      }
    ).samplingCoordinator = {
      async execute<T>(request: {
        signal?: AbortSignal | null
        invoke(context: {
          requestId: string
          attemptId: string
          attempt: number
          maxAttempts: number
          signal: AbortSignal
        }): Promise<T>
      }) {
        const signal = request.signal ?? new AbortController().signal
        const value = await request.invoke({
          requestId: 'raw-abort-test',
          attemptId: 'raw-abort-test:1',
          attempt: 1,
          maxAttempts: 1,
          signal,
        })
        return {
          value,
          requestId: 'raw-abort-test',
          attempts: 1,
          retryCount: 0,
          lastErrorKind: '',
        }
      },
    }
    const controller = new AbortController()
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve
    })

    const running = runner.stepAsync([{ role: 'user', content: 'hi' }], {
      signal: controller.signal,
    })
    await providerStarted
    controller.abort()

    await expect(running).rejects.toBeInstanceOf(CancelledTaskError)
  })

  it('does not normalize a provider AbortError without turn cancellation', async () => {
    const runner = new AgentRunner({
      provider: new (class extends LLMProvider {
        constructor() {
          super({ defaultModel: 'fake' })
        }

        async chat(): Promise<LLMResponse> {
          throw new DOMException('upstream connection aborted', 'AbortError')
        }
      })(),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })

    await expect(
      runner.stepAsync([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({ code: 'model_provider_unknown' })
  })

  it('keeps a missing required path side-effect free and recovers from one precise schema error', async () => {
    let writes = 0
    class RequiredPathWriteTool extends Tool {
      override name = 'write_file'
      override description = 'write a test file'
      override parameters = toolParamsSchema(
        { path: S('path'), content: S('content') },
        ['path', 'content'],
      )
      execute(): string {
        writes += 1
        return 'wrote file'
      }
    }
    const registry = new ToolRegistry()
    registry.register(new RequiredPathWriteTool())
    const provider = new FakeProvider([
      makeResponse({
        content: '',
        toolCalls: [
          toolCall('write_missing_path', 'write_file', { content: 'x' }),
        ],
        finishReason: 'tool_calls',
      }),
      makeResponse({
        content: '',
        toolCalls: [
          toolCall('write_corrected', 'write_file', {
            path: 'index.html',
            content: 'x',
          }),
        ],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: '写入完成。' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      maxTurns: 5,
    })
    const history: Msg[] = [{ role: 'user', content: '写入 index.html' }]

    const reply = await runner.stepAsync(history)

    expect(reply).toBe('写入完成。')
    expect(writes).toBe(1)
    const results = history.filter((message) => message.role === 'tool')
    expect(String(results[0]!.content)).toContain('arguments.path is required')
    expect(results[0]!.content).toContain('Tool schema validation failed')
  })

  it('consumes ordered interjections at the model/tool boundary and tombstones the superseded response', async () => {
    const provider = new FakeProvider([
      makeResponse({
        content: 'obsolete tool plan',
        finishReason: 'tool_calls',
        toolCalls: [toolCall('call_obsolete', 'interjection_probe', {})],
      }),
      makeResponse({ content: 'final after interjection' }),
    ])
    const registry = new ToolRegistry()
    const tool = new InterjectionProbeTool()
    registry.register(tool)
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []
    const tombstones: Msg[] = []
    let consumes = 0
    const history: Msg[] = [{ role: 'user', content: 'original prompt' }]

    const reply = await runner.stepAsync(history, {
      turnId: 'turn_interjection',
      emit: (event) => {
        emitted.push(event)
      },
      interjections: {
        consume: () => {
          consumes += 1
          return consumes === 2
            ? [
                {
                  role: 'user',
                  content: 'first interjection',
                  turn_id: 'prompt_1',
                },
                {
                  role: 'user',
                  content: 'second interjection',
                  turn_id: 'prompt_2',
                },
              ]
            : []
        },
        tombstonePartial: (record) => {
          tombstones.push(record)
        },
      },
    })

    expect(reply).toBe('final after interjection')
    expect(tool.calls).toBe(0)
    expect(JSON.stringify(provider.seenMessages[1])).toContain(
      'first interjection',
    )
    expect(JSON.stringify(provider.seenMessages[1])).toContain(
      'second interjection',
    )
    expect(tombstones).toEqual([
      expect.objectContaining({
        content: 'obsolete tool plan',
        reason: 'interjected',
        turnId: 'turn_interjection',
      }),
    ])
    expect(emitted).toContainEqual(
      expect.objectContaining({
        event: 'message_tombstoned',
        reason: 'interjected',
      }),
    )
  })

  it('tombstones a streamed partial on model failure even without a UI emitter', async () => {
    const provider = new (class extends LLMProvider {
      constructor() {
        super({ defaultModel: 'fake' })
      }
      async chat(): Promise<LLMResponse> {
        return makeResponse({ content: 'unused' })
      }
      override async chatStream(args: ChatStreamArgs): Promise<LLMResponse> {
        await args.onContentDelta?.('orphan partial')
        throw Object.assign(new Error('invalid api key'), {
          status: 401,
          code: 'invalid_api_key',
        })
      }
    })()
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })
    const tombstones: Msg[] = []

    await expect(
      runner.stepAsync([{ role: 'user', content: 'hi' }], {
        turnId: 'turn_failed_partial',
        interjections: {
          consume: () => [],
          tombstonePartial: (record) => {
            tombstones.push(record)
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'model_provider_auth' })

    expect(tombstones).toEqual([
      expect.objectContaining({
        turnId: 'turn_failed_partial',
        content: 'orphan partial',
        reason: 'model_failed',
      }),
    ])
  })

  it('propagates one immutable execution snapshot through a turn tool batch', async () => {
    const provider = new FakeProvider([
      makeResponse({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [toolCall('call_snapshot', 'snapshot_context', {})],
      }),
      makeResponse({ content: 'done' }),
    ])
    const registry = new ToolRegistry()
    registry.register(new SnapshotContextTool())
    const snapshot = new ExecutionEnvironment(
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
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })

    await runner.stepAsync([{ role: 'user', content: 'run' }], {
      turnId: 'turn_snapshot',
      executionEnvironment: snapshot,
    })

    expect(JSON.stringify(provider.seenMessages.at(-1))).toContain(
      'd'.repeat(64),
    )
    expect(JSON.stringify(provider.seenMessages.at(-1))).not.toContain(
      'missing',
    )
  })

  it('runs automatic semantic compaction without an environment switch', async () => {
    const calls: string[] = []
    await withEnv('EMPEROR_AUTO_MEMORY_COMPACT', undefined, async () => {
      const runner = new AgentRunner({
        provider: new FakeProvider([makeResponse({ content: 'done' })]),
        model: 'fake',
        registry: new ToolRegistry(),
        systemPrompt: 'system',
        tokenTracker: {
          record: () => undefined,
          shouldCompact: () => {
            calls.push('shouldCompact')
            return true
          },
        },
        compactor: {
          compactAfterTurn: async () => {
            calls.push('compactAfterTurn')
            return { status: 'compacted' }
          },
        },
      })

      await runner.stepAsync([{ role: 'user', content: 'hi' }])
    })

    expect(calls).toEqual(['shouldCompact', 'compactAfterTurn'])
  })

  it('allows automatic semantic compaction to be disabled explicitly', async () => {
    const calls: string[] = []
    const runner = new AgentRunner({
      provider: new FakeProvider([makeResponse({ content: 'done' })]),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      autoCompact: false,
      tokenTracker: {
        record: () => undefined,
        shouldCompact: () => {
          calls.push('shouldCompact')
          return true
        },
      },
      compactor: {
        compactAfterTurn: async () => {
          calls.push('compactAfterTurn')
          return { status: 'compacted' }
        },
      },
    })

    await runner.stepAsync([{ role: 'user', content: 'hi' }])

    expect(calls).toEqual([])
  })

  it('runs semantic compaction after the final reply is committed and keeps projected history immutable', async () => {
    const emitted: Msg[] = []
    const memory = memoryDouble()
    const history = [{ role: 'user', content: 'hi' }]
    let sawCommittedAssistant = false
    await withEnv('EMPEROR_AUTO_MEMORY_COMPACT', '1', async () => {
      const runner = new AgentRunner({
        provider: new FakeProvider([makeResponse({ content: 'done' })]),
        model: 'fake',
        registry: new ToolRegistry(),
        systemPrompt: 'system',
        memoryStore: memory,
        tokenTracker: {
          record: () => undefined,
          shouldCompact: () => true,
          lastInputTokensValue: () => 9_000,
        },
        compactor: {
          compactAfterTurn: async ({ history: projectedHistory }) => {
            sawCommittedAssistant =
              memory.cleared &&
              memory.appended.some(
                (item) => item.role === 'assistant' && item.content === 'done',
              )
            projectedHistory.splice(0, projectedHistory.length, {
              role: 'system',
              content: 'mutated copy only',
            })
            return { status: 'compacted', message: 'ok' }
          },
        },
        maxContext: 100,
      })

      const reply = await runner.stepAsync(history, {
        emit: (event) => {
          emitted.push(event)
        },
        turnId: 'turn_compact_success',
      })
      expect(reply).toBe('done')
    })

    expect(sawCommittedAssistant).toBe(true)
    expect(history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'done', turn_id: 'turn_compact_success' },
    ])
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'turn_phase',
          phase: 'compact_check',
        }),
        expect.objectContaining({ event: 'turn_phase', phase: 'completed' }),
      ]),
    )
  })

  it('records compaction failure as degraded runtime state without failing a completed reply', async () => {
    const emitted: Msg[] = []
    const memory = memoryDouble()
    await withEnv('EMPEROR_AUTO_MEMORY_COMPACT', '1', async () => {
      const runner = new AgentRunner({
        provider: new FakeProvider([makeResponse({ content: 'done' })]),
        model: 'fake',
        registry: new ToolRegistry(),
        systemPrompt: 'system',
        memoryStore: memory,
        tokenTracker: {
          record: () => undefined,
          shouldCompact: () => true,
          lastInputTokensValue: () => 9_000,
        },
        compactor: {
          compactAfterTurn: async () => {
            throw new Error('compact failed')
          },
        },
        maxContext: 100,
      })

      const reply = await runner.stepAsync([{ role: 'user', content: 'hi' }], {
        emit: (event) => {
          emitted.push(event)
        },
        turnId: 'turn_compact_fail',
      })
      expect(reply).toBe('done')
    })

    expect(memory.cleared).toBe(true)
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'record_degraded',
          kind: 'memory_compaction',
          taskId: 'turn_compact_fail',
        }),
        expect.objectContaining({ event: 'turn_phase', phase: 'completed' }),
      ]),
    )
  })

  it('stops retrying automatic compaction after repeated failures', async () => {
    const emitted: Msg[] = []
    let attempts = 0
    await withEnv('EMPEROR_AUTO_MEMORY_COMPACT', '1', async () => {
      const runner = new AgentRunner({
        provider: new FakeProvider([
          makeResponse({ content: 'one' }),
          makeResponse({ content: 'two' }),
          makeResponse({ content: 'three' }),
          makeResponse({ content: 'four' }),
        ]),
        model: 'fake',
        registry: new ToolRegistry(),
        systemPrompt: 'system',
        memoryStore: memoryDouble(),
        tokenTracker: {
          record: () => undefined,
          shouldCompact: () => true,
          lastInputTokensValue: () => 9_000,
        },
        compactor: {
          compactAfterTurn: async () => {
            attempts++
            throw new Error('still broken')
          },
        },
        maxContext: 100,
      })

      await runner.stepAsync([{ role: 'user', content: '1' }], {
        emit: (event) => {
          emitted.push(event)
        },
        turnId: 'turn_1',
      })
      await runner.stepAsync([{ role: 'user', content: '2' }], {
        emit: (event) => {
          emitted.push(event)
        },
        turnId: 'turn_2',
      })
      await runner.stepAsync([{ role: 'user', content: '3' }], {
        emit: (event) => {
          emitted.push(event)
        },
        turnId: 'turn_3',
      })
      await runner.stepAsync([{ role: 'user', content: '4' }], {
        emit: (event) => {
          emitted.push(event)
        },
        turnId: 'turn_4',
      })
    })

    expect(attempts).toBe(3)
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'record_degraded',
          kind: 'memory_compaction',
          reason:
            'automatic memory compaction disabled after consecutive failures',
          taskId: 'turn_4',
        }),
      ]),
    )
  })

  it('reserves output headroom when checking compaction threshold', async () => {
    const seenMaxContext: number[] = []
    await withEnv('EMPEROR_AUTO_MEMORY_COMPACT', '1', async () => {
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
    })

    // 有效上限 = maxContext 10_000 − 预留输出 maxTokens 2_000
    expect(seenMaxContext[0]).toBe(8_000)
  })

  it('keeps at least half the context window when output reserve is oversized', async () => {
    const seenMaxContext: number[] = []
    await withEnv('EMPEROR_AUTO_MEMORY_COMPACT', '1', async () => {
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
    })

    expect(seenMaxContext[0]).toBe(4_000)
  })

  it('emits context usage with the active route context window', async () => {
    const runner = new AgentRunner({
      provider: new FakeProvider([
        makeResponse({ content: 'done', usage: { input: 120, output: 3 } }),
      ]),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      maxContext: 1_000,
    })
    const emitted: Msg[] = []

    await runner.stepAsync([{ role: 'user', content: 'hi' }], {
      emit: (event) => {
        emitted.push(event)
      },
    })

    expect(
      emitted.find((event) => event.event === 'context_usage'),
    ).toMatchObject({
      used: 120,
      max: 1_000,
      threshold: 700,
    })
  })

  it('recovers once from provider context overflow with emergency projection shrink', async () => {
    const provider = new ContextOverflowOnceProvider('once')
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []
    const history: Msg[] = [{ role: 'user', content: 'overflow '.repeat(3000) }]

    const reply = await runner.stepAsync(history, {
      emit: (event) => {
        emitted.push(event)
      },
    })

    const firstUser = provider.seenMessages[0]!.find(
      (message) => message.role === 'user',
    )!
    const secondUser = provider.seenMessages[1]!.find(
      (message) => message.role === 'user',
    )!
    const projectionReports = emitted
      .filter((event) => event.event === 'context_projection')
      .map((event) => event.report as Record<string, unknown>)

    expect(reply).toBe('done')
    expect(provider.calls).toBe(2)
    expect(String(firstUser.content).length).toBeGreaterThan(20_000)
    expect(String(secondUser.content)).toContain('[local_microcompact]')
    expect(String(secondUser.content).length).toBeLessThan(
      String(firstUser.content).length,
    )
    expect(projectionReports[1]).toMatchObject({
      context_overflow_retry: 1,
      emergency_context_shrink: 1,
    })
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'record_degraded',
          kind: 'context_overflow',
        }),
      ]),
    )
    expect(
      history.filter((message) => message.role === 'assistant'),
    ).toHaveLength(1)
  })

  it('returns a domain context_overflow error after the emergency retry also overflows', async () => {
    const provider = new ContextOverflowOnceProvider('always')
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })
    const history: Msg[] = [{ role: 'user', content: 'overflow '.repeat(3000) }]

    await expect(runner.stepAsync(history)).rejects.toMatchObject({
      code: 'context_overflow',
    })

    expect(provider.calls).toBe(2)
    expect(
      history.filter((message) => message.role === 'assistant'),
    ).toHaveLength(0)
  })

  it('retries retryable provider errors before succeeding', async () => {
    const provider = new FlakyProvider(2, () =>
      Object.assign(new Error('temporarily unavailable'), { status: 503 }),
    )
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []

    const reply = await runner.stepAsync([{ role: 'user', content: 'hi' }], {
      emit: (event) => {
        emitted.push(event)
      },
    })

    expect(reply).toBe('done')
    expect(provider.calls).toBe(3)
    expect(
      emitted.filter((event) => event.event === 'model_provider_retry'),
    ).toHaveLength(2)
    const attempts = emitted.filter((event) =>
      String(event.event).startsWith('model_attempt_'),
    )
    expect(
      attempts.filter((event) => event.event === 'model_attempt_started'),
    ).toHaveLength(3)
    expect(
      attempts.filter((event) =>
        ['model_attempt_failed', 'model_attempt_succeeded'].includes(
          String(event.event),
        ),
      ),
    ).toHaveLength(3)
    expect(new Set(attempts.map((event) => event.request_id)).size).toBe(1)
    expect(new Set(attempts.map((event) => event.attempt_id)).size).toBe(3)
    expect(
      emitted.find((event) => event.event === 'context_usage'),
    ).toMatchObject({ provider_retry_count: 2 })
  })

  it('does not retry non-retryable auth provider errors', async () => {
    const provider = new FlakyProvider(1, () =>
      Object.assign(new Error('invalid api key'), {
        status: 401,
        code: 'invalid_api_key',
      }),
    )
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })

    await expect(
      runner.stepAsync([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({
      code: 'model_provider_auth',
      action: 'open_model_settings',
    })

    expect(provider.calls).toBe(1)
  })

  it('returns a safe retry-later provider error after retryable failures are exhausted', async () => {
    const provider = new FlakyProvider(3, () =>
      Object.assign(new Error('temporarily unavailable'), { status: 503 }),
    )
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []

    await expect(
      runner.stepAsync([{ role: 'user', content: 'hi' }], {
        emit: (event) => {
          emitted.push(event)
        },
      }),
    ).rejects.toMatchObject({
      code: 'model_provider_transient',
      action: 'retry_later',
    })

    expect(provider.calls).toBe(3)
    expect(
      emitted.filter((event) => event.event === 'model_provider_retry'),
    ).toHaveLength(2)
  })

  it('never switches to a legacy fallback provider after the active model fails', async () => {
    const primary = new FlakyProvider(3, () =>
      Object.assign(new Error('temporarily unavailable'), { status: 503 }),
    )
    const fallback = new FakeProvider([
      makeResponse({
        content: 'fallback done',
        usage: { input: 70, output: 5 },
      }),
    ])
    const legacyOptions = {
      provider: primary,
      model: 'main-model',
      modelEntryId: 'active-entry',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      fallbackProvider: fallback,
      fallbackModel: 'fallback-model',
      fallbackProviderName: 'fallback-provider',
      usageType: 'scheduler',
    }
    const runner = new AgentRunner(legacyOptions)
    const emitted: Msg[] = []

    await expect(
      runner.stepAsync([{ role: 'user', content: 'hi' }], {
        emit: (event) => {
          emitted.push(event)
        },
      }),
    ).rejects.toMatchObject({ code: 'model_provider_transient' })

    expect(primary.calls).toBe(3)
    expect(fallback.seenMessages).toHaveLength(0)
    expect(runner.model).toBe('main-model')
    expect(runner.provider).toBe(primary)
    expect(
      emitted.some((event) => event.event === 'model_route_fallback'),
    ).toBe(false)
  })

  it('keeps an explicit fallback for the current step only and starts the next step on primary', async () => {
    const primary = new FlakyProvider(3, () =>
      Object.assign(new Error('temporarily unavailable'), { status: 503 }),
    )
    const fallback = new FakeProvider([
      makeResponse({
        content: 'partial',
        finishReason: 'length',
        usage: { input: 70, output: 5 },
      }),
      makeResponse({
        content: 'fallback done',
        usage: { input: 80, output: 6 },
      }),
    ])
    const runner = new AgentRunner({
      provider: primary,
      model: 'main-model',
      modelEntryId: 'active-entry',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      modelPolicy: {
        fallback: {
          provider: fallback,
          model: 'fallback-model',
          providerName: 'fallback-provider',
          modelEntryId: 'fallback-entry',
          supportsToolCall: true,
          maxTokens: 8_000,
          temperature: 0,
          reasoningEffort: null,
          pricing: null,
        },
        triggerOn: ['transient'],
        maxUsdPerAgentTurn: null,
      },
    })
    const firstEvents: Msg[] = []

    await expect(
      runner.stepAsync([{ role: 'user', content: 'first' }], {
        emit: (event) => {
          firstEvents.push(event)
        },
      }),
    ).resolves.toContain('fallback done')
    expect(primary.calls).toBe(3)
    expect(fallback.seenMessages).toHaveLength(2)
    expect(
      firstEvents.filter((event) => event.event === 'model_route_fallback'),
    ).toHaveLength(1)

    const secondEvents: Msg[] = []
    await expect(
      runner.stepAsync([{ role: 'user', content: 'second' }], {
        emit: (event) => {
          secondEvents.push(event)
        },
      }),
    ).resolves.toBe('done')
    expect(primary.calls).toBe(4)
    expect(fallback.seenMessages).toHaveLength(2)
    expect(
      secondEvents.some((event) => event.event === 'model_route_fallback'),
    ).toBe(false)
  })

  it('disables tool payloads and streaming callbacks when tool calling is unsupported', async () => {
    const provider = new ToolCallbackProbeProvider()
    const runner = new AgentRunner({
      provider,
      model: 'plain-model',
      modelEntryId: 'plain-entry',
      supportsToolCall: false,
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })

    await expect(
      runner.stepAsync([{ role: 'user', content: 'hello' }], {
        emit: async () => {},
      }),
    ).resolves.toBe('plain response')
    expect(provider.sawTools).toBe(false)
    expect(provider.sawDeltaCallback).toBe(false)
    expect(provider.sawCompleteCallback).toBe(false)
  })

  it('writes a redacted prompt snapshot for each turn', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'emperor-prompt-snapshot-'))
    const memoryRoot = mkdtempSync(join(tmpdir(), 'emperor-prompt-memory-'))
    const memoryDir = join(memoryRoot, 'memory')
    const memory = new MemoryStore(memoryDir, join(memoryDir, 'USER.local.md'))
    memory.writeMemory('# Updated Memory\n\n- versioned before model call')
    const provider = new FakeProvider([makeResponse({ content: 'done' })])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'secret bootstrap',
      memoryStore: memory,
      promptSections: [
        {
          name: 'bootstrap',
          content: 'secret bootstrap',
          source: 'templates/SOUL.md',
          priority: 100,
          budgetChars: null,
          version: 'test',
        },
      ],
      promptContextPlan: {
        version: 1,
        mode: 'build',
        activeMemoryBinding: {
          profile: {
            scope: { kind: 'user_profile' },
            readable: true,
            writable: true,
            path: 'memory/profile/USER.local.md',
          },
          longTerm: {
            scope: { kind: 'project', projectId: 'project_1' },
            readable: true,
            writable: true,
            path: 'projects/project_1/AGENTS.local.md',
          },
          episode: {
            scope: { kind: 'episode', date: '2026-07-06' },
            readable: false,
            writable: true,
            path: 'memory/2026-07-06.md',
          },
        },
        items: [],
        omitted: [
          {
            kind: 'global_memory',
            source: 'memory/MEMORY.local.md',
            reason: 'build mode intentionally does not inject global MEMORY',
          },
        ],
      },
      promptSnapshotDir: snapshotDir,
      sessionId: 'session_1',
    })

    await runner.stepAsync(
      [
        {
          role: 'user',
          content: 'private user message body',
          seq: 7,
          turn_id: 'turn_prompt',
        },
      ],
      { turnId: 'turn_prompt' },
    )

    const snapshotPath = join(snapshotDir, 'turn_prompt.json')
    expect(existsSync(snapshotPath)).toBe(true)
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
    expect(snapshot).toMatchObject({
      sessionId: 'session_1',
      turnId: 'turn_prompt',
      model: 'fake',
    })
    expect(snapshot.sections[0]).toMatchObject({
      name: 'bootstrap',
      source: 'templates/SOUL.md',
      charCount: 'secret bootstrap'.length,
      redacted: true,
    })
    expect(snapshot.sections[0].hash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.contextPlan).toMatchObject({
      version: 1,
      mode: 'build',
      items: [
        {
          id: 'section:bootstrap',
          kind: 'bootstrap',
          source: 'templates/SOUL.md',
          action: 'include',
        },
      ],
      omitted: [
        {
          kind: 'global_memory',
          source: 'memory/MEMORY.local.md',
          reason: 'build mode intentionally does not inject global MEMORY',
        },
      ],
    })
    expect(snapshot.contextPlan.items[0].hash).toBe(snapshot.sections[0].hash)
    expect(snapshot.finalMessagesHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.projection).toMatchObject({
      version: 1,
      cacheBreak: {
        classification: 'initial',
        reasonCode: 'initial_projection',
      },
      stablePrefix: {
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        leaves: [
          expect.objectContaining({
            id: 'section:bootstrap',
            stability: 'stable',
          }),
          expect.objectContaining({ id: 'request:tools', kind: 'tools' }),
        ],
      },
    })
    expect(snapshot.historyRange).toEqual({
      messageCount: 1,
      firstSeq: 7,
      lastSeq: 7,
      turnIds: ['turn_prompt'],
    })
    expect(provider.seenMessages[0]![1]).toEqual({
      role: 'user',
      content: 'private user message body',
    })
    expect(snapshot.checkpoint).toMatchObject({
      status: 'captured',
      phase: 'user_received',
      turnId: 'turn_prompt',
      partialMessages: 1,
    })
    expect(snapshot.memoryVersions).toEqual([
      expect.objectContaining({
        target: 'memory',
        relPath: 'memory/MEMORY.local.md',
      }),
    ])
    expect(JSON.stringify(snapshot)).not.toContain('secret bootstrap')
    expect(JSON.stringify(snapshot)).not.toContain('private user message body')
  })

  it('keeps the prompt stable-prefix hash across turns and emits cache-break plus provider cache diagnostics', async () => {
    const snapshotDir = mkdtempSync(
      join(tmpdir(), 'emperor-prompt-projection-'),
    )
    const provider = new FakeProvider([
      makeResponse({ content: 'one', usage: { input: 10, output: 2 } }),
      makeResponse({
        content: 'two',
        usage: { input: 12, output: 2, cache_read: 8 },
      }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'stable system',
      promptSections: [
        {
          name: 'bootstrap',
          content: 'stable system',
          source: 'templates/SOUL.md',
          priority: 100,
          budgetChars: null,
          version: 'v1',
          stability: 'stable',
        },
      ],
      promptSnapshotDir: snapshotDir,
      sessionId: 'session_cache',
    })
    const history: Msg[] = [{ role: 'user', content: 'first' }]
    await runner.stepAsync(history, { turnId: 'turn_cache_1' })
    history.push({ role: 'user', content: 'second' })
    const emitted: Msg[] = []
    await runner.stepAsync(history, {
      turnId: 'turn_cache_2',
      emit: (event) => {
        emitted.push(event)
      },
    })

    const first = JSON.parse(
      readFileSync(join(snapshotDir, 'turn_cache_1.json'), 'utf8'),
    )
    const second = JSON.parse(
      readFileSync(join(snapshotDir, 'turn_cache_2.json'), 'utf8'),
    )
    expect(second.projection.stablePrefix.hash).toBe(
      first.projection.stablePrefix.hash,
    )
    expect(second.projection.cacheBreak).toMatchObject({
      classification: 'expected',
      reasonCode: 'history_appended',
    })
    expect(
      emitted.find((event) => event.event === 'context_projection'),
    ).toMatchObject({
      report: {
        stable_prefix_hash: second.projection.stablePrefix.hash,
        cache_break_classification: 'expected',
        cache_break_reason: 'history_appended',
      },
    })
    expect(
      emitted.find((event) => event.event === 'context_usage'),
    ).toMatchObject({
      cache_read_tokens: 8,
      cache_create_tokens: 0,
      prompt_cache_hit: true,
      stable_prefix_hash: second.projection.stablePrefix.hash,
    })
  })

  it('restores the previous redacted projection after runner restart for adjacent-turn diagnostics', async () => {
    const snapshotDir = mkdtempSync(
      join(tmpdir(), 'emperor-prompt-projection-restart-'),
    )
    const createRunner = (provider: FakeProvider) =>
      new AgentRunner({
        provider,
        model: 'fake',
        registry: new ToolRegistry(),
        systemPrompt: 'stable system',
        promptSections: [
          {
            name: 'bootstrap',
            content: 'stable system',
            source: 'templates/SOUL.md',
            priority: 100,
            budgetChars: null,
            version: 'v1',
            stability: 'stable',
          },
        ],
        promptSnapshotDir: snapshotDir,
        sessionId: 'session_cache_restart',
      })
    const history: Msg[] = [{ role: 'user', content: 'first' }]
    await createRunner(
      new FakeProvider([makeResponse({ content: 'one' })]),
    ).stepAsync(history, { turnId: 'turn_restart_1' })
    history.push({ role: 'user', content: 'second' })

    await createRunner(
      new FakeProvider([makeResponse({ content: 'two' })]),
    ).stepAsync(history, { turnId: 'turn_restart_2' })

    const second = JSON.parse(
      readFileSync(join(snapshotDir, 'turn_restart_2.json'), 'utf8'),
    )
    expect(second.projection.cacheBreak).toMatchObject({
      classification: 'expected',
      reasonCode: 'history_appended',
      previousStablePrefixHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it('records local microcompact records in the prompt context plan', async () => {
    const snapshotDir = mkdtempSync(
      join(tmpdir(), 'emperor-prompt-snapshot-microcompact-'),
    )
    const runner = new AgentRunner({
      provider: new FakeProvider([makeResponse({ content: 'done' })]),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      contextPipeline: new ContextPipeline({
        microcompactKeepRecent: 0,
        microcompactMinChars: 80,
        microcompactHeadChars: 12,
        microcompactTailChars: 8,
      }),
      promptSections: [
        {
          name: 'bootstrap',
          content: 'system',
          source: 'templates/SOUL.md',
          priority: 100,
          budgetChars: null,
          version: 'test',
        },
      ],
      promptContextPlan: {
        version: 1,
        mode: 'chat',
        activeMemoryBinding: {
          longTerm: {
            scope: { kind: 'global' },
            readable: true,
            writable: true,
            path: 'memory/MEMORY.local.md',
          },
        },
        items: [],
        omitted: [],
      },
      promptSnapshotDir: snapshotDir,
      sessionId: 'session_1',
    })

    await runner.stepAsync([{ role: 'user', content: 'x'.repeat(120) }], {
      turnId: 'turn_microcompact',
    })

    const snapshot = JSON.parse(
      readFileSync(join(snapshotDir, 'turn_microcompact.json'), 'utf8'),
    )
    expect(snapshot.contextPlan.microcompact).toEqual([
      expect.objectContaining({
        index: 0,
        message_id: 'history:0',
        role: 'user',
        original_chars: 120,
        token_estimate: 30,
        reason: 'older_text_over_microcompact_threshold',
        kept_head_chars: 12,
        kept_tail_chars: 8,
      }),
    ])
  })

  it('streaming tool execution produces the same final reply and tool messages as batch (Wave5 golden)', async () => {
    async function runTurn(
      streaming: boolean,
    ): Promise<{ reply: string; toolContents: string[] }> {
      const registry = new ToolRegistry()
      registry.register(new SafeEchoTool())
      const runner = new AgentRunner({
        provider: new FakeProvider([
          makeResponse({
            content: '',
            toolCalls: [
              toolCall('call_1', 'safe_echo', { value: 'a' }),
              toolCall('call_2', 'safe_echo', { value: 'b' }),
            ],
            finishReason: 'tool_calls',
          }),
          makeResponse({ content: 'done' }),
        ]),
        model: 'fake',
        registry,
        systemPrompt: 'system',
        streamingToolExecution: streaming,
      })
      const history: Msg[] = [{ role: 'user', content: 'hi' }]
      const reply = await runner.stepAsync(history)
      const toolContents = history
        .filter((m) => m.role === 'tool')
        .map((m) => String(m.content))
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
    registry.register(
      new LatchEchoTool(() => {
        started = true
      }),
    )
    let resolveModel: (() => void) | null = null
    const provider = new EarlyToolProvider(
      [toolCall('call_1', 'latch_echo', { value: 'x' })],
      new Promise<void>((resolve) => {
        resolveModel = resolve
      }),
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

  it('tombstones and aborts an early tool omitted from the final model response', async () => {
    const registry = new ToolRegistry()
    const tool = new AbortAwareStreamingTool()
    registry.register(tool)
    const partial = toolCall('partial_call', tool.name, {})
    const provider = new (class extends LLMProvider {
      constructor() {
        super({ defaultModel: 'fake' })
      }
      async chat(): Promise<LLMResponse> {
        return makeResponse({ content: 'done' })
      }
      override async chatStream(args: ChatStreamArgs): Promise<LLMResponse> {
        await args.onToolCallComplete?.(partial)
        await tool.started
        return makeResponse({ content: 'done', toolCalls: [] })
      }
    })()
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      streamingToolExecution: true,
    })
    const emitted: Array<Record<string, unknown>> = []

    await expect(
      runner.stepAsync([{ role: 'user', content: 'hi' }], {
        emit: (event) => {
          emitted.push(event)
        },
      }),
    ).resolves.toBe('done')

    expect(tool.aborted).toBe(true)
    expect(
      emitted.filter(
        (event) =>
          event.id === partial.id &&
          [
            'tool_run_completed',
            'tool_run_failed',
            'tool_run_cancelled',
          ].includes(String(event.event)),
      ),
    ).toEqual([
      expect.objectContaining({
        event: 'tool_run_cancelled',
        reason: 'not_in_final_response',
      }),
    ])
  })

  it('propagates the turn snapshot through streaming tool execution', async () => {
    const registry = new ToolRegistry()
    const tool = new SnapshotContextTool()
    registry.register(tool)
    const provider = new EarlyToolProvider(
      [toolCall('call_snapshot', 'snapshot_context', {})],
      Promise.resolve(),
    )
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      streamingToolExecution: true,
    })
    const snapshot = new ExecutionEnvironment(
      {
        revision: '9'.repeat(64),
        catalogRevision: '8'.repeat(64),
        projectFingerprint: '7'.repeat(64),
        createdAt: '2026-07-11T02:00:00.000Z',
        platform: 'darwin',
        pathEntries: ['/snapshot/bin'],
        env: { PATH: '/snapshot/bin' },
        toolPaths: {},
      },
      {},
    )

    await runner.stepAsync([{ role: 'user', content: 'run' }], {
      executionEnvironment: snapshot,
    })

    expect(tool.revisions).toEqual(['9'.repeat(64)])
  })

  it('emits tool batch phases', async () => {
    const registry = new ToolRegistry()
    registry.register(new EchoTool())
    const runner = new AgentRunner({
      provider: new FakeProvider([
        makeResponse({
          content: '',
          toolCalls: [toolCall('call_1', 'echo', { value: 'ok' })],
          finishReason: 'tool_calls',
        }),
        makeResponse({ content: 'done' }),
      ]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []
    const reply = await runner.stepAsync([{ role: 'user', content: 'hi' }], {
      emit: (e) => {
        emitted.push(e)
      },
    })
    expect(reply).toBe('done')
    const phases = emitted.filter((e) => e.event === 'turn_phase')
    expect(phases.map((e) => e.phase)).toContain('tool_batch_start')
    expect(phases.map((e) => e.phase)).toContain('tool_batch_done')
    expect(
      phases.filter((e) => e.phase === 'model_request').map((e) => e.iteration),
    ).toEqual([1, 2])
  })

  it('applies PreToolUse deny before executing the tool', async () => {
    class CountingTool extends Tool {
      override name = 'counting_echo'
      override description = 'Counts executions.'
      override parameters = toolParamsSchema({}, [])
      execute(): string {
        executed += 1
        return 'executed'
      }
    }
    let executed = 0
    const registry = new ToolRegistry()
    registry.register(new CountingTool())
    const provider = new FakeProvider([
      makeResponse({
        content: '',
        toolCalls: [toolCall('call_1', 'counting_echo', {})],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: 'done' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      hooks: {
        run: async (eventName) =>
          eventName === 'PreToolUse'
            ? {
                decision: 'deny',
                reason: 'blocked by hook',
                results: [],
                additionalContext: '',
              }
            : {
                decision: 'passthrough',
                reason: '',
                results: [],
                additionalContext: '',
              },
      },
    })

    await runner.stepAsync([{ role: 'user', content: 'hi' }])

    expect(executed).toBe(0)
    const secondCallMessages = provider.seenMessages[1] ?? []
    const toolMessage = secondCallMessages.find(
      (message) => message.role === 'tool',
    )
    expect(String(toolMessage?.content ?? '')).toContain('blocked by hook')
  })

  it('adds PostToolUse hook context to the next model call', async () => {
    const registry = new ToolRegistry()
    registry.register(new EchoTool())
    const provider = new FakeProvider([
      makeResponse({
        content: '',
        toolCalls: [toolCall('call_1', 'echo', { value: 'ok' })],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: 'done' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      hooks: {
        run: async (eventName) =>
          eventName === 'PostToolUse'
            ? {
                decision: 'passthrough',
                reason: '',
                results: [],
                additionalContext: '[policy] remember this',
              }
            : {
                decision: 'passthrough',
                reason: '',
                results: [],
                additionalContext: '',
              },
      },
    })

    await runner.stepAsync([{ role: 'user', content: 'hi' }])

    const secondCallMessages = provider.seenMessages[1] ?? []
    const toolMessage = secondCallMessages.find(
      (message) => message.role === 'tool',
    )
    expect(String(toolMessage?.content ?? '')).toContain(
      '[policy] remember this',
    )
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

    await runner.stepAsync([{ role: 'user', content: 'hi' }], {
      emit: (e) => {
        emitted.push(e)
      },
      turnId: 'turn_audit',
    })

    const intentIndex = emitted.findIndex(
      (e) => e.event === 'agent_thought' && e.stage === 'tool_intent',
    )
    const firstToolIndex = emitted.findIndex((e) => e.event === 'tool_call')
    const resultSummaryIndex = emitted.findIndex(
      (e) => e.event === 'agent_thought' && e.stage === 'tool_result_summary',
    )
    const lastToolResultIndex = emitted.reduce(
      (last, event, index) => (event.event === 'tool_result' ? index : last),
      -1,
    )

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
    expect(String(emitted[resultSummaryIndex]!.summary)).not.toContain(
      'echo 成功',
    )
    expect(String(emitted[resultSummaryIndex]!.summary)).toContain(
      'error_result 失败',
    )
    expect(String(emitted[resultSummaryIndex]!.summary)).toContain(
      'media_result 成功，识别到 1 个图片 artifact',
    )
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
          toolCalls: [toolCall('call_1', 'echo', { value: 'ok' })],
          finishReason: 'tool_calls',
        }),
        makeResponse({ content: 'handled' }),
      ]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []

    await runner.stepAsync([{ role: 'user', content: 'hi' }], {
      emit: (e) => {
        emitted.push(e)
      },
      turnId: 'turn_success_audit',
    })

    expect(
      emitted.some(
        (e) => e.event === 'agent_thought' && e.stage === 'tool_result_summary',
      ),
    ).toBe(false)
  })

  it('does not emit audit thoughts for plain replies without tools', async () => {
    const runner = new AgentRunner({
      provider: new FakeProvider([makeResponse({ content: 'done' })]),
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []

    await runner.stepAsync([{ role: 'user', content: 'hi' }], {
      emit: (e) => {
        emitted.push(e)
      },
      turnId: 'turn_plain',
    })

    expect(emitted.some((e) => e.event === 'agent_thought')).toBe(false)
  })

  it('uses structured tool result for history + runtime summary', async () => {
    const registry = new ToolRegistry()
    registry.register(new StructuredEchoTool())
    const runner = new AgentRunner({
      provider: new FakeProvider([
        makeResponse({
          content: '',
          toolCalls: [
            toolCall('call_1', 'structured_echo', { value: 'large' }),
          ],
          finishReason: 'tool_calls',
        }),
        makeResponse({ content: 'done' }),
      ]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const history: Msg[] = [{ role: 'user', content: 'hi' }]
    const emitted: Msg[] = []
    await runner.stepAsync(history, {
      emit: (e) => {
        emitted.push(e)
      },
    })
    const toolMessage = history.find((m) => m.role === 'tool')!
    const toolResultEvent = emitted.find((e) => e.event === 'tool_result')!
    const completedEvent = emitted.find(
      (e) => e.event === 'tool_run_completed',
    )!
    expect(toolMessage.content).toBe('model:large')
    expect(toolResultEvent.summary).toBe('summary:large')
    expect(toolResultEvent.output).toBe('model:large')
    expect(toolResultEvent.artifacts).toEqual([
      {
        path: 'memory/tool-results/large.txt',
        kind: 'text',
        bytes: 9,
        metadata: {},
      },
    ])
    expect(completedEvent.summary).toBe('summary:large')
    expect(completedEvent.output).toBe('model:large')
    expect(completedEvent.metadata).toEqual({ source: 'runner-test' })
  })

  it('emits error tool result and failed run event', async () => {
    const registry = new ToolRegistry()
    registry.register(new ErrorResultTool())
    const runner = new AgentRunner({
      provider: new FakeProvider([
        makeResponse({
          content: '',
          toolCalls: [toolCall('call_1', 'error_result', {})],
          finishReason: 'tool_calls',
        }),
        makeResponse({ content: 'handled' }),
      ]),
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []
    await runner.stepAsync([{ role: 'user', content: 'hi' }], {
      emit: (e) => {
        emitted.push(e)
      },
    })
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
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []
    await runner.stepAsync(
      [
        { role: 'user', content: 'inspect' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
          ],
        },
      ],
      {
        emit: (e) => {
          emitted.push(e)
        },
      },
    )
    const contextEvents = emitted.filter(
      (e) => e.event === 'context_projection',
    )
    expect(
      (contextEvents[0]!.report as Record<string, unknown>)
        .paired_missing_tool_results,
    ).toBe(1)
    expect(contextEvents[0]!.message_count).toBe(3)
    const lastSeen = provider.seenMessages[0]!
    expect(
      (lastSeen[lastSeen.length - 1] as Record<string, unknown>).tool_call_id,
    ).toBe('call_1')
  })

  it('default context pipeline replaces large tool results using registered tool budgets', async () => {
    const root = tmp('emperor-runner-tool-result-')
    const content = 'x'.repeat(3000)
    const memory = new MemoryFake() as MemoryFake & { memoryDir: string }
    memory.memoryDir = join(root, 'memory')
    const provider = new FakeProvider([makeResponse({ content: 'done' })])
    const registry = new ToolRegistry()
    registry.register(new BudgetedEchoTool())
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      memoryStore: memory,
    })
    const emitted: Msg[] = []

    await runner.stepAsync(
      [
        { role: 'user', content: 'inspect' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'budgeted_echo', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          turn_id: 'turn_1',
          tool_call_id: 'call_1',
          name: 'budgeted_echo',
          content,
        },
      ],
      {
        emit: (e) => {
          emitted.push(e)
        },
      },
    )

    const contextEvent = emitted.find((e) => e.event === 'context_projection')!
    const report = contextEvent.report as Record<string, unknown>
    const replacement = (
      report.tool_result_replacements as Array<Record<string, unknown>>
    )[0]!
    const projectedTool = provider.seenMessages[0]!.at(-1) as Record<
      string,
      unknown
    >

    expect(replacement.tool_name).toBe('budgeted_echo')
    expect(String(projectedTool.content)).toContain('original_chars: 3000')
    expect(
      readFileSync(join(root, String(replacement.artifact_path)), 'utf8'),
    ).toBe(content)
  })

  it('default context pipeline reports aggregate tool result replacements', async () => {
    const root = tmp('emperor-runner-aggregate-tool-result-')
    const memory = new MemoryFake() as MemoryFake & { memoryDir: string }
    memory.memoryDir = join(root, 'memory')
    const provider = new FakeProvider([
      makeResponse({ content: 'done', usage: { input: 100, output: 4 } }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      memoryStore: memory,
    })
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
      {
        emit: (event) => {
          emitted.push(event)
        },
      },
    )

    const contextEvent = emitted.find(
      (event) => event.event === 'context_projection',
    )!
    const usageEvent = emitted.find((event) => event.event === 'context_usage')!
    const report = contextEvent.report as Record<string, unknown>
    const aggregateRecords = report.aggregate_tool_result_replacements as Array<
      Record<string, unknown>
    >
    const projectedTools = provider.seenMessages[0]!.filter(
      (message) => message.role === 'tool',
    )

    expect(report.aggregate_replaced_tool_results).toBeGreaterThan(0)
    expect(report.replaced_tool_results).toBe(aggregateRecords.length)
    expect(usageEvent).toMatchObject({
      replaced_tool_results: aggregateRecords.length,
      aggregate_replaced_tool_results: aggregateRecords.length,
      aggregate_tool_result_budget: 24_000,
    })
    expect(String(projectedTools[0]!.content)).toContain(
      'Tool result stored outside the model context',
    )
    expect(String(projectedTools.at(-1)!.content)).toBe(
      String(toolMessages.at(-1)!.content),
    )
    expect(
      readFileSync(
        join(root, String(aggregateRecords[0]!.artifact_path)),
        'utf8',
      ),
    ).toBe(toolMessages[0]!.content)
  })

  it('default context pipeline supplies approved plan runtime context', async () => {
    const manager = new ControlManager(tmp('emperor-runner-plan-context-'))
    manager.setRuntimeScope({
      sessionId: 'session_plan',
      projectId: 'project_plan',
      workspaceRoot: '/tmp/plan-project',
    })
    const interaction = manager.createPlan({
      title: 'Continue approved plan',
      summary: 'Keep executing the active step.',
      planMarkdown: '# Plan\n\n- Continue approved plan',
      assumptions: [],
      riskLevel: 'low',
      steps: [
        {
          id: 'step_1',
          title: 'Continue approved plan',
          description: 'Run the next implementation step.',
          acceptance: ['model receives plan runtime context'],
          verification: [
            { id: 'manual_context', kind: 'manual', required: false },
          ],
        },
      ],
    })
    manager.approve(interaction.id)
    const provider = new FakeProvider([makeResponse({ content: 'done' })])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      controlManager: manager,
      maxTurns: 1,
    })

    await runner.stepAsync([
      { role: 'user', content: 'continue approved plan' },
    ])

    const contents = provider.seenMessages[0]!.map((message) =>
      String(message.content ?? ''),
    )
    const planContext =
      contents.find((content) => content.includes('[PLAN_RUNTIME_CONTEXT]')) ??
      ''
    expect(planContext).toContain('plan_id:')
    expect(planContext).toContain('status: approved')
  })

  it('reconciles an exactly bound update_todos completion into the authoritative Plan', async () => {
    const manager = new ControlManager(tmp('emperor-runner-todo-decoupled-'))
    const todoStore = new TodoStore()
    manager.setTodoStore(todoStore)
    const interaction = manager.createPlan({
      title: 'Decoupled todo plan',
      summary: 'Plan is approval context, todo is execution checklist.',
      planMarkdown: '# Plan\n\n- Run matrix',
      assumptions: [],
      riskLevel: 'low',
      steps: [
        {
          id: 'step_1',
          title: 'Run matrix',
          description: 'Execute the task.',
          acceptance: ['todo update succeeds without plan evidence'],
        },
      ],
    })
    manager.approve(interaction.id)
    const planId = String(interaction.meta.plan_id)
    expect(manager.planStore.get(planId)!.steps[0]!.status).toBe('active')
    const boundTodo = { ...todoStore.todos[0]!, status: 'completed' }

    const registry = new ToolRegistry()
    registry.register(new UpdateTodos(todoStore))
    const provider = new FakeProvider([
      makeResponse({
        content: '',
        toolCalls: [
          toolCall('todo_1', 'update_todos', {
            todos: [boundTodo],
          }),
        ],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: 'done' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: manager,
      todoStore,
      maxTurns: 4,
    })
    const emitted: Msg[] = []

    const reply = await runner.stepAsync(
      [{ role: 'user', content: 'continue' }],
      {
        emit: (event) => {
          emitted.push(event)
        },
      },
    )

    expect(reply).toBe('done')
    const todoResult = emitted.find(
      (event) => event.event === 'tool_result' && event.name === 'update_todos',
    )
    expect(todoResult).toMatchObject({
      event: 'tool_result',
      name: 'update_todos',
      todos: [
        {
          id: 'plan:step_1',
          plan_id: planId,
          plan_step_id: 'step_1',
          approval_generation: 1,
          content: 'Run matrix',
          status: 'completed',
        },
      ],
    })
    const finished = manager.planStore.get(planId)!
    expect(finished.steps[0]!.status).toBe('done')
    expect(finished.status).toBe('completed')
    expect(finished.completedAt).not.toBeNull()
    expect(JSON.stringify(finished.steps[0]!.evidence)).toContain(
      'todo_implementation_claim',
    )
  })

  it('does not resume an old unfinished todo list for an unrelated history question', async () => {
    const todoStore = new TodoStore()
    todoStore.todos = [
      { id: 1, content: '旧任务：继续实现页面', status: 'pending' },
    ]
    const provider = new FakeProvider([
      makeResponse({ content: '我们刚刚讨论了页面实现。' }),
      makeResponse({ content: '不应该消费这个响应' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      todoStore,
      maxTurns: 6,
    })
    const history: Msg[] = [
      { role: 'user', content: '先前的实现任务' },
      { role: 'assistant', content: '已经开始执行。' },
      { role: 'user', content: '我们刚刚说什么了1' },
    ]

    const reply = await runner.stepAsync(history)

    expect(reply).toBe('我们刚刚讨论了页面实现。')
    expect(provider.seenMessages).toHaveLength(1)
    expect(
      history.some((message) =>
        String(message.content ?? '').includes('差事尚未办妥'),
      ),
    ).toBe(false)
    expect(todoStore.todos).toHaveLength(1)
  })

  it('caps explicit todo continuation at two corrections and returns an honest partial report', async () => {
    const todoStore = new TodoStore()
    todoStore.todos = [
      { id: 1, content: '仍需完成实现', status: 'in_progress' },
    ]
    const provider = new FakeProvider([
      makeResponse({ content: '第一次误报完成。' }),
      makeResponse({ content: '第二次仍未执行。' }),
      makeResponse({ content: '全部完成。' }),
      makeResponse({ content: '不应无限续跑。' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      todoStore,
      maxTurns: 8,
    })
    const history: Msg[] = [{ role: 'user', content: '继续执行 step_1' }]

    const reply = await runner.stepAsync(history)

    expect(provider.seenMessages).toHaveLength(3)
    expect(reply).toContain('本次执行已暂停')
    expect(reply).toContain('仍需完成实现')
    expect(reply).toContain('/continue')
    expect(reply).not.toContain('全部完成')
    expect(
      history.filter((message) =>
        String(message.content ?? '').includes('差事尚未办妥'),
      ),
    ).toHaveLength(2)
  })

  it('continues a todo list created by the current prompt even without an explicit continue command', async () => {
    const todoStore = new TodoStore()
    const registry = new ToolRegistry()
    registry.register(new UpdateTodos(todoStore))
    const provider = new FakeProvider([
      makeResponse({
        content: '',
        toolCalls: [
          toolCall('todo_create', 'update_todos', {
            todos: [{ id: 1, content: '完成当前请求', status: 'pending' }],
          }),
        ],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: '先到这里。' }),
      makeResponse({
        content: '',
        toolCalls: [
          toolCall('todo_finish', 'update_todos', {
            todos: [{ id: 1, content: '完成当前请求', status: 'completed' }],
          }),
        ],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: '当前请求已完成。' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      todoStore,
      maxTurns: 8,
    })
    const history: Msg[] = [{ role: 'user', content: '创建当前功能' }]

    const reply = await runner.stepAsync(history)

    expect(reply).toContain('当前请求已完成。')
    expect(provider.seenMessages).toHaveLength(4)
    expect(
      history.filter((message) =>
        String(message.content ?? '').includes('差事尚未办妥'),
      ),
    ).toHaveLength(1)
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
      makeResponse({
        content: '',
        toolCalls: [toolCall('deny_1', 'deny_echo', {})],
        finishReason: 'tool_calls',
      }),
      makeResponse({
        content: '',
        toolCalls: [toolCall('deny_2', 'deny_echo', {})],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: 'done' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
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
      makeResponse({
        content: '',
        toolCalls: [toolCall('deny_1', 'deny_node', {})],
        finishReason: 'tool_calls',
      }),
      makeResponse({
        content: '',
        toolCalls: [toolCall('deny_2', 'deny_python', {})],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: 'done' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
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
      async execute(): Promise<string> {
        return 'Error: boom'
      }
    }
    const registry = new ToolRegistry()
    registry.register(new DeniedTool2())
    registry.register(new BoomTool())
    const provider = new FakeProvider([
      makeResponse({
        content: '',
        toolCalls: [toolCall('c1', 'deny_cmd', {}), toolCall('c2', 'boom', {})],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: 'done' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const emitted: Msg[] = []

    await runner.stepAsync([{ role: 'user', content: 'go' }], {
      emit: (event) => {
        emitted.push(event)
      },
    })

    const failures = emitted.filter(
      (event) => event.event === 'tool_run_failed',
    )
    expect(failures).toHaveLength(2)
    const byName = Object.fromEntries(
      failures.map((event) => [event.name, event]),
    )
    expect(byName.deny_cmd).toMatchObject({ reason_kind: 'safety_refusal' })
    expect(byName.boom).toMatchObject({ reason_kind: 'error' })
  })

  it('keeps a claimed Plan step active and blocks a completion reply while verification is missing', async () => {
    const manager = new ControlManager(tmp('emperor-honesty-'))
    const todoStore = new TodoStore()
    manager.setTodoStore(todoStore)
    manager.setMode('plan')
    new ProposePlanTool(manager).execute({
      title: 'Honesty plan',
      summary: 'Step carries a verification requirement.',
      plan_markdown: '# Plan\n\n- Ship it',
      assumptions: [],
      risk_level: 'low',
      steps: [
        {
          id: 'step_1',
          title: 'Ship it',
          description: 'do the work',
          files: ['a.html'],
          commands: ['npm test'],
          acceptance: ['tests pass'],
        },
      ],
    })
    const pendingHonesty = manager.payload().pending as Record<string, unknown>
    manager.approve(String(pendingHonesty.id))
    todoStore.update(
      todoStore.todos.map((todo) => ({ ...todo, status: 'completed' })),
    )
    manager.syncPlanFromTodos(todoStore.todos, {
      evidence: { source: 'update_todos' },
    })
    const provider = new FakeProvider([
      makeResponse({ content: '全部完成，交付。' }),
      makeResponse({
        content: '最终答复：step_1 的验证（npm test）未执行，声明为未验证。',
      }),
      makeResponse({ content: '不应该到第三轮' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      controlManager: manager,
      todoStore,
      maxTurns: 6,
    })
    const history: Msg[] = [{ role: 'user', content: '继续执行' }]

    const reply = await runner.stepAsync(history)

    expect(reply).toContain('本次执行已暂停')
    expect(reply).toContain('Ship it')
    expect(reply).not.toContain('全部完成')
    const followups = history.filter(
      (message) =>
        message.role === 'user' &&
        String(message.content).includes('差事尚未办妥'),
    )
    expect(followups).toHaveLength(2)
    expect(provider.responses).toHaveLength(0)
    expect(
      manager.planStore.get(
        String((pendingHonesty.meta as Record<string, unknown>).plan_id),
      ),
    ).toMatchObject({
      status: 'executing',
      steps: [expect.objectContaining({ status: 'active' })],
    })

    // 普通新问题不继承旧 lease，也不会擅自继续执行。
    const provider2 = new FakeProvider([
      makeResponse({ content: '下一轮直接完成' }),
    ])
    const runner2 = new AgentRunner({
      provider: provider2,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      controlManager: manager,
      todoStore,
    })
    const history2: Msg[] = [{ role: 'user', content: '再来一轮' }]
    const reply2 = await runner2.stepAsync(history2)
    expect(reply2).toBe('下一轮直接完成')
    expect(provider2.seenMessages).toHaveLength(1)
  })

  it('skips the honesty followup when verification evidence exists (B4.2)', async () => {
    const manager = new ControlManager(tmp('emperor-honesty-ok-'))
    const todoStore = new TodoStore()
    manager.setTodoStore(todoStore)
    manager.setMode('plan')
    new ProposePlanTool(manager).execute({
      title: 'Verified plan',
      summary: 'Verification already recorded.',
      plan_markdown: '# Plan\n\n- Ship it',
      assumptions: [],
      risk_level: 'low',
      steps: [
        {
          id: 'step_1',
          title: 'Ship it',
          description: 'work',
          files: ['a.html'],
          commands: ['npm test'],
          acceptance: ['ok'],
        },
      ],
    })
    const pendingVerified = manager.payload().pending as Record<string, unknown>
    const planId = String(
      (pendingVerified.meta as Record<string, unknown>).plan_id,
    )
    manager.approve(String(pendingVerified.id))
    manager.recordPlanVerificationResult({
      planId,
      stepId: 'step_1',
      result: { command: 'npm test', passed: true, summary: 'pass' },
    })
    todoStore.update(
      todoStore.todos.map((todo) => ({ ...todo, status: 'completed' })),
    )
    manager.syncPlanFromTodos(todoStore.todos, {
      evidence: { source: 'update_todos' },
    })
    const provider = new FakeProvider([makeResponse({ content: '完成' })])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      controlManager: manager,
      todoStore,
    })

    const reply = await runner.stepAsync([{ role: 'user', content: '继续' }])

    expect(reply).toBe('完成')
  })

  it("freezes the shrink boundary end-to-end so the prefix stays byte-stable across a turn's model calls (2026-07-05 B3)", async () => {
    class BigEchoTool extends Tool {
      override name = 'big_echo'
      override description = 'returns a long fixed result'
      override parameters = toolParamsSchema({}, [])
      execute(): string {
        return 'x'.repeat(2000)
      }
    }
    const registry = new ToolRegistry()
    registry.register(new BigEchoTool())
    const provider = new FakeProvider([
      makeResponse({
        content: '',
        toolCalls: [toolCall('c1', 'big_echo', {})],
        finishReason: 'tool_calls',
      }),
      makeResponse({
        content: '',
        toolCalls: [toolCall('c2', 'big_echo', {})],
        finishReason: 'tool_calls',
      }),
      makeResponse({
        content: '',
        toolCalls: [toolCall('c3', 'big_echo', {})],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: 'done' }),
    ])
    // keepRecent 很小，逼迫 shrink 的 cutoff 在几次迭代内就会追上第一条大结果——
    // 这正是 2026-07-05 会话里 shrunk_old_tool_results 在几乎每次调用都命中的复现条件。
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      contextPipeline: new ContextPipeline({ keepRecent: 2 }),
    })

    await runner.stepAsync([{ role: 'user', content: 'go' }])

    // messages = [system, user, ...(assistant/tool 对)...]；第一条工具结果固定在 index 3
    expect(provider.seenMessages.length).toBe(4)
    const firstToolResultAcrossCalls = provider.seenMessages
      .filter((call) => call.length > 3)
      .map((call) => call[3]!.content)
    expect(firstToolResultAcrossCalls.length).toBeGreaterThanOrEqual(2)
    // 没有 stableBoundary 时，这条消息会在某次调用从原文变成 [shrunk]，字节不再相同；
    // 冻结后它在 turn 内的每次调用里都逐字节相同。
    const distinct = new Set(firstToolResultAcrossCalls)
    expect(distinct.size).toBe(1)
    expect(String([...distinct][0])).not.toContain('[shrunk]')
  })

  it('final reply excludes interim tool-batch narration fragments (2026-07-05 B8)', async () => {
    const registry = new ToolRegistry()
    registry.register(new EchoTool())
    const provider = new FakeProvider([
      makeResponse({
        content: '先建任务清单，从 Step 1 起步。',
        toolCalls: [toolCall('c1', 'echo', { value: 'one' })],
        finishReason: 'tool_calls',
      }),
      makeResponse({
        content: 'Step 1 完成。进入 Step 2。',
        toolCalls: [toolCall('c2', 'echo', { value: 'two' })],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: '## 交付报告\n\n全部完成。' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
    })
    const history: Msg[] = [{ role: 'user', content: '干活' }]

    const reply = await runner.stepAsync(history)

    // 过场白不进最终回复（仍留在 history 与流式展示）
    expect(reply).toBe('## 交付报告\n\n全部完成。')
    expect(reply).not.toContain('先建任务清单')
    const interim = history.find(
      (message) =>
        message.role === 'assistant' &&
        String(message.content).includes('先建任务清单'),
    )
    expect(interim).toBeTruthy()
  })

  it('max_turns terminal reply is a structured delivery summary instead of the flat failure line', async () => {
    const todoStore = new TodoStore()
    todoStore.todos = [
      { id: 1, content: '实现功能', status: 'completed' },
      { id: 2, content: '补文档', status: 'pending' },
    ]
    const provider = new FakeProvider([
      makeResponse({ content: '第一轮进展：功能已实现。' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      todoStore,
      maxTurns: 1,
    })

    const reply = await runner.stepAsync([
      { role: 'user', content: '/continue' },
    ])

    expect(reply).toContain('max_turns=1')
    expect(reply).toContain('已完成 1/2')
    expect(reply).toContain('补文档')
    expect(reply).toContain('恢复')
    expect(reply).not.toContain('未办妥')
  })

  it('injects a single wrap-up reminder when the turn budget is nearly exhausted', async () => {
    const registry = new ToolRegistry()
    registry.register(new EchoTool())
    const provider = new FakeProvider([
      makeResponse({
        content: '',
        toolCalls: [toolCall('near_1', 'echo', { value: 'one' })],
        finishReason: 'tool_calls',
      }),
      makeResponse({
        content: '',
        toolCalls: [toolCall('near_2', 'echo', { value: 'two' })],
        finishReason: 'tool_calls',
      }),
      makeResponse({
        content: '',
        toolCalls: [toolCall('near_3', 'echo', { value: 'three' })],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: '收束并完成。' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      maxTurns: 5,
    })
    const history: Msg[] = [{ role: 'user', content: '执行多步检查' }]

    await runner.stepAsync(history)

    const reminders = history.filter(
      (message) =>
        message.role === 'user' &&
        String(message.content ?? '').includes('回合上限'),
    )
    expect(reminders).toHaveLength(1)
    const lastCall = provider.seenMessages[provider.seenMessages.length - 1]!
    expect(
      lastCall.some((message) =>
        String(message.content ?? '').includes('回合上限'),
      ),
    ).toBe(true)
  })

  it('does not project runtime plan context from another project scope', async () => {
    const manager = new ControlManager(
      tmp('emperor-runner-cross-project-plan-context-'),
    )
    manager.setRuntimeScope({
      sessionId: 'session_old',
      projectId: 'project_old',
      workspaceRoot: '/tmp/old-project',
    })
    const interaction = manager.createPlan({
      title: 'Old project plan',
      summary: 'This plan belongs to another project.',
      planMarkdown: '# Plan\n\n- Continue old project',
      assumptions: [],
      riskLevel: 'low',
      steps: [
        {
          id: 'step_1',
          title: 'Continue old project',
          description: 'Should not appear in the new project context.',
          commands: ['echo old'],
          acceptance: ['old only'],
        },
      ],
    })
    manager.approve(interaction.id)
    manager.setRuntimeScope({
      sessionId: 'session_new',
      projectId: 'project_new',
      workspaceRoot: '/tmp/new-project',
    })
    const provider = new FakeProvider([
      makeResponse({ content: 'new project only' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: new ToolRegistry(),
      systemPrompt: 'system',
      controlManager: manager,
      maxTurns: 1,
    })
    const emitted: Msg[] = []

    await runner.stepAsync([{ role: 'user', content: 'report files' }], {
      emit: (event) => {
        emitted.push(event)
      },
    })

    const contextEvent = emitted.find(
      (event) => event.event === 'context_projection',
    )!
    expect(
      (contextEvent.report as Record<string, unknown>).plan_context_attached,
    ).toBe(0)
    const contents = provider.seenMessages[0]!.map((message) =>
      String(message.content ?? ''),
    )
    expect(
      contents.some((content) => content.includes('[PLAN_RUNTIME_CONTEXT]')),
    ).toBe(false)
  })

  it('does not inject plan incomplete followups for active approved plan steps', async () => {
    const manager = new ControlManager(tmp('emperor-runner-plan-loop-'))
    const interaction = manager.createPlan({
      title: 'Stuck Plan',
      summary: 'Keep executing a step.',
      planMarkdown: '# Plan\n\n- Finish step',
      assumptions: [],
      riskLevel: 'low',
      steps: [
        {
          id: 'step_1',
          title: 'Finish step',
          description:
            'This step remains active to exercise followup loop protection.',
          commands: ['echo verify'],
          acceptance: ['runner does not loop forever'],
        },
      ],
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

    const reply = await runner.stepAsync(
      [{ role: 'user', content: 'continue' }],
      {
        emit: (event) => {
          emitted.push(event)
        },
        turnId: 'turn_plan_loop',
      },
    )

    expect(reply).toBe('step already done')
    expect(provider.seenMessages.length).toBe(1)
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'turn_phase', phase: 'completed' }),
      ]),
    )
    expect(
      emitted.some(
        (event) =>
          event.event === 'turn_phase' && event.phase === 'plan_followup',
      ),
    ).toBe(false)
    expect(
      emitted.some(
        (event) => event.event === 'turn_phase' && event.phase === 'max_turns',
      ),
    ).toBe(false)
    expect(
      memory.history.filter((item) => item.role === 'assistant'),
    ).toHaveLength(1)
    expect(
      memory.history.find((item) => item.role === 'assistant')!.content,
    ).toBe(reply)
  })
})

// ── test_control.py::test_runner_* (deferred from W05) ──

class MemoryFake implements MemoryStoreLike {
  checkpoint: Msg[] | null = null
  history: Array<{ role: string; content: string }> = []
  writeCheckpoint(history: Msg[]): void {
    this.checkpoint = [...history]
  }
  clearCheckpoint(): void {
    this.checkpoint = null
  }
  readCheckpoint(): Msg[] | null {
    return this.checkpoint
  }
  appendHistory(role: string, content: string): void {
    this.history.push({ role, content })
  }
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

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
      makeResponse({
        content: '',
        toolCalls: [
          toolCall('call_ask', 'ask_user', { questions: [makeQuestion()] }),
        ],
        finishReason: 'tool_calls',
      }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      memoryStore: memory,
      controlManager: manager,
      sessionId: 'session_ask_owner',
    })
    const history: Msg[] = [{ role: 'user', content: 'do work' }]
    const emitted: Msg[] = []
    await expect(
      runner.stepAsync(history, {
        emit: (e) => {
          emitted.push(e)
        },
      }),
    ).rejects.toThrow()
    expect((manager.payload().pending as Record<string, unknown>).kind).toBe(
      'ask',
    )
    expect(
      (
        (manager.payload().pending as Record<string, unknown>).meta as Record<
          string,
          unknown
        >
      ).control_session_id,
    ).toBe('session_ask_owner')
    expect(memory.readCheckpoint()).not.toBeNull()
    expect(emitted.some((e) => e.event === 'ask_request')).toBe(true)
    expect(emitted.some((e) => e.event === 'turn_paused')).toBe(true)
    expect(history[history.length - 1]!.role).toBe('tool')
    expect(String(history[history.length - 1]!.content)).toContain(
      'waiting for user',
    )
  })

  it('plan mode corrects one plain final and only a successful propose_plan creates approval', async () => {
    const manager = new ControlManager(tmp('emperor-runner-plan-'))
    manager.setRuntimeScope({ sessionId: 'session_plain_plan_owner' })
    manager.setMode('plan')
    const registry = controlRegistry(manager)
    const provider = new FakeProvider([
      makeResponse({ content: '我会先读代码，然后实现并测试。' }),
      makeResponse({
        content: '',
        toolCalls: [
          toolCall('call_plan', 'propose_plan', {
            title: '实现计划',
            summary: '完成实现并验证。',
            plan_markdown: '# 实现计划\n\n1. 修改代码\n2. 运行测试',
            assumptions: [],
            risk_level: 'low',
            steps: [
              {
                id: 'step_1',
                title: '修改并验证',
                description: '实施目标改动并运行测试。',
                files: ['src/example.ts'],
                commands: ['npm test'],
                acceptance: ['测试通过'],
              },
            ],
          }),
        ],
        finishReason: 'tool_calls',
      }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: manager,
      sessionId: 'session_plain_plan_owner',
    })
    const emitted: Msg[] = []
    await expect(
      runner.stepAsync([{ role: 'user', content: '做一个计划' }], {
        emit: (e) => {
          emitted.push(e)
        },
      }),
    ).rejects.toThrow()
    expect((manager.payload().pending as Record<string, unknown>).kind).toBe(
      'plan',
    )
    expect(
      (
        (manager.payload().pending as Record<string, unknown>).meta as Record<
          string,
          unknown
        >
      ).control_session_id,
    ).toBe('session_plain_plan_owner')
    expect(emitted.some((e) => e.event === 'plan_draft')).toBe(true)
    expect(emitted.some((e) => e.event === 'assistant_done')).toBe(false)
    expect(provider.seenMessages).toHaveLength(2)
    expect(JSON.stringify(provider.seenMessages[1])).toContain(
      '普通最终回复不能替代计划卡',
    )
  })

  it('plan mode fails closed after two plain finals without creating a fake approval card', async () => {
    const manager = new ControlManager(tmp('emperor-runner-plan-failed-'))
    manager.setRuntimeScope({ sessionId: 'session_plan_failed' })
    manager.setMode('plan')
    const provider = new FakeProvider([
      makeResponse({ content: '先写代码。' }),
      makeResponse({ content: '计划已经说明完毕。' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry: controlRegistry(manager),
      systemPrompt: 'system',
      controlManager: manager,
      sessionId: 'session_plan_failed',
      maxTurns: 6,
    })

    await expect(
      runner.stepAsync([{ role: 'user', content: '生成计划' }]),
    ).rejects.toBeInstanceOf(PlanGenerationFailedError)
    expect(manager.payload().pending).toBeNull()
    expect(
      manager.planStore
        .list()
        .filter((plan) => plan.status === 'waiting_approval'),
    ).toHaveLength(0)
  })

  it('streams partial propose_plan arguments as plan_draft_delta events', async () => {
    const manager = new ControlManager(tmp('emperor-runner-plan-stream-'))
    manager.setMode('plan')
    const registry = controlRegistry(manager)
    const provider = new StreamingToolDeltaProvider()
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: manager,
    })
    const emitted: Msg[] = []

    await expect(
      runner.stepAsync([{ role: 'user', content: '做一个计划' }], {
        emit: (e) => {
          emitted.push(e)
        },
        turnId: 'turn-plan-stream',
      }),
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
    const provider = new FakeProvider([
      makeResponse({ content: '我直接开始改。' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: manager,
      sessionId: 'session_ask_guard_owner',
    })
    const emitted: Msg[] = []
    await expect(
      runner.stepAsync(
        [
          {
            role: 'user',
            content: '阅读项目找到问题作出修改，不要打补丁，要工程化实现',
          },
        ],
        {
          emit: (e) => {
            emitted.push(e)
          },
        },
      ),
    ).rejects.toThrow()
    expect((manager.payload().pending as Record<string, unknown>).kind).toBe(
      'ask',
    )
    expect(
      (
        (manager.payload().pending as Record<string, unknown>).meta as Record<
          string,
          unknown
        >
      ).control_session_id,
    ).toBe('session_ask_guard_owner')
    expect(emitted.some((e) => e.event === 'ask_request')).toBe(true)
  })

  it('plan guard blocks high-impact write before planning', async () => {
    const root = tmp('emperor-runner-planguard-')
    const manager = new ControlManager(root)
    const registry = new ToolRegistry()
    registry.register(
      new (class extends Tool {
        override name = 'write_file'
        override description = 'write'
        override parameters = toolParamsSchema(
          { path: S('p'), content: S('c') },
          ['path', 'content'],
        )
        override getPath(args: Record<string, unknown>): string {
          return String(args.path ?? '')
        }
        execute(): string {
          return 'wrote'
        }
      })(),
    )
    registry.register(new AskUserTool(manager))
    registry.register(new ProposePlanTool(manager))
    const provider = new FakeProvider([
      makeResponse({
        content: '',
        toolCalls: [
          toolCall('call_write', 'write_file', {
            path: 'auth.py',
            content: 'new auth',
          }),
        ],
        finishReason: 'tool_calls',
      }),
      makeResponse({ content: '我需要先进入计划模式。' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: manager,
    })
    const history: Msg[] = [
      {
        role: 'user',
        content: 'Redesign authentication architecture across modules',
      },
    ]
    await runner.stepAsync(history)
    const toolMessage = history.find((m) => m.role === 'tool')!
    expect(String(toolMessage.content)).toContain('PLAN_GUARD_REQUIRED')
    expect(String(toolMessage.content)).toContain('request_plan_mode')
    expect(String(toolMessage.content)).toContain('readonly_scopes:')
    expect(String(toolMessage.content).toLowerCase()).toMatch(
      /auth|authentication/,
    )
  })

  it('emits plan entry decision contract', async () => {
    const manager = new ControlManager(tmp('emperor-runner-decision-'))
    const registry = controlRegistry(manager)
    const provider = new FakeProvider([
      makeResponse({ content: '我会先说明需要计划。' }),
    ])
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: manager,
    })
    const emitted: Msg[] = []
    await expect(
      runner.stepAsync(
        [
          {
            role: 'user',
            content:
              'Add a dashboard feature with UI state management and tests',
          },
        ],
        {
          emit: (e) => {
            emitted.push(e)
          },
        },
      ),
    ).rejects.toThrow()
    const decisionEvent = emitted.find(
      (e) => e.event === 'plan_entry_decision',
    )!
    expect(decisionEvent.decision).toBe('recommended')
    expect(decisionEvent.triggers).toEqual(['feature', 'multi_step'])
    expect(
      (decisionEvent.recommended_readonly_scopes as unknown[]).length,
    ).toBeGreaterThan(0)
    expect(
      (decisionEvent.suggested_questions as unknown[]).length,
    ).toBeGreaterThan(0)
  })

  it('answer resume injects user message', async () => {
    const manager = new ControlManager(tmp('emperor-runner-resume-'))
    const interaction = manager.createAsk({ questions: [makeQuestion()] })
    const resume = manager.answer(interaction.id, {
      scope: { choice: '最小', freeform: '' },
    })
    const provider = new FakeProvider([makeResponse({ content: 'resumed' })])
    const registry = controlRegistry(manager)
    const history: Msg[] = [{ role: 'user', content: resume.message }]
    const runner = new AgentRunner({
      provider,
      model: 'fake',
      registry,
      systemPrompt: 'system',
      controlManager: manager,
    })
    expect(await runner.stepAsync(history)).toBe('resumed')
    const lastSeen = provider.seenMessages[provider.seenMessages.length - 1]!
    expect(
      lastSeen.some((m) =>
        String((m as Record<string, unknown>).content).includes('ASK_ANSWERED'),
      ),
    ).toBe(true)
  })
})
