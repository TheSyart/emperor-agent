import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { schedulerPayloadSessionId } from '../../../scheduler/models'
import { SchedulerService } from '../../../scheduler/service'
import { SchedulerStore } from '../../../scheduler/store'
import { ToolRegistry } from '../registry'
import { createSchedulerTool } from './scheduler'

function setup(opts: { nested?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-scheduler-tool-'))
  const service = new SchedulerService(new SchedulerStore(root))
  const tools = new ToolRegistry()
  tools.register(
    createSchedulerTool({
      service,
      sessionIdOf: () => 'session-a',
      inSchedulerRun: () => opts.nested === true,
    }),
  )
  const call = async (args: Record<string, unknown>) => {
    const result = await tools.execute({
      callId: 'c',
      name: 'scheduler',
      arguments: args,
      signal: new AbortController().signal,
    })
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
    return { isError: result.isError, text }
  }
  return { service, call }
}

describe('scheduler tool', () => {
  it('lists, creates a session-bound job, pauses, and removes it', async () => {
    const { service, call } = setup()
    expect((await call({ action: 'list' })).text).toBe(
      'No scheduler jobs configured.',
    )
    const created = await call({
      action: 'add',
      message: 'Review inbox',
      every_seconds: 3600,
    })
    expect(created.isError).toBe(false)
    const job = service
      .listJobs({ includeDisabled: true })
      .find((item) => !item.protected)!
    expect(schedulerPayloadSessionId(job.payload)).toBe('session-a')
    expect((await call({ action: 'list' })).text).toContain(job.id)
    expect((await call({ action: 'pause', job_id: job.id })).text).toContain(
      'paused',
    )
    expect((await call({ action: 'remove', job_id: job.id })).text).toContain(
      'removed',
    )
  })

  it('rejects ambiguous schedules, missing ids, and nested creation', async () => {
    const { call } = setup()
    expect(
      (
        await call({
          action: 'add',
          message: 'x',
          every_seconds: 60,
          cron_expr: '* * * * *',
        })
      ).isError,
    ).toBe(true)
    expect((await call({ action: 'remove' })).isError).toBe(true)
    const nested = setup({ nested: true })
    const result = await nested.call({
      action: 'add',
      message: 'x',
      every_seconds: 60,
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('while running')
  })
})
