/**
 * Scheduler (the /scheduler page) — pure projection helpers (no Vue): job
 * status / schedule / payload labels, the list buckets and filters, the
 * Chinese schedule and next-run copy of a list row, the create-edit draft
 * (plus the 「创建」 templates) and the CoreApi inputs it turns into,
 * run-history rows and the one-line service summary.
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

/** `MM-DD HH:mm` in local time (service summary line). */
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

export function payloadLabel(job: SchedulerJob): string {
  if (job.payload.kind === 'team_wake')
    return `唤醒队友 · ${job.payload.target || '-'}`
  if (job.payload.kind === 'system_event') return '系统事件'
  return DEFAULT_JOB_NAME
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Form state of the job dialog (create and edit). */
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

// ── /scheduler list: buckets, filters, row copy ─────────────────────────

/** List bucket of a job: 已开启 / 已暂停 / 已完成. */
export type SchedulerJobBucket = 'enabled' | 'paused' | 'completed'
export type SchedulerFilter = 'all' | SchedulerJobBucket

export const SCHEDULER_FILTERS: ReadonlyArray<{
  id: SchedulerFilter
  label: string
}> = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已开启' },
  { id: 'paused', label: '已暂停' },
  { id: 'completed', label: '已完成' },
]

/**
 * 已完成 = a one-shot (`at`) job Core disabled after it ran; any other
 * disabled job is 已暂停.
 */
export function schedulerJobBucket(job: SchedulerJob): SchedulerJobBucket {
  if (job.enabled) return 'enabled'
  if (job.schedule?.kind === 'at' && job.state?.lastRunAtMs != null)
    return 'completed'
  return 'paused'
}

export function normalizeSchedulerFilter(value: unknown): SchedulerFilter {
  return SCHEDULER_FILTERS.some((filter) => filter.id === value)
    ? (value as SchedulerFilter)
    : 'all'
}

/** Jobs of one bucket (or all) whose name / prompt / id / purpose match. */
export function filterSchedulerJobs(
  jobs: readonly SchedulerJob[],
  options: { query?: string; filter?: SchedulerFilter } = {},
): SchedulerJob[] {
  const needle = (options.query ?? '').trim().toLowerCase()
  const filter = options.filter ?? 'all'
  return jobs.filter((job) => {
    if (filter !== 'all' && schedulerJobBucket(job) !== filter) return false
    if (!needle) return true
    return [job.name, job.payload?.message, job.id, job.purpose]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLowerCase().includes(needle))
  })
}

/** Row glyph + copy of the job state (status circle and badge). */
export type SchedulerRowState =
  'running' | 'queued' | 'error' | 'enabled' | 'paused' | 'completed'

export function schedulerRowState(job: SchedulerJob): SchedulerRowState {
  const phase = job.state?.activeRun?.phase
  if (phase === 'running') return 'running'
  if (phase === 'queued') return 'queued'
  const bucket = schedulerJobBucket(job)
  if (bucket !== 'enabled') return bucket
  return job.state?.lastStatus === 'error' ? 'error' : 'enabled'
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const
const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}
const MINUTE_MS = 60_000
const WEEK_MS = 7 * DAY_MS

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** A plain cron number in [min, max], or null for anything else. */
function cronNumber(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null
  const value = Number(field)
  return value >= min && value <= max ? value : null
}

/** `*` / `?` */
function cronAny(field: string): boolean {
  return field === '*' || field === '?'
}

/** `*\/N` step within [1, max), or null. */
function cronStep(field: string, max: number): number | null {
  const match = /^\*\/(\d{1,2})$/.exec(field)
  if (!match) return null
  const step = Number(match[1])
  return step >= 1 && step < max ? step : null
}

function cronWeekday(token: string): number | null {
  const named = WEEKDAY_NAMES[token.toLowerCase()]
  if (named !== undefined) return named
  const value = cronNumber(token, 0, 7)
  return value === null ? null : value % 7
}

/** Day-of-week field → sorted unique weekdays (0 = Sunday), or null. */
function cronWeekdays(field: string): number[] | null {
  const days = new Set<number>()
  for (const part of field.split(',')) {
    const range = /^([A-Za-z]{3}|\d)-([A-Za-z]{3}|\d)$/.exec(part)
    if (range) {
      const from = cronWeekday(range[1]!)
      const to = cronWeekday(range[2]!)
      if (from === null || to === null) return null
      // `5-7` / `FRI-SUN` wrap through Sunday.
      const end = to < from ? to + 7 : to
      for (let day = from; day <= end; day += 1) days.add(day % 7)
      continue
    }
    const day = cronWeekday(part)
    if (day === null) return null
    days.add(day)
  }
  return [...days].sort((a, b) => a - b)
}

function weekdayLabel(days: number[]): string {
  const key = days.join(',')
  if (key === '1,2,3,4,5') return '工作日'
  if (key === '0,6') return '周末'
  if (key === '0,1,2,3,4,5,6') return '每天'
  return days.map((day) => `星期${WEEKDAYS[day]}`).join('、')
}

/**
 * Chinese copy of a cron expression, or null when it is not one of the
 * shapes a person reads at a glance (the caller then shows the raw expr).
 */
export function cronLabelZh(expr: string): string | null {
  let fields = expr.trim().split(/\s+/)
  // Six fields carry seconds first (croner); only whole minutes read well.
  if (fields.length === 6) {
    if (fields[0] !== '0') return null
    fields = fields.slice(1)
  }
  if (fields.length !== 5) return null
  const [minute, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]
  if (!cronAny(month)) return null
  const everyMinutes = cronStep(minute, 60)
  if (everyMinutes !== null && [hour, dom, dow].every(cronAny))
    return `每 ${everyMinutes} 分钟`
  const m = cronNumber(minute, 0, 59)
  if (m === null) return null
  if ([hour, dom, dow].every(cronAny)) return `每小时（第 ${m} 分）`
  const everyHours = cronStep(hour, 24)
  if (everyHours !== null && m === 0 && cronAny(dom) && cronAny(dow))
    return `每 ${everyHours} 小时`
  const h = cronNumber(hour, 0, 23)
  if (h === null) return null
  const time = `（时间：${pad2(h)}:${pad2(m)}）`
  if (cronAny(dom) && cronAny(dow)) return `每天${time}`
  if (cronAny(dom)) {
    const days = cronWeekdays(dow)
    return days ? `${weekdayLabel(days)}${time}` : null
  }
  const day = cronNumber(dom, 1, 31)
  if (day !== null && cronAny(dow)) return `每月 ${day} 日${time}`
  return null
}

function everyLabelZh(everyMs: number): string {
  const value = Math.max(0, everyMs)
  if (value >= WEEK_MS && value % WEEK_MS === 0)
    return value === WEEK_MS ? '每周' : `每 ${value / WEEK_MS} 周`
  if (value >= DAY_MS && value % DAY_MS === 0)
    return value === DAY_MS ? '每天' : `每 ${value / DAY_MS} 天`
  if (value >= HOUR_MS && value % HOUR_MS === 0)
    return value === HOUR_MS ? '每小时' : `每 ${value / HOUR_MS} 小时`
  if (value >= MINUTE_MS) return `每 ${Math.round(value / MINUTE_MS)} 分钟`
  return `每 ${Math.max(1, Math.round(value / 1000))} 秒`
}

/** `9月30日 09:00` (with the year when it is not `now`'s year). */
export function formatDateTimeZh(ms: number, now: number = Date.now()): string {
  const date = new Date(ms)
  const year =
    date.getFullYear() === new Date(now).getFullYear()
      ? ''
      : `${date.getFullYear()}年`
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * Chinese schedule copy of a list row: 「星期五（时间：18:00）」,
 * 「每 2 小时」, 「9月30日 09:00 一次」. A cron job in another time zone
 * names it; an expression without a readable shape shows as 「Cron：…」.
 */
export function scheduleLabelZh(
  job: Pick<SchedulerJob, 'schedule'>,
  options: { now?: number; timeZone?: string } = {},
): string {
  const schedule = job.schedule || { kind: 'every' }
  if (schedule.kind === 'at')
    return schedule.atMs
      ? `${formatDateTimeZh(schedule.atMs, options.now)} 一次`
      : '一次性任务'
  if (schedule.kind === 'cron') {
    const expr = (schedule.expr || '').trim()
    const label = expr ? cronLabelZh(expr) : null
    const local = options.timeZone ?? localTimeZone()
    const zone = schedule.tz && schedule.tz !== local ? schedule.tz : ''
    if (!label) return `Cron：${expr || '-'}${zone ? `（${zone}）` : ''}`
    if (!zone) return label
    return label.endsWith('）')
      ? `${label.slice(0, -1)}，${zone}）`
      : `${label}（${zone}）`
  }
  return everyLabelZh(Number(schedule.everyMs || 0))
}

/** 「下次运行 3天后」 / 「下次运行 2小时后」 / 「即将运行」; '' without a time. */
export function relativeNextRunZh(
  nextRunAtMs: number | null | undefined,
  now: number = Date.now(),
): string {
  if (nextRunAtMs == null || !Number.isFinite(nextRunAtMs)) return ''
  const diff = nextRunAtMs - now
  if (diff <= MINUTE_MS) return '即将运行'
  const minutes = Math.ceil(diff / MINUTE_MS)
  if (minutes < 60) return `下次运行 ${minutes}分钟后`
  const hours = Math.round(diff / HOUR_MS)
  if (hours < 24) return `下次运行 ${hours}小时后`
  return `下次运行 ${Math.round(diff / DAY_MS)}天后`
}

/** Second line of a list row: schedule · state or next run. */
export function schedulerJobLine(
  job: SchedulerJob,
  options: { now?: number; timeZone?: string } = {},
): string {
  const schedule = scheduleLabelZh(job, options)
  const state = schedulerRowState(job)
  const tail =
    state === 'running'
      ? '正在运行'
      : state === 'queued'
        ? '排队中'
        : state === 'paused'
          ? '已暂停'
          : state === 'completed'
            ? '已完成'
            : relativeNextRunZh(job.state?.nextRunAtMs, options.now)
  return tail ? `${schedule} · ${tail}` : schedule
}

/** 「创建 ▾」 templates: prefilled drafts, still confirmed in the dialog. */
export type SchedulerTemplateId = 'daily-digest' | 'weekly-review'

export const SCHEDULER_TEMPLATES: ReadonlyArray<{
  id: SchedulerTemplateId
  label: string
  description: string
}> = [
  {
    id: 'daily-digest',
    label: '每日摘要',
    description: '工作日 09:00 汇总昨天的进展',
  },
  {
    id: 'weekly-review',
    label: '每周回顾',
    description: '星期五 18:00 整理本周完成事项',
  },
]

export function schedulerTemplateDraft(
  id: SchedulerTemplateId,
): SchedulerJobDraft {
  const base = emptyJobDraft()
  if (id === 'weekly-review')
    return {
      ...base,
      name: '每周回顾',
      message: '整理本周完成的事项、未完成的工作和下周计划，输出一份简短周报。',
      scheduleKind: 'cron',
      cronExpr: '0 18 * * 5',
    }
  return {
    ...base,
    name: '每日摘要',
    message: '汇总昨天的进展、待处理事项和阻塞点，输出一份简短摘要。',
    scheduleKind: 'cron',
    cronExpr: '0 9 * * 1-5',
  }
}
