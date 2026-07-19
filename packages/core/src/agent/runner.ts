/**
 * AgentRunner 回合状态机 (MIG-CORE-008/009)。对齐 Python `agent/runner.py`。
 * 单轮执行、工具循环、并发执行、plan guard / ask guard、暂停/checkpoint、query_state 恢复。
 * 不变量: INV-001 (tool_use↔tool_result 配对)、INV-002 (高影响命令审批)。
 * 未迁移波次的协作者（memory/W06、tokenTracker/W06、compactor/W06、runtime task/W14）以 null 守卫。
 */
import { dirname } from 'node:path'
import {
  isTruncated,
  shouldExecuteTools,
  toOpenAiToolCall,
  type ChatArgs,
  type LLMProvider,
  type LLMResponse,
  type ToolCallRequest,
} from '../providers/base'
import {
  ContextPipeline,
  ToolResultStore,
  type GoalContextProvider,
  type PlanContextProvider,
} from '../context/pipeline'
import type { ToolRegistry } from '../tools/registry'
import { ToolResultObj, type Tool, type ToolDefinition } from '../tools/base'
import { ToolExecutionEngine } from '../tools/execution'
import { TurnPaused } from '../control/exceptions'
import { parsePauseResult } from '../control/tools'
import type { Interaction } from '../control/models'
import { PlanContextBuilder } from '../plans/context'
import { PlanStatus, type PlanRecord } from '../plans/models'
import type { PlanStore } from '../plans/store'
import {
  latestPromptProjection,
  writePromptSnapshot,
  type PromptContextPlan,
  type PromptSectionInput,
} from '../prompts/manifest'
import {
  PromptProjectionTracker,
  type PromptProjectionSnapshot,
} from '../prompts/projection'
import type { PromptPrefetchReport } from '../prompts/prefetch'
import {
  readTurnCheckpoint,
  type CheckpointWriteOptions,
} from '../sessions/checkpoint'
import {
  TransitionReason,
  beginIteration,
  emptyResponseRetry,
  lengthRecovery,
  makeQueryState,
  markCompleted,
  markPaused,
  maxTurnsReached,
  nearMaxTurns,
  todoFollowup,
  toolFollowup,
  type QueryState,
} from './query-state'
import { TurnPhase, TurnState } from './turn-state'
import {
  createModelPolicyTurnState,
  ModelCaller,
  type ModelCallPolicy,
  type ModelCallMeta,
  type ModelPolicyTurnState,
  type RunnerModelHost,
} from './model-caller'
import type { ModelPricing } from '../config/model-config'
import { CancelledTaskError } from '../runtime/active'
import { SamplingCoordinator } from '../sampling/coordinator'
import type {
  FileCheckpointCaptureInput,
  FileCheckpointRecord,
} from '../checkpoints/file-checkpoints'
import { ContextOverflowError, EmperorError } from '../errors'
import { isContextOverflowProviderError } from '../providers/errors'
import type {
  HookAggregateDecision,
  HookEventName,
  HookRuntimeRunOptions,
} from '../hooks'
import * as runtimeEvents from './runtime-events'
import {
  applyRepeatedRefusalNudge,
  buildMaxTurnsSummary,
  contextUsedFromUsage,
  controlInteractionEvent,
  estimateMessagesTokens,
  latestUserText,
  optionalInt,
  planDecisionContract,
  planGuardMessage,
  renderTodos,
  summarizeToolResult,
} from './runner-helpers'
import { toolIntentThought, toolResultSummaryThought } from './runner-thoughts'
import {
  maybePauseForControl,
  pauseForClarification,
  pauseForPlan,
} from './runner-pause'
import {
  planIndependentVerificationFollowup,
  planVerificationFollowup,
  planVerificationTarget,
  recordPlanDiscovery,
  recordPlanStepToolOutput,
  recordPlanVerification,
  unverifiedPlanHonestyFollowup,
} from './runner-plan-recording'
import type { ExecutionEnvironment } from '../environment/snapshot'
import {
  recordRunnerGoalToolResult,
  recordRunnerPlanVerificationReceipt,
  type RunnerGoalRecordingHost,
} from './runner-goal-recording'
import { filterGoalToolDefinitions, type GoalToolHost } from '../goals/tools'

type StreamEmitter = (event: Record<string, unknown>) => void | Promise<void>
type Msg = Record<string, unknown>

const MAX_EMPTY_RETRIES = 2
const MAX_LENGTH_RECOVERIES = 3
const ASK_GUARD_BLOCK =
  'Error: Ask Guard requires `ask_user` before this high-impact action. ' +
  'Use read-only tools if needed, then ask the user to resolve the ambiguity.'

// ── 协作者接口（null 守卫；真实实现来自后续波次）──

export interface MemoryStoreLike {
  memoryDir?: string
  checkpointFile?: string
  versions?: { list(opts?: { limit?: number; target?: unknown }): unknown[] }
  writeCheckpoint(history: Msg[], opts?: CheckpointWriteOptions): void
  clearCheckpoint(): void
  readCheckpoint(): Msg[] | null
  appendHistory(
    role: string,
    content: string,
    opts?: { extra?: Record<string, unknown> | null },
  ): void
}

export interface AgentRunnerInterjectionHost {
  consume():
    Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>
  tombstonePartial(record: {
    turnId: string | null
    content: string
    reason: 'interjected' | 'cancelled' | 'model_failed'
  }): void | Promise<void>
}

export interface TokenTrackerLike {
  record(
    model: string,
    usage: Record<string, number>,
    opts: Record<string, unknown>,
  ): void
  shouldCompact(maxContext: number, threshold: number): boolean
  lastInputTokensValue?(): number
}

export interface CompactorLike {
  compactAfterTurn?(opts: {
    history: Msg[]
    turnId: string | null
    currentTokens: number
    maxContext: number
    goalHint?: {
      readonly goalId: string
      readonly lastEventSeq: number
    } | null
  }): Promise<unknown> | unknown
  compactAsync?(history: Msg[]): Promise<Msg[]>
  compact?(history: Msg[]): Msg[]
}

export interface TodoStoreLike {
  todos: Array<Record<string, unknown>>
}

/** runner 需要的 ControlManager 表面（W05）。全部可选/容错调用。 */
export interface ControlManagerRunnerHost {
  planStore?: PlanStore
  systemPrompt(): string
  toolDefinitions(registry: ToolRegistry): ToolDefinition[]
  assessPermission(
    name: string,
    args: Record<string, unknown>,
    registry: ToolRegistry | null,
  ): {
    allowed: boolean
    requiresApproval: boolean
    reason: string
    risk?: string
    rule?: string
    trace?: Array<{ rule: string; outcome: string; detail: string }>
    arguments?: Record<string, unknown> | null
    toolName?: string
  }
  permissionApprovalResult(
    decision: unknown,
    opts?: { parentCallId?: string | null; sessionId?: string | null },
  ): string
  assessClarification(history: Msg[]): {
    required: boolean
    reason: string
    questions: Array<Record<string, unknown>>
    categories: string[]
  }
  assessPlanDecision?(userMessage: string): unknown
  shouldEnforcePlanFinal(): boolean
  createAsk(opts: {
    questions: Array<Record<string, unknown>>
    context?: string
    meta?: Record<string, unknown> | null
  }): Interaction
  createPlanFromText(
    text: string,
    meta?: Record<string, unknown> | null,
  ): Interaction
  recordPlanDiscovery?(opts: Record<string, unknown>): unknown
  recordPlanStepToolOutput?(opts: Record<string, unknown>): unknown
  claimUnverifiedPlanSteps?(): {
    planId: string
    steps: Array<{ id: string; title: string }>
  } | null
  planMatchesCurrentScope?(record: PlanRecord): boolean
  planIndependentVerificationFollowup?(opts?: {
    dispatchAvailable?: boolean
  }): Record<string, unknown> | null
  planVerificationTarget?(command: string): Record<string, string> | null
  recordPlanVerificationResult?(opts: {
    planId: string
    stepId: string
    result: Record<string, unknown>
  }): PlanRecord | null
}

const EMPTY_CLARIFICATION = {
  required: false,
  reason: '',
  questions: [] as Array<Record<string, unknown>>,
  categories: [] as string[],
}
type Clarification = typeof EMPTY_CLARIFICATION

function clarificationPrompt(c: Clarification): string {
  if (!c.required) return ''
  return [
    '# Ask Guard',
    '当前用户任务存在会影响实现路径的高影响歧义。你可以先使用只读工具理解项目，但在进行写入、派遣子代理、Agent Team 写操作或给出最终答复前，必须调用 `ask_user`。',
    `触发原因：${c.reason}`,
    '推荐问题已经由策略层给出；如你要提问，请直接围绕这些问题调用 `ask_user`，不要用普通文字询问。',
  ].join('\n')
}

const FILE_CHECKPOINT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'delete_file',
  'rename_file',
])

function managedCheckpointPaths(
  call: ToolCallRequest,
  tool: Tool | undefined,
): string[] {
  if (!FILE_CHECKPOINT_TOOLS.has(call.name) || !tool) return []
  const paths =
    typeof tool.getPaths === 'function'
      ? tool.getPaths(call.arguments)
      : typeof tool.getPath === 'function'
        ? [tool.getPath(call.arguments)]
        : [call.arguments.path]
  return [
    ...new Set(paths.map((path) => String(path ?? '').trim()).filter(Boolean)),
  ]
}

export interface AgentRunnerOptions {
  provider: LLMProvider
  model: string
  registry: ToolRegistry
  systemPrompt: string
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string | null
  pricing?: ModelPricing | null
  providerName?: string | null
  modelEntryId?: string
  supportsToolCall?: boolean
  routeReason?: string
  routeEstimatedTokens?: number | null
  usageType?: string
  modelPolicy?: ModelCallPolicy | null
  memoryStore?: MemoryStoreLike | null
  tokenTracker?: TokenTrackerLike | null
  compactor?: CompactorLike | null
  todoStore?: TodoStoreLike | null
  controlManager?: ControlManagerRunnerHost | null
  maxContext?: number
  compactThreshold?: number
  autoCompact?: boolean
  maxTurns?: number | null
  contextPipeline?: ContextPipeline | null
  toolExecutionEngine?: ToolExecutionEngine | null
  workspaceRoot?: string | null
  promptSections?: PromptSectionInput[] | null
  promptContextPlan?: PromptContextPlan | null
  promptSnapshotDir?: string | null
  sessionId?: string | null
  taskId?: string | null
  subagentDepth?: number
  tokenBudget?: number | null
  streamingToolExecution?: boolean
  hooks?: AgentRunnerHookHost | null
  goalObservationRecorder?: RunnerGoalRecordingHost | null
  goalToolHost?: Pick<GoalToolHost, 'visibleToolNames'> | null
  goalContextProvider?: GoalContextProvider | null
  goalContextHint?:
    | (() => Promise<{
        readonly goalId: string
        readonly lastEventSeq: number
      } | null>)
    | null
  onGoalCompacted?: (() => void) | null
  fileCheckpoints?: FileCheckpointCaptureHost | null
}

export interface FileCheckpointCaptureHost {
  capture<T>(
    input: FileCheckpointCaptureInput,
    effect: () => Promise<T> | T,
  ): Promise<{ value: T; checkpoint: FileCheckpointRecord | null }>
}

export class AgentTokenBudgetExceededError extends EmperorError {
  constructor(budget: number, used: number) {
    super(
      `Agent token budget exceeded (${used}/${budget}).`,
      'agent_token_budget_exceeded',
    )
  }
}

export interface AgentRunnerHookHost {
  run(
    eventName: HookEventName,
    opts: HookRuntimeRunOptions,
    emit?: StreamEmitter | null,
  ): Promise<HookAggregateDecision> | HookAggregateDecision
  mayMatch?(eventName: HookEventName, opts: HookRuntimeRunOptions): boolean
}

export class AgentRunner implements RunnerModelHost {
  private readonly samplingCoordinator = new SamplingCoordinator()
  provider: LLMProvider
  model: string
  registry: ToolRegistry
  systemPrompt: string
  maxTokens: number
  temperature: number
  reasoningEffort: string | null
  pricing: ModelPricing | null
  providerName: string | null
  modelEntryId: string
  supportsToolCall: boolean
  routeReason: string
  routeEstimatedTokens: number | null
  usageType: string
  modelPolicy: ModelCallPolicy | null
  modelPolicyTurn: ModelPolicyTurnState
  memoryStore: MemoryStoreLike | null
  tokenTracker: TokenTrackerLike | null
  compactor: CompactorLike | null
  todoStore: TodoStoreLike | null
  controlManager: ControlManagerRunnerHost | null
  maxContext: number
  compactThreshold: number
  autoCompact: boolean
  maxTurns: number | null
  contextPipeline: ContextPipeline
  toolExecutionEngine: ToolExecutionEngine
  private readonly denyRefusalCounts = new Map<string, number>()
  workspaceRoot: string | null
  promptSections: PromptSectionInput[]
  promptContextPlan: PromptContextPlan | null
  promptSnapshotDir: string | null
  sessionId: string | null
  taskId: string | null
  subagentDepth: number
  tokenBudget: number | null
  streamingToolExecution: boolean
  hooks: AgentRunnerHookHost | null
  goalObservationRecorder: RunnerGoalRecordingHost | null
  goalToolHost: Pick<GoalToolHost, 'visibleToolNames'> | null
  goalContextProvider: GoalContextProvider | null
  goalContextHint:
    | (() => Promise<{
        readonly goalId: string
        readonly lastEventSeq: number
      } | null>)
    | null
  onGoalCompacted: (() => void) | null
  fileCheckpoints: FileCheckpointCaptureHost | null
  lastEstimatedInputTokens: number | null = null
  lastContextProjectionReport: Record<string, unknown> | null = null
  lastPromptProjection: PromptProjectionSnapshot | null = null
  promptPrefetchReport: PromptPrefetchReport | null = null
  lastModelCall: ModelCallMeta
  private readonly promptProjectionTracker: PromptProjectionTracker
  private compactionFailureStreak = 0

  constructor(opts: AgentRunnerOptions) {
    this.provider = opts.provider
    this.model = opts.model
    this.registry = opts.registry
    this.systemPrompt = opts.systemPrompt
    this.maxTokens = opts.maxTokens ?? 20000
    this.temperature = opts.temperature ?? 0.1
    this.reasoningEffort = opts.reasoningEffort ?? null
    this.pricing = opts.pricing ?? null
    this.providerName = opts.providerName ?? null
    this.modelEntryId = opts.modelEntryId ?? 'unknown'
    this.supportsToolCall = opts.supportsToolCall ?? true
    this.routeReason = opts.routeReason ?? ''
    this.routeEstimatedTokens = opts.routeEstimatedTokens ?? null
    this.usageType = opts.usageType ?? 'main_agent'
    this.modelPolicy = opts.modelPolicy ?? null
    this.modelPolicyTurn = createModelPolicyTurnState()
    this.memoryStore = opts.memoryStore ?? null
    this.tokenTracker = opts.tokenTracker ?? null
    this.compactor = opts.compactor ?? null
    this.todoStore = opts.todoStore ?? null
    this.controlManager = opts.controlManager ?? null
    this.maxContext = opts.maxContext ?? 200_000
    this.compactThreshold = opts.compactThreshold ?? 0.7
    this.autoCompact = opts.autoCompact ?? true
    this.maxTurns = opts.maxTurns ?? null
    this.contextPipeline = opts.contextPipeline ?? this.defaultContextPipeline()
    this.toolExecutionEngine =
      opts.toolExecutionEngine ?? new ToolExecutionEngine(opts.registry)
    this.workspaceRoot = opts.workspaceRoot ?? null
    this.promptSections = opts.promptSections ? [...opts.promptSections] : []
    this.promptContextPlan = opts.promptContextPlan ?? null
    this.promptSnapshotDir = opts.promptSnapshotDir ?? null
    this.promptProjectionTracker = new PromptProjectionTracker(
      this.promptSnapshotDir
        ? latestPromptProjection(this.promptSnapshotDir)
        : null,
    )
    this.sessionId = opts.sessionId ?? null
    this.taskId = opts.taskId ?? null
    this.subagentDepth = Math.max(
      0,
      Math.trunc(Number(opts.subagentDepth ?? 0)),
    )
    this.tokenBudget = positiveOptionalInt(opts.tokenBudget)
    this.streamingToolExecution = opts.streamingToolExecution ?? false
    this.hooks = opts.hooks ?? null
    this.goalObservationRecorder = opts.goalObservationRecorder ?? null
    this.goalToolHost = opts.goalToolHost ?? null
    this.goalContextProvider = opts.goalContextProvider ?? null
    this.goalContextHint = opts.goalContextHint ?? null
    this.onGoalCompacted = opts.onGoalCompacted ?? null
    this.fileCheckpoints = opts.fileCheckpoints ?? null
    this.lastModelCall = {
      model: this.model,
      provider: this.providerName,
      modelEntryId: this.modelEntryId,
      routeReason: this.routeReason,
      routeEstimatedTokens: this.routeEstimatedTokens,
      estimatedInputTokens: null,
      providerRetryCount: 0,
      providerErrorKind: '',
      usedFallback: false,
      fallbackReason: '',
      costUsdNanos: null,
      turnCostUsdNanos: 0,
      costCapUsdNanos: null,
      costComplete: true,
    }
  }

  async stepStream(
    history: Msg[],
    emit: StreamEmitter,
    opts?: {
      turnId?: string | null
      signal?: AbortSignal | null
      executionEnvironment?: ExecutionEnvironment | null
      interjections?: AgentRunnerInterjectionHost | null
    },
  ): Promise<string> {
    const reply = await this.stepAsync(history, {
      emit,
      turnId: opts?.turnId ?? null,
      signal: opts?.signal ?? null,
      executionEnvironment: opts?.executionEnvironment ?? null,
      interjections: opts?.interjections ?? null,
    })
    throwIfAborted(opts?.signal ?? null)
    await emit({ event: 'assistant_done', content: reply })
    return reply
  }

  async stepAsync(
    history: Msg[],
    opts?: {
      emit?: StreamEmitter | null
      turnId?: string | null
      signal?: AbortSignal | null
      executionEnvironment?: ExecutionEnvironment | null
      interjections?: AgentRunnerInterjectionHost | null
    },
  ): Promise<string> {
    this.modelPolicyTurn = createModelPolicyTurnState()
    try {
      return await this.stepAsyncInner(history, opts)
    } finally {
      this.modelPolicyTurn = createModelPolicyTurnState()
    }
  }

  private async stepAsyncInner(
    history: Msg[],
    opts?: {
      emit?: StreamEmitter | null
      turnId?: string | null
      signal?: AbortSignal | null
      executionEnvironment?: ExecutionEnvironment | null
      interjections?: AgentRunnerInterjectionHost | null
    },
  ): Promise<string> {
    const emit = opts?.emit ?? null
    const turnId = opts?.turnId ?? null
    const signal = opts?.signal ?? null
    const executionEnvironment = opts?.executionEnvironment ?? null
    const interjections = opts?.interjections ?? null
    throwIfAborted(signal)
    this.denyRefusalCounts.clear()
    // B3（2026-07-05）：turn 内每次投影都冻结在此边界，防止压缩/裁剪回头改写本 turn 已发给模型过的字节
    const turnStartLength = history.length
    const turnState = new TurnState({ turnId })
    await this.emitTurnPhase(turnState, TurnPhase.STARTED, emit, {
      history_length: history.length,
    })
    const entryPlanDecision = this.assessPlanDecision(history)
    if (emit && entryPlanDecision !== null) {
      await emit(
        runtimeEvents.planEntryDecision(
          planDecisionContract(entryPlanDecision as never),
        ),
      )
    }
    let queryState: QueryState = makeQueryState({
      turnId,
      maxTurns: this.maxTurns,
    })
    const finalParts: string[] = []
    let honestyNudged = false
    let stopHookNudged = false
    let tokenBudgetUsed = 0
    const clarification = this.assessClarification(history)
    if (this.memoryStore !== null) {
      this.memoryStore.writeCheckpoint(history, {
        turnId,
        phase: 'user_received',
      })
      await this.emitTurnPhase(turnState, TurnPhase.CHECKPOINT, emit, {
        reason: 'turn_start',
      })
    }
    while (true) {
      throwIfAborted(signal)
      const beforeModel = await consumeRunnerInterjections(interjections)
      if (beforeModel.length) history.push(...beforeModel)
      const maxTurnsTransition = maxTurnsReached(queryState)
      if (maxTurnsTransition !== null) {
        queryState = maxTurnsTransition.nextState
        const reply = buildMaxTurnsSummary({
          maxTurns: this.maxTurns,
          todos: this.todoStore?.todos ?? [],
          plan: this.activePlanForSummary(),
          lastAssistantText: finalParts.length
            ? finalParts[finalParts.length - 1]
            : '',
        })
        const message: Msg = { role: 'assistant', content: reply }
        if (turnId) message.turn_id = turnId
        history.push(message)
        if (this.memoryStore) {
          this.memoryStore.appendHistory('assistant', reply, {
            extra: turnId ? { turn_id: turnId } : null,
          })
          this.memoryStore.clearCheckpoint()
        }
        await this.emitTurnPhase(turnState, TurnPhase.MAX_TURNS, emit, {
          max_turns: this.maxTurns,
        })
        return reply
      }
      const wrapUpWarning = nearMaxTurns(queryState)
      if (wrapUpWarning !== null) {
        queryState = wrapUpWarning.nextState
        for (const message of wrapUpWarning.messages)
          history.push({ ...message } as Msg)
      }
      queryState = beginIteration(queryState).nextState
      turnState.startIteration()

      await this.emitTurnPhase(turnState, TurnPhase.MODEL_REQUEST, emit)
      const streamingTools =
        this.streamingToolExecution && !interjections
          ? this.beginStreamingTools(
              emit,
              clarification,
              signal,
              entryPlanDecision,
              executionEnvironment,
              turnId,
            )
          : null
      let response: LLMResponse
      let streamedPartial = ''
      const modelEmit =
        emit || interjections
          ? async (event: Record<string, unknown>) => {
              if (event.event === 'message_delta')
                streamedPartial += String(event.delta ?? '')
              if (emit) await emit(event)
            }
          : null
      try {
        response = await this.askModel(
          history,
          modelEmit,
          clarification,
          signal,
          turnId,
          turnStartLength,
          streamingTools?.onToolCallComplete ?? null,
        )
        throwIfAborted(signal)
      } catch (error) {
        await streamingTools?.cancel('model_request_failed')
        if (streamedPartial && interjections) {
          const reason = signal?.aborted ? 'cancelled' : 'model_failed'
          await interjections.tombstonePartial({
            turnId,
            content: streamedPartial,
            reason,
          })
          if (emit)
            await emit(
              runtimeEvents.messageTombstoned({
                reason,
                contentChars: streamedPartial.length,
              }),
            )
        }
        throw error
      }
      if (streamingTools && !shouldExecuteTools(response))
        await streamingTools.cancel('not_in_final_response')
      await this.emitTurnPhase(turnState, TurnPhase.MODEL_RESPONSE, emit, {
        finish_reason: response.finishReason,
        tool_call_count: response.toolCalls.length,
        content_chars: (response.content ?? '').length,
      })
      const superseding = await consumeRunnerInterjections(interjections)
      if (superseding.length) {
        await streamingTools?.cancel('interjected')
        const partial = String(response.content ?? streamedPartial)
        if (partial) {
          await interjections!.tombstonePartial({
            turnId,
            content: partial,
            reason: 'interjected',
          })
          if (emit)
            await emit(
              runtimeEvents.messageTombstoned({
                reason: 'interjected',
                contentChars: partial.length,
              }),
            )
        }
        history.push(...superseding)
        finalParts.length = 0
        continue
      }
      if (response.usage && Object.keys(response.usage).length) {
        const callMeta = this.lastModelCall
        const projectionReport = this.lastContextProjectionReport ?? {}
        if (this.tokenTracker) {
          this.tokenTracker.record(
            String(callMeta.model || this.model),
            response.usage,
            {
              provider: String(
                callMeta.provider || this.providerName || 'unknown',
              ),
              usageType: this.usageType,
              modelEntryId: String(callMeta.modelEntryId || this.modelEntryId),
              routeReason: String(
                callMeta.routeReason || this.routeReason || '',
              ),
              estimatedInputTokens: optionalInt(callMeta.estimatedInputTokens),
              routeEstimatedTokens: optionalInt(callMeta.routeEstimatedTokens),
              costUsdNanos: callMeta.costUsdNanos,
              costCapUsdNanos: callMeta.costCapUsdNanos,
              costComplete: callMeta.costComplete,
              usedFallback: callMeta.usedFallback,
              fallbackReason: callMeta.fallbackReason || null,
            },
          )
        }
        if (emit) {
          const cacheReadTokens = Math.max(
            0,
            Math.trunc(
              Number(
                response.usage.cache_read ??
                  response.usage.cache_read_input_tokens ??
                  0,
              ) || 0,
            ),
          )
          const cacheCreateTokens = Math.max(
            0,
            Math.trunc(
              Number(
                response.usage.cache_create ??
                  response.usage.cache_creation_input_tokens ??
                  0,
              ) || 0,
            ),
          )
          await emit({
            event: 'context_usage',
            used: contextUsedFromUsage(response.usage),
            max: this.maxContext,
            threshold: Math.trunc(this.maxContext * this.compactThreshold),
            usage_type: this.usageType,
            model_entry_id: callMeta.modelEntryId,
            model: callMeta.model,
            provider: callMeta.provider,
            route_reason: callMeta.routeReason,
            estimated_input_tokens: callMeta.estimatedInputTokens,
            provider_retry_count:
              optionalInt(callMeta.providerRetryCount) ?? undefined,
            provider_error_kind: callMeta.providerErrorKind || undefined,
            used_fallback: callMeta.usedFallback || undefined,
            fallback_reason: callMeta.fallbackReason || undefined,
            cost_usd_nanos: callMeta.costUsdNanos ?? undefined,
            turn_cost_usd_nanos: callMeta.turnCostUsdNanos,
            cost_cap_usd_nanos: callMeta.costCapUsdNanos ?? undefined,
            cost_complete: callMeta.costComplete,
            replaced_tool_results:
              optionalInt(projectionReport.replaced_tool_results) ?? undefined,
            aggregate_replaced_tool_results:
              optionalInt(projectionReport.aggregate_replaced_tool_results) ??
              undefined,
            aggregate_tool_result_budget:
              optionalInt(projectionReport.aggregate_tool_result_budget) ??
              undefined,
            cache_read_tokens: cacheReadTokens,
            cache_create_tokens: cacheCreateTokens,
            prompt_cache_hit: cacheReadTokens > 0,
            stable_prefix_hash:
              this.lastPromptProjection?.stablePrefix.hash ?? undefined,
            cache_break_classification:
              this.lastPromptProjection?.cacheBreak.classification ?? undefined,
            cache_break_reason:
              this.lastPromptProjection?.cacheBreak.reasonCode ?? undefined,
          })
        }
      }
      tokenBudgetUsed += modelUsageTokens(response.usage)
      if (this.tokenBudget !== null && tokenBudgetUsed > this.tokenBudget) {
        await streamingTools?.cancel('token_budget_exceeded')
        throw new AgentTokenBudgetExceededError(
          this.tokenBudget,
          tokenBudgetUsed,
        )
      }
      if (this.memoryStore) {
        const lastUser = [...history].reverse().find((m) => m.role === 'user')
        const userInput = lastUser
          ? String(lastUser.content ?? '').slice(0, 500)
          : ''
        const aiOutput = String(response.content ?? '').slice(0, 500)
        let cmdEvent: string | null = null
        if (userInput.startsWith('/'))
          cmdEvent = userInput.split(/\s+/)[0] ?? null
        const inputTokens = response.usage
          ? Number(response.usage.input ?? 0) || 0
          : 0
        const outputTokens = response.usage
          ? Number(response.usage.output ?? 0) || 0
          : 0
        this.memoryStore.appendHistory(
          'model_call',
          `${this.lastModelCall.model || this.model} call: input=${inputTokens} output=${outputTokens}`,
          {
            extra: {
              type: 'model_call',
              model: this.lastModelCall.model || this.model,
              provider: this.lastModelCall.provider || this.providerName,
              model_entry_id:
                this.lastModelCall.modelEntryId || this.modelEntryId,
              route_reason: this.lastModelCall.routeReason || this.routeReason,
              estimated_input_tokens: this.lastModelCall.estimatedInputTokens,
              route_estimated_tokens: this.lastModelCall.routeEstimatedTokens,
              usage_type: this.usageType,
              user_input: userInput,
              ai_output: aiOutput,
              command_event: cmdEvent,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              used_fallback: this.lastModelCall.usedFallback,
              fallback_reason: this.lastModelCall.fallbackReason || null,
              cost_usd_nanos: this.lastModelCall.costUsdNanos,
              turn_cost_usd_nanos: this.lastModelCall.turnCostUsdNanos,
              cost_cap_usd_nanos: this.lastModelCall.costCapUsdNanos,
              cost_complete: this.lastModelCall.costComplete,
              ...(turnId ? { turn_id: turnId } : {}),
            },
          },
        )
      }

      if (shouldExecuteTools(response)) {
        queryState = toolFollowup(queryState).nextState
        const assistantContent = response.content ?? ''
        // B8：伴随工具批次的过场白只进 history 与流式展示，不进最终回复
        // （2026-07-05 会话的交付报告被 19 段「Step N 完成。」碎片淹没）
        const assistantMessage: Msg = {
          role: 'assistant',
          content: assistantContent,
          tool_calls: response.toolCalls.map((call) => toOpenAiToolCall(call)),
        }
        if (turnId) assistantMessage.turn_id = turnId
        if (response.reasoningContent !== null)
          assistantMessage.reasoning_content = response.reasoningContent
        else if (this.reasoningEnabled())
          assistantMessage.reasoning_content = ''
        if (response.thinkingBlocks)
          assistantMessage.thinking_blocks = response.thinkingBlocks
        history.push(assistantMessage)
        await this.emitAgentThought(toolIntentThought(response.toolCalls), emit)
        await this.emitTurnPhase(turnState, TurnPhase.TOOL_BATCH_START, emit, {
          count: response.toolCalls.length,
          names: response.toolCalls.map((call) => call.name),
        })
        let toolMessages: Msg[]
        try {
          const planDecision = this.assessPlanDecision(history)
          toolMessages = streamingTools
            ? await streamingTools.finish(response.toolCalls, planDecision)
            : await this.executeToolCalls(
                response.toolCalls,
                emit,
                clarification,
                planDecision,
                signal,
                executionEnvironment,
                turnId,
              )
          throwIfAborted(signal)
        } catch (pause) {
          if (!(pause instanceof TurnPaused)) throw pause
          history.push(...pause.toolMessages)
          if (this.memoryStore !== null)
            this.memoryStore.writeCheckpoint(history, {
              turnId,
              phase: 'tool_calls_pending',
            })
          await this.emitTurnPhase(turnState, TurnPhase.PAUSED, emit, {
            kind: pause.interaction.kind,
            interaction_id: pause.interaction.id,
            source: 'tool',
          })
          if (emit) {
            for (const msg of pause.toolMessages) {
              if (msg.tool_call_id === pause.interaction.parent_call_id) {
                await emit({
                  event: 'tool_result',
                  id: msg.tool_call_id,
                  name: msg.name,
                  summary: msg.content,
                })
                break
              }
            }
            await emit(controlInteractionEvent(pause.interaction))
            await emit({ event: 'turn_paused', interaction: pause.interaction })
          }
          throw pause
        }
        history.push(...toolMessages)
        await this.emitTurnPhase(turnState, TurnPhase.TOOL_BATCH_DONE, emit, {
          count: toolMessages.length,
        })
        if (this.memoryStore !== null) {
          this.memoryStore.writeCheckpoint(history, {
            turnId,
            phase: 'tool_calls_completed',
          })
          await this.emitTurnPhase(turnState, TurnPhase.CHECKPOINT, emit, {
            reason: 'tool_batch',
          })
        }
        continue
      }

      const reply = response.content ?? ''

      // 空响应救援
      if (!reply.trim() && !response.toolCalls.length) {
        const t = emptyResponseRetry(queryState, {
          maxRetries: MAX_EMPTY_RETRIES,
        })
        if (t !== null) {
          queryState = t.nextState
          history.push(...t.messages)
          await this.emitTurnPhase(turnState, TurnPhase.EMPTY_RETRY, emit, {
            attempt: queryState.emptyRetries,
            max: MAX_EMPTY_RETRIES,
          })
          if (emit) for (const event of t.events) await emit(event)
          continue
        }
      }

      // 截断续写
      if (isTruncated(response.finishReason)) {
        const t = lengthRecovery(queryState, reply, {
          maxRetries: MAX_LENGTH_RECOVERIES,
        })
        if (t !== null) {
          queryState = t.nextState
          if (reply) finalParts.push(reply)
          history.push(...t.messages)
          await this.emitTurnPhase(turnState, TurnPhase.LENGTH_RETRY, emit, {
            attempt: queryState.lengthRetries,
            max: MAX_LENGTH_RECOVERIES,
          })
          if (emit) for (const event of t.events) await emit(event)
          continue
        }
      }

      if (clarification.required && reply.trim()) {
        queryState = markPaused(
          queryState,
          TransitionReason.ASK_PAUSE,
        ).nextState
        await this.emitTurnPhase(turnState, TurnPhase.PAUSED, emit, {
          kind: 'ask',
          source: 'clarification',
        })
        await pauseForClarification(this, history, clarification, emit, turnId)
      }

      if (this.mustPauseForPlan()) {
        queryState = markPaused(
          queryState,
          TransitionReason.PLAN_PAUSE,
        ).nextState
        await this.emitTurnPhase(turnState, TurnPhase.PAUSED, emit, {
          kind: 'plan',
          source: 'plan_final',
        })
        await pauseForPlan(this, history, reply, emit, turnId)
      }

      finalParts.push(reply)
      const finalReply = finalParts.join('')
      const assistantMessage: Msg = { role: 'assistant', content: reply }
      if (turnId) assistantMessage.turn_id = turnId
      if (response.reasoningContent !== null)
        assistantMessage.reasoning_content = response.reasoningContent
      else if (this.reasoningEnabled()) assistantMessage.reasoning_content = ''
      if (response.thinkingBlocks)
        assistantMessage.thinking_blocks = response.thinkingBlocks
      history.push(assistantMessage)

      if (this.todoStore && this.todoStore.todos.length) {
        const unfinished = this.todoStore.todos.filter(
          (t) => t.status !== 'completed',
        )
        if (unfinished.length) {
          const t = todoFollowup(queryState, {
            unfinishedText: renderTodos(unfinished),
            unfinishedCount: unfinished.length,
          })
          queryState = t.nextState
          history.push(...t.messages)
          await this.emitTurnPhase(turnState, TurnPhase.TODO_FOLLOWUP, emit, {
            unfinished: unfinished.length,
          })
          continue
        }
        this.todoStore.todos = []
      }

      const verificationFollowup = planIndependentVerificationFollowup(
        this.controlManager,
        this.registry,
      )
      if (verificationFollowup !== null) {
        history.push({
          role: 'user',
          content: String(verificationFollowup.message),
        })
        await this.emitTurnPhase(turnState, TurnPhase.PLAN_FOLLOWUP, emit, {
          plan_id: verificationFollowup.plan_id,
          verification: verificationFollowup.status,
        })
        continue
      }

      // B4.2 收尾诚实性：验证要求无证据时一次性拦下 stop，要求执行验证或明确申报未验证
      if (!honestyNudged) {
        const honesty = unverifiedPlanHonestyFollowup(this.controlManager)
        if (honesty !== null) {
          honestyNudged = true
          history.push(honesty)
          await this.emitTurnPhase(turnState, TurnPhase.PLAN_FOLLOWUP, emit, {
            honesty: 'verification_unrecorded',
          })
          continue
        }
      }

      const stopDecision = await this.runHookEvent(
        'Stop',
        {
          sessionId: this.sessionId ?? '',
          cwd: this.workspaceRoot ?? process.cwd(),
          lastAssistantMessage: finalReply,
          stopHookActive: stopHookNudged,
        },
        emit,
      )
      if (
        (stopDecision.continue === true ||
          stopDecision.decision === 'deny' ||
          stopDecision.decision === 'ask') &&
        !stopHookNudged
      ) {
        stopHookNudged = true
        const continuation = `[Stop hook] ${stopDecision.stopReason || stopDecision.reason || 'Continue until the stop hook passes.'}`
        history.push({
          role: 'user',
          content: continuation,
          ui_hidden: true,
          ...(turnId ? { turn_id: turnId } : {}),
        })
        this.memoryStore?.appendHistory('user', continuation, {
          extra: {
            ...(turnId ? { turn_id: turnId } : {}),
            ui_hidden: true,
            hook_event_name: 'Stop',
          },
        })
        await this.emitTurnPhase(turnState, TurnPhase.PLAN_FOLLOWUP, emit, {
          hook: 'Stop',
          decision: stopDecision.decision,
        })
        continue
      }

      if (this.memoryStore !== null) {
        this.memoryStore.appendHistory('assistant', finalReply, {
          extra: turnId ? { turn_id: turnId } : null,
        })
        this.memoryStore.clearCheckpoint()
      }
      await this.emitTurnPhase(turnState, TurnPhase.COMPACT_CHECK, emit)
      await this.maybeCompact(history, emit, turnId)
      queryState = markCompleted(queryState).nextState
      await this.emitTurnPhase(turnState, TurnPhase.COMPLETED, emit, {
        content_chars: finalReply.length,
      })
      // COMPLETED here is a single model turn. Goal terminal truth is owned
      // exclusively by GoalCompletionGate.complete(), never by final prose or
      // a permissive Stop hook.
      return finalReply
    }
  }

  private async emitTurnPhase(
    state: TurnState,
    phase: TurnPhase,
    emit: StreamEmitter | null,
    detail?: Record<string, unknown> | null,
  ): Promise<void> {
    const event = state.transition(phase, { detail: detail ?? null })
    if (emit) await emit(event.toRuntimeEvent())
  }

  private async askModel(
    history: Msg[],
    emit: StreamEmitter | null,
    clarification: Clarification | null,
    signal: AbortSignal | null,
    turnId: string | null,
    stableBoundary: number,
    onToolCallComplete?:
      ((call: ToolCallRequest) => void | Promise<void>) | null,
  ): Promise<LLMResponse> {
    try {
      return await this.callModelWithProjection(
        history,
        emit,
        clarification,
        signal,
        turnId,
        false,
        stableBoundary,
        onToolCallComplete,
      )
    } catch (exc) {
      if (!isContextOverflowProviderError(exc)) throw exc
      if (emit) {
        await emit({
          event: 'record_degraded',
          kind: 'context_overflow',
          reason: String(exc instanceof Error ? exc.message : exc).slice(
            0,
            500,
          ),
          taskId: turnId ?? undefined,
        })
      }
      const emergencyHook = await this.runHookEvent(
        'PreCompact',
        {
          sessionId: this.sessionId ?? '',
          cwd: this.workspaceRoot ?? process.cwd(),
          trigger: 'emergency',
        },
        emit,
      )
      if (
        emit &&
        (emergencyHook.decision === 'deny' || emergencyHook.decision === 'ask')
      ) {
        await emit({
          event: 'hook_emergency_compaction_bypass',
          event_name: 'PreCompact',
          decision: emergencyHook.decision,
          reason: emergencyHook.reason,
        })
      }
      try {
        // 紧急收缩重试：优先保证挤进上下文窗口，不冻结边界（放弃本次缓存换正确性）
        const response = await this.callModelWithProjection(
          history,
          emit,
          clarification,
          signal,
          turnId,
          true,
          undefined,
          onToolCallComplete,
        )
        await this.runHookEvent(
          'PostCompact',
          {
            sessionId: this.sessionId ?? '',
            cwd: this.workspaceRoot ?? process.cwd(),
            trigger: 'emergency',
            result: {
              status: 'completed',
              strategy: 'emergency_context_shrink',
            },
          },
          emit,
        )
        return response
      } catch (retryExc) {
        await this.runHookEvent(
          'PostCompact',
          {
            sessionId: this.sessionId ?? '',
            cwd: this.workspaceRoot ?? process.cwd(),
            trigger: 'emergency',
            result: {
              status: 'failed',
              error:
                retryExc instanceof Error ? retryExc.message : String(retryExc),
            },
          },
          emit,
        )
        if (!isContextOverflowProviderError(retryExc)) throw retryExc
        const options =
          retryExc instanceof Error ? { cause: retryExc } : undefined
        throw new ContextOverflowError(
          'context_overflow: model context window exceeded after emergency context shrink. Shorten the request, clear older context, or attach large outputs as files.',
          options,
        )
      }
    }
  }

  private async callModelWithProjection(
    history: Msg[],
    emit: StreamEmitter | null,
    clarification: Clarification | null,
    signal: AbortSignal | null,
    turnId: string | null,
    emergencyShrink: boolean,
    stableBoundary: number | undefined,
    onToolCallComplete?:
      ((call: ToolCallRequest) => void | Promise<void>) | null,
  ): Promise<LLMResponse> {
    const pipeline = emergencyShrink
      ? this.emergencyContextPipeline()
      : this.contextPipeline
    const projection = await pipeline.projectAsync(history as never, {
      stableBoundary,
      turnId,
    })
    let governed = projection.messages
    const report = emergencyShrink
      ? {
          ...projection.report,
          context_overflow_retry: 1,
          emergency_context_shrink: 1,
        }
      : projection.report
    if (this.promptPrefetchReport) report.prefetch = this.promptPrefetchReport
    let systemPrompt = this.systemPrompt
    const promptSections: PromptSectionInput[] = this.promptSections.length
      ? [...this.promptSections]
      : [
          {
            name: 'system',
            content: this.systemPrompt,
            source: 'AgentRunner.systemPrompt',
            priority: 100,
            budgetChars: null,
            version: null,
            stability: 'stable',
          },
        ]
    const durableContext: Array<Record<string, unknown>> = []
    while (
      governed.length &&
      governed[0]?.role === 'system' &&
      /^\[(?:GOAL|PLAN)_/.test(String(governed[0]?.content ?? ''))
    ) {
      durableContext.push(governed[0] as unknown as Record<string, unknown>)
      governed = governed.slice(1)
    }
    for (const message of durableContext) {
      const content = String(message.content ?? '')
      systemPrompt = `${systemPrompt}\n\n---\n\n${content}`
      promptSections.push({
        name: content.startsWith('[GOAL_') ? 'goal' : 'plan',
        content,
        source: content.startsWith('[GOAL_')
          ? 'GoalContextBuilder.build()'
          : 'PlanContextBuilder.messageFor()',
        priority: content.startsWith('[GOAL_') ? 70 : 60,
        budgetChars: null,
        version: null,
        stability: 'dynamic',
      })
    }
    let toolDefinitions: ToolDefinition[]
    if (this.controlManager !== null) {
      const controlPrompt = this.controlManager.systemPrompt()
      systemPrompt = `${systemPrompt}\n\n---\n\n${controlPrompt}`
      promptSections.push({
        name: 'control',
        content: controlPrompt,
        source: 'ControlManager.systemPrompt()',
        priority: 50,
        budgetChars: null,
        version: null,
        stability: 'dynamic',
      })
      if (clarification && clarification.required) {
        const askGuardPrompt = clarificationPrompt(clarification)
        systemPrompt = `${systemPrompt}\n\n---\n\n${askGuardPrompt}`
        promptSections.push({
          name: 'clarification',
          content: askGuardPrompt,
          source: 'ControlManager.assessClarification()',
          priority: 45,
          budgetChars: null,
          version: null,
          stability: 'dynamic',
        })
      }
      toolDefinitions = this.controlManager.toolDefinitions(this.registry)
    } else {
      toolDefinitions = this.registry.getDefinitions()
    }
    const visibleGoalTools = this.goalToolHost
      ? await this.goalToolHost.visibleToolNames(this.sessionId)
      : []
    toolDefinitions = filterGoalToolDefinitions(
      toolDefinitions,
      visibleGoalTools,
    )
    const snapshotMessages = [
      { role: 'system', content: systemPrompt },
      ...(governed as Array<Record<string, unknown>>),
    ]
    const promptProjection = this.promptProjectionTracker.observe({
      sessionId: this.sessionId,
      turnId: turnId ?? 'unscoped',
      sections: promptSections,
      canonicalHistory: history as Array<Record<string, unknown>>,
      projectedMessages: snapshotMessages,
      toolDefinitions: toolDefinitions as unknown as Array<
        Record<string, unknown>
      >,
      report,
    })
    this.lastPromptProjection = promptProjection
    Object.assign(report, {
      stable_prefix_hash: promptProjection.stablePrefix.hash,
      dynamic_suffix_hash: promptProjection.dynamicSuffix.hash,
      canonical_history_hash: promptProjection.canonicalHistoryHash,
      projected_messages_hash: promptProjection.projectedMessagesHash,
      cache_break_classification: promptProjection.cacheBreak.classification,
      cache_break_reason: promptProjection.cacheBreak.reasonCode,
      cache_break_first_changed: promptProjection.cacheBreak.firstChanged,
    })
    this.lastContextProjectionReport = report
    if (emit) {
      await emit(
        runtimeEvents.contextProjection({
          report,
          messageCount: governed.length,
        }),
      )
    }
    const messages: ChatArgs['messages'] = snapshotMessages.map(
      sanitizeProviderMessage,
    )
    this.lastEstimatedInputTokens = estimateMessagesTokens(
      messages as unknown as Msg[],
    )
    if (this.promptSnapshotDir && turnId) {
      try {
        const microcompact = Array.isArray(report.microcompact_records)
          ? report.microcompact_records.filter(
              (record): record is Record<string, unknown> =>
                Boolean(
                  record &&
                  typeof record === 'object' &&
                  !Array.isArray(record),
                ),
            )
          : []
        const contextPlan = microcompact.length
          ? {
              ...(this.promptContextPlan ?? {
                version: 1 as const,
                items: [],
                omitted: [],
              }),
              microcompact,
            }
          : this.promptContextPlan
        writePromptSnapshot({
          dir: this.promptSnapshotDir,
          sessionId: this.sessionId,
          turnId,
          model: this.model,
          provider: this.providerName,
          modelEntryId: this.modelEntryId,
          estimatedInputTokens: this.lastEstimatedInputTokens,
          sections: promptSections,
          contextPlan,
          messages: snapshotMessages,
          checkpoint: this.checkpointForPromptSnapshot(),
          memoryVersions: this.memoryVersionsForPromptSnapshot(),
          projection: promptProjection,
        })
      } catch {
        // Prompt snapshots are diagnostics only; never fail the model call because of them.
      }
    }
    return new ModelCaller(this, this.samplingCoordinator).ask({
      messages,
      tools: toolDefinitions as unknown as Array<Record<string, unknown>>,
      emit,
      signal,
      onToolCallComplete: onToolCallComplete ?? null,
    })
  }

  private checkpointForPromptSnapshot(): Record<string, unknown> | null {
    const checkpointFile = this.memoryStore?.checkpointFile
    if (!checkpointFile) return null
    try {
      const result = readTurnCheckpoint(checkpointFile, {
        sessionId: this.sessionId,
      })
      return result.checkpoint as unknown as Record<string, unknown> | null
    } catch {
      return null
    }
  }

  private memoryVersionsForPromptSnapshot(): Array<Record<string, unknown>> {
    const versions = this.memoryStore?.versions
    if (!versions) return []
    try {
      return versions.list({ limit: 12 }).filter(isRecord)
    } catch {
      return []
    }
  }

  /**
   * 构造单工具执行闭包，供批式（runBatch）与流式（createStreamingRun）两条路径共用。
   * toolCallsRef/planDecisionRef 为可变引用：流式路径在 finish() 时才知道完整 toolCalls 与 planDecision。
   */
  private buildToolRunOne(ctx: {
    toolCallsRef: { current: ToolCallRequest[] }
    planDecisionRef: { current: unknown }
    emit: StreamEmitter | null
    clarification: Clarification | null
    signal: AbortSignal | null
    executionEnvironment: ExecutionEnvironment | null
    turnId: string | null
  }): {
    runOne: (
      call: ToolCallRequest,
      childSignal: AbortSignal,
    ) => Promise<ToolResultObj>
    resultsById: Map<string, ToolResultObj>
    planFollowups: Msg[]
  } {
    const { emit, clarification, executionEnvironment } = ctx
    const resultsById = new Map<string, ToolResultObj>()
    const planFollowups: Msg[] = []

    const runOne = async (
      call: ToolCallRequest,
      childSignal: AbortSignal,
    ): Promise<ToolResultObj> => {
      throwIfAborted(childSignal)
      await this.emitToolCall(call, emit)
      const outcome = await this.executeToolWithHooks(
        call,
        emit,
        clarification,
        ctx.planDecisionRef.current,
        childSignal,
        executionEnvironment,
        ctx.turnId,
      )
      const result = outcome.result
      const executedCall = outcome.executedCall ?? call
      const verificationTarget = outcome.verificationTarget ?? null
      throwIfAborted(childSignal)
      applyRepeatedRefusalNudge(this.denyRefusalCounts, result)
      recordPlanDiscovery(this.controlManager, call, result)
      recordPlanStepToolOutput(this.controlManager, call, result)
      const content = result.modelContent
      resultsById.set(call.id, result)
      const recordGoalResult = async (
        verificationUpdate: ReturnType<typeof recordPlanVerification>,
      ): Promise<void> => {
        try {
          const observation = await recordRunnerGoalToolResult(
            this.goalObservationRecorder,
            this.registry,
            {
              expectedGoalId: outcome.expectedGoalId,
              sessionId: this.sessionId ?? '',
              turnId: ctx.turnId ?? '',
              toolCallId: call.id,
              toolName: executedCall.name,
              arguments: executedCall.arguments,
              executed: outcome.executed,
              result,
            },
          )
          await recordRunnerPlanVerificationReceipt(
            this.goalObservationRecorder,
            observation,
            verificationUpdate,
          )
        } catch {
          try {
            if (emit) {
              await emit({
                event: 'record_degraded',
                kind: 'goal_observation',
                reason:
                  'Goal observation could not be persisted; completion evidence was not recorded.',
                taskId: ctx.turnId ?? undefined,
              })
            }
          } catch {
            // Persistence diagnostics are best-effort and never replace a tool result.
          }
        }
      }
      if (parsePauseResult(content) !== null) {
        await recordGoalResult(null)
      }
      maybePauseForControl(content, ctx.toolCallsRef.current, resultsById)
      const verificationUpdate = recordPlanVerification(
        this.controlManager,
        executedCall,
        result,
        verificationTarget,
      )
      if (verificationUpdate !== null && emit) {
        await emit(
          runtimeEvents.planVerificationDone({
            planId: verificationUpdate.target.plan_id!,
            stepId: verificationUpdate.target.step_id!,
            result: verificationUpdate.result,
          }),
        )
        await emit(runtimeEvents.planRuntimeUpdate(verificationUpdate.plan))
      }
      if (verificationUpdate !== null) {
        const followup = planVerificationFollowup(verificationUpdate)
        if (followup !== null) planFollowups.push(followup)
      }
      await this.emitToolResult(call, result, emit)
      await recordGoalResult(verificationUpdate)
      return result
    }

    return { runOne, resultsById, planFollowups }
  }

  /** 某工具能否在流式期间提前起跑：只读 + 并发安全 + 不会触发 Ask/Plan Guard 或权限审批。 */
  private canStartToolEarly(
    call: ToolCallRequest,
    clarification: Clarification | null,
    planDecision: unknown,
  ): boolean {
    const tool = this.registry.get(call.name)
    if (!tool || !tool.readOnly || !tool.isConcurrencySafe(call.arguments))
      return false
    let prepared: ToolCallRequest
    try {
      prepared = {
        ...call,
        arguments: this.registry.prepareCall(call.name, call.arguments),
      }
    } catch {
      return false
    }
    if (
      clarification &&
      clarification.required &&
      this.askGuardBlocksTool(call.name)
    )
      return false
    if (this.planGuardBlocksTool(prepared, planDecision)) return false
    if (this.controlManager !== null) return false
    if (this.hooks !== null) {
      if (!this.hooks.mayMatch) return false
      if (this.hooks.mayMatch('PreToolUse', this.toolHookInput(prepared)))
        return false
    }
    return true
  }

  /** 流式工具执行会话（Wave5）：onToolCallComplete 边到边入队，finish 对账。 */
  private beginStreamingTools(
    emit: StreamEmitter | null,
    clarification: Clarification | null,
    signal: AbortSignal | null,
    entryPlanDecision: unknown,
    executionEnvironment: ExecutionEnvironment | null,
    turnId: string | null,
  ): {
    onToolCallComplete: (call: ToolCallRequest) => void
    finish: (
      toolCalls: ToolCallRequest[],
      planDecision: unknown,
    ) => Promise<Msg[]>
    cancel: (reason?: string) => Promise<void>
  } {
    const toolCallsRef: { current: ToolCallRequest[] } = { current: [] }
    const planDecisionRef: { current: unknown } = { current: entryPlanDecision }
    const { runOne, resultsById, planFollowups } = this.buildToolRunOne({
      toolCallsRef,
      planDecisionRef,
      emit,
      clarification,
      signal,
      executionEnvironment,
      turnId,
    })
    const run = this.toolExecutionEngine.createStreamingRun({
      emit,
      runOne,
      signal,
      canStartEarly: (call) =>
        this.canStartToolEarly(call, clarification, planDecisionRef.current),
    })
    return {
      onToolCallComplete: (call) => run.enqueue(call),
      finish: async (toolCalls, planDecision): Promise<Msg[]> => {
        toolCallsRef.current = toolCalls
        planDecisionRef.current = planDecision
        const toolMessages = await run.finish(toolCalls)
        throwIfAborted(signal)
        const resultThought = toolResultSummaryThought(toolCalls, resultsById)
        if (resultThought) await this.emitAgentThought(resultThought, emit)
        return [...toolMessages, ...planFollowups]
      },
      cancel: async (reason): Promise<void> => {
        await run.cancel(reason)
      },
    }
  }

  private async executeToolCalls(
    toolCalls: ToolCallRequest[],
    emit: StreamEmitter | null,
    clarification: Clarification | null,
    planDecision: unknown,
    signal: AbortSignal | null,
    executionEnvironment: ExecutionEnvironment | null,
    turnId: string | null,
  ): Promise<Msg[]> {
    const toolCallsRef = { current: toolCalls }
    const planDecisionRef = { current: planDecision }
    const { runOne, resultsById, planFollowups } = this.buildToolRunOne({
      toolCallsRef,
      planDecisionRef,
      emit,
      clarification,
      signal,
      executionEnvironment,
      turnId,
    })
    const toolMessages = await this.toolExecutionEngine.runBatch(toolCalls, {
      emit,
      runOne,
      signal,
    })
    throwIfAborted(signal)
    const resultThought = toolResultSummaryThought(toolCalls, resultsById)
    if (resultThought) await this.emitAgentThought(resultThought, emit)
    return [...toolMessages, ...planFollowups]
  }

  private async executeToolWithHooks(
    call: ToolCallRequest,
    emit: StreamEmitter | null,
    clarification: Clarification | null,
    planDecision: unknown,
    signal: AbortSignal | null,
    executionEnvironment: ExecutionEnvironment | null,
    turnId: string | null,
  ): Promise<{
    result: ToolResultObj
    executed: boolean
    executedCall?: ToolCallRequest
    expectedGoalId?: string | null
    verificationTarget?: Record<string, string> | null
  }> {
    throwIfAborted(signal)
    let effectiveCall: ToolCallRequest
    try {
      effectiveCall = {
        ...call,
        arguments: this.registry.prepareCall(call.name, call.arguments),
      }
    } catch (error) {
      return { result: toolPreparationError(error), executed: false }
    }
    const initialGuard = this.toolGuardResult(
      effectiveCall,
      clarification,
      planDecision,
    )
    if (initialGuard) return { result: initialGuard, executed: false }

    let transformCount = 0
    const preTool = await this.runHookEvent(
      'PreToolUse',
      this.toolHookInput(effectiveCall, signal),
      emit,
    )
    throwIfAborted(signal)
    if (preTool.decision === 'deny') {
      return {
        result: ToolResultObj.fromText(
          `Error: hook denied ${call.name}: ${preTool.reason}`,
          { isError: true, meta: { hook_decision: preTool.decision } },
        ),
        executed: false,
      }
    }
    if (preTool.updatedInput) {
      transformCount += 1
      try {
        effectiveCall = {
          ...effectiveCall,
          arguments: this.registry.prepareCall(
            effectiveCall.name,
            preTool.updatedInput,
          ),
        }
      } catch (error) {
        return { result: toolPreparationError(error), executed: false }
      }
      const transformedGuard = this.toolGuardResult(
        effectiveCall,
        clarification,
        planDecision,
      )
      if (transformedGuard) return { result: transformedGuard, executed: false }
    }

    if (this.controlManager !== null) {
      let permission = this.controlManager.assessPermission(
        effectiveCall.name,
        effectiveCall.arguments,
        this.registry,
      )
      if (!permission.allowed && !permission.requiresApproval) {
        await this.runHookEvent(
          'PermissionDenied',
          {
            ...this.toolHookInput(effectiveCall, signal),
            permission: permissionHookPayload(permission),
          },
          emit,
        )
        return {
          result: ToolResultObj.fromText(
            `Error: permission denied for ${effectiveCall.name}: ${permission.reason}`,
            { isError: true },
          ),
          executed: false,
        }
      }
      if (permission.requiresApproval) {
        const hookDecision = await this.runHookEvent(
          'PermissionRequest',
          {
            ...this.toolHookInput(effectiveCall, signal),
            permission: permissionHookPayload(permission),
          },
          emit,
        )
        throwIfAborted(signal)
        if (hookDecision.decision === 'deny') {
          return {
            result: ToolResultObj.fromText(
              `Error: hook denied permission for ${effectiveCall.name}: ${hookDecision.reason}`,
              { isError: true, meta: { hook_decision: hookDecision.decision } },
            ),
            executed: false,
          }
        }
        if (hookDecision.updatedInput) {
          transformCount += 1
          if (transformCount > 2) {
            return {
              result: ToolResultObj.fromText(
                'Error: hook input transform limit exceeded',
                { isError: true },
              ),
              executed: false,
            }
          }
          try {
            effectiveCall = {
              ...effectiveCall,
              arguments: this.registry.prepareCall(
                effectiveCall.name,
                hookDecision.updatedInput,
              ),
            }
          } catch (error) {
            return { result: toolPreparationError(error), executed: false }
          }
          const transformedGuard = this.toolGuardResult(
            effectiveCall,
            clarification,
            planDecision,
          )
          if (transformedGuard)
            return { result: transformedGuard, executed: false }
          const replayPre = await this.runHookEvent(
            'PreToolUse',
            this.toolHookInput(effectiveCall, signal),
            emit,
          )
          throwIfAborted(signal)
          if (replayPre.decision === 'deny') {
            return {
              result: ToolResultObj.fromText(
                `Error: hook denied transformed ${effectiveCall.name}: ${replayPre.reason}`,
                { isError: true },
              ),
              executed: false,
            }
          }
          if (replayPre.updatedInput) {
            return {
              result: ToolResultObj.fromText(
                'Error: hook input transform limit exceeded during permission recheck',
                { isError: true },
              ),
              executed: false,
            }
          }
          permission = this.controlManager.assessPermission(
            effectiveCall.name,
            effectiveCall.arguments,
            this.registry,
          )
          if (!permission.allowed && !permission.requiresApproval) {
            await this.runHookEvent(
              'PermissionDenied',
              {
                ...this.toolHookInput(effectiveCall, signal),
                permission: permissionHookPayload(permission),
              },
              emit,
            )
            return {
              result: ToolResultObj.fromText(
                `Error: permission denied for ${effectiveCall.name}: ${permission.reason}`,
                { isError: true },
              ),
              executed: false,
            }
          }
        }
        if (permission.requiresApproval && hookDecision.decision !== 'allow') {
          return {
            result: ToolResultObj.fromText(
              this.controlManager.permissionApprovalResult(permission, {
                parentCallId: call.id,
                sessionId: this.sessionId,
              }),
            ),
            executed: false,
          }
        }
      }
    }
    const tool = this.registry.get(effectiveCall.name)
    const ctx = {
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      ...(emit && tool && tool.requiresRuntimeContext ? { emit } : {}),
      parentCallId: effectiveCall.id,
      sessionId: this.sessionId,
      taskId: this.taskId,
      subagentDepth: this.subagentDepth,
      signal,
      executionEnvironment,
    }
    let expectedGoalId: string | null | undefined
    if (this.goalObservationRecorder?.captureExpectedGoalId) {
      try {
        expectedGoalId =
          await this.goalObservationRecorder.captureExpectedGoalId(
            this.sessionId ?? '',
          )
      } catch {
        expectedGoalId = null
      }
    }
    const verificationTarget = planVerificationTarget(
      this.controlManager,
      effectiveCall,
    )
    if (verificationTarget !== null && emit) {
      await emit(
        runtimeEvents.planVerificationStart({
          planId: verificationTarget.plan_id!,
          stepId: verificationTarget.step_id!,
          command: verificationTarget.command!,
        }),
      )
    }
    throwIfAborted(signal)
    let result: ToolResultObj
    try {
      const execute = async () =>
        await this.registry.executeResult(
          effectiveCall.name,
          effectiveCall.arguments,
          ctx,
        )
      const paths = managedCheckpointPaths(effectiveCall, tool)
      if (
        this.fileCheckpoints &&
        this.sessionId &&
        this.workspaceRoot &&
        paths.length
      ) {
        result = (
          await this.fileCheckpoints.capture(
            {
              sessionId: this.sessionId,
              turnId: turnId ?? `tool-${effectiveCall.id}`,
              toolCallId: effectiveCall.id,
              toolName: effectiveCall.name,
              workspaceRoot: this.workspaceRoot,
              paths,
            },
            execute,
          )
        ).value
      } else {
        result = await execute()
      }
    } catch (error) {
      throwIfAborted(signal)
      if (error instanceof TurnPaused || error instanceof CancelledTaskError)
        throw error
      const message = error instanceof Error ? error.message : String(error)
      result = ToolResultObj.fromText(`Error: ${message}`, { isError: true })
    }
    const postInput: HookRuntimeRunOptions = result.isError
      ? {
          ...this.toolHookInput(effectiveCall, signal),
          error: result.modelContent,
        }
      : {
          ...this.toolHookInput(effectiveCall, signal),
          toolResult: {
            summary: result.summary,
            content: result.modelContent,
            isError: false,
            metadata: result.metadata,
          },
        }
    const postDecision = await this.runHookEvent(
      result.isError ? 'PostToolUseFailure' : 'PostToolUse',
      postInput,
      emit,
    )
    throwIfAborted(signal)
    if (
      !result.isError &&
      effectiveCall.name.startsWith('mcp_') &&
      postDecision.updatedToolOutput !== undefined
    ) {
      result = replaceHookToolOutput(result, postDecision.updatedToolOutput)
    }
    return {
      result: postDecision.additionalContext
        ? appendHookContext(result, postDecision.additionalContext)
        : result,
      executed: true,
      executedCall: effectiveCall,
      expectedGoalId,
      verificationTarget,
    }
  }

  private toolGuardResult(
    call: ToolCallRequest,
    clarification: Clarification | null,
    planDecision: unknown,
  ): ToolResultObj | null {
    if (
      clarification &&
      clarification.required &&
      this.askGuardBlocksTool(call.name)
    ) {
      return ToolResultObj.fromText(ASK_GUARD_BLOCK, { isError: true })
    }
    if (this.planGuardBlocksTool(call, planDecision)) {
      return ToolResultObj.fromText(
        planGuardMessage(call, planDecision as never),
        { isError: true },
      )
    }
    return null
  }

  private toolHookInput(
    call: ToolCallRequest,
    signal: AbortSignal | null = null,
  ): HookRuntimeRunOptions {
    return {
      sessionId: this.sessionId ?? '',
      cwd: this.workspaceRoot ?? process.cwd(),
      projectRoot: this.workspaceRoot ?? null,
      toolName: call.name,
      toolInput: call.arguments,
      toolUseId: call.id,
      ...(signal ? { signal } : {}),
    }
  }

  private async runHookEvent(
    eventName: HookEventName,
    opts: HookRuntimeRunOptions,
    emit: StreamEmitter | null,
  ): Promise<HookAggregateDecision> {
    if (!this.hooks) return emptyHookDecision()
    try {
      return await this.hooks.run(eventName, opts, emit)
    } catch (error) {
      if (emit) {
        await emit({
          event: 'hook_run_failed',
          event_name: eventName,
          status: 'failed',
          decision: 'passthrough',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      return emptyHookDecision()
    }
  }

  private assessPlanDecision(history: Msg[]): unknown {
    if (
      this.controlManager === null ||
      typeof this.controlManager.assessPlanDecision !== 'function'
    )
      return null
    const latest = latestUserText(history)
    if (!latest) return null
    try {
      return this.controlManager.assessPlanDecision(latest)
    } catch {
      return null
    }
  }

  private activePlanForSummary(): PlanRecord | null {
    const store = this.controlManager?.planStore
    if (!store) return null
    try {
      const record = store.latest()
      if (record === null) return null
      if (
        typeof this.controlManager?.planMatchesCurrentScope === 'function' &&
        !this.controlManager.planMatchesCurrentScope(record)
      ) {
        return null
      }
      return record.status === PlanStatus.APPROVED ||
        record.status === PlanStatus.EXECUTING
        ? record
        : null
    } catch {
      return null
    }
  }

  private assessClarification(history: Msg[]): Clarification {
    if (this.controlManager === null) return EMPTY_CLARIFICATION
    try {
      const a = this.controlManager.assessClarification(history)
      return {
        required: a.required,
        reason: a.reason,
        questions: a.questions,
        categories: a.categories,
      }
    } catch {
      return EMPTY_CLARIFICATION
    }
  }

  private askGuardBlocksTool(name: string): boolean {
    if (name === 'ask_user' || name === 'propose_plan') return false
    const tool = this.registry.get(name)
    if (!tool) return false
    return !tool.readOnly
  }

  private planGuardBlocksTool(
    call: ToolCallRequest,
    decision: unknown,
  ): boolean {
    if ((decision as { behavior?: string })?.behavior !== 'required')
      return false
    if (
      call.name === 'ask_user' ||
      call.name === 'propose_plan' ||
      call.name === 'update_todos'
    )
      return false
    const tool = this.registry.get(call.name)
    if (!tool) return false
    try {
      return !tool.isReadOnly(call.arguments)
    } catch {
      return !tool.readOnly
    }
  }

  private mustPauseForPlan(): boolean {
    return (
      this.controlManager !== null &&
      this.controlManager.shouldEnforcePlanFinal()
    )
  }

  private async emitToolCall(
    call: ToolCallRequest,
    emit: StreamEmitter | null,
  ): Promise<void> {
    if (emit)
      await emit({
        event: 'tool_call',
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })
  }

  private async emitAgentThought(
    event: Record<string, unknown>,
    emit: StreamEmitter | null,
  ): Promise<void> {
    if (emit) await emit(event)
  }

  private async emitToolResult(
    call: ToolCallRequest,
    result: ToolResultObj | string,
    emit: StreamEmitter | null,
  ): Promise<void> {
    if (!emit) return
    const r =
      result instanceof ToolResultObj
        ? result
        : ToolResultObj.fromText(String(result), {
            isError: String(result).startsWith('Error:'),
          })
    const payload: Msg = {
      event: 'tool_result',
      id: call.id,
      name: call.name,
      summary: summarizeToolResult(r.summary),
    }
    Object.assign(
      payload,
      runtimeEvents.compactRuntimeToolOutput(r.modelContent),
    )
    if (r.isError) payload.is_error = true
    const artifacts = r.artifactPayloads()
    if (artifacts.length) payload.artifacts = artifacts
    if (Object.keys(r.metadata).length) payload.metadata = r.metadata
    if (call.name === 'update_todos' && this.todoStore !== null) {
      payload.todos = this.todoStore.todos.map((t) => ({
        id: t.id,
        ...(t.plan_id ? { plan_id: t.plan_id } : {}),
        ...(t.plan_step_id ? { plan_step_id: t.plan_step_id } : {}),
        ...(t.approval_generation
          ? { approval_generation: t.approval_generation }
          : {}),
        content: t.content,
        status: t.status,
        ...(t.blocked_reason ? { blocked_reason: t.blocked_reason } : {}),
      }))
    }
    await emit(payload)
  }

  /** 压缩判定用的有效上下文上限：预留本回合输出 maxTokens，至少保留半个窗口。 */
  private effectiveMaxContext(): number {
    return Math.max(
      Math.trunc(this.maxContext / 2),
      this.maxContext - this.maxTokens,
    )
  }

  private async maybeCompact(
    history: Msg[],
    emit: StreamEmitter | null,
    turnId: string | null,
  ): Promise<void> {
    if (!(this.compactor && this.tokenTracker)) return
    if (!this.autoCompact) return
    const maxContext = this.effectiveMaxContext()
    if (!this.tokenTracker.shouldCompact(maxContext, this.compactThreshold))
      return
    if (this.compactionFailureStreak >= 3) {
      if (emit) {
        await emit({
          event: 'record_degraded',
          kind: 'memory_compaction',
          reason:
            'automatic memory compaction disabled after consecutive failures',
          taskId: turnId ?? undefined,
        })
      }
      return
    }
    try {
      if (typeof this.compactor.compactAfterTurn === 'function') {
        const goalHint = this.goalContextHint
          ? await this.goalContextHint()
          : null
        const result = await this.compactor.compactAfterTurn({
          history: history.map((message) => ({ ...message })),
          turnId,
          currentTokens: this.tokenTracker.lastInputTokensValue?.() ?? 0,
          maxContext,
          goalHint,
        })
        const resultRecord = isRecord(result) ? result : null
        const status = resultRecord ? String(resultRecord.status || '') : ''
        if (['degraded', 'failed', 'failure', 'error'].includes(status)) {
          throw new Error(
            String(resultRecord?.error || resultRecord?.message || status),
          )
        }
        const retainedHistory = Array.isArray(resultRecord?.retainedHistory)
          ? resultRecord.retainedHistory
          : null
        if (retainedHistory !== null)
          history.splice(
            0,
            history.length,
            ...retainedHistory.map((message) => ({ ...message })),
          )
        this.compactionFailureStreak = 0
        this.onGoalCompacted?.()
      } else if (typeof this.compactor.compactAsync === 'function') {
        const out = await this.compactor.compactAsync(history)
        history.splice(0, history.length, ...out)
        this.compactionFailureStreak = 0
        this.onGoalCompacted?.()
      } else if (typeof this.compactor.compact === 'function') {
        const out = this.compactor.compact(history)
        history.splice(0, history.length, ...out)
        this.compactionFailureStreak = 0
        this.onGoalCompacted?.()
      }
    } catch (exc) {
      this.compactionFailureStreak++
      if (emit) {
        await emit({
          event: 'record_degraded',
          kind: 'memory_compaction',
          reason: String(exc instanceof Error ? exc.message : exc).slice(
            0,
            500,
          ),
          taskId: turnId ?? undefined,
        })
      }
    }
  }

  private defaultContextPipeline(): ContextPipeline {
    const planContextProvider = this.defaultPlanContextProvider()
    if (!this.memoryStore?.memoryDir)
      return new ContextPipeline({
        goalContextProvider: this.goalContextProvider,
        planContextProvider,
      })
    try {
      return new ContextPipeline({
        toolResultStore: new ToolResultStore(
          dirname(this.memoryStore.memoryDir),
        ),
        toolResultLimits: this.registry.toolResultLimits(),
        goalContextProvider: this.goalContextProvider,
        planContextProvider,
      })
    } catch {
      return new ContextPipeline({
        goalContextProvider: this.goalContextProvider,
        planContextProvider,
      })
    }
  }

  private emergencyContextPipeline(): ContextPipeline {
    const planContextProvider = this.defaultPlanContextProvider()
    const common = {
      perCallLimit: 1200,
      keepRecent: 0,
      replacementMinBytes: 1200,
      replacementPreviewChars: 200,
      aggregateToolResultBudget: 6000,
      goalContextProvider: this.goalContextProvider,
      planContextProvider,
      microcompactKeepRecent: 0,
      microcompactMinChars: 1500,
      microcompactHeadChars: 500,
      microcompactTailChars: 200,
    }
    if (!this.memoryStore?.memoryDir) return new ContextPipeline(common)
    try {
      return new ContextPipeline({
        ...common,
        toolResultStore: new ToolResultStore(
          dirname(this.memoryStore.memoryDir),
        ),
        toolResultLimits: this.registry.toolResultLimits(),
      })
    } catch {
      return new ContextPipeline(common)
    }
  }

  private defaultPlanContextProvider(): PlanContextProvider | null {
    if (!this.controlManager?.planStore) return null
    const builder = new PlanContextBuilder(this.controlManager.planStore, {
      filter: (record) =>
        this.controlManager?.planMatchesCurrentScope?.(record) ?? true,
    })
    return (history) => builder.messageFor(history)
  }

  private reasoningEnabled(): boolean {
    return Boolean(
      this.reasoningEffort &&
      !['none', 'minimal', 'minimum'].includes(
        this.reasoningEffort.toLowerCase(),
      ),
    )
  }
}

function sanitizeProviderMessage(
  message: Record<string, unknown>,
): ChatArgs['messages'][number] {
  const out: Record<string, unknown> = {
    role: String(message.role ?? ''),
  }
  for (const key of [
    'content',
    'tool_calls',
    'tool_call_id',
    'name',
    'reasoning_content',
    'extra_content',
  ]) {
    if (key in message) out[key] = message[key]
  }
  return out as ChatArgs['messages'][number]
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw new CancelledTaskError('turn')
}

async function consumeRunnerInterjections(
  host: AgentRunnerInterjectionHost | null,
): Promise<Msg[]> {
  if (!host) return []
  const messages = await host.consume()
  if (!Array.isArray(messages))
    throw new Error('interjection host returned an invalid message batch')
  return messages.map((message) => {
    if (!isRecord(message) || message.role !== 'user')
      throw new Error('interjection messages must have the user role')
    const content = String(message.content ?? '')
    if (!content.trim()) throw new Error('interjection message is empty')
    return { ...message, role: 'user', content }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function positiveOptionalInt(value: unknown): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.trunc(parsed)
}

function modelUsageTokens(usage: Record<string, number>): number {
  const total = Number(usage.total ?? usage.total_tokens)
  if (Number.isFinite(total) && total > 0) return Math.trunc(total)
  const input = Number(usage.input ?? usage.input_tokens)
  const output = Number(usage.output ?? usage.output_tokens)
  return Math.max(
    0,
    Math.trunc(Number.isFinite(input) ? input : 0) +
      Math.trunc(Number.isFinite(output) ? output : 0),
  )
}

function emptyHookDecision(): HookAggregateDecision {
  return {
    decision: 'passthrough',
    reason: '',
    results: [],
    additionalContext: '',
  }
}

function appendHookContext(
  result: ToolResultObj,
  context: string,
): ToolResultObj {
  const trimmed = context.trim()
  if (!trimmed) return result
  return new ToolResultObj({
    modelContent: `${result.modelContent}\n\n[Hook additional context]\n${trimmed}`,
    displaySummary: result.displaySummary,
    rawContent: result.rawContent,
    artifacts: result.artifacts,
    metadata: { ...result.metadata, hook_additional_context: true },
    isError: result.isError,
  })
}

function toolPreparationError(error: unknown): ToolResultObj {
  const reason = error instanceof Error ? error.message : String(error)
  return ToolResultObj.fromText(`Error: ${reason}`, {
    isError: true,
    meta: { reason_kind: 'schema_validation' },
  })
}

function permissionHookPayload(
  permission: ReturnType<ControlManagerRunnerHost['assessPermission']>,
): Record<string, unknown> {
  return {
    allowed: permission.allowed,
    requiresApproval: permission.requiresApproval,
    risk: permission.risk ?? '',
    reason: permission.reason,
    rule: permission.rule ?? '',
    trace: Array.isArray(permission.trace)
      ? permission.trace.map((entry) => ({ ...entry }))
      : [],
    arguments: permission.arguments ?? null,
    toolName: permission.toolName ?? '',
  }
}

function replaceHookToolOutput(
  result: ToolResultObj,
  replacement: unknown,
): ToolResultObj {
  const content =
    typeof replacement === 'string' ? replacement : JSON.stringify(replacement)
  return new ToolResultObj({
    modelContent: content,
    displaySummary: content.slice(0, 120),
    rawContent: content,
    artifacts: result.artifacts,
    metadata: { ...result.metadata, hook_output_replaced: true },
    isError: false,
  })
}
