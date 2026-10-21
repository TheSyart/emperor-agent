import type { SandboxMode, SandboxExecutionPolicy } from '../sandbox/policy'
import type { ObjectJsonSchema } from '../tools/json-schema'
import type {
  TurnFileEntry,
  TurnRevertSkip,
} from '../../workspace/turn-snapshots'
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
  /**
   * Claude Code only: `bundled` (default) runs the binary shipped with
   * Emperor's Agent SDK; `system` runs `executablePath`. Codex always runs
   * `executablePath`.
   */
  executableSource?: 'bundled' | 'system'
  executablePath: string
  customModels?: string[]
  defaultModel?: string
  specialties?: string[]
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
  /**
   * Tokens one task may spend on API-billed runs whose price is unknown
   * (AGT-07); absent: {@link DEFAULT_UNPRICED_TOKENS_PER_TASK}.
   */
  maxUnpricedTokensPerTask?: number
  /**
   * Claude Code's turns per run (SDK `maxTurns`), 50–1000; absent:
   * {@link DEFAULT_CLAUDE_MAX_TURNS}. Settings › 子智能体 › 高级 (AGT-02).
   */
  claudeMaxTurns?: number
}
export const DEFAULT_CLAUDE_MAX_TURNS = 200
/** The token cap for unpriced API runs when the config sets none. */
export const DEFAULT_UNPRICED_TOKENS_PER_TASK = 2_000_000
/**
 * How an executor's spend is paid (AGT-07): a subscription (Claude or
 * ChatGPT login) has nominal cost only and is bounded by turns and time;
 * an API key spends money and is bounded by the task's USD or token cap.
 */
export type ExecutorBilling = 'subscription' | 'api'
/** A run's usage as recorded and as the budget counts it. */
export interface ExecutorRunUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  /** Real API spend; never set for a subscription. */
  estimatedUsd?: number
  /** A subscription's reported cost: shown, never counted. */
  nominalUsd?: number
  billing?: ExecutorBilling
}
export interface ExecutorConfig {
  schemaVersion: 1
  revision: number
  profiles: ExecutorProfile[]
  limits: ExecutorLimits
  /** When the user last saved these settings (absent: never saved). */
  touchedAt?: number
  /**
   * Shown once on the settings page: an upgrade turned off external
   * executors the user had never chosen (AGT-05).
   */
  upgradeNotice?: 'external-default-off'
  /**
   * Settings › 子智能体 › 高级 › 诊断模式 (AGT-04): mark external runs with a
   * Seatbelt boundary and let the native scanner stop processes that left a
   * run's process group when it ends. Off by default.
   */
  diagnosticsMode?: boolean
  /**
   * Settings › 子智能体 › 高级 › 验证后再应用 (AGT-06): results go through
   * the receipt, an independent check and an integration preview before
   * they reach the project; 应用到项目 on the result card is refused.
   */
  verifyBeforeApply?: boolean
  /**
   * What a task's environment passes through (AGT-08): git identity and
   * proxies by default; SSH agent, toolchains and GitHub sign-in on request.
   * Absent: the defaults.
   */
  developmentEnvironment?: {
    gitIdentity: boolean
    proxy: boolean
    sshAgent: boolean
    toolchains: boolean
    github: boolean
  }
  /**
   * The model entry local subagents use (设置 › 子智能体 › 本地子智能体,
   * AGT-10); absent follows the conversation's model.
   */
  localSubagentModel?: string
  /**
   * Where a writing external task works when the model does not say
   * (设置 › 子智能体 › 改代码的位置, AGT-10); absent is an isolated worktree.
   */
  defaultWorkspace?: 'isolated-worktree' | 'shared-exclusive'
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
  /** Claude Code: which binary was checked. */
  executableSource?: 'bundled' | 'system'
  /** The range a refused or old CLI needs, e.g. `>= 2.1` or `0.153.x`. */
  requiredVersion?: string
  /**
   * Codex: `verified` when the CLI's protocol digest is a known one;
   * `unverified` when only the minor matches (runnable, may be incompatible).
   */
  compatibility?: 'verified' | 'unverified'
  /** Codex: the verified release whose protocol the CLI was compared with. */
  protocolVersion?: string
  capabilities: ExecutorCapabilities
  checkedAt: number
  authVerified: boolean
  localAuthChecked?: boolean
  /** Claude Code: the sign-in the check found, or why there is none (AGT-02). */
  auth?: ExecutorAuthState
  diagnostic?: string
}
/**
 * Where Claude Code's credential comes from (AGT-02), in the order the
 * sources are read: a token pasted into Emperor, ~/.claude/settings.json
 * `env`, `.credentials.json`, the environment Emperor started with, the
 * login shell. Never the macOS Keychain.
 */
export interface ExecutorAuthState {
  source:
    | 'emperor'
    | 'settings'
    | 'credentials-file'
    | 'environment'
    | 'login-shell'
    | 'model-route'
    | null
  kind?: 'oauth-token' | 'api-key' | 'auth-token'
  /** Emperor's own token: its last four characters, for 已设置 · 末 4 位. */
  last4?: string
  /** Set when there is no usable credential. */
  problem?: 'missing' | 'expired' | 'unreadable'
  /** `.credentials.json`'s expiry (epoch ms). */
  expiresAt?: number
  /** It expires within ten minutes: still used, with a warning. */
  expiresSoon?: boolean
}
export type NativeCapabilityStatus =
  | 'unverified'
  | 'verifying'
  | 'available'
  | 'unavailable'
  | 'unsupported'
  | 'stale'
export interface NativeCapabilityEvidence {
  status: NativeCapabilityStatus
  checkedAt?: number
  runId?: string
  delegationId?: string
  model?: string | null
  backend?: ExternalBackend
  executorVersion?: string
  adapterVersion?: string
  toolPolicy?: string
  permissionMode?: string
  /** Non-reversible digest prefix; never a token, email or raw account ID. */
  authIdentity?: string
  reason?: string
  references?: string[]
  searchMode?: 'live' | 'cached' | 'unknown'
}
export interface ExecutorRuntimeFacts {
  configuredModel: string | null
  reportedModel: string | null
  modelSource: string | null
  provider: string | null
  hostAllowedTools: string[]
  advertisedTools: string[] | null
  observedTools: string[]
  searchMode: 'live' | 'cached' | 'unknown'
  observedAt?: number
  nativeCapabilities: {
    search: NativeCapabilityEvidence
    imageGeneration: NativeCapabilityEvidence
  }
}
export interface NativeToolEvidence {
  /** False when the native protocol provides activity but no affirmative result. */
  verified?: boolean
  kind: 'search' | 'image-generation'
  action: 'search' | 'fetch' | 'generate'
  success: boolean
  references?: string[]
  artifactPath?: string
  searchMode?: 'live' | 'cached' | 'unknown'
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
  /** CLI version the preflight saw when the delegation was created. */
  executorVersion?: string
  providerSessionId?: string
  currentRunId?: string
  availability: 'idle' | 'active' | 'needs_recovery' | 'closed'
  createdAt: number
}
/**
 * What a write run left in its isolated workspace (AGT-06): its base and
 * result commits, the files and lines it changed, and what became of it.
 * `ready` waits for 应用到项目 / 丢弃; `conflicted` was not applied (the
 * listed files changed in the project too); `applied` can be undone
 * (`undo` holds the before/after records) and then reads `reverted`.
 */
export interface DelegationResult {
  base: string
  commit: string
  files: TurnFileEntry[]
  totals: { files: number; additions: number; deletions: number }
  truncated?: true
  state: 'ready' | 'conflicted' | 'applied' | 'reverted' | 'discarded'
  conflicts?: string[]
  /** When the run's result was recorded. */
  at: number
  /** When it last changed state. */
  changedAt?: number
  by?: 'user' | 'model'
  undo?: { before: string; after: string }
  reverted?: { reverted: string[]; skipped: TurnRevertSkip[] }
}
export interface DelegationRunRecord {
  /** The run's file changes, waiting to be applied or discarded (AGT-06). */
  result?: DelegationResult
  goalFailureDisposition?: { source: 'human'; reason: string; at: number }
  /**
   * "标记为已结束" (AGT-04): the user, or the model with the user's
   * approval, ended a run that had no outcome; it no longer blocks anything.
   */
  abandoned?: { by: 'user' | 'model'; at: number }
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
    /** System boot marker at spawn (AGT-04). */
    bootTime?: string
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
  usage?: ExecutorRunUsage
}
export interface ExecutorOpenInput {
  onProcessStarted?: (
    identity: import('./process-types').OwnedProcessIdentity,
  ) => Promise<void>
  onProcessExit?: (
    receipt: import('./process-types').ProcessExitReceipt,
  ) => void
  outputSchema?: ObjectJsonSchema
  usageBaseline?: { estimatedUsd?: number }
  /** What an API-billed run may still spend (Claude's maxBudgetUsd). */
  budgetUsd?: number
  /** Claude Code's turns per run (AGT-02). */
  maxTurns?: number
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
  /**
   * Codex ChatGPT login: the isolated auth.json links to the user's file.
   * The adapter holds the login lock for the process lifetime (AGT-03).
   */
  codexAuth?: CodexAuthLink
}
/** The isolated CODEX_HOME's auth.json is a symlink to the user's own file. */
export interface CodexAuthLink {
  /** The user's own auth.json (their CODEX_HOME or ~/.codex). */
  source: string
  /** `auth.json` of an isolated CODEX_HOME: a symlink to `source`. */
  isolated: string
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
  | {
      type: 'runtime_metadata'
      source: string
      model?: string
      provider?: string
      advertisedTools?: string[]
      searchMode?: 'live' | 'cached' | 'unknown'
    }
  | { type: 'session_bound'; sessionId: string }
  | { type: 'turn_started'; turnId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_started'; id: string; name: string; detail?: string }
  | {
      type: 'tool_finished'
      id: string
      status: string
      detail?: string
      evidence?: NativeToolEvidence
    }
  | { type: 'question'; requestId: string; questions: ExecutorQuestion[] }
  | { type: 'permission_denied'; requestId?: string; reason: string }
  | {
      type: 'usage'
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      reasoningTokens?: number
      totalTokens?: number
      estimatedUsd?: number
    }
  | {
      type: 'turn_finished'
      status: 'completed' | 'failed' | 'interrupted'
      text?: string
      structured?: unknown
      error?: string
      /** Why a failed turn failed (AGT-02); absent: EXECUTOR_TURN_FAILED. */
      failureCode?: string
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
  /** IPC carries fixed domain guidance, never native stdout or credentials. */
  toSafe(): { code: string; message: string; action: string } {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(this.code)
      ? this.code
      : 'EXTERNAL_OPERATION_FAILED'
    const guidance: Record<string, [string, string]> = {
      INTEGRATION_CONFLICT: [
        '工作区或 Git 索引已改变，请重新生成整合预览。',
        'regenerate_integration_preview',
      ],
      STALE_REVISION: [
        '任务状态已经变化，请刷新后重试。',
        'refresh_delegation',
      ],
      ACCEPTANCE_REQUIRED: [
        '成果或预览还没有通过当前的验证，请重新验证。',
        'validate_current_artifacts',
      ],
      REQUIRED_DELEGATION_UNVERIFIED: [
        '目标还有必需的子任务没有通过验证。',
        'validate_current_artifacts',
      ],
      PERMISSION_DENIED: [
        '当前会话没有执行此操作的权限。',
        'review_task_permission',
      ],
      PERMISSION_REVOKED: [
        '父任务权限已收窄，请检查任务详情。',
        'review_task_permission',
      ],
      PLAN_MODE_UNSUPPORTED: [
        '计划模式下子智能体只能做只读审查；需要修改文件时请先确认计划。',
        'review_task_permission',
      ],
      OUTCOME_UNKNOWN: [
        '还不能确认子智能体已经停止，请检查保留的成果与原生历史。',
        'inspect_retained_results',
      ],
      DELIVERY_UNKNOWN: [
        '消息送达状态未知，请先查看原生历史，避免重复发送。',
        'inspect_retained_results',
      ],
      AUTH_REQUIRED: [
        '子智能体没有可用的登录，请在「设置 › 子智能体」设置令牌。',
        'configure_executor',
      ],
      AUTH_EXPIRED: [
        '子智能体的登录令牌已过期，请在「设置 › 子智能体」重新设置令牌。',
        'configure_executor',
      ],
      EXECUTOR_MISSING: [
        '找不到 Claude Code / Codex 的命令行程序，请检查安装与可执行文件路径。',
        'configure_executor',
      ],
      EXECUTOR_DISABLED: [
        '请先在「设置 › 子智能体」里启用它。',
        'configure_executor',
      ],
      EXECUTOR_INCOMPATIBLE: [
        'CLI 版本不在支持范围内，请按设置 › 子智能体中显示的版本安装，或改用 Emperor 内置的 Claude Code。',
        'configure_executor',
      ],
      CONTAINMENT_UNAVAILABLE: [
        '操作系统的执行边界不可用，请在「设置 › 子智能体」查看诊断。',
        'configure_executor',
      ],
    }
    const [message, action] = guidance[code] ?? [
      '子智能体的操作没有成功，请刷新任务详情并检查保留的日志。',
      'inspect_retained_results',
    ]
    return { code, message, action }
  }
}

/** No usable credential; `auth` says what the check found (AGT-02). */
export class ExecutorAuthError extends DelegationError {
  constructor(
    readonly auth: ExecutorAuthState,
    detail: string,
  ) {
    super(auth.problem === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED', detail)
  }
}
export interface ExecutorModelCandidate {
  id: string
  name: string
  source: 'cli' | 'configuration' | 'cache' | 'builtin' | 'custom'
}
export interface ExecutorModelCatalog {
  profileId: string
  models: ExecutorModelCandidate[]
  configuredModel: string | null
  provider: string | null
  checkedAt: number | null
  diagnostic: string | null
}
