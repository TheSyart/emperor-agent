import { describe, expect, it } from 'vitest'
import type { BootstrapPayload, SchedulerJob, WsEvent } from '../../types'
import { applySchedulerEventToBootstrap } from './scheduler'

function job(lastStatus: SchedulerJob['state']['lastStatus']): SchedulerJob {
  return {
    id: 'job-1',
    name: 'nightly',
    enabled: true,
    schedule: { kind: 'every', everyMs: 60_000 },
    payload: { kind: 'agent_turn', message: 'run' },
    state: {
      nextRunAtMs: 1_700_000_060_000,
      lastStatus,
      runHistory: [],
    },
    misfirePolicy: 'skip',
  }
}

function bootstrap(): BootstrapPayload {
  return {
    scheduler: {
      status: {
        running: true,
        jobs: 0,
        enabled: 0,
        active: 0,
        queued: 0,
        maxConcurrentRuns: 2,
        maxPerOwner: 1,
        maxQueuedRuns: 100,
        shutdownPolicy: 'cancel-and-interrupt',
      },
      jobs: [],
    },
  } as unknown as BootstrapPayload
}

describe('Scheduler runtime projection', () => {
  it.each([
    ['scheduler_run_skipped', 'skipped'],
    ['scheduler_run_interrupted', 'interrupted'],
  ] as const)('projects %s terminal receipts', (event, status) => {
    const boot = bootstrap()
    const data = {
      event,
      job: job(status),
      run_id: 'schrun_1234',
      task_id: 'scheduler_run_1234',
      reason: status,
    } as unknown as WsEvent

    applySchedulerEventToBootstrap(boot, data)

    expect(boot.scheduler?.jobs).toEqual([
      expect.objectContaining({
        id: 'job-1',
        state: expect.objectContaining({ lastStatus: status }),
      }),
    ])
    expect(boot.scheduler?.status).toMatchObject({
      jobs: 1,
      enabled: 1,
      nextRunAtMs: 1_700_000_060_000,
    })
  })
})
