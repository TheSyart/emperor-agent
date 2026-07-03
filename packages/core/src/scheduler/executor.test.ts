import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActiveTaskRegistry } from '../runtime/active'
import { TaskManager } from '../tasks/manager'
import { TaskStatus } from '../tasks/models'
import { WatchlistDecision } from '../watchlist/models'
import { SCHEDULER_TARGET_SESSION_METADATA_KEY, SchedulerJob, SchedulerPayload, SchedulerSchedule } from './models'
import { SchedulerJobExecutor, type SchedulerAgentTurnPayload } from './executor'
import { inSchedulerRun } from './tool'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makeJob(kind: 'agent_turn' | 'team_wake' | 'system_event', opts: Partial<{ message: string; target: string; project_id: string; deliver: boolean; meta: Record<string, unknown> }> = {}): SchedulerJob {
  return SchedulerJob.create({
    jobId: `${kind}-job`,
    name: `${kind} job`,
    schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
    payload: new SchedulerPayload({
      kind,
      message: opts.message ?? 'do work',
      target: opts.target ?? null,
      project_id: opts.project_id ?? null,
      deliver: opts.deliver ?? true,
      meta: opts.meta ?? {},
    }),
    now: 1_700_000_000_000,
  })
}

describe('SchedulerJobExecutor', () => {
  it('runs agent_turn jobs through active task and task manager with scheduler context', async () => {
    const root = tmp('emperor-scheduler-executor-agent-')
    const taskManager = new TaskManager(root)
    const activeTasks = new ActiveTaskRegistry()
    const submitted: SchedulerAgentTurnPayload[] = []
    const executor = new SchedulerJobExecutor({
      activeTasks,
      taskManager,
      controlPending: () => false,
      submitAgentTurn: async (payload) => {
        expect(inSchedulerRun()).toBe(true)
        submitted.push(payload)
        return 'agent_turn completed'
      },
    })

    const result = await executor.run(makeJob('agent_turn', { deliver: false, meta: { [SCHEDULER_TARGET_SESSION_METADATA_KEY]: 'sess_sched' } }))
    expect(result).toBe('agent_turn completed')
    expect(submitted[0]!.content).toContain('[SCHEDULER_TRIGGER]')
    expect(submitted[0]!.displayContent).toContain('定时任务触发')
    expect(submitted[0]!.deliver).toBe(false)
    const record = taskManager.store.list()[0]!
    expect(record.status).toBe(TaskStatus.COMPLETED)
    expect(record.job_id).toBe('agent_turn-job')
    expect(record.session_id).toBe('sess_sched')
  })

  it('rejects agent_turn while control interaction is pending', async () => {
    const executor = new SchedulerJobExecutor({
      controlPending: () => true,
      submitAgentTurn: async () => 'never',
    })
    await expect(executor.run(makeJob('agent_turn'))).rejects.toThrow(/Ask \/ Plan/)
  })

  it('routes team_wake payloads to the project team manager', async () => {
    const sent: Array<Record<string, unknown>> = []
    const executor = new SchedulerJobExecutor({
      submitAgentTurn: async () => 'unused',
      teamManagerForProject: (projectId) => ({
        sendMessage: async (payload: Record<string, unknown>) => {
          sent.push({ projectId, ...payload })
          return 'team wake done'
        },
      }),
    })
    const result = await executor.run(makeJob('team_wake', { target: 'alice', project_id: 'project-1', message: 'wake up' }))
    expect(result).toBe('team wake done')
    expect(sent).toEqual([{ projectId: 'project-1', to: 'alice', content: 'wake up', wake: true, type: 'task' }])
  })

  it('handles system_event jobs and watchlist run decisions', async () => {
    const submitted: SchedulerAgentTurnPayload[] = []
    const executor = new SchedulerJobExecutor({
      submitAgentTurn: async (payload) => { submitted.push(payload); return 'watchlist turn done' },
      systemHandlers: { 'memory-maintenance': async () => 'memory ok' },
      watchlistService: {
        check: async () => new WatchlistDecision({ action: 'run', reason: 'timely', message: 'Check issue queue' }),
      },
    })

    expect(await executor.run(makeJob('system_event', { meta: { system_event: 'memory-maintenance' } }))).toBe('memory ok')
    expect(await executor.run(makeJob('system_event', { meta: { system_event: 'watchlist-check' } }))).toBe('watchlist turn done')
    expect(submitted[0]!.content).toContain('[WATCHLIST_TRIGGER]')
    expect(submitted[0]!.content).toContain('Check issue queue')

    const skipExecutor = new SchedulerJobExecutor({
      submitAgentTurn: async () => 'unused',
      watchlistService: { check: async () => WatchlistDecision.skip('nothing timely') },
    })
    expect(await skipExecutor.run(makeJob('system_event', { meta: { system_event: 'watchlist-check' } }))).toBe('watchlist-check skipped: nothing timely')
  })
})
