// Trajectory target contract (ported from the dsh ui-trajectory
// trajectory-contract, adapted to Emperor's raw session-log vocabulary).
//
// The trajectory Definitions (`definitions/*`) share the conversation
// assembler with chat and materialize independent contributions for the
// 'trajectory' target; `TrajectorySnapshotBuilder` folds them into one
// stage-oriented `TrajectorySnapshot`, which `deriveTrajectoryLayout`
// turns into the Turn → group → record ledger.
//
// Unlike chat nodes, trajectory nodes keep full tool-call arguments on the
// assistant blocks and every model-visible input (user, steering, context).
import type {
  ContentBlock,
  EpochHeader,
  ImageAttachmentRef,
  RequestContext,
  SessionEventMap,
  SubagentMode,
  SubagentStopReason,
  TokenUsage,
  ToolSchema,
} from '@emperor/core/runtime-contract'
import type {
  ConversationPromptSnapshot,
  RequestPromptChange,
  AssistantRequestView as InspectedAssistantRequest,
  CompactionRequestView as InspectedCompactionRequest,
} from '../../conversation/requestInspection'
import type { ConversationViewNode } from '../../conversation/assembler'

export type { ConversationPromptSnapshot, RequestPromptChange }

/**
 * Compact placement of one event: the Turn (and Step) it belongs to, the
 * session level, or unresolved (outside the loaded boundaries).
 */
export type TrajectoryLocation =
  | { readonly kind: 'session' }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'turn'; readonly turn: number }
  | { readonly kind: 'step'; readonly turn: number; readonly step: number }

/** Assistant content, with tool-call arguments retained for inspection. */
export type TrajectoryAssistantBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'image'; readonly attachment: ImageAttachmentRef }
  | {
      readonly kind: 'tool-call'
      readonly callId: string
      readonly name: string
      readonly argsRaw: string
    }
  | { readonly kind: 'other'; readonly block: unknown }

/** Recorded timing of one settled (or interrupted) assistant step. */
export interface TrajectoryAssistantTiming {
  readonly stepStartTime: number | null
  readonly firstTokenTime: number | null
  readonly completedTime: number
}

/** Model provenance of one assistant message. */
export interface TrajectoryProvenance {
  readonly provider: string
  readonly model: string
}

/** Request configuration shown by the request inspector. */
export type TrajectoryRequestConfig = EpochHeader['config'] & {
  readonly purpose?: 'compaction'
}

/** One finalized (or interrupted) assistant message of one step. */
export interface TrajectoryAssistantNode {
  readonly kind: 'assistant'
  readonly seq: number
  readonly time: number
  readonly turn: number
  readonly step: number
  readonly blocks: readonly TrajectoryAssistantBlock[]
  readonly messageId?: string
  readonly usage?: TokenUsage
  readonly provenance?: TrajectoryProvenance
  readonly timing?: TrajectoryAssistantTiming
  readonly interrupted?: true
  readonly requestConfig?: TrajectoryRequestConfig
}

type HostUserMeta = SessionEventMap['host/user-meta']

/** A user-authored message opening (or queued into) a turn. */
export interface TrajectoryUserNode {
  readonly kind: 'user'
  readonly seq: number
  readonly time: number
  readonly messageId: string
  /** Model-visible content. */
  readonly content: readonly ContentBlock[]
  readonly source: unknown
  /** host/user-meta display text (what the user saw), when recorded. */
  readonly displayText?: string
  /** host/user-meta facts (attachments, delivery source...). */
  readonly meta?: HostUserMeta
}

/** A user message admitted from the next-step inbox into a running turn. */
export interface TrajectorySteeringNode extends Omit<
  TrajectoryUserNode,
  'kind'
> {
  readonly kind: 'steering'
}

/**
 * Model-visible or run-shaping context:
 * - `message`: a context-source user/message (runtime snapshot, memory,
 *   relay, goal round...);
 * - `event`: a durable harness fact (goal, hook, approval, plan/sandbox mode,
 *   inbox splice, instruction/memory baseline) rendered as a context record.
 */
export interface TrajectoryContextNode {
  readonly kind: 'context'
  readonly origin: 'message' | 'event'
  readonly seq: number
  readonly time: number
  readonly content: readonly ContentBlock[]
  readonly source: unknown
  /** Short record label (`Hook · PreToolUse`); events only. */
  readonly label?: string
  /** Raw event type; events only. */
  readonly eventType?: string
  /** Own duration (hook runtime), when recorded. */
  readonly durationMs?: number
  readonly isError?: boolean
}

/** Delegated child session attached to a tool call (subagent/started|settled). */
export interface TrajectorySubagentFact {
  /** Child session id. */
  readonly childSessionId: string
  readonly description: string
  readonly mode: SubagentMode
  readonly background: boolean
  readonly status: 'running' | 'settled'
  readonly stopReason?: SubagentStopReason
  readonly text?: string
}

/** Background job started by a tool call (job/started|finished). */
export interface TrajectoryJobFact {
  readonly jobId: string
  readonly kind?: string
  readonly status: 'running' | 'completed' | 'killed' | 'failed'
  readonly exitCode?: number
  readonly detail?: string
}

/** Workflow / ralph run started by a tool call (tool-workflow/*). */
export interface TrajectoryWorkflowFact {
  readonly runId: string
  readonly name: string
  readonly tool?: 'workflow' | 'ralph'
  readonly status: 'running' | 'completed' | 'cancelled' | 'error'
  readonly phases: readonly string[]
  readonly logs: readonly string[]
  readonly error?: string
  readonly result?: string
}

/** Emperor enrichment carried by tool call blocks. */
export interface TrajectoryToolFacts {
  readonly subagent?: TrajectorySubagentFact
  readonly job?: TrajectoryJobFact
  readonly workflow?: TrajectoryWorkflowFact
  /** Child session of a subagent call or workflow member. */
  readonly childSessionId?: string
}

/** A tool call without a result yet. */
export interface TrajectoryRunningCall extends TrajectoryToolFacts {
  readonly callId: string
  readonly name: string
  readonly argsRaw: string
  readonly argsTruncated?: boolean
  /** Session-event seq of the `tool/call` (full payload lookup). */
  readonly callSeq?: number
  readonly turn: number
  readonly step: number
  readonly time: number
  readonly subCalls: readonly TrajectoryToolCallBlock[]
}

/** A settled tool call (result landed, or synthesized as interrupted). */
export interface TrajectoryToolResultNode extends TrajectoryToolFacts {
  readonly kind: 'tool-result'
  readonly seq: number
  readonly time: number
  readonly callId: string
  readonly call: { readonly name: string; readonly argsRaw: string } | null
  readonly callTime: number | null
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
  readonly error?: { readonly name: string; readonly code: string }
  readonly meta?: unknown
  /** The wire truncated this result's text. */
  readonly truncated?: boolean
  /** The wire truncated the arguments of the call this result settles. */
  readonly argsTruncated?: boolean
  /** Session-event seq of the settled call's `tool/call`. */
  readonly callSeq?: number
  readonly subCalls: readonly TrajectoryToolCallBlock[]
}

/** Running or settled tool call (root or nested). */
export type TrajectoryToolCallBlock =
  TrajectoryRunningCall | TrajectoryToolResultNode

/** Finalized ledger node. */
export type TrajectoryEventNode =
  | TrajectoryUserNode
  | TrajectorySteeringNode
  | TrajectoryContextNode
  | TrajectoryAssistantNode
  | TrajectoryToolResultNode

/** In-flight assistant output of the open step. */
export interface TrajectoryPartialAssistant {
  readonly turn: number
  readonly step: number
  readonly blocks: readonly TrajectoryAssistantBlock[]
}

/** Emperor per-step notice attached to a request. */
export type TrajectoryRequestNotice =
  | {
      readonly kind: 'fallback'
      readonly seq: number
      readonly time: number
      readonly from: string
      readonly to: string
      readonly trigger: SessionEventMap['llm/fallback']['trigger']
      readonly message: string
      readonly code: string
    }
  | {
      readonly kind: 'cost-cap'
      readonly seq: number
      readonly time: number
      readonly capUsdNanos: number
      readonly spentUsdNanos: number
      readonly unpricedRoutes: readonly string[]
    }

/** One ordinary assistant generation (one agent step). */
export interface TrajectoryAssistantRequest extends InspectedAssistantRequest {
  readonly requestConfig?: TrajectoryRequestConfig
  readonly notices?: readonly TrajectoryRequestNotice[]
}

/** One compaction provider request. */
export interface TrajectoryCompactionRequest extends InspectedCompactionRequest {
  readonly requestConfig?: TrajectoryRequestConfig
}

export type TrajectoryRequestView =
  TrajectoryAssistantRequest | TrajectoryCompactionRequest

/** Request-header facts retained by the Trajectory target. */
export interface TrajectoryRequestHeaderState {
  readonly seq: number
  readonly time: number
  readonly prompt: ConversationPromptSnapshot
  readonly change?: RequestPromptChange
  readonly location: TrajectoryLocation
}

/** One independently assembled contribution to the Trajectory ledger. */
export type TrajectoryContribution =
  | { readonly kind: 'node'; readonly node: TrajectoryEventNode }
  | {
      readonly kind: 'assistant'
      readonly node?: TrajectoryAssistantNode
      readonly partial: TrajectoryPartialAssistant | null
      readonly request?: TrajectoryAssistantRequest
    }
  | { readonly kind: 'tool'; readonly root: TrajectoryToolCallBlock }
  | {
      readonly kind: 'request-header'
      readonly header: TrajectoryRequestHeaderState
    }
  | {
      readonly kind: 'request-context'
      readonly seq: number
      readonly context: RequestContext
      readonly location: TrajectoryLocation
    }
  | {
      readonly kind: 'compaction'
      readonly request: TrajectoryCompactionRequest
    }
  | {
      readonly kind: 'session-end'
      readonly seq: number
      readonly time: number
    }
  | {
      readonly kind: 'turn-end'
      readonly turn: number
      readonly time: number
      readonly error?: string
    }

/** Target envelope consumed by the Trajectory snapshot builder. */
export interface TrajectoryConversationViewNode extends ConversationViewNode {
  readonly target: 'trajectory'
  readonly location: TrajectoryLocation
  readonly data: TrajectoryContribution
}

/** Stage-oriented Trajectory data assembled from the trajectory Definitions. */
export interface TrajectorySnapshot {
  readonly eventNodes: readonly TrajectoryEventNode[]
  readonly eventLocations: ReadonlyMap<number, TrajectoryLocation>
  readonly requests: readonly TrajectoryRequestView[]
  /** Call-time model-visible schema per tool callId. */
  readonly callSchemas: ReadonlyMap<string, ToolSchema>
  readonly partial: TrajectoryPartialAssistant | null
  readonly runningCalls: readonly TrajectoryRunningCall[]
}
