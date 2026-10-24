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
   * The installed CLI: a bare name (`claude`, `codex`) found on PATH, the
   * login shell's PATH and the usual install folders, or an absolute path.
   * Emperor ships no Claude Code of its own (AGT-12).
   */
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
  /** The range a refused or old CLI needs, e.g. `>= 2.1.79` or `0.153.x`. */
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
  /** Claude Code: what `claude auth status` said, or why it could not (AGT-12). */
  auth?: ExecutorAuthState
  diagnostic?: string
}
/**
 * How Claude Code signs in (AGT-12). `method` and the account are what
 * `claude auth status` reports in the run's own environment; `source` is
 * the credential Emperor hands claude besides its own sign-in, which then
 * outranks it: an API key saved in Emperor, or an API key / gateway token
 * from ~/.claude/settings.json `env`, the environment Emperor started
 * with or the login shell. Never a Claude.ai token, never the Keychain.
 */
export interface ExecutorAuthState {
  source:
    | 'emperor'
    | 'settings'
    | 'environment'
    | 'login-shell'
    | 'model-route'
    | null
  kind?: 'api-key' | 'auth-token'
  /** Emperor's own API key: its last four characters, for 末 4 位. */
  last4?: string
  /** A non-Anthropic endpoint in effect (the ANTHROPIC_BASE_URL host). */
  endpoint?: string
  /**
   * `claude auth status` authMethod: `claude.ai` (its own sign-in),
   * `api_key`, `oauth_token` (a bearer token, e.g. a gateway's
   * ANTHROPIC_AUTH_TOKEN), `api_key_helper`, `third_party` (Bedrock,
   * Vertex, Foundry), `none`, or `other` for a value this build does not know.
   */
  method?:
    | 'claude.ai'
    | 'oauth_token'
    | 'api_key'
    | 'api_key_helper'
    | 'third_party'
    | 'none'
    | 'other'
  /** The account claude says it signed in with. */
  email?: string
  organization?: string
  subscription?: string
  /**
   * `missing`: no sign-in; `unreadable`: Emperor's API key no longer opens
   * (the local key changed); `status-failed`: `claude auth status` did not
   * answer.
   */
  problem?: 'missing' | 'unreadable' | 'status-failed'
}
/**
 * 登录 Claude Code (FIX-11): the installed claude's own `claude auth login`,
 * which Core starts and the user finishes in the browser. One at a time.
 * It carries nothing claude printed: the link and the code prompt stay
 * between claude, the browser and the user.
 */
export interface ClaudeSignInView {
  profileId: string
  method: 'claude-ai' | 'console'
  state: 'running' | 'signed-in' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
  /**
   * Why a sign-in failed: `exit` (claude ended unsuccessfully), `timeout`
   * (ten minutes went by), `start` (claude could not be started),
   * `not-signed-in` (claude ended, yet `claude auth status` still says no).
   */
  reason?: 'exit' | 'timeout' | 'start' | 'not-signed-in'
  /** claude's exit code, when it ended by itself. */
  exitCode?: number
  /** A failed sign-in: the same login as one line for the user's Terminal. */
  command?: string
}
/** How a CLI was installed, from where it really lives (AGT-13). */
export type ExecutorInstallKind =
  'npm' | 'homebrew' | 'claude-native' | 'desktop' | 'unknown'
/** 设置 › 子智能体 › 版本 for one profile (AGT-13). */
export interface ExecutorVersionView {
  profileId: string
  backend: ExternalBackend
  /** The user turned it on: only then is an upgrade offered. */
  enabled: boolean
  /** What the last probe found; null: not installed or not checked. */
  installed: string | null
  install: { kind: ExecutorInstallKind; location: string | null }
  /** npm's `latest`; null: not checked yet, or the check failed. */
  latest: string | null
  /** Codex: the major.minor lines Emperor verified (`0.153`). */
  verified: string[]
  /** What 升级 installs; null: nothing newer to install. */
  target: string | null
  /** Codex: a newer release Emperor has not verified (尚未验证). */
  unverified: string | null
  /**
   * How the upgrade runs: one click, or a command for the user's own
   * Terminal (`manual`: why not — a desktop app, an unknown install, or
   * Homebrew offering another version). Null without a target.
   */
  upgrade: {
    oneClick: boolean
    command: string | null
    manual?: 'desktop' | 'unknown' | 'homebrew'
  } | null
  /**
   * 退回 (VER-03): the last version a task ran on, offered when the
   * installed one failed for its version (or its self-check found it
   * incompatible); `because` says so in one line. How it runs, as for
   * `upgrade`: Homebrew gets the npm command to copy (`manual: 'homebrew'`),
   * a desktop app's copy none. Absent: nothing to go back to.
   */
  rollback?: {
    target: string
    because: string
    oneClick: boolean
    command: string | null
    manual?: 'desktop' | 'unknown' | 'homebrew'
  }
  /** Its subtasks running now; an upgrade waits for them. */
  activeRuns: number
}
/** 升级 (or 退回) while it runs and once it ended (AGT-13). */
export interface ExecutorUpgradeView {
  profileId: string
  backend: ExternalBackend
  /** `rollback`: 退回 to the last good version (VER-03); absent: 升级. */
  kind?: 'rollback'
  from: string | null
  target: string
  /** The command as the confirmation showed it. */
  command: string
  state: 'waiting' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  /** waiting: its subtasks still running. */
  waitingFor?: number
  /** waiting: behind another executor's upgrade. */
  queued?: boolean
  startedAt: number
  finishedAt?: number
  /** The command and its output, cleaned (查看过程). */
  log: string[]
  /**
   * Why it failed: `permission` (no write access; `path`), `network`,
   * `exit` (another non-zero exit), `start`, `timeout`, `not-upgraded`
   * (it ended, but the probe still finds the old version).
   */
  reason?:
    'permission' | 'network' | 'exit' | 'start' | 'timeout' | 'not-upgraded'
  exitCode?: number
  path?: string
  /** The version the probe found afterwards. */
  installed?: string
  /** failed: the same upgrade for the user's own Terminal. */
  manualCommand?: string
}
export interface ExecutorVersionsView {
  checkedAt: number | null
  checking: boolean
  /** The last check could not reach npm (`offline`) or got no answer. */
  error: 'offline' | 'registry' | null
  executors: ExecutorVersionView[]
  upgrades: ExecutorUpgradeView[]
  /** 稍后 for every version offered now: no notice, no dot. */
  dismissed: boolean
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
  /** The model the run used instead of Codex's own default (FIX-16). */
  modelChoice?: ExecutorModelChoice
  /** What Emperor did for the run that 任务详情 says (VER-02). */
  notices?: DelegationRunNotice[]
}
/**
 * VER-02: a newer Claude Code loaded builtin plugins of its own and Emperor
 * turned them off before the first prompt (sources, `x@builtin`).
 */
export interface DelegationRunNotice {
  kind: 'builtin_plugins_disabled'
  plugins: string[]
  claudeVersion: string
}
/**
 * FIX-16: nobody in Emperor chose a model and Codex's own default
 * (`configured`, from its config.toml) is not offered to this login, so the
 * run used `used` instead — chosen before the turn (`default-unavailable`)
 * or after the provider refused the default (`retried`).
 */
export interface ExecutorModelChoice {
  configured: string
  used: string
  reason: 'default-unavailable' | 'retried'
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
  /** The CLI's version as the run's probe read it (`claude --version`). */
  executableVersion?: string
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
      /** The executor used another model than its own default (FIX-16). */
      modelChoice?: ExecutorModelChoice
      /** Claude Code builtin plugins Emperor turned off in this run (VER-02). */
      builtinPluginsDisabled?: { plugins: string[]; claudeVersion: string }
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
  | {
      type: 'transport_error'
      code: string
      message: string
      /** The run's Chinese reason (DelegationError.reason). */
      reason?: string
    }
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
  /**
   * FIX-16: the provider refused the model nobody in Emperor chose (Codex's
   * own default). Ask the executor again which models this login offers
   * and start the same turn once more on one of them, in the same
   * conversation. Undefined when no other model is known.
   */
  retryOnSupportedModel?(
    input: ExecutorTurnInput,
    refused: string | undefined,
  ): Promise<{ providerTurnId: string; model: string } | undefined>
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
    /**
     * One Chinese line for the run's summary, when Emperor itself refused
     * the run and can say why (VER-02); the parent and 任务详情 show it.
     */
    readonly reason?: string,
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
        'Claude Code 还没有登录，请在「设置 › 子智能体 › Claude Code」点「登录 Claude Code」。',
        'configure_executor',
      ],
      AUTH_EXPIRED: [
        'Claude Code 的登录已失效或过期，请在「设置 › 子智能体 › Claude Code」重新登录。',
        'configure_executor',
      ],
      AUTH_STATUS_FAILED: [
        '读不到 Claude Code 的登录状态，请在「设置 › 子智能体」重新检测。',
        'configure_executor',
      ],
      AUTH_SIGN_OUT_FAILED: [
        'Claude Code 没有退出登录，请稍后重试。',
        'configure_executor',
      ],
      EXECUTOR_MISSING: [
        '找不到 Claude Code / Codex 的命令行程序，请先安装，或在「设置 › 子智能体」更正路径。',
        'configure_executor',
      ],
      EXECUTOR_DISABLED: [
        '请先在「设置 › 子智能体」里启用它。',
        'configure_executor',
      ],
      EXECUTOR_INCOMPATIBLE: [
        'CLI 版本不在支持范围内，请按「设置 › 子智能体」中显示的版本升级后重新检测。',
        'configure_executor',
      ],
      CONTAINMENT_UNAVAILABLE: [
        '操作系统的执行边界不可用，请在「设置 › 子智能体」查看诊断。',
        'configure_executor',
      ],
      EXECUTOR_UPGRADING: [
        '它正在升级，升级完成前不接新的子任务；可以改用本地子智能体。',
        'configure_executor',
      ],
      EXECUTOR_UPGRADE_UNAVAILABLE: [
        '这个版本不能在这里一键升级，请在「设置 › 子智能体」重新检测后再试。',
        'configure_executor',
      ],
      EXECUTOR_ROLLBACK_UNAVAILABLE: [
        '这个版本不能在这里一键退回，请在「设置 › 子智能体」重新检测后再试。',
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

/**
 * Claude Code is not signed in (`AUTH_REQUIRED`) or its status could not be
 * read (`AUTH_STATUS_FAILED`); `auth` says what the check found (AGT-12).
 */
export class ExecutorAuthError extends DelegationError {
  constructor(
    readonly auth: ExecutorAuthState,
    detail: string,
    code: 'AUTH_REQUIRED' | 'AUTH_STATUS_FAILED' = 'AUTH_REQUIRED',
  ) {
    super(code, detail)
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
  /**
   * FIX-16: Codex's own default model (its config.toml) is not in the list
   * this login offers; a run that follows the CLI uses `replacement`.
   */
  defaultUnavailable?: { model: string; replacement: string } | null
}
