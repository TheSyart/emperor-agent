export interface SchedulerRunPoolLimits {
  maxConcurrentRuns: number
  maxPerOwner: number
  maxQueuedRuns: number
}

export interface SchedulerRunPoolItem<T = unknown> {
  runId: string
  jobId: string
  ownerKey: string
  scheduledForMs: number
  onStart?: (signal: AbortSignal) => void | Promise<void>
  execute: (signal: AbortSignal) => T | Promise<T>
}

export interface SchedulerRunPoolSnapshot {
  active: number
  queued: number
  activeByOwner: Record<string, number>
}

export class SchedulerRunPoolCapacityError extends Error {
  readonly code = 'scheduler_queue_capacity'

  constructor(readonly limit: number) {
    super(`scheduler run queue reached its ${limit} item limit`)
    this.name = 'SchedulerRunPoolCapacityError'
  }
}

export class SchedulerRunPoolCancelledError extends Error {
  readonly code = 'scheduler_run_cancelled'

  constructor(
    readonly reason: string,
    readonly runId: string,
  ) {
    super(reason)
    this.name = 'SchedulerRunPoolCancelledError'
  }
}

export class SchedulerRunPoolClosedError extends Error {
  readonly code = 'scheduler_closed'

  constructor() {
    super('scheduler run pool is closed')
    this.name = 'SchedulerRunPoolClosedError'
  }
}

export class SchedulerRunPoolDuplicateError extends Error {
  readonly code = 'scheduler_run_duplicate'

  constructor(readonly runId: string) {
    super(`scheduler run is already admitted: ${runId}`)
    this.name = 'SchedulerRunPoolDuplicateError'
  }
}

interface Deferred<T> {
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

interface QueuedRun<T = unknown> {
  item: SchedulerRunPoolItem<T>
  deferred: Deferred<T>
}

interface ActiveRun {
  item: SchedulerRunPoolItem<unknown>
  controller: AbortController
  settled: Promise<void>
}

const DEFAULT_LIMITS: SchedulerRunPoolLimits = {
  maxConcurrentRuns: 2,
  maxPerOwner: 1,
  maxQueuedRuns: 100,
}

export class SchedulerRunPool {
  readonly limits: SchedulerRunPoolLimits
  private accepting = true
  private readonly queue: QueuedRun[] = []
  private readonly active = new Map<string, ActiveRun>()
  private readonly activeByOwner = new Map<string, number>()

  constructor(limits: Partial<SchedulerRunPoolLimits> = {}) {
    this.limits = {
      maxConcurrentRuns: positiveInt(
        limits.maxConcurrentRuns,
        DEFAULT_LIMITS.maxConcurrentRuns,
      ),
      maxPerOwner: positiveInt(limits.maxPerOwner, DEFAULT_LIMITS.maxPerOwner),
      maxQueuedRuns: positiveInt(
        limits.maxQueuedRuns,
        DEFAULT_LIMITS.maxQueuedRuns,
      ),
    }
  }

  enqueue<T>(item: SchedulerRunPoolItem<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new SchedulerRunPoolClosedError())
    if (this.hasRun(item.runId))
      return Promise.reject(new SchedulerRunPoolDuplicateError(item.runId))
    let deferred!: Deferred<T>
    const promise = new Promise<T>((resolve, reject) => {
      deferred = { resolve, reject }
    })
    const queued = { item, deferred } as QueuedRun
    this.queue.push(queued)
    this.queue.sort(compareQueuedRuns)
    this.pump()
    const queuedIndex = this.queue.indexOf(queued)
    if (queuedIndex >= 0 && this.queue.length > this.limits.maxQueuedRuns) {
      this.queue.splice(queuedIndex, 1)
      deferred.reject(
        new SchedulerRunPoolCapacityError(this.limits.maxQueuedRuns),
      )
    }
    return promise
  }

  cancelQueued(
    predicate: (item: SchedulerRunPoolItem<unknown>) => boolean,
    reason: string,
  ): number {
    let cancelled = 0
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index]!
      if (!predicate(queued.item)) continue
      this.queue.splice(index, 1)
      queued.deferred.reject(
        new SchedulerRunPoolCancelledError(reason, queued.item.runId),
      )
      cancelled += 1
    }
    return cancelled
  }

  async shutdown(reason: string, signal?: AbortSignal | null): Promise<void> {
    this.accepting = false
    this.cancelQueued(() => true, reason)
    for (const active of this.active.values())
      if (!active.controller.signal.aborted)
        active.controller.abort(
          new SchedulerRunPoolCancelledError(reason, active.item.runId),
        )

    const drained = Promise.allSettled(
      [...this.active.values()].map((entry) => entry.settled),
    ).then(() => undefined)
    if (!signal) {
      await drained
      return
    }
    if (signal.aborted) return
    await Promise.race([drained, waitForAbort(signal)])
  }

  snapshot(): SchedulerRunPoolSnapshot {
    return {
      active: this.active.size,
      queued: this.queue.length,
      activeByOwner: Object.fromEntries(this.activeByOwner),
    }
  }

  private hasRun(runId: string): boolean {
    return (
      this.active.has(runId) ||
      this.queue.some((entry) => entry.item.runId === runId)
    )
  }

  private pump(): void {
    if (!this.accepting) return
    while (this.active.size < this.limits.maxConcurrentRuns) {
      const index = this.queue.findIndex(
        ({ item }) =>
          (this.activeByOwner.get(item.ownerKey) ?? 0) <
          this.limits.maxPerOwner,
      )
      if (index < 0) return
      const queued = this.queue.splice(index, 1)[0]!
      this.start(queued)
    }
  }

  private start(queued: QueuedRun): void {
    const { item, deferred } = queued
    const controller = new AbortController()
    const ownerActive = (this.activeByOwner.get(item.ownerKey) ?? 0) + 1
    this.activeByOwner.set(item.ownerKey, ownerActive)
    const active: ActiveRun = {
      item,
      controller,
      settled: Promise.resolve(),
    }
    this.active.set(item.runId, active)
    const settled = (async (): Promise<void> => {
      try {
        if (item.onStart) await item.onStart(controller.signal)
        if (controller.signal.aborted) throw controller.signal.reason
        const value = await item.execute(controller.signal)
        if (controller.signal.aborted) throw controller.signal.reason
        deferred.resolve(value)
      } catch (error) {
        deferred.reject(error)
      } finally {
        this.active.delete(item.runId)
        const remaining = (this.activeByOwner.get(item.ownerKey) ?? 1) - 1
        if (remaining > 0) this.activeByOwner.set(item.ownerKey, remaining)
        else this.activeByOwner.delete(item.ownerKey)
        this.pump()
      }
    })()
    active.settled = settled
  }
}

function compareQueuedRuns(a: QueuedRun, b: QueuedRun): number {
  return (
    a.item.scheduledForMs - b.item.scheduledForMs ||
    a.item.jobId.localeCompare(b.item.jobId) ||
    a.item.runId.localeCompare(b.item.runId)
  )
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
