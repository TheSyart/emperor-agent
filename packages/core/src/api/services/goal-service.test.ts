import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../harness/agent/agent'
import { GoalService as HarnessGoalService } from '../../harness/goal/service'
import { createTestHarness } from '../../harness/testing'
import { GoalService } from './goal-service'

function fixture(options: { active?: string | null } = {}) {
  const h = createTestHarness()
  const goals = new HarnessGoalService()
  const agents = new Map<string, Agent>()
  const agentFor = vi.fn((sessionId: string) => {
    let agent = agents.get(sessionId)
    if (!agent) {
      agent = h.agent(sessionId)
      agents.set(sessionId, agent)
    }
    return agent
  })
  const materializeSession = vi.fn(async () => undefined)
  const service = new GoalService({
    goals,
    agentFor,
    goalView: (sessionId) => {
      const agent = agents.get(sessionId)
      return agent ? (goals.get(agent) ?? null) : null
    },
    activeSessionId: () =>
      options.active === undefined ? 'session-1' : options.active,
    materializeSession,
  })
  return { service, goals, agentFor, materializeSession }
}

describe('GoalService facade', () => {
  it('starts an armed user goal in the session and returns its view', async () => {
    const f = fixture()
    const result = await f.service.start({
      sessionId: 'session-1',
      objective: '  Ship the harness goal API  ',
      maxRounds: 5,
    })
    expect(f.materializeSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
    })
    expect(result).toMatchObject({
      accepted: true,
      goal: {
        objective: 'Ship the harness goal API',
        phase: 'active',
        maxGoalRounds: 5,
        revision: 1,
        activation: 'armed',
      },
    })
    await expect(f.service.list({ sessionId: 'session-1' })).resolves.toEqual([
      result.goal,
    ])
    await expect(f.service.bootstrap('session-1')).resolves.toEqual({
      active: result.goal,
    })
  })

  it('rejects an empty objective and a second non-complete goal', async () => {
    const f = fixture()
    await expect(
      f.service.start({ sessionId: 'session-1', objective: '   ' }),
    ).rejects.toMatchObject({
      code: 'goal_objective_invalid',
    })
    await f.service.start({ sessionId: 'session-1', objective: 'first' })
    await expect(
      f.service.start({ sessionId: 'session-1', objective: 'second' }),
    ).rejects.toMatchObject({
      code: 'GOAL_ALREADY_EXISTS',
    })
  })

  it('returns empty reads for sessions without a goal or without a session', async () => {
    const f = fixture({ active: null })
    await expect(f.service.list()).resolves.toEqual([])
    await expect(f.service.bootstrap()).resolves.toEqual({ active: null })
    await expect(f.service.get('goal-x')).rejects.toMatchObject({
      code: 'goal_session_required',
    })
  })

  it('pauses, resumes, and cancels the current goal by id (active session default)', async () => {
    const f = fixture()
    const { goal } = await f.service.start({
      sessionId: 'session-1',
      objective: 'loop',
    })
    const id = goal!.id

    const paused = await f.service.pause(id)
    expect(paused.goal).toMatchObject({
      id,
      phase: 'paused',
      revision: 2,
      activation: 'disarmed',
    })
    await expect(f.service.get(id)).resolves.toMatchObject({ phase: 'paused' })

    const resumed = await f.service.resume(id)
    expect(resumed.goal).toMatchObject({
      phase: 'active',
      revision: 3,
      activation: 'armed',
    })

    const cancelled = await f.service.cancel(id, 'user_cancelled')
    expect(cancelled).toEqual({
      accepted: true,
      goal: null,
      cleared: { id, revision: 4 },
    })
    await expect(f.service.list()).resolves.toEqual([])
    await expect(f.service.bootstrap()).resolves.toEqual({ active: null })
  })

  it('fences goal ids to the owning session', async () => {
    const f = fixture()
    const { goal } = await f.service.start({
      sessionId: 'session-1',
      objective: 'private',
    })
    await expect(f.service.get(goal!.id, 'session-2')).rejects.toMatchObject({
      code: 'goal_not_found',
    })
    await expect(f.service.pause(goal!.id, 'session-2')).rejects.toMatchObject({
      code: 'goal_not_found',
    })
    await expect(
      f.service.pause('goal-other', 'session-1'),
    ).rejects.toMatchObject({ code: 'goal_not_found' })
  })

  it('retires replace', async () => {
    const f = fixture()
    await expect(f.service.replace({})).rejects.toMatchObject({
      code: 'operation_retired',
    })
  })
})
