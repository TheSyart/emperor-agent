import Anthropic from '@anthropic-ai/sdk'
import { logger } from '../util/log'
import {
  type ChatArgs,
  type ChatStreamArgs,
  DEFAULT_MAX_RETRIES,
  LLMProvider,
  type LLMResponse,
  type OpenAiMessage,
  type ToolCallRequest,
  parseJsonArgs,
} from './base'

/**
 * Anthropic provider (MIG-PROV-004)。对齐 Python `agent/providers/anthropic_provider.py`。
 * 原生端点对 system 前缀与最后一个 tool 加 ephemeral cache_control；第三方代理保持 system 为字符串。
 */

const EPHEMERAL = { type: 'ephemeral' as const }

export class AnthropicProvider extends LLMProvider {
  readonly client: Anthropic

  constructor(cfg: ConstructorParameters<typeof LLMProvider>[0]) {
    super(cfg)
    this.client = new Anthropic({
      maxRetries: DEFAULT_MAX_RETRIES,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      ...(this.apiBase ? { baseURL: this.apiBase } : {}),
      ...(Object.keys(this.extraHeaders).length ? { defaultHeaders: this.extraHeaders } : {}),
    })
  }

  supportsPromptCaching(): boolean {
    const base = (this.apiBase ?? '').toLowerCase()
    return !base || base.includes('anthropic.com')
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    const resp = await this.client.messages.create({ ...(this.kwargsFor(args) as any), stream: false }, requestOptions(args.signal))
    return AnthropicProvider.parseResponse(resp)
  }

  override async chatStream(args: ChatStreamArgs): Promise<LLMResponse> {
    const stream = this.client.messages.stream(this.kwargsFor(args) as any, requestOptions(args.signal))
    if (args.onContentDelta) {
      stream.on('text', (text: string) => {
        void args.onContentDelta?.(text)
      })
    }
    const final = await stream.finalMessage()
    return AnthropicProvider.parseResponse(final)
  }

  /** 对齐 `_kwargs`：组装 Anthropic messages.create 请求体（含缓存门控）。 */
  kwargsFor(args: ChatArgs): Record<string, unknown> {
    const reasoningEffort = args.reasoningEffort ?? null
    const [system, messages] = this.convertMessages(args.messages)
    if (this.needsReasoningBackfill(reasoningEffort)) backfillReasoning(messages)

    const maxTokens = Math.max(1, args.maxTokens ?? 4096)
    const kwargs: Record<string, unknown> = {
      model: AnthropicProvider.stripPrefix(args.model || this.defaultModel),
      max_tokens: maxTokens,
      messages,
      temperature: args.temperature ?? 0.7,
    }
    const cache = this.supportsPromptCaching()
    if (system) {
      kwargs.system = cache ? [{ type: 'text', text: system, cache_control: EPHEMERAL }] : system
    }
    const tools = LLMProvider.openaiToolsToAnthropic(args.tools)
    if (tools && tools.length) {
      if (cache) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: EPHEMERAL }
      kwargs.tools = tools
      kwargs.tool_choice = { type: 'auto' }
    }
    if (reasoningEffort && reasoningEffort !== 'none') {
      const budget = { low: 1024, medium: 4096, high: 8192 }[reasoningEffort] ?? 4096
      kwargs.thinking = { type: 'enabled', budget_tokens: budget }
      kwargs.temperature = 1.0
      kwargs.max_tokens = Math.max(maxTokens, budget + 1024)
    }
    return kwargs
  }

  static stripPrefix(model: string): string {
    for (const prefix of ['anthropic/', 'deepseekAnthropic/']) {
      if (model.startsWith(prefix)) return model.slice(prefix.length)
    }
    return model
  }

  /** 对齐 `_convert_messages`：拆出 system 字符串 + Anthropic 消息列表。 */
  convertMessages(messages: OpenAiMessage[]): [string, Array<Record<string, any>>] {
    const systemParts: string[] = []
    const converted: Array<Record<string, any>> = []
    for (const msg of messages) {
      const role = msg.role
      const content = msg.content
      if (role === 'system') {
        systemParts.push(String(content ?? ''))
        continue
      }
      if (role === 'tool') {
        appendToolResult(converted, msg)
        continue
      }
      if (role === 'assistant') {
        const assistantMsg: Record<string, any> = { role: 'assistant', content: assistantBlocks(msg) }
        if ('reasoning_content' in msg) assistantMsg.reasoning_content = String(msg.reasoning_content ?? '')
        converted.push(assistantMsg)
        continue
      }
      if (role === 'user') {
        converted.push({ role: 'user', content: contentToAnthropic(content) || '(empty)' })
      }
    }
    return [systemParts.filter((p) => p).join('\n\n'), mergeRoles(converted)]
  }

  needsReasoningBackfill(reasoningEffort: string | null): boolean {
    if (!reasoningEffort || ['none', 'minimal', 'minimum'].includes(reasoningEffort.toLowerCase())) return false
    const base = (this.apiBase ?? '').toLowerCase()
    return Boolean(base && !base.includes('anthropic.com'))
  }

  static parseResponse(response: any): LLMResponse {
    const parts: string[] = []
    const tools: ToolCallRequest[] = []
    const reasoningParts: string[] = []
    const thinkingBlocks: Array<Record<string, unknown>> = []
    for (const block of response.content ?? []) {
      if (block.type === 'text') parts.push(block.text)
      else if (block.type === 'tool_use') {
        tools.push({ id: block.id, name: block.name, arguments: block.input && typeof block.input === 'object' ? block.input : {} })
      } else if (block.type === 'thinking') {
        const thinking = String(block.thinking ?? '')
        reasoningParts.push(thinking)
        const tb: Record<string, unknown> = { type: 'thinking', thinking }
        if (block.signature) tb.signature = block.signature
        thinkingBlocks.push(tb)
      } else if (block.type === 'redacted_thinking') {
        thinkingBlocks.push({ ...block })
      }
    }
    const usage: Record<string, number> = {}
    if (response.usage) {
      usage.input = response.usage.input_tokens ?? 0
      usage.output = response.usage.output_tokens ?? 0
      usage.cache_read = response.usage.cache_read_input_tokens ?? 0
      usage.cache_create = response.usage.cache_creation_input_tokens ?? 0
      if (usage.cache_read || usage.cache_create) {
        logger.debug('[prompt-cache]', { read: usage.cache_read, create: usage.cache_create, input: usage.input })
      }
    }
    return {
      content: parts.join('') || null,
      toolCalls: tools,
      finishReason: tools.length ? 'tool_calls' : response.stop_reason || 'stop',
      usage,
      reasoningContent: reasoningParts.join('') || null,
      thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : null,
    }
  }
}

// ── module-private helpers（对齐 Python 静态方法）──

function requestOptions(signal?: AbortSignal | null): { signal: AbortSignal } | undefined {
  return signal ? { signal } : undefined
}

function contentToAnthropic(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content != null ? String(content) : ''
  const out: Array<Record<string, unknown>> = []
  for (const block of content as any[]) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') out.push({ type: 'text', text: String(block.text ?? '') })
    else if (block.type === 'image_url') {
      const url = block.image_url?.url ?? ''
      if (typeof url === 'string' && url.startsWith('data:')) {
        const comma = url.indexOf(',')
        if (comma < 0) continue
        const meta = url.slice(0, comma)
        const data = url.slice(comma + 1)
        const mediaType = meta.split(';')[0]?.split(':')[1]
        if (!mediaType) continue
        out.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })
      }
    }
  }
  return out
}

function appendToolResult(converted: Array<Record<string, any>>, msg: OpenAiMessage): void {
  const block = { type: 'tool_result', tool_use_id: msg.tool_call_id ?? '', content: String(msg.content ?? '') }
  const last = converted[converted.length - 1]
  if (last && last.role === 'user') {
    if (Array.isArray(last.content)) last.content.push(block)
    else last.content = [{ type: 'text', text: String(last.content) }, block]
  } else {
    converted.push({ role: 'user', content: [block] })
  }
}

function assistantBlocks(msg: OpenAiMessage): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  for (const block of (msg.thinking_blocks as any[]) ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'thinking') {
      const item: Record<string, unknown> = { type: 'thinking', thinking: block.thinking ?? '' }
      if (block.signature) item.signature = block.signature
      blocks.push(item)
    } else if (block.type === 'redacted_thinking') {
      blocks.push({ ...block })
    }
  }
  if (msg.content) blocks.push({ type: 'text', text: String(msg.content) })
  for (const tc of (msg.tool_calls as any[]) ?? []) {
    const fn = tc.function ?? {}
    blocks.push({ type: 'tool_use', id: tc.id || newToolId(), name: fn.name ?? '', input: parseJsonArgs(fn.arguments) })
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }]
}

function mergeRoles(messages: Array<Record<string, any>>): Array<Record<string, any>> {
  const merged: Array<Record<string, any>> = []
  for (const msg of messages) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      let prev = last.content
      const curr = msg.content
      if (!Array.isArray(prev)) prev = [{ type: 'text', text: String(prev) }]
      if (Array.isArray(curr)) prev.push(...curr)
      else prev.push({ type: 'text', text: String(curr) })
      last.content = prev
    } else {
      merged.push(msg)
    }
  }
  while (merged.length && merged[merged.length - 1]!.role === 'assistant') merged.pop()
  if (!merged.length) merged.push({ role: 'user', content: '(conversation continued)' })
  if (merged[0]!.role === 'assistant') merged.unshift({ role: 'user', content: '(conversation continued)' })
  return merged
}

function backfillReasoning(messages: Array<Record<string, any>>): void {
  for (const msg of messages) {
    if (msg.role === 'assistant' && !('reasoning_content' in msg)) msg.reasoning_content = ''
  }
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
function newToolId(): string {
  let s = 'toolu_'
  for (let i = 0; i < 22; i++) s += ALNUM[Math.floor(Math.random() * ALNUM.length)]
  return s
}
