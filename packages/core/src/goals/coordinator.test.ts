import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActiveTaskRegistry } from '../runtime/active'
import { GoalCoordinator, type GoalCycleTurnInput } from './coordinator'
import type { GoalGuardPolicy } from './models'
import { GoalStore } from './store'
import { GoalContractValidator, newGoalRecord } from './validation'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function fixture(
  options: {
    guardPolicy?: Partial<GoalGuardPolicy>
    runTurn?: (input: GoalCycleTurnInput) => Promise<void>
    pendingInteractionId?: () => string | null
    evaluateGate?: () => Promise<{
      pass: boolean
      [key: string]: unknown
    }>
    executionPaused?: () => boolean
    now?: () => string
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'goal-coordinator-'))
  roots.push(root)
  const store = new GoalStore(root, { now: options.now })
  const draft = await store.create(
    newGoalRecord({
      id: `goal_${Math.random().toString(16).slice(2)}`,
      outcome: 'Complete the durable objective',
      scope: {
        sessionId: 'session-goal',
        mode: 'build',
        projectId: 'project-goal',
        workspaceRoot: root,
      },
      contract: {
        inScope: ['src'],
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'The objective is verified.',
            required: true,
            verification: { kind: 'command', requirement: 'npm test' },
          },
        ],
      },
      guardPolicy: options.guardPolicy,
      now: '2026-07-16T00:00:00.000Z',
    }),
  )
  const locked = GoalContractValidator.lock(
    draft,
    {
      inScope: draft.contract.inScope,
      outOfScope: draft.contract.outOfScope,
      constraints: draft.contract.constraints,
      acceptanceCriteria: draft.contract.acceptanceCriteria,
      escalationConditions: draft.contract.escalationConditions,
    },
    '2026-07-16T00:00:01.000Z',
  )
  const goal = await store.append(draft.id, {
    type: 'goal_updated',
    record: locked,
    createdAt: locked.updatedAt,
  })
  const activeTasks = new ActiveTaskRegistry()
  const turns: GoalCycleTurnInput[] = []
  const coordinator = new GoalCoordinator({
    goalStore: store,
    activeTasks,
    pendingInteractionId: options.pendingInteractionId,
    evaluateGate: options.evaluateGate as never,
    executionPaused: options.executionPaused,
    now: options.now,
    runTurn: async (input) => {
      turns.push(input)
      await options.runTurn?.(input)
    },
  })
  return { store, goal, coordinator, turns, activeTasks }
}

async function settle(coordinator: GoalCoordinator, goalId: string) {
  const handle = coordinator.active(goalId)
  if (handle) await handle.promise
}

describe('GoalCoordinator', () => {
  it('stops automatic Goal cycles when the Plan execution is paused for continuation', async () => {
    let paused = false
    const f = await fixture({
      executionPaused: () => paused,
      runTurn: async () => {
        paused = true
      },
    })

    await f.coordinator.start(f.goal.id, 'Visible request')
    await settle(f.coordinator, f.goal.id)

    expect(f.turns).toHaveLength(1)
    await expect(f.store.get(f.goal.id)).resolves.toMatchObject({
      runtime: {
        phase: 'paused',
        currentRunId: null,
        pauseReason: 'continuation_pause',
      },
    })
  })

  it('resumes a paused Goal with an explicit continuation prompt', async () => {
    const f = await fixture({
      runTurn: async () => {
        await f.coordinator.pause(f.goal.id, 'continuation_pause')
      },
    })
    await f.coordinator.start(f.goal.id, 'Visible request')
    await settle(f.coordinator, f.goal.id)

    const resumed = await f.coordinator.resume(f.goal.id, '继续执行')
    expect(resumed.runtime.phase).not.toBe('paused')
    for (let attempt = 0; attempt < 10 && f.turns.length < 2; attempt += 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(f.turns.at(-1)?.content).toContain(
      '[CONTROL:GOAL_CONTINUATION_RESUMED]',
    )
    expect(f.turns.at(-1)?.displayContent).toBe('继续执行')
    await f.coordinator.pause(f.goal.id, 'test_done')
    await settle(f.coordinator, f.goal.id)
  })

  it('owns one ActiveTask across turns and hides only continuation cycles', async () => {
    let calls = 0
    const f = await fixture({
      runTurn: async (input) => {
        calls += 1
        await f.store.appendObservation(input.goal.id, { id: `obs-${calls}` })
        if (calls === 2) await f.coordinator.cancel(input.goal.id, 'test_done')
      },
    })
    await f.coordinator.start(f.goal.id, 'Visible request')
    expect(f.activeTasks.list()).toHaveLength(1)
    expect(f.activeTasks.list()[0]).toMatchObject({
      id: `goal:${f.goal.id}`,
      kind: 'goal',
      session_id: 'session-goal',
    })
    await settle(f.coordinator, f.goal.id)
    expect(f.turns).toHaveLength(2)
    expect(f.turns[0]).toMatchObject({
      displayContent: 'Visible request',
      uiHidden: false,
      source: 'goal',
      useActiveTask: false,
    })
    expect(f.turns[1]).toMatchObject({ displayContent: '', uiHidden: true })
    expect(f.activeTasks.list()).toHaveLength(0)
  })

  it('pauses durably after three cycles without new evidence', async () => {
    const f = await fixture()
    await f.coordinator.start(f.goal.id)
    await settle(f.coordinator, f.goal.id)
    const goal = await f.store.get(f.goal.id)
    expect(f.turns).toHaveLength(3)
    expect(goal).toMatchObject({
      status: 'active',
      runtime: {
        phase: 'paused',
        cyclesUsed: 3,
        consecutiveNoEvidenceCycles: 3,
        pauseReason: 'no_new_evidence',
        currentRunId: null,
      },
    })
  })

  it('persists awaiting_user and resumes only the matching interaction', async () => {
    let pending: string | null = null
    const f = await fixture({
      pendingInteractionId: () => pending,
      runTurn: async () => {
        pending = 'interaction-1'
      },
    })
    await f.coordinator.start(f.goal.id)
    await settle(f.coordinator, f.goal.id)
    expect(await f.store.get(f.goal.id)).toMatchObject({
      runtime: {
        phase: 'awaiting_user',
        pendingInteractionId: 'interaction-1',
      },
    })
    await expect(
      f.coordinator.resumeAfterControl(f.goal.id, 'wrong'),
    ).rejects.toThrow('does not match')
    pending = null
    await f.coordinator.resumeAfterControl(f.goal.id, 'interaction-1')
    await f.coordinator.pause(f.goal.id, 'test_cleanup')
    await settle(f.coordinator, f.goal.id)
    expect(await f.store.get(f.goal.id)).toMatchObject({
      status: 'active',
      runtime: { phase: 'paused', pendingInteractionId: null },
    })
  })

  it('treats stop as resumable pause and cancel as terminal', async () => {
    let entered!: Promise<void>
    let markEntered!: () => void
    let blocked!: Promise<void>
    let release!: () => void
    const resetTurnBarrier = () => {
      entered = new Promise<void>((resolve) => {
        markEntered = resolve
      })
      blocked = new Promise<void>((resolve) => {
        release = resolve
      })
    }
    resetTurnBarrier()
    const f = await fixture({
      runTurn: async () => {
        markEntered()
        await blocked
      },
    })
    await f.coordinator.start(f.goal.id)
    await entered
    const paused = await f.coordinator.pause(f.goal.id)
    expect(paused).toMatchObject({
      status: 'active',
      runtime: { phase: 'paused', pauseReason: 'user_stop' },
    })
    release()
    await settle(f.coordinator, f.goal.id)
    resetTurnBarrier()
    await f.coordinator.resume(f.goal.id)
    await entered
    const cancelled = await f.coordinator.cancel(f.goal.id)
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      runtime: { phase: 'terminal' },
    })
    release()
    await settle(f.coordinator, f.goal.id)
    await expect(f.coordinator.resume(f.goal.id)).rejects.toThrow()
  })

  it('records a newer pause cause when an already paused Goal changes lifecycle context', async () => {
    const f = await fixture()

    await f.coordinator.pause(f.goal.id, 'no_new_evidence')
    const archived = await f.coordinator.pause(f.goal.id, 'session_archived')

    expect(archived).toMatchObject({
      status: 'active',
      runtime: { phase: 'paused', pauseReason: 'session_archived' },
    })
  })

  it('makes explicit maxCycles terminal and never guesses unavailable cost', async () => {
    const f = await fixture({ guardPolicy: { maxCycles: 1 } })
    await f.coordinator.start(f.goal.id)
    await settle(f.coordinator, f.goal.id)
    expect(await f.store.get(f.goal.id)).toMatchObject({
      status: 'stopped_by_policy',
      runtime: { phase: 'terminal', pauseReason: 'max_cycles' },
    })
    await expect(f.coordinator.resume(f.goal.id)).rejects.toThrow()
  })

  it('converts background failures to paused/internal_error without rejection', async () => {
    const f = await fixture({
      runTurn: async () => {
        throw new Error('runner exploded')
      },
    })
    await f.coordinator.start(f.goal.id)
    await expect(
      f.coordinator.active(f.goal.id)!.promise,
    ).resolves.toBeUndefined()
    expect(await f.store.get(f.goal.id)).toMatchObject({
      status: 'active',
      runtime: { phase: 'paused', pauseReason: 'internal_error' },
    })
  })

  it('uses one bounded hidden cycle for a passing Gate and never auto-completes', async () => {
    const f = await fixture({
      evaluateGate: async () => ({ pass: true }),
      runTurn: async (input) => {
        let current = await f.store.get(input.goal.id)
        if (current?.runtime.phase === 'planning') {
          current = await f.store.append(current.id, {
            type: 'goal_updated',
            record: {
              ...current,
              runtime: { ...current.runtime, phase: 'executing' },
              updatedAt: new Date(
                Date.parse(current.updatedAt) + 1,
              ).toISOString(),
            },
            expectedLastEventSeq: current.lastEventSeq,
          })
        }
        if (current?.runtime.phase === 'executing')
          await f.store.append(current.id, {
            type: 'goal_updated',
            record: {
              ...current,
              runtime: { ...current.runtime, phase: 'verifying' },
              updatedAt: new Date(
                Date.parse(current.updatedAt) + 1,
              ).toISOString(),
            },
            expectedLastEventSeq: current.lastEventSeq,
          })
      },
    })
    await f.coordinator.start(f.goal.id)
    await settle(f.coordinator, f.goal.id)
    expect(f.turns).toHaveLength(2)
    expect(f.turns[1]?.content).toContain('complete_goal')
    expect(await f.store.get(f.goal.id)).toMatchObject({
      status: 'active',
      runtime: {
        phase: 'paused',
        pauseReason: 'completion_tool_not_called',
      },
    })
  })

  it('shutdown persists pause before aborting and waits for the handle', async () => {
    const f = await fixture({
      runTurn: async (input) =>
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), {
            once: true,
          })
        }),
    })
    await f.coordinator.start(f.goal.id)
    await f.coordinator.shutdown()
    expect(f.coordinator.active(f.goal.id)).toBeNull()
    expect(await f.store.get(f.goal.id)).toMatchObject({
      status: 'active',
      runtime: {
        phase: 'paused',
        pauseReason: 'shutdown_recovery_required',
        currentRunId: null,
      },
    })
  })

  it('rejects another mutation task while preserving the existing owner', async () => {
    let release!: () => void
    const f = await fixture({
      runTurn: async () =>
        await new Promise<void>((resolve) => {
          release = resolve
        }),
    })
    const other = f.activeTasks.run({
      taskId: 'turn:other',
      kind: 'turn',
      label: 'Other turn',
      execute: async () => await new Promise<void>(() => {}),
    })
    await expect(f.coordinator.start(f.goal.id)).rejects.toThrow(
      'Another mutation task',
    )
    f.activeTasks.cancel({ taskId: 'turn:other' })
    await other.catch(() => undefined)

    await f.coordinator.start(f.goal.id)
    await expect(f.coordinator.start(f.goal.id)).rejects.toThrow(
      'already running',
    )
    expect(f.coordinator.active(f.goal.id)).not.toBeNull()
    await f.coordinator.pause(f.goal.id)
    release()
    await settle(f.coordinator, f.goal.id)
  })
})
