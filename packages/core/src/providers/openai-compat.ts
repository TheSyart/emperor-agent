/**
 * OpenAI-compat provider (MIG-PROV-003)。
 * 对齐 Python `agent/providers/openai_compat.py`。
 */
import OpenAI from 'openai'
import { logger } from '../util/log'
import type { ProviderSpec } from './registry'
import {
  DEFAULT_MAX_RETRIES,
  LLMProvider,
  type LLMResponse,
  type ToolCallRequest,
  type ChatArgs,
  type ChatStreamArgs,
  type OpenAiMessage,
  parseJsonArgs,
} from './base'

export class OpenAICompatProvider extends LLMProvider {
  readonly spec: ProviderSpec | undefined
  readonly client: OpenAI

  constructor(cfg: ConstructorParameters<typeof LLMProvider>[0] & { spec?: ProviderSpec }) {
    super(cfg)
    this.spec = cfg.spec
    this.client = new OpenAI({
      apiKey: this.apiKey || 'no-key',
      baseURL: this.apiBase || (cfg.spec?.defaultApiBase ?? undefined),
      defaultHeaders: this.extraHeaders,
      maxRetries: DEFAULT_MAX_RETRIES,
      timeout: 600_000,
    })
  }

  modelName(model: string | null | undefined): string {
    const name = model || this.defaultModel
    return this.spec?.stripModelPrefix ? name.split('/').pop()! : name
  }

  override async chat(args: ChatArgs): Promise<LLMResponse> {
    const resp = await this.client.chat.completions.create({
      ...(this.kwargsFor(args, false) as any),
      stream: false,
    })
    const choice = resp.choices[0]!
    const m = choice.message as any
    const tc: ToolCallRequest[] = ((m?.tool_calls ?? []) as any[]).map((tc) => ({
      id: tc.id as string,
      name: tc.function?.name ?? '',
      arguments: parseJsonArgs(tc.function?.arguments),
    }))
    return {
      content: (m?.content ?? null) as string | null,
      toolCalls: tc,
      finishReason: tc.length ? 'tool_calls' : (choice.finish_reason || 'stop'),
      usage: OpenAICompatProvider.parseUsage(resp.usage),
      reasoningContent: OpenAICompatProvider.messageReasoning(m),
      thinkingBlocks: null,
    }
  }

  override async chatStream(args: ChatStreamArgs): Promise<LLMResponse> {
    const streamKwargs = this.kwargsFor(args, true)
    ;(streamKwargs as any).stream_options = { include_usage: true }
    let stream: any
    try {
      stream = await this.client.chat.completions.create({ ...(streamKwargs as any), stream: true })
    } catch (exc: unknown) {
      if (!streamUsageUnsupported(String(exc))) throw exc
      logger.debug(`Provider does not support stream usage, retrying without it: ${String(exc)}`)
      delete (streamKwargs as any).stream_options
      stream = await this.client.chat.completions.create({ ...(streamKwargs as any), stream: true })
    }
    const contentParts: string[] = []
    const reasoningParts: string[] = []
    const toolChunks = new Map<number, { id: string; name: string; arguments: string }>()
    let finishReason = 'stop'
    let usage: Record<string, number> = {}
    for await (const chunk of stream) {
      if (chunk.usage) usage = OpenAICompatProvider.parseUsage(chunk.usage)
      if (!chunk.choices.length) continue
      const choice = chunk.choices[0]!
      finishReason = choice.finish_reason || finishReason
      const delta = choice.delta
      if (delta.content) {
        contentParts.push(delta.content)
        await args.onContentDelta?.(delta.content)
      }
      const reasoning = OpenAICompatProvider.messageReasoning(delta)
      if (reasoning) reasoningParts.push(reasoning)
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0
        let buf = toolChunks.get(idx)
        if (!buf) { buf = { id: '', name: '', arguments: '' }; toolChunks.set(idx, buf) }
        if (tc.id) buf.id += tc.id
        if (tc.function?.name) buf.name += tc.function.name
        if (tc.function?.arguments) buf.arguments += tc.function.arguments
        await args.onToolCallDelta?.({
          index: idx,
          id: buf.id || `call_${idx}`,
          name: buf.name,
          argumentsText: buf.arguments,
        })
      }
    }
    const toolCalls: ToolCallRequest[] = [...toolChunks.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, b]) => b.name)
      .map(([idx, b]) => ({
        id: b.id || `call_${idx}`,
        name: b.name,
        arguments: parseJsonArgs(b.arguments),
      }))
    return {
      content: contentParts.join('') || null,
      toolCalls,
      finishReason: toolCalls.length ? 'tool_calls' : finishReason,
      usage,
      reasoningContent: reasoningParts.join('') || null,
      thinkingBlocks: null,
    }
  }

  kwargsFor(args: ChatArgs, stream: boolean): Record<string, unknown> {
    const modelName = this.modelName(args.model)
    const reasoningEffort = args.reasoningEffort ?? null
    const kwargs: Record<string, unknown> = {
      model: modelName,
      messages: this.sanitizeMessages(args.messages, modelName, reasoningEffort),
      stream,
    }
    if (!this.temperatureForbidden(modelName, reasoningEffort)) {
      kwargs.temperature = args.temperature ?? 0.7
    }
    if (this.spec?.supportsMaxCompletionTokens) {
      kwargs.max_completion_tokens = Math.max(1, args.maxTokens ?? 4096)
    } else {
      kwargs.max_tokens = Math.max(1, args.maxTokens ?? 4096)
    }
    if (reasoningEffort && reasoningEffort !== 'none') kwargs.reasoning_effort = reasoningEffort
    if (args.tools?.length) {
      kwargs.tools = LLMProvider.anthropicToolsToOpenai(args.tools)
      kwargs.tool_choice = 'auto'
    }
    const extraBody = this.extraBodyForReasoning(reasoningEffort)
    if (Object.keys(this.extraBody).length) Object.assign(extraBody, this.extraBody)
    if (Object.keys(extraBody).length) kwargs.extra_body = extraBody
    return kwargs
  }

  temperatureForbidden(model: string, reasoningEffort: string | null): boolean {
    const name = model.toLowerCase()
    return Boolean(reasoningEffort && reasoningEffort !== 'none') || ['gpt-5', 'o1', 'o3', 'o4'].some((t) => name.includes(t))
  }

  extraBodyForReasoning(reasoningEffort: string | null): Record<string, unknown> {
    if (!this.spec?.thinkingStyle || reasoningEffort === null) return {}
    const enabled = !['none', 'minimal', 'minimum'].includes(reasoningEffort)
    switch (this.spec.thinkingStyle) {
      case 'thinking_type': return { thinking: { type: enabled ? 'enabled' : 'disabled' } }
      case 'enable_thinking': return { enable_thinking: enabled }
      case 'reasoning_split': return { reasoning_split: enabled }
    }
    return {}
  }

  sanitizeMessages(messages: OpenAiMessage[], modelName: string, reasoningEffort: string | null): OpenAiMessage[] {
    const allowed = new Set(['role', 'content', 'tool_calls', 'tool_call_id', 'name', 'reasoning_content', 'extra_content'])
    const clean: OpenAiMessage[] = messages.map((msg) => {
      const out: OpenAiMessage = { role: 'user' }
      for (const k of Object.keys(msg)) {
        if (allowed.has(k)) (out as any)[k] = (msg as any)[k]
      }
      if (out.role === 'assistant' && out.tool_calls) out.content = out.content ?? null
      return out
    })
    if (this.requiresReasoningBackfill(modelName, reasoningEffort)) {
      for (const msg of clean) {
        if (msg.role === 'assistant' && msg.reasoning_content === undefined) msg.reasoning_content = ''
      }
    }
    return clean
  }

  requiresReasoningBackfill(modelName: string, reasoningEffort: string | null): boolean {
    const effort = typeof reasoningEffort === 'string' ? reasoningEffort.toLowerCase() : null
    const explicit = !!(reasoningEffort !== null && effort && !['none', 'minimal', 'minimum'].includes(effort) && this.spec?.thinkingStyle)
    const deepseekArg = !!(this.spec?.name === 'deepseek' && effort && !['none', 'minimal', 'minimum'].includes(effort) && ['deepseek-v4', 'deepseek-reasoner'].some((t) => modelName.toLowerCase().includes(t)))
    return explicit || deepseekArg
  }

  static parseUsage(usage: any): Record<string, number> {
    if (!usage) return {}
    const prompt = OpenAICompatProvider.usageInt(usage, 'prompt_tokens')
    const completion = OpenAICompatProvider.usageInt(usage, 'completion_tokens')
    const details = OpenAICompatProvider.usageField(usage, 'prompt_tokens_details')
    const cached = OpenAICompatProvider.usageInt(details, 'cached_tokens')
    const cacheCreate = OpenAICompatProvider.usageInt(details, 'cache_creation_tokens') ||
      OpenAICompatProvider.usageInt(details, 'cache_creation_input_tokens') ||
      OpenAICompatProvider.usageInt(usage, 'cache_creation_input_tokens')
    return { input: Math.max(0, prompt - cached - cacheCreate), output: completion, cache_read: cached, cache_create: cacheCreate }
  }

  static usageField(value: any, key: string): any {
    if (value == null) return null
    if (typeof value === 'object' && !Array.isArray(value)) {
      if (key in value) return (value as any)[key]
      if (value.model_extra && key in value.model_extra) return value.model_extra[key]
      if (typeof value.model_dump === 'function') {
        try { const d = value.model_dump(); if (d && typeof d === 'object' && key in d) return d[key] } catch { /* ignore */ }
      }
    }
    return null
  }

  static usageInt(value: any, key: string): number {
    const raw = OpenAICompatProvider.usageField(value, key)
    const n = Number(raw)
    return Number.isFinite(n) ? Math.trunc(n) : 0
  }

  static messageReasoning(msg: any): string | null {
    const value = (msg as any).reasoning_content ?? (msg as any).reasoning ?? (msg as any).model_extra?.reasoning_content ?? (msg as any).model_extra?.reasoning
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.filter((x) => x != null).map(String).join('') || null
    return null
  }
}

function streamUsageUnsupported(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('stream_options') || lower.includes('include_usage')
}

export class AzureOpenAIProvider extends OpenAICompatProvider {
  constructor(cfg: ConstructorParameters<typeof OpenAICompatProvider>[0]) {
    const base = cfg.apiBase?.replace(/\/$/, '')
    super({ ...cfg, apiBase: base ? `${base}/openai/v1/` : undefined })
  }
}

export class OpenAICodexProvider extends OpenAICompatProvider {}
export class GitHubCopilotProvider extends OpenAICompatProvider {}
