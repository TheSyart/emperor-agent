/**
 * Settings › Scheduler — pure projection helpers (no Vue): job status /
 * schedule / payload labels, the create-edit draft and the CoreApi inputs it
 * turns into, run-history rows and the one-line service summary.
 */
import type {
  SchedulerJob,
  SchedulerMisfirePolicy,
  SchedulerPayload,
  SchedulerRunRecord,
  SchedulerSchedule,
  SchedulerScheduleKind,
} from '../../../types'

export const DEFAULT_JOB_NAME = '主 Agent 任务'
const DEFAULT_CRON = '0 9 * * *'
const HOUR_MS = 60 * 60 * 1000

const READONLY_TIME_FIELDS = [
  'createdAtMs',
  'updatedAtMs',
  'nextRunAtMs',
  'lastRunAtMs',
] as const

const MISFIRE_OPTIONS: Array<{
  value: SchedulerMisfirePolicy
  label: string
}> = [
  { value: 'skip', label: '跳过（默认）' },
  { value: 'latest', label: '只运行最近一次' },
  { value: 'catch-up-one', label: '补跑最早一次' },
]

export const SCHEDULE_KIND_OPTIONS: Array<{
  value: SchedulerScheduleKind
  label: string
}> = [
  { value: 'every', label: '每隔' },
  { value: 'at', label: '指定时间' },
  { value: 'cron', label: 'Cron 表达式' },
]

/** Protected system jobs and system events are run / pause only. */
export function canEditSchedulerJob(job: SchedulerJob | null): boolean {
  if (!job) return false
  if (job.protected) return false
  if (job.payload?.kind === 'system_event') return false
  return true
}

/** Time metadata the UI never sends back (Core owns it). */
export function readonlySchedulerTimeFields(): string[] {
  return [...READONLY_TIME_FIELDS]
}

export function schedulerMisfirePolicyOptions() {
  return MISFIRE_OPTIONS.map((option) => ({ ...option }))
}

export function schedulerMisfirePolicyLabel(value: unknown): string {
  return (
    MISFIRE_OPTIONS.find((option) => option.value === value)?.label ??
    MISFIRE_OPTIONS[0]!.label
  )
}

export function schedulerRunStatusLabel(status?: string | null): string {
  if (status === 'ok') return '成功'
  if (status === 'error') return '失败'
  if (status === 'skipped') return '已跳过'
  if (status === 'cancelled') return '已取消'
  if (status === 'interrupted') return '已中断'
  if (status === 'running') return '运行中'
  return status || '-'
}

export type SchedulerTone = 'ok' | 'warn' | 'error' | 'neutral' | 'accent'

/** Badge tone for one run status (history rows, 「上次」). */
export function schedulerRunStatusTone(status?: string | null): SchedulerTone {
  if (status === 'ok') return 'ok'
  if (status === 'error') return 'error'
  if (status === 'interrupted' || status === 'cancelled') return 'warn'
  if (status === 'running') return 'accent'
  return 'neutral'
}

/** Current job state: active run > paused > last error > enabled. */
export function schedulerJobStatus(job: SchedulerJob): {
  label: string
  tone: SchedulerTone
} {
  const phase = job.state?.activeRun?.phase
  if (phase === 'running') return { label: '运行中', tone: 'accent' }
  if (phase === 'queued') return { label: '排队中', tone: 'accent' }
  if (!job.enabled) return { label: '已暂停', tone: 'neutral' }
  if (job.state?.lastStatus === 'error') return { label: '异常', tone: 'error' }
  return { label: '已启用', tone: 'ok' }
}

export function formatMs(ms?: number | null): string {
  if (!ms) return '-'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/** `MM-DD HH:mm` in local time (card lines). */
export function formatShortMs(ms?: number | null): string {
  if (!ms) return '-'
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const DAY_MS = 24 * HOUR_MS

export function formatDuration(ms?: number | null): string {
  const value = Math.max(0, Number(ms || 0))
  if (value >= DAY_MS && value % DAY_MS === 0) return `${value / DAY_MS} 天`
  if (value >= HOUR_MS && value % HOUR_MS === 0)
    return `${value / HOUR_MS} 小时`
  if (value >= 60_000) return `${Math.round(value / 60_000)} 分钟`
  if (value >= 1000) return `${Math.round(value / 1000)} 秒`
  return `${value} 毫秒`
}

/** `datetime-local` input value for an epoch (local wall clock). */
export function toLocalInputValue(ms: number): string {
  const date = new Date(ms)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function scheduleLabel(job: SchedulerJob): string {
  const schedule = job.schedule || { kind: 'every' }
  if (schedule.kind === 'at') return `指定时间：${formatMs(schedule.atMs)}`
  if (schedule.kind === 'cron')
    return `Cron：${schedule.expr || '-'} · ${schedule.tz || '本地时区'}`
  return `每隔 ${formatDuration(schedule.everyMs || 0)}`
}

export function payloadLabel(job: SchedulerJob): string {
  if (job.payload.kind === 'team_wake')
    return `唤醒队友 · ${job.payload.target || '-'}`
  if (job.payload.kind === 'system_event') return '系统事件'
  return DEFAULT_JOB_NAME
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Form state shared by the create card and the inline editor. */
export interface SchedulerJobDraft {
  name: string
  message: string
  deliver: boolean
  deleteAfterRun: boolean
  misfirePolicy: SchedulerMisfirePolicy
  scheduleKind: SchedulerScheduleKind
  atLocal: string
  everyMinutes: number
  cronExpr: string
  cronTz: string
}

export function emptyJobDraft(): SchedulerJobDraft {
  return {
    name: '',
    message: '',
    deliver: true,
    deleteAfterRun: false,
    misfirePolicy: 'skip',
    scheduleKind: 'every',
    atLocal: '',
    everyMinutes: 60,
    cronExpr: DEFAULT_CRON,
    cronTz: localTimeZone(),
  }
}

export function draftFromJob(job: SchedulerJob): SchedulerJobDraft {
  const schedule: SchedulerSchedule = job.schedule || {
    kind: 'every',
    everyMs: HOUR_MS,
  }
  const kind =
    schedule.kind === 'at' || schedule.kind === 'cron' ? schedule.kind : 'every'
  return {
    name: job.name || '',
    message: job.payload?.message || '',
    deliver: job.payload?.deliver !== false,
    deleteAfterRun: Boolean(job.deleteAfterRun),
    misfirePolicy: job.misfirePolicy || 'skip',
    scheduleKind: kind,
    atLocal: schedule.atMs ? toLocalInputValue(schedule.atMs) : '',
    everyMinutes: Math.max(
      1,
      Math.round(Number(schedule.everyMs || HOUR_MS) / 60_000),
    ),
    cronExpr: schedule.expr || DEFAULT_CRON,
    cronTz: schedule.tz || localTimeZone(),
  }
}

export type SchedulerScheduleInput =
  | { kind: 'at'; atMs: number }
  | { kind: 'every'; everyMs: number }
  | { kind: 'cron'; expr: string; tz: string }

export function buildSchedule(
  draft: Pick<
    SchedulerJobDraft,
    'scheduleKind' | 'atLocal' | 'everyMinutes' | 'cronExpr' | 'cronTz'
  >,
  now: number = Date.now(),
): SchedulerScheduleInput {
  if (draft.scheduleKind === 'at') {
    return {
      kind: 'at',
      atMs: draft.atLocal ? new Date(draft.atLocal).getTime() : now + HOUR_MS,
    }
  }
  if (draft.scheduleKind === 'cron') {
    return {
      kind: 'cron',
      expr: draft.cronExpr.trim() || DEFAULT_CRON,
      tz: draft.cronTz.trim() || 'UTC',
    }
  }
  return {
    kind: 'every',
    everyMs: Math.max(1, Number(draft.everyMinutes || 1)) * 60 * 1000,
  }
}

/** `scheduler.createJob` input (always a main-agent turn). */
export function createJobInput(draft: SchedulerJobDraft, now = Date.now()) {
  return {
    name: draft.name.trim() || DEFAULT_JOB_NAME,
    schedule: buildSchedule(draft, now),
    payload: {
      kind: 'agent_turn' as const,
      message: draft.message.trim(),
      target: null,
      deliver: draft.deliver,
    },
    deleteAfterRun: draft.deleteAfterRun,
    misfirePolicy: draft.misfirePolicy,
  }
}

/** Payload for an update: keeps kind / target / project / meta. */
export function editablePayload(job: SchedulerJob, draft: SchedulerJobDraft) {
  if (job.payload.kind === 'team_wake') {
    return {
      kind: 'team_wake' as const,
      message: draft.message.trim(),
      target: String(job.payload.target || ''),
      projectId: String(job.payload.projectId || ''),
      deliver: draft.deliver,
      meta: job.payload.meta,
    }
  }
  return {
    kind: 'agent_turn' as const,
    message: draft.message.trim(),
    target: null,
    projectId: job.payload.projectId,
    deliver: draft.deliver,
    meta: job.payload.meta,
  }
}

/** `scheduler.updateJob` patch for an editable job. */
export function updateJobInput(
  job: SchedulerJob,
  draft: SchedulerJobDraft,
  now = Date.now(),
) {
  return {
    name: draft.name.trim() || job.name,
    schedule: buildSchedule(draft, now),
    payload: editablePayload(job, draft),
    deleteAfterRun: draft.deleteAfterRun,
    misfirePolicy: draft.misfirePolicy,
  }
}

export function runKey(run: SchedulerRunRecord): string {
  return (
    run.runId ||
    `${run.runAtMs}-${run.status}-${run.durationMs || 0}-${run.error || ''}`
  )
}

/** Newest first. */
export function runHistory(job: SchedulerJob | null): SchedulerRunRecord[] {
  return [...(job?.state?.runHistory || [])].reverse()
}

/** Second line of a run row: planned time · duration · missed count. */
export function runDetail(run: SchedulerRunRecord): string {
  return `计划 ${formatMs(run.scheduledForMs || run.runAtMs)} · ${formatDuration(run.durationMs)} · ${run.missedCount || 1} 次计划${run.countCapped ? '（计数已封顶）' : ''}`
}

export function emptySchedulerPayload(): SchedulerPayload {
  return {
    status: {
      running: false,
      jobs: 0,
      enabled: 0,
      nextRunAtMs: null,
      lastError: null,
    },
    jobs: [],
  }
}

export interface SchedulerSummaryItem {
  text: string
  /** Long form for the tooltip. */
  title: string
}

/** The one-line service summary under the section intro. */
export function schedulerSummary(
  payload: SchedulerPayload,
): SchedulerSummaryItem[] {
  const status = payload.status
  const jobs = payload.jobs || []
  const active = status?.active || 0
  const queued = status?.queued || 0
  const limit = status?.maxConcurrentRuns || 2
  const perOwner = status?.maxPerOwner || 1
  const items: SchedulerSummaryItem[] = [
    { text: `${jobs.length} 个任务`, title: `共 ${jobs.length} 个定时任务` },
    {
      text: `${status?.enabled || 0} 个启用`,
      title: `${status?.enabled || 0} 个任务已启用`,
    },
  ]
  if (status?.nextRunAtMs)
    items.push({
      text: `下次 ${formatShortMs(status.nextRunAtMs)}`,
      title: `下次运行 ${formatMs(status.nextRunAtMs)}`,
    })
  items.push(
    {
      text: `并发 ${active}/${limit}`,
      title: `运行 ${active} / 排队 ${queued} / 上限 ${limit}`,
    },
    { text: `排队 ${queued}`, title: `排队中的运行 ${queued} 个` },
    { text: `每会话 ${perOwner}`, title: `同一会话上限 ${perOwner}` },
  )
  return items
}
