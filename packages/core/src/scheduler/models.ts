import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'

export const SCHEMA_VERSION = 1
export const SCHEDULER_TARGET_SESSION_METADATA_KEY = 'emperor_target_session_id'
const JOB_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/
const MAX_RUN_HISTORY = 20
const RUN_ID_RE = /^schrun_[a-f0-9]{32}$/
const TASK_ID_RE = /^scheduler_run_[a-f0-9]{32}$/
const SHA256_RE = /^[a-f0-9]{64}$/
const MAX_MISSED_COUNT = 10_000

export enum SchedulerMisfirePolicy {
  SKIP = 'skip',
  LATEST = 'latest',
  CATCH_UP_ONE = 'catch-up-one',
}

export enum SchedulerRunTrigger {
  TIMER = 'timer',
  MANUAL = 'manual',
  MISFIRE = 'misfire',
}

export type SchedulerRunPhase = 'queued' | 'running'

export enum SchedulerStatus {
  RUNNING = 'running',
  OK = 'ok',
  ERROR = 'error',
  SKIPPED = 'skipped',
  CANCELLED = 'cancelled',
  INTERRUPTED = 'interrupted',
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
  runId: string | null
  taskId: string | null
  runAtMs: number
  scheduledForMs: number
  trigger: SchedulerRunTrigger
  misfirePolicy: SchedulerMisfirePolicy
  missedCount: number
  countCapped: boolean
  status: string
  durationMs: number
  error: string | null
  [key: string]: unknown
}

export interface SchedulerPendingMisfirePayload {
  policy: SchedulerMisfirePolicy
  scheduledForMs: number
  detectedAtMs: number
  missedCount: number
  countCapped: boolean
}

export interface SchedulerActiveRunPayload {
  runId: string
  taskId: string
  phase: SchedulerRunPhase
  trigger: SchedulerRunTrigger
  scheduledForMs: number
  enqueuedAtMs: number
  startedAtMs: number | null
  ownerKeyDigest: string
  misfirePolicy: SchedulerMisfirePolicy
  missedCount: number
  countCapped: boolean
  resumeNextRunAtMs: number | null
}

export interface SchedulerJobStatePayload {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastStatus: string | null
  lastError: string | null
  runHistory: SchedulerRunRecordPayload[]
  pendingMisfire: SchedulerPendingMisfirePayload | null
  activeRun: SchedulerActiveRunPayload | null
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
  misfirePolicy: SchedulerMisfirePolicy
  protected: boolean
  purpose: string | null
  [key: string]: unknown
}

export type SchedulerPublicActiveRunPayload = Omit<
  SchedulerActiveRunPayload,
  'ownerKeyDigest' | 'resumeNextRunAtMs'
>

export interface SchedulerPublicJobStatePayload {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastStatus: string | null
  lastError: string | null
  runHistory: SchedulerRunRecordPayload[]
  pendingMisfire: SchedulerPendingMisfirePayload | null
  activeRun: SchedulerPublicActiveRunPayload | null
  [key: string]: unknown
}

export interface SchedulerPublicJobViewPayload {
  id: string
  name: string
  enabled: boolean
  schedule: SchedulerSchedulePayload
  payload: SchedulerJobPayload
  state: SchedulerPublicJobStatePayload
  createdAtMs: number
  updatedAtMs: number
  deleteAfterRun: boolean
  misfirePolicy: SchedulerMisfirePolicy
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

export function normalizeSchedulerMisfirePolicy(
  value: unknown,
): SchedulerMisfirePolicy {
  if (value === SchedulerMisfirePolicy.LATEST)
    return SchedulerMisfirePolicy.LATEST
  if (value === SchedulerMisfirePolicy.CATCH_UP_ONE)
    return SchedulerMisfirePolicy.CATCH_UP_ONE
  return SchedulerMisfirePolicy.SKIP
}

export class SchedulerPendingMisfire {
  policy: SchedulerMisfirePolicy
  scheduled_for_ms: number
  detected_at_ms: number
  missed_count: number
  count_capped: boolean

  constructor(opts: {
    policy: SchedulerMisfirePolicy
    scheduled_for_ms: number
    detected_at_ms: number
    missed_count: number
    count_capped: boolean
  }) {
    if (!Object.values(SchedulerMisfirePolicy).includes(opts.policy))
      throw new Error('scheduler pending misfire policy is invalid')
    this.policy = opts.policy
    this.scheduled_for_ms = strictSchedulerTime(
      opts.scheduled_for_ms,
      'scheduler pending misfire scheduled time',
    )!
    this.detected_at_ms = strictSchedulerTime(
      opts.detected_at_ms,
      'scheduler pending misfire detected time',
    )!
    this.missed_count = strictMissedCount(
      opts.missed_count,
      'scheduler pending misfire',
    )
    this.count_capped = strictBoolean(
      opts.count_capped,
      'scheduler pending misfire count cap',
    )
  }

  static fromDict(raw: Record<string, any>): SchedulerPendingMisfire {
    const policy = raw.policy
    if (!Object.values(SchedulerMisfirePolicy).includes(policy))
      throw new Error('scheduler pending misfire policy is invalid')
    return new SchedulerPendingMisfire({
      policy,
      scheduled_for_ms: raw.scheduled_for_ms ?? raw.scheduledForMs,
      detected_at_ms: raw.detected_at_ms ?? raw.detectedAtMs,
      missed_count: raw.missed_count ?? raw.missedCount,
      count_capped: raw.count_capped ?? raw.countCapped,
    })
  }

  toDict(): SchedulerPendingMisfirePayload {
    return {
      policy: this.policy,
      scheduledForMs: this.scheduled_for_ms,
      detectedAtMs: this.detected_at_ms,
      missedCount: this.missed_count,
      countCapped: this.count_capped,
    }
  }
}

export class SchedulerActiveRun {
  run_id: string
  task_id: string
  phase: SchedulerRunPhase
  trigger: SchedulerRunTrigger
  scheduled_for_ms: number
  enqueued_at_ms: number
  started_at_ms: number | null
  owner_key_digest: string
  misfire_policy: SchedulerMisfirePolicy
  missed_count: number
  count_capped: boolean
  resume_next_run_at_ms: number | null

  constructor(opts: {
    run_id: string
    task_id: string
    phase: SchedulerRunPhase
    trigger: SchedulerRunTrigger
    scheduled_for_ms: number
    enqueued_at_ms: number
    started_at_ms: number | null
    owner_key_digest: string
    misfire_policy: SchedulerMisfirePolicy
    missed_count: number
    count_capped: boolean
    resume_next_run_at_ms: number | null
  }) {
    if (!RUN_ID_RE.test(String(opts.run_id ?? '')))
      throw new Error('scheduler active run id is invalid')
    if (!TASK_ID_RE.test(String(opts.task_id ?? '')))
      throw new Error('scheduler active run task id is invalid')
    if (!['queued', 'running'].includes(String(opts.phase ?? '')))
      throw new Error('scheduler active run phase is invalid')
    if (!Object.values(SchedulerRunTrigger).includes(opts.trigger))
      throw new Error('scheduler active run trigger is invalid')
    if (!SHA256_RE.test(String(opts.owner_key_digest ?? '')))
      throw new Error('scheduler active run owner digest is invalid')
    if (!Object.values(SchedulerMisfirePolicy).includes(opts.misfire_policy))
      throw new Error('scheduler active run misfire policy is invalid')
    this.run_id = opts.run_id
    this.task_id = opts.task_id
    this.phase = opts.phase
    this.trigger = opts.trigger
    this.scheduled_for_ms = strictSchedulerTime(
      opts.scheduled_for_ms,
      'scheduler active run scheduled time',
    )!
    this.enqueued_at_ms = strictSchedulerTime(
      opts.enqueued_at_ms,
      'scheduler active run enqueued time',
    )!
    this.started_at_ms = strictSchedulerTime(
      opts.started_at_ms,
      'scheduler active run started time',
      true,
    )
    this.owner_key_digest = opts.owner_key_digest
    this.misfire_policy = opts.misfire_policy
    this.missed_count = strictMissedCount(
      opts.missed_count,
      'scheduler active run',
    )
    this.count_capped = strictBoolean(
      opts.count_capped,
      'scheduler active run count cap',
    )
    this.resume_next_run_at_ms = strictSchedulerTime(
      opts.resume_next_run_at_ms,
      'scheduler active run resume time',
      true,
    )
    if (this.phase === 'queued' && this.started_at_ms !== null)
      throw new Error('scheduler active run queued phase cannot be started')
    if (this.phase === 'running' && this.started_at_ms === null)
      throw new Error('scheduler active run running phase requires start time')
  }

  static fromDict(raw: Record<string, any>): SchedulerActiveRun {
    return new SchedulerActiveRun({
      run_id: raw.run_id ?? raw.runId,
      task_id: raw.task_id ?? raw.taskId,
      phase: raw.phase,
      trigger: raw.trigger,
      scheduled_for_ms: raw.scheduled_for_ms ?? raw.scheduledForMs,
      enqueued_at_ms: raw.enqueued_at_ms ?? raw.enqueuedAtMs,
      started_at_ms: raw.started_at_ms ?? raw.startedAtMs ?? null,
      owner_key_digest: raw.owner_key_digest ?? raw.ownerKeyDigest,
      misfire_policy: raw.misfire_policy ?? raw.misfirePolicy,
      missed_count: raw.missed_count ?? raw.missedCount,
      count_capped: raw.count_capped ?? raw.countCapped,
      resume_next_run_at_ms:
        raw.resume_next_run_at_ms ?? raw.resumeNextRunAtMs ?? null,
    })
  }

  toDict(): SchedulerActiveRunPayload {
    return {
      runId: this.run_id,
      taskId: this.task_id,
      phase: this.phase,
      trigger: this.trigger,
      scheduledForMs: this.scheduled_for_ms,
      enqueuedAtMs: this.enqueued_at_ms,
      startedAtMs: this.started_at_ms,
      ownerKeyDigest: this.owner_key_digest,
      misfirePolicy: this.misfire_policy,
      missedCount: this.missed_count,
      countCapped: this.count_capped,
      resumeNextRunAtMs: this.resume_next_run_at_ms,
    }
  }
}

export class SchedulerRunRecord {
  run_id: string | null
  task_id: string | null
  run_at_ms: number
  scheduled_for_ms: number
  trigger: SchedulerRunTrigger
  misfire_policy: SchedulerMisfirePolicy
  missed_count: number
  count_capped: boolean
  status: string
  duration_ms: number
  error: string | null
  constructor(opts: {
    run_id?: string | null
    task_id?: string | null
    run_at_ms: number
    scheduled_for_ms?: number
    trigger?: SchedulerRunTrigger
    misfire_policy?: SchedulerMisfirePolicy
    missed_count?: number
    count_capped?: boolean
    status: string
    duration_ms?: number
    error?: string | null
  }) {
    if (opts.run_id && !RUN_ID_RE.test(opts.run_id))
      throw new Error('scheduler run record id is invalid')
    if (opts.task_id && !TASK_ID_RE.test(opts.task_id))
      throw new Error('scheduler run record task id is invalid')
    this.run_id = strOrNull(opts.run_id)
    this.task_id = strOrNull(opts.task_id)
    this.run_at_ms = strictSchedulerTime(
      opts.run_at_ms,
      'scheduler run record time',
    )!
    this.scheduled_for_ms = strictSchedulerTime(
      opts.scheduled_for_ms ?? opts.run_at_ms,
      'scheduler run record scheduled time',
    )!
    if (
      opts.trigger !== undefined &&
      !Object.values(SchedulerRunTrigger).includes(opts.trigger)
    )
      throw new Error('scheduler run record trigger is invalid')
    if (
      opts.misfire_policy !== undefined &&
      !Object.values(SchedulerMisfirePolicy).includes(opts.misfire_policy)
    )
      throw new Error('scheduler run record misfire policy is invalid')
    this.trigger = opts.trigger ?? SchedulerRunTrigger.TIMER
    this.misfire_policy = opts.misfire_policy ?? SchedulerMisfirePolicy.SKIP
    this.missed_count = strictMissedCount(
      opts.missed_count ?? 1,
      'scheduler run record',
    )
    this.count_capped =
      opts.count_capped === undefined
        ? false
        : strictBoolean(opts.count_capped, 'scheduler run record count cap')
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
      run_id: raw.run_id ?? raw.runId ?? null,
      task_id: raw.task_id ?? raw.taskId ?? null,
      run_at_ms: Number(raw.run_at_ms ?? raw.runAtMs ?? 0),
      scheduled_for_ms: Number(
        raw.scheduled_for_ms ??
          raw.scheduledForMs ??
          raw.run_at_ms ??
          raw.runAtMs ??
          0,
      ),
      trigger: raw.trigger,
      misfire_policy: raw.misfire_policy ?? raw.misfirePolicy,
      missed_count: raw.missed_count ?? raw.missedCount ?? 1,
      count_capped: raw.count_capped ?? raw.countCapped ?? false,
      status: String(raw.status || SchedulerStatus.SKIPPED),
      duration_ms: Number(raw.duration_ms ?? raw.durationMs ?? 0),
      error: raw.error,
    })
  }
  toDict(): SchedulerRunRecordPayload {
    return {
      runId: this.run_id,
      taskId: this.task_id,
      runAtMs: this.run_at_ms,
      scheduledForMs: this.scheduled_for_ms,
      trigger: this.trigger,
      misfirePolicy: this.misfire_policy,
      missedCount: this.missed_count,
      countCapped: this.count_capped,
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
  pending_misfire: SchedulerPendingMisfire | null = null
  active_run: SchedulerActiveRun | null = null
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
    this.pending_misfire = raw.pending_misfire ?? null
    this.active_run = raw.active_run ?? null
  }
  static fromDict(raw: Record<string, any>): SchedulerJobState {
    const history = (raw.run_history ?? raw.runHistory ?? [])
      .filter(isObject)
      .map(SchedulerRunRecord.fromDict)
    const pendingRaw = raw.pending_misfire ?? raw.pendingMisfire ?? null
    const activeRaw = raw.active_run ?? raw.activeRun ?? null
    if (pendingRaw !== null && !isObject(pendingRaw))
      throw new Error('scheduler pending misfire must be an object')
    if (activeRaw !== null && !isObject(activeRaw))
      throw new Error('scheduler active run must be an object')
    return new SchedulerJobState({
      next_run_at_ms: raw.next_run_at_ms ?? raw.nextRunAtMs,
      last_run_at_ms: raw.last_run_at_ms ?? raw.lastRunAtMs,
      last_status: raw.last_status ?? raw.lastStatus,
      last_error: raw.last_error ?? raw.lastError,
      run_history: history,
      pending_misfire:
        pendingRaw === null
          ? null
          : SchedulerPendingMisfire.fromDict(pendingRaw),
      active_run:
        activeRaw === null ? null : SchedulerActiveRun.fromDict(activeRaw),
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
      pendingMisfire: this.pending_misfire?.toDict() ?? null,
      activeRun: this.active_run?.toDict() ?? null,
    }
  }
  recordRun(opts: {
    runId?: string | null
    taskId?: string | null
    runAtMs: number
    scheduledForMs?: number
    trigger?: SchedulerRunTrigger
    misfirePolicy?: SchedulerMisfirePolicy
    missedCount?: number
    countCapped?: boolean
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
        run_id: opts.runId,
        task_id: opts.taskId,
        run_at_ms: opts.runAtMs,
        scheduled_for_ms: opts.scheduledForMs,
        trigger: opts.trigger,
        misfire_policy: opts.misfirePolicy,
        missed_count: opts.missedCount,
        count_capped: opts.countCapped,
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
  misfire_policy: SchedulerMisfirePolicy
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
    misfire_policy?: SchedulerMisfirePolicy
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
    this.misfire_policy = normalizeSchedulerMisfirePolicy(opts.misfire_policy)
    this.protected = opts.protected ?? false
    this.purpose = strOrNull(opts.purpose)
  }
  static create(opts: {
    name: string
    schedule: SchedulerSchedule
    payload: SchedulerPayload
    jobId?: string | null
    deleteAfterRun?: boolean
    misfirePolicy?: SchedulerMisfirePolicy
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
      misfire_policy: opts.misfirePolicy,
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
      misfire_policy: decodeSchedulerMisfirePolicy(
        raw.misfire_policy ?? raw.misfirePolicy,
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
      misfirePolicy: this.misfire_policy,
      protected: this.protected,
      purpose: this.purpose,
    }
  }
}

export function schedulerJobPublicPayload(
  job: SchedulerJob,
): SchedulerPublicJobViewPayload {
  const payload = job.toDict()
  const active = payload.state.activeRun
  return {
    ...payload,
    state: {
      ...payload.state,
      activeRun: active
        ? {
            runId: active.runId,
            taskId: active.taskId,
            phase: active.phase,
            trigger: active.trigger,
            scheduledForMs: active.scheduledForMs,
            enqueuedAtMs: active.enqueuedAtMs,
            startedAtMs: active.startedAtMs,
            misfirePolicy: active.misfirePolicy,
            missedCount: active.missedCount,
            countCapped: active.countCapped,
          }
        : null,
    },
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

function strictSchedulerTime(
  value: unknown,
  label: string,
  nullable = false,
): number | null {
  if (nullable && (value === null || value === undefined)) return null
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > 8_640_000_000_000_000
  )
    throw new Error(`${label} is invalid`)
  return parsed
}

function strictMissedCount(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_MISSED_COUNT)
    throw new Error(`${label} missed count is invalid`)
  return parsed
}

function strictBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid`)
  return value
}

function decodeSchedulerMisfirePolicy(value: unknown): SchedulerMisfirePolicy {
  if (value === undefined || value === null) return SchedulerMisfirePolicy.SKIP
  if (
    Object.values(SchedulerMisfirePolicy).includes(
      value as SchedulerMisfirePolicy,
    )
  )
    return value as SchedulerMisfirePolicy
  throw new Error('scheduler job misfire policy is invalid')
}
function strOrNull(value: unknown): string | null {
  const text = String(value ?? '')
  return text || null
}
function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
