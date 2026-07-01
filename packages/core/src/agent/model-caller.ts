/**
 * ModelCaller (MIG-CORE-001)。对齐 Python `agent/runner_model.py`。
 * 统一模型调用 + 次模型失败一次性升主；记 _lastModelCall（route_reason/估算输入/fallback）。
 */
import { parseJsonArgs, type ChatArgs, type ChatStreamArgs, type GenerationSettings, type LLMProvider, type LLMResponse, type ToolCallDelta } from '../providers/base'
import * as runtimeEvents from './runtime-events'

export type StreamEmitter = (event: Record<string, unknown>) => void | Promise<void>

export interface ModelCallMeta {
  model: string
  provider: string | null
  modelRole: string
  routeReason: string
  routeEstimatedTokens: number | null
  estimatedInputTokens: number | null
  usedFallback: boolean
  fallbackReason: string
}

/** ModelCaller 依赖的 runner 表面。 */
export interface RunnerModelHost {
  provider: LLMProvider
  model: string
  providerName: string | null
  modelRole: string
  routeReason: string
  routeEstimatedTokens: number | null
  maxTokens: number
  temperature: number
  reasoningEffort: string | null
  usageType: string
  fallbackProvider: LLMProvider | null
  fallbackModel: string | null
  fallbackProviderName: string | null
  fallbackGeneration: GenerationSettings | null
  fallbackModelRole: string
  lastEstimatedInputTokens: number | null
  lastModelCall: ModelCallMeta
}

export class ModelCaller {
  private readonly runner: RunnerModelHost
  constructor(runner: RunnerModelHost) { this.runner = runner }

  async ask(opts: {
    messages: ChatArgs['messages']
    tools: Array<Record<string, unknown>> | null
    emit: StreamEmitter | null
  }): Promise<LLMResponse> {
    const runner = this.runner
    const onDelta = async (delta: string): Promise<void> => {
      if (opts.emit) await opts.emit({ event: 'message_delta', delta })
    }
    const onToolCallDelta = async (delta: ToolCallDelta): Promise<void> => {
      if (!opts.emit) return
      const event = planDraftDeltaFromToolDelta(delta)
      if (event) await opts.emit(event)
    }
    try {
      runner.lastModelCall = {
        model: runner.model,
        provider: runner.providerName,
        modelRole: runner.modelRole,
        routeReason: runner.routeReason,
        routeEstimatedTokens: runner.routeEstimatedTokens,
        estimatedInputTokens: runner.lastEstimatedInputTokens,
        usedFallback: false,
        fallbackReason: '',
      }
      return await ModelCaller.callProvider({
        provider: runner.provider,
        model: runner.model,
        maxTokens: runner.maxTokens,
        temperature: runner.temperature,
        reasoningEffort: runner.reasoningEffort,
        messages: opts.messages,
        tools: opts.tools,
        emit: opts.emit,
        onDelta,
        onToolCallDelta,
      })
    } catch (exc) {
      if (!(runner.fallbackProvider && runner.fallbackModel)) throw exc
      if (opts.emit) {
        await opts.emit(
          runtimeEvents.modelRouteFallback({
            fromModel: runner.model,
            toModel: runner.fallbackModel,
            reason: String(exc),
            usageType: runner.usageType,
          }),
        )
      }
      const generation = runner.fallbackGeneration
      runner.lastModelCall = {
        model: runner.fallbackModel,
        provider: runner.fallbackProviderName,
        modelRole: runner.fallbackModelRole,
        routeReason: `${runner.routeReason}:fallback`,
        routeEstimatedTokens: runner.routeEstimatedTokens,
        estimatedInputTokens: runner.lastEstimatedInputTokens,
        usedFallback: true,
        fallbackReason: String(exc),
      }
      return await ModelCaller.callProvider({
        provider: runner.fallbackProvider,
        model: runner.fallbackModel,
        maxTokens: Math.min(runner.maxTokens, Number(generation?.maxTokens ?? runner.maxTokens) || runner.maxTokens),
        temperature: generation?.temperature ?? runner.temperature,
        reasoningEffort: generation?.reasoningEffort ?? runner.reasoningEffort,
        messages: opts.messages,
        tools: opts.tools,
        emit: opts.emit,
        onDelta,
        onToolCallDelta,
      })
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
    onToolCallDelta: (delta: ToolCallDelta) => Promise<void>
  }): Promise<LLMResponse> {
    if (opts.emit) {
      const args: ChatStreamArgs = {
        messages: opts.messages,
        tools: opts.tools,
        model: opts.model,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        reasoningEffort: opts.reasoningEffort,
        onContentDelta: opts.onDelta,
        onToolCallDelta: opts.onToolCallDelta,
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
    }
    return opts.provider.chat(args)
  }
}

function planDraftDeltaFromToolDelta(delta: ToolCallDelta): Record<string, unknown> | null {
  if (delta.name !== 'propose_plan') return null
  const args = parseJsonArgs(delta.argumentsText)
  const title = textField(args, 'title')
  const summary = textField(args, 'summary')
  const planMarkdown = textField(args, 'plan_markdown') || textField(args, 'planMarkdown')
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
    risk_level: textField(args, 'risk_level') || textField(args, 'riskLevel') || 'medium',
    meta: { plan_stream_id: streamId, provisional: true },
  }
  return runtimeEvents.planDraftDelta({ toolCallId: streamId, interaction })
}

function textField(value: Record<string, unknown>, key: string): string {
  const raw = value[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const raw = value[key]
  if (!Array.isArray(raw)) return []
  return raw.map((item) => String(item || '').trim()).filter(Boolean)
}
