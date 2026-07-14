import { jsonrepair } from 'jsonrepair'
import {
  resolveModelProfile,
  type ResolvedModelProfile,
} from '../model/profile'

/**
 * Provider 基类 + 类型 + 工具/消息转换 (MIG-PROV-001)。
 * 对齐 Python `agent/providers/base.py`。chat/chatStream 在 TS 下原生 async（无需 run_sync）。
 */

/** SDK 自带指数退避 + 尊重 Retry-After。LLM 调用无副作用，重试幂等安全。 */
export const DEFAULT_MAX_RETRIES = 2

export interface ToolCallRequest {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface OpenAiMessage {
  role: string
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: string
  name?: string
  reasoning_content?: unknown
  [k: string]: unknown
}

export interface LLMResponse {
  content: string | null
  toolCalls: ToolCallRequest[]
  finishReason: string
  usage: Record<string, number>
  reasoningContent: string | null
  thinkingBlocks: Array<Record<string, unknown>> | null
}

export type ContentDelta = (text: string) => void | Promise<void>

export interface ToolCallDelta {
  index: number
  id: string
  name: string
  argumentsText: string
}

export type ToolCallDeltaHandler = (
  delta: ToolCallDelta,
) => void | Promise<void>

export interface GenerationSettings {
  maxTokens: number
  temperature: number
  reasoningEffort: string | null
}

export function defaultGenerationSettings(): GenerationSettings {
  return { maxTokens: 20_000, temperature: 0.1, reasoningEffort: null }
}

export const TRUNCATED_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'model_max_tokens',
])

export function isTruncated(finishReason: string | null | undefined): boolean {
  return TRUNCATED_FINISH_REASONS.has((finishReason ?? '').toLowerCase())
}

export function shouldExecuteTools(resp: LLMResponse): boolean {
  return (
    resp.toolCalls.length > 0 &&
    ['tool_calls', 'stop'].includes(resp.finishReason)
  )
}

export function toOpenAiToolCall(
  req: ToolCallRequest,
): Record<string, unknown> {
  return {
    id: req.id,
    type: 'function',
    function: { name: req.name, arguments: JSON.stringify(req.arguments) },
  }
}

export interface ChatArgs {
  messages: OpenAiMessage[]
  tools?: Array<Record<string, unknown>> | null
  model?: string | null
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string | null
  signal?: AbortSignal | null
}

export type ToolCallCompleteHandler = (
  call: ToolCallRequest,
) => void | Promise<void>

export interface ChatStreamArgs extends ChatArgs {
  onContentDelta?: ContentDelta
  onToolCallDelta?: ToolCallDeltaHandler
  /** Wave5：某个 tool_use 块参数流式拼完时回调一次；批式结果仍以最终响应为准。 */
  onToolCallComplete?: ToolCallCompleteHandler
}

export interface LLMProviderConfig {
  apiKey?: string | null
  apiBase?: string | null
  defaultModel: string
  extraHeaders?: Record<string, string> | null
  extraBody?: Record<string, unknown> | null
  profile?: ResolvedModelProfile
}

export abstract class LLMProvider {
  readonly apiKey: string | null
  readonly apiBase: string | null
  readonly defaultModel: string
  readonly extraHeaders: Record<string, string>
  readonly extraBody: Record<string, unknown>
  readonly profile: ResolvedModelProfile
  generation: GenerationSettings

  constructor(cfg: LLMProviderConfig) {
    this.apiKey = cfg.apiKey ?? null
    this.apiBase = cfg.apiBase ?? null
    this.defaultModel = cfg.defaultModel
    this.extraHeaders = cfg.extraHeaders ?? {}
    this.extraBody = cfg.extraBody ?? {}
    this.profile =
      cfg.profile ??
      resolveModelProfile({
        provider: 'custom',
        protocol: 'openai',
        modelId: 'unknown-model',
      })
    this.generation = {
      ...defaultGenerationSettings(),
      maxTokens: this.profile.maxTokens,
    }
  }

  abstract chat(args: ChatArgs): Promise<LLMResponse>

  async chatStream(args: ChatStreamArgs): Promise<LLMResponse> {
    const resp = await this.chat(args)
    if (resp.content && args.onContentDelta)
      await args.onContentDelta(resp.content)
    return resp
  }

  /** anthropic 风格 tools → openai 风格。对齐 `anthropic_tools_to_openai`。 */
  static anthropicToolsToOpenai(
    tools?: Array<Record<string, any>> | null,
  ): Array<Record<string, unknown>> | null {
    if (!tools || tools.length === 0) return null
    return tools.map((tool) => {
      if (tool.type === 'function') return tool
      return {
        type: 'function',
        function: {
          name: tool.name ?? '',
          description: tool.description ?? '',
          parameters: tool.input_schema ?? { type: 'object', properties: {} },
        },
      }
    })
  }

  /** openai 风格 tools → anthropic 风格。对齐 `openai_tools_to_anthropic`。 */
  static openaiToolsToAnthropic(
    tools?: Array<Record<string, any>> | null,
  ): Array<Record<string, unknown>> | null {
    if (!tools || tools.length === 0) return null
    return tools.map((tool) => {
      const fn = (tool.function ?? tool) as Record<string, any>
      return {
        name: fn.name ?? '',
        description: fn.description ?? '',
        input_schema: fn.parameters ??
          fn.input_schema ?? { type: 'object', properties: {} },
      }
    })
  }
}

/**
 * 在 provider 边界执行视觉能力门控。文本块（包括附件解析文本）始终保留。
 */
export function messagesForProfile(
  messages: OpenAiMessage[],
  profile: ResolvedModelProfile,
): OpenAiMessage[] {
  if (profile.vision) return messages
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    return {
      ...message,
      content: message.content.filter(
        (block) =>
          !(
            block &&
            typeof block === 'object' &&
            ['image_url', 'image'].includes(
              String((block as Record<string, unknown>).type ?? ''),
            )
          ),
      ),
    }
  })
}

/** 解析工具调用的 JSON 参数；坏 JSON 走 jsonrepair，最终失败返回 {}。对齐 `parse_json_args`。 */
export function parseJsonArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {}
  } catch {
    try {
      const parsed = JSON.parse(jsonrepair(value))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {}
    } catch {
      return {}
    }
  }
}
