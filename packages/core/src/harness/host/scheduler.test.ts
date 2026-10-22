import { describe, expect, it } from 'vitest'
import {
  SchedulerJob,
  SchedulerPayload,
  SchedulerSchedule,
  withSchedulerPayloadSession,
} from '../../scheduler/models'
import type { SchedulerRunContext } from '../../scheduler/service'
import {
  createSchedulerExecutor,
  schedulerRunResult,
  type SchedulerTurnRequest,
} from './scheduler'
import type { TurnResult } from './scope'

function completed(content: string): { result: TurnResult } {
  return { result: { kind: 'completed', content, turnId: 't:1' } }
}

function job(payload: SchedulerPayload): SchedulerJob {
  return SchedulerJob.create({
    jobId: 'job-1',
    name: 'Daily review',
    schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
    payload,
    now: 1_000,
  })
}

function context(): SchedulerRunContext {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    scheduledForMs: 1_000,
    trigger: 'timer',
    signal: new AbortController().signal,
  } as unknown as SchedulerRunContext
}

describe('scheduler executor on the harness kernel', () => {
  it('submits agent_turn jobs to their session and returns the reply', async () => {
    const requests: SchedulerTurnRequest[] = []
    const run = createSchedulerExecutor({
      runTurn: async (request) => {
        requests.push(request)
        return completed('done')
      },
      hasPendingInteraction: () => false,
    })
    const payload = withSchedulerPayloadSession(
      new SchedulerPayload({
        kind: 'agent_turn',
        message: 'Review work',
        deliver: true,
      }),
      'session-a',
    )
    await expect(run(job(payload), context())).resolves.toBe('done')
    expect(requests[0]).toMatchObject({
      sessionId: 'session-a',
      clientMessageId: 'scheduler:run-1',
      deliver: true,
    })
    expect(requests[0]!.content).toContain('[SCHEDULER_TRIGGER]')
    expect(requests[0]!.content).toContain('Review work')
  })

  it('refuses to run while an interaction is pending and rejects team_wake', async () => {
    const run = createSchedulerExecutor({
      runTurn: async () => completed('x'),
      hasPendingInteraction: () => true,
    })
    const payload = new SchedulerPayload({
      kind: 'agent_turn',
      message: 'Review work',
    })
    await expect(run(job(payload), context())).rejects.toThrow('pending')
    const team = new SchedulerPayload({
      kind: 'team_wake',
      message: 'wake',
      target: 'bob',
      project_id: 'p',
    })
    await expect(run(job(team), context())).rejects.toThrow('Team was removed')
  })

  it('turns a due watchlist check into an agent turn and skips otherwise', async () => {
    const contents: string[] = []
    let decision = { action: 'skip', reason: 'quiet', message: '' }
    const run = createSchedulerExecutor({
      runTurn: async (request) => {
        contents.push(request.content)
        return completed('ran')
      },
      hasPendingInteraction: () => false,
      watchlistCheck: async () => decision,
    })
    const payload = new SchedulerPayload({
      kind: 'system_event',
      message: 'watchlist-check',
      meta: { system_event: 'watchlist-check' },
    })
    await expect(run(job(payload), context())).resolves.toBe(
      'watchlist-check skipped: quiet',
    )
    decision = { action: 'run', reason: 'incident', message: 'Check the queue' }
    await expect(run(job(payload), context())).resolves.toBe('ran')
    expect(contents[0]).toContain('[WATCHLIST_TRIGGER]')
    expect(contents[0]).toContain('Check the queue')
  })

  it('maps each turn result onto the run record (KRN-01)', () => {
    expect(schedulerRunResult(completed('ok').result)).toBe('ok')
    const failure = (result: TurnResult) => {
      try {
        schedulerRunResult(result)
      } catch (error) {
        return error as { status: string; code: string | null; message: string }
      }
      throw new Error('expected a failure')
    }
    expect(
      failure({ kind: 'error', code: 'AUTH', message: '401', turnId: 't' }),
    ).toMatchObject({ status: 'error', code: 'AUTH' })
    expect(
      failure({ kind: 'aborted', by: 'timeout', turnId: 't' }),
    ).toMatchObject({ status: 'cancelled', code: 'TIMEOUT' })
    expect(failure({ kind: 'aborted', by: 'user', turnId: 't' })).toMatchObject(
      { status: 'cancelled', message: '已被用户停止' },
    )
    expect(
      failure({
        kind: 'blocked',
        reason: 'interaction-rejected',
        turnId: 't',
        detail: 'bash',
      }).message,
    ).toContain('自动拒绝')
    expect(
      failure({ kind: 'not-consumed', reason: 'previous-turn-failed' }),
    ).toMatchObject({ status: 'error', code: 'NOT_CONSUMED' })
  })
})
