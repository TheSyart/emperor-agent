import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActiveTaskRegistry } from '../../runtime/active'
import { GoalCoordinator } from '../../goals/coordinator'
import { GoalStore } from '../../goals/store'
import { GoalService, type GoalOperationResult } from './goal-service'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goal-service-'))
  roots.push(root)
  const goalStore = new GoalStore(root)
  const activeTasks = new ActiveTaskRegistry()
  const runTurn = vi.fn(async () => {})
  const clearPendingInteraction = vi.fn()
  const coordinator = new GoalCoordinator({ goalStore, activeTasks, runTurn })
  const sessions = new Map([
    [
      'session-1',
      { id: 'session-1', mode: 'build' as const, project_id: 'project-1' },
    ],
    ['session-2', { id: 'session-2', mode: 'chat' as const, project_id: null }],
  ])
  const service = new GoalService({
    goalStore,
    coordinator,
    activeTasks,
    materializeSession: async ({ sessionId }) => {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      return session
    },
    requireReadableSession: (sessionId) => {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      return session
    },
    scopeForSession: (session) => ({
      sessionId: session.id,
      mode: session.mode,
      projectId: session.project_id,
      workspaceRoot: root,
    }),
    clearPendingInteraction,
  })
  return {
    service,
    coordinator,
    goalStore,
    activeTasks,
    runTurn,
    clearPendingInteraction,
  }
}

describe('GoalService', () => {
  it('creates and launches a Goal without waiting for its lifecycle', async () => {
    const f = fixture()
    const result = await f.service.start({
      outcome: 'Ship the typed Goal API',
      sessionId: 'session-1',
    })

    expect(result).toMatchObject({
      accepted: true,
      goal: { outcome: 'Ship the typed Goal API', sessionId: 'session-1' },
      activeTask: { kind: 'goal', session_id: 'session-1' },
    })
    await f.coordinator.pause(result.goal.id, 'test_cleanup')
  })

  it('fences list/get and mutations to the owner session', async () => {
    const f = fixture()
    const started = await f.service.start({
      outcome: 'Private goal',
      sessionId: 'session-1',
    })
    await f.coordinator.pause(started.goal.id, 'test_pause')

    expect(await f.service.list({ sessionId: 'session-1' })).toHaveLength(1)
    await expect(
      f.service.get(started.goal.id, 'session-2'),
    ).rejects.toMatchObject({
      code: 'goal_session_mismatch',
    })
    await expect(
      f.service.resume(started.goal.id, 'session-2'),
    ).rejects.toMatchObject({
      code: 'goal_session_mismatch',
    })
  })

  it('caps recent summaries at fifty with stable newest-first ordering', async () => {
    const f = fixture()
    const list = vi.spyOn((f.service as any).options.goalStore, 'list')
    await f.service.list({ sessionId: 'session-1' })
    expect(list).toHaveBeenCalledOnce()
  })

  it('atomically reserves the single running Goal across concurrent sessions', async () => {
    const f = fixture()
    const results = await Promise.allSettled([
      f.service.start({ outcome: 'First Goal', sessionId: 'session-1' }),
      f.service.start({ outcome: 'Second Goal', sessionId: 'session-2' }),
    ])
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof f.service.start>>
      > => result.status === 'fulfilled',
    )
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: 'goal_mutation_busy' })
    await f.coordinator.pause(fulfilled[0]!.value.goal.id, 'test_cleanup')
  })

  it('replaces an owned Goal by cancelling the old record and preserving supersession history', async () => {
    const f = fixture()
    const started = await f.service.start({
      outcome: '旧 Outcome',
      sessionId: 'session-1',
    })

    const replaced = await f.service.replace({
      goalId: started.goal.id,
      outcome: '新的 Outcome',
      sessionId: 'session-1',
    })

    expect(replaced.goal).toMatchObject({
      outcome: '新的 Outcome',
      sessionId: 'session-1',
    })
    expect(replaced.goal.id).not.toBe(started.goal.id)
    expect(await f.goalStore.get(started.goal.id)).toMatchObject({
      status: 'cancelled',
      runtime: { phase: 'terminal', pauseReason: 'goal_replaced' },
    })
    expect(await f.goalStore.get(replaced.goal.id)).toMatchObject({
      supersedesGoalId: started.goal.id,
    })
    expect(f.clearPendingInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ id: started.goal.id }),
    )
    await f.coordinator.pause(replaced.goal.id, 'test_cleanup')
  })

  it('clears a pending Goal interaction when the Goal is cancelled', async () => {
    const f = fixture()
    const started = await f.service.start({
      outcome: '取消等待中的 Goal',
      sessionId: 'session-1',
    })

    await f.service.cancel(
      started.goal.id,
      'user_confirmed_cancel',
      'session-1',
    )

    expect(f.clearPendingInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: started.goal.id,
      }),
    )
  })

  it('validates replacement ownership and Outcome before terminating the old Goal', async () => {
    const f = fixture()
    const started = await f.service.start({
      outcome: '保留中的 Goal',
      sessionId: 'session-1',
    })

    await expect(
      f.service.replace({
        goalId: started.goal.id,
        outcome: '跨会话替换',
        sessionId: 'session-2',
      }),
    ).rejects.toMatchObject({ code: 'goal_session_mismatch' })
    await expect(
      f.service.replace({
        goalId: started.goal.id,
        outcome: '   ',
        sessionId: 'session-1',
      }),
    ).rejects.toMatchObject({ code: 'goal_outcome_invalid' })

    expect(await f.goalStore.get(started.goal.id)).toMatchObject({
      status: 'draft',
      terminalAt: null,
    })
    await f.coordinator.pause(started.goal.id, 'test_cleanup')
  })

  it('serializes concurrent replacements so only one supersession can win', async () => {
    const f = fixture()
    const started = await f.service.start({
      outcome: '并发替换源 Goal',
      sessionId: 'session-1',
    })

    const results = await Promise.allSettled([
      f.service.replace({
        goalId: started.goal.id,
        outcome: '替代 Goal A',
        sessionId: 'session-1',
      }),
      f.service.replace({
        goalId: started.goal.id,
        outcome: '替代 Goal B',
        sessionId: 'session-1',
      }),
    ])

    const fulfilled = results.find(
      (result): result is PromiseFulfilledResult<GoalOperationResult> =>
        result.status === 'fulfilled',
    )
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(fulfilled?.value.goal.outcome).toMatch(/^替代 Goal [AB]$/)
    expect(rejected?.reason).toMatchObject({ code: 'goal_terminal' })
    await f.coordinator.pause(fulfilled!.value.goal.id, 'test_cleanup')
  })

  it('fails closed when replacement persistence fails after cancelling the old Goal', async () => {
    const f = fixture()
    const started = await f.service.start({
      outcome: '需要安全替换的 Goal',
      sessionId: 'session-1',
    })
    vi.spyOn(f.goalStore, 'create').mockRejectedValueOnce(
      new Error('replacement persistence failed'),
    )

    await expect(
      f.service.replace({
        goalId: started.goal.id,
        outcome: '无法落盘的替代 Goal',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('replacement persistence failed')
    expect(await f.goalStore.get(started.goal.id)).toMatchObject({
      status: 'cancelled',
      runtime: { phase: 'terminal', pauseReason: 'goal_replaced' },
    })
    expect(f.activeTasks.hasActive()).toBe(false)
  })
})
