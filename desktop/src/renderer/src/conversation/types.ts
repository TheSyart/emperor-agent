// Chat target contract: the node union the M4 conversation UI renders.
//
// Every node is produced by one Definition in `nodes/*` from raw session-log
// events. Nodes are immutable: a changed node is a new object, an unchanged
// node keeps its identity across flushes (see `ConversationAssembler`). The
// renderer keys rows by `key` and dispatches on `kind`.
import type {
  ContentBlock,
  ImageAttachmentRef,
  SessionEventMap,
  SubagentMode,
  SubagentStopReason,
  TodoItem,
  TokenUsage,
} from '@emperor/core/runtime-contract'
import type { ConversationTimeline } from './locationIndex'

export type { TodoItem, TokenUsage }

/** Assistant content classified for rendering. */
export type AssistantBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'image'; readonly attachment: ImageAttachmentRef }
  /**
   * A tool call requested inside the message. Arguments are intentionally
   * absent in chat: the call renders as its own `tool` node.
   */
  | {
      readonly kind: 'tool-call'
      readonly callId: string
      readonly name: string
    }
  | { readonly kind: 'other'; readonly block: unknown }

/** Timing recorded for one assistant step. */
export interface AssistantTiming {
  /** step/start time, or null when outside the window. */
  readonly stepStartTime: number | null
  /** First non-empty text/reasoning/tool delta, or null when none streamed. */
  readonly firstTokenTime: number | null
  /** assistant/message time (or the closing boundary when interrupted). */
  readonly completedTime: number
}

/** `user`: one user-authored message (host/user-meta merged in). */
export interface UserChatData {
  readonly messageId: string
  readonly seq: number
  readonly time: number
  /** Model-visible content blocks. */
  readonly content: readonly ContentBlock[]
  /** Text to display: host `displayContent`, else the joined text blocks. */
  readonly text: string
  /** Host attachment descriptors (id, name, mime, size, kind). */
  readonly attachments: readonly Record<string, unknown>[]
  /** Host delivery source (e.g. `scheduler`), when not a plain prompt. */
  readonly source?: string
  readonly scheduler?: Record<string, unknown>
  readonly clientMessageId?: string
  /** Admitted from the next-step inbox into a running turn. */
  readonly steering: boolean
}

/** `assistant`: one model step (per turn:step), streaming or settled. */
export interface AssistantChatData {
  /**
   * running: chunks still arriving; settled: assistant/message landed;
   * interrupted: the step/turn closed first (abort, crash repair) or the
   * message is flagged interrupted.
   */
  readonly status: 'running' | 'settled' | 'interrupted'
  readonly turn: number
  readonly step: number
  readonly blocks: readonly AssistantBlock[]
  /** First visible content (running) or message time (settled). */
  readonly time: number
  readonly messageId?: string
  readonly usage?: TokenUsage
  readonly provenance?: { readonly provider: string; readonly model: string }
  readonly timing?: AssistantTiming
}

/** Settled tool result. */
export interface ToolResultView {
  readonly seq: number
  readonly time: number
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
  readonly error?: { readonly name: string; readonly code: string }
  readonly meta?: SessionEventMap['tool/result']['meta']
  /** The wire truncated this result's text (full event via Raw later). */
  readonly truncated?: boolean
}

/** Background job attached to the tool call that started it. */
export interface ToolJobView {
  readonly jobId: string
  readonly status: 'running' | 'completed' | 'killed' | 'failed'
  readonly exitCode?: number
  readonly detail?: string
}

/** Delegated child session attached to a subagent tool call. */
export interface ToolSubagentView {
  readonly subagentId: string
  readonly description: string
  readonly mode: SubagentMode
  readonly background: boolean
  readonly status: 'running' | 'settled'
  readonly stopReason?: SubagentStopReason
  /** Final text the child returned. */
  readonly text?: string
}

/** One approval request raised by a tool call (sandbox escalation...). */
export interface ToolApprovalView {
  readonly id: string
  readonly toolName: string
  readonly reason?: string
  readonly outcome?: SessionEventMap['approval/decided']['outcome']
}

/** ask_user_question interaction attached to its call. */
export interface ToolQuestionView {
  readonly id: string
  readonly questions: SessionEventMap['question/asked']['questions']
  readonly intent?: SessionEventMap['question/asked']['intent']
  readonly answers?: Extract<
    SessionEventMap['question/answered'],
    { answers: unknown }
  >['answers']
  readonly outcome?: 'answered' | 'cancelled' | 'unavailable'
}

/** One published workflow member (a child session). */
export interface WorkflowMemberView {
  readonly seq: number
  readonly label: string
  readonly childId: string
  readonly outcome?: SessionEventMap['tool-workflow/agent-end']['outcome']
}

/** One workflow phase with the members started while it was current. */
export interface WorkflowPhaseView {
  /** Phase title; empty for members started before any phase. */
  readonly title: string
  readonly members: readonly WorkflowMemberView[]
}

/** Workflow / ralph run: run → phases → members. */
export interface WorkflowRunView {
  readonly runId: string
  readonly name: string
  readonly description?: string
  readonly tool?: 'workflow' | 'ralph'
  readonly callId?: string
  readonly status: 'running' | 'completed' | 'cancelled' | 'error'
  readonly phases: readonly WorkflowPhaseView[]
  /** Latest narration lines (bounded). */
  readonly logs: readonly string[]
  readonly agentsStarted?: number
  readonly error?: string
  readonly result?: string
}

/** `tool`: one tool call and everything attached to it. */
export interface ToolChatData {
  readonly callId: string
  readonly name: string
  /** Raw JSON arguments (may be truncated on the wire). */
  readonly argsRaw: string
  readonly argsTruncated?: boolean
  readonly turn: number
  readonly step: number
  /** tool/call time, or the result time when the call is outside the window. */
  readonly time: number
  /**
   * running: no result yet; settled: result landed; interrupted: the step
   * or turn closed without a result.
   */
  readonly status: 'running' | 'settled' | 'interrupted'
  readonly result?: ToolResultView
  readonly job?: ToolJobView
  readonly subagent?: ToolSubagentView
  readonly workflow?: WorkflowRunView
  readonly approvals: readonly ToolApprovalView[]
  readonly question?: ToolQuestionView
}

/** One scheduled model-request retry. */
export interface RetryAttemptView {
  readonly retryId: string
  readonly seq: number
  /** llm/retry time; the countdown ends at time + delayMs. */
  readonly time: number
  readonly retry: number
  readonly maxRetries?: number
  readonly delayMs: number
  readonly provider: string
  readonly message: string
  readonly code: string
  /** scheduled → started, or cancelled when the step closed first. */
  readonly state: 'scheduled' | 'started' | 'cancelled'
}

/** `retry`: the retry chain of one step on one provider. */
export interface RetryChatData {
  readonly turn: number
  readonly step: number
  readonly attempts: readonly RetryAttemptView[]
  readonly current: RetryAttemptView
}

/** `fallback`: the rest of the turn moved to the fallback route. */
export interface FallbackChatData {
  readonly turn: number
  readonly step: number
  readonly from: string
  readonly to: string
  readonly trigger: SessionEventMap['llm/fallback']['trigger']
  readonly message: string
  readonly code: string
  readonly time: number
}

/** `turnError`: a turn that ended with an error reason. */
export interface TurnErrorChatData {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly message: string
  readonly code: string
  readonly status?: number
}

/** `turnMaxTokens`: a turn ended by the output-token cap. */
export interface TurnMaxTokensChatData {
  readonly turn: number
  readonly seq: number
  readonly time: number
}

/** `costCap`: the per-turn cost cap stopped the turn. */
export interface CostCapChatData {
  readonly turn: number
  readonly step: number
  readonly time: number
  readonly capUsdNanos: number
  readonly spentUsdNanos: number
  readonly unpricedRoutes: readonly string[]
}

/** `compaction`: one compaction run (automatic or manual). */
export interface CompactionChatData {
  readonly compactionId: string
  /** Owning turn, or null for manual compaction between turns. */
  readonly turn: number | null
  readonly status: 'running' | 'done' | 'error'
  readonly time: number
  readonly summary: string | null
  readonly shadowedItemCount: number | null
  readonly shadowedTokenCount: number | null
  readonly error?: string
  readonly sourceCommandId?: string
}

/**
 * `context`: harness-injected, model-visible context. UI renders these
 * collapsed by default.
 * - message: a context-source user/message (runtime snapshot, memory,
 *   relay, goal round, ...).
 * - instructions: an instructions baseline naming the loaded files.
 */
export type ContextChatData =
  | {
      readonly origin: 'message'
      readonly seq: number
      readonly time: number
      readonly messageId: string
      /** Producing subsystem (`runtime-context`, `memory`, `subagent`...). */
      readonly producer: string
      readonly form?: string
      /** One-line account for `notice` context. */
      readonly summary?: string
      readonly text: string
      readonly content: readonly ContentBlock[]
    }
  | {
      readonly origin: 'instructions'
      readonly seq: number
      readonly time: number
      readonly files: readonly string[]
    }

/** `hook`: one hook command invocation (collapsed row). */
export interface HookChatData {
  readonly turn: number
  readonly point: string
  readonly dialect: SessionEventMap['hook/invoked']['dialect']
  readonly matcher?: string
  readonly handlerId: string
  readonly status: 'running' | 'done'
  readonly time: number
  readonly decision?: string
  readonly exitCode?: number
  readonly stderrSummary?: string
  readonly durationMs?: number
}

/** Token usage summed over a turn's steps. */
export interface TurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
}

/** `turnTail`: footer of a completed turn. */
export interface TurnTailChatData {
  readonly turn: number
  readonly seq: number
  readonly startedAt: number | null
  readonly endedAt: number
  /** turn/start → turn/end, when the start is in the window. */
  readonly durationMs?: number
  /** First step's step/start → first token. */
  readonly ttftMs?: number
  /** Output tokens / decode wall time over steps with both readings. */
  readonly tokensPerSecond?: number
  readonly usage: TurnUsage
  readonly steps: number
  /** Text of the last text-bearing assistant message (copy action). */
  readonly closingText: string | null
}

/** `goal`: one goal mutation, rendered inline. */
export interface GoalChatData {
  readonly seq: number
  readonly time: number
  readonly operation: SessionEventMap['goal/change']['operation']
  readonly goalId: string
  readonly revision: number
  /** Absent for a clear. */
  readonly objective?: string
  readonly phase?: 'active' | 'paused' | 'blocked' | 'complete'
  readonly blockedReason?: { readonly code: string; readonly message: string }
  readonly roundsStarted?: number
  readonly maxGoalRounds?: number
}

/** Common node envelope. */
interface ChatNodeBase<Kind extends string, Data> {
  /** Stable engine key (unique per session). */
  readonly key: string
  readonly kind: Kind
  /** Definition-local identity (callId, turn:step, seq...). */
  readonly id: string
  readonly target: 'chat'
  /** Sort position; fractional values place synthetic nodes. */
  readonly anchorSeq: number
  readonly visibility: 'visible' | 'hidden'
  /** Owning turn (null at the session level). */
  readonly turn: number | null
  /** Owning step (null outside a step). */
  readonly step: number | null
  readonly data: Data
}

export type UserChatNode = ChatNodeBase<'user', UserChatData>
export type AssistantChatNode = ChatNodeBase<'assistant', AssistantChatData>
export type ToolChatNode = ChatNodeBase<'tool', ToolChatData>
export type RetryChatNode = ChatNodeBase<'retry', RetryChatData>
export type FallbackChatNode = ChatNodeBase<'fallback', FallbackChatData>
export type TurnErrorChatNode = ChatNodeBase<'turnError', TurnErrorChatData>
export type TurnMaxTokensChatNode = ChatNodeBase<
  'turnMaxTokens',
  TurnMaxTokensChatData
>
export type CostCapChatNode = ChatNodeBase<'costCap', CostCapChatData>
export type CompactionChatNode = ChatNodeBase<'compaction', CompactionChatData>
export type ContextChatNode = ChatNodeBase<'context', ContextChatData>
export type HookChatNode = ChatNodeBase<'hook', HookChatData>
export type TurnTailChatNode = ChatNodeBase<'turnTail', TurnTailChatData>
export type GoalChatNode = ChatNodeBase<'goal', GoalChatData>
export type WorkflowRunChatNode = ChatNodeBase<'workflowRun', WorkflowRunView>

/** Every chat row the conversation UI renders. */
export type ChatNode =
  | UserChatNode
  | AssistantChatNode
  | ToolChatNode
  | RetryChatNode
  | FallbackChatNode
  | TurnErrorChatNode
  | TurnMaxTokensChatNode
  | CostCapChatNode
  | CompactionChatNode
  | ContextChatNode
  | HookChatNode
  | TurnTailChatNode
  | GoalChatNode
  | WorkflowRunChatNode

export type ChatNodeKind = ChatNode['kind']

/** Chat node narrowed to one kind. */
export type ChatNodeOf<Kind extends ChatNodeKind> = Extract<
  ChatNode,
  { kind: Kind }
>

/** Context-window occupancy from the latest request. */
export interface ContextUsage {
  /** Tokens of the latest completed request (input + cache + output). */
  readonly usedTokens: number
  /** Window of the route that served it, when known. */
  readonly contextWindow: number | null
  /** usedTokens / contextWindow in [0, 1], when the window is known. */
  readonly ratio: number | null
  readonly provider: string | null
  readonly model: string | null
}

/**
 * One published chat state. `order` and scalar fields are immutable per
 * snapshot; `nodes` is a stable live reader (an old snapshot observes later
 * flushes through it), matching the dsh ChatSnapshot contract.
 */
export interface ChatSnapshot {
  /** Visible node keys in render order. */
  readonly order: readonly string[]
  /** Every materialized node (visible and hidden) by key. */
  readonly nodes: ReadonlyMap<string, ChatNode>
  /** A turn is open (no turn/end yet). */
  readonly running: boolean
  /** Open turn and its start time, for the status line. */
  readonly turnStatus: {
    readonly turn: number
    readonly startedAt: number
  } | null
  /** Latest todo/write list. */
  readonly todos: readonly TodoItem[]
  readonly contextUsage: ContextUsage | null
  /** Reference-stable Turn/Step timeline of the window. */
  readonly timeline: ConversationTimeline
}
