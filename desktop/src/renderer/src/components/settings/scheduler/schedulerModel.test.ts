import { describe, expect, it } from 'vitest'
import type { SchedulerJob } from '../../../types'
import {
  buildSchedule,
  canEditSchedulerJob,
  createJobInput,
  DEFAULT_JOB_NAME,
  draftFromJob,
  emptyJobDraft,
  formatDuration,
  payloadLabel,
  readonlySchedulerTimeFields,
  runDetail,
  runHistory,
  runKey,
  scheduleLabel,
  schedulerJobStatus,
  schedulerMisfirePolicyLabel,
  schedulerMisfirePolicyOptions,
  schedulerRunStatusLabel,
  schedulerRunStatusTone,
  schedulerSummary,
  toLocalInputValue,
  updateJobInput,
} from './schedulerModel'

function job(overrides: Partial<SchedulerJob> = {}): SchedulerJob {
  return {
    id: 'job_1',
    name: 'Demo',
    enabled: true,
    schedule: { kind: 'every', everyMs: 60_000 },
    payload: { kind: 'agent_turn', message: 'Run' },
    state: { nextRunAtMs: 1000, lastRunAtMs: 500, lastStatus: 'ok' },
    createdAtMs: 100,
    updatedAtMs: 200,
    ...overrides,
  }
}

describe('scheduler model', () => {
  it('marks protected system jobs as not editable', () => {
    expect(
      canEditSchedulerJob(
        job({
          protected: true,
          payload: { kind: 'system_event', message: '' },
        }),
      ),
    ).toBe(false)
    expect(
      canEditSchedulerJob(
        job({ payload: { kind: 'system_event', message: '' } }),
      ),
    ).toBe(false)
    expect(canEditSchedulerJob(job({ protected: false }))).toBe(true)
    expect(canEditSchedulerJob(null)).toBe(false)
  })

  it('keeps scheduler time metadata read-only', () => {
    expect(readonlySchedulerTimeFields()).toEqual([
      'createdAtMs',
      'updatedAtMs',
      'nextRunAtMs',
      'lastRunAtMs',
    ])
  })

  it('projects closed policy and terminal status labels', () => {
    expect(schedulerMisfirePolicyOptions()).toEqual([
      { value: 'skip', label: '跳过（默认）' },
      { value: 'latest', label: '只运行最近一次' },
      { value: 'catch-up-one', label: '补跑最早一次' },
    ])
    expect(schedulerMisfirePolicyLabel('latest')).toBe('只运行最近一次')
    expect(schedulerMisfirePolicyLabel('invalid')).toBe('跳过（默认）')
    expect(schedulerRunStatusLabel('interrupted')).toBe('已中断')
    expect(schedulerRunStatusLabel('cancelled')).toBe('已取消')
    expect(schedulerRunStatusLabel(null)).toBe('-')
    expect(schedulerRunStatusTone('ok')).toBe('ok')
    expect(schedulerRunStatusTone('error')).toBe('error')
    expect(schedulerRunStatusTone('interrupted')).toBe('warn')
    expect(schedulerRunStatusTone('skipped')).toBe('neutral')
  })

  it('derives the job status by priority', () => {
    const activeRun = {
      runId: 'r',
      taskId: 't',
      trigger: 'manual' as const,
      scheduledForMs: 1,
      enqueuedAtMs: 1,
      startedAtMs: null,
      misfirePolicy: 'skip' as const,
      missedCount: 1,
      countCapped: false,
    }
    expect(
      schedulerJobStatus(
        job({ state: { activeRun: { ...activeRun, phase: 'running' } } }),
      ),
    ).toEqual({ label: '运行中', tone: 'accent' })
    expect(
      schedulerJobStatus(
        job({ state: { activeRun: { ...activeRun, phase: 'queued' } } }),
      ).label,
    ).toBe('排队中')
    expect(schedulerJobStatus(job({ enabled: false })).label).toBe('已暂停')
    expect(schedulerJobStatus(job({ state: { lastStatus: 'error' } }))).toEqual(
      { label: '异常', tone: 'error' },
    )
    expect(schedulerJobStatus(job())).toEqual({ label: '已启用', tone: 'ok' })
  })

  it('labels schedules, payloads and durations', () => {
    expect(scheduleLabel(job())).toBe('每隔 1 分钟')
    expect(
      scheduleLabel(job({ schedule: { kind: 'every', everyMs: 3_600_000 } })),
    ).toBe('每隔 1 小时')
    expect(
      scheduleLabel(
        job({ schedule: { kind: 'every', everyMs: 7 * 86_400_000 } }),
      ),
    ).toBe('每隔 7 天')
    expect(
      scheduleLabel(
        job({ schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' } }),
      ),
    ).toBe('Cron：0 9 * * * · UTC')
    expect(scheduleLabel(job({ schedule: { kind: 'cron' } }))).toBe(
      'Cron：- · 本地时区',
    )
    expect(scheduleLabel(job({ schedule: { kind: 'at', atMs: 0 } }))).toBe(
      '指定时间：-',
    )
    expect(payloadLabel(job())).toBe(DEFAULT_JOB_NAME)
    expect(
      payloadLabel(
        job({ payload: { kind: 'team_wake', message: '', target: 'bob' } }),
      ),
    ).toBe('唤醒队友 · bob')
    expect(
      payloadLabel(job({ payload: { kind: 'system_event', message: '' } })),
    ).toBe('系统事件')
    expect(formatDuration(90_000)).toBe('2 分钟')
    expect(formatDuration(1500)).toBe('2 秒')
    expect(formatDuration(12)).toBe('12 毫秒')
  })

  it('round-trips a job through the edit draft', () => {
    const atMs = Date.parse('2026-09-23T01:30:00.000Z')
    const draft = draftFromJob(
      job({
        schedule: { kind: 'at', atMs },
        payload: { kind: 'agent_turn', message: 'Ping', deliver: false },
        deleteAfterRun: true,
        misfirePolicy: 'latest',
      }),
    )
    expect(draft).toMatchObject({
      name: 'Demo',
      message: 'Ping',
      deliver: false,
      deleteAfterRun: true,
      misfirePolicy: 'latest',
      scheduleKind: 'at',
      atLocal: toLocalInputValue(atMs),
      everyMinutes: 60,
      cronExpr: '0 9 * * *',
    })
    expect(buildSchedule(draft)).toEqual({ kind: 'at', atMs })
  })

  it('builds schedules with fallbacks', () => {
    const base = emptyJobDraft()
    expect(buildSchedule({ ...base, everyMinutes: 0 })).toEqual({
      kind: 'every',
      everyMs: 60_000,
    })
    expect(buildSchedule({ ...base, everyMinutes: 15 })).toEqual({
      kind: 'every',
      everyMs: 15 * 60_000,
    })
    expect(
      buildSchedule({ ...base, scheduleKind: 'at', atLocal: '' }, 1_000),
    ).toEqual({ kind: 'at', atMs: 1_000 + 60 * 60 * 1000 })
    expect(
      buildSchedule({
        ...base,
        scheduleKind: 'cron',
        cronExpr: '  ',
        cronTz: ' ',
      }),
    ).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })
  })

  it('creates main-agent jobs and keeps payload identity on update', () => {
    const draft = { ...emptyJobDraft(), message: '  整理日报  ' }
    expect(createJobInput(draft)).toEqual({
      name: DEFAULT_JOB_NAME,
      schedule: { kind: 'every', everyMs: 60 * 60_000 },
      payload: {
        kind: 'agent_turn',
        message: '整理日报',
        target: null,
        deliver: true,
      },
      deleteAfterRun: false,
      misfirePolicy: 'skip',
    })

    const teamJob = job({
      payload: {
        kind: 'team_wake',
        message: 'old',
        target: 'reviewer',
        projectId: 'p1',
        meta: { a: 1 },
      },
    })
    const update = updateJobInput(teamJob, {
      ...draftFromJob(teamJob),
      name: ' ',
      message: 'new',
    })
    expect(update.name).toBe('Demo')
    expect(update.payload).toEqual({
      kind: 'team_wake',
      message: 'new',
      target: 'reviewer',
      projectId: 'p1',
      deliver: true,
      meta: { a: 1 },
    })
  })

  it('orders run history newest first with stable keys', () => {
    const runs = [
      { runAtMs: 1, status: 'ok', durationMs: 1200 },
      { runId: 'run_2', runAtMs: 2, status: 'error', error: 'boom' },
    ]
    const history = runHistory(job({ state: { runHistory: runs } }))
    expect(history.map((run) => run.runAtMs)).toEqual([2, 1])
    expect(runKey(history[0]!)).toBe('run_2')
    expect(runKey(history[1]!)).toBe('1-ok-1200-')
    expect(
      runDetail({ ...runs[0]!, missedCount: 3, countCapped: true }),
    ).toMatch(/1 秒 · 3 次计划（计数已封顶）$/)
    expect(runHistory(null)).toEqual([])
  })

  it('summarizes the scheduler service in one line', () => {
    expect(
      schedulerSummary({
        status: {
          running: true,
          jobs: 2,
          enabled: 1,
          nextRunAtMs: null,
          active: 1,
          queued: 2,
          maxConcurrentRuns: 3,
          maxPerOwner: 1,
        },
        jobs: [job(), job({ id: 'job_2' })],
      }).map((item) => item.text),
    ).toEqual(['2 个任务', '1 个启用', '并发 1/3', '排队 2', '每会话 1'])
    const withNext = schedulerSummary({
      status: { running: true, jobs: 0, enabled: 0, nextRunAtMs: 5_000 },
      jobs: [],
    })
    expect(withNext[2]!.text).toMatch(/^下次 \d{2}-\d{2} \d{2}:\d{2}$/)
    expect(withNext.at(-1)!.title).toBe('同一会话上限 1')
  })
})
