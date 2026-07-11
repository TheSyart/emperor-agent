import type {
  ControlMode as CoreControlMode,
  CompactionDecision as CoreCompactionDecision,
  DiscardedItem as CoreDiscardedItem,
  InteractionKind as CoreInteractionKind,
  InteractionStatus as CoreInteractionStatus,
  HooksConfigV2 as CoreHooksConfigV2,
  MemoryScope as CoreMemoryScope,
  RuntimeEvent as CoreRuntimeEvent,
} from '@emperor/core'

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

export interface HookSourcePayload {
  id?: string
  kind?: 'global' | 'project' | 'project-local' | 'session' | 'test' | string
  rank?: number
  path?: string
  readonly?: boolean
  revision?: string
  active?: boolean
  blockedReason?: string | null
}

export interface HookDiagnosticPayload {
  code?: string
  path?: string
  message?: string
}

export interface HookHandlerPayload {
  id?: string
  type?: 'command' | 'http' | 'prompt' | 'agent' | string
  enabled?: boolean
  command?: string
  args?: string[]
  url?: string
  prompt?: string
  modelRole?: 'secondary' | 'main' | string
  maxTurns?: number
  timeoutMs?: number
  statusMessage?: string
  once?: boolean
  shell?: 'none' | 'bash' | 'powershell' | string
  headers?: Record<string, string>
  async?: boolean
  asyncRewake?: boolean
  allowedEnv?: string[]
}

export interface HookGroupPayload {
  id?: string
  enabled?: boolean
  matcher?: string
  if?: string
  failureMode?: 'open' | 'closed' | string
  handlers?: HookHandlerPayload[]
}

export type HooksConfigPayload = CoreHooksConfigV2

export interface EffectiveHookGroupPayload {
  eventName?: string
  group?: HookGroupPayload
  source?: HookSourcePayload
}

export interface HookProjectTrustPayload {
  canonicalRoot?: string
  digest?: string
  status?: 'trusted' | 'untrusted' | 'stale' | string
}

export interface HooksPayload {
  revision?: string
  config?: HooksConfigPayload
  globalConfig?: HooksConfigPayload
  effectiveGroups?: EffectiveHookGroupPayload[]
  diagnostics?: HookDiagnosticPayload[]
  sources?: HookSourcePayload[]
  projectTrust?: HookProjectTrustPayload | null
  summary?: {
    total?: number
    groups?: number
    events?: Array<{ eventName?: string; groups?: number; count?: number }>
  }
}

export interface HookEventMetadataPayload {
  eventName: string
  matcherField: string | null
  mode: 'observe' | 'block' | 'transform' | 'continue' | string
  allowedHandlers: string[]
}

export interface HooksMetadataPayload {
  version?: number
  events?: HookEventMetadataPayload[]
  handlers?: Record<string, Record<string, unknown>>
  limits?: Record<string, unknown>
}

export interface HookAuditRecordPayload {
  hookRunId?: string
  eventName?: string
  groupId?: string
  handlerId?: string
  handlerType?: string
  source?: HookSourcePayload
  snapshotRevision?: string
  startedAt?: string
  durationMs?: number
  status?: string
  outcome?: string
  reason?: string
  inputHash?: string
  outputHash?: string | null
}

export interface HookAuditPayload {
  records?: HookAuditRecordPayload[]
  badLines?: Array<{ line?: number; raw?: string }>
  cursor?: string
  nextCursor?: string | null
  total?: number
}

export interface SkillInfo {
  name: string
  description?: string
  path: string
  tags?: string
  always?: boolean
  source?: 'builtin' | 'user' | 'project'
  status?: 'active' | 'blocked' | 'blocked_pending_review' | 'invalid'
  readOnly?: boolean
  requirements?: {
    bins: string[]
    runtimes: string[]
    env: string[]
  }
}

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
  [key: string]: number | string | undefined
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
  archives?: Array<{ path: string; bytes: number; updatedAt?: number }>
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
export type TokensTab = 'overview' | 'models' | 'cache'

export interface TokenUsageRecord {
  ts: string
  provider: string
  model: string
  model_role?: string
  route_reason?: string
  used_fallback?: boolean
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
  display_name?: string
  backend?: string
  websiteUrl?: string
  apiKeyUrl?: string
  modelDiscovery?: string
  defaultApiBase?: string
  region?: ProviderRegion
  isGateway?: boolean
  isLocal?: boolean
  isOauth?: boolean
  isDirect?: boolean
  thinkingStyle?: string | null
}

export interface ModelEntry {
  name: string // 唯一 key（agents.defaults.model 引用）
  id?: string // 兼容旧字段，等价于 mainModelId
  mainModelId?: string // 主模型 id：复杂任务 / 主 Agent
  secondaryModelId?: string // 次模型 id：简单任务 / 内部任务
  provider: string // registry name
  apiKey?: string | null // "***last4" 占位 / 空 / 真值
  apiBase?: string | null
  extraHeaders?: Record<string, unknown> | null
  extraBody?: Record<string, unknown> | null
  maxTokens?: number | null
  temperature?: number | null
  contextWindowTokens?: number | null
  reasoningEffort?: string | null
  label?: string
  supportsVision?: boolean // 仅由"测试视觉"成功时自动 true；UI 用 👁 徽章渲染
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
}

export interface ModelTestResult {
  ok: boolean
  kind: 'text' | 'vision'
  latencyMs?: number
  model?: string
  modelRole?: string
  provider?: string
  sample?: string
  finishReason?: string
  error?: string
  visionMarked?: boolean // 视觉测试通过且后端已持久化 supportsVision
}

export interface DiscoveredModel {
  id: string
  ownedBy?: string
  created?: number | string
}

export interface ModelDiscoveryResult {
  ok: boolean
  provider?: string
  apiBase?: string | null
  source?: string
  models: DiscoveredModel[]
  code?: string
  message?: string
}

export interface AgentDefaults {
  provider?: string | null
  model?: string | null
  maxTokens?: number | null
  temperature?: number | null
  reasoningEffort?: string | null
  contextWindowTokens?: number | null
}

export interface ProviderConfig {
  apiKey?: string | null
  apiBase?: string | null
  extraHeaders?: Record<string, unknown> | null
  extraBody?: Record<string, unknown> | null
  [key: string]: unknown
}

export interface ModelConfigRaw {
  agents?: {
    defaults?: AgentDefaults
    [key: string]: unknown
  }
  models?: ModelEntry[]
  providers?: Record<string, ProviderConfig>
  [key: string]: unknown
}

export interface CurrentModelConfig {
  provider?: string | null
  providerLabel?: string | null
  model?: string | null
  apiBase?: string | null
  maxTokens?: number | null
  temperature?: number | null
  reasoningEffort?: string | null
  contextWindowTokens?: number | null
  entryName?: string | null
  entryLabel?: string | null
  supportsVision?: boolean
  mainModelId?: string | null
  secondaryModelId?: string | null
  modelRole?: string | null
}

export interface ModelAvailability {
  usable: boolean
  code?: 'model_configuration_required' | string | null
  message: string
  action?: 'open_model_settings' | string | null
  provider?: string | null
  entryName?: string | null
}

export interface ModelConfigPayload {
  current?: CurrentModelConfig
  secondary?: CurrentModelConfig | null
  availability?: ModelAvailability
  routing?: {
    secondaryEnabled?: boolean
    fallbackToMain?: boolean
    mainEntry?: string | null
    mainModel?: string | null
    secondaryModel?: string | null
  }
  config?: ModelConfigRaw
  providerOptions?: ProviderOption[]
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

export interface ExternalDiagnosticsPayload {
  running?: boolean
  adapters?: unknown[]
  inbox?: {
    pending?: number
    seen?: number
    recent?: unknown[]
  }
  outbox?: {
    recent?: unknown[]
  }
  recentErrors?: unknown[]
  store?: {
    path?: string | null
    exists?: boolean
    bytes?: number
    durable?: boolean
    corruptBackups?: DiagnosticsFileInfo[]
  }
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
  controlRoot?: string
  externalRoot?: string
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
  external?: ExternalDiagnosticsPayload
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
  memory: MemoryPayload
  modelConfig: ModelConfigPayload
  team?: TeamPayload
  scheduler?: SchedulerPayload
  control?: ControlPayload
  desktopPet?: DesktopPetPayload
  runtime?: RuntimeReplayPayload
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
  range?: { fromSeq?: number; toSeq?: number }
  cursor?: SemanticCompactionPayload['cursor']
  applied?: Array<{
    scope?: CoreMemoryScope
    path?: string
    operationCount?: number
  }>
  discarded?: CoreDiscardedItem[]
  decisions?: CoreCompactionDecision[]
}

export interface RuntimeHistoryItem {
  role: 'user' | 'assistant'
  content: string
  attachments?: AttachmentRef[]
  turn_id?: string
  source?: string
  scheduler?: SchedulerMessageMeta
}

export interface RuntimeEventEnvelope {
  event: string
  seq?: number
  ts?: number
  turn_id?: string
  client_message_id?: string
  [key: string]: unknown
}

export interface RuntimeReplayPayload {
  sessionId?: string
  afterSeq?: number
  latestSeq: number
  busy?: boolean
  scope?: 'unarchived' | string
  events: RuntimeEventEnvelope[]
  active_tasks?: ActiveRuntimeTask[]
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

export interface RuntimeTaskRecord {
  id: string
  kind: string
  status: string
  title: string
  source: string
  startedAt?: number
  endedAt?: number | null
  turnId?: string | null
  toolCallId?: string | null
  jobId?: string | null
  outputPath?: string | null
  transcriptPath?: string | null
  progress?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type ToolStatus =
  'queued' | 'running' | 'done' | 'error' | 'error_aborted'

export interface ToolArtifactRef {
  path: string
  kind?: string
  bytes?: number
  media?: MediaArtifactRef
  metadata?: Record<string, unknown>
}

export interface MediaArtifactRef {
  id: string
  kind: 'image' | 'audio' | string
  mime: string
  name: string
  relPath: string
  originalPath: string
}

export interface TodoItem {
  id: string | number
  plan_step_id?: string | null
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
  blocked_reason?: string | null
}

export interface TextSegment {
  id: string
  type: 'text'
  content: string
}

export interface ThoughtSegment {
  id: string
  type: 'thought'
  status: 'running' | 'done' | 'error' | 'error_aborted'
  label?: string
  stage?: string
  source?: 'audit' | string
  summary?: string
  toolIds?: string[]
  toolNames?: string[]
  startedAt?: number
  endedAt?: number
  durationMs?: number
}

export interface ToolSegment {
  id: string
  type: 'tool'
  toolId?: string
  name: string
  displayName?: string
  inputLabel?: string
  outputLabel?: string
  arguments?: Record<string, unknown>
  status: ToolStatus
  summary?: string
  output?: string
  outputMissing?: boolean
  outputTruncated?: boolean
  artifacts?: ToolArtifactRef[]
  metadata?: Record<string, unknown>
  todos?: TodoItem[]
  subagents?: SubagentState[]
  startedAt?: number
  endedAt?: number
  durationMs?: number
}

export interface ControlQuestionOption {
  label: string
  description?: string
}

export interface ControlQuestion {
  id: string
  header: string
  question: string
  options: ControlQuestionOption[]
}

// 控制枚举以 core control/models 为单一来源；`| string` 容忍未来后端新增值
export type ControlMode = `${CoreControlMode}` | string
export type InteractionKind = `${CoreInteractionKind}` | string
export type InteractionStatus = `${CoreInteractionStatus}` | string

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

export interface ControlPayload {
  version?: number
  mode: ControlMode
  previous_mode?: 'ask_before_edit' | 'accept_edits' | 'auto' | null
  pending?: ControlInteraction | null
  last_interaction?: ControlInteraction | null
  updated_at?: number
}

export interface RuntimePlanStep {
  id: string
  title: string
  status: string
  description?: string
  files?: string[]
  commands?: string[]
  acceptance?: string[]
  discovery_refs?: string[]
  discoveryRefs?: string[]
  verification?: Array<Record<string, unknown>>
  evidence?: Array<Record<string, unknown>>
  risk?: string
  risk_note?: string
  rollback?: string
  blocked_reason?: string
}

export interface RuntimePlanDraft {
  phase?: string
  discoveries?: Array<Record<string, unknown>>
  relevant_files?: string[]
  open_questions?: Array<Record<string, unknown>>
  resolved_questions?: Array<Record<string, unknown>>
  alternatives_considered?: string[]
  recommended_approach?: string
  verification_strategy?: string[]
  last_context_refresh_at?: number | null
}

export interface RuntimePlanRecord {
  id: string
  title: string
  summary?: string
  status: string
  updated_at?: number
  steps: RuntimePlanStep[]
  plan_markdown?: string
  planMarkdown?: string
  assumptions?: string[]
  verification?: Array<Record<string, unknown>>
  draft?: RuntimePlanDraft
  metadata?: Record<string, unknown>
}

export interface RuntimePlanEntryDecision {
  decision: 'required' | 'recommended' | 'proceed' | string
  reason: string
  triggers: string[]
  suggested_questions?: string[]
  suggestedQuestions?: string[]
  recommended_readonly_scopes?: string[]
  recommendedReadonlyScopes?: string[]
}

export interface RuntimeTaskRecord {
  id: string
  kind: string
  status: string
  title: string
  source: string
  startedAt?: number
  endedAt?: number | null
  turnId?: string | null
  toolCallId?: string | null
  jobId?: string | null
  outputPath?: string | null
  transcriptPath?: string | null
  progress?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface AskSegment {
  id: string
  type: 'ask'
  interaction: ControlInteraction
}

export interface PlanSegment {
  id: string
  type: 'plan'
  interaction: ControlInteraction
}

export type AssistantSegment =
  TextSegment | ThoughtSegment | ToolSegment | AskSegment | PlanSegment

export interface SubagentToolState {
  id?: string
  name: string
  arguments?: Record<string, unknown>
  status: ToolStatus
  summary?: string
  startedAt?: number
  endedAt?: number
  durationMs?: number
}

export interface SubagentState {
  id?: string
  agent_type?: string
  kind?: 'subagent' | 'team'
  role?: string
  purpose?: string
  status: ToolStatus
  content?: string
  summary?: string
  error?: string
  tools?: SubagentToolState[]
  messages?: TeamMessage[]
  startedAt?: number
  endedAt?: number
  durationMs?: number
}

export interface UserMessage {
  id: string
  role: 'user'
  content: string
  attachments?: AttachmentRef[]
  turn_id?: string
  source?: string
  scheduler?: SchedulerMessageMeta
  local?: boolean
}

export interface AssistantMessage {
  id: string
  role: 'assistant'
  content: string
  segments: AssistantSegment[]
  todos?: TodoItem[] | null
  streaming: boolean
  turn_id?: string
  local?: boolean
  startedAt?: number
  endedAt?: number
  durationMs?: number
}

export type ChatMessage = UserMessage | AssistantMessage

export interface PendingState {
  label: string
  detail: string
  tone?: 'running' | 'done' | 'error'
}

export type RuntimeStatus = 'connecting' | 'ready' | 'error'

export type TeamStatus =
  'idle' | 'working' | 'offline' | 'shutdown' | 'error' | string

export interface TeamMessage {
  id: string
  type: 'message' | 'task' | 'result' | 'status' | 'error' | string
  from: string
  to: string
  content: string
  timestamp: number
  task_id?: string | null
  in_reply_to?: string | null
  meta?: Record<string, unknown>
}

export interface TeamMember {
  name: string
  role: string
  agent_type: string
  status: TeamStatus
  created_at?: number
  updated_at?: number
  last_error?: string | null
  unread?: number
  recent_messages?: TeamMessage[]
  thread_count?: number
  tools?: string[]
}

export interface TeamPayload {
  config?: {
    version?: number
    team_name?: string
    members?: TeamMember[]
  }
  members: TeamMember[]
  leadUnread?: number
  leadInbox?: TeamMessage[]
}

export interface TeamMemberPayload {
  member: TeamMember
  inbox: TeamMessage[]
  leadInbox: TeamMessage[]
  thread: Array<{ role?: string; content?: string }>
}

export type SchedulerScheduleKind = 'at' | 'every' | 'cron' | string
export type SchedulerPayloadKind =
  'agent_turn' | 'team_wake' | 'system_event' | string
export type SchedulerRunStatus = 'ok' | 'error' | 'skipped' | string

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
  runAtMs: number
  status: SchedulerRunStatus
  durationMs?: number
  error?: string | null
}

export interface SchedulerJobState {
  nextRunAtMs?: number | null
  lastRunAtMs?: number | null
  lastStatus?: SchedulerRunStatus | null
  lastError?: string | null
  runHistory?: SchedulerRunRecord[]
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
  protected?: boolean
  purpose?: string | null
}

export interface SchedulerMessageMeta {
  jobId?: string
  jobName?: string
}

export interface SchedulerStatusPayload {
  running: boolean
  jobs: number
  enabled: number
  nextRunAtMs?: number | null
  lastError?: string | null
}

export interface SchedulerPayload {
  status: SchedulerStatusPayload
  jobs: SchedulerJob[]
  diagnostics?: Record<string, unknown>
}

export type WsEvent = CoreRuntimeEvent &
  ({
    seq?: number
    ts?: number
    session_id?: string
    turn_id?: string
    client_message_id?: string
    owner?: Record<string, unknown>
  } & WsEventVariants)

interface HookRuntimeEventFields {
  hook_id?: string
  hook_run_id?: string
  event_name?: string
  group_id?: string
  handler_id?: string
  handler_type?: string
  snapshot_revision?: string
  hook_source?: Record<string, unknown> | null
  status?: string
  decision?: string
  reason?: string
  duration_ms?: number
}

interface EnvironmentRuntimeEventFields {
  job_id?: string
  tool_id?: string | null
  step_id?: string | null
  status?: string
  completed_steps?: number
  total_steps?: number
  error_code?: string | null
  catalog_revision?: string
  project_fingerprint?: string
}

type WsEventVariants =
  | {
      event: 'ready'
      model?: string
      provider?: string
      latest_seq?: number
      replay_count?: number
      resume_from?: number
      busy?: boolean
      control?: ControlPayload
    }
  | {
      event: 'user_message'
      content?: string
      attachments?: AttachmentRef[]
      source?: string
      scheduler?: SchedulerMessageMeta
      ui_hidden?: boolean
    }
  | { event: 'message_delta'; delta?: string }
  | {
      event: 'agent_thought'
      stage?: string
      label?: string
      summary?: string
      source?: string
      status?: 'done' | 'running' | string
      tool_call_ids?: string[]
      tool_names?: string[]
    }
  | {
      event: 'context_usage'
      used?: number
      max?: number
      threshold?: number
      usage_type?: string
      model_role?: string
      model?: string
      provider?: string
      route_reason?: string
      estimated_input_tokens?: number
      used_fallback?: boolean
      fallback_reason?: string
      provider_retry_count?: number
      provider_error_kind?: string
      replaced_tool_results?: number
      aggregate_replaced_tool_results?: number
      aggregate_tool_result_budget?: number
    }
  | {
      event: 'context_projection'
      report?: Record<string, unknown>
      message_count?: number
    }
  | {
      event: 'model_provider_retry'
      model?: string
      provider?: string | null
      usage_type?: string
      attempt?: number
      max_retries?: number
      error_kind?: string
      reason?: string
    }
  | {
      event: 'model_route_fallback'
      from_model?: string
      to_model?: string
      reason?: string
      usage_type?: string
    }
  | {
      event: 'session_created'
      session?: SessionInfo
      client_draft_id?: string
    }
  | { event: 'session_title_updated'; session?: SessionInfo }
  | { event: 'external_inbound'; message?: Record<string, unknown> }
  | {
      event: 'external_queued'
      message?: Record<string, unknown>
      reason?: string
    }
  | { event: 'external_outbound_queued'; message?: Record<string, unknown> }
  | {
      event: 'external_outbound_sent'
      message?: Record<string, unknown>
      delivery?: Record<string, unknown>
    }
  | {
      event: 'external_outbound_error'
      message?: Record<string, unknown>
      error?: string
    }
  | {
      event: 'tool_call'
      id?: string
      name: string
      arguments?: Record<string, unknown>
    }
  | {
      event: 'tool_result'
      id?: string
      name?: string
      summary?: string
      output?: string
      output_truncated?: boolean
      artifacts?: ToolArtifactRef[]
      metadata?: Record<string, unknown>
      todos?: TodoItem[]
      is_error?: boolean
    }
  | { event: 'tool_error'; id?: string; name?: string; message?: string }
  | {
      event: 'tool_run_queued'
      id?: string
      name: string
      arguments?: Record<string, unknown>
    }
  | { event: 'tool_run_started'; id?: string; name: string }
  | {
      event: 'tool_run_completed'
      id?: string
      name: string
      summary?: string
      output?: string
      output_truncated?: boolean
      artifacts?: ToolArtifactRef[]
      metadata?: Record<string, unknown>
    }
  | {
      event: 'tool_run_failed'
      id?: string
      name: string
      message?: string
      reason_kind?: 'safety_refusal' | 'error' | string
    }
  | { event: 'tool_run_cancelled'; id?: string; name: string; reason?: string }
  | (HookRuntimeEventFields & { event: 'hook_run_started' })
  | (HookRuntimeEventFields & {
      event: 'hook_run_progress'
      message?: string | null
    })
  | (HookRuntimeEventFields & { event: 'hook_run_completed' })
  | (HookRuntimeEventFields & { event: 'hook_run_failed' })
  | (HookRuntimeEventFields & {
      event: 'hook_decision_applied'
      hook_ids?: string[]
      hook_run_ids?: string[]
    })
  | (EnvironmentRuntimeEventFields & {
      event: 'environment_install_started'
    })
  | (EnvironmentRuntimeEventFields & {
      event: 'environment_install_progress'
    })
  | (EnvironmentRuntimeEventFields & {
      event: 'environment_install_completed'
    })
  | (EnvironmentRuntimeEventFields & {
      event: 'environment_install_failed'
    })
  | (EnvironmentRuntimeEventFields & { event: 'environment_changed' })
  | {
      event: 'turn_phase'
      phase?: string
      sequence?: number
      iteration?: number
      detail?: Record<string, unknown>
    }
  | {
      event: 'turn_scope'
      mode?: string
      workspace_root?: string
      state_root?: string
      session_root?: string
      project_id?: string | null
      project_state_root?: string | null
      active_memory_binding?: Record<string, unknown>
    }
  | { event: 'assistant_done'; content?: string }
  | {
      event: 'error'
      message?: string
      code?: string
      action?: string
      partial?: boolean
    }
  | { event: 'control_mode_update'; control?: ControlPayload }
  | { event: 'ask_request'; interaction?: ControlInteraction }
  | { event: 'ask_answered'; interaction?: ControlInteraction }
  | { event: 'plan_draft'; interaction?: ControlInteraction }
  | {
      event: 'plan_draft_delta'
      tool_call_id?: string
      interaction?: ControlInteraction
    }
  | {
      event: 'plan_comment_added'
      interaction?: ControlInteraction
      comment?: string
    }
  | {
      event: 'plan_approved'
      interaction?: ControlInteraction
      control?: ControlPayload
      plan?: RuntimePlanRecord
      todos?: TodoItem[]
    }
  | {
      event: 'plan_entry_decision'
      decision?: string
      reason?: string
      triggers?: string[]
      suggested_questions?: string[]
      recommended_readonly_scopes?: string[]
    }
  | { event: 'plan_runtime_update'; plan?: RuntimePlanRecord }
  | { event: 'plan_step_update'; plan_id?: string; step?: RuntimePlanStep }
  | {
      event: 'plan_verification_start'
      plan_id?: string
      step_id?: string
      command?: string
    }
  | {
      event: 'plan_verification_done'
      plan_id?: string
      step_id?: string
      result?: Record<string, unknown>
    }
  | { event: 'task_started'; task?: RuntimeTaskRecord }
  | {
      event: 'task_progress'
      task?: RuntimeTaskRecord
      progress?: Record<string, unknown>
    }
  | {
      event: 'task_output'
      task?: RuntimeTaskRecord
      offset?: number
      chunk?: string
    }
  | { event: 'task_done'; task?: RuntimeTaskRecord }
  | { event: 'task_error'; task?: RuntimeTaskRecord; error?: string }
  | { event: 'task_cancelled'; task?: RuntimeTaskRecord; reason?: string }
  | {
      event: 'interaction_cancelled'
      interaction?: ControlInteraction
      control?: ControlPayload
    }
  | { event: 'turn_paused'; interaction?: ControlInteraction }
  | {
      event: 'subagent_start'
      parent_id?: string
      subagent_id?: string
      agent_type?: string
      purpose?: string
    }
  | {
      event: 'subagent_delta'
      parent_id?: string
      subagent_id?: string
      agent_type?: string
      delta?: string
    }
  | {
      event: 'subagent_tool_call'
      parent_id?: string
      subagent_id?: string
      id?: string
      name: string
      arguments?: Record<string, unknown>
    }
  | {
      event: 'subagent_tool_result'
      parent_id?: string
      subagent_id?: string
      id?: string
      name?: string
      summary?: string
    }
  | {
      event: 'subagent_tool_error'
      parent_id?: string
      subagent_id?: string
      id?: string
      name?: string
      message?: string
    }
  | {
      event: 'subagent_done'
      parent_id?: string
      subagent_id?: string
      agent_type?: string
      summary?: string
    }
  | {
      event: 'subagent_error'
      parent_id?: string
      subagent_id?: string
      agent_type?: string
      message?: string
    }
  | { event: 'team_member_update'; member?: TeamMember }
  | { event: 'team_message'; message?: TeamMessage }
  | {
      event: 'team_run_start'
      parent_id?: string
      teammate?: string
      role?: string
      agent_type?: string
      purpose?: string
    }
  | {
      event: 'team_run_delta'
      parent_id?: string
      teammate?: string
      delta?: string
    }
  | {
      event: 'team_run_tool_call'
      parent_id?: string
      teammate?: string
      id?: string
      name: string
      arguments?: Record<string, unknown>
    }
  | {
      event: 'team_run_tool_result'
      parent_id?: string
      teammate?: string
      id?: string
      name?: string
      summary?: string
    }
  | {
      event: 'team_run_tool_error'
      parent_id?: string
      teammate?: string
      id?: string
      name?: string
      message?: string
    }
  | {
      event: 'team_run_done'
      parent_id?: string
      teammate?: string
      summary?: string
    }
  | {
      event: 'team_run_error'
      parent_id?: string
      teammate?: string
      message?: string
    }
  | { event: 'scheduler_job_update'; job?: SchedulerJob; action?: string }
  | { event: 'scheduler_run_start'; job?: SchedulerJob }
  | { event: 'scheduler_run_done'; job?: SchedulerJob }
  | { event: 'scheduler_run_error'; job?: SchedulerJob; error?: string }
  | { event: 'scheduler_run_cancelled'; job?: SchedulerJob; reason?: string }
  | { event: 'task_started'; task?: RuntimeTaskRecord }
  | {
      event: 'task_progress'
      task?: RuntimeTaskRecord
      progress?: Record<string, unknown>
    }
  | {
      event: 'task_output'
      task?: RuntimeTaskRecord
      offset?: number
      chunk?: string
    }
  | { event: 'task_done'; task?: RuntimeTaskRecord }
  | { event: 'task_error'; task?: RuntimeTaskRecord; error?: string }
  | { event: 'task_cancelled'; task?: RuntimeTaskRecord; reason?: string }
  | {
      event: 'runtime_task_cancelled'
      task?: {
        id?: string
        kind?: string
        label?: string
        turnId?: string
        jobId?: string
      }
      reason?: string
    }
  | {
      event: 'record_degraded'
      kind?: string
      reason?: string
      taskId?: string
    }

// INV-005 绊线：desktop 手抄的事件 union 与 core RuntimeEvent 的事件名必须保持一一对应。
// 任一侧新增/改名事件而另一侧未同步时，这两行在编译期直接报错（此前漂移是静默的）。
type _WsEventName = WsEventVariants['event']
type _CoreEventName = CoreRuntimeEvent['event']
type _AssertDesktopSubset = [_WsEventName] extends [_CoreEventName]
  ? true
  : ['desktop 声明了 core 不存在的事件', Exclude<_WsEventName, _CoreEventName>]
type _AssertCoreCovered = [_CoreEventName] extends [_WsEventName]
  ? true
  : ['core 事件未在 desktop union 声明', Exclude<_CoreEventName, _WsEventName>]
export const WS_EVENT_NAME_PARITY: _AssertDesktopSubset extends true
  ? _AssertCoreCovered extends true
    ? true
    : _AssertCoreCovered
  : _AssertDesktopSubset = true

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

export interface SidebarState {
  section_order: Array<'projects' | 'chats'>
  project_sort: SidebarSortMode
  chat_sort: SidebarSortMode
  project_order: string[]
  chat_order: string[]
  project_session_order: Record<string, string[]>
  collapsed_project_ids: string[]
}
