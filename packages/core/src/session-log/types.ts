/**
 * Session log vocabulary (ported from dsh-session types.ts).
 *
 * The log is the single durable trajectory of one agent conversation: an
 * append-only list of typed events. Domains extend {@link SessionEventMap}
 * with TS declaration merging in their own modules:
 *
 *   declare module '../session-log/types' {
 *     interface SessionEventMap { 'plan/mode': { active: boolean } }
 *   }
 *
 * Model-visible ⟺ logged: every model request is derived only from the
 * surface events (`user/message`, `assistant/message`, `tool/result`) plus
 * the latest `request/header`.
 */

import type {
  LlmCallConfig,
  LlmCallConfigAdapterDefaults,
} from '../llm/call-config'
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from '../llm/message'
import type {
  LlmFailure,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '../llm/types'
import type { JsonValue } from './json'

export type { JsonValue } from './json'

export const SESSION_FORMAT_VERSION = 0

/** Creation-time facts of one session; frozen for its lifetime. */
export interface SessionHeader {
  readonly version: number
  readonly id: string
  readonly createdAt: number
  /** Absolute workspace directory. */
  readonly cwd?: string
  /** Parent session for forks and subagents. */
  readonly parentSession?: string
  /** Number of events copied from the parent as this session's seed. */
  readonly seedLength?: number
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
}

export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: AgentCancelCause }
  | { kind: 'blocked' }
  | { kind: 'error'; error: LlmFailure }
  | { kind: 'max-tokens' }
  /** Closed by crash repair: the process died inside this turn. */
  | { kind: 'interrupted' }

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** The request-header epoch: everything outside the message list that shapes a request. */
export interface EpochHeader {
  config: LlmCallConfig
  adapterDefaults?: LlmCallConfigAdapterDefaults
  system?: string
  tools?: ToolSchema[]
}

export interface RequestContext {
  provider: string
  model: string
  contextWindow?: number
}

export type RequestHeaderReason = 'initial' | 'resume' | 'change'

/** Core event payloads; domains merge more entries in. */
export interface SessionEventMap {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  'user/message': UserMessage
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  'assistant/message': {
    turn: number
    step: number
    message: AssistantMessage
    usage?: TokenUsage
    interrupted?: true
  }
  'tool/call': {
    turn: number
    step: number
    callId: string
    name: string
    arguments: string
  }
  'tool/result': {
    turn: number
    step: number
    message: ToolResultMessage
    error?: { name: string; code: string }
    meta?: JsonValue
  }
  'todo/write': { todos: TodoItem[] }
  'request/header': { header: EpochHeader; reason: RequestHeaderReason }
  'request/context': RequestContext
  /** Marks where a fork's copied seed ends. */
  'session/end-seed': Record<string, never>
}

export type SessionEventType = keyof SessionEventMap

/** Event types that may carry a surface operation. */
export type SurfaceEventType =
  'user/message' | 'assistant/message' | 'tool/result'

export type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }

export interface SurfaceIntent {
  surfaceOp: SurfaceOp
  /** Earlier events this one was derived from; must cover every node a replace hides. */
  sourceEventSeqs?: number[]
}

export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    seq: number
    time: number
    data: SessionEventMap[K]
    /** Consumers that do not recognize this event may skip it. */
    ignorable?: true
  } & (K extends SurfaceEventType
    ? { sourceEventSeqs?: number[]; surfaceOp?: SurfaceOp }
    : object)
}[T]

export type SurfaceEvent = SessionEvent<SurfaceEventType> & {
  surfaceOp: SurfaceOp
}
