import * as runtimeEvents from '../runtime/events'
import { cleanString } from '../util/strings'
import {
  computeNextRunMs,
  SchedulerJob,
  SchedulerPayload,
  SchedulerSchedule,
  SchedulerStatus,
  SCHEDULER_TARGET_SESSION_METADATA_KEY,
  nowMs,
  schedulerPayloadSessionId,
  validateSchedule,
} from './models'
import {
  SchedulerStore,
  SchedulerStoreCorrupt,
  SchedulerStoreData,
} from './store'
import { defaultSystemJobs } from './system-jobs'

export type SchedulerTimerCallback = () => void | Promise<void>
export type SchedulerSetTimer = (
  callback: SchedulerTimerCallback,
  delayMs: number,
) => unknown
export type SchedulerClearTimer = (handle: unknown) => void
export type SchedulerTargetSession = () => string | null | undefined

export interface SchedulerStatusPayload {
  running: boolean
  jobs: number
  enabled: number
  nextRunAtMs: number | null
  lastError: string | null
}

export class SchedulerService {
  readonly store: SchedulerStore
  onJob: ((job: SchedulerJob) => Promise<string | void | null>) | null
  eventSink: ((event: Record<string, unknown>) => Promise<void>) | null
  timeFunc: () => number
  maxSleepMs: number
  private readonly targetSessionId: SchedulerTargetSession
  private readonly setTimer: SchedulerSetTimer
  private readonly clearTimer: SchedulerClearTimer
  private running = false
  private timer: unknown = null
  private readonly inFlightJobIds = new Set<string>()

  constructor(
    store: SchedulerStore,
    opts: {
      onJob?: ((job: SchedulerJob) => Promise<string | void | null>) | null
      eventSink?: ((event: Record<string, unknown>) => Promise<void>) | null
      timeFunc?: () => number
      maxSleepMs?: number
      targetSessionId?: SchedulerTargetSession | null
      setTimer?: SchedulerSetTimer
      clearTimer?: SchedulerClearTimer
    } = {},
  ) {
    this.store = store
    this.onJob = opts.onJob ?? null
    this.eventSink = opts.eventSink ?? null
    this.timeFunc = opts.timeFunc ?? nowMs
    this.maxSleepMs = Math.max(1, Math.trunc(opts.maxSleepMs ?? 300_000))
    this.targetSessionId = opts.targetSessionId ?? (() => null)
    this.setTimer =
      opts.setTimer ??
      ((callback, delayMs) =>
        setTimeout(() => {
          void callback()
        }, delayMs))
    this.clearTimer =
      opts.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      })
  }

  async start(): Promise<void> {
    if (this.running) return
    const data = this.store.load({ allowLastGood: false })
    this.registerSystemJobs(data)
    this.markStaleRunning(data)
    this.running = true
    this.recomputeNextRuns(data)
    this.store.save(data)
    this.armTimer(data)
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  listJobs(opts: { includeDisabled?: boolean } = {}): SchedulerJob[] {
    return this.store.listJobs({
      includeDisabled: opts.includeDisabled ?? true,
    })
  }
  getJob(jobId: string): SchedulerJob | null {
    return this.store.getJob(jobId)
  }
  status(): SchedulerStatusPayload {
    const jobs = this.store.listJobs({ includeDisabled: true })
    const enabled = jobs.filter((job) => job.enabled)
    const errors = jobs.filter(
      (job) => job.state.last_status === SchedulerStatus.ERROR,
    )
    return {
      running: this.running,
      jobs: jobs.length,
      enabled: enabled.length,
      nextRunAtMs: this.nextWakeMs(jobs),
      lastError: errors.at(-1)?.state.last_error ?? null,
    }
  }

  addJob(opts: {
    name: string
    schedule: SchedulerSchedule
    payload: SchedulerPayload
    deleteAfterRun?: boolean
    protected?: boolean
    purpose?: string | null
  }): SchedulerJob {
    validateSchedule(opts.schedule)
    const current = this.timeFunc()
    const payload = this.withTargetSession(opts.payload)
    const job = SchedulerJob.create({
      name: opts.name,
      schedule: opts.schedule,
      payload,
      deleteAfterRun: opts.deleteAfterRun ?? false,
      protected: opts.protected ?? false,
      purpose: opts.purpose ?? null,
      now: current,
    })
    job.state.next_run_at_ms = computeNextRunMs(opts.schedule, current)
    const saved = this.store.upsertJob(job)
    this.armTimer()
    return saved
  }

  updateJob(
    jobId: string,
    opts: {
      name?: string | null
      schedule?: SchedulerSchedule | null
      payload?: SchedulerPayload | null
      deleteAfterRun?: boolean | null
    },
  ): SchedulerJob | 'not_found' | 'protected' {
    const job = this.store.getJob(jobId)
    if (!job) return 'not_found'
    if (job.protected) return 'protected'
    if (opts.schedule) {
      validateSchedule(opts.schedule)
      job.schedule = opts.schedule
      job.state.next_run_at_ms = computeNextRunMs(job.schedule, this.timeFunc())
    }
    if (opts.payload) job.payload = opts.payload
    if (opts.name !== undefined && opts.name !== null)
      job.name = String(opts.name || '').trim() || job.name
    if (opts.deleteAfterRun !== undefined && opts.deleteAfterRun !== null)
      job.delete_after_run = Boolean(opts.deleteAfterRun)
    job.updated_at_ms = this.timeFunc()
    const saved = this.store.upsertJob(job)
    this.armTimer()
    return saved
  }

  enableJob(jobId: string, enabled = true): SchedulerJob | 'not_found' {
    const job = this.store.getJob(jobId)
    if (!job) return 'not_found'
    job.enabled = Boolean(enabled)
    job.updated_at_ms = this.timeFunc()
    job.state.next_run_at_ms = job.enabled
      ? computeNextRunMs(job.schedule, this.timeFunc())
      : null
    const saved = this.store.upsertJob(job)
    this.armTimer()
    return saved
  }

  removeJob(jobId: string): SchedulerJob | 'not_found' | 'protected' {
    const job = this.store.getJob(jobId)
    if (!job) return 'not_found'
    if (job.protected) return 'protected'
    const removed = this.store.removeJob(jobId) ?? 'not_found'
    this.armTimer()
    return removed
  }

  async runJob(
    jobId: string,
    opts: { force?: boolean } = {},
  ): Promise<boolean> {
    const job = this.store.getJob(jobId)
    if (!job) return false
    if (!opts.force && !job.enabled) return false
    const executed = await this.executeJob(job, { manual: true })
    this.armTimer()
    return executed
  }

  async onTimer(): Promise<void> {
    let data: SchedulerStoreData
    try {
      data = this.store.load()
    } catch (error) {
      if (error instanceof SchedulerStoreCorrupt) return
      throw error
    }
    const current = this.timeFunc()
    for (const job of data.jobs.filter(
      (item) =>
        item.enabled &&
        item.state.next_run_at_ms &&
        current >= item.state.next_run_at_ms,
    )) {
      await this.executeJob(job, { manual: false })
    }
    this.armTimer()
  }

  private armTimer(data?: SchedulerStoreData): void {
    if (!this.running) return
    if (this.timer !== null) this.clearTimer(this.timer)
    const jobs = data?.jobs ?? this.store.listJobs({ includeDisabled: true })
    const nextWake = this.nextWakeMs(jobs)
    const delayMs =
      nextWake === null
        ? this.maxSleepMs
        : Math.min(this.maxSleepMs, Math.max(0, nextWake - this.timeFunc()))
    this.timer = this.setTimer(() => this.onTimer(), delayMs)
  }

  private recomputeNextRuns(data: SchedulerStoreData): void {
    const current = this.timeFunc()
    for (const job of data.jobs)
      job.state.next_run_at_ms = job.enabled
        ? computeNextRunMs(job.schedule, current)
        : null
  }

  private registerSystemJobs(data: SchedulerStoreData): void {
    const current = this.timeFunc()
    const existing = new Map(data.jobs.map((job) => [job.id, job]))
    for (const def of defaultSystemJobs(current)) {
      const found = existing.get(def.id)
      if (!found) {
        def.state.next_run_at_ms = computeNextRunMs(def.schedule, current)
        data.jobs.push(def)
      } else {
        found.name = def.name
        found.schedule = def.schedule
        found.payload = def.payload
        found.protected = true
        found.purpose = def.purpose
        found.delete_after_run = false
        if (found.enabled)
          found.state.next_run_at_ms = computeNextRunMs(found.schedule, current)
      }
    }
  }

  private nextWakeMs(jobs: SchedulerJob[]): number | null {
    const times = jobs
      .filter((job) => job.enabled && job.state.next_run_at_ms)
      .map((job) => job.state.next_run_at_ms!)
    return times.length ? Math.min(...times) : null
  }

  /**
   * 单个 job 的执行状态通过 appendAction 追加到 action log，而不是整表 save()。
   * onTimer/runJob 的 `data` 快照可能跨越 `await this.onJob(job)` 变陈旧；若在此期间
   * 整表覆盖写，会悄悄撤销执行期间发生的并发 add/update/remove（审计 P0-3）。
   * appendAction 只记录"这一个 job 的最新状态"，下一次 store.load() 会自动合并，
   * 不会覆盖其他 job 的并发变更。
   */
  private async executeJob(
    job: SchedulerJob,
    opts: { manual: boolean },
  ): Promise<boolean> {
    if (this.inFlightJobIds.has(job.id)) return false
    this.inFlightJobIds.add(job.id)
    try {
      await this.executeJobLocked(job, opts)
      return true
    } finally {
      this.inFlightJobIds.delete(job.id)
    }
  }

  private async executeJobLocked(
    job: SchedulerJob,
    opts: { manual: boolean },
  ): Promise<void> {
    const start = this.timeFunc()
    let status: string = SchedulerStatus.OK
    let error: string | null = null
    job.state.last_run_at_ms = start
    job.state.last_status = SchedulerStatus.RUNNING
    job.state.last_error = null
    job.state.next_run_at_ms = null
    job.updated_at_ms = start
    this.store.appendAction('update', { job })
    await this.emit(
      this.withEventSession(runtimeEvents.schedulerRunStart(job.toDict()), job),
    )
    try {
      if (this.onJob) await this.onJob(job)
    } catch (exc) {
      status =
        exc instanceof Error && exc.name === 'CancelledTaskError'
          ? SchedulerStatus.CANCELLED
          : SchedulerStatus.ERROR
      error =
        status === SchedulerStatus.CANCELLED
          ? 'cancelled'
          : String(exc instanceof Error ? exc.message : exc)
    }
    const end = this.timeFunc()
    job.state.recordRun({
      runAtMs: start,
      status,
      durationMs: Math.max(0, end - start),
      error,
    })
    job.updated_at_ms = end
    let deleted = false
    if (job.schedule.kind === 'at' && !opts.manual) {
      if (job.delete_after_run) deleted = true
      else {
        job.enabled = false
        job.state.next_run_at_ms = null
      }
    } else if (job.enabled)
      job.state.next_run_at_ms = computeNextRunMs(job.schedule, this.timeFunc())
    this.store.appendAction(
      deleted ? 'delete' : 'update',
      deleted ? { jobId: job.id } : { job },
    )
    if (status === SchedulerStatus.ERROR)
      await this.emit(
        this.withEventSession(
          runtimeEvents.schedulerRunError(job.toDict(), {
            error: error || 'unknown error',
          }),
          job,
        ),
      )
    else if (status === SchedulerStatus.CANCELLED)
      await this.emit(
        this.withEventSession(
          runtimeEvents.schedulerRunCancelled(job.toDict(), {
            reason: error || 'cancelled',
          }),
          job,
        ),
      )
    else
      await this.emit(
        this.withEventSession(
          runtimeEvents.schedulerRunDone(job.toDict()),
          job,
        ),
      )
  }

  private markStaleRunning(data: SchedulerStoreData): void {
    const current = this.timeFunc()
    for (const job of data.jobs) {
      if (job.state.last_status !== SchedulerStatus.RUNNING) continue
      const started = job.state.last_run_at_ms ?? current
      job.state.recordRun({
        runAtMs: started,
        status: SchedulerStatus.ERROR,
        durationMs: Math.max(0, current - started),
        error: 'interrupted by scheduler restart',
      })
      job.updated_at_ms = current
    }
  }

  private async emit(event: Record<string, unknown>): Promise<void> {
    if (this.eventSink) await this.eventSink(event)
  }

  private withTargetSession(payload: SchedulerPayload): SchedulerPayload {
    if (schedulerPayloadSessionId(payload)) return payload
    const sessionId = cleanString(this.targetSessionId())
    if (!sessionId) return payload
    return SchedulerPayload.fromDict({
      ...payload.toDict(),
      meta: {
        ...payload.meta,
        [SCHEDULER_TARGET_SESSION_METADATA_KEY]: sessionId,
      },
    })
  }

  /** 兜底链 payload → 实时 targetSessionId → 伪 session 'scheduler'：绝不发无主事件。 */
  private withEventSession(
    event: Record<string, unknown>,
    job: SchedulerJob,
  ): Record<string, unknown> {
    const sessionId =
      schedulerPayloadSessionId(job.payload) ||
      cleanString(this.targetSessionId()) ||
      'scheduler'
    return { ...event, session_id: sessionId }
  }
}

export {
  computeNextRunMs,
  validateSchedule,
  SchedulerJob,
  SchedulerPayload,
  SchedulerSchedule,
  SchedulerStatus,
}
