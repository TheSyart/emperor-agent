// KRN-10: the scheduler survives a bad job entry, a failing tick, a sleep
// across a trigger and a second process on the same data directory.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SchedulerJob,
  SchedulerMisfirePolicy,
  SchedulerPayload,
  SchedulerRunTrigger,
  SchedulerSchedule,
  SchedulerStatus,
} from './models'
import { SchedulerRunContext, SchedulerService } from './service'
import { SchedulerStore, SchedulerStoreCorrupt } from './store'

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0)
const HOUR = 60 * 60 * 1000

function root(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-scheduler-robust-'))
}

function job(id: string, everyMs = HOUR): SchedulerJob {
  return SchedulerJob.create({
    jobId: id,
    name: id,
    schedule: new SchedulerSchedule({ kind: 'every', every_ms: everyMs }),
    payload: new SchedulerPayload({ kind: 'agent_turn', message: id }),
    now: BASE,
  })
}

/** A service on a fake clock whose timer callbacks are collected. */
function harness(dir = root()) {
  const clock = { now: BASE }
  const timers: Array<() => void | Promise<void>> = []
  const runs: Array<{ id: string; context: SchedulerRunContext }> = []
  const service = new SchedulerService(new SchedulerStore(dir), {
    timeFunc: () => clock.now,
    setTimer: (callback) => {
      timers.push(callback)
      return timers.length
    },
    clearTimer: () => undefined,
    onJob: async (current, context) => {
      // System jobs (memory maintenance) come due on the same clock.
      if (!current.protected) runs.push({ id: current.id, context })
    },
  })
  return { dir, clock, timers, runs, service }
}

const services: SchedulerService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
})

describe('jobs.json tolerates a bad entry (KRN-10 2)', () => {
  it('loads the good jobs and moves the bad one to jobs.rejected.json', () => {
    const dir = root()
    const store = new SchedulerStore(dir)
    store.upsertJob(job('job-good'))
    const raw = JSON.parse(readFileSync(store.jobsFile, 'utf8'))
    raw.jobs.push({
      id: 'job-bad',
      name: '坏任务',
      schedule: { kind: 'yearly' },
    })
    writeFileSync(store.jobsFile, JSON.stringify(raw), 'utf8')

    const fresh = new SchedulerStore(dir)
    expect(
      fresh.load({ allowLastGood: false }).jobs.map((item) => item.id),
    ).toEqual(['job-good'])
    // The original file is not quarantined as a whole.
    expect(existsSync(fresh.jobsFile)).toBe(true)
    const rejectedFile = join(dir, 'scheduler', 'jobs.rejected.json')
    const rejected = JSON.parse(readFileSync(rejectedFile, 'utf8'))
    expect(rejected.jobs).toEqual([
      expect.objectContaining({
        id: 'job-bad',
        name: '坏任务',
        error: expect.stringContaining('yearly'),
        raw: expect.objectContaining({ id: 'job-bad' }),
      }),
    ])
    expect(fresh.diagnostics()).toMatchObject({
      rejectedFile,
      rejectedJobs: [{ id: 'job-bad', name: '坏任务' }],
    })
    // Loading again (and saving the good jobs) does not repeat the entry.
    fresh.upsertJob(job('job-other'))
    new SchedulerStore(dir).load()
    expect(JSON.parse(readFileSync(rejectedFile, 'utf8')).jobs).toHaveLength(1)
  })

  it('says how many jobs were set aside in the status', async () => {
    const { dir, service } = harness()
    const store = new SchedulerStore(dir)
    store.upsertJob(job('job-good'))
    const raw = JSON.parse(readFileSync(store.jobsFile, 'utf8'))
    raw.jobs.push({ id: 'job-bad', schedule: { kind: 'yearly' } })
    writeFileSync(store.jobsFile, JSON.stringify(raw), 'utf8')
    services.push(service)
    await service.start()
    expect(service.status()).toMatchObject({ running: true, rejectedJobs: 1 })
    expect(service.listJobs().map((item) => item.id)).toContain('job-good')
  })
})

describe('a failing tick re-arms the timer (KRN-10 3)', () => {
  it('arms the next timer when the store cannot be read during a tick', async () => {
    const { service, timers, clock, runs } = harness()
    services.push(service)
    service.store.upsertJob(job('job-a'))
    await service.start()
    const armed = timers.length
    const load = service.store.load.bind(service.store)
    let fail = true
    service.store.load = (opts) => {
      if (fail) {
        fail = false
        throw new Error('disk read failed')
      }
      return load(opts)
    }
    await expect(service.onTimer()).rejects.toThrow('disk read failed')
    expect(timers.length).toBe(armed + 1)
    // The next tick runs the job that came due.
    clock.now = BASE + HOUR
    await timers.at(-1)!()
    expect(runs.map((run) => run.id)).toEqual(['job-a'])
  })

  it('arms the next timer when the store is corrupt during a tick', async () => {
    const { service, timers } = harness()
    services.push(service)
    await service.start()
    const armed = timers.length
    const load = service.store.load.bind(service.store)
    let fail = true
    service.store.load = (opts) => {
      if (fail) {
        fail = false
        throw new SchedulerStoreCorrupt('jobs.json is corrupt')
      }
      return load(opts)
    }
    await service.onTimer()
    expect(timers.length).toBe(armed + 1)
  })
})

describe('waking from sleep follows the misfire policy (KRN-10 4, 5)', () => {
  it('skips a job whose trigger passed while asleep under 「skip」', async () => {
    const { service, clock, runs } = harness()
    services.push(service)
    service.store.upsertJob(job('job-skip'))
    await service.start()
    // Asleep from before the trigger at BASE + 1h until BASE + 4h 30m.
    clock.now = BASE + 4.5 * HOUR
    await service.onTimer()
    expect(runs).toEqual([])
    const after = service.getJob('job-skip')!
    expect(after.state.last_status).toBe(SchedulerStatus.SKIPPED)
    expect(after.state.run_history.at(-1)).toMatchObject({
      trigger: SchedulerRunTrigger.MISFIRE,
      status: SchedulerStatus.SKIPPED,
      missed_count: 4,
    })
    expect(after.state.next_run_at_ms).toBe(BASE + 5 * HOUR)
  })

  it('runs a 「补跑一次」 job once after waking, counting what it missed', async () => {
    const { service, clock, runs } = harness()
    services.push(service)
    const item = job('job-catch-up')
    item.misfire_policy = SchedulerMisfirePolicy.CATCH_UP_ONE
    service.store.upsertJob(item)
    await service.start()
    clock.now = BASE + 3.5 * HOUR
    await service.onTimer()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.context).toMatchObject({
      trigger: SchedulerRunTrigger.MISFIRE,
      scheduledForMs: BASE + HOUR,
      missedCount: 3,
    })
    expect(service.getJob('job-catch-up')!.state.next_run_at_ms).toBe(
      BASE + 4 * HOUR,
    )
  })

  it('still runs a job that is only a little late as a normal timer run', async () => {
    const { service, clock, runs } = harness()
    services.push(service)
    service.store.upsertJob(job('job-late'))
    await service.start()
    clock.now = BASE + HOUR + 20_000
    await service.onTimer()
    expect(runs.map((run) => run.context.trigger)).toEqual([
      SchedulerRunTrigger.TIMER,
    ])
  })
})

describe('start failures are kept for diagnostics (KRN-10 1)', () => {
  it('records why start failed and reports it in the status', async () => {
    const { service } = harness()
    services.push(service)
    service.store.save = () => {
      throw new Error('scheduler directory is read-only')
    }
    await expect(service.start()).rejects.toThrow('read-only')
    expect(service.status()).toMatchObject({
      running: false,
      startError: expect.stringContaining('read-only'),
    })
  })

  it('clears the start error once a later start succeeds', async () => {
    const { service } = harness()
    services.push(service)
    const save = service.store.save.bind(service.store)
    service.store.save = () => {
      throw new Error('busy')
    }
    await expect(service.start()).rejects.toThrow('busy')
    service.store.save = save
    await service.start()
    expect(service.status()).toMatchObject({ running: true, startError: null })
  })
})

describe('scheduler.lock (KRN-10)', () => {
  it('does not start while another live process holds the lock', async () => {
    const dir = root()
    const holder = spawn(process.execPath, [
      '-e',
      'setTimeout(() => {}, 60000)',
    ])
    try {
      const store = new SchedulerStore(dir)
      writeFileSync(
        store.lockFile,
        JSON.stringify({ pid: holder.pid, startedAt: BASE }),
        'utf8',
      )
      const { service } = harness(dir)
      services.push(service)
      await expect(service.start()).rejects.toThrow(String(holder.pid))
      expect(service.status()).toMatchObject({
        running: false,
        startError: expect.stringContaining(String(holder.pid)),
      })
    } finally {
      holder.kill()
    }
  })

  it('starts by itself once the process holding the lock exits', async () => {
    const dir = root()
    const holder = spawn(process.execPath, [
      '-e',
      'setTimeout(() => {}, 60000)',
    ])
    writeFileSync(
      new SchedulerStore(dir).lockFile,
      JSON.stringify({ pid: holder.pid, startedAt: BASE }),
      'utf8',
    )
    const { service, timers } = harness(dir)
    services.push(service)
    await expect(service.start()).rejects.toThrow(String(holder.pid))
    const exited = new Promise((resolve) => holder.on('exit', resolve))
    holder.kill()
    await exited
    await timers.at(-1)!()
    expect(service.status()).toMatchObject({ running: true, startError: null })
  })

  it('takes over a lock written before the last reboot, even if its pid is alive again', async () => {
    const dir = root()
    const store = new SchedulerStore(dir)
    // Our parent is alive; the lock says it was written a day before boot.
    const bootAt = Date.now() - uptime() * 1000
    writeFileSync(
      store.lockFile,
      JSON.stringify({
        pid: process.ppid,
        startedAt: bootAt - 86_400_000,
        bootAt: bootAt - 86_400_000,
      }),
      'utf8',
    )
    const { service } = harness(dir)
    services.push(service)
    await service.start()
    expect(service.status().running).toBe(true)
    expect(JSON.parse(readFileSync(store.lockFile, 'utf8'))).toMatchObject({
      pid: process.pid,
      bootAt: expect.any(Number),
    })
  })

  it('takes over a lock whose process is gone, and releases it on stop', async () => {
    const dir = root()
    const store = new SchedulerStore(dir)
    // A pid that is not running (spawned and already exited).
    const gone = spawn(process.execPath, ['-e', ''])
    await new Promise((resolve) => gone.on('exit', resolve))
    writeFileSync(
      store.lockFile,
      JSON.stringify({ pid: gone.pid, startedAt: BASE }),
      'utf8',
    )
    const { service } = harness(dir)
    await service.start()
    expect(JSON.parse(readFileSync(store.lockFile, 'utf8')).pid).toBe(
      process.pid,
    )
    await service.stop()
    expect(existsSync(store.lockFile)).toBe(false)
  })
})
