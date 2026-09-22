/**
 * Workflow vocabulary (ported from dsh-workflow `types.ts` / `runtime-types.ts`
 * and dsh-workflow-worker-thread `types.ts` / `protocol.ts`): run identity and
 * meta, results, observe-only lifecycle payloads, the start request and live
 * run handle, and the host⇄worker wire protocol. Protocol tags are string
 * literals (no TS enums) because the worker-side code is serialized source.
 */

import type { ContentBlock } from '../../llm/types'
import type { Agent } from '../agent/agent'
import type { ObjectJsonSchema } from '../tools/json-schema'

/** One phase declared in `meta.phases` (progress vocabulary only). */
export interface WorkflowPhase {
  title: string
  detail?: string
  provider?: string
  model?: string
}

/** The script's identity block (plain JSON data, validated before the body runs). */
export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhase[]
}

/** Why a run settled (closed union). */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'

/** The outcome of a live run; `value` is plain JSON data (`null` for no return). */
export interface WorkflowResult {
  value: unknown
  stopReason: WorkflowStopReason
  /** Present iff `stopReason` is not `completed`. */
  error?: string
  /** `agent()` calls the run accepted over its lifetime. */
  agentsStarted: number
}

/** Identity carried by every lifecycle event (borrowed immutable data, never the live run). */
export interface WorkflowRunInfo {
  id: string
  meta: WorkflowMeta
}

/** One `agent()` call's identity within a run. */
export interface WorkflowAgentInfo {
  /** 1-based sequence number of this `agent()` call within the run. */
  seq: number
  label: string
  phase?: string
  /** The child agent's id (a subagent session id). */
  childId: string
}

export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'

export interface WorkflowAgentEndInfo extends WorkflowAgentInfo {
  outcome: WorkflowAgentOutcome
}

/** A settled run's outcome as event data (the result minus `value`). */
export interface WorkflowResultInfo {
  stopReason: WorkflowStopReason
  error?: string
  agentsStarted: number
}

/** Machine-routable fatal workflow failure codes. */
export type WorkflowErrorCode =
  | 'SCRIPT_PARSE'
  | 'META_INVALID'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_OPTION'
  | 'UNSUPPORTED_SCHEMA'
  | 'AGENT_CAP'
  | 'ITEM_CAP'
  | 'AGENT_START'
  | 'AGENT_RESULT'
  | 'RESULT_UNSERIALIZABLE'
  | 'CANCELLED'

/** What a caller asks for when starting a run. */
export interface WorkflowStartRequest {
  /** Plain-JS body (top-level await allowed; ends with `return <json-value>`). */
  script: string
  meta: WorkflowMeta
  args?: unknown
  /** Engine-wide child-provider override for this run (invisible to the script). */
  subagentProvider?: string
  /** Per-run total-child ceiling (may lower, never raise, the engine ceiling). */
  maxTotalAgents?: number
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: Agent
  /** Emperor: the tool call that started the run; children attach to it in the UI. */
  callId?: string
  signal?: AbortSignal
}

/** Holder-owned live run: `result` never rejects; `dispose()` must be called on every path. */
export interface WorkflowRun {
  readonly id: string
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  cancel(reason?: string): void
  dispose(): Promise<void>
}

/** Lifecycle observer (observe-only; every callback is independently contained). */
export interface WorkflowEngineObserver {
  start?(info: WorkflowRunInfo): void
  phase?(info: WorkflowRunInfo, title: string): void
  log?(info: WorkflowRunInfo, message: string): void
  agentStart?(info: WorkflowRunInfo, agent: WorkflowAgentInfo): void
  agentEnd?(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo): void
  end?(info: WorkflowRunInfo, result: WorkflowResultInfo): void
}

// ── worker boundary ─────────────────────────────────────────────────────

/** Per-run limits the worker-side runtime enforces. */
export interface WorkerLimits {
  maxConcurrentAgents: number
  maxTotalAgents: number
  maxItemsPerCall: number
  syncTimeoutMs: number
}

/** The `workerData` payload of one run. */
export interface WorkerInit {
  meta: WorkflowMeta
  body: string
  args?: unknown
  limits: WorkerLimits
}

/** What the worker asks the host to start for one `agent()` call. */
export interface ChildStartRequest {
  prompt: string
  schema?: ObjectJsonSchema
  provider?: string
  model?: string
  /** Emperor: the display label (UI description of the child). */
  label?: string
}

/** JSON projection of a child's result crossing the port. */
export interface ChildResult {
  output: ContentBlock[]
  structured?: unknown
  stopReason: string
}

/** Worker-side handle for one started child. */
export interface ChildHandle {
  readonly id: string
  /** Rejects only for an infrastructure fault (`child-failed`). */
  readonly result: Promise<ChildResult>
  dispose(): Promise<void>
}

/** Worker-side port the runtime starts children through. */
export interface ChildPort {
  startAgent(request: ChildStartRequest): Promise<ChildHandle>
}

/** Worker → host messages. */
export type WorkerToHostMessage =
  | { type: 'ready' }
  | { type: 'phase'; title: string }
  | { type: 'log'; message: string }
  | { type: 'agent-start'; info: WorkflowAgentInfo }
  | { type: 'agent-end'; info: WorkflowAgentEndInfo }
  | { type: 'child-start'; callId: number; request: ChildStartRequest }
  | { type: 'child-dispose'; callId: number }
  | { type: 'result'; result: WorkflowResult }

/** Host → worker messages. */
export type HostToWorkerMessage =
  | { type: 'go' }
  | { type: 'cancel'; reason: string }
  | { type: 'child-started'; callId: number; childId: string }
  | { type: 'child-start-error'; callId: number; rendered: string }
  | { type: 'child-settled'; callId: number; result: ChildResult }
  | { type: 'child-failed'; callId: number; rendered: string }
  | { type: 'child-disposed'; callId: number }

// ── child providers (the subagent seam, reduced) ────────────────────────

/** One published child run (the `SubagentRun` of the dsh seam, reduced). */
export interface ChildRun {
  readonly id: string
  /** Never rejects for an ordinary child failure (non-`completed` stop reason instead). */
  readonly result: Promise<ChildResult>
  dispose(): Promise<void>
}

export interface ChildProviderStartRequest {
  prompt: string
  parent: Agent
  signal: AbortSignal
  outputSchema?: ObjectJsonSchema
  provider?: string
  model?: string
  label?: string
  callId?: string
}

/** A named child provider (`spawn`). */
export interface ChildProvider {
  readonly name: string
  readonly capabilities: { readonly outputSchema: boolean }
  readonly inheritsParentContext: boolean
  start(request: ChildProviderStartRequest): Promise<ChildRun>
}
