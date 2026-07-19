import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskManager } from '../tasks/manager'
import { TaskKind, TaskStatus } from '../tasks/models'
import {
  SchedulerActiveRun,
  SchedulerJob,
  SchedulerMisfirePolicy,
  SchedulerPayload,
  SchedulerRunTrigger,
  SchedulerSchedule,
  SchedulerStatus,
  SCHEDULER_TARGET_SESSION_METADATA_KEY,
} from './models'
import { SchedulerRunPoolCapacityError } from './run-pool'
import { SchedulerRunContext, SchedulerService } from './service'
import { SchedulerStore } from './store'

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0)

interface Gate {
  promise: Promise<void>
  release: () => void
}

function gate(): Gate {
  let release = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-scheduler-runtime-'))
}

function payload(sessionId: string): SchedulerPayload {
  return new SchedulerPayload({
    kind: 'agent_turn',
    message: 'run',
    meta: { [SCHEDULER_TARGET_SESSION_METADATA_KEY]: sessionId },
  })
}

function addEvery(
  service: SchedulerService,
  name: string,
  sessionId: string,
  misfirePolicy = SchedulerMisfirePolicy.SKIP,
): SchedulerJob {
  return service.addJob({
    name,
    schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
    payload: payload(sessionId),
    misfirePolicy,
  })
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('condition did not become true')
}

function ownerDigest(owner: string): string {
  return createHash('sha256').update(owner).digest('hex')
}

describe('SchedulerService durable admission', () => {
  it('emits public run correlation without internal owner or resume fields', async () => {
    const events: Record<string, unknown>[] = []
    const service = new SchedulerService(new SchedulerStore(root()), {
      eventSink: async (event) => {
        events.push(event)
      },
      onJob: async () => undefined,
    })
    const job = addEvery(service, 'public event', 'session-secret')

    await service.runJob(job.id, { force: true })

    expect(events.map((event) => event.event)).toEqual([
      'scheduler_run_start',
      'scheduler_run_done',
    ])
    for (const event of events) {
      expect(event).toMatchObject({
        run_id: expect.stringMatching(/^schrun_[a-f0-9]{32}$/),
        task_id: expect.stringMatching(/^scheduler_run_[a-f0-9]{32}$/),
        session_id: 'session-secret',
      })
      expect(JSON.stringify(event)).not.toContain('ownerKeyDigest')
      expect(JSON.stringify(event)).not.toContain('resumeNextRunAtMs')
    }
  })

  it('runs different owners concurrently and serializes the same owner', async () => {
    const first = gate()
    const second = gate()
    const starts: string[] = []
    let active = 0
    let peak = 0
    const service = new SchedulerService(new SchedulerStore(root()), {
      onJob: async (job, context) => {
        expect(context.runId).toMatch(/^schrun_[a-f0-9]{32}$/)
        expect(context.taskId).toMatch(/^scheduler_run_[a-f0-9]{32}$/)
        starts.push(job.name)
        active += 1
        peak = Math.max(peak, active)
        if (job.name === 'a1') await first.promise
        if (job.name === 'b1') await second.promise
        active -= 1
      },
    })
    const a1 = addEvery(service, 'a1', 'session-a')
    const a2 = addEvery(service, 'a2', 'session-a')
    const b1 = addEvery(service, 'b1', 'session-b')

    const runA1 = service.runJob(a1.id, { force: true })
    const runA2 = service.runJob(a2.id, { force: true })
    const runB1 = service.runJob(b1.id, { force: true })
    await flushUntil(() => starts.length === 2)
    expect(starts).toEqual(['a1', 'b1'])
    expect(peak).toBe(2)
    expect(service.status()).toMatchObject({ active: 2, queued: 1 })

    second.release()
    await runB1
    expect(starts).toEqual(['a1', 'b1'])
    first.release()
    await Promise.all([runA1, runA2])
    expect(starts).toEqual(['a1', 'b1', 'a2'])
    expect(service.status()).toMatchObject({ active: 0, queued: 0 })
  })

  it('admits every due owner before awaiting a long timer run', async () => {
    let clock = BASE
    const slow = gate()
    const starts: string[] = []
    const service = new SchedulerService(new SchedulerStore(root()), {
      timeFunc: () => clock,
      setTimer: () => 1,
      clearTimer: () => undefined,
      onJob: async (job) => {
        starts.push(job.name)
        if (job.name === 'slow') await slow.promise
      },
    })
    const slowJob = addEvery(service, 'slow', 'session-a')
    const fastJob = addEvery(service, 'fast', 'session-b')
    slowJob.state.next_run_at_ms = BASE
    fastJob.state.next_run_at_ms = BASE
    service.store.upsertJob(slowJob)
    service.store.upsertJob(fastJob)
    await service.start()

    const tick = service.onTimer()
    await flushUntil(() => starts.length === 2)
    expect(starts).toEqual(expect.arrayContaining(['slow', 'fast']))
    expect(service.getJob(fastJob.id)?.state.last_status).toBe(
      SchedulerStatus.OK,
    )
    slow.release()
    await tick
    await service.stop()
    clock += 1
  })

  it('returns a typed manual capacity error and never invokes overflow work', async () => {
    const blocker = gate()
    const starts: string[] = []
    const service = new SchedulerService(new SchedulerStore(root()), {
      runPoolLimits: {
        maxConcurrentRuns: 1,
        maxPerOwner: 1,
        maxQueuedRuns: 1,
      },
      onJob: async (job) => {
        starts.push(job.name)
        if (job.name === 'active') await blocker.promise
      },
    })
    const active = addEvery(service, 'active', 'session-a')
    const queued = addEvery(service, 'queued', 'session-b')
    const overflow = addEvery(service, 'overflow', 'session-c')

    const first = service.runJob(active.id, { force: true })
    await flushUntil(() => starts.includes('active'))
    const second = service.runJob(queued.id, { force: true })
    await flushUntil(() => service.status().queued === 1)
    await expect(
      service.runJob(overflow.id, { force: true }),
    ).rejects.toBeInstanceOf(SchedulerRunPoolCapacityError)
    expect(starts).not.toContain('overflow')
    expect(service.getJob(overflow.id)?.state.last_status).toBe(
      SchedulerStatus.SKIPPED,
    )

    blocker.release()
    await Promise.all([first, second])
  })

  it('records automatic queue overflow as skipped without invoking it', async () => {
    const store = new SchedulerStore(root())
    for (const [jobId, sessionId] of [
      ['auto-a', 'session-a'],
      ['auto-b', 'session-b'],
      ['auto-c', 'session-c'],
    ] as const) {
      const job = SchedulerJob.create({
        jobId,
        name: jobId,
        schedule: new SchedulerSchedule({
          kind: 'every',
          every_ms: 60_000,
        }),
        payload: payload(sessionId),
        now: BASE,
      })
      job.state.next_run_at_ms = BASE
      store.upsertJob(job)
    }
    const blocker = gate()
    const starts: string[] = []
    const service = new SchedulerService(store, {
      timeFunc: () => BASE,
      setTimer: () => 1,
      clearTimer: () => undefined,
      runPoolLimits: {
        maxConcurrentRuns: 1,
        maxPerOwner: 1,
        maxQueuedRuns: 1,
      },
      onJob: async (job) => {
        starts.push(job.id)
        if (job.id === 'auto-a') await blocker.promise
      },
    })
    await service.start()

    const tick = service.onTimer()
    await flushUntil(
      () =>
        service.getJob('auto-c')?.state.last_status === SchedulerStatus.SKIPPED,
    )
    expect(starts).toEqual(['auto-a'])
    expect(service.getJob('auto-c')?.state.run_history.at(-1)).toMatchObject({
      status: SchedulerStatus.SKIPPED,
      error: expect.stringContaining('queue reached'),
    })
    blocker.release()
    await tick
    expect(starts).toEqual(['auto-a', 'auto-b'])
    await service.stop()
  })

  it('coalesces overlapping manual and timer admission for one Job', async () => {
    let clock = BASE
    const blocker = gate()
    let calls = 0
    const service = new SchedulerService(new SchedulerStore(root()), {
      timeFunc: () => clock,
      onJob: async () => {
        calls += 1
        await blocker.promise
      },
    })
    const job = addEvery(service, 'single', 'session-a')
    job.state.next_run_at_ms = clock
    service.store.upsertJob(job)

    const manual = service.runJob(job.id, { force: true })
    await flushUntil(() => calls === 1)
    const timer = service.onTimer()
    blocker.release()
    await Promise.all([manual, timer])
    expect(calls).toBe(1)
    expect(service.getJob(job.id)?.state.run_history).toHaveLength(1)
    clock += 1
  })

  it('pauses a queued Job without invoking its callback', async () => {
    const blocker = gate()
    const starts: string[] = []
    const service = new SchedulerService(new SchedulerStore(root()), {
      runPoolLimits: { maxConcurrentRuns: 1 },
      onJob: async (job) => {
        starts.push(job.name)
        if (job.name === 'active') await blocker.promise
      },
    })
    const active = addEvery(service, 'active', 'session-a')
    const queued = addEvery(service, 'queued', 'session-b')
    const first = service.runJob(active.id, { force: true })
    await flushUntil(() => starts.length === 1)
    const second = service.runJob(queued.id, { force: true })
    await flushUntil(() => service.status().queued === 1)

    expect(service.enableJob(queued.id, false)).toMatchObject({
      enabled: false,
    })
    await expect(second).resolves.toBe(true)
    expect(starts).toEqual(['active'])
    expect(service.getJob(queued.id)?.state.last_status).toBe(
      SchedulerStatus.CANCELLED,
    )
    blocker.release()
    await first
  })

  it('rejects deletion of an active Job', async () => {
    const blocker = gate()
    const service = new SchedulerService(new SchedulerStore(root()), {
      onJob: async () => await blocker.promise,
    })
    const job = addEvery(service, 'active', 'session-a')
    const running = service.runJob(job.id, { force: true })
    await flushUntil(
      () => service.getJob(job.id)?.state.active_run?.phase === 'running',
    )

    expect(service.removeJob(job.id)).toBe('active')
    expect(service.getJob(job.id)).not.toBeNull()
    blocker.release()
    await running
  })

  it('shutdown aborts running work, cancels queued work, and fences late timers', async () => {
    const starts: string[] = []
    const service = new SchedulerService(new SchedulerStore(root()), {
      runPoolLimits: { maxConcurrentRuns: 1 },
      setTimer: () => 1,
      clearTimer: () => undefined,
      onJob: async (job, context) => {
        starts.push(job.name)
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true },
          )
        })
      },
    })
    const active = addEvery(service, 'active', 'session-a')
    const queued = addEvery(service, 'queued', 'session-b')
    const first = service.runJob(active.id, { force: true })
    await flushUntil(() => starts.length === 1)
    const second = service.runJob(queued.id, { force: true })
    await flushUntil(() => service.status().queued === 1)

    await service.stop('application shutdown')
    await Promise.all([first, second])
    expect(starts).toEqual(['active'])
    expect(service.getJob(active.id)?.state.last_status).toBe(
      SchedulerStatus.INTERRUPTED,
    )
    expect(service.getJob(queued.id)?.state.last_status).toBe(
      SchedulerStatus.CANCELLED,
    )
    await service.onTimer()
    expect(starts).toEqual(['active'])
  })

  it('bounds shutdown wait while leaving an uncooperative run durable until it settles', async () => {
    const blocker = gate()
    let entered = false
    const service = new SchedulerService(new SchedulerStore(root()), {
      onJob: async () => {
        entered = true
        await blocker.promise
      },
    })
    const job = addEvery(service, 'uncooperative', 'session-a')
    const running = service.runJob(job.id, { force: true })
    await flushUntil(() => entered)
    const lifecycle = new AbortController()
    const stopping = service.stop('application shutdown', lifecycle.signal)
    lifecycle.abort(new Error('lifecycle deadline'))

    await expect(stopping).resolves.toBeUndefined()
    expect(service.getJob(job.id)?.state.active_run?.phase).toBe('running')
    blocker.release()
    await running
    await flushUntil(
      () =>
        service.getJob(job.id)?.state.last_status ===
        SchedulerStatus.INTERRUPTED,
    )
    expect(service.getJob(job.id)?.state.active_run).toBeNull()
  })

  it.each([
    {
      policy: SchedulerMisfirePolicy.SKIP,
      expectedCalls: 0,
      scheduledForMs: BASE,
      status: SchedulerStatus.SKIPPED,
    },
    {
      policy: SchedulerMisfirePolicy.LATEST,
      expectedCalls: 1,
      scheduledForMs: BASE + 3 * 60_000,
      status: SchedulerStatus.OK,
    },
    {
      policy: SchedulerMisfirePolicy.CATCH_UP_ONE,
      expectedCalls: 1,
      scheduledForMs: BASE,
      status: SchedulerStatus.OK,
    },
  ])(
    'applies startup $policy as at most one durable effect',
    async ({ policy, expectedCalls, scheduledForMs, status }) => {
      let clock = BASE
      const store = new SchedulerStore(root())
      const job = SchedulerJob.create({
        jobId: `misfire-${policy}`,
        name: policy,
        schedule: new SchedulerSchedule({
          kind: 'every',
          every_ms: 60_000,
        }),
        payload: payload('session-a'),
        misfirePolicy: policy,
        now: clock,
      })
      job.state.next_run_at_ms = BASE
      store.upsertJob(job)
      clock = BASE + 3 * 60_000 + 30_000
      const contexts: SchedulerRunContext[] = []
      const service = new SchedulerService(store, {
        timeFunc: () => clock,
        setTimer: () => 1,
        clearTimer: () => undefined,
        onJob: async (_job, context) => {
          contexts.push(context)
        },
      })

      await service.start()
      await flushUntil(
        () =>
          service.getJob(job.id)?.state.last_status === status &&
          contexts.length === expectedCalls,
      )
      const loaded = service.getJob(job.id)!
      expect(contexts).toHaveLength(expectedCalls)
      expect(loaded.state.run_history).toHaveLength(1)
      expect(loaded.state.run_history[0]).toMatchObject({
        scheduled_for_ms: scheduledForMs,
        misfire_policy: policy,
        missed_count: 4,
      })
      expect(loaded.state.next_run_at_ms).toBe(BASE + 4 * 60_000)
      await service.stop()
    },
  )

  it('restores a durable queued run once with the same identities', async () => {
    let clock = BASE + 10_000
    const store = new SchedulerStore(root())
    const job = SchedulerJob.create({
      jobId: 'queued-restart',
      name: 'queued restart',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: payload('session-a'),
      misfirePolicy: SchedulerMisfirePolicy.LATEST,
      now: BASE,
    })
    const runId = `schrun_${'a'.repeat(32)}`
    const taskId = `scheduler_run_${'b'.repeat(32)}`
    job.state.next_run_at_ms = null
    job.state.active_run = new SchedulerActiveRun({
      run_id: runId,
      task_id: taskId,
      phase: 'queued',
      trigger: SchedulerRunTrigger.MISFIRE,
      scheduled_for_ms: BASE,
      enqueued_at_ms: BASE,
      started_at_ms: null,
      owner_key_digest: ownerDigest('session-a'),
      misfire_policy: SchedulerMisfirePolicy.LATEST,
      missed_count: 2,
      count_capped: false,
      resume_next_run_at_ms: BASE + 60_000,
    })
    store.upsertJob(job)
    const contexts: SchedulerRunContext[] = []
    const service = new SchedulerService(store, {
      timeFunc: () => clock,
      setTimer: () => 1,
      clearTimer: () => undefined,
      onJob: async (_job, context) => {
        contexts.push(context)
      },
    })

    await service.start()
    await flushUntil(() => contexts.length === 1)
    await flushUntil(() => service.getJob(job.id)?.state.active_run === null)
    expect(contexts[0]).toMatchObject({ runId, taskId })
    expect(service.getJob(job.id)?.state.run_history).toHaveLength(1)
    await service.stop()
    clock += 1
  })

  it('marks an unproven running run interrupted without replaying it', async () => {
    const store = new SchedulerStore(root())
    const job = SchedulerJob.create({
      jobId: 'running-restart',
      name: 'running restart',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: payload('session-a'),
      now: BASE,
    })
    job.state.active_run = new SchedulerActiveRun({
      run_id: `schrun_${'a'.repeat(32)}`,
      task_id: `scheduler_run_${'b'.repeat(32)}`,
      phase: 'running',
      trigger: SchedulerRunTrigger.TIMER,
      scheduled_for_ms: BASE,
      enqueued_at_ms: BASE,
      started_at_ms: BASE + 1_000,
      owner_key_digest: ownerDigest('session-a'),
      misfire_policy: SchedulerMisfirePolicy.SKIP,
      missed_count: 1,
      count_capped: false,
      resume_next_run_at_ms: BASE + 60_000,
    })
    store.upsertJob(job)
    let calls = 0
    const service = new SchedulerService(store, {
      timeFunc: () => BASE + 10_000,
      setTimer: () => 1,
      clearTimer: () => undefined,
      onJob: async () => {
        calls += 1
      },
    })

    await service.start()
    expect(calls).toBe(0)
    expect(service.getJob(job.id)?.state.active_run).toBeNull()
    expect(service.getJob(job.id)?.state.last_status).toBe(
      SchedulerStatus.INTERRUPTED,
    )
    expect(service.getJob(job.id)?.state.next_run_at_ms).toBe(BASE + 60_000)
    await service.stop()
  })

  it.each([
    { taskStatus: TaskStatus.COMPLETED, schedulerStatus: SchedulerStatus.OK },
    { taskStatus: TaskStatus.FAILED, schedulerStatus: SchedulerStatus.ERROR },
    {
      taskStatus: TaskStatus.CANCELLED,
      schedulerStatus: SchedulerStatus.CANCELLED,
    },
    {
      taskStatus: TaskStatus.INTERRUPTED,
      schedulerStatus: SchedulerStatus.INTERRUPTED,
    },
  ])(
    'converges a Task $taskStatus / Scheduler running terminal gap without replay',
    async ({ taskStatus, schedulerStatus }) => {
      const stateRoot = root()
      const taskManager = new TaskManager(stateRoot)
      const taskId = `scheduler_run_${'b'.repeat(32)}`
      taskManager.startTask({
        taskId,
        kind: TaskKind.SCHEDULER_RUN,
        title: 'terminal gap',
        source: 'scheduler',
      })
      if (taskStatus === TaskStatus.COMPLETED)
        taskManager.completeTask(taskId, { summary: 'done' })
      else if (taskStatus === TaskStatus.FAILED)
        taskManager.failTask(taskId, { error: 'failed' })
      else if (taskStatus === TaskStatus.CANCELLED)
        taskManager.cancelTask(taskId, { reason: 'cancelled' })
      else taskManager.interruptTask(taskId, { reason: 'restart' })

      const store = new SchedulerStore(stateRoot)
      const job = SchedulerJob.create({
        jobId: `terminal-${taskStatus}`,
        name: 'terminal gap',
        schedule: new SchedulerSchedule({
          kind: 'every',
          every_ms: 60_000,
        }),
        payload: payload('session-a'),
        now: BASE,
      })
      job.state.active_run = new SchedulerActiveRun({
        run_id: `schrun_${'a'.repeat(32)}`,
        task_id: taskId,
        phase: 'running',
        trigger: SchedulerRunTrigger.TIMER,
        scheduled_for_ms: BASE,
        enqueued_at_ms: BASE,
        started_at_ms: BASE + 1_000,
        owner_key_digest: ownerDigest('session-a'),
        misfire_policy: SchedulerMisfirePolicy.SKIP,
        missed_count: 1,
        count_capped: false,
        resume_next_run_at_ms: BASE + 60_000,
      })
      store.upsertJob(job)
      let calls = 0
      const service = new SchedulerService(store, {
        timeFunc: () => BASE + 10_000,
        setTimer: () => 1,
        clearTimer: () => undefined,
        taskTerminal: (candidateTaskId) => {
          const task = taskManager.store.get(candidateTaskId)
          if (!task || task.status === TaskStatus.RUNNING) return null
          return {
            status:
              task.status === TaskStatus.COMPLETED
                ? 'completed'
                : task.status === TaskStatus.CANCELLED
                  ? 'cancelled'
                  : task.status === TaskStatus.INTERRUPTED
                    ? 'interrupted'
                    : 'failed',
            error: String(task.progress.error ?? task.progress.reason ?? ''),
          }
        },
        onJob: async () => {
          calls += 1
        },
      })

      await service.start()
      expect(calls).toBe(0)
      expect(service.getJob(job.id)?.state.active_run).toBeNull()
      expect(service.getJob(job.id)?.state.last_status).toBe(schedulerStatus)
      expect(service.getJob(job.id)?.state.run_history.at(-1)).toMatchObject({
        task_id: taskId,
        status: schedulerStatus,
      })
      await service.stop()
    },
  )

  it('keeps start/stop idempotent and can restart with a fresh pool', async () => {
    const service = new SchedulerService(new SchedulerStore(root()), {
      setTimer: () => 1,
      clearTimer: () => undefined,
    })
    await Promise.all([service.start(), service.start()])
    expect(service.status().running).toBe(true)
    await Promise.all([service.stop(), service.stop()])
    expect(service.status().running).toBe(false)
    await service.start()
    expect(service.status().running).toBe(true)
    await service.stop()
  })
})
