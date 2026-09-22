/**
 * Provider-neutral LLM vocabulary shared by the agent loop, the session log,
 * compaction, and every adapter. Adapters alone translate provider wire
 * formats; everything above them speaks only these types.
 *
 * Ported from deepseek-harness `dsh-llm` (types.ts), without the plugin
 * registry: branded ids are plain strings here.
 */

/** Provider/model identity and adapter-private replay data for an assistant message. */
export interface AssistantProvenance {
  /** Route key that produced the message. */
  provider: string
  /** Wire model id that produced the message. */
  model: string
  /** Lossless-JSON adapter state needed to replay the provider response. */
  replayState?: unknown
}

/** Required source of an assistant message produced by a routed model. */
export interface ModelMessageSource extends AssistantProvenance {
  kind: 'model'
}

/** Required source of a user-role message carrying one tool result. */
export interface ToolMessageSource {
  kind: 'tool'
  callId: string
}

/**
 * The kind of information in producer-supplied context. The vocabulary is
 * semantic, never visual: consumers decide how each form looks.
 */
export type ContextForm =
  /** Instructions read out of workspace files the model is expected to follow. */
  | 'instructions'
  /** A catalog of items available in this session, republished as it changes. */
  | 'catalog'
  /** Current state; a later snapshot from the same producer supersedes an earlier one. */
  | 'snapshot'
  /** A one-off account of something that just happened. */
  | 'notice'
  /** A message another agent addressed to this one. */
  | 'relay'
  /** Material lifted out of another session's log. */
  | 'recall'

/** Harness-produced context (runtime snapshots, AGENTS.md, skill catalog, notices). */
export interface ContextMessageSource {
  kind: 'context'
  /** Producing subsystem, e.g. `agent-instructions`, `runtime-context`. */
  producer: string
  form?: ContextForm
  /** One-line account for `notice` context. */
  summary?: string
}

/** Where a message came from. */
export type MessageSource =
  | { kind: 'user' }
  | ContextMessageSource
  | ModelMessageSource
  | ToolMessageSource

/** One immutable message representation shared by delivery, durable history, and model requests. */
export interface Message {
  /** Stable identity preserved across every representation boundary. */
  readonly id: string
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source: MessageSource
}

export interface UserMessage extends Message {
  readonly role: 'user'
}

export interface AssistantMessage extends Message {
  readonly role: 'assistant'
  readonly source: ModelMessageSource
}

export interface ToolResultMessage extends Message {
  readonly role: 'user'
  readonly content: [ToolResultBlock]
  readonly source: ToolMessageSource
}

/** Serializable provider or transport failure facts; policy decides whether they are retryable. */
export interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string
  /** Stable provider-neutral machine-routing code. */
  readonly code: string
  /** HTTP status returned by the provider, when available. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: string
}

/** Plain text visible to the end user. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** Durable reference to one stored image attachment; bytes are resolved at request time. */
export interface ImageAttachmentRef {
  /** Attachment store id. */
  attachmentId: string
  /** Image media type, e.g. `image/png`. */
  mediaType: string
  /** Stored byte length. */
  bytes: number
}

/** A durable raster image reference (user content only in practice). */
export interface ImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef
}

/** A tool invocation requested by the model. */
export interface ToolCallBlock {
  type: 'tool-call'
  /** Provider-issued call id; correlates with the matching tool result. */
  id: string
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

/** The result of a tool invocation, sent back to the model. */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: ContentBlock[]
  isError?: boolean
}

/** Every content block the harness understands. */
export type ContentBlock =
  TextBlock | ReasoningBlock | ImageBlock | ToolCallBlock | ToolResultBlock

/** The block `type` tag vocabulary. */
export type ContentBlockType = ContentBlock['type']

/** Why a model response stopped. */
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

/**
 * Token accounting for one model call. Counts are DISJOINT: `inputTokens` is
 * uncached input only; cached input is reported separately (billed input =
 * sum of the three). Adapters whose providers fold cache hits into a total
 * prompt count subtract them out.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Accepted request modalities. */
export type ModelModality = 'text' | 'image'

/** Display metadata for one adapter-owned reasoning effort. */
export interface LlmReasoningEffortInfo {
  id: string
  name: string
  description?: string
}

/** Selectable reasoning efforts for one exact model route. */
export interface LlmModelReasoningInfo {
  efforts: readonly LlmReasoningEffortInfo[]
  /** Default materialized into requests when callers omit an effort. */
  defaultEffort?: string
}

/** Exact-route model metadata resolved by its owning adapter. */
export interface LlmResolvedModelInfo {
  /** Route key (model entry id). */
  provider: string
  /** Wire model id. */
  id: string
  name: string
  inputModalities?: readonly ModelModality[]
  /** Maximum combined request and response context in tokens. */
  context?: { contextWindow: number }
  /** Per-request output cap materialized when callers omit one. */
  defaultMaxTokens?: number
  reasoning?: LlmModelReasoningInfo
}

/**
 * Adapter-private lossless-JSON state for replaying a successful response,
 * carried by a terminal `finish` chunk and stored on the assembled assistant
 * message's model source.
 */
export interface ReplayEnvelope {
  /** Response-level adapter-private metadata. */
  response: unknown
  /** Per-block adapter-private metadata aligned with emitted blocks, if any. */
  blocks?: readonly unknown[]
}

/**
 * Raw streaming protocol emitted by adapters. Block indexes correlate
 * interleaved deltas, and `block-end` carries the assembled block. Adapters
 * emit usage before the terminal finish and nothing afterward; tool
 * arguments remain raw JSON strings.
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | {
      type: 'tool-call-delta'
      index: number
      id: string
      name?: string
      argumentsDelta: string
    }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }

/** JSON-schema description of a tool, as sent to the model. */
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}

/** Purpose of an auxiliary (non-conversation) model call. */
export type LlmCallPurpose =
  'compaction' | 'session-title' | 'memory' | 'auxiliary'

/** A single model request, fully assembled. */
export interface GenerateOptions {
  /** Route key selecting the adapter (the model entry id). */
  provider: string
  /** Wire model id. */
  model: string
  reasoningEffort?: string
  /** Ordered conversation messages, exactly as the provider sees them. */
  messages: Message[]
  /** System prompt text. */
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  /** Session identity for adapters that route or cache by it. */
  sessionId?: string
  /** Classification for an auxiliary model call; conversation requests leave it unset. */
  purpose?: LlmCallPurpose
}
