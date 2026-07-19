import { describe, expect, it } from 'vitest'
import {
  SchedulerActiveRun,
  SchedulerJob,
  SchedulerMisfirePolicy,
  SchedulerPayload,
  SchedulerPendingMisfire,
  SchedulerRunTrigger,
  SchedulerSchedule,
} from './models'
import { occurrenceWindow, resolveStartupMisfire } from './misfire'

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0)

describe('scheduler compatible run metadata', () => {
  it('defaults an old V1 job and run history to skip-safe fields', () => {
    const old = SchedulerJob.fromDict({
      id: 'old-job',
      name: 'Old job',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'agent_turn', message: 'run' },
      state: {
        nextRunAtMs: BASE + 60_000,
        lastRunAtMs: BASE,
        lastStatus: 'ok',
        runHistory: [{ runAtMs: BASE, status: 'ok', durationMs: 12 }],
      },
      createdAtMs: BASE,
      updatedAtMs: BASE,
    })

    expect(old.misfire_policy).toBe(SchedulerMisfirePolicy.SKIP)
    expect(old.state.pending_misfire).toBeNull()
    expect(old.state.active_run).toBeNull()
    expect(old.state.run_history[0]!.toDict()).toMatchObject({
      runId: null,
      taskId: null,
      scheduledForMs: BASE,
      trigger: SchedulerRunTrigger.TIMER,
      misfirePolicy: SchedulerMisfirePolicy.SKIP,
      missedCount: 1,
      countCapped: false,
    })
  })

  it('round-trips pending and active run metadata without exposing snake_case on disk', () => {
    const pending = new SchedulerPendingMisfire({
      policy: SchedulerMisfirePolicy.LATEST,
      scheduled_for_ms: BASE,
      detected_at_ms: BASE + 10_000,
      missed_count: 3,
      count_capped: false,
    })
    const active = new SchedulerActiveRun({
      run_id: `schrun_${'a'.repeat(32)}`,
      task_id: `scheduler_run_${'b'.repeat(32)}`,
      phase: 'queued',
      trigger: SchedulerRunTrigger.MISFIRE,
      scheduled_for_ms: BASE,
      enqueued_at_ms: BASE + 10_000,
      started_at_ms: null,
      owner_key_digest: 'c'.repeat(64),
      misfire_policy: SchedulerMisfirePolicy.LATEST,
      missed_count: 3,
      count_capped: false,
      resume_next_run_at_ms: BASE + 60_000,
    })
    const job = SchedulerJob.create({
      jobId: 'round-trip',
      name: 'Round trip',
      schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      payload: new SchedulerPayload({ message: 'run' }),
      misfirePolicy: SchedulerMisfirePolicy.LATEST,
      now: BASE,
    })
    job.state.pending_misfire = pending
    job.state.active_run = active

    const encoded = job.toDict()
    const decoded = SchedulerJob.fromDict(encoded)
    expect(encoded.misfirePolicy).toBe('latest')
    expect(encoded.state.pendingMisfire).toEqual(pending.toDict())
    expect(encoded.state.activeRun).toEqual(active.toDict())
    expect(JSON.stringify(encoded)).not.toContain('owner_key_digest')
    expect(decoded.toDict()).toEqual(encoded)
  })

  it.each([
    { activeRun: { phase: 'unknown' } },
    { activeRun: { runId: '../bad' } },
    { activeRun: { ownerKeyDigest: 'bad' } },
    { activeRun: { scheduledForMs: Number.NaN } },
    { pendingMisfire: { policy: 'replay-all' } },
    { pendingMisfire: { missedCount: 0 } },
    { misfirePolicy: 'replay-all' },
  ])('rejects malformed optional durable run state: %#', (override) => {
    const validActive = {
      runId: `schrun_${'a'.repeat(32)}`,
      taskId: `scheduler_run_${'b'.repeat(32)}`,
      phase: 'queued',
      trigger: 'misfire',
      scheduledForMs: BASE,
      enqueuedAtMs: BASE,
      startedAtMs: null,
      ownerKeyDigest: 'c'.repeat(64),
      misfirePolicy: 'latest',
      missedCount: 1,
      countCapped: false,
      resumeNextRunAtMs: null,
    }
    const validPending = {
      policy: 'latest',
      scheduledForMs: BASE,
      detectedAtMs: BASE,
      missedCount: 1,
      countCapped: false,
    }
    expect(() =>
      SchedulerJob.fromDict({
        id: 'invalid-durable-state',
        name: 'Invalid',
        schedule: { kind: 'every', everyMs: 60_000 },
        payload: { kind: 'agent_turn', message: 'run' },
        misfirePolicy: override.misfirePolicy,
        state: {
          activeRun: { ...validActive, ...(override.activeRun ?? {}) },
          pendingMisfire: {
            ...validPending,
            ...(override.pendingMisfire ?? {}),
          },
        },
      }),
    ).toThrow(/scheduler (active run|pending misfire|job misfire)/)
  })
})

describe('scheduler startup misfire resolution', () => {
  it.each([
    {
      policy: SchedulerMisfirePolicy.SKIP,
      kind: 'skip',
      scheduledForMs: BASE,
    },
    {
      policy: SchedulerMisfirePolicy.LATEST,
      kind: 'queue',
      scheduledForMs: BASE + 3 * 60_000,
    },
    {
      policy: SchedulerMisfirePolicy.CATCH_UP_ONE,
      kind: 'queue',
      scheduledForMs: BASE,
    },
  ])(
    'resolves every/$policy to one bounded startup decision',
    ({ policy, kind, scheduledForMs }) => {
      const schedule = new SchedulerSchedule({
        kind: 'every',
        every_ms: 60_000,
      })
      const result = resolveStartupMisfire(
        schedule,
        policy,
        BASE,
        BASE + 3 * 60_000 + 30_000,
      )
      expect(result).toMatchObject({
        kind,
        scheduledForMs,
        window: {
          firstMissedMs: BASE,
          latestMissedMs: BASE + 3 * 60_000,
          nextFutureMs: BASE + 4 * 60_000,
          missedCount: 4,
          countCapped: false,
        },
      })
    },
  )

  it.each([
    SchedulerMisfirePolicy.SKIP,
    SchedulerMisfirePolicy.LATEST,
    SchedulerMisfirePolicy.CATCH_UP_ONE,
  ])('treats an expired at schedule as one occurrence for %s', (policy) => {
    const result = resolveStartupMisfire(
      new SchedulerSchedule({ kind: 'at', at_ms: BASE }),
      policy,
      BASE,
      BASE + 10_000,
    )
    expect(result).toMatchObject({
      kind: policy === SchedulerMisfirePolicy.SKIP ? 'skip' : 'queue',
      scheduledForMs: BASE,
      window: {
        firstMissedMs: BASE,
        latestMissedMs: BASE,
        nextFutureMs: null,
        missedCount: 1,
      },
    })
  })

  it.each([
    {
      policy: SchedulerMisfirePolicy.SKIP,
      kind: 'skip',
      scheduledForMs: Date.UTC(2026, 0, 1, 1, 0, 0),
    },
    {
      policy: SchedulerMisfirePolicy.LATEST,
      kind: 'queue',
      scheduledForMs: Date.UTC(2026, 0, 3, 1, 0, 0),
    },
    {
      policy: SchedulerMisfirePolicy.CATCH_UP_ONE,
      kind: 'queue',
      scheduledForMs: Date.UTC(2026, 0, 1, 1, 0, 0),
    },
  ])(
    'resolves timezone cron/$policy without replaying every miss',
    ({ policy, kind, scheduledForMs }) => {
      const result = resolveStartupMisfire(
        new SchedulerSchedule({
          kind: 'cron',
          expr: '0 9 * * *',
          tz: 'Asia/Shanghai',
        }),
        policy,
        Date.UTC(2026, 0, 1, 1, 0, 0),
        Date.UTC(2026, 0, 3, 2, 0, 0),
      )
      expect(result).toMatchObject({
        kind,
        scheduledForMs,
        window: {
          missedCount: 3,
          countCapped: false,
          nextFutureMs: Date.UTC(2026, 0, 4, 1, 0, 0),
        },
      })
    },
  )

  it('does not misclassify an occurrence due exactly at startup', () => {
    const result = resolveStartupMisfire(
      new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
      SchedulerMisfirePolicy.SKIP,
      BASE,
      BASE,
    )
    expect(result).toEqual({ kind: 'none', nextRunAtMs: BASE })
  })

  it('caps a high-frequency cron history while retaining exact latest/next times', () => {
    const schedule = new SchedulerSchedule({
      kind: 'cron',
      expr: '* * * * * *',
      tz: 'UTC',
    })
    const result = occurrenceWindow(schedule, BASE, BASE + 20_000_000)
    expect(result).toMatchObject({
      firstMissedMs: BASE,
      latestMissedMs: BASE + 20_000_000,
      nextFutureMs: BASE + 20_001_000,
      missedCount: 10_000,
      countCapped: true,
    })
  })

  it('keeps cron occurrences ordered across a daylight-saving boundary', () => {
    const schedule = new SchedulerSchedule({
      kind: 'cron',
      expr: '30 2 * * *',
      tz: 'America/New_York',
    })
    const first = Date.UTC(2026, 2, 7, 7, 30, 0)
    const result = occurrenceWindow(
      schedule,
      first,
      Date.UTC(2026, 2, 10, 12, 0, 0),
    )
    expect(result.firstMissedMs).toBe(first)
    expect(result.latestMissedMs).toBeGreaterThanOrEqual(first)
    expect(result.latestMissedMs).toBeLessThanOrEqual(
      Date.UTC(2026, 2, 10, 12, 0, 0),
    )
    expect(result.nextFutureMs).toBeGreaterThan(Date.UTC(2026, 2, 10, 12, 0, 0))
  })

  it('rejects invalid intervals instead of inventing a future occurrence', () => {
    expect(() =>
      occurrenceWindow(
        new SchedulerSchedule({ kind: 'every', every_ms: 0 }),
        BASE,
        BASE + 1,
      ),
    ).toThrow(/every_ms/)
  })
})
