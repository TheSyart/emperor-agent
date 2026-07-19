import { createHash, randomUUID } from 'node:crypto'
import * as runtimeEvents from '../runtime/events'
import { cleanString } from '../util/strings'
import { resolveStartupMisfire } from './misfire'
import {
  computeNextRunMs,
  nowMs,
  SchedulerActiveRun,
  SchedulerJob,
  SchedulerMisfirePolicy,
  SchedulerPayload,
  SchedulerPendingMisfire,
  SchedulerRunTrigger,
  SchedulerSchedule,
  SchedulerStatus,
  SCHEDULER_TARGET_SESSION_METADATA_KEY,
  schedulerJobPublicPayload,
  schedulerPayloadSessionId,
  validateSchedule,
} from './models'
import {
  SchedulerRunPool,
  SchedulerRunPoolCancelledError,
  SchedulerRunPoolCapacityError,
  SchedulerRunPoolClosedError,
  SchedulerRunPoolLimits,
} from './run-pool'
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

export interface SchedulerRunContext {
  runId: string
  taskId: string
  trigger: SchedulerRunTrigger
  scheduledForMs: number
  misfirePolicy: SchedulerMisfirePolicy
  missedCount: number
  countCapped: boolean
  signal: AbortSignal
}

export interface SchedulerTaskTerminalSnapshot {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  error?: string | null
}

export interface SchedulerStatusPayload {
  running: boolean
  misfirePolicy: SchedulerMisfirePolicy
  jobs: number
  enabled: number
  nextRunAtMs: number | null
  lastError: string | null
  active: number
  queued: number
  maxConcurrentRuns: number
  maxPerOwner: number
  maxQueuedRuns: number
  shutdownPolicy: 'cancel-and-interrupt'
}

interface Admission {
  accepted: boolean
  settled: Promise<void>
}

interface NewRunOptions {
  trigger: SchedulerRunTrigger
  scheduledForMs: number
  misfirePolicy: SchedulerMisfirePolicy
  missedCount: number
  countCapped: boolean
  resumeNextRunAtMs: number | null
}

export class SchedulerService {
  readonly store: SchedulerStore
  onJob:
    | ((job: SchedulerJob, context: SchedulerRunContext) => Promise<unknown>)
    | null
  eventSink: ((event: Record<string, unknown>) => Promise<void>) | null
  timeFunc: () => number
  maxSleepMs: number
  readonly misfirePolicy = SchedulerMisfirePolicy.SKIP
  private readonly targetSessionId: SchedulerTargetSession
  private readonly setTimer: SchedulerSetTimer
  private readonly clearTimer: SchedulerClearTimer
  private readonly runPoolLimits: SchedulerRunPoolLimits
  private readonly taskTerminal: (
    taskId: string,
  ) => SchedulerTaskTerminalSnapshot | null
  private runPool: SchedulerRunPool
  private running = false
  private accepting = true
  private timer: unknown = null
  private stopping: Promise<void> | null = null
  private shutdownReason: string | null = null
  private readonly inFlightJobIds = new Set<string>()
  private readonly runSettlements = new Map<string, Promise<void>>()

  constructor(
    store: SchedulerStore,
    opts: {
      onJob?:
        | ((
            job: SchedulerJob,
            context: SchedulerRunContext,
          ) => Promise<unknown>)
        | null
      eventSink?: ((event: Record<string, unknown>) => Promise<void>) | null
      timeFunc?: () => number
      maxSleepMs?: number
      targetSessionId?: SchedulerTargetSession | null
      setTimer?: SchedulerSetTimer
      clearTimer?: SchedulerClearTimer
      runPoolLimits?: Partial<SchedulerRunPoolLimits>
      taskTerminal?:
        ((taskId: string) => SchedulerTaskTerminalSnapshot | null) | null
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
    this.runPool = new SchedulerRunPool(opts.runPoolLimits)
    this.runPoolLimits = this.runPool.limits
    this.taskTerminal = opts.taskTerminal ?? (() => null)
  }

  async start(): Promise<void> {
    if (this.running) return
    if (this.stopping) await this.stopping
    if (this.running) return
    if (!this.accepting) this.runPool = new SchedulerRunPool(this.runPoolLimits)

    const data = this.store.load({ allowLastGood: false })
    this.registerSystemJobs(data)
    const queuedRunJobIds = this.reconcileStartup(data)
    this.store.save(data)
    this.accepting = true
    this.shutdownReason = null
    this.running = true

    for (const jobId of queuedRunJobIds) {
      const job = this.store.getJob(jobId)
      if (job?.state.active_run?.phase === 'queued')
        this.admitDurableRun(job, job.state.active_run, false)
    }
    for (const job of this.store.listJobs({ includeDisabled: true }))
      if (job.state.pending_misfire) this.promotePendingMisfire(job)
    this.armTimer()
  }

  stop(
    reason = 'scheduler shutdown',
    signal?: AbortSignal | null,
  ): Promise<void> {
    if (this.stopping) return this.stopping
    const stopping = this.performStop(reason, signal)
    this.stopping = stopping
    void stopping.finally(() => {
      if (this.stopping === stopping) this.stopping = null
    })
    return stopping
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
    const pool = this.runPool.snapshot()
    return {
      running: this.running,
      misfirePolicy: this.misfirePolicy,
      jobs: jobs.length,
      enabled: enabled.length,
      nextRunAtMs: this.nextWakeMs(jobs),
      lastError: errors.at(-1)?.state.last_error ?? null,
      active: pool.active,
      queued: pool.queued,
      maxConcurrentRuns: this.runPool.limits.maxConcurrentRuns,
      maxPerOwner: this.runPool.limits.maxPerOwner,
      maxQueuedRuns: this.runPool.limits.maxQueuedRuns,
      shutdownPolicy: 'cancel-and-interrupt',
    }
  }

  addJob(opts: {
    name: string
    schedule: SchedulerSchedule
    payload: SchedulerPayload
    deleteAfterRun?: boolean
    misfirePolicy?: SchedulerMisfirePolicy
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
      misfirePolicy: opts.misfirePolicy,
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
      misfirePolicy?: SchedulerMisfirePolicy | null
    },
  ): SchedulerJob | 'not_found' | 'protected' {
    const job = this.store.getJob(jobId)
    if (!job) return 'not_found'
    if (job.protected) return 'protected'
    if (opts.schedule) {
      validateSchedule(opts.schedule)
      job.schedule = opts.schedule
      if (!job.state.active_run)
        job.state.next_run_at_ms = computeNextRunMs(
          job.schedule,
          this.timeFunc(),
        )
    }
    if (opts.payload) job.payload = this.withTargetSession(opts.payload)
    if (opts.name !== undefined && opts.name !== null)
      job.name = String(opts.name || '').trim() || job.name
    if (opts.deleteAfterRun !== undefined && opts.deleteAfterRun !== null)
      job.delete_after_run = Boolean(opts.deleteAfterRun)
    if (opts.misfirePolicy !== undefined && opts.misfirePolicy !== null)
      job.misfire_policy = opts.misfirePolicy
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
    if (!job.enabled) job.state.next_run_at_ms = null
    else if (!job.state.active_run)
      job.state.next_run_at_ms = computeNextRunMs(job.schedule, this.timeFunc())
    const saved = this.store.upsertJob(job)
    if (!job.enabled && job.state.active_run?.phase === 'queued')
      this.runPool.cancelQueued(
        (item) => item.jobId === job.id,
        'scheduler job paused',
      )
    this.armTimer()
    return saved
  }

  removeJob(
    jobId: string,
  ): SchedulerJob | 'not_found' | 'protected' | 'active' {
    const job = this.store.getJob(jobId)
    if (!job) return 'not_found'
    if (job.protected) return 'protected'
    if (job.state.active_run?.phase === 'running') return 'active'
    if (job.state.active_run?.phase === 'queued')
      this.runPool.cancelQueued(
        (item) => item.jobId === job.id,
        'scheduler job removed',
      )
    const removed = this.store.removeJob(jobId) ?? 'not_found'
    this.armTimer()
    return removed
  }

  async cancelQueuedJob(jobId: string, reason: string): Promise<boolean> {
    const job = this.store.getJob(jobId)
    const runId = job?.state.active_run?.run_id
    if (!runId || job?.state.active_run?.phase !== 'queued') return false
    const cancelled = this.runPool.cancelQueued(
      (item) => item.runId === runId,
      reason,
    )
    if (!cancelled) return false
    await this.runSettlements.get(runId)
    return true
  }

  async runJob(
    jobId: string,
    opts: { force?: boolean } = {},
  ): Promise<boolean> {
    if (!this.accepting) throw new SchedulerRunPoolClosedError()
    const job = this.store.getJob(jobId)
    if (!job) return false
    if (!opts.force && !job.enabled) return false
    if (job.state.active_run || this.inFlightJobIds.has(job.id)) return false
    const current = this.timeFunc()
    const activeRun = this.newActiveRun(job, {
      trigger: SchedulerRunTrigger.MANUAL,
      scheduledForMs: current,
      misfirePolicy: job.misfire_policy,
      missedCount: 1,
      countCapped: false,
      resumeNextRunAtMs: job.state.next_run_at_ms,
    })
    const admission = this.admitDurableRun(job, activeRun, true, true)
    await admission.settled
    this.armTimer()
    return admission.accepted
  }

  async onTimer(): Promise<void> {
    if (!this.accepting) return
    let data: SchedulerStoreData
    try {
      data = this.store.load()
    } catch (error) {
      if (error instanceof SchedulerStoreCorrupt) return
      throw error
    }
    const current = this.timeFunc()
    const dueJobs = data.jobs
      .filter(
        (job) =>
          job.enabled &&
          !job.state.active_run &&
          job.state.next_run_at_ms !== null &&
          current >= job.state.next_run_at_ms,
      )
      .sort(
        (a, b) =>
          a.state.next_run_at_ms! - b.state.next_run_at_ms! ||
          a.id.localeCompare(b.id),
      )
    const settlements: Promise<void>[] = []
    for (const job of dueJobs) {
      if (this.inFlightJobIds.has(job.id)) continue
      const scheduledForMs = job.state.next_run_at_ms!
      const activeRun = this.newActiveRun(job, {
        trigger: SchedulerRunTrigger.TIMER,
        scheduledForMs,
        misfirePolicy: job.misfire_policy,
        missedCount: 1,
        countCapped: false,
        resumeNextRunAtMs: nextStrictlyAfter(
          job.schedule,
          scheduledForMs,
          current,
        ),
      })
      settlements.push(
        this.admitDurableRun(job, activeRun, false, true).settled,
      )
    }
    this.armTimer()
    await Promise.allSettled(settlements)
  }

  private async performStop(
    reason: string,
    signal?: AbortSignal | null,
  ): Promise<void> {
    this.accepting = false
    this.shutdownReason = reason
    this.running = false
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    const settlements = [...this.runSettlements.values()]
    await this.runPool.shutdown(reason, signal)
    if (signal?.aborted) return
    const drained = Promise.allSettled(settlements).then(() => undefined)
    if (!signal) await drained
    else await Promise.race([drained, waitForAbort(signal)])
  }

  private reconcileStartup(data: SchedulerStoreData): string[] {
    const current = this.timeFunc()
    const queuedRunJobIds: string[] = []
    for (const job of data.jobs) {
      const active = job.state.active_run
      const taskTerminal = active ? this.taskTerminal(active.task_id) : null
      if (active && taskTerminal) {
        this.reconcileTaskTerminal(job, active, taskTerminal, current)
        continue
      }
      if (active?.phase === 'running') {
        job.state.recordRun({
          runId: active.run_id,
          taskId: active.task_id,
          runAtMs: active.started_at_ms ?? active.enqueued_at_ms,
          scheduledForMs: active.scheduled_for_ms,
          trigger: active.trigger,
          misfirePolicy: active.misfire_policy,
          missedCount: active.missed_count,
          countCapped: active.count_capped,
          status: SchedulerStatus.INTERRUPTED,
          durationMs: Math.max(
            0,
            current - (active.started_at_ms ?? active.enqueued_at_ms),
          ),
          error: 'interrupted by scheduler restart',
        })
        job.state.active_run = null
        job.state.pending_misfire = null
        job.state.next_run_at_ms = job.enabled
          ? active.resume_next_run_at_ms
          : null
        job.updated_at_ms = current
        continue
      }
      if (active?.phase === 'queued') {
        if (job.enabled) queuedRunJobIds.push(job.id)
        else this.cancelPersistedQueued(job, 'disabled before restart', current)
        continue
      }
      if (job.state.last_status === SchedulerStatus.RUNNING) {
        const started = job.state.last_run_at_ms ?? current
        job.state.recordRun({
          runAtMs: started,
          status: SchedulerStatus.INTERRUPTED,
          durationMs: Math.max(0, current - started),
          error: 'interrupted by scheduler restart',
        })
        job.updated_at_ms = current
      }
      if (!job.enabled) {
        job.state.next_run_at_ms = null
        continue
      }
      if (job.state.pending_misfire) continue
      const decision = resolveStartupMisfire(
        job.schedule,
        job.misfire_policy,
        job.state.next_run_at_ms,
        current,
      )
      if (decision.kind === 'none') {
        job.state.next_run_at_ms = decision.nextRunAtMs
        continue
      }
      if (decision.kind === 'skip') {
        const identity = newRunIdentity()
        job.state.recordRun({
          ...identity,
          runAtMs: current,
          scheduledForMs: decision.scheduledForMs,
          trigger: SchedulerRunTrigger.MISFIRE,
          misfirePolicy: job.misfire_policy,
          missedCount: decision.window.missedCount,
          countCapped: decision.window.countCapped,
          status: SchedulerStatus.SKIPPED,
          error: 'startup misfire skipped by policy',
        })
        job.state.next_run_at_ms = decision.window.nextFutureMs
        if (job.schedule.kind === 'at') job.enabled = false
        job.updated_at_ms = current
        continue
      }
      job.state.pending_misfire = new SchedulerPendingMisfire({
        policy: job.misfire_policy,
        scheduled_for_ms: decision.scheduledForMs,
        detected_at_ms: current,
        missed_count: decision.window.missedCount,
        count_capped: decision.window.countCapped,
      })
      job.state.next_run_at_ms = decision.window.nextFutureMs
      job.updated_at_ms = current
    }
    return queuedRunJobIds
  }

  private promotePendingMisfire(job: SchedulerJob): void {
    const pending = job.state.pending_misfire
    if (!pending || job.state.active_run || !job.enabled) return
    const activeRun = this.newActiveRun(job, {
      trigger: SchedulerRunTrigger.MISFIRE,
      scheduledForMs: pending.scheduled_for_ms,
      misfirePolicy: pending.policy,
      missedCount: pending.missed_count,
      countCapped: pending.count_capped,
      resumeNextRunAtMs: job.state.next_run_at_ms,
    })
    this.admitDurableRun(job, activeRun, false, true)
  }

  private newActiveRun(
    job: SchedulerJob,
    opts: NewRunOptions,
  ): SchedulerActiveRun {
    const identity = newRunIdentity()
    return new SchedulerActiveRun({
      run_id: identity.runId,
      task_id: identity.taskId,
      phase: 'queued',
      trigger: opts.trigger,
      scheduled_for_ms: opts.scheduledForMs,
      enqueued_at_ms: this.timeFunc(),
      started_at_ms: null,
      owner_key_digest: schedulerOwnerDigest(job),
      misfire_policy: opts.misfirePolicy,
      missed_count: opts.missedCount,
      count_capped: opts.countCapped,
      resume_next_run_at_ms: opts.resumeNextRunAtMs,
    })
  }

  private admitDurableRun(
    job: SchedulerJob,
    activeRun: SchedulerActiveRun,
    manual: boolean,
    persist = false,
  ): Admission {
    if (this.inFlightJobIds.has(job.id))
      return { accepted: false, settled: Promise.resolve() }
    this.inFlightJobIds.add(job.id)
    if (persist) {
      job.state.pending_misfire = null
      job.state.active_run = activeRun
      job.state.next_run_at_ms = null
      job.updated_at_ms = this.timeFunc()
      this.store.appendAction('update', { job })
    }
    const contextBase = {
      runId: activeRun.run_id,
      taskId: activeRun.task_id,
      trigger: activeRun.trigger,
      scheduledForMs: activeRun.scheduled_for_ms,
      misfirePolicy: activeRun.misfire_policy,
      missedCount: activeRun.missed_count,
      countCapped: activeRun.count_capped,
    }
    const execution = this.runPool.enqueue({
      runId: activeRun.run_id,
      jobId: job.id,
      ownerKey: activeRun.owner_key_digest,
      scheduledForMs: activeRun.scheduled_for_ms,
      onStart: async () => await this.markRunRunning(job.id, activeRun.run_id),
      execute: async (signal) => {
        const current = this.store.getJob(job.id)
        if (!current)
          throw new SchedulerRunPoolCancelledError(
            'scheduler job was removed',
            activeRun.run_id,
          )
        if (this.onJob) await this.onJob(current, { ...contextBase, signal })
      },
    })
    const settled = this.finishRun(job.id, activeRun.run_id, execution, manual)
    this.runSettlements.set(activeRun.run_id, settled)
    return { accepted: true, settled }
  }

  private async markRunRunning(jobId: string, runId: string): Promise<void> {
    const job = this.store.getJob(jobId)
    const active = job?.state.active_run
    if (!job || !active || active.run_id !== runId)
      throw new SchedulerRunPoolCancelledError(
        'scheduler admission is no longer durable',
        runId,
      )
    if (!job.enabled && active.trigger !== SchedulerRunTrigger.MANUAL)
      throw new SchedulerRunPoolCancelledError('scheduler job paused', runId)
    active.phase = 'running'
    active.started_at_ms = this.timeFunc()
    job.state.last_run_at_ms = active.started_at_ms
    job.state.last_status = SchedulerStatus.RUNNING
    job.state.last_error = null
    job.updated_at_ms = active.started_at_ms
    this.store.appendAction('update', { job })
    await this.emit(
      this.withEventSession(
        runtimeEvents.schedulerRunStart(schedulerJobPublicPayload(job), {
          run: schedulerRunEventPayload(active),
        }),
        job,
      ),
    )
  }

  private async finishRun(
    jobId: string,
    runId: string,
    execution: Promise<unknown>,
    manual: boolean,
  ): Promise<void> {
    let failure: unknown = null
    try {
      await execution
    } catch (error) {
      failure = error
    }
    try {
      await this.finalizeRun(jobId, runId, failure)
    } finally {
      this.inFlightJobIds.delete(jobId)
      this.runSettlements.delete(runId)
      this.armTimer()
    }
    if (manual && failure instanceof SchedulerRunPoolCapacityError)
      throw failure
  }

  private async finalizeRun(
    jobId: string,
    runId: string,
    failure: unknown,
  ): Promise<void> {
    const job = this.store.getJob(jobId)
    const active = job?.state.active_run
    if (!job || !active || active.run_id !== runId) return
    const end = this.timeFunc()
    const status = terminalStatus(active, failure, this.shutdownReason !== null)
    const error = terminalError(status, failure, this.shutdownReason)
    job.state.recordRun({
      runId: active.run_id,
      taskId: active.task_id,
      runAtMs: active.started_at_ms ?? active.enqueued_at_ms,
      scheduledForMs: active.scheduled_for_ms,
      trigger: active.trigger,
      misfirePolicy: active.misfire_policy,
      missedCount: active.missed_count,
      countCapped: active.count_capped,
      status,
      durationMs: Math.max(
        0,
        end - (active.started_at_ms ?? active.enqueued_at_ms),
      ),
      error,
    })
    const automaticAt =
      job.schedule.kind === 'at' &&
      active.trigger !== SchedulerRunTrigger.MANUAL
    const deleted = automaticAt && job.delete_after_run
    job.state.active_run = null
    job.state.pending_misfire = null
    job.updated_at_ms = end
    if (automaticAt) {
      job.enabled = false
      job.state.next_run_at_ms = null
    } else
      job.state.next_run_at_ms = job.enabled
        ? active.resume_next_run_at_ms
        : null
    this.store.appendAction(
      deleted ? 'delete' : 'update',
      deleted ? { jobId: job.id } : { job },
    )
    if (status === SchedulerStatus.ERROR)
      await this.emit(
        this.withEventSession(
          runtimeEvents.schedulerRunError(schedulerJobPublicPayload(job), {
            error: error ?? 'unknown error',
            run: schedulerRunEventPayload(active),
          }),
          job,
        ),
      )
    else if (status === SchedulerStatus.CANCELLED)
      await this.emit(
        this.withEventSession(
          runtimeEvents.schedulerRunCancelled(schedulerJobPublicPayload(job), {
            reason: error ?? 'cancelled',
            run: schedulerRunEventPayload(active),
          }),
          job,
        ),
      )
    else if (status === SchedulerStatus.INTERRUPTED)
      await this.emit(
        this.withEventSession(
          runtimeEvents.schedulerRunInterrupted(
            schedulerJobPublicPayload(job),
            {
              reason: error ?? 'interrupted',
              run: schedulerRunEventPayload(active),
            },
          ),
          job,
        ),
      )
    else if (status === SchedulerStatus.SKIPPED)
      await this.emit(
        this.withEventSession(
          runtimeEvents.schedulerRunSkipped(schedulerJobPublicPayload(job), {
            reason: error ?? 'skipped',
            run: schedulerRunEventPayload(active),
          }),
          job,
        ),
      )
    else if (status === SchedulerStatus.OK)
      await this.emit(
        this.withEventSession(
          runtimeEvents.schedulerRunDone(schedulerJobPublicPayload(job), {
            run: schedulerRunEventPayload(active),
          }),
          job,
        ),
      )
  }

  private cancelPersistedQueued(
    job: SchedulerJob,
    reason: string,
    current: number,
  ): void {
    const active = job.state.active_run
    if (!active) return
    job.state.recordRun({
      runId: active.run_id,
      taskId: active.task_id,
      runAtMs: active.enqueued_at_ms,
      scheduledForMs: active.scheduled_for_ms,
      trigger: active.trigger,
      misfirePolicy: active.misfire_policy,
      missedCount: active.missed_count,
      countCapped: active.count_capped,
      status: SchedulerStatus.CANCELLED,
      durationMs: Math.max(0, current - active.enqueued_at_ms),
      error: reason,
    })
    job.state.active_run = null
    job.state.pending_misfire = null
    job.state.next_run_at_ms = null
    job.updated_at_ms = current
  }

  private reconcileTaskTerminal(
    job: SchedulerJob,
    active: SchedulerActiveRun,
    terminal: SchedulerTaskTerminalSnapshot,
    current: number,
  ): void {
    const status = schedulerStatusFromTaskTerminal(terminal.status)
    job.state.recordRun({
      runId: active.run_id,
      taskId: active.task_id,
      runAtMs: active.started_at_ms ?? active.enqueued_at_ms,
      scheduledForMs: active.scheduled_for_ms,
      trigger: active.trigger,
      misfirePolicy: active.misfire_policy,
      missedCount: active.missed_count,
      countCapped: active.count_capped,
      status,
      durationMs: Math.max(
        0,
        current - (active.started_at_ms ?? active.enqueued_at_ms),
      ),
      error:
        status === SchedulerStatus.OK
          ? null
          : terminal.error || `Task terminal status: ${terminal.status}`,
    })
    job.state.active_run = null
    job.state.pending_misfire = null
    if (
      job.schedule.kind === 'at' &&
      active.trigger !== SchedulerRunTrigger.MANUAL
    ) {
      job.enabled = false
      job.state.next_run_at_ms = null
    } else
      job.state.next_run_at_ms = job.enabled
        ? active.resume_next_run_at_ms
        : null
    job.updated_at_ms = current
  }

  private armTimer(data?: SchedulerStoreData): void {
    if (!this.running || !this.accepting) return
    if (this.timer !== null) this.clearTimer(this.timer)
    const jobs = data?.jobs ?? this.store.listJobs({ includeDisabled: true })
    const nextWake = this.nextWakeMs(jobs)
    const delayMs =
      nextWake === null
        ? this.maxSleepMs
        : Math.min(this.maxSleepMs, Math.max(0, nextWake - this.timeFunc()))
    this.timer = this.setTimer(() => this.onTimer(), delayMs)
  }

  private registerSystemJobs(data: SchedulerStoreData): void {
    const current = this.timeFunc()
    const existing = new Map(data.jobs.map((job) => [job.id, job]))
    for (const def of defaultSystemJobs(current)) {
      const found = existing.get(def.id)
      if (!found) {
        def.state.next_run_at_ms = computeNextRunMs(def.schedule, current)
        data.jobs.push(def)
        continue
      }
      found.name = def.name
      found.schedule = def.schedule
      found.payload = def.payload
      found.protected = true
      found.purpose = def.purpose
      found.delete_after_run = false
      if (
        found.enabled &&
        !found.state.active_run &&
        !found.state.pending_misfire &&
        found.state.next_run_at_ms === null
      )
        found.state.next_run_at_ms = computeNextRunMs(found.schedule, current)
    }
  }

  private nextWakeMs(jobs: SchedulerJob[]): number | null {
    const times = jobs
      .filter(
        (job) =>
          job.enabled &&
          !job.state.active_run &&
          job.state.next_run_at_ms !== null,
      )
      .map((job) => job.state.next_run_at_ms!)
    return times.length ? Math.min(...times) : null
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

function newRunIdentity(): { runId: string; taskId: string } {
  const token = randomUUID().replaceAll('-', '')
  return {
    runId: `schrun_${token}`,
    taskId: `scheduler_run_${token}`,
  }
}

function schedulerOwnerDigest(job: SchedulerJob): string {
  const owner =
    schedulerPayloadSessionId(job.payload) ||
    job.payload.target ||
    job.payload.project_id ||
    `${job.payload.kind}:${job.id}`
  return createHash('sha256').update(owner, 'utf8').digest('hex')
}

function schedulerRunEventPayload(
  active: SchedulerActiveRun,
): Record<string, unknown> {
  return {
    runId: active.run_id,
    taskId: active.task_id,
    phase: active.phase,
    trigger: active.trigger,
    scheduledForMs: active.scheduled_for_ms,
    enqueuedAtMs: active.enqueued_at_ms,
    startedAtMs: active.started_at_ms,
    misfirePolicy: active.misfire_policy,
    missedCount: active.missed_count,
    countCapped: active.count_capped,
  }
}

function nextStrictlyAfter(
  schedule: SchedulerSchedule,
  scheduledForMs: number,
  currentMs: number,
): number | null {
  if (schedule.kind === 'at') return null
  if (schedule.kind === 'cron') return computeNextRunMs(schedule, currentMs)
  const interval = schedule.every_ms
  if (!interval || interval <= 0) return null
  const steps = Math.floor((currentMs - scheduledForMs) / interval) + 1
  const next = scheduledForMs + Math.max(1, steps) * interval
  return Number.isSafeInteger(next) ? next : null
}

function terminalStatus(
  active: SchedulerActiveRun,
  failure: unknown,
  shuttingDown: boolean,
): SchedulerStatus {
  if (!failure) return SchedulerStatus.OK
  if (failure instanceof SchedulerRunPoolCapacityError)
    return SchedulerStatus.SKIPPED
  if (failure instanceof SchedulerRunPoolCancelledError)
    return active.phase === 'running'
      ? SchedulerStatus.INTERRUPTED
      : SchedulerStatus.CANCELLED
  if (failure instanceof Error && failure.name === 'CancelledTaskError')
    return shuttingDown && active.phase === 'running'
      ? SchedulerStatus.INTERRUPTED
      : SchedulerStatus.CANCELLED
  return SchedulerStatus.ERROR
}

function terminalError(
  status: SchedulerStatus,
  failure: unknown,
  shutdownReason: string | null,
): string | null {
  if (status === SchedulerStatus.OK) return null
  if (failure instanceof SchedulerRunPoolCapacityError) return failure.message
  if (failure instanceof SchedulerRunPoolCancelledError) return failure.reason
  if (failure instanceof Error && failure.name === 'CancelledTaskError')
    return shutdownReason || 'cancelled'
  return String(failure instanceof Error ? failure.message : failure)
}

function schedulerStatusFromTaskTerminal(
  status: SchedulerTaskTerminalSnapshot['status'],
): SchedulerStatus {
  if (status === 'completed') return SchedulerStatus.OK
  if (status === 'cancelled') return SchedulerStatus.CANCELLED
  if (status === 'interrupted') return SchedulerStatus.INTERRUPTED
  return SchedulerStatus.ERROR
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

export {
  computeNextRunMs,
  validateSchedule,
  SchedulerJob,
  SchedulerPayload,
  SchedulerSchedule,
  SchedulerStatus,
}
