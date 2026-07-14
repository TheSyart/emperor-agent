/**
 * ModelCaller (MIG-CORE-001)。对齐 Python `agent/runner_model.py`。
 * 统一调用全局激活模型并记录重试元数据；不执行跨模型 fallback。
 */
import {
  parseJsonArgs,
  type ChatArgs,
  type ChatStreamArgs,
  type LLMProvider,
  type LLMResponse,
  type ToolCallDelta,
  type ToolCallRequest,
} from '../providers/base'
import {
  classifyProviderError,
  isContextOverflowProviderError,
  isRetryableProviderErrorKind,
  type ProviderErrorKind,
} from '../providers/errors'
import { ModelProviderError, type ModelProviderErrorKind } from '../errors'
import * as runtimeEvents from './runtime-events'

export type StreamEmitter = (
  event: Record<string, unknown>,
) => void | Promise<void>

export interface ModelCallMeta {
  model: string
  provider: string | null
  modelEntryId: string
  routeReason: string
  routeEstimatedTokens: number | null
  estimatedInputTokens: number | null
  providerRetryCount: number
  providerErrorKind: string
}

/** ModelCaller 依赖的 runner 表面。 */
export interface RunnerModelHost {
  provider: LLMProvider
  model: string
  providerName: string | null
  modelEntryId: string
  supportsToolCall: boolean
  routeReason: string
  routeEstimatedTokens: number | null
  maxTokens: number
  temperature: number
  reasoningEffort: string | null
  usageType: string
  lastEstimatedInputTokens: number | null
  lastModelCall: ModelCallMeta
}

export class ModelCaller {
  private readonly runner: RunnerModelHost
  constructor(runner: RunnerModelHost) {
    this.runner = runner
  }

  async ask(opts: {
    messages: ChatArgs['messages']
    tools: Array<Record<string, unknown>> | null
    emit: StreamEmitter | null
    signal?: AbortSignal | null
    onToolCallComplete?:
      ((call: ToolCallRequest) => void | Promise<void>) | null
  }): Promise<LLMResponse> {
    const runner = this.runner
    const onDelta = async (delta: string): Promise<void> => {
      if (opts.emit) await opts.emit({ event: 'message_delta', delta })
    }
    // B6：plan 起草 delta 是全量快照，按时间窗合并落盘（实测 27 秒 1421 条 → 约每 100ms 一条）
    const planDeltaThrottle = createPlanDeltaThrottle(
      opts.emit,
      PLAN_DELTA_INTERVAL_MS,
    )
    const onToolCallDelta = planDeltaThrottle.onDelta
    const onToolCallComplete = opts.onToolCallComplete ?? null
    let retryCount = 0
    let errorKind = ''
    runner.lastModelCall = {
      model: runner.model,
      provider: runner.providerName,
      modelEntryId: runner.modelEntryId,
      routeReason: runner.routeReason,
      routeEstimatedTokens: runner.routeEstimatedTokens,
      estimatedInputTokens: runner.lastEstimatedInputTokens,
      providerRetryCount: 0,
      providerErrorKind: '',
    }
    const result = await ModelCaller.callProviderWithRetries({
      provider: runner.provider,
      model: runner.model,
      providerName: runner.providerName,
      usageType: runner.usageType,
      maxTokens: runner.maxTokens,
      temperature: runner.temperature,
      reasoningEffort: runner.reasoningEffort,
      messages: opts.messages,
      tools: runner.supportsToolCall ? opts.tools : null,
      emit: opts.emit,
      onDelta,
      onToolCallDelta: runner.supportsToolCall ? onToolCallDelta : null,
      onToolCallComplete: runner.supportsToolCall ? onToolCallComplete : null,
      signal: opts.signal ?? null,
      onRetry: (count, kind) => {
        retryCount = count
        errorKind = kind
      },
    })
    retryCount = result.retryCount
    errorKind = result.errorKind
    runner.lastModelCall = {
      ...runner.lastModelCall,
      providerRetryCount: retryCount,
      providerErrorKind: errorKind,
    }
    await planDeltaThrottle.flush()
    return runner.supportsToolCall
      ? result.response
      : { ...result.response, toolCalls: [] }
  }

  private static async callProviderWithRetries(opts: {
    provider: LLMProvider
    model: string
    providerName: string | null
    usageType: string
    maxTokens: number
    temperature: number
    reasoningEffort: string | null
    messages: ChatArgs['messages']
    tools: Array<Record<string, unknown>> | null
    emit: StreamEmitter | null
    onDelta: (delta: string) => Promise<void>
    onToolCallDelta?: ((delta: ToolCallDelta) => Promise<void>) | null
    onToolCallComplete?:
      ((call: ToolCallRequest) => void | Promise<void>) | null
    signal: AbortSignal | null
    onRetry?: (retryCount: number, errorKind: ProviderErrorKind) => void
  }): Promise<{
    response: LLMResponse
    retryCount: number
    errorKind: ProviderErrorKind | ''
  }> {
    let retryCount = 0
    let lastKind: ProviderErrorKind | '' = ''
    while (true) {
      try {
        const response = await ModelCaller.callProvider(opts)
        return { response, retryCount, errorKind: lastKind }
      } catch (exc) {
        const kind = classifyProviderError(exc)
        lastKind = kind
        if (isContextOverflowProviderError(exc)) throw exc
        if (
          !isRetryableProviderErrorKind(kind) ||
          retryCount >= MODEL_CALL_MAX_RETRIES
        ) {
          throw new ModelProviderError(modelProviderErrorKind(kind), {
            cause: exc,
          })
        }
        retryCount += 1
        if (opts.emit) {
          await opts.emit({
            event: 'model_provider_retry',
            model: opts.model,
            provider: opts.providerName,
            usage_type: opts.usageType,
            attempt: retryCount,
            max_retries: MODEL_CALL_MAX_RETRIES,
            error_kind: kind,
            reason: String(exc instanceof Error ? exc.message : exc).slice(
              0,
              500,
            ),
          })
        }
        opts.onRetry?.(retryCount, kind)
        await boundedRetryBackoff(retryCount)
      }
    }
  }

  private static async callProvider(opts: {
    provider: LLMProvider
    model: string
    maxTokens: number
    temperature: number
    reasoningEffort: string | null
    messages: ChatArgs['messages']
    tools: Array<Record<string, unknown>> | null
    emit: StreamEmitter | null
    onDelta: (delta: string) => Promise<void>
    onToolCallDelta?: ((delta: ToolCallDelta) => Promise<void>) | null
    onToolCallComplete?:
      ((call: ToolCallRequest) => void | Promise<void>) | null
    signal: AbortSignal | null
  }): Promise<LLMResponse> {
    if (opts.emit || opts.onToolCallComplete) {
      const args: ChatStreamArgs = {
        messages: opts.messages,
        tools: opts.tools,
        model: opts.model,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        reasoningEffort: opts.reasoningEffort,
        onContentDelta: opts.onDelta,
        onToolCallDelta: opts.onToolCallDelta ?? undefined,
        onToolCallComplete: opts.onToolCallComplete ?? undefined,
        signal: opts.signal,
      }
      return opts.provider.chatStream(args)
    }
    const args: ChatArgs = {
      messages: opts.messages,
      tools: opts.tools,
      model: opts.model,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      reasoningEffort: opts.reasoningEffort,
      signal: opts.signal,
    }
    return opts.provider.chat(args)
  }
}

function modelProviderErrorKind(
  kind: ProviderErrorKind,
): ModelProviderErrorKind {
  if (
    kind === 'rate_limit' ||
    kind === 'auth' ||
    kind === 'transient' ||
    kind === 'permanent'
  )
    return kind
  return 'unknown'
}

const MODEL_CALL_MAX_RETRIES = 2

async function boundedRetryBackoff(retryCount: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(20 * retryCount, 100)),
  )
}

const PLAN_DELTA_INTERVAL_MS = 100

/**
 * plan_draft_delta 节流（B6）：每条 delta 都携带全量快照，窗口内只保留最新一条，
 * 流结束时 trailing flush 保证终态不丢。
 */
export function createPlanDeltaThrottle(
  emit: StreamEmitter | null,
  intervalMs = PLAN_DELTA_INTERVAL_MS,
): {
  onDelta: (delta: ToolCallDelta) => Promise<void>
  flush: () => Promise<void>
} {
  let lastEmitMs = 0
  let pending: Record<string, unknown> | null = null
  return {
    async onDelta(delta: ToolCallDelta): Promise<void> {
      if (!emit) return
      const event = planDraftDeltaFromToolDelta(delta)
      if (!event) return
      const now = Date.now()
      if (now - lastEmitMs >= intervalMs) {
        lastEmitMs = now
        pending = null
        await emit(event)
        return
      }
      pending = event
    },
    async flush(): Promise<void> {
      if (pending === null || !emit) return
      const event = pending
      pending = null
      await emit(event)
    },
  }
}

function planDraftDeltaFromToolDelta(
  delta: ToolCallDelta,
): Record<string, unknown> | null {
  if (delta.name !== 'propose_plan') return null
  const args = parseJsonArgs(delta.argumentsText)
  const title = textField(args, 'title')
  const summary = textField(args, 'summary')
  const planMarkdown =
    textField(args, 'plan_markdown') || textField(args, 'planMarkdown')
  if (!title && !summary && !planMarkdown) return null
  const streamId = delta.id || `call_${delta.index}`
  const interaction: Record<string, unknown> = {
    id: `provisional-plan-${streamId}`,
    kind: 'plan',
    status: 'waiting',
    parent_call_id: streamId,
    title,
    summary,
    plan_markdown: planMarkdown,
    assumptions: stringArrayField(args, 'assumptions'),
    risk_level:
      textField(args, 'risk_level') || textField(args, 'riskLevel') || 'medium',
    meta: { plan_stream_id: streamId, provisional: true },
  }
  return runtimeEvents.planDraftDelta({ toolCallId: streamId, interaction })
}

function textField(value: Record<string, unknown>, key: string): string {
  const raw = value[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

function stringArrayField(
  value: Record<string, unknown>,
  key: string,
): string[] {
  const raw = value[key]
  if (!Array.isArray(raw)) return []
  return raw.map((item) => String(item || '').trim()).filter(Boolean)
}
