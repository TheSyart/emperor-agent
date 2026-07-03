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
  type GenerationSettings,
  type LLMProvider,
  type LLMResponse,
  type ToolCallRequest,
} from '../providers/base'
import { ContextPipeline, ToolResultStore, type PlanContextProvider } from '../context/pipeline'
import type { ToolRegistry } from '../tools/registry'
import { ToolResultObj, type ToolDefinition } from '../tools/base'
import { ToolExecutionEngine } from '../tools/execution'
import { TurnPaused } from '../control/exceptions'
import { parsePauseResult } from '../control/tools'
import { interactionToDict, type Interaction } from '../control/models'
import { PlanContextBuilder } from '../plans/context'
import { resultFromToolOutput, type VerificationCommand } from '../plans/verification'
import { PlanEvidenceError } from '../plans/evidence'
import { planToDict, type PlanRecord } from '../plans/models'
import type { PlanStore } from '../plans/store'
import { writePromptSnapshot, type PromptSectionInput } from '../prompts/manifest'
import {
  TransitionReason,
  beginIteration,
  emptyResponseRetry,
  lengthRecovery,
  makeQueryState,
  markCompleted,
  markPaused,
  maxTurnsReached,
  todoFollowup,
  toolFollowup,
  type QueryState,
} from './query-state'
import { TurnPhase, TurnState } from './turn-state'
import { ModelCaller, type ModelCallMeta, type RunnerModelHost } from './model-caller'
import { CancelledTaskError } from '../runtime/active'
import { ContextOverflowError } from '../errors'
import { isContextOverflowProviderError } from '../providers/errors'
import * as runtimeEvents from './runtime-events'
import {
  contextUsedFromUsage,
  controlInteractionEvent,
  discoveryEvidenceRefs,
  discoveryFiles,
  estimateMessagesTokens,
  latestUserText,
  optionalInt,
  planDecisionContract,
  planGuardMessage,
  renderTodos,
  summarizeToolResult,
} from './runner-helpers'
import { toolIntentThought, toolResultSummaryThought } from './runner-thoughts'

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
  writeCheckpoint(history: Msg[]): void
  clearCheckpoint(): void
  readCheckpoint(): Msg[] | null
  appendHistory(role: string, content: string, opts?: { extra?: Record<string, unknown> | null }): void
}

export interface TokenTrackerLike {
  record(model: string, usage: Record<string, number>, opts: Record<string, unknown>): void
  shouldCompact(maxContext: number, threshold: number): boolean
}

export interface CompactorLike {
  compactAsync?(history: Msg[]): Promise<Msg[]>
  compact?(history: Msg[]): Msg[]
}

export interface TodoStoreLike {
  todos: Array<Record<string, unknown>>
  syncFromPlanSteps(steps: Array<Record<string, unknown>>): string
}

/** runner 需要的 ControlManager 表面（W05）。全部可选/容错调用。 */
export interface ControlManagerRunnerHost {
  planStore?: PlanStore
  systemPrompt(): string
  toolDefinitions(registry: ToolRegistry): ToolDefinition[]
  assessPermission(name: string, args: Record<string, unknown>, registry: ToolRegistry | null): { allowed: boolean; requiresApproval: boolean; reason: string }
  permissionApprovalResult(decision: unknown, opts?: { parentCallId?: string | null }): string
  assessClarification(history: Msg[]): { required: boolean; reason: string; questions: Array<Record<string, unknown>>; categories: string[] }
  assessPlanDecision?(userMessage: string): unknown
  shouldEnforcePlanFinal(): boolean
  createAsk(opts: { questions: Array<Record<string, unknown>>; context?: string }): Interaction
  createPlanFromText(text: string): Interaction
  recordPlanDiscovery?(opts: Record<string, unknown>): unknown
  recordPlanStepToolOutput?(opts: Record<string, unknown>): unknown
  planMatchesCurrentScope?(record: PlanRecord): boolean
  syncPlanFromTodos?(todos: Array<Record<string, unknown>>, opts?: { evidence?: Record<string, unknown> }): PlanRecord | null
  planCompletionFollowup?(): Record<string, unknown> | null
  planIndependentVerificationFollowup?(opts?: { dispatchAvailable?: boolean }): Record<string, unknown> | null
  planVerificationTarget?(command: string): Record<string, string> | null
  recordPlanVerificationResult?(opts: { planId: string; stepId: string; result: Record<string, unknown> }): PlanRecord | null
}

const EMPTY_CLARIFICATION = { required: false, reason: '', questions: [] as Array<Record<string, unknown>>, categories: [] as string[] }
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

export interface AgentRunnerOptions {
  provider: LLMProvider
  model: string
  registry: ToolRegistry
  systemPrompt: string
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string | null
  providerName?: string | null
  modelRole?: string
  routeReason?: string
  routeEstimatedTokens?: number | null
  fallbackProvider?: LLMProvider | null
  fallbackModel?: string | null
  fallbackProviderName?: string | null
  fallbackGeneration?: GenerationSettings | null
  fallbackModelRole?: string
  usageType?: string
  memoryStore?: MemoryStoreLike | null
  tokenTracker?: TokenTrackerLike | null
  compactor?: CompactorLike | null
  todoStore?: TodoStoreLike | null
  controlManager?: ControlManagerRunnerHost | null
  maxContext?: number
  compactThreshold?: number
  maxTurns?: number | null
  contextPipeline?: ContextPipeline | null
  toolExecutionEngine?: ToolExecutionEngine | null
  workspaceRoot?: string | null
  promptSections?: PromptSectionInput[] | null
  promptSnapshotDir?: string | null
  sessionId?: string | null
}

export class AgentRunner implements RunnerModelHost {
  provider: LLMProvider
  model: string
  registry: ToolRegistry
  systemPrompt: string
  maxTokens: number
  temperature: number
  reasoningEffort: string | null
  providerName: string | null
  modelRole: string
  routeReason: string
  routeEstimatedTokens: number | null
  fallbackProvider: LLMProvider | null
  fallbackModel: string | null
  fallbackProviderName: string | null
  fallbackGeneration: GenerationSettings | null
  fallbackModelRole: string
  usageType: string
  memoryStore: MemoryStoreLike | null
  tokenTracker: TokenTrackerLike | null
  compactor: CompactorLike | null
  todoStore: TodoStoreLike | null
  controlManager: ControlManagerRunnerHost | null
  maxContext: number
  compactThreshold: number
  maxTurns: number | null
  contextPipeline: ContextPipeline
  toolExecutionEngine: ToolExecutionEngine
  workspaceRoot: string | null
  promptSections: PromptSectionInput[]
  promptSnapshotDir: string | null
  sessionId: string | null
  lastEstimatedInputTokens: number | null = null
  lastContextProjectionReport: Record<string, unknown> | null = null
  lastModelCall: ModelCallMeta

  constructor(opts: AgentRunnerOptions) {
    this.provider = opts.provider
    this.model = opts.model
    this.registry = opts.registry
    this.systemPrompt = opts.systemPrompt
    this.maxTokens = opts.maxTokens ?? 20000
    this.temperature = opts.temperature ?? 0.1
    this.reasoningEffort = opts.reasoningEffort ?? null
    this.providerName = opts.providerName ?? null
    this.modelRole = opts.modelRole ?? 'main'
    this.routeReason = opts.routeReason ?? ''
    this.routeEstimatedTokens = opts.routeEstimatedTokens ?? null
    this.fallbackProvider = opts.fallbackProvider ?? null
    this.fallbackModel = opts.fallbackModel ?? null
    this.fallbackProviderName = opts.fallbackProviderName ?? null
    this.fallbackGeneration = opts.fallbackGeneration ?? null
    this.fallbackModelRole = opts.fallbackModelRole ?? 'main'
    this.usageType = opts.usageType ?? 'main_agent'
    this.memoryStore = opts.memoryStore ?? null
    this.tokenTracker = opts.tokenTracker ?? null
    this.compactor = opts.compactor ?? null
    this.todoStore = opts.todoStore ?? null
    this.controlManager = opts.controlManager ?? null
    this.maxContext = opts.maxContext ?? 200_000
    this.compactThreshold = opts.compactThreshold ?? 0.7
    this.maxTurns = opts.maxTurns ?? null
    this.contextPipeline = opts.contextPipeline ?? this.defaultContextPipeline()
    this.toolExecutionEngine = opts.toolExecutionEngine ?? new ToolExecutionEngine(opts.registry)
    this.workspaceRoot = opts.workspaceRoot ?? null
    this.promptSections = opts.promptSections ? [...opts.promptSections] : []
    this.promptSnapshotDir = opts.promptSnapshotDir ?? null
    this.sessionId = opts.sessionId ?? null
    this.lastModelCall = {
      model: this.model,
      provider: this.providerName,
      modelRole: this.modelRole,
      routeReason: this.routeReason,
      routeEstimatedTokens: this.routeEstimatedTokens,
      estimatedInputTokens: null,
      usedFallback: false,
      fallbackReason: '',
      providerRetryCount: 0,
      providerErrorKind: '',
    }
  }

  async stepStream(history: Msg[], emit: StreamEmitter, opts?: { turnId?: string | null; signal?: AbortSignal | null }): Promise<string> {
    const reply = await this.stepAsync(history, { emit, turnId: opts?.turnId ?? null, signal: opts?.signal ?? null })
    throwIfAborted(opts?.signal ?? null)
    await emit({ event: 'assistant_done', content: reply })
    return reply
  }

  async stepAsync(history: Msg[], opts?: { emit?: StreamEmitter | null; turnId?: string | null; signal?: AbortSignal | null }): Promise<string> {
    const emit = opts?.emit ?? null
    const turnId = opts?.turnId ?? null
    const signal = opts?.signal ?? null
    throwIfAborted(signal)
    const turnState = new TurnState({ turnId })
    await this.emitTurnPhase(turnState, TurnPhase.STARTED, emit, { history_length: history.length })
    const entryPlanDecision = this.assessPlanDecision(history)
    if (emit && entryPlanDecision !== null) {
      await emit(runtimeEvents.planEntryDecision(planDecisionContract(entryPlanDecision as never)))
    }
    let queryState: QueryState = makeQueryState({ turnId, maxTurns: this.maxTurns })
    const finalParts: string[] = []
    const seenPlanFollowups = new Set<string>()
    const clarification = this.assessClarification(history)
    if (this.memoryStore !== null) {
      this.memoryStore.writeCheckpoint(history)
      await this.emitTurnPhase(turnState, TurnPhase.CHECKPOINT, emit, { reason: 'turn_start' })
    }
    while (true) {
      throwIfAborted(signal)
      const maxTurnsTransition = maxTurnsReached(queryState)
      if (maxTurnsTransition !== null) {
        queryState = maxTurnsTransition.nextState
        const reply = maxTurnsTransition.terminalReply ?? ''
        const message: Msg = { role: 'assistant', content: reply }
        if (turnId) message.turn_id = turnId
        history.push(message)
        if (this.memoryStore) {
          this.memoryStore.appendHistory('assistant', reply, { extra: turnId ? { turn_id: turnId } : null })
          this.memoryStore.clearCheckpoint()
        }
        await this.emitTurnPhase(turnState, TurnPhase.MAX_TURNS, emit, { max_turns: this.maxTurns })
        return reply
      }
      queryState = beginIteration(queryState).nextState
      turnState.startIteration()

      await this.emitTurnPhase(turnState, TurnPhase.MODEL_REQUEST, emit)
      const response = await this.askModel(history, emit, clarification, signal, turnId)
      throwIfAborted(signal)
      await this.emitTurnPhase(turnState, TurnPhase.MODEL_RESPONSE, emit, {
        finish_reason: response.finishReason,
        tool_call_count: response.toolCalls.length,
        content_chars: (response.content ?? '').length,
      })
      if (response.usage && Object.keys(response.usage).length) {
        const callMeta = this.lastModelCall
        const projectionReport = this.lastContextProjectionReport ?? {}
        if (this.tokenTracker) {
          this.tokenTracker.record(String(callMeta.model || this.model), response.usage, {
            provider: String(callMeta.provider || this.providerName || 'unknown'),
            usageType: this.usageType,
            modelRole: String(callMeta.modelRole || this.modelRole),
            routeReason: String(callMeta.routeReason || this.routeReason || ''),
            usedFallback: Boolean(callMeta.usedFallback),
            fallbackReason: String(callMeta.fallbackReason || ''),
            estimatedInputTokens: optionalInt(callMeta.estimatedInputTokens),
            routeEstimatedTokens: optionalInt(callMeta.routeEstimatedTokens),
          })
        }
        if (emit) {
          await emit({
            event: 'context_usage',
            used: contextUsedFromUsage(response.usage),
            max: this.maxContext,
            threshold: Math.trunc(this.maxContext * this.compactThreshold),
            usage_type: this.usageType,
            model_role: callMeta.modelRole,
            model: callMeta.model,
            provider: callMeta.provider,
            route_reason: callMeta.routeReason,
            estimated_input_tokens: callMeta.estimatedInputTokens,
            used_fallback: Boolean(callMeta.usedFallback),
            fallback_reason: callMeta.fallbackReason || undefined,
            provider_retry_count: optionalInt(callMeta.providerRetryCount) ?? undefined,
            provider_error_kind: callMeta.providerErrorKind || undefined,
            replaced_tool_results: optionalInt(projectionReport.replaced_tool_results) ?? undefined,
            aggregate_replaced_tool_results: optionalInt(projectionReport.aggregate_replaced_tool_results) ?? undefined,
            aggregate_tool_result_budget: optionalInt(projectionReport.aggregate_tool_result_budget) ?? undefined,
          })
        }
      }
      if (this.memoryStore) {
        const lastUser = [...history].reverse().find((m) => m.role === 'user')
        const userInput = lastUser ? String(lastUser.content ?? '').slice(0, 500) : ''
        const aiOutput = String(response.content ?? '').slice(0, 500)
        let cmdEvent: string | null = null
        if (userInput.startsWith('/')) cmdEvent = userInput.split(/\s+/)[0] ?? null
        const inputTokens = response.usage ? Number(response.usage.input ?? 0) || 0 : 0
        const outputTokens = response.usage ? Number(response.usage.output ?? 0) || 0 : 0
        this.memoryStore.appendHistory('model_call', `${this.model} call: input=${inputTokens} output=${outputTokens}`, {
          extra: {
            type: 'model_call',
            model: this.lastModelCall.model || this.model,
            provider: this.lastModelCall.provider || this.providerName,
            model_role: this.lastModelCall.modelRole || this.modelRole,
            route_reason: this.lastModelCall.routeReason || this.routeReason,
            used_fallback: Boolean(this.lastModelCall.usedFallback),
            fallback_reason: this.lastModelCall.fallbackReason || '',
            estimated_input_tokens: this.lastModelCall.estimatedInputTokens,
            route_estimated_tokens: this.lastModelCall.routeEstimatedTokens,
            usage_type: this.usageType,
            user_input: userInput,
            ai_output: aiOutput,
            command_event: cmdEvent,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            ...(turnId ? { turn_id: turnId } : {}),
          },
        })
      }

      if (shouldExecuteTools(response)) {
        queryState = toolFollowup(queryState).nextState
        const assistantContent = response.content ?? ''
        if (assistantContent) finalParts.push(assistantContent)
        const assistantMessage: Msg = {
          role: 'assistant',
          content: assistantContent,
          tool_calls: response.toolCalls.map((call) => toOpenAiToolCall(call)),
        }
        if (turnId) assistantMessage.turn_id = turnId
        if (response.reasoningContent !== null) assistantMessage.reasoning_content = response.reasoningContent
        else if (this.reasoningEnabled()) assistantMessage.reasoning_content = ''
        if (response.thinkingBlocks) assistantMessage.thinking_blocks = response.thinkingBlocks
        history.push(assistantMessage)
        await this.emitAgentThought(toolIntentThought(response.toolCalls), emit)
        await this.emitTurnPhase(turnState, TurnPhase.TOOL_BATCH_START, emit, {
          count: response.toolCalls.length,
          names: response.toolCalls.map((call) => call.name),
        })
        let toolMessages: Msg[]
        try {
          const planDecision = this.assessPlanDecision(history)
          toolMessages = await this.executeToolCalls(response.toolCalls, emit, clarification, planDecision, signal)
          throwIfAborted(signal)
        } catch (pause) {
          if (!(pause instanceof TurnPaused)) throw pause
          history.push(...pause.toolMessages)
          if (this.memoryStore !== null) this.memoryStore.writeCheckpoint(history)
          await this.emitTurnPhase(turnState, TurnPhase.PAUSED, emit, {
            kind: pause.interaction.kind,
            interaction_id: pause.interaction.id,
            source: 'tool',
          })
          if (emit) {
            for (const msg of pause.toolMessages) {
              if (msg.tool_call_id === pause.interaction.parent_call_id) {
                await emit({ event: 'tool_result', id: msg.tool_call_id, name: msg.name, summary: msg.content })
                break
              }
            }
            await emit(controlInteractionEvent(pause.interaction))
            await emit({ event: 'turn_paused', interaction: pause.interaction })
          }
          throw pause
        }
        history.push(...toolMessages)
        await this.emitTurnPhase(turnState, TurnPhase.TOOL_BATCH_DONE, emit, { count: toolMessages.length })
        if (this.memoryStore !== null) {
          this.memoryStore.writeCheckpoint(history)
          await this.emitTurnPhase(turnState, TurnPhase.CHECKPOINT, emit, { reason: 'tool_batch' })
        }
        continue
      }

      const reply = response.content ?? ''

      // 空响应救援
      if (!reply.trim() && !response.toolCalls.length) {
        const t = emptyResponseRetry(queryState, { maxRetries: MAX_EMPTY_RETRIES })
        if (t !== null) {
          queryState = t.nextState
          history.push(...t.messages)
          await this.emitTurnPhase(turnState, TurnPhase.EMPTY_RETRY, emit, { attempt: queryState.emptyRetries, max: MAX_EMPTY_RETRIES })
          if (emit) for (const event of t.events) await emit(event)
          continue
        }
      }

      // 截断续写
      if (isTruncated(response.finishReason)) {
        const t = lengthRecovery(queryState, reply, { maxRetries: MAX_LENGTH_RECOVERIES })
        if (t !== null) {
          queryState = t.nextState
          if (reply) finalParts.push(reply)
          history.push(...t.messages)
          await this.emitTurnPhase(turnState, TurnPhase.LENGTH_RETRY, emit, { attempt: queryState.lengthRetries, max: MAX_LENGTH_RECOVERIES })
          if (emit) for (const event of t.events) await emit(event)
          continue
        }
      }

      if (clarification.required && reply.trim()) {
        queryState = markPaused(queryState, TransitionReason.ASK_PAUSE).nextState
        await this.emitTurnPhase(turnState, TurnPhase.PAUSED, emit, { kind: 'ask', source: 'clarification' })
        await this.pauseForClarification(history, clarification, emit, turnId)
      }

      if (this.mustPauseForPlan()) {
        queryState = markPaused(queryState, TransitionReason.PLAN_PAUSE).nextState
        await this.emitTurnPhase(turnState, TurnPhase.PAUSED, emit, { kind: 'plan', source: 'plan_final' })
        await this.pauseForPlan(history, reply, emit, turnId)
      }

      finalParts.push(reply)
      const finalReply = finalParts.join('')
      const assistantMessage: Msg = { role: 'assistant', content: reply }
      if (turnId) assistantMessage.turn_id = turnId
      if (response.reasoningContent !== null) assistantMessage.reasoning_content = response.reasoningContent
      else if (this.reasoningEnabled()) assistantMessage.reasoning_content = ''
      if (response.thinkingBlocks) assistantMessage.thinking_blocks = response.thinkingBlocks
      history.push(assistantMessage)

      if (this.todoStore && this.todoStore.todos.length) {
        const unfinished = this.todoStore.todos.filter((t) => t.status !== 'completed')
        if (unfinished.length) {
          const t = todoFollowup(queryState, { unfinishedText: renderTodos(unfinished), unfinishedCount: unfinished.length })
          queryState = t.nextState
          history.push(...t.messages)
          await this.emitTurnPhase(turnState, TurnPhase.TODO_FOLLOWUP, emit, { unfinished: unfinished.length })
          continue
        }
        this.todoStore.todos = []
      }

      const planFollowup = this.planCompletionFollowup()
      if (planFollowup !== null) {
        const key = planFollowupSignature(planFollowup)
        if (seenPlanFollowups.has(key)) {
          if (emit) {
            await emit({
              event: 'record_degraded',
              kind: 'plan_followup_loop',
              reason: 'repeated plan completion followup in one turn',
              taskId: turnId ?? undefined,
              plan_id: planFollowup.plan_id,
              unfinished_count: planFollowup.unfinished_count,
            })
          }
          if (this.memoryStore) {
            this.memoryStore.appendHistory('assistant', finalReply, { extra: turnId ? { turn_id: turnId } : null })
            this.memoryStore.clearCheckpoint()
          }
          queryState = markCompleted(queryState).nextState
          await this.emitTurnPhase(turnState, TurnPhase.COMPLETED, emit, { content_chars: finalReply.length, degraded: 'plan_followup_loop' })
          return finalReply
        }
        seenPlanFollowups.add(key)
        history.push({ role: 'user', content: String(planFollowup.message) })
        await this.emitTurnPhase(turnState, TurnPhase.PLAN_FOLLOWUP, emit, { plan_id: planFollowup.plan_id, unfinished: planFollowup.unfinished_count })
        continue
      }

      const verificationFollowup = this.planIndependentVerificationFollowup()
      if (verificationFollowup !== null) {
        history.push({ role: 'user', content: String(verificationFollowup.message) })
        await this.emitTurnPhase(turnState, TurnPhase.PLAN_FOLLOWUP, emit, { plan_id: verificationFollowup.plan_id, verification: verificationFollowup.status })
        continue
      }

      await this.emitTurnPhase(turnState, TurnPhase.COMPACT_CHECK, emit)
      await this.maybeCompact(history, emit, turnId)
      if (this.memoryStore !== null) {
        this.memoryStore.appendHistory('assistant', finalReply, { extra: turnId ? { turn_id: turnId } : null })
        this.memoryStore.clearCheckpoint()
      }
      queryState = markCompleted(queryState).nextState
      await this.emitTurnPhase(turnState, TurnPhase.COMPLETED, emit, { content_chars: finalReply.length })
      return finalReply
    }
  }

  private async emitTurnPhase(state: TurnState, phase: TurnPhase, emit: StreamEmitter | null, detail?: Record<string, unknown> | null): Promise<void> {
    const event = state.transition(phase, { detail: detail ?? null })
    if (emit) await emit(event.toRuntimeEvent())
  }

  private async askModel(history: Msg[], emit: StreamEmitter | null, clarification: Clarification | null, signal: AbortSignal | null, turnId: string | null): Promise<LLMResponse> {
    try {
      return await this.callModelWithProjection(history, emit, clarification, signal, turnId, false)
    } catch (exc) {
      if (!isContextOverflowProviderError(exc)) throw exc
      if (emit) {
        await emit({
          event: 'record_degraded',
          kind: 'context_overflow',
          reason: String(exc instanceof Error ? exc.message : exc).slice(0, 500),
          taskId: turnId ?? undefined,
        })
      }
      try {
        return await this.callModelWithProjection(history, emit, clarification, signal, turnId, true)
      } catch (retryExc) {
        if (!isContextOverflowProviderError(retryExc)) throw retryExc
        const options = retryExc instanceof Error ? { cause: retryExc } : undefined
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
  ): Promise<LLMResponse> {
    const pipeline = emergencyShrink ? this.emergencyContextPipeline() : this.contextPipeline
    const projection = pipeline.project(history as never)
    const governed = projection.messages
    const report = emergencyShrink
      ? { ...projection.report, context_overflow_retry: 1, emergency_context_shrink: 1 }
      : projection.report
    this.lastContextProjectionReport = report
    if (emit) {
      await emit(
        runtimeEvents.contextProjection({
          report,
          messageCount: governed.length,
        }),
      )
    }
    let systemPrompt = this.systemPrompt
    const promptSections: PromptSectionInput[] = this.promptSections.length ? [...this.promptSections] : [{
      name: 'system',
      content: this.systemPrompt,
      source: 'AgentRunner.systemPrompt',
      priority: 100,
      budgetChars: null,
      version: null,
    }]
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
        })
      }
      toolDefinitions = this.controlManager.toolDefinitions(this.registry)
    } else {
      toolDefinitions = this.registry.getDefinitions()
    }
    const messages: ChatArgs['messages'] = [{ role: 'system', content: systemPrompt }, ...(governed as never[])]
    this.lastEstimatedInputTokens = estimateMessagesTokens(messages as unknown as Msg[])
    if (this.promptSnapshotDir && turnId) {
      try {
        writePromptSnapshot({
          dir: this.promptSnapshotDir,
          sessionId: this.sessionId,
          turnId,
          model: this.model,
          provider: this.providerName,
          modelRole: this.modelRole,
          estimatedInputTokens: this.lastEstimatedInputTokens,
          sections: promptSections,
        })
      } catch {
        // Prompt snapshots are diagnostics only; never fail the model call because of them.
      }
    }
    return new ModelCaller(this).ask({ messages, tools: toolDefinitions as unknown as Array<Record<string, unknown>>, emit, signal })
  }

  private async executeToolCalls(
    toolCalls: ToolCallRequest[],
    emit: StreamEmitter | null,
    clarification: Clarification | null,
    planDecision: unknown,
    signal: AbortSignal | null,
  ): Promise<Msg[]> {
    const resultsById = new Map<string, ToolResultObj>()
    const planFollowups: Msg[] = []

    const runOne = async (call: ToolCallRequest): Promise<ToolResultObj> => {
      throwIfAborted(signal)
      await this.emitToolCall(call, emit)
      const verificationTarget = this.planVerificationTarget(call)
      if (verificationTarget !== null && emit) {
        await emit(runtimeEvents.planVerificationStart({ planId: verificationTarget.plan_id!, stepId: verificationTarget.step_id!, command: verificationTarget.command! }))
      }
      let result = await this.runToolResult(call, emit, clarification, planDecision, signal)
      throwIfAborted(signal)
      this.recordPlanDiscovery(call, result)
      this.recordPlanStepToolOutput(call, result)
      const content = result.modelContent
      resultsById.set(call.id, result)
      this.maybePauseForControl(content, toolCalls, resultsById)
      const verificationUpdate = this.recordPlanVerification(call, content, verificationTarget)
      if (verificationUpdate !== null && emit) {
        await emit(runtimeEvents.planVerificationDone({ planId: verificationUpdate.target.plan_id!, stepId: verificationUpdate.target.step_id!, result: verificationUpdate.result }))
        await emit(runtimeEvents.planRuntimeUpdate(verificationUpdate.plan))
      }
      if (verificationUpdate !== null) {
        const followup = AgentRunner.planVerificationFollowup(verificationUpdate)
        if (followup !== null) planFollowups.push(followup)
      }
      let planUpdate: PlanRecord | null = null
      if (!result.isError) {
        try {
          planUpdate = this.syncPlanFromTodoTool(call, content)
        } catch (exc) {
          if (!(exc instanceof PlanEvidenceError)) throw exc
          this.restoreTodosFromPlan()
          result = ToolResultObj.fromText(exc.message, { isError: true })
          resultsById.set(call.id, result)
        }
      }
      await this.emitToolResult(call, result, emit)
      if (planUpdate !== null && emit) {
        await emit(runtimeEvents.planRuntimeUpdate(planToDict(planUpdate)))
      }
      return result
    }

    const toolMessages = await this.toolExecutionEngine.runBatch(toolCalls, { emit, runOne, signal })
    throwIfAborted(signal)
    const resultThought = toolResultSummaryThought(toolCalls, resultsById)
    if (resultThought) await this.emitAgentThought(resultThought, emit)
    return [...toolMessages, ...planFollowups]
  }

  private async runToolResult(call: ToolCallRequest, emit: StreamEmitter | null, clarification: Clarification | null, planDecision: unknown, signal: AbortSignal | null): Promise<ToolResultObj> {
    throwIfAborted(signal)
    if (clarification && clarification.required && this.askGuardBlocksTool(call.name)) {
      return ToolResultObj.fromText(ASK_GUARD_BLOCK, { isError: true })
    }
    if (this.planGuardBlocksTool(call, planDecision)) {
      return ToolResultObj.fromText(planGuardMessage(call, planDecision as never), { isError: true })
    }
    if (this.controlManager !== null) {
      const decision = this.controlManager.assessPermission(call.name, call.arguments, this.registry)
      if (decision.requiresApproval) {
        return ToolResultObj.fromText(this.controlManager.permissionApprovalResult(decision, { parentCallId: call.id }))
      }
      if (!decision.allowed) {
        return ToolResultObj.fromText(`Error: permission denied for ${call.name}: ${decision.reason}`, { isError: true })
      }
    }
    const tool = this.registry.get(call.name)
    const ctx = {
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      ...(emit && tool && tool.requiresRuntimeContext ? { emit } : {}),
      parentCallId: call.id,
      signal,
    }
    return this.registry.executeResult(call.name, call.arguments, ctx)
  }

  private assessPlanDecision(history: Msg[]): unknown {
    if (this.controlManager === null || typeof this.controlManager.assessPlanDecision !== 'function') return null
    const latest = latestUserText(history)
    if (!latest) return null
    try {
      return this.controlManager.assessPlanDecision(latest)
    } catch {
      return null
    }
  }

  private recordPlanDiscovery(call: ToolCallRequest, result: ToolResultObj): void {
    if (result.isError || this.controlManager === null || typeof this.controlManager.recordPlanDiscovery !== 'function') return
    const source = String(result.metadata.tool ?? call.name)
    if (source !== 'read_file' && source !== 'grep') return
    const files = discoveryFiles(source, result)
    if (source === 'grep' && !files.length) return
    const evidenceRefs = discoveryEvidenceRefs(source, result, files)
    try {
      this.controlManager.recordPlanDiscovery({
        source,
        summary: result.displaySummary || summarizeToolResult(result.modelContent, 240),
        files,
        evidenceRefs,
      })
    } catch {
      /* tolerate */
    }
  }

  private recordPlanStepToolOutput(call: ToolCallRequest, result: ToolResultObj): void {
    if (this.controlManager === null || typeof this.controlManager.recordPlanStepToolOutput !== 'function') return
    try {
      this.controlManager.recordPlanStepToolOutput({
        toolName: call.name,
        summary: result.displaySummary || summarizeToolResult(result.modelContent, 240),
        toolCallId: call.id,
        artifacts: result.artifactPayloads(),
        metadata: result.metadata,
        isError: result.isError,
      })
    } catch {
      /* tolerate */
    }
  }

  private assessClarification(history: Msg[]): Clarification {
    if (this.controlManager === null) return EMPTY_CLARIFICATION
    try {
      const a = this.controlManager.assessClarification(history)
      return { required: a.required, reason: a.reason, questions: a.questions, categories: a.categories }
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

  private planGuardBlocksTool(call: ToolCallRequest, decision: unknown): boolean {
    if ((decision as { behavior?: string })?.behavior !== 'required') return false
    if (call.name === 'ask_user' || call.name === 'propose_plan' || call.name === 'update_todos') return false
    const tool = this.registry.get(call.name)
    if (!tool) return false
    try {
      return !tool.isReadOnly(call.arguments)
    } catch {
      return !tool.readOnly
    }
  }

  private async pauseForClarification(history: Msg[], clarification: Clarification, emit: StreamEmitter | null, turnId: string | null): Promise<void> {
    if (this.controlManager === null) return
    const interaction = this.controlManager.createAsk({ questions: clarification.questions, context: `Ask Guard: ${clarification.reason}` })
    const message: Msg = { role: 'assistant', content: '需要先确认关键取舍，已触发 Ask Guard。' }
    if (turnId) message.turn_id = turnId
    history.push(message)
    if (this.memoryStore !== null) this.memoryStore.writeCheckpoint(history)
    const payload = interactionToDict(interaction)
    if (emit) {
      await emit(controlInteractionEvent(payload))
      await emit({ event: 'turn_paused', interaction: payload })
    }
    throw new TurnPaused(payload, [])
  }

  private async pauseForPlan(history: Msg[], reply: string, emit: StreamEmitter | null, turnId: string | null): Promise<void> {
    if (this.controlManager === null) return
    const interaction = this.controlManager.createPlanFromText(reply)
    const message: Msg = { role: 'assistant', content: reply }
    if (turnId) message.turn_id = turnId
    history.push(message)
    if (this.memoryStore !== null) this.memoryStore.writeCheckpoint(history)
    const payload = interactionToDict(interaction)
    if (emit) {
      await emit(controlInteractionEvent(payload))
      await emit({ event: 'turn_paused', interaction: payload })
    }
    throw new TurnPaused(payload, [])
  }

  private mustPauseForPlan(): boolean {
    return this.controlManager !== null && this.controlManager.shouldEnforcePlanFinal()
  }

  private maybePauseForControl(content: string, toolCalls: ToolCallRequest[], resultsById: Map<string, ToolResultObj>): void {
    const interaction = parsePauseResult(content)
    if (interaction === null) return
    const toolMessages = AgentRunner.toolMessagesForPause(toolCalls, resultsById, interaction)
    throw new TurnPaused(interaction, toolMessages)
  }

  private syncPlanFromTodoTool(call: ToolCallRequest, content: string): PlanRecord | null {
    if (call.name !== 'update_todos' || this.controlManager === null) return null
    const todos = call.arguments.todos
    if (!Array.isArray(todos) || typeof this.controlManager.syncPlanFromTodos !== 'function') return null
    return this.controlManager.syncPlanFromTodos(todos, {
      evidence: { source: 'update_todos', tool_call_id: call.id, summary: summarizeToolResult(content) },
    })
  }

  private restoreTodosFromPlan(): void {
    if (this.todoStore === null) return
    const followup = this.planCompletionFollowup()
    const plan = followup && typeof followup === 'object' ? (followup.plan as Record<string, unknown>) : null
    const steps = plan && typeof plan === 'object' ? plan.steps : null
    if (Array.isArray(steps)) this.todoStore.syncFromPlanSteps(steps as Array<Record<string, unknown>>)
  }

  private planCompletionFollowup(): Record<string, unknown> | null {
    if (this.controlManager === null || typeof this.controlManager.planCompletionFollowup !== 'function') return null
    return this.controlManager.planCompletionFollowup()
  }

  private planIndependentVerificationFollowup(): Record<string, unknown> | null {
    if (this.controlManager === null || typeof this.controlManager.planIndependentVerificationFollowup !== 'function') return null
    return this.controlManager.planIndependentVerificationFollowup({ dispatchAvailable: this.registry.get('dispatch_subagent') !== undefined })
  }

  private planVerificationTarget(call: ToolCallRequest): Record<string, string> | null {
    if (call.name !== 'run_command' || this.controlManager === null) return null
    const command = call.arguments.command
    if (typeof command !== 'string' || typeof this.controlManager.planVerificationTarget !== 'function') return null
    return this.controlManager.planVerificationTarget(command)
  }

  private recordPlanVerification(
    call: ToolCallRequest,
    content: string,
    target: Record<string, string> | null,
  ): { target: Record<string, string>; result: Record<string, unknown>; plan: Record<string, unknown> } | null {
    if (target === null || this.controlManager === null || typeof this.controlManager.recordPlanVerificationResult !== 'function') return null
    const command: VerificationCommand = { command: target.command!, cwd: null, timeoutSeconds: 300 }
    const resultObj = resultFromToolOutput(command, content)
    const result: Record<string, unknown> = {
      command: resultObj.command,
      exit_code: resultObj.exitCode,
      passed: resultObj.passed,
      summary: resultObj.summary,
      stdout_tail: resultObj.stdoutTail,
      stderr_tail: resultObj.stderrTail,
      checked_at: resultObj.checkedAt,
      source: 'run_command',
      tool_call_id: call.id,
    }
    const plan = this.controlManager.recordPlanVerificationResult({ planId: target.plan_id!, stepId: target.step_id!, result })
    if (plan === null) return null
    return { target, result, plan: planToDict(plan) }
  }

  private static planVerificationFollowup(update: { result: Record<string, unknown>; target: Record<string, string> }): Msg | null {
    const result = update.result ?? {}
    if (result.passed !== false) return null
    const target = update.target ?? {}
    return {
      role: 'user',
      content: [
        '[PLAN_VERIFICATION_FAILED]',
        `plan_id: ${target.plan_id}`,
        `step_id: ${target.step_id}`,
        `command: ${result.command}`,
        `exit_code: ${result.exit_code}`,
        `summary: ${result.summary}`,
        '',
        '该计划步骤的验证命令失败。不要直接最终答复；先诊断失败原因，修复后重新执行相关验证。如果失败原因需要用户决策，调用 ask_user。',
      ].join('\n'),
    }
  }

  private static toolMessagesForPause(toolCalls: ToolCallRequest[], resultsById: Map<string, ToolResultObj>, interaction: Record<string, unknown>): Msg[] {
    const messages: Msg[] = []
    let currentId = String(interaction.parent_call_id ?? '')
    for (const call of toolCalls) {
      const result = resultsById.get(call.id)
      let content: string | null = result !== undefined ? result.modelContent : null
      if (content && parsePauseResult(content)) {
        content = `waiting for user (${interaction.kind}:${interaction.id})`
      } else if (content === null) {
        content = 'skipped because the turn paused for user input'
      }
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content })
      if (currentId && call.id === currentId) currentId = ''
    }
    return messages
  }

  private async emitToolCall(call: ToolCallRequest, emit: StreamEmitter | null): Promise<void> {
    if (emit) await emit({ event: 'tool_call', id: call.id, name: call.name, arguments: call.arguments })
  }

  private async emitAgentThought(event: Record<string, unknown>, emit: StreamEmitter | null): Promise<void> {
    if (emit) await emit(event)
  }

  private async emitToolResult(call: ToolCallRequest, result: ToolResultObj | string, emit: StreamEmitter | null): Promise<void> {
    if (!emit) return
    const r = result instanceof ToolResultObj ? result : ToolResultObj.fromText(String(result), { isError: String(result).startsWith('Error:') })
    const payload: Msg = { event: 'tool_result', id: call.id, name: call.name, summary: summarizeToolResult(r.summary) }
    Object.assign(payload, runtimeEvents.compactRuntimeToolOutput(r.modelContent))
    if (r.isError) payload.is_error = true
    const artifacts = r.artifactPayloads()
    if (artifacts.length) payload.artifacts = artifacts
    if (Object.keys(r.metadata).length) payload.metadata = r.metadata
    if (call.name === 'update_todos' && this.todoStore !== null) {
      payload.todos = this.todoStore.todos.map((t) => ({
        id: t.id,
        ...(t.plan_step_id ? { plan_step_id: t.plan_step_id } : {}),
        content: t.content,
        status: t.status,
        ...(t.blocked_reason ? { blocked_reason: t.blocked_reason } : {}),
      }))
    }
    await emit(payload)
  }

  /** 压缩判定用的有效上下文上限：预留本回合输出 maxTokens，至少保留半个窗口。 */
  private effectiveMaxContext(): number {
    return Math.max(Math.trunc(this.maxContext / 2), this.maxContext - this.maxTokens)
  }

  private async maybeCompact(history: Msg[], emit: StreamEmitter | null, turnId: string | null): Promise<void> {
    if (!(this.compactor && this.tokenTracker)) return
    if (!this.tokenTracker.shouldCompact(this.effectiveMaxContext(), this.compactThreshold)) return
    try {
      if (typeof this.compactor.compactAsync === 'function') {
        const out = await this.compactor.compactAsync(history)
        history.splice(0, history.length, ...out)
      } else if (typeof this.compactor.compact === 'function') {
        const out = this.compactor.compact(history)
        history.splice(0, history.length, ...out)
      }
    } catch (exc) {
      if (emit) {
        await emit({
          event: 'record_degraded',
          kind: 'memory_compaction',
          reason: String(exc instanceof Error ? exc.message : exc).slice(0, 500),
          taskId: turnId ?? undefined,
        })
      }
    }
  }

  private defaultContextPipeline(): ContextPipeline {
    const planContextProvider = this.defaultPlanContextProvider()
    if (!this.memoryStore?.memoryDir) return new ContextPipeline({ planContextProvider })
    try {
      return new ContextPipeline({
        toolResultStore: new ToolResultStore(dirname(this.memoryStore.memoryDir)),
        toolResultLimits: this.registry.toolResultLimits(),
        planContextProvider,
      })
    } catch {
      return new ContextPipeline({ planContextProvider })
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
        toolResultStore: new ToolResultStore(dirname(this.memoryStore.memoryDir)),
        toolResultLimits: this.registry.toolResultLimits(),
      })
    } catch {
      return new ContextPipeline(common)
    }
  }

  private defaultPlanContextProvider(): PlanContextProvider | null {
    if (!this.controlManager?.planStore) return null
    const builder = new PlanContextBuilder(this.controlManager.planStore, {
      filter: (record) => this.controlManager?.planMatchesCurrentScope?.(record) ?? true,
    })
    return (history) => builder.messageFor(history)
  }

  private reasoningEnabled(): boolean {
    return Boolean(this.reasoningEffort && !['none', 'minimal', 'minimum'].includes(this.reasoningEffort.toLowerCase()))
  }

}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw new CancelledTaskError('turn')
}

function planFollowupSignature(followup: Record<string, unknown>): string {
  const plan = followup.plan && typeof followup.plan === 'object' ? followup.plan as Record<string, unknown> : null
  const steps = Array.isArray(plan?.steps)
    ? plan.steps
      .filter((step): step is Record<string, unknown> => Boolean(step && typeof step === 'object' && !Array.isArray(step)))
      .filter((step) => step.status !== 'done' && step.status !== 'skipped')
      .map((step) => `${String(step.id ?? '')}:${String(step.status ?? '')}`)
      .join('|')
    : String(followup.message ?? '')
  return `${String(followup.plan_id ?? '')}:${steps}`
}
