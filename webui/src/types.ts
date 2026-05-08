export interface ToolInfo {
  name: string
  description: string
  parameters?: Record<string, unknown>
  read_only?: boolean
  exclusive?: boolean
  concurrency_safe?: boolean
}

export interface SkillInfo {
  name: string
  description?: string
  path: string
  tags?: string
  always?: boolean
}

export interface TokenStatsRow {
  input?: number
  output?: number
  cache_read?: number
  cache_create?: number
  total?: number
  calls?: number
  [key: string]: number | undefined
}

export interface TokenTotals extends TokenStatsRow {
  total?: number
  calls?: number
}

export interface MemoryPayload {
  long_term?: string
  today_episode?: string
  episodes?: string[]
  tokens?: Record<string, TokenStatsRow>
  tokensByModel?: Record<string, TokenStatsRow>
  tokensByUsageType?: Record<string, TokenStatsRow>
  tokenTotals?: TokenTotals
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
  generatedAt: string
}

export type TokensRange = 'all' | '30d' | '7d'
export type TokensTab = 'overview' | 'models'

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
  id: string                       // 真实 model id（发给 API）
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

export interface ModelTestResult {
  ok: boolean
  kind: 'text' | 'vision'
  latencyMs?: number
  model?: string
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
}

export interface ModelConfigPayload {
  current?: CurrentModelConfig
  config?: ModelConfigRaw
  providerOptions?: ProviderOption[]
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
}

export type ToolStatus = 'running' | 'done' | 'error' | 'error_aborted'

export interface TodoItem {
  id: string | number
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
}

export interface TextSegment {
  id: string
  type: 'text'
  content: string
}

export interface ToolSegment {
  id: string
  type: 'tool'
  toolId?: string
  name: string
  arguments?: Record<string, unknown>
  status: ToolStatus
  summary?: string
  subagents?: SubagentState[]
}

export type AssistantSegment = TextSegment | ToolSegment

export interface SubagentToolState {
  id?: string
  name: string
  arguments?: Record<string, unknown>
  status: ToolStatus
  summary?: string
}

export interface SubagentState {
  id?: string
  agent_type?: string
  purpose?: string
  status: ToolStatus
  content?: string
  summary?: string
  error?: string
  tools?: SubagentToolState[]
}

export interface UserMessage {
  id: string
  role: 'user'
  content: string
  attachments?: AttachmentRef[]
  local?: boolean
}

export interface AssistantMessage {
  id: string
  role: 'assistant'
  content: string
  segments: AssistantSegment[]
  todos?: TodoItem[] | null
  streaming: boolean
  local?: boolean
}

export type ChatMessage = UserMessage | AssistantMessage

export interface PendingState {
  label: string
  detail: string
}

export type RuntimeStatus = 'connecting' | 'ready' | 'error'

export type WsEvent = ({ seq?: number } & (
  | { event: 'ready'; model?: string; provider?: string; latest_seq?: number; replay_count?: number; resume_from?: number; busy?: boolean }
  | { event: 'message_delta'; delta?: string }
  | { event: 'context_usage'; used?: number; max?: number; threshold?: number; usage_type?: string }
  | { event: 'tool_call'; id?: string; name: string; arguments?: Record<string, unknown> }
  | { event: 'tool_result'; id?: string; name?: string; summary?: string; todos?: TodoItem[] }
  | { event: 'tool_error'; id?: string; name?: string; message?: string }
  | { event: 'assistant_done'; content?: string }
  | { event: 'error'; message?: string; partial?: boolean }
  | { event: 'subagent_start'; parent_id?: string; subagent_id?: string; agent_type?: string; purpose?: string }
  | { event: 'subagent_delta'; parent_id?: string; subagent_id?: string; agent_type?: string; delta?: string }
  | { event: 'subagent_tool_call'; parent_id?: string; subagent_id?: string; id?: string; name: string; arguments?: Record<string, unknown> }
  | { event: 'subagent_tool_result'; parent_id?: string; subagent_id?: string; id?: string; name?: string; summary?: string }
  | { event: 'subagent_tool_error'; parent_id?: string; subagent_id?: string; id?: string; name?: string; message?: string }
  | { event: 'subagent_done'; parent_id?: string; subagent_id?: string; agent_type?: string; summary?: string }
  | { event: 'subagent_error'; parent_id?: string; subagent_id?: string; agent_type?: string; message?: string }
))
