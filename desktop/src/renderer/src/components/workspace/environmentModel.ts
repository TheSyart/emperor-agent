// Pure environment-card model: subagent grouping and status tones, the
// deterministic avatar color, the 比较分支 compare link, the 后台任务
// summary and its expanded job / workflow lines, and the task output text.
// Consumed by conversation/environment/EnvironmentCard.vue and
// TaskOutputDialog.vue.

import { formatClock } from '../conversation/chatFormat'
import { formatElapsed } from '../ui/elapsed'

export interface EnvironmentSubagentGroups<T extends object> {
  active: T[]
  recent: T[]
  /** Every agent, active first, then terminal ones most recent first. */
  ordered: T[]
  completedCount: number
  failedCount: number
  hiddenCount: number
}

const ACTIVE_STATUSES = new Set(['running', 'queued', 'pending'])
const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled', 'interrupted'])

/** Subagent 状态点色调(对齐 Codex 右栏彩点):运行脉冲/排队高亮/完成绿/失败红/取消灰 */
export function subagentStatusTone(value: unknown): string {
  const status =
    value && typeof value === 'object' && !Array.isArray(value)
      ? String((value as Record<string, unknown>)['status'] ?? '')
      : ''
  if (status === 'running') return 'running'
  if (status === 'queued' || status === 'pending') return 'pending'
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'cancelled' || status === 'interrupted') return 'cancelled'
  return 'unknown'
}

export function environmentSubagentGroups<T extends object>(
  agents: T[],
): EnvironmentSubagentGroups<T> {
  const active = agents.filter((agent) =>
    ACTIVE_STATUSES.has(String(field(agent, 'status') ?? '')),
  )
  const terminal = agents
    .filter((agent) => !active.includes(agent))
    .sort(
      (left, right) =>
        terminalTimestamp(right) - terminalTimestamp(left) ||
        String(field(right, 'id') ?? '').localeCompare(
          String(field(left, 'id') ?? ''),
        ),
    )
  const completedCount = terminal.filter(
    (agent) => String(field(agent, 'status') ?? '') === 'completed',
  ).length
  const failedCount = terminal.filter((agent) =>
    FAILED_STATUSES.has(String(field(agent, 'status') ?? '')),
  ).length
  const recent = terminal.slice(0, 3)
  return {
    active,
    recent,
    ordered: [...active, ...terminal],
    completedCount,
    failedCount,
    hiddenCount: Math.max(0, terminal.length - recent.length),
  }
}

/**
 * Card status of a `tasks.list` subagent record. The kernel reports
 * `running` / `idle` plus the last stop reason; older records may carry a
 * terminal status directly.
 */
export function subagentTaskStatus(task: {
  status: string
  last_stop_reason?: string | null
}): 'running' | 'pending' | 'completed' | 'failed' | 'cancelled' {
  const status = task.status
  if (status === 'running') return 'running'
  if (status === 'queued' || status === 'pending') return 'pending'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'cancelled' || status === 'killed') return 'cancelled'
  if (status === 'completed') return 'completed'
  switch (task.last_stop_reason) {
    case 'error':
    case 'refusal':
    case 'max-tokens':
      return 'failed'
    case 'aborted':
    case 'interrupted':
      return 'cancelled'
    default:
      return 'completed'
  }
}

export const SUBAGENT_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  pending: '等待中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
}

/** Number of `--avatar-*` theme tokens. */
export const AVATAR_COLORS = 6

/** Deterministic avatar slot (0-based) for an id: FNV-1a 32-bit hash. */
export function avatarIndex(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % AVATAR_COLORS
}

/** The avatar color token of an id (`--avatar-1` … `--avatar-6`). */
export function avatarToken(id: string): string {
  return `--avatar-${avatarIndex(id) + 1}`
}

export interface RemoteInfo {
  name: string | null
  webUrl: string | null
  provider: 'github' | 'gitlab' | 'other' | null
}

export type CompareLink = { url: string } | { url: null; reason: string }

function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/')
}

/**
 * 比较分支 link: the provider compare page of `head` against `base`
 * (GitHub `/compare/base...head`, GitLab `/-/compare/base...head`), or the
 * reason it is unavailable.
 */
export function compareBranchLink(input: {
  remote: RemoteInfo | null
  base: string | null
  head: string | null
}): CompareLink {
  const { remote, head } = input
  const base = input.base || 'main'
  if (!remote?.name || !remote.webUrl)
    return { url: null, reason: '没有 origin 远端' }
  if (remote.provider !== 'github' && remote.provider !== 'gitlab')
    return { url: null, reason: '远端不是 GitHub / GitLab' }
  if (!head) return { url: null, reason: '当前不在分支上' }
  if (head === base) return { url: null, reason: `当前就是 ${base}` }
  const root = remote.webUrl.replace(/\/+$/u, '')
  const range = `${refPath(base)}...${refPath(head)}`
  return {
    url:
      remote.provider === 'github'
        ? `${root}/compare/${range}`
        : `${root}/-/compare/${range}`,
  }
}

export interface BackgroundTaskSummary {
  running: number
  total: number
  labels: string[]
}

function isBackgroundTask(task: { kind: string }): boolean {
  return task.kind === 'job' || task.kind === 'workflow'
}

/** Still live: running, or a job asked to stop that has not settled yet. */
export function isLiveTaskStatus(status: string): boolean {
  return status === 'running' || status === 'stopping'
}

/** 后台任务 row: background jobs and workflow runs of the session. */
export function backgroundTaskSummary(
  tasks: readonly { kind: string; status: string; label: string }[],
): BackgroundTaskSummary {
  const background = tasks.filter(isBackgroundTask)
  return {
    running: background.filter((task) => isLiveTaskStatus(task.status)).length,
    total: background.length,
    labels: background.map((task) => task.label).filter(Boolean),
  }
}

/** A `tasks.list` record as far as the 后台任务 lines read it. */
export interface BackgroundTaskInput {
  id: string
  kind: string
  status: string
  label: string
  description?: string
  job_kind?: string
  exit_code?: number | null
  detail?: string | null
  workflow_tool?: string
  rounds?: number
  started_at: number
  finished_at: number | null
}

/** Dot tone of a job (`running` / `stopping` / `completed` / `killed` /
 * `failed`) or workflow run (`running` / `completed` / `cancelled` /
 * `error` / `interrupted`). */
export type BackgroundTaskTone =
  'running' | 'pending' | 'completed' | 'failed' | 'cancelled'

export function backgroundTaskTone(status: string): BackgroundTaskTone {
  switch (status) {
    case 'running':
      return 'running'
    case 'stopping':
      return 'pending'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    default:
      return 'cancelled'
  }
}

const BACKGROUND_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  stopping: '正在停止',
  completed: '已完成',
  failed: '失败',
  error: '失败',
  killed: '已停止',
  cancelled: '已停止',
  interrupted: '已中断',
}

export function backgroundStatusLabel(status: string): string {
  return BACKGROUND_STATUS_LABEL[status] ?? status
}

/**
 * Short detail of a line: a workflow run's progress (Ralph 「第 n 轮」, a
 * workflow's started agents), a settled job's exit code, else its kind.
 */
export function backgroundTaskDetail(task: BackgroundTaskInput): string {
  if (task.kind === 'workflow') {
    const rounds = Math.max(0, Math.floor(Number(task.rounds ?? 0)) || 0)
    if (task.workflow_tool === 'ralph')
      return rounds ? `第 ${rounds} 轮` : 'Ralph'
    return rounds ? `${rounds} 个代理` : '工作流'
  }
  if (!isLiveTaskStatus(task.status) && typeof task.exit_code === 'number')
    return `退出码 ${task.exit_code}`
  return task.job_kind || '命令'
}

/** Elapsed time while live (`1m 05s`), else when it finished (`14:05`). */
export function backgroundTaskTime(
  task: Pick<BackgroundTaskInput, 'status' | 'started_at' | 'finished_at'>,
  now: number = Date.now(),
): string {
  if (isLiveTaskStatus(task.status))
    return task.started_at ? formatElapsed(now - task.started_at) : ''
  return task.finished_at ? formatClock(task.finished_at, now) : ''
}

export interface BackgroundTaskLine {
  id: string
  kind: 'job' | 'workflow'
  label: string
  /** Raw kernel status. */
  status: string
  tone: BackgroundTaskTone
  statusLabel: string
  detail: string
  /** Running: 「停止」 applies (`tasks.cancel`). */
  stoppable: boolean
  /** Workflow runs may be midway through subagents: stopping asks first. */
  confirmStop: boolean
  live: boolean
  startedAt: number
  finishedAt: number | null
  /** Failure detail (`exit code: 3`, the workflow error), for the tooltip. */
  error: string
}

/** 后台任务 lines: live runs first, then settled ones most recent first. */
export function backgroundTaskLines(
  tasks: readonly BackgroundTaskInput[],
): BackgroundTaskLine[] {
  const lines = tasks
    .filter(isBackgroundTask)
    .map((task): BackgroundTaskLine => ({
      id: task.id,
      kind: task.kind === 'workflow' ? 'workflow' : 'job',
      label: task.label || task.description || task.id,
      status: task.status,
      tone: backgroundTaskTone(task.status),
      statusLabel: backgroundStatusLabel(task.status),
      detail: backgroundTaskDetail(task),
      stoppable: task.status === 'running',
      confirmStop: task.kind === 'workflow',
      live: isLiveTaskStatus(task.status),
      startedAt: task.started_at,
      finishedAt: task.finished_at,
      error: task.detail ?? '',
    }))
  const recency = (line: BackgroundTaskLine) =>
    line.live ? line.startedAt : (line.finishedAt ?? line.startedAt)
  return lines.sort(
    (left, right) =>
      Number(right.live) - Number(left.live) || recency(right) - recency(left),
  )
}

/** `tasks.transcript` entry: job output, or a workflow run's record. */
export interface TaskTranscriptEntry {
  role: string
  content: string
}

const TRANSCRIPT_ROLE_LABEL: Record<string, string> = {
  workflow: '工作流',
  phase: '阶段',
  log: '日志',
  agent: '代理',
  result: '结果',
  error: '错误',
  user: '用户',
  assistant: '助手',
  tool: '工具',
  system: '系统',
}

/** Output viewer text: job output verbatim, record entries role-tagged. */
export function transcriptText(
  entries: readonly TaskTranscriptEntry[],
): string {
  return entries
    .map((entry) =>
      entry.role === 'output'
        ? entry.content
        : `[${TRANSCRIPT_ROLE_LABEL[entry.role] ?? entry.role}] ${entry.content}`,
    )
    .join('\n')
}

function terminalTimestamp(agent: object): number {
  const raw = Number(
    field(agent, 'ended_at') ??
      field(agent, 'endedAt') ??
      field(agent, 'started_at') ??
      0,
  )
  return Number.isFinite(raw) ? raw : 0
}

function field(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key]
}
