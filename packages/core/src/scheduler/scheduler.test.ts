import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SchedulerJob,
  SchedulerPayload,
  SchedulerSchedule,
  SchedulerStatus,
  computeNextRunMs,
  validateSchedule,
} from './models'
import { SchedulerService } from './service'
import { SchedulerStore, SchedulerStoreCorrupt } from './store'
import { resetSchedulerRun, SchedulerTool, setSchedulerRun } from './tool'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

class FakeClock {
  value = 1_700_000_000_000
  now = () => this.value
  advance(ms: number): void {
    this.value += ms
  }
}

function makeJob(jobId = 'job-1', name = 'job'): SchedulerJob {
  return SchedulerJob.create({
    jobId,
    name,
    schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
    payload: new SchedulerPayload({ kind: 'agent_turn', message: 'ping' }),
    now: 1_700_000_000_000,
  })
}

describe('scheduler models/store', () => {
  it('round-trips jobs with camelCase disk payloads and trims run history', () => {
    const root = tmp('emperor-scheduler-store-')
    const store = new SchedulerStore(root)
    const job = makeJob()
    job.state.next_run_at_ms = 1_700_000_060_000
    for (let i = 0; i < 25; i++)
      job.state.recordRun({
        runAtMs: i,
        status: SchedulerStatus.OK,
        durationMs: 12,
      })

    store.upsertJob(job)
    const loaded = store.getJob('job-1')!
    const raw = JSON.parse(readFileSync(store.jobsFile, 'utf8'))

    expect(loaded.schedule.every_ms).toBe(60_000)
    expect(loaded.state.run_history).toHaveLength(20)
    expect(loaded.state.run_history[0]!.run_at_ms).toBe(5)
    expect(raw.jobs[0].schedule.everyMs).toBe(60_000)
    expect(raw.jobs[0].state.runHistory[0].durationMs).toBe(12)
  })

  it('merges action logs and isolates invalid lines', () => {
    const root = tmp('emperor-scheduler-actions-')
    const store = new SchedulerStore(root)
    store.appendAction('add', { job: makeJob('job-1', 'first') })
    store.appendAction('update', { job: makeJob('job-1', 'second') })
    store.appendAction('add', { job: makeJob('job-2', 'keep') })
    store.appendAction('delete', { jobId: 'job-1' })
    expect(store.load().jobs.map((job) => [job.id, job.name])).toEqual([
      ['job-2', 'keep'],
    ])
    expect(readFileSync(store.actionFile, 'utf8')).toBe('')

    writeFileSync(
      store.actionFile,
      'not json\n' +
        JSON.stringify({ action: 'add', job: makeJob('job-3').toDict() }) +
        '\n' +
        JSON.stringify({ action: 'delete', jobId: '../bad' }) +
        '\n',
      'utf8',
    )
    expect(store.load().jobs.map((job) => job.id)).toContain('job-3')
    expect(
      readdirSync(store.schedulerDir).some((name) =>
        name.startsWith('action.corrupt-'),
      ),
    ).toBe(true)
    expect(store.diagnostics().lastActionErrors).toHaveLength(2)
  })

  it('preserves corrupt jobs store and can return last good snapshot', () => {
    const root = tmp('emperor-scheduler-corrupt-')
    const store = new SchedulerStore(root)
    store.upsertJob(makeJob('job-1'))
    expect(store.load().jobs).toHaveLength(1)
    writeFileSync(store.jobsFile, '{bad', 'utf8')
    expect(
      store.load({ allowLastGood: true }).jobs.map((job) => job.id),
    ).toEqual(['job-1'])

    const fresh = new SchedulerStore(root)
    writeFileSync(fresh.jobsFile, '{bad', 'utf8')
    expect(() => fresh.load({ allowLastGood: false })).toThrow(
      SchedulerStoreCorrupt,
    )
    expect(existsSync(fresh.jobsFile)).toBe(false)
  })
})

describe('scheduler service/tool', () => {
  it('runs a job at most once when manual calls overlap', async () => {
    const root = tmp('emperor-scheduler-single-flight-')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => {}
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    let dispatches = 0
    const events: Array<Record<string, unknown>> = []
    const service = new SchedulerService(new SchedulerStore(root), {
      eventSink: async (event) => {
        events.push(event)
      },
      onJob: async () => {
        dispatches += 1
        entered()
        await gate
      },
    })
    const job = service.addJob({
      name: 'single-flight',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({ message: 'ping' }),
    })
    const first = service.runJob(job.id, { force: true })
    await firstEntered
    const duplicate = service.runJob(job.id, { force: true })
    await Promise.resolve()
    release()

    await expect(first).resolves.toBe(true)
    await expect(duplicate).resolves.toBe(false)
    expect(dispatches).toBe(1)
    expect(
      events.filter((event) => event.event === 'scheduler_run_start'),
    ).toHaveLength(1)
    expect(service.getJob(job.id)?.state.run_history).toHaveLength(1)
  })

  it('computes and validates schedules', () => {
    expect(
      computeNextRunMs(
        new SchedulerSchedule({ kind: 'every', every_ms: 5_000 }),
        1_000,
      ),
    ).toBe(6_000)
    expect(
      computeNextRunMs(
        new SchedulerSchedule({ kind: 'at', at_ms: 900 }),
        1_000,
      ),
    ).toBeNull()
    expect(
      computeNextRunMs(
        new SchedulerSchedule({
          kind: 'cron',
          expr: '0 9 * * *',
          tz: 'Asia/Shanghai',
        }),
        Date.UTC(2026, 0, 1, 0, 0),
      ),
    ).toBe(Date.UTC(2026, 0, 1, 1, 0))
    expect(() =>
      validateSchedule(
        new SchedulerSchedule({ kind: 'cron', expr: 'bad cron', tz: 'UTC' }),
      ),
    ).toThrow(/invalid cron/)
    expect(() =>
      validateSchedule(
        new SchedulerSchedule({
          kind: 'cron',
          expr: '0 9 * * *',
          tz: 'Bad/Zone',
        }),
      ),
    ).toThrow(/unknown timezone/)
  })

  it('runs jobs, records status, handles stale running, and registers protected jobs', async () => {
    const root = tmp('emperor-scheduler-service-')
    const clock = new FakeClock()
    const events: Array<Record<string, unknown>> = []
    const called: string[] = []
    const service = new SchedulerService(new SchedulerStore(root), {
      timeFunc: clock.now,
      eventSink: async (event) => {
        events.push(event)
      },
      onJob: async (job) => {
        called.push(job.id)
        clock.advance(25)
      },
    })
    const job = service.addJob({
      name: 'ping',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({ message: 'hello' }),
    })

    expect(job.state.next_run_at_ms).toBe(clock.value + 60_000)
    expect(await service.runJob(job.id, { force: true })).toBe(true)
    expect(called).toEqual([job.id])
    expect(service.getJob(job.id)?.state.last_status).toBe(SchedulerStatus.OK)
    expect(service.getJob(job.id)?.state.run_history[0]!.duration_ms).toBe(25)
    expect(events.map((event) => event.event)).toEqual([
      'scheduler_run_start',
      'scheduler_run_done',
    ])

    const stale = service.addJob({
      name: 'stale',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({ message: 'hello' }),
    })
    stale.state.last_run_at_ms = clock.value - 250
    stale.state.last_status = SchedulerStatus.RUNNING
    service.store.upsertJob(stale)
    clock.advance(500)
    await service.start()
    service.stop()
    expect(service.getJob(stale.id)?.state.last_status).toBe(
      SchedulerStatus.INTERRUPTED,
    )

    await service.start()
    const protectedIds = service
      .listJobs({ includeDisabled: true })
      .filter((item) => item.protected)
      .map((item) => item.id)
    service.stop()
    expect(protectedIds).toEqual(
      expect.arrayContaining([
        'memory-maintenance',
        'runtime-maintenance',
        'watchlist-check',
      ]),
    )
    expect(service.removeJob('memory-maintenance')).toBe('protected')
  })

  it('never emits ownerless run events: falls back to live target session, then the scheduler pseudo-session', async () => {
    const root = tmp('emperor-scheduler-session-fallback-')
    const clock = new FakeClock()
    const events: Array<Record<string, unknown>> = []
    let liveSession: string | null = 'sess_live'
    const service = new SchedulerService(new SchedulerStore(root), {
      timeFunc: clock.now,
      eventSink: async (event) => {
        events.push(event)
      },
      onJob: async () => undefined,
      targetSessionId: () => liveSession,
    })
    // 创建时 targetSessionId 可用 → payload stamp
    const stamped = service.addJob({
      name: 'stamped',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({ message: 'hello' }),
    })
    liveSession = null
    await service.runJob(stamped.id, { force: true })
    expect(events.every((event) => event.session_id === 'sess_live')).toBe(true)

    // 创建与运行时 targetSessionId 均不可用 → 伪 session 'scheduler'，绝不无主
    events.length = 0
    const orphan = service.addJob({
      name: 'orphan',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({ message: 'hello' }),
    })
    await service.runJob(orphan.id, { force: true })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.session_id === 'scheduler')).toBe(true)
  })

  it('does not lose a concurrent add/remove while another job is executing (audit P0-3)', async () => {
    const root = tmp('emperor-scheduler-race-')
    const clock = new FakeClock()
    const store = new SchedulerStore(root)
    const service = new SchedulerService(store, {
      timeFunc: clock.now,
      onJob: async (job) => {
        if (job.name !== 'running') return
        // 模拟：job 正在执行期间，用户并发触发了增删——不应被本次 tick 结束时的
        // 整表覆盖写悄悄撤销。
        service.addJob({
          name: 'concurrent-add',
          schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
          payload: new SchedulerPayload({ message: 'added mid-tick' }),
        })
        service.removeJob(other.id)
      },
    })

    const running = service.addJob({
      name: 'running',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({ message: 'ping' }),
    })
    const other = service.addJob({
      name: 'other',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({ message: 'unrelated' }),
    })
    running.state.next_run_at_ms = clock.value
    store.upsertJob(running)

    await service.onTimer()

    const names = service
      .listJobs({ includeDisabled: true })
      .map((job) => job.name)
    expect(names).toContain('concurrent-add')
    expect(names).not.toContain('other')
    expect(service.getJob(running.id)?.state.last_status).toBe(
      SchedulerStatus.OK,
    )
  })

  it('arms, re-arms, and clears the service timer around due jobs', async () => {
    const root = tmp('emperor-scheduler-timer-')
    const clock = new FakeClock()
    const timers: Array<{
      handle: number
      delayMs: number
      callback: () => void | Promise<void>
    }> = []
    const cleared: unknown[] = []
    const called: string[] = []
    const service = new SchedulerService(new SchedulerStore(root), {
      timeFunc: clock.now,
      maxSleepMs: 300_000,
      setTimer: (callback, delayMs) => {
        const handle = timers.length + 1
        timers.push({ handle, delayMs, callback })
        return handle
      },
      clearTimer: (handle) => {
        cleared.push(handle)
      },
      onJob: async (job) => {
        called.push(job.id)
      },
    })

    await service.start()
    expect(service.status().misfirePolicy).toBe('skip')
    const initialHandle = timers.at(-1)!.handle
    const job = service.addJob({
      name: 'soon',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({ message: 'ping' }),
    })

    expect(cleared).toContain(initialHandle)
    expect(timers.at(-1)!.delayMs).toBe(60_000)
    clock.advance(60_000)
    await timers.at(-1)!.callback()
    expect(called).toEqual([job.id])
    expect(service.getJob(job.id)?.state.last_status).toBe(SchedulerStatus.OK)
    expect(timers.at(-1)!.delayMs).toBe(60_000)
    const latest = timers.at(-1)!.handle
    service.stop()
    expect(cleared).toContain(latest)
  })

  it.each([
    {
      kind: 'at',
      schedule: (now: number) =>
        new SchedulerSchedule({ kind: 'at', at_ms: now + 10_000 }),
    },
    {
      kind: 'every',
      schedule: () =>
        new SchedulerSchedule({ kind: 'every', every_ms: 20_000 }),
    },
    {
      kind: 'cron',
      schedule: () =>
        new SchedulerSchedule({ kind: 'cron', expr: '* * * * *', tz: 'UTC' }),
    },
  ])('automatically dispatches a due $kind schedule', async ({ schedule }) => {
    const root = tmp('emperor-scheduler-auto-schedule-')
    const clock = new FakeClock()
    clock.value = Date.UTC(2026, 0, 1, 0, 0, 0)
    const callbacks: Array<() => void | Promise<void>> = []
    const called: string[] = []
    const service = new SchedulerService(new SchedulerStore(root), {
      timeFunc: clock.now,
      setTimer: (callback) => {
        callbacks.push(callback)
        return callbacks.length
      },
      clearTimer: () => undefined,
      onJob: async (job) => {
        called.push(job.id)
      },
    })
    const job = service.addJob({
      name: 'automatic schedule',
      schedule: schedule(clock.value),
      payload: new SchedulerPayload({ message: 'run automatically' }),
    })

    await service.start()
    const dueAt = service.getJob(job.id)?.state.next_run_at_ms
    expect(dueAt).not.toBeNull()
    clock.value = dueAt!
    await callbacks.at(-1)!()

    expect(called).toEqual([job.id])
    expect(service.getJob(job.id)?.state.last_status).toBe(SchedulerStatus.OK)
    service.stop()
  })

  it('SchedulerTool adds, lists, pauses, resumes, runs, removes, and rejects recursive creation', async () => {
    const root = tmp('emperor-scheduler-tool-')
    const ran: string[] = []
    const service = new SchedulerService(new SchedulerStore(root), {
      onJob: async (job) => {
        ran.push(job.id)
      },
    })
    const tool = new SchedulerTool(service)

    const created = await tool.execute({
      action: 'add',
      name: 'daily summary',
      payload_kind: 'agent_turn',
      message: 'Summarize today',
      every_seconds: 60,
    })
    expect(created).toContain('Scheduler job created')
    const job = service.listJobs()[0]!
    expect(await tool.execute({ action: 'list' })).toContain('daily summary')
    expect(await tool.execute({ action: 'pause', job_id: job.id })).toContain(
      'paused',
    )
    expect(service.getJob(job.id)?.enabled).toBe(false)
    expect(await tool.execute({ action: 'resume', job_id: job.id })).toContain(
      'resumed',
    )
    expect(await tool.execute({ action: 'run', job_id: job.id })).toContain(
      'run finished',
    )
    expect(ran).toEqual([job.id])
    expect(await tool.execute({ action: 'remove', job_id: job.id })).toContain(
      'removed',
    )

    expect(
      await tool.execute({
        action: 'add',
        payload_kind: 'system_event',
        message: 'internal',
        every_seconds: 60,
      }),
    ).toContain('system_event')
    const token = setSchedulerRun(true)
    try {
      expect(
        await tool.execute({
          action: 'add',
          payload_kind: 'agent_turn',
          message: 'recursive',
          every_seconds: 60,
        }),
      ).toContain('cannot create')
    } finally {
      resetSchedulerRun(token)
    }
  })
})
