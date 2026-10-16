import type { SandboxMode, SandboxExecutionPolicy } from '../sandbox/policy'
import type { ObjectJsonSchema } from '../tools/json-schema'
export type ExecutorBackend = 'internal' | 'claude-code' | 'codex'
export type ExternalBackend = Exclude<ExecutorBackend, 'internal'>
export type RunPhase =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting_input'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'outcome_unknown'
export const TERMINAL_RUN_PHASES: ReadonlySet<RunPhase> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'outcome_unknown',
])
export interface ExecutorCapabilities {
  persistentSession: boolean
  queuedFollowup: boolean
  steer: boolean
  interrupt: boolean
  questions: boolean
  structuredOutput: boolean
  processBoundary: 'os' | 'none'
  usage: 'tokens-and-estimate' | 'tokens' | 'unavailable'
}
export interface ExecutorProfile {
  id: string
  backend: ExternalBackend
  enabled: boolean
  executablePath: string
  expectedVersion: string
  defaultModel?: string
  authRef:
    { kind: 'model-route'; routeId: string } | { kind: 'managed-cli-login' }
  stateDirectoryId: string
  concurrencyLimit: number
}
export interface ExecutorLimits {
  globalConcurrency: number
  maxQueuedMessages: number
  maxRunsPerTask: number
  maxDepth: number
  runTimeoutMs: number
  questionTimeoutMs: number
  estimatedBudgetUsd: number
}
export interface ExecutorConfig {
  schemaVersion: 1
  revision: number
  profiles: ExecutorProfile[]
  limits: ExecutorLimits
}
export interface ExecutorProbe {
  status:
    | 'available'
    | 'missing'
    | 'needs_auth'
    | 'incompatible'
    | 'containment_unavailable'
  executableVersion?: string
  sdkVersion?: string
  capabilities: ExecutorCapabilities
  checkedAt: number
  authVerified: boolean
  diagnostic?: string
}
export interface DelegationOwner {
  rootSessionId: string
  parentAgentId: string
  taskScopeId: string
  goalRef?: { id: string; revision: number }
  requiredForGoal: boolean
  parentCallId?: string
  depth: number
  source: 'human' | 'model' | 'workflow' | 'scheduler'
}
export interface DelegationStart {
  backend: ExternalBackend
  profileId?: string
  description: string
  prompt: string
  context: 'isolated' | 'brief'
  workspace: 'isolated-worktree' | 'shared-readonly' | 'shared-exclusive'
  base: 'committed' | 'snapshot'
  model?: string
  outputSchema?: ObjectJsonSchema
  runInBackground: boolean
  clientRequestId: string
}
export interface DelegationRecord {
  dispatchPaused?: boolean
  clientRequestId?: string
  requestDigest?: string
  startSpec?: DelegationStart
  schemaVersion: 1
  id: string
  owner: DelegationOwner
  backend: ExternalBackend
  profileId: string
  cwd: string
  workspaceLeaseId: string
  effectivePermission: SandboxMode
  capabilitySnapshot: ExecutorCapabilities
  providerSessionId?: string
  currentRunId?: string
  availability: 'idle' | 'active' | 'needs_recovery' | 'closed'
  createdAt: number
}
export interface DelegationRunRecord {
  recoveryResolved?: boolean
  recoveryInspection?: {
    id: string
    sessionId: string
    inspectedAt: number
    nativeStatus: string
  }
  quotaReserved?: boolean
  process?: {
    pid: number | null
    startedAt: number
    fingerprint: string
    boundaryReceiptId: string
    policyDigest: string
  }
  quiescent?: boolean
  structured?: unknown
  id: string
  delegationId: string
  revision: number
  generation: number
  messageId: string
  providerTurnId?: string
  phase: RunPhase
  startedAt?: number
  finishedAt?: number
  acceptance: 'unverified' | 'passed' | 'failed' | 'needs_user'
  integrationPreviewId?: string
  acceptanceId?: string
  receiptId?: string
  failureCode?: string
  summary?: string
  usage?: { inputTokens?: number; outputTokens?: number; estimatedUsd?: number }
}
export interface ExecutorOpenInput {
  onProcessStarted?: (
    identity: import('./process-types').OwnedProcessIdentity,
  ) => Promise<void>
  onProcessObserved?: (
    descendants: import('./process-types').OwnedDescendant[],
  ) => void
  onProcessExit?: (
    receipt: import('./process-types').ProcessExitReceipt,
  ) => void
  outputSchema?: ObjectJsonSchema
  usageBaseline?: { estimatedUsd?: number }
  policy: SandboxExecutionPolicy
  runtimeRoot: string
  secretValues?: readonly string[]
  delegationId: string
  profile: ExecutorProfile
  cwd: string
  environment: Record<string, string>
  boundaryReceiptId: string
  resumeSessionId?: string
  generation: number
  signal: AbortSignal
}
export interface ExecutorTurnInput {
  runId: string
  messageId: string
  text: string
  outputSchema?: ObjectJsonSchema
}
export interface ExecutorSteerInput {
  providerTurnId: string
  messageId: string
  text: string
}
export type ExecutorInteractionAnswer =
  | {
      requestId: string
      generation: number
      kind: 'question'
      answers: Record<string, string>
    }
  | { requestId: string; generation: number; kind: 'deny'; reason: string }
export interface ExecutorQuestion {
  id: string
  title: string
  options?: string[]
}
export type ExecutorEventPayload =
  | { type: 'session_bound'; sessionId: string }
  | { type: 'turn_started'; turnId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_started'; id: string; name: string; detail?: string }
  | { type: 'tool_finished'; id: string; status: string; detail?: string }
  | { type: 'question'; requestId: string; questions: ExecutorQuestion[] }
  | { type: 'permission_denied'; requestId?: string; reason: string }
  | {
      type: 'usage'
      inputTokens?: number
      outputTokens?: number
      estimatedUsd?: number
    }
  | {
      type: 'turn_finished'
      status: 'completed' | 'failed' | 'interrupted'
      text?: string
      structured?: unknown
      error?: string
    }
  | { type: 'transport_error'; code: string; message: string }
export type NormalizedExecutorEvent = ExecutorEventPayload & {
  delegationId: string
  runId: string
  generation: number
  sourceEventId?: string
}
export interface NativeSessionInspection {
  sessionId: string
  nativeStatus: string
  turns: { id?: string; status?: string; text: string }[]
}
export interface ExecutorSession {
  inspect?(): Promise<NativeSessionInspection>
  readonly providerSessionId: string
  readonly events: AsyncIterable<NormalizedExecutorEvent>
  submit(input: ExecutorTurnInput): Promise<{ providerTurnId: string }>
  steer(input: ExecutorSteerInput): Promise<void>
  answer(input: ExecutorInteractionAnswer): Promise<void>
  interrupt(providerTurnId: string): Promise<void>
  close(): Promise<{ quiescent: boolean }>
}
export interface ExecutorAdapter {
  inspect?(input: ExecutorOpenInput): Promise<NativeSessionInspection>
  readonly backend: ExternalBackend
  open(input: ExecutorOpenInput): Promise<ExecutorSession>
}
export class DelegationError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'DelegationError'
  }
}
