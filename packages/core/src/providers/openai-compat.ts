/**
 * OpenAI-compat provider (MIG-PROV-003)。
 * 对齐 Python `agent/providers/openai_compat.py`。
 */
import OpenAI from 'openai'
import {
  reasoningPayload,
  type ReasoningEffort,
} from '../model/profile'
import { logger } from '../util/log'
import { normalizeApiBase, type ProviderSpec } from './registry'
import {
  DEFAULT_MAX_RETRIES,
  LLMProvider,
  type LLMResponse,
  type ToolCallRequest,
  type ChatArgs,
  type ChatStreamArgs,
  type OpenAiMessage,
  type ToolCallCompleteHandler,
  messagesForProfile,
  parseJsonArgs,
} from './base'

const UI_AND_CORE_BODY_FIELDS = new Set([
  'activeModelId',
  'apiBase',
  'apiBases',
  'apiKey',
  'capabilityOverrides',
  'contextWindowTokens',
  'defaultModel',
  'defaultProtocol',
  'displayName',
  'entryId',
  'extraBody',
  'extraHeaders',
  'iconId',
  'legacy',
  'maxTokens',
  'messages',
  'model',
  'modelId',
  'profile',
  'protocols',
  'provider',
  'protocol',
  'reasoning',
  'reasoningAdapter',
  'reasoningEffort',
  'reasoningEfforts',
  'reasoning_effort',
  'reasoning_split',
  'schemaVersion',
  'sources',
  'stream',
  'temperature',
  'thinking',
  'toolCall',
  'vision',
  'enable_thinking',
  'tool_choice',
  'tools',
  'max_tokens',
  'max_completion_tokens',
])
const NO_TEMPERATURE_MODEL_RE =
  /(?:^|[/._-])(?:gpt-5|o[134])(?:$|[/._-])/

export class OpenAICompatProvider extends LLMProvider {
  readonly spec: ProviderSpec | undefined
  readonly client: OpenAI

  constructor(
    cfg: ConstructorParameters<typeof LLMProvider>[0] & { spec?: ProviderSpec },
  ) {
    super(cfg)
    this.spec = cfg.spec
    const configuredBase = this.apiBase || cfg.spec?.apiBases.openai
    this.client = new OpenAI({
      apiKey: this.apiKey || 'no-key',
      baseURL: configuredBase
        ? normalizeApiBase('openai', configuredBase)
        : undefined,
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
    const resp = await this.client.chat.completions.create(
      {
        ...(this.kwargsFor(args, false) as any),
        stream: false,
      },
      OpenAICompatProvider.requestOptions(args),
    )
    const choice = resp.choices[0]!
    const m = choice.message as any
    const tc: ToolCallRequest[] = ((m?.tool_calls ?? []) as any[]).map(
      (tc) => ({
        id: tc.id as string,
        name: tc.function?.name ?? '',
        arguments: parseJsonArgs(tc.function?.arguments),
      }),
    )
    return {
      content: (m?.content ?? null) as string | null,
      toolCalls: tc,
      finishReason: tc.length ? 'tool_calls' : choice.finish_reason || 'stop',
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
      stream = await this.client.chat.completions.create(
        { ...(streamKwargs as any), stream: true },
        OpenAICompatProvider.requestOptions(args),
      )
    } catch (exc: unknown) {
      if (!streamUsageUnsupported(String(exc))) throw exc
      logger.debug(
        `Provider does not support stream usage, retrying without it: ${String(exc)}`,
      )
      delete (streamKwargs as any).stream_options
      stream = await this.client.chat.completions.create(
        { ...(streamKwargs as any), stream: true },
        OpenAICompatProvider.requestOptions(args),
      )
    }
    const contentParts: string[] = []
    const reasoningParts: string[] = []
    const toolChunks = new Map<
      number,
      { id: string; name: string; arguments: string; fired?: boolean }
    >()
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
        if (!buf) {
          // 新 index 出现 → 上一个 index 的参数已流完，可提前回调（Wave5）
          for (const [doneIdx, doneBuf] of toolChunks) {
            if (doneIdx < idx)
              OpenAICompatProvider.fireCompletedToolChunk(
                doneBuf,
                args.onToolCallComplete,
              )
          }
          buf = { id: '', name: '', arguments: '' }
          toolChunks.set(idx, buf)
        }
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
    // 收尾：所有尚未回调的 index 在流结束时补发（Wave5）
    for (const buf of toolChunks.values())
      OpenAICompatProvider.fireCompletedToolChunk(buf, args.onToolCallComplete)
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

  private static requestOptions(
    args: ChatArgs,
  ): Record<string, unknown> | undefined {
    return args.signal ? { signal: args.signal } : undefined
  }

  kwargsFor(args: ChatArgs, stream: boolean): Record<string, unknown> {
    const modelName = this.modelName(args.model)
    const reasoningEffort = this.reasoningEffort(args)
    const reasoning = reasoningEffort
      ? reasoningPayload(this.profile, reasoningEffort)
      : {}
    const kwargs: Record<string, unknown> = {
      model: modelName,
      messages: this.sanitizeMessages(
        messagesForProfile(args.messages, this.profile),
        reasoningEffort,
      ),
      stream,
    }
    if (!this.temperatureForbidden(modelName, reasoningEffort)) {
      kwargs.temperature = args.temperature ?? this.generation.temperature
    }
    const maxTokens = Math.min(
      this.profile.maxTokens,
      Math.max(1, args.maxTokens ?? this.generation.maxTokens),
    )
    if (this.spec?.supportsMaxCompletionTokens) {
      kwargs.max_completion_tokens = maxTokens
    } else {
      kwargs.max_tokens = maxTokens
    }
    if (args.tools?.length && this.profile.toolCall) {
      kwargs.tools = LLMProvider.anthropicToolsToOpenai(args.tools)
      kwargs.tool_choice = 'auto'
    }
    for (const [key, value] of Object.entries(this.extraBody)) {
      if (!UI_AND_CORE_BODY_FIELDS.has(key)) kwargs[key] = value
    }
    Object.assign(kwargs, reasoning)
    return kwargs
  }

  temperatureForbidden(model: string, reasoningEffort: string | null): boolean {
    const name = model.toLowerCase()
    const effort = asReasoningEffort(reasoningEffort)
    const reasoningEnabled =
      effort !== null &&
      effort !== 'none' &&
      Object.keys(reasoningPayload(this.profile, effort)).length > 0
    return reasoningEnabled || NO_TEMPERATURE_MODEL_RE.test(name)
  }

  private reasoningEffort(args: ChatArgs): ReasoningEffort | null {
    return asReasoningEffort(
      args.reasoningEffort === undefined
        ? this.generation.reasoningEffort
        : args.reasoningEffort,
    )
  }

  sanitizeMessages(
    messages: OpenAiMessage[],
    reasoningEffort: string | null,
  ): OpenAiMessage[] {
    const allowed = new Set([
      'role',
      'content',
      'tool_calls',
      'tool_call_id',
      'name',
      'reasoning_content',
      'extra_content',
    ])
    const clean: OpenAiMessage[] = messages.map((msg) => {
      const out: OpenAiMessage = { role: 'user' }
      for (const k of Object.keys(msg)) {
        if (allowed.has(k)) (out as any)[k] = (msg as any)[k]
      }
      if (out.role === 'assistant' && out.tool_calls)
        out.content = out.content ?? null
      return out
    })
    if (this.requiresReasoningBackfill(reasoningEffort)) {
      for (const msg of clean) {
        if (msg.role === 'assistant' && msg.reasoning_content === undefined)
          msg.reasoning_content = ''
      }
    }
    return clean
  }

  requiresReasoningBackfill(reasoningEffort: string | null): boolean {
    const resolvedEffort = asReasoningEffort(reasoningEffort?.toLowerCase())
    const vendorRequiresBackfill = [
      'thinking_toggle',
      'enable_thinking_toggle',
      'reasoning_split_toggle',
    ].includes(this.profile.reasoningAdapter)
    return Boolean(
      vendorRequiresBackfill &&
      resolvedEffort &&
      resolvedEffort !== 'none' &&
      Object.keys(reasoningPayload(this.profile, resolvedEffort)).length,
    )
  }

  /** 单个已流完的 tool 分片解析为 ToolCallRequest 并回调一次（幂等：拼好名字才发）。 */
  static fireCompletedToolChunk(
    buf: { id: string; name: string; arguments: string; fired?: boolean },
    handler?: ToolCallCompleteHandler,
  ): void {
    if (!handler || buf.fired || !buf.name) return
    buf.fired = true
    void handler({
      id: buf.id || `call_${buf.name}`,
      name: buf.name,
      arguments: parseJsonArgs(buf.arguments),
    })
  }

  static parseUsage(usage: any): Record<string, number> {
    if (!usage) return {}
    const prompt = OpenAICompatProvider.usageInt(usage, 'prompt_tokens')
    const completion = OpenAICompatProvider.usageInt(usage, 'completion_tokens')
    const details = OpenAICompatProvider.usageField(
      usage,
      'prompt_tokens_details',
    )
    const cached = OpenAICompatProvider.usageInt(details, 'cached_tokens')
    const cacheCreate =
      OpenAICompatProvider.usageInt(details, 'cache_creation_tokens') ||
      OpenAICompatProvider.usageInt(details, 'cache_creation_input_tokens') ||
      OpenAICompatProvider.usageInt(usage, 'cache_creation_input_tokens')
    return {
      input: Math.max(0, prompt - cached - cacheCreate),
      output: completion,
      cache_read: cached,
      cache_create: cacheCreate,
    }
  }

  static usageField(value: any, key: string): any {
    if (value == null) return null
    if (typeof value === 'object' && !Array.isArray(value)) {
      if (key in value) return (value as any)[key]
      if (value.model_extra && key in value.model_extra)
        return value.model_extra[key]
      if (typeof value.model_dump === 'function') {
        try {
          const d = value.model_dump()
          if (d && typeof d === 'object' && key in d) return d[key]
        } catch {
          /* ignore */
        }
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
    const value =
      (msg as any).reasoning_content ??
      (msg as any).reasoning ??
      (msg as any).model_extra?.reasoning_content ??
      (msg as any).model_extra?.reasoning
    if (typeof value === 'string') return value
    if (Array.isArray(value))
      return (
        value
          .filter((x) => x != null)
          .map(String)
          .join('') || null
      )
    return null
  }
}

function streamUsageUnsupported(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('stream_options') || lower.includes('include_usage')
}

function asReasoningEffort(value: string | null | undefined): ReasoningEffort | null {
  return [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ].includes(value ?? '')
    ? (value as ReasoningEffort)
    : null
}
