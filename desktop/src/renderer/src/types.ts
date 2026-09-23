import type {
  CompactionDecision as CoreCompactionDecision,
  CoreHookAuditRecordPayload,
  CoreHookMatchItemPayload,
  CoreHooksAuditPayload,
  CoreHooksConfigPayload,
  CoreHooksMatchPayload,
  CoreHooksMetadataPayload,
  CoreHooksTestRunPayload,
  CoreHooksValidationPayload,
  CoreTaskRecord,
  DiscardedItem as CoreDiscardedItem,
  GoalOperationResult as CoreGoalOperationResult,
  MemoryScope as CoreMemoryScope,
  CoreOperationResult,
} from '@emperor/core/api'
import type {
  RuntimeEvent as CoreRuntimeEvent,
  RuntimeGoalView as CoreRuntimeGoalView,
} from '@emperor/core/runtime-contract'

export interface ToolInfo {
  name: string
  description: string
  parameters?: Record<string, unknown>
  read_only?: boolean
  exclusive?: boolean
  concurrency_safe?: boolean
  source?: 'builtin' | 'mcp'
  server?: string
}

export interface McpServerConfig {
  transport?: string
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  url?: string | null
  headers?: Record<string, string>
  enabled?: boolean
  tool_overrides?: Record<string, McpToolOverride>
  [key: string]: unknown
}

export interface McpToolOverride {
  read_only?: boolean
  exclusive?: boolean
  [key: string]: unknown
}

export interface McpDefaultsConfig {
  read_only?: boolean
  exclusive?: boolean
  [key: string]: unknown
}

export interface McpConfigPayload {
  servers: Record<string, McpServerConfig>
  defaults?: McpDefaultsConfig
  [key: string]: unknown
}

export interface McpConnectionStatusPayload {
  serverName: string
  transport?: string
  generation: number
  clientId?: string | null
  state:
    | 'connecting'
    | 'ready'
    | 'degraded'
    | 'backoff'
    | 'auth_failed'
    | 'failed'
    | 'stopped'
    | string
  health?: 'unknown' | 'healthy' | 'unhealthy' | string
  auth?: 'unknown' | 'ok' | 'failed' | string
  toolCount?: number
  tools?: string[]
  restartAttempts?: number
  nextRetryAt?: number | null
  activeRequestCount?: number
  activeRequestIds?: string[]
  lastError?: { code?: string; message?: string } | null
}

export interface McpStatusPayload {
  initialized: boolean
  servers: McpConnectionStatusPayload[]
  ready: number
  configured: number
  tools: number
  toolCapabilities?: Array<{
    name: string
    serverName: string
    toolName: string
    readOnly: boolean
    exclusive: boolean
    evidencePolicy: 'context_only' | string
    readOnlySource: string
    exclusiveSource: string
    generation: number | null
    clientId: string | null
  }>
}

// Hooks: Claude Code `hooks.json` payloads owned by Core `hooks.*`.
export type HooksConfigPayload = CoreHooksConfigPayload
export type HooksValidationPayload = CoreHooksValidationPayload
export type HooksMetadataPayload = CoreHooksMetadataPayload
export type HooksMatchPayload = CoreHooksMatchPayload
export type HookMatchItemPayload = CoreHookMatchItemPayload
export type HooksTestRunPayload = CoreHooksTestRunPayload
export type HooksAuditPayload = CoreHooksAuditPayload
export type HookAuditRecordPayload = CoreHookAuditRecordPayload

export interface SkillInfo {
  name: string
  description?: string
  path: string
  /** Absolute Skill folder (the source folder of a single-file Skill). */
  root?: string
  /** Absolute SKILL.md (or `<name>.md`) path. */
  skillFile?: string
  tags?: string
  always?: boolean
  source?: 'builtin' | 'plugin' | 'verified_plugin' | 'user' | 'project'
  status?: 'active' | 'blocked' | 'blocked_pending_review' | 'invalid'
  /** Builtin and Plugin Skills are read-only (`skills.copyToUser`). */
  readOnly?: boolean
  /** A single `<name>.md` file instead of a Skill folder. */
  flat?: boolean
  warnings?: string[]
  requirements?: {
    bins: string[]
    runtimes: string[]
    env: string[]
  }
}

/** A Skill folder or file the loader rejected, with the reason (`skills.list().invalid`). */
export type InvalidSkillInfo =
  CoreOperationResult<'skills.list'>['invalid'][number]

export type PluginSummary = CoreOperationResult<'plugins.list'>[number]

export interface RequestedSkill {
  name: string
  source: 'slash'
}

export interface TokenStatsRow {
  input?: number
  output?: number
  cache_read?: number
  cache_create?: number
  total?: number
  calls?: number
  provider?: string
  model?: string
  cost_usd_nanos?: number
  cost_complete_calls?: number
  cost_incomplete_calls?: number
  cost_is_partial?: boolean
  [key: string]: number | string | boolean | undefined
}

export interface TokenTotals extends TokenStatsRow {
  total?: number
  calls?: number
}

export type SessionMode = 'chat' | 'build'

export interface ProjectInfo {
  project_id: string
  project_path: string
  workspace_path?: string
  project_name: string
  summary?: string
  agents_path?: string
  state_path?: string
  memory_path?: string
  project_json_path?: string
  prompt_overlay_path?: string
  legacy_agents_path?: string | null
  legacy_imported_at?: string | null
  created_at?: string
  updated_at?: string
  version?: number
}

export interface MemoryContextPayload {
  mode?: SessionMode | string
  session?: SessionInfo | null
  sources?: string[]
  sourceMap?: Array<{
    domain?: string
    kind?: string
    path?: string
    sessionId?: string
    projectId?: string
    statePath?: string
    workspacePath?: string
    legacyAgentsPath?: string | null
    legacyImportedAt?: string | null
    scope?: string
  }>
  project?: ProjectInfo | null
  projectIndexSummary?: string
  projectMemory?: string
}

export interface MemoryPayload {
  long_term?: string
  today_episode?: string
  episodes?: string[]
  context?: MemoryContextPayload
  projects?: ProjectInfo[]
  history?: HistoryStats
  tokens?: Record<string, TokenStatsRow>
  tokensByModel?: Record<string, TokenStatsRow>
  tokensByUsageType?: Record<string, TokenStatsRow>
  tokenTotals?: TokenTotals
  runtime?: RuntimeStats
  compaction?: SemanticCompactionPayload | null
  schedulerMaintenance?: SchedulerMaintenanceStats
  watchlist?: WatchlistPayload
  versions?: MemoryVersionsPayload
}

export interface SemanticCompactionPayload {
  cursor?: {
    compactedUntilSeq?: number
    archivedUntilSeq?: number
    status?: string
    lastCompactionId?: string | null
  }
  archive?: {
    compactedUntilSeq?: number
    archivedUntilSeq?: number
    archiveBlockedUntilCompacted?: boolean
  }
  omittedRanges?: Array<Record<string, unknown>>
  latest?: Record<string, unknown> | null
}

export interface SchedulerMaintenanceStats {
  jobs?: number
  enabled?: number
  nextRunAtMs?: number | null
  lastError?: string | null
}

export interface WatchlistDecision {
  action?: 'skip' | 'run' | string
  reason?: string
  message?: string
  checkedAt?: number
  model?: string | null
  provider?: string | null
  modelRole?: string | null
}

export interface WatchlistPayload {
  content?: string
  lastDecision?: WatchlistDecision | null
}

export interface MemoryVersion {
  id: string
  target: 'memory' | 'user' | 'episode' | string
  relPath: string
  label: string
  reason: string
  createdAt: number
  contentHash: string
  bytes: number
}

export interface MemoryVersionsPayload {
  versions: MemoryVersion[]
  count?: number
  path?: string
}

export interface MemoryVersionDetail {
  version: MemoryVersion
  content: string
  currentContent: string
  diff: string
}

export interface RuntimeStats {
  path?: string
  bytes?: number
  events?: number
  latestSeq?: number
  latestTs?: number | null
  activeTurnEvents?: number
  activeTurns?: number
  archiveFiles?: number
  archiveBytes?: number
  archives?: unknown[]
  lastArchiveAt?: number | string | null
  needsRotation?: boolean
}

export interface HistoryArchiveInfo {
  path: string
  bytes: number
  updated_at?: string
}

export interface HistoryStats {
  version?: number
  latest_seq?: number
  active_lines?: number
  active_bytes?: number
  archive_files?: number
  archive_bytes?: number
  archives?: HistoryArchiveInfo[]
  last_archive_at?: string | null
  migrated_at?: string | null
  hot_limit_lines?: number
  hot_limit_bytes?: number
  needs_rotation?: boolean
}

export interface TokensStreak {
  active_days: number
  current_streak: number
  longest_streak: number
}

export interface TokensPayload {
  totals: TokenTotals
  byDate: Record<string, TokenStatsRow>
  byModel: Record<string, TokenStatsRow>
  byUsageType: Record<string, TokenStatsRow>
  byDateModel: Record<string, Record<string, TokenStatsRow>>
  byHour: Record<string, TokenStatsRow>
  streak: TokensStreak
  sessions: number
  messages: number
  recentCalls?: TokenUsageRecord[]
  recentCacheCalls?: TokenUsageRecord[]
  generatedAt: string
}

export type TokensRange = 'all' | '30d' | '7d'

export interface TokenUsageRecord {
  ts: string
  provider: string
  model: string
  model_entry_id?: string
  /** Historical replay compatibility only. */
  model_role?: string
  route_reason?: string
  /** Historical replay compatibility only. */
  used_fallback?: boolean
  /** Historical replay compatibility only. */
  fallback_reason?: string
  estimated_input_tokens?: number
  route_estimated_tokens?: number
  usage_type: string
  input: number
  output: number
  cache_read: number
  cache_create: number
  total: number
}

export type ProviderRegion =
  'foreign' | 'aggregator' | 'cloud' | 'cn' | 'local' | 'other'

export interface ProviderOption {
  name: string
  displayName?: string
  protocols?:
    Array<'openai' | 'anthropic'> | readonly ('openai' | 'anthropic')[]
  defaultProtocol?: 'openai' | 'anthropic' | null
  apiBases?: Partial<Record<'openai' | 'anthropic', string>>
  iconId?: string | null
  websiteUrl?: string
  apiKeyUrl?: string
  modelDiscovery?: Partial<
    Record<
      'openai' | 'anthropic',
      'openai_compat' | 'anthropic' | 'unsupported'
    >
  >
  region?: ProviderRegion
  isGateway?: boolean
  isLocal?: boolean
  isOauth?: boolean
  isDirect?: boolean
  thinkingStyle?: string | null
}

export interface ModelEntry {
  entryId: string
  provider: string
  protocol: 'openai' | 'anthropic'
  modelId: string
  displayName?: string
  effectiveDisplayName: string
  apiKey: string
  apiBase: string
  capabilityOverrides?: ModelCapabilityOverrides
  contextWindowTokens: number
  maxTokens: number
  reasoningEffort: string | null
  pricing?: ModelPricing
  resolvedProfile: ResolvedModelProfile
}

export interface ModelPricing {
  inputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
  cacheReadUsdPerMillionTokens: number
  cacheWriteUsdPerMillionTokens: number
}

export type ModelFallbackTrigger = 'rate_limit' | 'transient'

export interface ModelExecutionPolicy {
  fallback: {
    enabled: boolean
    entryId: string | null
    triggerOn: ModelFallbackTrigger[]
  }
  cost: { maxUsdPerAgentTurn: number | null }
}

export interface ModelCapabilityOverrides {
  toolCall?: boolean
  vision?: boolean
  reasoning?: boolean
}

export type CapabilitySource = 'override' | 'inferred' | 'default'

export interface ResolvedModelProfile {
  toolCall: boolean
  vision: boolean
  reasoning: boolean
  sources: {
    toolCall: CapabilitySource
    vision: CapabilitySource
    reasoning: CapabilitySource
  }
  contextWindowTokens: number
  maxTokens: number
  reasoningEfforts: string[] | readonly string[]
  reasoningAdapter: string
}

export interface ModelEntrySaveInput {
  entryId?: string
  provider?: string
  protocol?: 'openai' | 'anthropic'
  modelId?: string
  displayName?: string
  apiKey?: string | null
  apiBase?: string
  capabilityOverrides?: ModelCapabilityOverrides
  contextWindowTokens?: number
  maxTokens?: number
  reasoningEffort?: string | null
  pricing?: ModelPricing | null
  /** New entries only: reuse this saved entry's key (same endpoint). */
  credentialsFrom?: string
}

export interface ModelProfilePreviewInput {
  provider: string
  protocol: 'openai' | 'anthropic'
  modelId: string
  capabilityOverrides?: ModelCapabilityOverrides
  contextWindowTokens?: number
  maxTokens?: number
}

export interface AttachmentRef {
  id: string // "att_2026-05_abc12345"
  name: string
  mime: string
  size: number
  kind: 'image' | 'document' | 'text'
  hasText: boolean
  hasImage: boolean
  path: string
  textPath?: string | null
}

export interface ChatSendPayload {
  content: string
  attachments?: AttachmentRef[]
  requestedSkills?: RequestedSkill[]
  displayContent?: string
  delivery?: 'queue' | 'interject'
}

export interface QueueDraftRecovery {
  sessionId: string
  payload: ChatSendPayload
}

export interface ModelTestResult {
  ok: boolean
  kind: 'text' | 'vision'
  entryId?: string
  latencyMs?: number
  model?: string
  provider?: string
  sample?: string
  finishReason?: string
  error?: string
}

export interface DiscoveredModel {
  id: string
  ownedBy?: string
  created?: number | string
}

export interface ModelDiscoveryResult {
  ok: boolean
  provider?: string
  protocol?: 'openai' | 'anthropic'
  apiBase?: string | null
  source?: string
  models: DiscoveredModel[]
  code?: string
  message?: string
}

export interface CurrentModelConfig {
  entryId: string
  provider: string
  providerLabel: string
  protocol: 'openai' | 'anthropic'
  modelId: string
  displayName: string | null
  effectiveDisplayName: string
  apiBase: string
  maxTokens: number
  reasoningEffort: string | null
  contextWindowTokens: number
  capabilities: {
    toolCall: boolean
    vision: boolean
    reasoning: boolean
  }
  capabilitySources: ResolvedModelProfile['sources']
  reasoningEfforts: string[] | readonly string[]
  reasoningAdapter: string
}

export interface ModelAvailability {
  usable: boolean
  code?: 'model_configuration_required' | string | null
  message: string
  action?: 'open_model_settings' | string | null
  provider?: string | null
  entryName?: string | null
}

export type ProfileOnboardingStatus =
  'pending' | 'in_progress' | 'completed' | 'skipped'

export interface ProfileOnboardingPayload {
  status: ProfileOnboardingStatus
  sessionId: string | null
  interactionId: string | null
  attemptCount: number
  lastError: string | null
  canStart: boolean
  canSkip: boolean
}

export interface ProfileOnboardingActionResult {
  started: boolean
  state: ProfileOnboardingPayload
}

export interface ModelConfigPayload {
  schemaVersion: 2
  activeModelId: string | null
  models: ModelEntry[]
  policy: ModelExecutionPolicy
  current: CurrentModelConfig | null
  availability: ModelAvailability
  providerOptions: ProviderOption[]
  profileOnboarding?: ProfileOnboardingActionResult
}

export interface DesktopPetPayload {
  enabled: boolean
  autoStartWithWebui: boolean
  running: boolean
  pid?: number | null
  lastError?: string | null
  installCommand: string
}

export interface DiagnosticsFileInfo {
  path: string
  bytes?: number
  updatedAt?: number
}

export type DiagnosticsStatus =
  'ok' | 'missing' | 'corrupt' | 'invalid' | 'unknown' | string

export interface DiagnosticsConfigSummary {
  path?: string
  exists?: boolean
  status?: DiagnosticsStatus
  error?: string
  models?: number
  corruptBackups?: DiagnosticsFileInfo[]
}

export interface SchedulerDiagnosticsPayload {
  jobsFile?: string
  actionFile?: string
  lastActionErrors?: unknown[]
  corruptActionFiles?: DiagnosticsFileInfo[]
}

export interface DiagnosticsDependencyPayload {
  nodeRuntime?: boolean
  desktopRenderer?: boolean
  desktopPetModules?: boolean
  [key: string]: unknown
}

export interface WorkspacePolicyRootPayload {
  path?: string
  label?: string
}

export interface WorkspacePolicyDiagnosticsPayload {
  workspaceRoot?: string | null
  stateRoot?: string | null
  allowRoots?: WorkspacePolicyRootPayload[]
  denyRoots?: WorkspacePolicyRootPayload[]
  readOnlyRoots?: WorkspacePolicyRootPayload[]
  outsideWorkspace?: string
}

export interface SandboxCapabilityDiagnosticsPayload {
  platform?: string
  backend?: string
  status?: 'available' | 'unavailable' | 'unsupported' | 'error' | string
  filesystem?: string
  network?: string
  processTree?: boolean
  reason?: string
}

export interface ProcessRuntimeDiagnosticsPayload {
  platform?: string
  ownership?: boolean
  leases?: boolean
  reparent?: boolean
  orphanReconcile?: boolean
  stableProcessIdentity?: boolean
  processTree?: string
  terminal?: {
    interactiveStdio?: boolean
    pty?: boolean
    resize?: boolean
  }
  outputQuota?: {
    defaultBytes?: number
    maximumBytes?: number
    defaultStrategy?: string
  }
}

export interface LifecycleServiceDiagnosticsPayload {
  id?: string
  required?: boolean
  dependsOn?: string[]
  state?: string
  error?: string | null
}

export interface LifecycleDiagnosticsPayload {
  state?: string
  failedServiceId?: string | null
  failedPhase?: string | null
  services?: LifecycleServiceDiagnosticsPayload[]
}

export interface DiagnosticsRuntimePaths {
  runtimeRoot?: string
  stateRoot?: string
  stateRootSource?: string
  templatesDir?: string
  skillsDir?: string
  assetsDir?: string
  memoryRoot?: string
  sessionsRoot?: string
  projectsRoot?: string
  attachmentsRoot?: string
  mediaRoot?: string
  tokensFile?: string
  schedulerRoot?: string
  teamRoot?: string
  tasksRoot?: string
  processesRoot?: string
  controlRoot?: string
  mcpConfigPath?: string
  runtimeManifestPath?: string
  legacyRuntimeSkillsReceiptPath?: string
}

export interface LegacyStateRootInfo {
  path: string
  kind: string
  existed: boolean
}

export interface LegacyStateMigrationPayload {
  legacyStateRoots?: LegacyStateRootInfo[]
  copied?: number
  skipped?: number
  logPath?: string
}

export interface ProjectLegacyPrivateDataPayload {
  projectPath?: string
  sessions?: boolean
  memory?: boolean
}

export interface DiagnosticsEnvironmentSummary {
  catalogRevision?: string
  platform?: 'darwin' | 'win32' | 'linux'
  arch?: 'arm64' | 'x64'
  projectRoot?: string
  required?: number
  ready?: number
  missing?: number
  versionMismatch?: number
  blockedSkills?: number
  diagnostics?: string[]
  activeJob?: {
    jobId?: string
    status?: string
    updatedAt?: string
  } | null
}

export interface SubagentSupervisorDiagnosticsPayload {
  active?: number
  maxGlobal?: number
  maxPerSession?: number
  bySession?: Record<string, number>
  taskIds?: string[]
}

export interface AgentDefinitionDiagnosticsPayload {
  revision?: string
  sources?: Array<{
    id?: string
    kind?: string
    trust?: string
    rank?: number
    active?: boolean
    blockedReason?: string | null
  }>
  agents?: Array<{
    definition?: { name?: string }
    source?: { id?: string; kind?: string; trust?: string }
  }>
  aliases?: Record<string, string>
  diagnostics?: Array<{
    code?: string
    severity?: string
    sourceId?: string
    agentName?: string | null
    message?: string
  }>
}

export interface EffectiveConfigSourcePayload {
  kind?: 'builtin' | 'user' | 'project' | 'session' | 'managed' | string
  id?: string
  trust?: 'trusted' | 'untrusted' | 'managed' | string
}

export interface EffectiveConfigEntryPayload {
  key?: string
  value?: unknown
  source?: EffectiveConfigSourcePayload
  trust?: string
  trace?: Array<{
    source?: EffectiveConfigSourcePayload
    status?: 'applied' | 'rejected' | string
    reason?: string
    fingerprint?: string
  }>
  secretSources?: Array<{
    path?: string
    source?: EffectiveConfigSourcePayload
  }>
}

export interface EffectiveConfigSnapshotPayload {
  schemaVersion?: number
  revision?: string
  status?: string
  error?: string
  entries?: EffectiveConfigEntryPayload[]
}

export interface PromptSnapshotsDiagnosticsPayload {
  count?: number
  recent?: Array<{
    turnId?: string
    projection?: {
      stablePrefix?: { hash?: string }
      cacheBreak?: {
        classification?: 'initial' | 'none' | 'expected' | 'unexpected' | string
        reasonCode?: string
        firstChanged?: {
          kind?: string
          id?: string
          index?: number
        } | null
      }
    }
  }>
}

export interface HybridMemoryDiagnosticsPayload {
  capability?: {
    requestedMode?: 'off' | 'eval' | 'on' | string
    effectiveMode?: 'off' | 'eval' | 'on' | string
    promptMutationAllowed?: boolean
    reason?: string
    evaluationDatasetSha256?: string | null
    embeddingProviderId?: string | null
  }
  indexPath?: string
  searches?: number
  promptMutations?: number
  embeddingFallbacks?: number
  lastStrategy?: 'hybrid' | 'fts_fallback' | string | null
  lastResultCount?: number
  lastSourceDigest?: string | null
  derivedDiskBytes?: number
}

export interface CodeIntelligenceDiagnosticsPayload {
  capability?: {
    requestedMode?: 'off' | 'eval' | 'on' | string
    effectiveMode?: 'off' | 'eval' | 'on' | string
    toolAllowed?: boolean
    reason?: string
    evaluationDatasetSha256?: string | null
    parserRevision?: string
  }
  graphManagers?: number
  queries?: number
  lspQueries?: number
  graphFallbacks?: number
  notifications?: number
  lastStrategy?: 'graph' | 'lsp' | 'graph_fallback' | string | null
  lastLatencyMs?: number | null
  graph?: {
    state?: 'idle' | 'building' | 'ready' | 'closed' | string
    version?: number
    indexedFiles?: number
    sourceBytes?: number
    parserLoads?: number
    parseErrors?: number
    skippedOversized?: number
    skippedSymlinks?: number
    skippedBinary?: number
    skippedUnsupported?: number
    skippedCapacity?: number
    oversizedFileGateVerified?: boolean
    cacheStatus?: string
    cacheBytes?: number
  }
  lsp?: Array<{
    keyDigest?: string
    descriptorId?: string
    sourceKind?: string
    state?: string
    starts?: number
    restarts?: number
    crashes?: number
    generation?: number
    pendingRequests?: number
    openDocuments?: number
    ignoredNotifications?: number
    protocolErrors?: number
    lastError?: string | null
  }>
}

export interface DiagnosticsPayload {
  root?: string
  paths?: DiagnosticsRuntimePaths
  modelConfig?: DiagnosticsConfigSummary
  localConfig?: DiagnosticsConfigSummary
  contextExplanation?: MemoryContextExplanationPayload
  legacyStateMigration?: LegacyStateMigrationPayload
  projectLegacyPrivateData?: ProjectLegacyPrivateDataPayload | null
  scheduler?: SchedulerDiagnosticsPayload
  runtime?: RuntimeStats
  workspacePolicy?: WorkspacePolicyDiagnosticsPayload
  sandbox?: SandboxCapabilityDiagnosticsPayload
  processRuntime?: ProcessRuntimeDiagnosticsPayload
  lifecycle?: LifecycleDiagnosticsPayload
  /** Kernel subagent records (current Core) or the retired supervisor summary. */
  subagents?: SubagentSupervisorDiagnosticsPayload | unknown[]
  agentDefinitions?: AgentDefinitionDiagnosticsPayload
  effectiveConfig?: EffectiveConfigSnapshotPayload
  commandCatalog?: {
    status?: string
    registeredSkills?: number
    conflicts?: Array<{
      token?: string
      skillName?: string
      source?: string
      reason?: string
      winnerSkillName?: string | null
      winnerSource?: string
    }>
  }
  mcp?: McpStatusPayload
  promptSnapshots?: PromptSnapshotsDiagnosticsPayload
  hybridMemory?: HybridMemoryDiagnosticsPayload
  codeIntelligence?: CodeIntelligenceDiagnosticsPayload
  activeTasks?: ActiveRuntimeTask[]
  desktopPet?: DesktopPetPayload & Record<string, unknown>
  environment?: DiagnosticsEnvironmentSummary
  dependencies?: DiagnosticsDependencyPayload
}

export interface MemoryContextExplanationPayload {
  status?: string
  sessionId?: string | null
  turnId?: string | null
  mode?: string | null
  injected?: Array<Record<string, unknown>>
  omitted?: Array<Record<string, unknown>>
  checkpoint?: Record<string, unknown> | null
  compaction?: Record<string, unknown> | null
  microcompact?: Record<string, unknown> | null
  reason?: string
  [key: string]: unknown
}

export interface BootstrapPayload {
  app: string
  model?: string
  provider?: string
  providerLabel?: string
  tools: ToolInfo[]
  skills: SkillInfo[]
  /** Skills that failed validation, with reasons (not in `skills`). */
  invalidSkills?: InvalidSkillInfo[]
  plugins?: PluginSummary[]
  memory: MemoryPayload
  modelConfig: ModelConfigPayload
  profileOnboarding: ProfileOnboardingPayload
  scheduler?: SchedulerPayload
  control?: ControlPayload
  goals?: BootstrapGoalsPayload
  hooks?: HooksConfigPayload
  desktopPet?: DesktopPetPayload
  runtime?: RuntimeReplayPayload
  mcp?: McpStatusPayload
  diagnostics?: DiagnosticsPayload
  projects?: ProjectInfo[]
  context_used?: number
  unarchivedHistory?: RuntimeHistoryItem[]
}

export interface CompactResult {
  status: 'compacted' | 'skipped' | 'degraded'
  count: number
  message: string
  memory: MemoryPayload
  unarchivedHistory: RuntimeHistoryItem[]
  runtime?: RuntimeStats
  compaction?: CompactResultCompaction
  error?: string
}

export interface CompactResultCompaction {
  compactionId?: string
  mode?: SessionMode | string
  projectId?: string | null
  range?: { fromSeq?: number | null; toSeq?: number | null }
  cursor?: SemanticCompactionPayload['cursor']
  applied?: Array<{
    scope?: CoreMemoryScope
    path?: string
    operationCount?: number
  }>
  discarded?: Array<CoreDiscardedItem | Record<string, unknown>>
  decisions?: Array<CoreCompactionDecision | Record<string, unknown>>
}

export interface RuntimeHistoryItem {
  role: 'user' | 'assistant'
  content: string
  attachments?: AttachmentRef[]
  turn_id?: string
  source?: string
  ui_hidden?: boolean
  scheduler?: Record<string, unknown>
}

export interface RuntimeEventEnvelope {
  event: string
  seq?: number
  ts?: number
  turn_id?: string
  request_id?: string
  attempt_id?: string
  client_message_id?: string
  [key: string]: unknown
}

export interface RuntimeReplayPayload {
  sessionId?: string
  afterSeq?: number
  latestSeq: number
  format?: 'projection' | 'envelope_v2'
  busy?: boolean
  scope?: 'unarchived' | string
  events: RuntimeEventEnvelope[]
  active_tasks?: Array<ActiveRuntimeTask | Record<string, unknown>>
}

export interface ActiveRuntimeTask {
  id: string
  kind: string
  label?: string
  turn_id?: string | null
  job_id?: string | null
  session_id?: string | null
  cancelled?: boolean
}

/** Task-panel row (background job, subagent, or workflow run), mirrors Core `CoreTaskRecord`. */
export type RuntimeTaskRecord = CoreTaskRecord

export interface TodoItem {
  id: string | number
  plan_step_id?: string | null
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
  blocked_reason?: string | null
}

export interface ControlQuestionOption {
  id?: string
  label: string
  description?: string
}

export interface ControlQuestion {
  id: string
  header: string
  question: string
  options: ControlQuestionOption[]
  /** `ask_user_question` questions that accept several options. */
  multi_select?: boolean
}

/** Core permission presets (sandbox + approval bundles). */
export type PermissionPreset =
  'read-only' | 'workspace-write' | 'danger-full-access'
export type InteractionKind = 'ask' | 'plan' | string
export type InteractionStatus =
  'waiting' | 'answered' | 'approved' | 'commented' | 'cancelled' | string

export interface ControlInteraction {
  id: string
  kind: InteractionKind
  status: InteractionStatus
  created_at?: number
  updated_at?: number
  parent_call_id?: string | null
  context?: string
  questions?: ControlQuestion[]
  answers?: Record<string, unknown>
  title?: string
  summary?: string
  plan_markdown?: string
  assumptions?: string[]
  risk_level?: string
  comments?: Array<{ content?: string; timestamp?: number }>
  meta?: Record<string, unknown>
}

export interface PermissionPresetOption {
  value: PermissionPreset | string
  name: string
  description: string
}

/** Core `control.get()` payload (version 3). */
export interface ControlPayload {
  version?: number
  /** Same as `preset`; kept for older consumers. */
  mode?: PermissionPreset | string
  preset: PermissionPreset | string
  /** Plan mode is a separate toggle (`control.setMode('plan' | 'default')`). */
  plan: boolean
  approval?: string
  sandbox?: string
  presets?: PermissionPresetOption[]
  pending?: ControlInteraction | null
}

/** Current goal (`GoalView` projection; `activation` only on live host views). */
export type RuntimeGoalView = CoreRuntimeGoalView

export interface BootstrapGoalsPayload {
  active: RuntimeGoalView | Record<string, unknown> | null
}

export type GoalOperationResult = CoreGoalOperationResult

export interface GoalProjectionState {
  /** Latest goal per session; `null` after a clear. */
  bySession: Record<string, RuntimeGoalView | null>
}

export interface QueuedPromptItem {
  id: string
  turnId: string
  clientMessageId: string
  content: string
  delivery: 'queue' | 'interject'
  status: 'queued' | 'interjecting'
  supportsInterjection: boolean
  createdOrder: number
  attachmentCount: number
  requestedSkillNames: string[]
  hasCapabilityRefs: boolean
}

export interface PendingState {
  label: string
  detail: string
  tone?: 'running' | 'done' | 'error'
}

export type RuntimeStatus = 'connecting' | 'ready' | 'error'

export type SchedulerScheduleKind = 'at' | 'every' | 'cron'
export type SchedulerPayloadKind = 'agent_turn' | 'team_wake' | 'system_event'
export type SchedulerMisfirePolicy = 'skip' | 'latest' | 'catch-up-one'
export type SchedulerRunTrigger = 'timer' | 'manual' | 'misfire'
export type SchedulerRunStatus =
  'running' | 'ok' | 'error' | 'skipped' | 'cancelled' | 'interrupted' | string

export interface SchedulerSchedule {
  kind: SchedulerScheduleKind
  atMs?: number | null
  everyMs?: number | null
  expr?: string | null
  tz?: string | null
}

export interface SchedulerJobPayload {
  kind: SchedulerPayloadKind
  message: string
  target?: string | null
  projectId?: string | null
  deliver?: boolean
  meta?: Record<string, unknown>
}

export interface SchedulerRunRecord {
  runId?: string | null
  taskId?: string | null
  runAtMs: number
  scheduledForMs?: number
  trigger?: SchedulerRunTrigger
  misfirePolicy?: SchedulerMisfirePolicy
  missedCount?: number
  countCapped?: boolean
  status: SchedulerRunStatus
  durationMs?: number
  error?: string | null
}

export interface SchedulerPendingMisfire {
  policy: SchedulerMisfirePolicy
  scheduledForMs: number
  detectedAtMs: number
  missedCount: number
  countCapped: boolean
}

export interface SchedulerActiveRun {
  runId: string
  taskId: string
  phase: 'queued' | 'running'
  trigger: SchedulerRunTrigger
  scheduledForMs: number
  enqueuedAtMs: number
  startedAtMs: number | null
  misfirePolicy: SchedulerMisfirePolicy
  missedCount: number
  countCapped: boolean
}

export interface SchedulerJobState {
  nextRunAtMs?: number | null
  lastRunAtMs?: number | null
  lastStatus?: SchedulerRunStatus | null
  lastError?: string | null
  runHistory?: SchedulerRunRecord[]
  pendingMisfire?: SchedulerPendingMisfire | null
  activeRun?: SchedulerActiveRun | null
}

export interface SchedulerJob {
  id: string
  name: string
  enabled: boolean
  schedule: SchedulerSchedule
  payload: SchedulerJobPayload
  state: SchedulerJobState
  createdAtMs?: number
  updatedAtMs?: number
  deleteAfterRun?: boolean
  misfirePolicy?: SchedulerMisfirePolicy
  protected?: boolean
  purpose?: string | null
}

export interface SchedulerStatusPayload {
  running: boolean
  jobs: number
  enabled: number
  nextRunAtMs?: number | null
  lastError?: string | null
  active?: number
  queued?: number
  maxConcurrentRuns?: number
  maxPerOwner?: number
  maxQueuedRuns?: number
  shutdownPolicy?: 'cancel-and-interrupt'
}

export interface SchedulerPayload {
  status: SchedulerStatusPayload
  jobs: SchedulerJob[]
  diagnostics?: Record<string, unknown>
}

/**
 * Core owns the wire discriminant and payload union. Renderer only narrows the
 * generic domain payload slots into view-model shapes consumed by projectors.
 */
type RendererRuntimePayloadProjection = {
  attachments?: AttachmentRef[]
  control?: ControlPayload
  interaction?: ControlInteraction
  job?: SchedulerJob
  profile_onboarding?: ProfileOnboardingPayload
  session?: SessionInfo
  task?: RuntimeTaskEventRecord
  todos?: TodoItem[]
}

/** `task_*` / `workflow_*` event payload: a Core job or workflow-run record projected from the session log. */
export interface RuntimeTaskEventRecord {
  id: string
  kind?: string
  label?: string
  command?: string
  status?: string
  exit_code?: number | null
  detail?: string | null
  session_id?: string
  /** Workflow runs: `workflow` or `ralph`. */
  workflow_tool?: string
  /** Workflow runs: accepted `agent()` calls (Ralph: rounds). */
  rounds?: number
  current_phase?: string | null
}

export type WsEvent = CoreRuntimeEvent & RendererRuntimePayloadProjection

/**
 * Host-only receipt of a finished workspace git operation (commit, push,
 * PR publish …) in a Build session; seq 0, never replayed. The renderer
 * surfaces it as a notification (runtime/handlers/git.ts).
 */
export type GitOperationCompletedEvent = Extract<
  WsEvent,
  { event: 'git_operation_completed' }
>

export type GitOperationAction = GitOperationCompletedEvent['action']

export interface SessionInfo {
  id: string
  title: string
  created_at: string
  updated_at: string
  preview: string
  mode?: SessionMode
  project_id?: string | null
  project_path?: string | null
  project_name?: string | null
  message_count?: number
  title_status?: string
  archived_at?: string | null
  control_pending?: SessionControlPending | null
  parent_session_id?: string | null
  lineage_root_id?: string | null
  transition_reason?: 'clear' | null
  transitioned_to_session_id?: string | null
  transitioned_at?: string | null
  version: number
  draft?: boolean
}

export interface SessionControlPending {
  kind: 'ask' | 'plan' | string
  label: string
  tone: 'blue' | 'green' | string
  interaction_id: string
  updated_at: number
}

export type SidebarSortMode = 'manual' | 'created_at' | 'updated_at'

export interface RightWorkspaceState {
  version: 3
  workbenchOpen: boolean
  width: number
  filesTreeWidth: number
  pane: 'launcher' | 'review' | 'terminal' | 'files' | 'browser'
}

export interface SidebarState {
  section_order: Array<'projects' | 'chats'>
  project_sort: SidebarSortMode
  chat_sort: SidebarSortMode
  project_order: string[]
  chat_order: string[]
  project_session_order: Record<string, string[]>
  collapsed_project_ids: string[]
  /** Pinned sessions in pin order (Core keeps ≤ 50, drops deleted/archived). */
  pinned_session_ids: string[]
  right_workspace: RightWorkspaceState
}
