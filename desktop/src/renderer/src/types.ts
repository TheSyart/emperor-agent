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
  tool_overrides?: Record<string, { read_only?: boolean; exclusive?: boolean }>
}

export interface McpConfigPayload {
  servers: Record<string, McpServerConfig>
  defaults?: {
    read_only?: boolean
    exclusive?: boolean
  }
}

export interface SkillInfo {
  name: string
  description?: string
  path: string
  tags?: string
  always?: boolean
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
  project_name: string
  summary?: string
  agents_path?: string
  created_at?: string
  updated_at?: string
  version?: number
}

export interface MemoryContextPayload {
  mode?: SessionMode | string
  session?: SessionInfo | null
  sources?: string[]
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
  schedulerMaintenance?: SchedulerMaintenanceStats
  watchlist?: WatchlistPayload
  versions?: MemoryVersionsPayload
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

export type ProviderRegion = 'foreign' | 'aggregator' | 'cloud' | 'cn' | 'local' | 'other'

export interface ProviderOption {
  name: string
  displayName?: string
  display_name?: string
  backend?: string
  defaultApiBase?: string
  region?: ProviderRegion
  isGateway?: boolean
  isLocal?: boolean
  isOauth?: boolean
  isDirect?: boolean
  thinkingStyle?: string | null
}

export interface ModelEntry {
  name: string                     // 唯一 key（agents.defaults.model 引用）
  id?: string                      // 兼容旧字段，等价于 mainModelId
  mainModelId?: string             // 主模型 id：复杂任务 / 主 Agent
  secondaryModelId?: string        // 次模型 id：简单任务 / 内部任务
  provider: string                 // registry name
  apiKey?: string | null           // "***last4" 占位 / 空 / 真值
  apiBase?: string | null
  extraHeaders?: Record<string, unknown> | null
  extraBody?: Record<string, unknown> | null
  maxTokens?: number | null
  temperature?: number | null
  contextWindowTokens?: number | null
  reasoningEffort?: string | null
  label?: string
  supportsVision?: boolean         // 仅由"测试视觉"成功时自动 true；UI 用 👁 徽章渲染
}

export interface AttachmentRef {
  id: string                       // "att_2026-05_abc12345"
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
  visionMarked?: boolean           // 视觉测试通过且后端已持久化 supportsVision
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

export interface ModelConfigPayload {
  current?: CurrentModelConfig
  secondary?: CurrentModelConfig | null
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

export interface DiagnosticsPayload {
  modelConfig?: Record<string, unknown>
  localConfig?: Record<string, unknown>
  scheduler?: Record<string, unknown>
  runtime?: RuntimeStats
  external?: Record<string, unknown>
  desktopPet?: DesktopPetPayload & Record<string, unknown>
  dependencies?: Record<string, unknown>
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
  status: 'compacted' | 'skipped'
  count: number
  message: string
  memory: MemoryPayload
  unarchivedHistory: RuntimeHistoryItem[]
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
  latestSeq: number
  scope: 'unarchived' | string
  events: RuntimeEventEnvelope[]
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

export type ToolStatus = 'running' | 'done' | 'error' | 'error_aborted'

export interface ToolArtifactRef {
  path: string
  kind?: string
  bytes?: number
  metadata?: Record<string, unknown>
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

export type ControlMode = 'ask_before_edit' | 'auto' | 'plan' | string
export type InteractionKind = 'ask' | 'plan' | string
export type InteractionStatus = 'waiting' | 'answered' | 'commented' | 'approved' | 'cancelled' | string

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
  previous_mode?: 'ask_before_edit' | 'auto' | null
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

export type AssistantSegment = TextSegment | ThoughtSegment | ToolSegment | AskSegment | PlanSegment

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
}

export type ChatMessage = UserMessage | AssistantMessage

export interface PendingState {
  label: string
  detail: string
  tone?: 'running' | 'done' | 'error'
}

export type RuntimeStatus = 'connecting' | 'ready' | 'error'

export type TeamStatus = 'idle' | 'working' | 'offline' | 'shutdown' | 'error' | string

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
export type SchedulerPayloadKind = 'agent_turn' | 'team_wake' | 'system_event' | string
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

export type WsEvent = ({ seq?: number; ts?: number; turn_id?: string; client_message_id?: string } & (
  | { event: 'ready'; model?: string; provider?: string; latest_seq?: number; replay_count?: number; resume_from?: number; busy?: boolean; control?: ControlPayload }
  | { event: 'user_message'; content?: string; attachments?: AttachmentRef[]; source?: string; scheduler?: SchedulerMessageMeta }
  | { event: 'message_delta'; delta?: string }
  | { event: 'context_usage'; used?: number; max?: number; threshold?: number; usage_type?: string; model_role?: string; model?: string; provider?: string; route_reason?: string; estimated_input_tokens?: number }
  | { event: 'context_projection'; report?: Record<string, unknown>; message_count?: number }
  | { event: 'model_route_fallback'; from_model?: string; to_model?: string; reason?: string; usage_type?: string }
  | { event: 'session_created'; session?: SessionInfo; client_draft_id?: string }
  | { event: 'session_title_updated'; session?: SessionInfo }
  | { event: 'external_inbound'; message?: Record<string, unknown> }
  | { event: 'external_queued'; message?: Record<string, unknown>; reason?: string }
  | { event: 'external_outbound_queued'; message?: Record<string, unknown> }
  | { event: 'external_outbound_sent'; message?: Record<string, unknown>; delivery?: Record<string, unknown> }
  | { event: 'external_outbound_error'; message?: Record<string, unknown>; error?: string }
  | { event: 'tool_call'; id?: string; name: string; arguments?: Record<string, unknown> }
  | { event: 'tool_result'; id?: string; name?: string; summary?: string; artifacts?: ToolArtifactRef[]; metadata?: Record<string, unknown>; todos?: TodoItem[] }
  | { event: 'tool_error'; id?: string; name?: string; message?: string }
  | { event: 'tool_run_queued'; id?: string; name: string; arguments?: Record<string, unknown> }
  | { event: 'tool_run_started'; id?: string; name: string }
  | { event: 'tool_run_completed'; id?: string; name: string; summary?: string; artifacts?: ToolArtifactRef[]; metadata?: Record<string, unknown> }
  | { event: 'tool_run_failed'; id?: string; name: string; message?: string }
  | { event: 'tool_run_cancelled'; id?: string; name: string; reason?: string }
  | { event: 'turn_phase'; phase?: string; sequence?: number; iteration?: number; detail?: Record<string, unknown> }
  | { event: 'assistant_done'; content?: string }
  | { event: 'error'; message?: string; partial?: boolean }
  | { event: 'control_mode_update'; control?: ControlPayload }
  | { event: 'ask_request'; interaction?: ControlInteraction }
  | { event: 'ask_answered'; interaction?: ControlInteraction }
  | { event: 'plan_draft'; interaction?: ControlInteraction }
  | { event: 'plan_comment_added'; interaction?: ControlInteraction; comment?: string }
  | { event: 'plan_approved'; interaction?: ControlInteraction; control?: ControlPayload; plan?: RuntimePlanRecord; todos?: TodoItem[] }
  | { event: 'plan_entry_decision'; decision?: string; reason?: string; triggers?: string[]; suggested_questions?: string[]; recommended_readonly_scopes?: string[] }
  | { event: 'plan_runtime_update'; plan?: RuntimePlanRecord }
  | { event: 'plan_step_update'; plan_id?: string; step?: RuntimePlanStep }
  | { event: 'plan_verification_start'; plan_id?: string; step_id?: string; command?: string }
  | { event: 'plan_verification_done'; plan_id?: string; step_id?: string; result?: Record<string, unknown> }
  | { event: 'task_started'; task?: RuntimeTaskRecord }
  | { event: 'task_progress'; task?: RuntimeTaskRecord; progress?: Record<string, unknown> }
  | { event: 'task_output'; task?: RuntimeTaskRecord; offset?: number; chunk?: string }
  | { event: 'task_done'; task?: RuntimeTaskRecord }
  | { event: 'task_error'; task?: RuntimeTaskRecord; error?: string }
  | { event: 'task_cancelled'; task?: RuntimeTaskRecord; reason?: string }
  | { event: 'interaction_cancelled'; interaction?: ControlInteraction; control?: ControlPayload }
  | { event: 'turn_paused'; interaction?: ControlInteraction }
  | { event: 'subagent_start'; parent_id?: string; subagent_id?: string; agent_type?: string; purpose?: string }
  | { event: 'subagent_delta'; parent_id?: string; subagent_id?: string; agent_type?: string; delta?: string }
  | { event: 'subagent_tool_call'; parent_id?: string; subagent_id?: string; id?: string; name: string; arguments?: Record<string, unknown> }
  | { event: 'subagent_tool_result'; parent_id?: string; subagent_id?: string; id?: string; name?: string; summary?: string }
  | { event: 'subagent_tool_error'; parent_id?: string; subagent_id?: string; id?: string; name?: string; message?: string }
  | { event: 'subagent_done'; parent_id?: string; subagent_id?: string; agent_type?: string; summary?: string }
  | { event: 'subagent_error'; parent_id?: string; subagent_id?: string; agent_type?: string; message?: string }
  | { event: 'team_member_update'; member?: TeamMember }
  | { event: 'team_message'; message?: TeamMessage }
  | { event: 'team_run_start'; parent_id?: string; teammate?: string; role?: string; agent_type?: string; purpose?: string }
  | { event: 'team_run_delta'; parent_id?: string; teammate?: string; delta?: string }
  | { event: 'team_run_tool_call'; parent_id?: string; teammate?: string; id?: string; name: string; arguments?: Record<string, unknown> }
  | { event: 'team_run_tool_result'; parent_id?: string; teammate?: string; id?: string; name?: string; summary?: string }
  | { event: 'team_run_tool_error'; parent_id?: string; teammate?: string; id?: string; name?: string; message?: string }
  | { event: 'team_run_done'; parent_id?: string; teammate?: string; summary?: string }
  | { event: 'team_run_error'; parent_id?: string; teammate?: string; message?: string }
  | { event: 'scheduler_job_update'; job?: SchedulerJob; action?: string }
  | { event: 'scheduler_run_start'; job?: SchedulerJob }
  | { event: 'scheduler_run_done'; job?: SchedulerJob }
  | { event: 'scheduler_run_error'; job?: SchedulerJob; error?: string }
  | { event: 'scheduler_run_cancelled'; job?: SchedulerJob; reason?: string }
  | { event: 'task_started'; task?: RuntimeTaskRecord }
  | { event: 'task_progress'; task?: RuntimeTaskRecord; progress?: Record<string, unknown> }
  | { event: 'task_output'; task?: RuntimeTaskRecord; offset?: number; chunk?: string }
  | { event: 'task_done'; task?: RuntimeTaskRecord }
  | { event: 'task_error'; task?: RuntimeTaskRecord; error?: string }
  | { event: 'task_cancelled'; task?: RuntimeTaskRecord; reason?: string }
  | { event: 'runtime_task_cancelled'; task?: { id?: string; kind?: string; label?: string; turnId?: string; jobId?: string }; reason?: string }
))

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
  version: number
  draft?: boolean
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
