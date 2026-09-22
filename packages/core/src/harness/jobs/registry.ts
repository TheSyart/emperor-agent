/**
 * Background job registry (ported from dsh-jobs + dsh-jobs-local, plus the
 * completion delivery of dsh-tool-jobs; no Cordis scopes/controllers).
 *
 * Producers (bash `run_in_background`, later subagents) hand the registry a
 * synchronous starter returning {@link JobHooks}; the registry owns ids,
 * owner-fenced access, lifecycle state, waiters, and notices.
 *
 * - Ids are `<kind>-N`. Access to an owned job is fenced by the owner's
 *   agent id (ids are predictable, so authorization is the boundary).
 * - At most `maxConcurrentPerOwner` (default 10) running/stopping jobs per
 *   exact owner (or the shared unowned bucket).
 * - Settlement is first-wins: one terminal record, released waiters, one
 *   `job/finished` log event, then one completion notice unless something
 *   already reported the terminal state (a kill, a terminal read, a live
 *   wait, or teardown).
 * - Completion notice: an idle owner is woken with `followup` (at most
 *   `maxConsecutiveWakes`, default 3, since the owner last received
 *   user-authored input); a running owner — or one past its budget — gets the
 *   notice injected into its next step.
 * - {@link disposeOwner} cancels, awaits, and drops every job of one agent.
 */

import { boundContextSummary, contextMessage } from '../../llm/message'
import { deadline, timeoutOf } from '../../util/timeout'
import { logger } from '../../util/log'
import type { Agent } from '../agent/agent'

export type JobStatus =
  'running' | 'stopping' | 'completed' | 'killed' | 'failed'
export type JobKind = 'bash' | 'subagent' | (string & {})

declare module '../../session-log/types' {
  interface SessionEventMap {
    /** A background job was registered (log-only). */
    'job/started': {
      jobId: string
      kind: string
      command: string
      description?: string
    }
    /** A background job settled (log-only). */
    'job/finished': {
      jobId: string
      kind: string
      command: string
      status: 'completed' | 'killed' | 'failed'
      exitCode?: number
      detail?: string
    }
  }
}

export interface JobOutcome {
  status: 'completed' | 'killed' | 'failed'
  /** Kind-specific status detail ('exit code: 3', 'signal: SIGTERM'). */
  detail?: string
  /** Exit code for process jobs (logged on `job/finished`). */
  exitCode?: number
  /** Final output for jobs without `readOutput`. */
  output?: string
}

export interface JobHooks {
  /** Request termination: synchronous, idempotent, eventually settles `done`. */
  cancel(reason?: string): void
  /** Resolves once the producer released its resources. Must not reject. */
  done: Promise<JobOutcome>
  /** Consume output produced since the previous call (stream jobs). */
  readOutput?(): string
  /** All output retained so far, without moving the read cursor (UI views). */
  peekOutput?(): string
}

export interface JobStart {
  kind: JobKind
  /** One-line model-facing label (the command). */
  label: string
  /** Optional UI description (logged on `job/started`). */
  description?: string
  owner?: Agent
  run(): JobHooks
}

export interface JobSnapshot {
  id: string
  kind: JobKind
  label: string
  ownerId?: string
  status: JobStatus
  detail?: string
  exitCode?: number
  startedAt: number
  finishedAt?: number
  reported: boolean
}

export interface JobRead {
  text: string
  snapshot: JobSnapshot
}

export type JobDoneListener = (
  snapshot: JobSnapshot,
  owner: Agent | undefined,
) => void
export type JobsChangedListener = (owner: Agent | undefined) => void
export type CompletionDelivery = 'wakeup' | 'quiet'

export interface JobRegistryOptions {
  maxConcurrentPerOwner?: number
  /** `wakeup` opens a turn on an idle owner; `quiet` only injects. */
  completionDelivery?: CompletionDelivery
  maxConsecutiveWakes?: number
}

export const DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER = 10
export const DEFAULT_MAX_CONSECUTIVE_WAKES = 3
export const JOB_WAIT_TIMEOUT = 'JOB_WAIT_TIMEOUT'
export const JOB_NOTICE_PRODUCER = 'jobs'

interface TrackedJob {
  id: string
  kind: JobKind
  label: string
  owner: Agent | undefined
  cancel: (reason?: string) => void
  readOutput: (() => string) | undefined
  peekOutput: (() => string) | undefined
  status: JobStatus
  detail: string | undefined
  exitCode: number | undefined
  output: string | undefined
  startedAt: number
  finishedAt: number | undefined
  reported: boolean
  settled: Promise<void>
  markSettled: () => void
  waiters: number
  waitResolvers: Set<() => void>
}

function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/** `[status: completed, exit code: 0]` */
export function statusLine(
  snapshot: Pick<JobSnapshot, 'status' | 'detail'>,
): string {
  return snapshot.detail !== undefined
    ? `[status: ${snapshot.status}, ${snapshot.detail}]`
    : `[status: ${snapshot.status}]`
}

/** Completion notice text (dsh-tool-jobs `fitCompletionNotice`, uncapped). */
export function completionNotice(snapshot: JobSnapshot): string {
  return `background job ${snapshot.id} (${snapshot.kind}: ${snapshot.label}) finished ${statusLine(snapshot)}. Read its output with job_output.`
}

export class JobRegistry {
  private readonly maxPerOwner: number
  private readonly delivery: CompletionDelivery
  private readonly wakeBudget: number
  private readonly store = new Map<string, TrackedJob>()
  private readonly counters = new Map<string, number>()
  private readonly doneListeners = new Set<JobDoneListener>()
  private readonly changedListeners = new Set<JobsChangedListener>()
  /** Per exact owner: wakes spent and the session seq of the last wake. */
  private readonly wakes = new WeakMap<
    Agent,
    { spent: number; sinceSeq: number }
  >()
  private disposed = false

  constructor(options: JobRegistryOptions = {}) {
    this.maxPerOwner =
      options.maxConcurrentPerOwner ?? DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER
    this.delivery = options.completionDelivery ?? 'wakeup'
    this.wakeBudget =
      options.maxConsecutiveWakes ?? DEFAULT_MAX_CONSECUTIVE_WAKES
    if (!Number.isSafeInteger(this.maxPerOwner) || this.maxPerOwner < 1)
      throw new Error('maxConcurrentPerOwner must be a positive integer')
    if (!Number.isSafeInteger(this.wakeBudget) || this.wakeBudget < 0)
      throw new Error('maxConsecutiveWakes must be a whole number of turns')
  }

  start(spec: JobStart): string {
    if (this.disposed)
      throw new Error(
        'background jobs unavailable: the job registry is disposed',
      )
    if (spec.kind.length === 0)
      throw new Error('invalid job kind: expected a non-empty string')
    if (spec.label.length === 0)
      throw new Error('invalid job label: expected a non-empty string')
    if (this.activeCount(spec.owner) >= this.maxPerOwner) {
      throw new Error(
        `background job limit reached for this owner (limit: ${this.maxPerOwner}); use job_kill to stop an unneeded job, wait for it to finish, then retry`,
      )
    }
    const hooks = spec.run()
    const count = (this.counters.get(spec.kind) ?? 0) + 1
    this.counters.set(spec.kind, count)
    const id = `${spec.kind}-${count}`
    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve
    })
    const job: TrackedJob = {
      id,
      kind: spec.kind,
      label: spec.label,
      owner: spec.owner,
      cancel: hooks.cancel.bind(hooks),
      readOutput: hooks.readOutput?.bind(hooks),
      peekOutput: hooks.peekOutput?.bind(hooks),
      status: 'running',
      detail: undefined,
      exitCode: undefined,
      output: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      reported: false,
      settled,
      markSettled,
      waiters: 0,
      waitResolvers: new Set(),
    }
    this.store.set(id, job)
    this.log(job.owner, () =>
      job.owner!.session.append('job/started', {
        jobId: id,
        kind: job.kind,
        command: job.label,
        ...(spec.description === undefined
          ? {}
          : { description: spec.description }),
      }),
    )
    void hooks.done.then(
      (outcome) => {
        this.settle(job, outcome)
      },
      (error: unknown) => {
        this.settle(job, { status: 'failed', detail: String(error) })
      },
    )
    this.notifyChanged(job.owner)
    return id
  }

  /** Caller-owned and unowned jobs, in registration order. */
  list(caller?: Agent): JobSnapshot[] {
    return [...this.store.values()]
      .filter((job) => job.owner === undefined || job.owner.id === caller?.id)
      .map((job) => this.snapshot(job))
  }

  get(id: string, caller?: Agent): JobSnapshot {
    const job = this.expect(id, caller)
    return this.snapshot(job)
  }

  /** Next stream delta, or the idempotent final output after settlement. */
  read(id: string, caller?: Agent): JobRead {
    const job = this.expect(id, caller)
    const text =
      job.readOutput !== undefined
        ? job.readOutput()
        : isTerminal(job.status)
          ? (job.output ?? '')
          : ''
    if (isTerminal(job.status)) job.reported = true
    return { text, snapshot: this.snapshot(job) }
  }

  /**
   * Everything the job has produced so far, for host views (task panel).
   * Unlike {@link read} it neither advances the stream nor marks the job reported,
   * so the owning agent's own `job_output` reads are unaffected.
   */
  peek(id: string, caller?: Agent): JobRead {
    const job = this.expect(id, caller)
    const text =
      job.peekOutput !== undefined ? job.peekOutput() : (job.output ?? '')
    return { text, snapshot: this.snapshot(job) }
  }

  kill(
    id: string,
    caller?: Agent,
    reason?: string,
  ): 'requested' | 'already-finished' {
    const job = this.expect(id, caller)
    if (isTerminal(job.status)) {
      job.reported = true
      return 'already-finished'
    }
    job.cancel(reason)
    job.status = 'stopping'
    job.reported = true
    this.notifyChanged(job.owner)
    return 'requested'
  }

  /** Wait for settlement or timeout without cancelling the job. */
  async wait(
    id: string,
    timeoutMs: number,
    caller?: Agent,
    signal?: AbortSignal,
  ): Promise<JobSnapshot> {
    const job = this.expect(id, caller)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`,
      )
    }
    if (!isTerminal(job.status)) {
      if (signal?.aborted) throw new Error('wait aborted')
      job.waiters += 1
      let counted = true
      const uncount = (): void => {
        if (!counted) return
        counted = false
        job.waiters -= 1
      }
      const limit = deadline(signal, timeoutMs, JOB_WAIT_TIMEOUT)
      try {
        await new Promise<void>((resolve, reject) => {
          const onSettled = (): void => {
            job.waitResolvers.delete(onSettled)
            limit.signal.removeEventListener('abort', onAbort)
            resolve()
          }
          const onAbort = (): void => {
            job.waitResolvers.delete(onSettled)
            if (timeoutOf(limit.signal, JOB_WAIT_TIMEOUT) !== undefined) {
              resolve()
            } else {
              uncount()
              reject(new Error('wait aborted'))
            }
          }
          job.waitResolvers.add(onSettled)
          limit.signal.addEventListener('abort', onAbort, { once: true })
        })
      } finally {
        limit.dispose()
        uncount()
      }
    }
    if (isTerminal(job.status)) job.reported = true
    return this.snapshot(job)
  }

  onJobDone(listener: JobDoneListener): () => void {
    this.doneListeners.add(listener)
    return () => {
      this.doneListeners.delete(listener)
    }
  }

  onJobsChanged(listener: JobsChangedListener): () => void {
    this.changedListeners.add(listener)
    return () => {
      this.changedListeners.delete(listener)
    }
  }

  /** Cancel, await, and drop every job owned by one agent (by agent id). */
  async disposeOwner(agentId: string): Promise<void> {
    const owned = [...this.store.values()].filter(
      (job) => job.owner?.id === agentId,
    )
    this.cancelForTeardown(owned, 'owner disposed')
    await Promise.all(owned.map((job) => job.settled))
    for (const job of owned) this.store.delete(job.id)
    const owners = new Set(owned.map((job) => job.owner))
    for (const owner of owners) this.notifyChanged(owner)
  }

  /** Cancel and await every job; the registry refuses new work afterwards. */
  async dispose(): Promise<void> {
    this.disposed = true
    const all = [...this.store.values()]
    this.cancelForTeardown(all, 'jobs registry disposed')
    await Promise.all(all.map((job) => job.settled))
    const owners = new Set(all.map((job) => job.owner))
    this.store.clear()
    for (const owner of owners) this.notifyChanged(owner)
    this.doneListeners.clear()
  }

  private activeCount(owner: Agent | undefined): number {
    let count = 0
    for (const job of this.store.values()) {
      if (
        job.owner === owner &&
        (job.status === 'running' || job.status === 'stopping')
      )
        count += 1
    }
    return count
  }

  private expect(id: string, caller: Agent | undefined): TrackedJob {
    if (id.length === 0)
      throw new Error('invalid job_id: expected a non-empty string')
    const job = this.store.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    if (job.owner !== undefined && job.owner.id !== caller?.id)
      throw new Error(`job ${id} belongs to another session`)
    return job
  }

  private snapshot(job: TrackedJob): JobSnapshot {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      ...(job.owner === undefined ? {} : { ownerId: job.owner.id }),
      status: job.status,
      ...(job.detail === undefined ? {} : { detail: job.detail }),
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      reported: job.reported,
    }
  }

  private notifyChanged(owner: Agent | undefined): void {
    for (const listener of this.changedListeners) {
      try {
        listener(owner)
      } catch (error: unknown) {
        logger.warn('jobs: onJobsChanged listener threw', {
          error: String(error),
        })
      }
    }
  }

  private log(owner: Agent | undefined, append: () => void): void {
    if (owner === undefined) return
    try {
      append()
    } catch (error: unknown) {
      logger.warn('jobs: session event append failed', { error: String(error) })
    }
  }

  private settle(job: TrackedJob, outcome: JobOutcome): void {
    if (isTerminal(job.status)) return
    job.status = outcome.status
    job.detail = outcome.detail
    job.exitCode = outcome.exitCode
    job.output = outcome.output
    job.finishedAt = Date.now()
    if (job.waiters > 0) job.reported = true
    const snapshot = this.snapshot(job)
    const resolvers = [...job.waitResolvers]
    job.waitResolvers.clear()
    for (const resolve of resolvers) resolve()
    job.markSettled()
    this.log(job.owner, () =>
      job.owner!.session.append('job/finished', {
        jobId: job.id,
        kind: job.kind,
        command: job.label,
        status: outcome.status,
        ...(outcome.exitCode === undefined
          ? {}
          : { exitCode: outcome.exitCode }),
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      }),
    )
    this.notifyChanged(job.owner)
    if (this.disposed) return
    for (const listener of this.doneListeners) {
      try {
        listener(snapshot, job.owner)
      } catch (error: unknown) {
        logger.warn(`jobs: onJobDone listener threw for ${job.id}`, {
          error: String(error),
        })
      }
    }
    // Completion is announced last: a wake may open a model turn synchronously.
    this.deliverNotice(snapshot, job.owner)
  }

  private deliverNotice(snapshot: JobSnapshot, owner: Agent | undefined): void {
    if (snapshot.reported || owner === undefined) return
    const message = contextMessage(
      JOB_NOTICE_PRODUCER,
      completionNotice(snapshot),
      {
        form: 'notice',
        summary: boundContextSummary(
          `${snapshot.kind} ${snapshot.label} ${statusLine(snapshot)}`,
        ),
      },
    )
    try {
      if (
        this.delivery === 'wakeup' &&
        owner.status === 'idle' &&
        this.takeWake(owner)
      ) {
        owner.followup(message)
        return
      }
      owner.inject(message)
    } catch (error: unknown) {
      // A disposed owner has no reader left.
      logger.warn(
        `jobs: completion notice for ${snapshot.id} was not delivered`,
        { error: String(error) },
      )
    }
  }

  /** Spend one wake unless the budget is exhausted; user-authored input since the last wake refills it. */
  private takeWake(owner: Agent): boolean {
    const events = owner.session.events
    let state = this.wakes.get(owner)
    if (state !== undefined) {
      for (let index = events.length - 1; index >= state.sinceSeq; index -= 1) {
        const event = events[index]
        if (
          event?.type === 'user/message' &&
          event.data.source.kind === 'user'
        ) {
          state = undefined
          break
        }
      }
    }
    const spent = state?.spent ?? 0
    if (spent >= this.wakeBudget) return false
    this.wakes.set(owner, { spent: spent + 1, sinceSeq: events.length })
    return true
  }

  private cancelForTeardown(jobs: TrackedJob[], reason: string): void {
    for (const job of jobs) {
      if (isTerminal(job.status)) continue
      // Nothing will read a notice for a job whose owner is being destroyed.
      job.reported = true
      try {
        job.cancel(reason)
        job.status = 'stopping'
        this.notifyChanged(job.owner)
      } catch (error: unknown) {
        this.settle(job, {
          status: 'failed',
          detail: `cancel threw during teardown; work may be orphaned: ${String(error)}`,
        })
      }
    }
  }
}
