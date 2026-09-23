import { describe, expect, it } from 'vitest'
import type { SchedulerJob } from '../../../types'
import {
  buildSchedule,
  canEditSchedulerJob,
  createJobInput,
  cronLabelZh,
  DEFAULT_JOB_NAME,
  draftFromJob,
  emptyJobDraft,
  filterSchedulerJobs,
  formatDateTimeZh,
  formatDuration,
  normalizeSchedulerFilter,
  payloadLabel,
  readonlySchedulerTimeFields,
  runDetail,
  runHistory,
  relativeNextRunZh,
  runKey,
  scheduleLabelZh,
  schedulerJobBucket,
  schedulerJobLine,
  schedulerJobStatus,
  schedulerMisfirePolicyLabel,
  schedulerMisfirePolicyOptions,
  schedulerRunStatusLabel,
  schedulerRowState,
  schedulerRunStatusTone,
  schedulerSummary,
  schedulerTemplateDraft,
  SCHEDULER_TEMPLATES,
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

  it('labels payloads and durations', () => {
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

describe('scheduler list model', () => {
  const HOUR = 3_600_000
  const DAY = 24 * HOUR
  // Local wall-clock instants, so the copy does not depend on the test TZ.
  const now = new Date(2026, 8, 23, 10, 0).getTime()
  const opts = { now, timeZone: 'Asia/Shanghai' }

  function cron(expr: string, tz?: string) {
    return job({ schedule: { kind: 'cron', expr, tz: tz ?? 'Asia/Shanghai' } })
  }

  it('buckets jobs: enabled, paused, and one-shot jobs that already ran', () => {
    expect(schedulerJobBucket(job())).toBe('enabled')
    expect(schedulerJobBucket(job({ enabled: false }))).toBe('paused')
    const at = { kind: 'at' as const, atMs: now - HOUR }
    expect(
      schedulerJobBucket(
        job({ enabled: false, schedule: at, state: { lastRunAtMs: now } }),
      ),
    ).toBe('completed')
    // A one-shot job that never ran was paused, not completed.
    expect(
      schedulerJobBucket(
        job({ enabled: false, schedule: at, state: { lastRunAtMs: null } }),
      ),
    ).toBe('paused')
    // Still scheduled: enabled even if an earlier manual run happened.
    expect(
      schedulerJobBucket(job({ schedule: at, state: { lastRunAtMs: now } })),
    ).toBe('enabled')
  })

  it('filters by bucket and searches name, prompt, id and purpose', () => {
    const jobs = [
      job({ id: 'job_a', name: '每日摘要' }),
      job({
        id: 'job_b',
        name: 'Weekly',
        enabled: false,
        payload: { kind: 'agent_turn', message: '整理周报' },
      }),
      job({
        id: 'job_c',
        name: '提醒',
        enabled: false,
        schedule: { kind: 'at', atMs: now },
        state: { lastRunAtMs: now },
        purpose: 'Release reminder',
      }),
    ]
    const ids = (list: SchedulerJob[]) => list.map((item) => item.id)
    expect(ids(filterSchedulerJobs(jobs))).toEqual(['job_a', 'job_b', 'job_c'])
    expect(ids(filterSchedulerJobs(jobs, { filter: 'enabled' }))).toEqual([
      'job_a',
    ])
    expect(ids(filterSchedulerJobs(jobs, { filter: 'paused' }))).toEqual([
      'job_b',
    ])
    expect(ids(filterSchedulerJobs(jobs, { filter: 'completed' }))).toEqual([
      'job_c',
    ])
    expect(ids(filterSchedulerJobs(jobs, { query: ' 周报 ' }))).toEqual([
      'job_b',
    ])
    expect(ids(filterSchedulerJobs(jobs, { query: 'RELEASE' }))).toEqual([
      'job_c',
    ])
    expect(ids(filterSchedulerJobs(jobs, { query: 'job_a' }))).toEqual([
      'job_a',
    ])
    expect(
      filterSchedulerJobs(jobs, { query: '周报', filter: 'enabled' }),
    ).toEqual([])
    expect(normalizeSchedulerFilter('paused')).toBe('paused')
    expect(normalizeSchedulerFilter('nope')).toBe('all')
  })

  it('reads common cron shapes in Chinese', () => {
    expect(cronLabelZh('0 18 * * 5')).toBe('星期五（时间：18:00）')
    expect(cronLabelZh('0 18 * * FRI')).toBe('星期五（时间：18:00）')
    expect(cronLabelZh('0 9 * * 1-5')).toBe('工作日（时间：09:00）')
    expect(cronLabelZh('0 10 * * 0,6')).toBe('周末（时间：10:00）')
    expect(cronLabelZh('0 10 * * 6-7')).toBe('周末（时间：10:00）')
    expect(cronLabelZh('0 9 * * 1,3,5')).toBe(
      '星期一、星期三、星期五（时间：09:00）',
    )
    expect(cronLabelZh('0 9 * * 7')).toBe('星期日（时间：09:00）')
    expect(cronLabelZh('30 8 * * *')).toBe('每天（时间：08:30）')
    expect(cronLabelZh('0 9 1 * *')).toBe('每月 1 日（时间：09:00）')
    expect(cronLabelZh('*/15 * * * *')).toBe('每 15 分钟')
    expect(cronLabelZh('0 */2 * * *')).toBe('每 2 小时')
    expect(cronLabelZh('15 * * * *')).toBe('每小时（第 15 分）')
    expect(cronLabelZh('0 0 9 * * 5')).toBe('星期五（时间：09:00）')
    // Shapes without a short reading fall back to the raw expression.
    expect(cronLabelZh('0 9 1-7 * 1')).toBeNull()
    expect(cronLabelZh('0 9 * 1 *')).toBeNull()
    expect(cronLabelZh('30 0 9 * * *')).toBeNull()
    expect(cronLabelZh('0 25 * * *')).toBeNull()
    expect(cronLabelZh('not cron')).toBeNull()
  })

  it('labels every / at / cron schedules for a row', () => {
    const every = (everyMs: number) =>
      scheduleLabelZh(job({ schedule: { kind: 'every', everyMs } }), opts)
    expect(every(2 * HOUR)).toBe('每 2 小时')
    expect(every(HOUR)).toBe('每小时')
    expect(every(90 * 60_000)).toBe('每 90 分钟')
    expect(every(DAY)).toBe('每天')
    expect(every(3 * DAY)).toBe('每 3 天')
    expect(every(7 * DAY)).toBe('每周')
    expect(every(14 * DAY)).toBe('每 2 周')
    expect(every(30_000)).toBe('每 30 秒')

    const at = new Date(2026, 8, 30, 9, 0).getTime()
    expect(
      scheduleLabelZh(job({ schedule: { kind: 'at', atMs: at } }), opts),
    ).toBe('9月30日 09:00 一次')
    const nextYear = new Date(2027, 0, 2, 7, 5).getTime()
    expect(
      scheduleLabelZh(job({ schedule: { kind: 'at', atMs: nextYear } }), opts),
    ).toBe('2027年1月2日 07:05 一次')
    expect(
      scheduleLabelZh(job({ schedule: { kind: 'at', atMs: null } }), opts),
    ).toBe('一次性任务')
    expect(formatDateTimeZh(at, now)).toBe('9月30日 09:00')

    expect(scheduleLabelZh(cron('0 18 * * 5'), opts)).toBe(
      '星期五（时间：18:00）',
    )
    // Another zone than the local one is named.
    expect(scheduleLabelZh(cron('0 9 * * *', 'UTC'), opts)).toBe(
      '每天（时间：09:00，UTC）',
    )
    expect(scheduleLabelZh(cron('*/5 * * * *', 'UTC'), opts)).toBe(
      '每 5 分钟（UTC）',
    )
    expect(scheduleLabelZh(cron('0 9 1-7 * 1'), opts)).toBe('Cron：0 9 1-7 * 1')
    expect(scheduleLabelZh(cron('0 9 1-7 * 1', 'UTC'), opts)).toBe(
      'Cron：0 9 1-7 * 1（UTC）',
    )
  })

  it('phrases the next run relative to now', () => {
    expect(relativeNextRunZh(now + 3 * DAY, now)).toBe('下次运行 3天后')
    expect(relativeNextRunZh(now + 2 * HOUR, now)).toBe('下次运行 2小时后')
    expect(relativeNextRunZh(now + 23.6 * HOUR, now)).toBe('下次运行 1天后')
    expect(relativeNextRunZh(now + 5 * 60_000, now)).toBe('下次运行 5分钟后')
    expect(relativeNextRunZh(now + 59.5 * 60_000, now)).toBe('下次运行 1小时后')
    expect(relativeNextRunZh(now + 30_000, now)).toBe('即将运行')
    expect(relativeNextRunZh(now - HOUR, now)).toBe('即将运行')
    expect(relativeNextRunZh(null, now)).toBe('')
    expect(relativeNextRunZh(undefined, now)).toBe('')
  })

  it('builds the row line from the schedule and the job state', () => {
    const friday = cron('0 18 * * 5')
    expect(
      schedulerJobLine(
        { ...friday, state: { nextRunAtMs: now + 3 * DAY } },
        opts,
      ),
    ).toBe('星期五（时间：18:00） · 下次运行 3天后')
    expect(
      schedulerJobLine({ ...friday, enabled: false, state: {} }, opts),
    ).toBe('星期五（时间：18:00） · 已暂停')
    expect(schedulerJobLine({ ...friday, state: {} }, opts)).toBe(
      '星期五（时间：18:00）',
    )
    const done = job({
      enabled: false,
      schedule: { kind: 'at', atMs: new Date(2026, 8, 20, 9, 0).getTime() },
      state: { lastRunAtMs: now - DAY },
    })
    expect(schedulerJobLine(done, opts)).toBe('9月20日 09:00 一次 · 已完成')
    const activeRun = {
      runId: 'r',
      taskId: 't',
      trigger: 'manual' as const,
      scheduledForMs: 1,
      enqueuedAtMs: 1,
      startedAtMs: 1,
      misfirePolicy: 'skip' as const,
      missedCount: 1,
      countCapped: false,
    }
    const running = job({
      state: { activeRun: { ...activeRun, phase: 'running' } },
    })
    expect(schedulerRowState(running)).toBe('running')
    expect(schedulerJobLine(running, opts)).toBe('每 1 分钟 · 正在运行')
    expect(
      schedulerRowState(
        job({ state: { activeRun: { ...activeRun, phase: 'queued' } } }),
      ),
    ).toBe('queued')
    expect(schedulerRowState(job({ state: { lastStatus: 'error' } }))).toBe(
      'error',
    )
    expect(schedulerRowState(done)).toBe('completed')
    expect(schedulerRowState(job({ enabled: false }))).toBe('paused')
    expect(schedulerRowState(job())).toBe('enabled')
  })

  it('prefills the create templates as cron drafts', () => {
    expect(SCHEDULER_TEMPLATES.map((item) => item.id)).toEqual([
      'daily-digest',
      'weekly-review',
    ])
    const daily = schedulerTemplateDraft('daily-digest')
    expect(daily).toMatchObject({
      name: '每日摘要',
      scheduleKind: 'cron',
      cronExpr: '0 9 * * 1-5',
    })
    expect(daily.message.trim()).not.toBe('')
    expect(cronLabelZh(daily.cronExpr)).toBe('工作日（时间：09:00）')
    const weekly = schedulerTemplateDraft('weekly-review')
    expect(cronLabelZh(weekly.cronExpr)).toBe('星期五（时间：18:00）')
  })
})
