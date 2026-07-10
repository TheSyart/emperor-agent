import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'

export const SCHEMA_VERSION = 1
export const SCHEDULER_TARGET_SESSION_METADATA_KEY = 'emperor_target_session_id'
const JOB_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/
const MAX_RUN_HISTORY = 20

export enum SchedulerStatus {
  RUNNING = 'running',
  OK = 'ok',
  ERROR = 'error',
  SKIPPED = 'skipped',
  CANCELLED = 'cancelled',
}

export interface SchedulerSchedulePayload {
  kind: 'at' | 'every' | 'cron'
  atMs: number | null
  everyMs: number | null
  expr: string | null
  tz: string | null
  [key: string]: unknown
}

export interface SchedulerJobPayload {
  kind: 'agent_turn' | 'team_wake' | 'system_event'
  message: string
  target: string | null
  projectId: string | null
  deliver: boolean
  meta: Record<string, unknown>
  [key: string]: unknown
}

export interface SchedulerRunRecordPayload {
  runAtMs: number
  status: string
  durationMs: number
  error: string | null
  [key: string]: unknown
}

export interface SchedulerJobStatePayload {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastStatus: string | null
  lastError: string | null
  runHistory: SchedulerRunRecordPayload[]
  [key: string]: unknown
}

export interface SchedulerJobViewPayload {
  id: string
  name: string
  enabled: boolean
  schedule: SchedulerSchedulePayload
  payload: SchedulerJobPayload
  state: SchedulerJobStatePayload
  createdAtMs: number
  updatedAtMs: number
  deleteAfterRun: boolean
  protected: boolean
  purpose: string | null
  [key: string]: unknown
}

export function nowMs(): number {
  return Date.now()
}
export function newJobId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}
export function validateJobId(jobId: string): string {
  const safe = String(jobId || '').trim()
  if (!JOB_ID_RE.test(safe))
    throw new Error('job id must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}')
  return safe
}

export class SchedulerSchedule {
  kind: 'at' | 'every' | 'cron'
  at_ms: number | null
  every_ms: number | null
  expr: string | null
  tz: string | null
  constructor(opts: {
    kind: 'at' | 'every' | 'cron'
    at_ms?: number | null
    every_ms?: number | null
    expr?: string | null
    tz?: string | null
  }) {
    this.kind = opts.kind
    this.at_ms = intOrNull(opts.at_ms)
    this.every_ms = intOrNull(opts.every_ms)
    this.expr = strOrNull(opts.expr)
    this.tz = strOrNull(opts.tz)
  }
  static fromDict(raw: Record<string, any>): SchedulerSchedule {
    const kind = String(raw.kind || 'every')
    if (!['at', 'every', 'cron'].includes(kind))
      throw new Error(`unsupported schedule kind: ${kind}`)
    return new SchedulerSchedule({
      kind: kind as 'at' | 'every' | 'cron',
      at_ms: raw.at_ms ?? raw.atMs,
      every_ms: raw.every_ms ?? raw.everyMs,
      expr: raw.expr,
      tz: raw.tz,
    })
  }
  toDict(): SchedulerSchedulePayload {
    return {
      kind: this.kind,
      atMs: this.at_ms,
      everyMs: this.every_ms,
      expr: this.expr,
      tz: this.tz,
    }
  }
}

export class SchedulerPayload {
  kind: 'agent_turn' | 'team_wake' | 'system_event'
  message: string
  target: string | null
  project_id: string | null
  deliver: boolean
  meta: Record<string, unknown>
  constructor(
    opts: {
      kind?: 'agent_turn' | 'team_wake' | 'system_event'
      message?: string
      target?: string | null
      project_id?: string | null
      deliver?: boolean
      meta?: Record<string, unknown>
    } = {},
  ) {
    this.kind = opts.kind ?? 'agent_turn'
    this.message = String(opts.message ?? '')
    this.target = strOrNull(opts.target)
    this.project_id = strOrNull(opts.project_id)
    this.deliver = opts.deliver ?? true
    this.meta = opts.meta ?? {}
  }
  static fromDict(raw: Record<string, any>): SchedulerPayload {
    let kind = String(raw.kind || 'agent_turn') as
      'agent_turn' | 'team_wake' | 'system_event'
    if (!['agent_turn', 'team_wake', 'system_event'].includes(kind))
      kind = 'agent_turn'
    return new SchedulerPayload({
      kind,
      message: raw.message,
      target: raw.target,
      project_id: raw.project_id ?? raw.projectId,
      deliver: Boolean(raw.deliver ?? true),
      meta: isObject(raw.meta) ? raw.meta : {},
    })
  }
  toDict(): SchedulerJobPayload {
    return {
      kind: this.kind,
      message: this.message,
      target: this.target,
      projectId: this.project_id,
      deliver: this.deliver,
      meta: this.meta,
    }
  }
}

export function schedulerPayloadSessionId(payload: SchedulerPayload): string {
  return strOrNull(payload.meta[SCHEDULER_TARGET_SESSION_METADATA_KEY]) ?? ''
}

export class SchedulerRunRecord {
  run_at_ms: number
  status: string
  duration_ms: number
  error: string | null
  constructor(opts: {
    run_at_ms: number
    status: string
    duration_ms?: number
    error?: string | null
  }) {
    this.run_at_ms = Math.trunc(opts.run_at_ms)
    this.status = Object.values(SchedulerStatus).includes(
      opts.status as SchedulerStatus,
    )
      ? opts.status
      : SchedulerStatus.SKIPPED
    this.duration_ms = Math.max(0, Math.trunc(opts.duration_ms ?? 0))
    this.error = strOrNull(opts.error)
  }
  static fromDict(raw: Record<string, any>): SchedulerRunRecord {
    return new SchedulerRunRecord({
      run_at_ms: Number(raw.run_at_ms ?? raw.runAtMs ?? 0),
      status: String(raw.status || SchedulerStatus.SKIPPED),
      duration_ms: Number(raw.duration_ms ?? raw.durationMs ?? 0),
      error: raw.error,
    })
  }
  toDict(): SchedulerRunRecordPayload {
    return {
      runAtMs: this.run_at_ms,
      status: this.status,
      durationMs: this.duration_ms,
      error: this.error,
    }
  }
}

export class SchedulerJobState {
  next_run_at_ms: number | null = null
  last_run_at_ms: number | null = null
  last_status: string | null = null
  last_error: string | null = null
  run_history: SchedulerRunRecord[] = []
  constructor(raw: Partial<SchedulerJobState> = {}) {
    this.next_run_at_ms = intOrNull(raw.next_run_at_ms)
    this.last_run_at_ms = intOrNull(raw.last_run_at_ms)
    this.last_status =
      raw.last_status &&
      Object.values(SchedulerStatus).includes(
        raw.last_status as SchedulerStatus,
      )
        ? raw.last_status
        : null
    this.last_error = strOrNull(raw.last_error)
    this.run_history = (raw.run_history ?? []).slice(-MAX_RUN_HISTORY)
  }
  static fromDict(raw: Record<string, any>): SchedulerJobState {
    const history = (raw.run_history ?? raw.runHistory ?? [])
      .filter(isObject)
      .map(SchedulerRunRecord.fromDict)
    return new SchedulerJobState({
      next_run_at_ms: raw.next_run_at_ms ?? raw.nextRunAtMs,
      last_run_at_ms: raw.last_run_at_ms ?? raw.lastRunAtMs,
      last_status: raw.last_status ?? raw.lastStatus,
      last_error: raw.last_error ?? raw.lastError,
      run_history: history,
    })
  }
  toDict(): SchedulerJobStatePayload {
    return {
      nextRunAtMs: this.next_run_at_ms,
      lastRunAtMs: this.last_run_at_ms,
      lastStatus: this.last_status,
      lastError: this.last_error,
      runHistory: this.run_history
        .slice(-MAX_RUN_HISTORY)
        .map((item) => item.toDict()),
    }
  }
  recordRun(opts: {
    runAtMs: number
    status: string
    durationMs?: number
    error?: string | null
  }): void {
    const status = Object.values(SchedulerStatus).includes(
      opts.status as SchedulerStatus,
    )
      ? opts.status
      : SchedulerStatus.SKIPPED
    this.last_run_at_ms = Math.trunc(opts.runAtMs)
    this.last_status = status
    this.last_error = strOrNull(opts.error)
    this.run_history.push(
      new SchedulerRunRecord({
        run_at_ms: opts.runAtMs,
        status,
        duration_ms: opts.durationMs ?? 0,
        error: opts.error,
      }),
    )
    this.run_history = this.run_history.slice(-MAX_RUN_HISTORY)
  }
}

export class SchedulerJob {
  id: string
  name: string
  enabled = true
  schedule: SchedulerSchedule
  payload: SchedulerPayload
  state: SchedulerJobState
  created_at_ms: number
  updated_at_ms: number
  delete_after_run = false
  protected = false
  purpose: string | null = null
  constructor(opts: {
    id: string
    name: string
    enabled?: boolean
    schedule: SchedulerSchedule
    payload: SchedulerPayload
    state?: SchedulerJobState
    created_at_ms?: number
    updated_at_ms?: number
    delete_after_run?: boolean
    protected?: boolean
    purpose?: string | null
  }) {
    this.id = validateJobId(opts.id)
    this.name = String(opts.name || '')
    this.enabled = opts.enabled ?? true
    this.schedule = opts.schedule
    this.payload = opts.payload
    this.state = opts.state ?? new SchedulerJobState()
    this.created_at_ms = Math.trunc(opts.created_at_ms ?? nowMs())
    this.updated_at_ms = Math.trunc(opts.updated_at_ms ?? nowMs())
    this.delete_after_run = opts.delete_after_run ?? false
    this.protected = opts.protected ?? false
    this.purpose = strOrNull(opts.purpose)
  }
  static create(opts: {
    name: string
    schedule: SchedulerSchedule
    payload: SchedulerPayload
    jobId?: string | null
    deleteAfterRun?: boolean
    protected?: boolean
    purpose?: string | null
    now?: number
  }): SchedulerJob {
    const stamp = Math.trunc(opts.now ?? nowMs())
    return new SchedulerJob({
      id: validateJobId(opts.jobId || newJobId()),
      name: String(opts.name || 'scheduled-job').trim() || 'scheduled-job',
      schedule: opts.schedule,
      payload: opts.payload,
      created_at_ms: stamp,
      updated_at_ms: stamp,
      delete_after_run: opts.deleteAfterRun ?? false,
      protected: opts.protected ?? false,
      purpose: opts.purpose ?? null,
    })
  }
  static fromDict(raw: Record<string, any>): SchedulerJob {
    return new SchedulerJob({
      id: String(raw.id || ''),
      name: String(raw.name || ''),
      enabled: Boolean(raw.enabled ?? true),
      schedule: SchedulerSchedule.fromDict(raw.schedule || {}),
      payload: SchedulerPayload.fromDict(raw.payload || {}),
      state: SchedulerJobState.fromDict(raw.state || {}),
      created_at_ms: Number(raw.created_at_ms ?? raw.createdAtMs ?? nowMs()),
      updated_at_ms: Number(raw.updated_at_ms ?? raw.updatedAtMs ?? nowMs()),
      delete_after_run: Boolean(
        raw.delete_after_run ?? raw.deleteAfterRun ?? false,
      ),
      protected: Boolean(raw.protected ?? false),
      purpose: raw.purpose,
    })
  }
  toDict(): SchedulerJobViewPayload {
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      schedule: this.schedule.toDict(),
      payload: this.payload.toDict(),
      state: this.state.toDict(),
      createdAtMs: this.created_at_ms,
      updatedAtMs: this.updated_at_ms,
      deleteAfterRun: this.delete_after_run,
      protected: this.protected,
      purpose: this.purpose,
    }
  }
}

export function computeNextRunMs(
  schedule: SchedulerSchedule,
  currentMs: number,
): number | null {
  if (schedule.kind === 'at')
    return schedule.at_ms && schedule.at_ms > currentMs ? schedule.at_ms : null
  if (schedule.kind === 'every')
    return schedule.every_ms && schedule.every_ms > 0
      ? currentMs + schedule.every_ms
      : null
  if (schedule.kind === 'cron') return nextCronMs(schedule, currentMs)
  return null
}

export function validateSchedule(schedule: SchedulerSchedule): void {
  if (schedule.kind === 'at') {
    if (!schedule.at_ms || schedule.at_ms <= 0)
      throw new Error('at schedule requires at_ms')
    if (schedule.tz) throw new Error('tz can only be used with cron schedules')
    return
  }
  if (schedule.kind === 'every') {
    if (!schedule.every_ms || schedule.every_ms <= 0)
      throw new Error('every schedule requires every_ms > 0')
    if (schedule.tz) throw new Error('tz can only be used with cron schedules')
    return
  }
  if (schedule.kind === 'cron') {
    if (!schedule.expr) throw new Error('cron schedule requires expr')
    if (schedule.tz) validateTimeZone(schedule.tz)
    if (!isValidCron(schedule.expr))
      throw new Error(`invalid cron expression '${schedule.expr}'`)
    return
  }
  throw new Error(
    `unsupported schedule kind: ${(schedule as SchedulerSchedule).kind}`,
  )
}

function nextCronMs(
  schedule: SchedulerSchedule,
  currentMs: number,
): number | null {
  if (!schedule.expr) return null
  try {
    const cron = new Cron(schedule.expr, {
      paused: true,
      timezone: schedule.tz ?? undefined,
    })
    return cron.nextRun(new Date(currentMs))?.getTime() ?? null
  } catch {
    return null
  }
}

function isValidCron(expr: string): boolean {
  try {
    new Cron(expr, { paused: true })
    return true
  } catch {
    return false
  }
}

function validateTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date())
  } catch {
    throw new Error(`unknown timezone '${tz}'`)
  }
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}
function strOrNull(value: unknown): string | null {
  const text = String(value ?? '')
  return text || null
}
function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
