import { describe, expect, it } from 'vitest'
import type { SchedulerJob } from '../../types'
import {
  canEditSchedulerJob,
  readonlySchedulerTimeFields,
  schedulerMisfirePolicyLabel,
  schedulerMisfirePolicyOptions,
  schedulerRunStatusLabel,
} from './schedulerPanelModel'

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

describe('scheduler panel model', () => {
  it('marks protected system jobs as not editable', () => {
    expect(
      canEditSchedulerJob(
        job({
          protected: true,
          payload: { kind: 'system_event', message: '' },
        }),
      ),
    ).toBe(false)
    expect(canEditSchedulerJob(job({ protected: false }))).toBe(true)
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
  })
})
