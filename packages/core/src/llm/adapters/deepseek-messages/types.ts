/**
 * Wire format of DeepSeek's Anthropic-compatible Messages endpoint. Types
 * only. Fields are limited to what DeepSeek documents as supported
 * (https://api-docs.deepseek.com/guides/anthropic_api) in the shape of the
 * Anthropic Messages API; nothing here is DeepSeek-specific beyond that
 * subset.
 */

/** Request body for `POST {base}/v1/messages`. */
export interface MessagesRequest {
  model: string
  max_tokens: number
  messages: WireMessage[]
  system?: string
  tools?: WireTool[]
  /** DeepSeek honours the type; `budget_tokens` is ignored, so it is not sent. */
  thinking?: { type: 'enabled' | 'disabled' }
  /** Only `effort` is supported (low / high / max). */
  output_config?: { effort: WireEffort }
  temperature?: number
  stop_sequences?: string[]
  stream: true
  /** Legacy `extraBody` keys an entry carried for its provider. */
  [extra: string]: unknown
}

export type WireEffort = 'low' | 'high' | 'max'

export interface WireMessage {
  role: 'user' | 'assistant'
  content: WireContentBlock[]
}

export interface WireTextBlock {
  type: 'text'
  text: string
}

/** A thinking block replayed in history; the signature is sent exactly as received. */
export interface WireThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface WireToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface WireToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: Array<WireTextBlock | WireImageBlock>
  /** DeepSeek ignores it; sent for fidelity. */
  is_error?: boolean
}

export type WireImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'file'; file_id: string }

export interface WireImageBlock {
  type: 'image'
  source: WireImageSource
}

export type WireContentBlock =
  | WireTextBlock
  | WireThinkingBlock
  | WireToolUseBlock
  | WireToolResultBlock
  | WireImageBlock

export interface WireTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** Anthropic usage counts; `input_tokens` excludes cache reads and writes. */
export interface WireUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** One block as `content_block_start` opens it. */
export type WireStartBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string; signature?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | { type: string; [key: string]: unknown }

export type WireDelta =
  | { type: 'text_delta'; text?: string }
  | { type: 'thinking_delta'; thinking?: string }
  | { type: 'signature_delta'; signature?: string }
  | { type: 'input_json_delta'; partial_json?: string }
  | { type: string; [key: string]: unknown }

/** The parsed `data` of one stream event, discriminated on `type`. */
export type WireEvent =
  | {
      type: 'message_start'
      message?: {
        id?: string
        model?: string
        usage?: WireUsage
      }
    }
  | {
      type: 'content_block_start'
      index: number
      content_block: WireStartBlock
    }
  | { type: 'content_block_delta'; index: number; delta: WireDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      delta?: { stop_reason?: string | null; stop_sequence?: string | null }
      usage?: WireUsage
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error?: WireErrorBody }

export interface WireErrorBody {
  type?: string
  message?: string
  code?: string
}

/** A non-2xx body: the Anthropic envelope or the OpenAI-compatible one. */
export interface WireErrorResponse {
  type?: string
  error?: WireErrorBody
}
