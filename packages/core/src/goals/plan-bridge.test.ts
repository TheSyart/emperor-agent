import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ControlManager } from '../control/manager'
import {
  PlanStatus,
  PlanStepStatus,
  makePlanRecord,
  type PlanRecord,
} from '../plans/models'
import { requirementsForStep } from '../plans/verification'
import { TodoStore } from '../tools/builtin'
import { TaskManager } from '../tasks/manager'
import { GoalContractValidator, newGoalRecord } from './validation'
import { GoalStore } from './store'
import { GoalPlanBridge } from './plan-bridge'
import type { GoalRecord, GoalScope } from './models'
import { computeGoalEventHash } from './events'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function planningGoal(
  store: GoalStore,
  id = 'goal_plan_bridge',
  sessionId = 'session_goal_bridge',
): Promise<GoalRecord> {
  const created = await store.create(
    newGoalRecord({
      id,
      outcome: 'Execute a Goal-bound Plan.',
      scope: {
        sessionId,
        mode: 'build',
        projectId: 'project_goal_bridge',
        workspaceRoot: '/workspace/goal-bridge',
      },
      now: '2026-07-15T14:00:00.000Z',
    }),
  )
  const locked = GoalContractValidator.lock(
    created,
    {
      inScope: ['Task 4'],
      outOfScope: [],
      constraints: [],
      acceptanceCriteria: [
        {
          id: 'AC-1',
          description: 'Plan succeeds.',
          required: true,
          verification: { kind: 'command', requirement: 'npm test' },
        },
      ],
      escalationConditions: [],
    },
    '2026-07-15T14:00:01.000Z',
  )
  return store.append(created.id, {
    type: 'goal_updated',
    record: locked,
    expectedLastEventSeq: created.lastEventSeq,
  })
}

function pendingGoalPlan(
  root: string,
  goal: GoalRecord,
): {
  manager: ControlManager
  taskManager: TaskManager
  todoStore: TodoStore
  planId: string
  interactionId: string
  approvalGeneration: number
} {
  const manager = new ControlManager(root)
  const taskManager = new TaskManager(root)
  const todoStore = new TodoStore()
  manager.setTodoStore(todoStore)
  manager.setTaskManager(taskManager)
  manager.setRuntimeScope({
    sessionId: goal.scope.sessionId,
    mode: goal.scope.mode,
    projectId: goal.scope.projectId,
    workspaceRoot: goal.scope.workspaceRoot,
    projectFingerprint: goal.scope.projectFingerprint,
  })
  manager.setActiveGoalPlanContext(goal)
  manager.setMode('plan')
  const interaction = manager.createPlan({
    title: 'Goal execution Plan',
    summary: 'Execute the current Goal path.',
    planMarkdown: '# Plan\n\n- Implement\n- Verify',
    steps: [
      {
        id: 'step_1',
        title: 'Implement',
        files: ['src/a.ts'],
        commands: ['npm test'],
        acceptance: ['implementation complete'],
      },
      {
        id: 'step_2',
        title: 'Verify',
        files: ['src/a.test.ts'],
        commands: ['npm test'],
        acceptance: ['tests pass'],
        depends_on: ['step_1'],
      },
    ],
  })
  return {
    manager,
    taskManager,
    todoStore,
    planId: String(interaction.meta.plan_id),
    interactionId: interaction.id,
    approvalGeneration: Number(interaction.meta.approval_generation),
  }
}

function approvedGoalPlan(
  root: string,
  goal: GoalRecord,
): {
  manager: ControlManager
  taskManager: TaskManager
  todoStore: TodoStore
  planId: string
} {
  const pending = pendingGoalPlan(root, goal)
  pending.manager.approve(pending.interactionId)
  return pending
}

describe('GoalPlanBridge.preflightApproval', () => {
  it.each(['scope', 'generation', 'phase'] as const)(
    'rejects a stale %s before Plan bytes, tokens, or tasks mutate',
    async (failure) => {
      const root = tmp(`emperor-goal-plan-preflight-${failure}-`)
      const goalStore = new GoalStore(root)
      const originalGoal = await planningGoal(
        goalStore,
        `goal_preflight_${failure}`,
      )
      const pending = pendingGoalPlan(root, originalGoal)
      let goal = originalGoal
      if (failure === 'scope') {
        const plan = pending.manager.planStore.get(pending.planId)!
        pending.manager.planStore.save({
          ...plan,
          metadata: {
            ...plan.metadata,
            scope: {
              ...(plan.metadata.scope as Record<string, unknown>),
              workspace_root: '/workspace/forged',
            },
          },
        })
      } else if (failure === 'phase') {
        goal = await goalStore.append(originalGoal.id, {
          type: 'goal_updated',
          record: {
            ...originalGoal,
            runtime: {
              ...originalGoal.runtime,
              phase: 'awaiting_user',
              pendingInteractionId: 'interaction_other',
            },
          },
          expectedLastEventSeq: originalGoal.lastEventSeq,
        })
      }
      const beforePlan = readFileSync(
        pending.manager.planStore.indexFile,
        'utf8',
      )
      const beforeTasks = readFileSync(
        pending.taskManager.store.indexFile,
        'utf8',
      )
      const beforeTokens = pending.manager.planStore.get(pending.planId)!
        .metadata.permission_tokens
      const bridge = new GoalPlanBridge({
        goalStore,
        planStore: pending.manager.planStore,
        taskManager: pending.taskManager,
      })

      await expect(
        bridge.preflightApproval({
          goalId: goal.id,
          planId: pending.planId,
          interactionId: pending.interactionId,
          approvalGeneration:
            pending.approvalGeneration + (failure === 'generation' ? 1 : 0),
        }),
      ).rejects.toThrow()

      expect(readFileSync(pending.manager.planStore.indexFile, 'utf8')).toBe(
        beforePlan,
      )
      expect(readFileSync(pending.taskManager.store.indexFile, 'utf8')).toBe(
        beforeTasks,
      )
      expect(
        pending.manager.planStore.get(pending.planId)!.metadata
          .permission_tokens,
      ).toEqual(beforeTokens)
      expect(pending.manager.payload().pending).not.toBeNull()
    },
  )
})

describe('GoalPlanBridge.bindApprovedPlan', () => {
  it('binds the current approved generation and moves the Goal to executing', async () => {
    const root = tmp('emperor-goal-plan-bind-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore)
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })

    const result = await bridge.bindApprovedPlan({ goalId: goal.id, planId })

    expect(result.plan.goalId).toBe(goal.id)
    expect(result.goal.runtime).toMatchObject({
      phase: 'executing',
      currentPlanId: planId,
    })
    expect((await goalStore.get(goal.id))?.runtime.currentPlanId).toBe(planId)
    const events = await goalStore.readEvents(goal.id)
    expect(events.at(-1)?.payload.planBinding).toMatchObject({
      goalId: goal.id,
      planId,
    })
  })

  it('is idempotent when concurrent callers bind the same approved generation', async () => {
    const root = tmp('emperor-goal-plan-bind-concurrent-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_bind_concurrent')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })

    const results = await Promise.all([
      bridge.bindApprovedPlan({ goalId: goal.id, planId }),
      bridge.bindApprovedPlan({ goalId: goal.id, planId }),
    ])

    expect(results.map((item) => item.goal.runtime.currentPlanId)).toEqual([
      planId,
      planId,
    ])
    const bindings = (await goalStore.readEvents(goal.id)).filter(
      (event) => event.payload.planBinding,
    )
    expect(bindings).toHaveLength(1)
  })

  it('rereads a Goal CAS conflict across bridge instances without cancelling the bound Plan', async () => {
    const root = tmp('emperor-goal-plan-bind-cross-bridge-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_bind_cross_bridge')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const first = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })
    const second = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })

    const results = await Promise.all([
      first.bindApprovedPlan({ goalId: goal.id, planId }),
      second.bindApprovedPlan({ goalId: goal.id, planId }),
    ])

    expect(results.map((item) => item.goal.runtime.currentPlanId)).toEqual([
      planId,
      planId,
    ])
    expect(manager.planStore.get(planId)?.status).toBe(PlanStatus.EXECUTING)
    expect(manager.planStore.isQuarantined(planId)).toBe(false)
    expect(
      (await goalStore.readEvents(goal.id)).filter(
        (event) => event.payload.planBinding,
      ),
    ).toHaveLength(1)
  })

  it('serializes independent stores at one Goal ledger and returns one idempotent binding', async () => {
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const root = tmp(`emperor-goal-plan-bind-independent-${iteration}-`)
      const bootstrap = new GoalStore(root)
      const goal = await planningGoal(
        bootstrap,
        `goal_bind_independent_${iteration}`,
      )
      const { manager, planId } = approvedGoalPlan(root, goal)
      const approved = manager.planStore.get(planId)!
      manager.planStore.prepareApprovalQuarantine({
        planId,
        goalId: goal.id,
        interactionId: approved.sourceInteractionId!,
        approvalGeneration: Number(approved.metadata.approval_generation),
      })

      let releaseFirst!: () => void
      const firstMayAppend = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      let signalFirst!: () => void
      const firstReachedAppend = new Promise<void>((resolve) => {
        signalFirst = resolve
      })
      const firstGoalStore = new GoalStore(root, {
        hooks: {
          async beforeEventAppend(context) {
            if (context.goalId !== goal.id || context.seq !== 3) return
            signalFirst()
            await firstMayAppend
          },
        },
      })
      const secondGoalStore = new GoalStore(root)
      const first = new GoalPlanBridge({
        goalStore: firstGoalStore,
        planStore: new ControlManager(root).planStore,
        taskManager: new TaskManager(root),
      })
      const second = new GoalPlanBridge({
        goalStore: secondGoalStore,
        planStore: new ControlManager(root).planStore,
        taskManager: new TaskManager(root),
      })

      const firstBinding = first.bindApprovedPlan({ goalId: goal.id, planId })
      await firstReachedAppend
      let secondSettled = false
      const secondBinding = second
        .bindApprovedPlan({ goalId: goal.id, planId })
        .finally(() => {
          secondSettled = true
        })
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
      const secondSettledBeforeRelease = secondSettled
      releaseFirst()
      const results = await Promise.all([firstBinding, secondBinding])

      expect(secondSettledBeforeRelease).toBe(false)
      expect(results.map((item) => item.goal.runtime.currentPlanId)).toEqual([
        planId,
        planId,
      ])
      const verifier = new GoalStore(root)
      const events = await verifier.readEvents(goal.id)
      expect(events.filter((event) => event.payload.planBinding)).toHaveLength(
        1,
      )
      events.forEach((event, index) => {
        expect(event.hash).toBe(computeGoalEventHash(event))
        expect(event.prevHash).toBe(
          index === 0 ? null : events[index - 1]!.hash,
        )
      })
      expect(await verifier.get(goal.id)).toMatchObject({
        status: 'active',
        runtime: { phase: 'executing', currentPlanId: planId },
      })
      expect(await verifier.diagnostics()).toMatchObject({
        recoveryRequired: 0,
        issues: [],
      })
    }
  })

  it('does not compensate a direct cross-Goal bind validation failure', async () => {
    const root = tmp('emperor-goal-plan-cross-goal-validation-')
    const goalStore = new GoalStore(root)
    const owner = await planningGoal(goalStore, 'goal_plan_owner')
    const foreign = await planningGoal(
      goalStore,
      'goal_plan_foreign',
      'session_goal_foreign',
    )
    const { manager, taskManager, planId } = approvedGoalPlan(root, owner)
    const beforePlan = readFileSync(manager.planStore.indexFile, 'utf8')
    const beforeTasks = readFileSync(taskManager.store.indexFile, 'utf8')
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })

    await expect(
      bridge.bindApprovedPlan({ goalId: foreign.id, planId }),
    ).rejects.toThrow(/Goal binding|scope/i)

    expect(readFileSync(manager.planStore.indexFile, 'utf8')).toBe(beforePlan)
    expect(readFileSync(taskManager.store.indexFile, 'utf8')).toBe(beforeTasks)
    expect(manager.planStore.isQuarantined(planId)).toBe(false)
    expect(manager.latestExecutablePlan()?.id).toBe(planId)
  })

  it.each([
    ['session', { sessionId: 'session_other' }],
    ['project', { projectId: 'project_other' }],
    ['workspace', { workspaceRoot: '/workspace/other' }],
    ['fingerprint', { projectFingerprint: '0'.repeat(64) }],
  ])(
    'rejects a %s scope mismatch without changing the Goal',
    async (_name, patch) => {
      const root = tmp('emperor-goal-plan-scope-')
      const goalStore = new GoalStore(root)
      const goal = await planningGoal(goalStore)
      const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
      const plan = manager.planStore.get(planId)!
      const scopePatch = patch as Partial<GoalScope>
      const scope = {
        ...(plan.metadata.scope as Record<string, unknown>),
        ...(Object.hasOwn(scopePatch, 'sessionId')
          ? { session_id: scopePatch.sessionId }
          : {}),
        ...(Object.hasOwn(scopePatch, 'projectId')
          ? { project_id: scopePatch.projectId }
          : {}),
        ...(Object.hasOwn(scopePatch, 'workspaceRoot')
          ? { workspace_root: scopePatch.workspaceRoot }
          : {}),
        ...(Object.hasOwn(scopePatch, 'projectFingerprint')
          ? { project_fingerprint: scopePatch.projectFingerprint }
          : {}),
      }
      manager.planStore.save({
        ...plan,
        sessionId: Object.hasOwn(scopePatch, 'sessionId')
          ? String(scopePatch.sessionId)
          : plan.sessionId,
        metadata: { ...plan.metadata, scope },
      })
      const bridge = new GoalPlanBridge({
        goalStore,
        planStore: manager.planStore,
        taskManager,
      })

      const beforePlan = readFileSync(manager.planStore.indexFile, 'utf8')
      const beforeTasks = readFileSync(taskManager.store.indexFile, 'utf8')

      await expect(
        bridge.bindApprovedPlan({ goalId: goal.id, planId }),
      ).rejects.toThrow(/scope/i)
      expect((await goalStore.get(goal.id))?.runtime).toMatchObject({
        phase: 'planning',
        currentPlanId: null,
      })
      expect(readFileSync(manager.planStore.indexFile, 'utf8')).toBe(beforePlan)
      expect(readFileSync(taskManager.store.indexFile, 'utf8')).toBe(
        beforeTasks,
      )
      expect(manager.planStore.isQuarantined(planId)).toBe(false)
    },
  )

  it('rejects an older approval generation', async () => {
    const root = tmp('emperor-goal-plan-generation-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore)
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const approved = manager.planStore.get(planId)!
    manager.planStore.save(
      makePlanRecord({
        ...approved,
        id: 'plan_newer_generation',
        eventSeq: 0,
        approvedAt: approved.approvedAt! + 1,
        createdAt: approved.createdAt + 1,
        updatedAt: approved.updatedAt + 1,
        metadata: {
          ...approved.metadata,
          approval_generation:
            Number(approved.metadata.approval_generation ?? 1) + 1,
        },
      }),
    )
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })

    await expect(
      bridge.bindApprovedPlan({ goalId: goal.id, planId }),
    ).rejects.toThrow(/generation/i)
  })

  it('cancels execution and revokes tokens when the Goal write fails', async () => {
    const root = tmp('emperor-goal-plan-bind-failure-')
    let failBinding = false
    const goalStore = new GoalStore(root, {
      hooks: {
        beforeEventAppend: () => {
          if (failBinding) throw new Error('injected Goal append failure')
        },
      },
    })
    const goal = await planningGoal(goalStore)
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    failBinding = true
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })

    await expect(
      bridge.bindApprovedPlan({ goalId: goal.id, planId }),
    ).rejects.toThrow(/injected Goal append failure/)
    const failed = manager.planStore.get(planId)!
    expect(failed.status).toBe(PlanStatus.CANCELLED)
    expect(failed.metadata.permission_tokens).toEqual([])
    expect(failed.metadata.goal_bind_failed).toBeTruthy()
    const taskIds = Object.values(
      failed.metadata.plan_step_tasks as Record<string, string>,
    )
    expect(
      taskIds.map((id) => taskManager.store.get(id)?.status),
    ).not.toContain('running')
    expect((await goalStore.get(goal.id))?.runtime.currentPlanId).toBeNull()
  })

  it('continues fail-closed compensation when Plan save and task cancellation fail once', async () => {
    const root = tmp('emperor-goal-plan-bind-compensation-faults-')
    let failBinding = false
    const goalStore = new GoalStore(root, {
      hooks: {
        beforeEventAppend: () => {
          if (failBinding)
            throw new Error('secret=/private/key Goal append failed')
        },
      },
    })
    const goal = await planningGoal(goalStore, 'goal_bind_compensation_faults')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const originalSave = manager.planStore.save.bind(manager.planStore)
    let cancelSaveFailures = 0
    manager.planStore.save = ((record) => {
      if (record.status === PlanStatus.CANCELLED && cancelSaveFailures++ === 0)
        throw new Error('/private/plan-index unavailable')
      return originalSave(record)
    }) as typeof manager.planStore.save
    const originalCancel = taskManager.cancelTask.bind(taskManager)
    let taskCancelFailures = 0
    taskManager.cancelTask = ((taskId, opts) => {
      if (taskCancelFailures++ === 0)
        throw new Error('secret-token task cancellation unavailable')
      return originalCancel(taskId, opts)
    }) as typeof taskManager.cancelTask
    failBinding = true
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })

    await expect(
      bridge.bindApprovedPlan({ goalId: goal.id, planId }),
    ).rejects.toThrow(/Goal append failed/)

    const failed = manager.planStore.get(planId)!
    expect(failed).toMatchObject({
      status: PlanStatus.CANCELLED,
      metadata: {
        permission_tokens: [],
        goal_bind_failed: {
          code: 'goal_plan_bind_failed',
          compensation: {
            planSaveFailures: 1,
            taskCancelFailures: 1,
          },
        },
      },
    })
    expect(JSON.stringify(failed.metadata.goal_bind_failed)).not.toMatch(
      /private|secret|token/,
    )
    const taskIds = Object.values(
      failed.metadata.plan_step_tasks as Record<string, string>,
    )
    expect(
      taskIds.map((id) => taskManager.store.get(id)?.status),
    ).not.toContain('running')
    expect(manager.latestExecutablePlan()).toBeNull()
  })

  it('durably quarantines approval when compensation exhausts and recovers later', async () => {
    const root = tmp('emperor-goal-plan-bind-quarantine-')
    let failBinding = false
    const goalStore = new GoalStore(root, {
      hooks: {
        beforeEventAppend: () => {
          if (failBinding) throw new Error('injected binding failure')
        },
      },
    })
    const goal = await planningGoal(goalStore, 'goal_bind_quarantine')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const originalSave = manager.planStore.save.bind(manager.planStore)
    const originalCancel = taskManager.cancelTask.bind(taskManager)
    manager.planStore.save = ((record) => {
      if (record.status === PlanStatus.CANCELLED)
        throw new Error('persistent Plan save failure')
      return originalSave(record)
    }) as typeof manager.planStore.save
    taskManager.cancelTask = (() => {
      throw new Error('persistent task cancel failure')
    }) as typeof taskManager.cancelTask
    failBinding = true
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })

    await expect(
      bridge.bindApprovedPlan({ goalId: goal.id, planId }),
    ).rejects.toThrow(/binding failure/)
    expect(manager.planStore.isQuarantined(planId)).toBe(true)
    expect(manager.latestExecutablePlan()).toBeNull()
    expect(
      manager.consumePlanPermissionToken({
        toolName: 'run_command',
        arguments: { command: 'npm test' },
      }),
    ).toBeNull()
    expect((await bridge.planCompletionReceipt(goal.id)).completed).toBe(false)

    manager.planStore.save = originalSave
    taskManager.cancelTask = originalCancel
    failBinding = false
    expect(await bridge.recoverQuarantinedApprovals()).toBe(1)
    expect(manager.planStore.isQuarantined(planId)).toBe(false)
    expect(manager.planStore.get(planId)?.status).toBe(PlanStatus.CANCELLED)
  })

  it('startup scans and cancels an orphan explicit Goal-bound executable Plan without a sidecar marker', async () => {
    const root = tmp('emperor-goal-plan-orphan-scan-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_orphan_scan')
    const { manager, planId } = approvedGoalPlan(root, goal)
    expect(manager.planStore.isQuarantined(planId)).toBe(false)

    const restartedManager = new ControlManager(root)
    const restartedTasks = new TaskManager(root)
    restartedManager.setTaskManager(restartedTasks)
    const restartedBridge = new GoalPlanBridge({
      goalStore: new GoalStore(root),
      planStore: restartedManager.planStore,
      taskManager: restartedTasks,
    })

    expect(await restartedBridge.recoverQuarantinedApprovals()).toBe(1)
    expect(restartedManager.planStore.get(planId)).toMatchObject({
      status: PlanStatus.CANCELLED,
      metadata: { permission_tokens: [] },
    })
    expect(restartedManager.latestExecutablePlan()).toBeNull()
  })

  it('clears a prepared waiting approval on startup without cancelling the draft', async () => {
    const root = tmp('emperor-goal-plan-prepared-waiting-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_prepared_waiting')
    const pending = pendingGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: pending.manager.planStore,
      taskManager: pending.taskManager,
    })

    await bridge.prepareApproval({
      goalId: goal.id,
      planId: pending.planId,
      interactionId: pending.interactionId,
      approvalGeneration: pending.approvalGeneration,
    })
    expect(pending.manager.planStore.isQuarantined(pending.planId)).toBe(true)

    const restarted = new GoalPlanBridge({
      goalStore: new GoalStore(root),
      planStore: new ControlManager(root).planStore,
      taskManager: new TaskManager(root),
    })
    expect(await restarted.recoverQuarantinedApprovals()).toBe(1)
    expect(pending.manager.planStore.get(pending.planId)?.status).toBe(
      PlanStatus.WAITING_APPROVAL,
    )
    expect(
      new ControlManager(root).planStore.isQuarantined(pending.planId),
    ).toBe(false)
  })

  it('keeps an exact bound Plan quarantined after clear failure until startup safely clears it', async () => {
    const root = tmp('emperor-goal-plan-clear-quarantine-fault-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_clear_quarantine_fault')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    manager.planStore.clearApprovalQuarantine = (() => {
      throw new Error('injected quarantine clear failure')
    }) as typeof manager.planStore.clearApprovalQuarantine
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })

    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    expect(manager.planStore.isQuarantined(planId)).toBe(true)
    expect(manager.latestExecutablePlan()).toBeNull()

    const restartedStore = new ControlManager(root).planStore
    const restarted = new GoalPlanBridge({
      goalStore: new GoalStore(root),
      planStore: restartedStore,
      taskManager: new TaskManager(root),
    })
    expect(await restarted.recoverQuarantinedApprovals()).toBe(1)
    expect(restartedStore.isQuarantined(planId)).toBe(false)
    expect(restartedStore.get(planId)?.status).toBe(PlanStatus.EXECUTING)
  })

  it('recovers from corrupt sidecar plus exhausted live compensation using the durable Plan intent', async () => {
    const root = tmp('emperor-goal-plan-quarantine-multi-fault-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_quarantine_multi_fault')
    const pending = pendingGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: pending.manager.planStore,
      taskManager: pending.taskManager,
    })
    await bridge.prepareApproval({
      goalId: goal.id,
      planId: pending.planId,
      interactionId: pending.interactionId,
      approvalGeneration: pending.approvalGeneration,
    })
    pending.manager.approve(pending.interactionId)
    writeFileSync(pending.manager.planStore.quarantineFile, '{corrupt', 'utf8')
    const originalSave = pending.manager.planStore.save.bind(
      pending.manager.planStore,
    )
    pending.manager.planStore.save = ((record) => {
      if (record.status === PlanStatus.CANCELLED)
        throw new Error('persistent cancellation write failure')
      return originalSave(record)
    }) as typeof pending.manager.planStore.save
    pending.manager.planStore.quarantine = (() => {
      throw new Error('persistent quarantine sidecar write failure')
    }) as typeof pending.manager.planStore.quarantine
    pending.taskManager.cancelTask = (() => {
      throw new Error('persistent task cancellation failure')
    }) as typeof pending.taskManager.cancelTask

    expect(() =>
      bridge.abortFailedApproval({ goalId: goal.id, planId: pending.planId }),
    ).toThrow(/sidecar write failure/)

    const restartedManager = new ControlManager(root)
    const restartedTasks = new TaskManager(root)
    restartedManager.setTaskManager(restartedTasks)
    expect(restartedManager.planStore.isQuarantined(pending.planId)).toBe(true)
    expect(restartedManager.latestExecutablePlan()).toBeNull()
    const restarted = new GoalPlanBridge({
      goalStore: new GoalStore(root),
      planStore: restartedManager.planStore,
      taskManager: restartedTasks,
    })
    expect(await restarted.recoverQuarantinedApprovals()).toBe(1)
    expect(restartedManager.planStore.get(pending.planId)).toMatchObject({
      status: PlanStatus.CANCELLED,
      metadata: { permission_tokens: [] },
    })
    expect(restartedManager.planStore.isQuarantined(pending.planId)).toBe(false)
  })
})

describe('GoalPlanBridge.skipStepWithWaiver', () => {
  it('persists a trusted skip, advances the successor, and leaves Todo independent', async () => {
    const root = tmp('emperor-goal-plan-production-skip-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_production_skip')
    const { manager, taskManager, todoStore, planId } = approvedGoalPlan(
      root,
      goal,
    )
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
      resolveStepWaiver: ({ goalId, planId: sourcePlanId, stepId }) => ({
        kind: 'explicit_user_plan_step_waiver',
        issuedBy: 'core',
        approvedBy: 'user',
        receiptId: 'waiver_production_1',
        goalId,
        planId: sourcePlanId,
        stepId,
      }),
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    const before = manager.planStore.get(planId)!
    const taskMap = before.metadata.plan_step_tasks as Record<string, string>

    const skipped = await bridge.skipStepWithWaiver({
      goalId: goal.id,
      planId,
      stepId: 'step_1',
    })

    expect(skipped.eventSeq).toBeGreaterThan(before.eventSeq)
    expect(skipped.steps).toMatchObject([
      {
        id: 'step_1',
        status: 'skipped',
        evidence: [{ receipt_id: 'waiver_production_1' }],
      },
      { id: 'step_2', status: 'active' },
    ])
    expect(taskManager.store.get(taskMap.step_1!)).toMatchObject({
      status: 'cancelled',
      metadata: {
        plan_id: planId,
        plan_step_id: 'step_1',
        approval_generation: Number(before.metadata.approval_generation),
      },
    })
    expect(taskManager.store.get(taskMap.step_2!)).toMatchObject({
      status: 'running',
      metadata: {
        plan_id: planId,
        plan_step_id: 'step_2',
        approval_generation: Number(before.metadata.approval_generation),
      },
    })
    expect(todoStore.todos).toEqual([])
    const duplicate = await bridge.skipStepWithWaiver({
      goalId: goal.id,
      planId,
      stepId: 'step_1',
    })
    expect(duplicate.eventSeq).toBe(skipped.eventSeq)
    expect(
      duplicate.steps[0]!.evidence.filter(
        (item) => item.receipt_id === 'waiver_production_1',
      ),
    ).toHaveLength(1)
  })

  it('fails closed without a real resolver receipt and preserves Plan/task/Todo bytes', async () => {
    const root = tmp('emperor-goal-plan-production-skip-reject-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_production_skip_reject')
    const { manager, taskManager, todoStore, planId } = approvedGoalPlan(
      root,
      goal,
    )
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
      resolveStepWaiver: () => null,
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    const beforePlan = readFileSync(manager.planStore.indexFile, 'utf8')
    const beforeTasks = readFileSync(taskManager.store.indexFile, 'utf8')
    const beforeTodos = structuredClone(todoStore.todos)

    await expect(
      bridge.skipStepWithWaiver({
        goalId: goal.id,
        planId,
        stepId: 'step_1',
      }),
    ).rejects.toThrow(/waiver/i)

    expect(readFileSync(manager.planStore.indexFile, 'utf8')).toBe(beforePlan)
    expect(readFileSync(taskManager.store.indexFile, 'utf8')).toBe(beforeTasks)
    expect(todoStore.todos).toEqual(beforeTodos)
  })

  it.each(['plan', 'task_cancel', 'task_update', 'completion'] as const)(
    'recovers a durable skip after a %s persistence failure',
    async (failure) => {
      const root = tmp(`emperor-goal-plan-skip-recovery-${failure}-`)
      const goalStore = new GoalStore(root)
      const goal = await planningGoal(goalStore, `goal_skip_${failure}`)
      const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
      const beforeBind = manager.planStore.get(planId)!
      const bridge = new GoalPlanBridge({
        goalStore,
        planStore: manager.planStore,
        taskManager,
        resolveStepWaiver: ({ goalId, planId: sourcePlanId, stepId }) => ({
          kind: 'explicit_user_plan_step_waiver',
          issuedBy: 'core',
          approvedBy: 'user',
          receiptId: `waiver_${failure}`,
          goalId,
          planId: sourcePlanId,
          stepId,
        }),
      })
      await bridge.bindApprovedPlan({ goalId: goal.id, planId })
      const before = manager.planStore.get(planId)!
      const taskMap = before.metadata.plan_step_tasks as Record<string, string>

      const originalPlanSave = manager.planStore.save.bind(manager.planStore)
      const originalCancel = taskManager.cancelTask.bind(taskManager)
      const originalUpdate = taskManager.updateTask.bind(taskManager)
      if (failure === 'plan' || failure === 'completion') {
        manager.planStore.save = ((candidate: PlanRecord) => {
          const intent = candidate.metadata.goal_skip_intent as
            Record<string, unknown> | undefined
          if (
            (failure === 'plan' && intent?.stage === 'plan_skipped') ||
            (failure === 'completion' && intent?.stage === 'completed')
          )
            throw new Error('injected Plan skip CAS failure')
          return originalPlanSave(candidate)
        }) as typeof manager.planStore.save
      } else if (failure === 'task_cancel') {
        taskManager.cancelTask = (() => {
          throw new Error('injected persistent Task cancel failure')
        }) as typeof taskManager.cancelTask
      } else if (failure === 'task_update') {
        taskManager.updateTask = ((taskId, fields) => {
          if (taskId === taskMap.step_2)
            throw new Error('injected persistent Task update failure')
          return originalUpdate(taskId, fields)
        }) as typeof taskManager.updateTask
      }

      await expect(
        bridge.skipStepWithWaiver({
          goalId: goal.id,
          planId,
          stepId: 'step_1',
        }),
      ).rejects.toThrow(/injected persistent|injected Plan/)

      const failed = new ControlManager(root).planStore.get(planId)!
      const expectedStage =
        failure === 'plan'
          ? 'intent_persisted'
          : failure === 'completion'
            ? 'todo_synced'
            : 'plan_skipped'
      expect(skipIntentStage(failed)).toBe(expectedStage)
      expect(
        new ControlManager(root).planStore.isExecutionBlocked(planId),
      ).toBe(true)
      expect(manager.latestExecutablePlan()).toBeNull()
      expect(
        manager.consumePlanPermissionToken({
          toolName: 'run_command',
          arguments: { command: 'npm test' },
        }),
      ).toBeNull()

      const recoveredTasks = new TaskManager(root)
      const recoveredTodos = new TodoStore()
      const recovered = new GoalPlanBridge({
        goalStore: new GoalStore(root),
        planStore: new ControlManager(root).planStore,
        taskManager: recoveredTasks,
      })
      const recovery = await recovered.recoverIncompleteSkips()
      expect(recovery).toMatchObject({
        count: 1,
      })
      const finalStore = new ControlManager(root).planStore
      const final = finalStore.get(planId)!
      expect(skipIntentStage(final)).toBe('completed')
      expect(finalStore.isExecutionBlocked(planId)).toBe(false)
      expect(final.steps).toMatchObject([
        { id: 'step_1', status: 'skipped' },
        { id: 'step_2', status: 'active' },
      ])
      expect(recoveredTasks.store.get(taskMap.step_1!)?.status).not.toBe(
        'running',
      )
      const running = recoveredTasks.store
        .list()
        .filter(
          (task) =>
            task.status === 'running' &&
            task.metadata.plan_id === planId &&
            task.metadata.approval_generation ===
              Number(beforeBind.metadata.approval_generation),
        )
      expect(running).toHaveLength(1)
      expect(running[0]?.metadata.plan_step_id).toBe('step_2')
      expect(recoveredTodos.todos).toEqual([])
      const completedSeq = final.eventSeq
      expect(await recovered.recoverIncompleteSkips()).toEqual({
        count: 0,
      })
      expect(finalStore.get(planId)!.eventSeq).toBe(completedSeq)

      manager.planStore.save = originalPlanSave
      taskManager.cancelTask = originalCancel
      taskManager.updateTask = originalUpdate
    },
  )

  it('selects the current approval when an older incomplete intent shares its session', async () => {
    const root = tmp('emperor-goal-plan-skip-current-generation-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(
      goalStore,
      'goal_skip_current_generation',
      'session_shared_generation',
    )
    const {
      manager,
      taskManager,
      planId: oldPlanId,
    } = approvedGoalPlan(root, goal)
    const bindingBridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })
    const bound = await bindingBridge.bindApprovedPlan({
      goalId: goal.id,
      planId: oldPlanId,
    })
    const oldPlan = manager.planStore.get(oldPlanId)!
    const currentPlanId = 'plan_skip_current_generation'
    let currentPlan = manager.planStore.save(
      makePlanRecord({
        id: currentPlanId,
        title: 'Current approval generation',
        summary: 'Only this Plan may project Todo state.',
        status: PlanStatus.EXECUTING,
        createdAt: oldPlan.createdAt + 10,
        updatedAt: oldPlan.updatedAt + 10,
        approvedAt: Number(oldPlan.approvedAt) + 10,
        sessionId: oldPlan.sessionId,
        goalId: goal.id,
        sourceInteractionId: 'interaction_skip_current_generation',
        steps: oldPlan.steps.map((step) => ({ ...step, evidence: [] })),
        metadata: {
          scope: structuredClone(oldPlan.metadata.scope),
          approval_generation: Number(oldPlan.metadata.approval_generation) + 1,
          plan_step_tasks: {},
        },
      }),
    )
    const currentIntent = {
      version: 1,
      goal_id: goal.id,
      plan_id: currentPlan.id,
      approval_generation: Number(currentPlan.metadata.approval_generation),
      step_id: 'step_1',
      receipt_id: 'waiver_current_generation',
      started_at: 20,
      stage: 'intent_persisted',
    }
    currentPlan = manager.planStore.save({
      ...currentPlan,
      metadata: {
        ...currentPlan.metadata,
        goal_skip_intent: currentIntent,
      },
    })
    currentPlan = manager.planStore.save({
      ...currentPlan,
      steps: currentPlan.steps.map((step) =>
        step.id === 'step_1'
          ? { ...step, status: PlanStepStatus.SKIPPED }
          : { ...step, status: PlanStepStatus.ACTIVE },
      ),
      metadata: {
        ...currentPlan.metadata,
        goal_skip_intent: { ...currentIntent, stage: 'plan_skipped' },
      },
    })
    currentPlan = manager.planStore.save({
      ...currentPlan,
      metadata: {
        ...currentPlan.metadata,
        goal_skip_intent: { ...currentIntent, stage: 'tasks_synced' },
      },
    })
    await goalStore.append(goal.id, {
      type: 'goal_updated',
      record: {
        ...bound.goal,
        runtime: {
          ...bound.goal.runtime,
          currentPlanId: currentPlan.id,
        },
        updatedAt: '2026-07-16T00:00:20.000Z',
      },
      expectedLastEventSeq: bound.goal.lastEventSeq,
    })

    const oldIntent = {
      version: 1,
      goal_id: goal.id,
      plan_id: oldPlan.id,
      approval_generation: Number(oldPlan.metadata.approval_generation),
      step_id: 'step_1',
      receipt_id: 'waiver_stale_generation',
      started_at: 10,
      stage: 'intent_persisted',
    }
    let stale = manager.planStore.save({
      ...oldPlan,
      metadata: { ...oldPlan.metadata, goal_skip_intent: oldIntent },
    })
    for (const stage of ['plan_skipped', 'tasks_synced'] as const) {
      stale = manager.planStore.save({
        ...stale,
        metadata: {
          ...stale.metadata,
          goal_skip_intent: { ...oldIntent, stage },
        },
      })
    }

    const todos = new TodoStore()
    const recovery = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })
    const result = await recovery.recoverIncompleteSkips()

    expect(result).toMatchObject({
      count: 1,
    })
    expect(todos.todos).toEqual([])
    expect(skipIntentStage(manager.planStore.get(currentPlan.id)!)).toBe(
      'completed',
    )
    expect(skipIntentStage(manager.planStore.get(oldPlan.id)!)).toBe(
      'tasks_synced',
    )
  })

  it('blocks review and assessment while a completed Plan has an incomplete skip intent', async () => {
    const root = tmp('emperor-goal-plan-skip-review-block-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_skip_review_block')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
      resolveStepWaiver: ({ goalId, planId: sourcePlanId, stepId }) => ({
        kind: 'explicit_user_plan_step_waiver',
        issuedBy: 'core',
        approvedBy: 'user',
        receiptId: 'waiver_review_block',
        goalId,
        planId: sourcePlanId,
        stepId,
      }),
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    const current = manager.planStore.get(planId)!
    manager.planStore.save({
      ...current,
      steps: current.steps.map((step) =>
        step.id === 'step_2'
          ? { ...step, status: 'done', dependsOn: [] }
          : step,
      ),
    })
    const originalSave = manager.planStore.save.bind(manager.planStore)
    manager.planStore.save = ((candidate: PlanRecord) => {
      const intent = candidate.metadata.goal_skip_intent as
        Record<string, unknown> | undefined
      if (intent?.stage === 'completed')
        throw new Error('injected skip completion failure')
      return originalSave(candidate)
    }) as typeof manager.planStore.save

    await expect(
      bridge.skipStepWithWaiver({
        goalId: goal.id,
        planId,
        stepId: 'step_1',
      }),
    ).rejects.toThrow(/completion failure/)
    manager.planStore.save = originalSave

    expect(manager.planStore.get(planId)?.status).toBe(PlanStatus.COMPLETED)
    expect(skipIntentStage(manager.planStore.get(planId)!)).toBe('todo_synced')
    expect(manager.latestReviewablePlan()).toBeNull()
    expect((await bridge.currentPlanAssessment(goal.id)).status).toBe('invalid')
  })

  it('serializes two bridge instances to one durable skip intent and receipt', async () => {
    const root = tmp('emperor-goal-plan-skip-concurrent-')
    const bootstrap = new GoalStore(root)
    const goal = await planningGoal(bootstrap, 'goal_skip_concurrent')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    await new GoalPlanBridge({
      goalStore: bootstrap,
      planStore: manager.planStore,
      taskManager,
    }).bindApprovedPlan({ goalId: goal.id, planId })
    let signalResolver!: () => void
    const resolverReached = new Promise<void>((resolve) => {
      signalResolver = resolve
    })
    let releaseResolver!: () => void
    const resolverMayReturn = new Promise<void>((resolve) => {
      releaseResolver = resolve
    })
    let resolverCalls = 0
    const resolver = async ({
      goalId,
      planId: sourcePlanId,
      stepId,
    }: {
      goalId: string
      planId: string
      stepId: string
    }) => {
      resolverCalls += 1
      if (resolverCalls === 1) {
        signalResolver()
        await resolverMayReturn
      }
      return {
        kind: 'explicit_user_plan_step_waiver' as const,
        issuedBy: 'core' as const,
        approvedBy: 'user' as const,
        receiptId: 'waiver_skip_concurrent',
        goalId,
        planId: sourcePlanId,
        stepId,
      }
    }
    const first = new GoalPlanBridge({
      goalStore: new GoalStore(root),
      planStore: new ControlManager(root).planStore,
      taskManager,
      resolveStepWaiver: resolver,
    })
    const second = new GoalPlanBridge({
      goalStore: new GoalStore(root),
      planStore: new ControlManager(root).planStore,
      taskManager,
      resolveStepWaiver: resolver,
    })

    const firstSkip = first.skipStepWithWaiver({
      goalId: goal.id,
      planId,
      stepId: 'step_1',
    })
    await resolverReached
    let secondSettled = false
    const secondSkip = second
      .skipStepWithWaiver({ goalId: goal.id, planId, stepId: 'step_1' })
      .finally(() => {
        secondSettled = true
      })
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    expect(secondSettled).toBe(false)
    releaseResolver()
    const results = await Promise.all([firstSkip, secondSkip])

    expect(resolverCalls).toBe(1)
    expect(results[0].eventSeq).toBe(results[1].eventSeq)
    expect(skipIntentStage(results[0])).toBe('completed')
    expect(
      results[0].steps[0]!.evidence.filter(
        (item) => item.receipt_id === 'waiver_skip_concurrent',
      ),
    ).toHaveLength(1)
  })

  it('does not let approval or replan recovery clear or supersede an incomplete skip', async () => {
    const root = tmp('emperor-goal-plan-skip-recovery-isolation-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_skip_recovery_isolation')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
      resolveStepWaiver: ({ goalId, planId: sourcePlanId, stepId }) => ({
        kind: 'explicit_user_plan_step_waiver',
        issuedBy: 'core',
        approvedBy: 'user',
        receiptId: 'waiver_recovery_isolation',
        goalId,
        planId: sourcePlanId,
        stepId,
      }),
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    const originalSave = manager.planStore.save.bind(manager.planStore)
    manager.planStore.save = ((candidate: PlanRecord) => {
      const intent = candidate.metadata.goal_skip_intent as
        Record<string, unknown> | undefined
      if (intent?.stage === 'completed')
        throw new Error('injected isolated completion failure')
      return originalSave(candidate)
    }) as typeof manager.planStore.save
    await expect(
      bridge.skipStepWithWaiver({
        goalId: goal.id,
        planId,
        stepId: 'step_1',
      }),
    ).rejects.toThrow(/isolated completion/)
    manager.planStore.save = originalSave
    const interrupted = manager.planStore.get(planId)!
    expect(skipIntentStage(interrupted)).toBe('todo_synced')

    manager.planStore.quarantine(planId, 'stale_approval_sidecar')
    expect(await bridge.recoverQuarantinedApprovals()).toBe(1)
    expect(await bridge.recoverIncompleteReplans()).toBe(0)
    await expect(
      bridge.requestReplan({ goalId: goal.id, reason: 'must wait for skip' }),
    ).rejects.toThrow(/recovery is incomplete/i)

    const unchanged = manager.planStore.get(planId)!
    expect(unchanged.status).toBe(PlanStatus.EXECUTING)
    expect(unchanged.eventSeq).toBe(interrupted.eventSeq)
    expect(skipIntentStage(unchanged)).toBe('todo_synced')
    expect(manager.planStore.isExecutionBlocked(planId)).toBe(true)
  })
})

describe('GoalPlanBridge.requestReplan', () => {
  it('revokes the old execution before creating the sole current draft', async () => {
    const root = tmp('emperor-goal-replan-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_replan')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    const oldBefore = manager.planStore.get(planId)!
    const oldTaskIds = Object.values(
      oldBefore.metadata.plan_step_tasks as Record<string, string>,
    )
    expect(oldBefore.metadata.permission_tokens).not.toEqual([])

    const result = await bridge.requestReplan({
      goalId: goal.id,
      reason: 'New evidence invalidated the path.',
    })

    expect(result.previousPlan).toMatchObject({
      id: planId,
      status: PlanStatus.CANCELLED,
      metadata: {
        superseded_by: result.plan.id,
        permission_tokens: [],
        plan_step_tasks: {},
      },
    })
    expect(result.previousPlan.metadata.plan_step_tasks_revoked).toEqual(
      oldBefore.metadata.plan_step_tasks,
    )
    expect(
      oldTaskIds.map((id) => taskManager.store.get(id)?.status),
    ).not.toContain('running')
    expect(result.plan).toMatchObject({
      status: PlanStatus.DRAFT,
      goalId: goal.id,
      supersedesPlanId: planId,
    })
    expect(result.goal.runtime).toMatchObject({
      phase: 'planning',
      currentPlanId: result.plan.id,
    })
    expect(manager.latestExecutablePlan()).toBeNull()
    expect(
      manager.consumePlanPermissionToken({
        toolName: 'run_command',
        arguments: { command: 'npm test' },
      }),
    ).toBeNull()
  })

  it('validates supersession receipts and emits bounded non-secret failure summaries', async () => {
    const root = tmp('emperor-goal-replan-receipt-chain-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_replan_receipt_chain')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    await bridge.requestReplan({
      goalId: goal.id,
      reason: 'Switch to the safe path.',
    })
    const predecessor = manager.planStore.get(planId)!
    manager.planStore.save({
      ...predecessor,
      metadata: {
        ...predecessor.metadata,
        superseded_by: 'plan_tampered_successor',
        replan_failed: {
          reason: 'PRIVATE /Users/alice/.ssh/id_ed25519 token=super-secret',
          stack: 'must never escape',
        },
      },
    })

    const receipt = await bridge.planCompletionReceipt(goal.id)
    expect(receipt.invalidReasons).toContain('supersession_chain_invalid')
    expect(receipt.supersededPlans[0]).toMatchObject({
      planId,
      chainValid: false,
      invalidReason: 'superseded_by_mismatch',
      failure: {
        code: 'replan_failed',
        summary: 'Replan failed before Goal transition.',
      },
    })
    expect(
      receipt.supersededPlans[0]!.failure!.summary.length,
    ).toBeLessThanOrEqual(160)
    expect(JSON.stringify(receipt)).not.toMatch(
      /PRIVATE|id_ed25519|super-secret|must never escape/,
    )
  })

  it.each([
    'intent_persisted',
    'tasks_cancelled',
    'predecessor_cancelled',
    'successor_created',
    'goal_updated',
  ] as const)(
    'recovers an interrupted durable replan after %s',
    async (crashStage) => {
      const root = tmp(`emperor-goal-replan-crash-${crashStage}-`)
      const goalStore = new GoalStore(root)
      const goal = await planningGoal(
        goalStore,
        `goal_replan_crash_${crashStage}`,
      )
      const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
      const bridge = new GoalPlanBridge({
        goalStore,
        planStore: manager.planStore,
        taskManager,
        hooks: {
          afterReplanStage: (stage) => {
            if (stage === crashStage)
              throw new Error(`simulated crash after ${stage}`)
          },
        },
      })
      await bridge.bindApprovedPlan({ goalId: goal.id, planId })

      await expect(
        bridge.requestReplan({ goalId: goal.id, reason: 'Recover safely.' }),
      ).rejects.toThrow(/simulated crash/)

      const recoveredGoalStore = new GoalStore(root)
      const recoveredManager = new ControlManager(root)
      const recoveredTasks = new TaskManager(root)
      recoveredManager.setTaskManager(recoveredTasks)
      const recovered = new GoalPlanBridge({
        goalStore: recoveredGoalStore,
        planStore: recoveredManager.planStore,
        taskManager: recoveredTasks,
      })
      expect(await recovered.recoverIncompleteReplans()).toBe(1)
      const currentGoal = (await recoveredGoalStore.get(goal.id))!
      const currentPlan = recoveredManager.planStore.get(
        currentGoal.runtime.currentPlanId!,
      )!
      expect(currentGoal.runtime).toMatchObject({
        phase: 'planning',
        currentPlanId: currentPlan.id,
      })
      expect(currentPlan).toMatchObject({
        status: PlanStatus.DRAFT,
        goalId: goal.id,
        supersedesPlanId: planId,
      })
      const predecessor = recoveredManager.planStore.get(planId)!
      expect(predecessor).toMatchObject({
        status: PlanStatus.CANCELLED,
        metadata: {
          permission_tokens: [],
          plan_step_tasks: {},
          superseded_by: currentPlan.id,
          replan_intent: { stage: 'completed' },
        },
      })
      const taskIds = Object.values(
        predecessor.metadata.plan_step_tasks_revoked as Record<string, string>,
      )
      expect(
        taskIds.map((id) => recoveredTasks.store.get(id)?.status),
      ).not.toContain('running')
      const predecessorSeq = predecessor.eventSeq
      expect(await recovered.recoverIncompleteReplans()).toBe(0)
      expect(recoveredManager.planStore.get(planId)!.eventSeq).toBe(
        predecessorSeq,
      )
    },
  )

  it('serializes replans across independent bridge instances', async () => {
    const root = tmp('emperor-goal-replan-multi-bridge-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_replan_multi_bridge')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const first = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })
    const second = new GoalPlanBridge({
      goalStore: new GoalStore(root),
      planStore: new ControlManager(root).planStore,
      taskManager,
    })
    await first.bindApprovedPlan({ goalId: goal.id, planId })

    const results = await Promise.allSettled([
      first.requestReplan({ goalId: goal.id, reason: 'First writer.' }),
      second.requestReplan({ goalId: goal.id, reason: 'Second writer.' }),
    ])
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    )
    const currentGoal = (await goalStore.get(goal.id))!
    const drafts = manager.planStore
      .list()
      .filter(
        (plan) => plan.goalId === goal.id && plan.status === PlanStatus.DRAFT,
      )
    expect(drafts).toHaveLength(1)
    expect(currentGoal.runtime).toMatchObject({
      phase: 'planning',
      currentPlanId: drafts[0]!.id,
    })
    expect(manager.planStore.get(planId)?.metadata.permission_tokens).toEqual(
      [],
    )
  })

  it('keeps a recoverable successor and completes forward on a new instance when Goal persistence fails', async () => {
    const root = tmp('emperor-goal-replan-failure-')
    let failReplan = false
    const goalStore = new GoalStore(root, {
      hooks: {
        beforeEventAppend: () => {
          if (failReplan) throw new Error('injected replan Goal failure')
        },
      },
    })
    const goal = await planningGoal(goalStore, 'goal_replan_failure')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    failReplan = true

    await expect(
      bridge.requestReplan({ goalId: goal.id, reason: 'Try a new path.' }),
    ).rejects.toThrow(/injected replan Goal failure/)

    const old = manager.planStore.get(planId)!
    expect(old.status).toBe(PlanStatus.CANCELLED)
    expect(old.metadata.permission_tokens).toEqual([])
    const liveGoal = await goalStore.get(goal.id)
    const goalCurrent = liveGoal?.runtime.currentPlanId
    const drafts = manager.planStore
      .list()
      .filter(
        (plan) => plan.goalId === goal.id && plan.status === PlanStatus.DRAFT,
      )
    expect(drafts).toHaveLength(1)
    expect(goalCurrent).toBe(planId)
    expect(old.metadata.replan_intent).toMatchObject({
      successor_plan_id: drafts[0]!.id,
      stage: 'successor_created',
    })
    expect(
      manager.consumePlanPermissionToken({
        toolName: 'run_command',
        arguments: { command: 'npm test' },
      }),
    ).toBeNull()

    failReplan = false
    const restartedGoalStore = new GoalStore(root)
    const restartedManager = new ControlManager(root)
    const restartedTasks = new TaskManager(root)
    restartedManager.setTaskManager(restartedTasks)
    const restarted = new GoalPlanBridge({
      goalStore: restartedGoalStore,
      planStore: restartedManager.planStore,
      taskManager: restartedTasks,
    })
    expect(await restarted.recoverIncompleteReplans()).toBe(1)
    const recoveredGoal = (await restartedGoalStore.get(goal.id))!
    expect(recoveredGoal.runtime).toMatchObject({
      phase: 'planning',
      currentPlanId: drafts[0]!.id,
    })
    expect(
      restartedManager.planStore
        .list()
        .filter(
          (plan) => plan.goalId === goal.id && plan.status === PlanStatus.DRAFT,
        ),
    ).toHaveLength(1)
    expect(restartedManager.planStore.get(planId)?.metadata).toMatchObject({
      permission_tokens: [],
      replan_intent: { stage: 'completed' },
    })
  })

  it('recovers an active durable intent before accepting a repeated replan request', async () => {
    const root = tmp('emperor-goal-replan-repeated-recovery-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_replan_repeated_recovery')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const interrupted = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
      hooks: {
        afterReplanStage: (stage) => {
          if (stage === 'successor_created')
            throw new Error('simulated request interruption')
        },
      },
    })
    await interrupted.bindApprovedPlan({ goalId: goal.id, planId })
    await expect(
      interrupted.requestReplan({ goalId: goal.id, reason: 'First path.' }),
    ).rejects.toThrow(/request interruption/)
    const successorId = String(
      (
        manager.planStore.get(planId)?.metadata.replan_intent as Record<
          string,
          unknown
        >
      ).successor_plan_id,
    )

    const restarted = new GoalPlanBridge({
      goalStore: new GoalStore(root),
      planStore: new ControlManager(root).planStore,
      taskManager: new TaskManager(root),
    })
    const recovered = await restarted.requestReplan({
      goalId: goal.id,
      reason: 'Second request must recover the first intent.',
    })

    expect(recovered.plan.id).toBe(successorId)
    expect(recovered.goal.runtime).toMatchObject({
      phase: 'planning',
      currentPlanId: successorId,
    })
    expect(
      manager.planStore
        .list()
        .filter(
          (plan) => plan.goalId === goal.id && plan.status === PlanStatus.DRAFT,
        ),
    ).toHaveLength(1)
    expect(manager.planStore.get(planId)?.metadata).toMatchObject({
      permission_tokens: [],
      replan_intent: { stage: 'completed' },
    })
  })

  it('serializes concurrent replan requests to one successor', async () => {
    const root = tmp('emperor-goal-replan-concurrent-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_replan_concurrent')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })

    const results = await Promise.allSettled([
      bridge.requestReplan({ goalId: goal.id, reason: 'Path A' }),
      bridge.requestReplan({ goalId: goal.id, reason: 'Path B' }),
    ])

    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    )
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1)
    const liveGoal = (await goalStore.get(goal.id))!
    const current = manager.planStore.get(liveGoal.runtime.currentPlanId!)!
    expect(current.goalId).toBe(goal.id)
    expect(current.status).toBe(PlanStatus.DRAFT)
    expect(
      manager.planStore
        .list()
        .filter(
          (plan) => plan.goalId === goal.id && plan.status === PlanStatus.DRAFT,
        ),
    ).toHaveLength(1)
  })
})

describe('GoalPlanBridge assessment and completion receipt', () => {
  it('does not trust mutable Plan verification or reviewer fields without typed Core resolvers', async () => {
    const root = tmp('emperor-goal-plan-receipt-typed-facts-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_receipt_typed_facts')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    const plan = manager.planStore.get(planId)!
    manager.planStore.save({
      ...plan,
      status: PlanStatus.COMPLETED,
      completedAt: plan.updatedAt + 1,
      steps: plan.steps.map((step) => ({
        ...step,
        status: 'done',
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        evidence: [
          {
            requirement_id: 'cmd_1',
            tool_call_id: `forged_${step.id}`,
            command: 'npm test',
            passed: true,
            exit_code: 0,
          },
        ],
      })),
      verification: [
        {
          source: 'independent_verification',
          passed: true,
          command: 'npm test',
        },
      ],
    })

    const untrusted = await bridge.planCompletionReceipt(goal.id)
    expect(untrusted.completed).toBe(false)
    expect(untrusted.invalidReasons).toEqual(
      expect.arrayContaining([
        'required_verification_incomplete',
        'reviewer_incomplete',
      ]),
    )

    const trusted = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
      resolveStepVerification: (context) => ({
        kind: 'core_plan_step_verification',
        issuedBy: 'core',
        verdict: 'pass',
        receiptId: `verification_${context.stepId}_${context.requirementId}`,
        ...context,
      }),
      resolveReviewer: (context) => ({
        kind: 'core_independent_plan_review',
        issuedBy: 'core',
        verdict: 'pass',
        receiptId: 'review_receipt_1',
        commandEvidenceRefs: ['tool_call:review_command_1'],
        ...context,
      }),
    })
    expect((await trusted.planCompletionReceipt(goal.id)).completed).toBe(true)
  })

  it('treats skipped as incomplete unless a typed Core user-waiver fact resolves', async () => {
    const root = tmp('emperor-goal-plan-assessment-waiver-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_assessment_waiver')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    const plan = manager.planStore.get(planId)!
    manager.planStore.save({
      ...plan,
      status: PlanStatus.COMPLETED,
      completedAt: plan.updatedAt + 1,
      steps: [
        {
          ...plan.steps[0]!,
          status: 'done',
          evidence: [
            {
              command: 'npm test',
              passed: true,
              exit_code: 0,
              tool_call_id: 'call_test_pass',
            },
          ],
        },
        {
          ...plan.steps[1]!,
          status: 'skipped',
          evidence: [
            {
              source: 'goal_plan_step_waiver',
              issued_by: 'core',
              approved_by: 'user',
              receipt_id: 'forged-model-waiver',
            },
          ],
        },
      ],
    })

    const missing = await bridge.currentPlanAssessment(goal.id)
    expect(missing.status).toBe('invalid')
    expect(missing.skippedWithoutWaiverIds).toEqual(['step_2'])

    const trusted = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
      resolveStepWaiver: ({ goalId, planId: sourcePlanId, stepId }) => ({
        kind: 'explicit_user_plan_step_waiver',
        issuedBy: 'core',
        approvedBy: 'user',
        receiptId: 'waiver_receipt_1',
        goalId,
        planId: sourcePlanId,
        stepId,
      }),
      resolveStepVerification: (context) => ({
        ...context,
        kind: 'core_plan_step_verification',
        issuedBy: 'core',
        verdict: 'pass',
        receiptId: `verification_${context.requirementId}`,
      }),
      resolveReviewerRiskFact: (context) => ({
        ...context,
        kind: 'core_goal_reviewer_risk',
        issuedBy: 'core',
        version: 'risk:readonly:1',
        readonlyProven: true,
        changedFiles: [],
        capabilitySignals: [],
      }),
    })
    const completed = await trusted.currentPlanAssessment(goal.id)
    expect(completed.status).toBe('completed')
    expect(completed.skippedWithoutWaiverIds).toEqual([])
    const receipt = await trusted.planCompletionReceipt(goal.id)
    expect(receipt.completed).toBe(true)
    expect(receipt.planEventSeq).toBeGreaterThan(0)
    expect(receipt.steps.find((step) => step.id === 'step_2')).toMatchObject({
      status: 'skipped',
      waiverReceiptId: 'waiver_receipt_1',
    })
    expect((await goalStore.get(goal.id))?.status).toBe('active')
  })

  it('refuses a completed receipt when required verification or reviewer state is missing', async () => {
    const root = tmp('emperor-goal-plan-receipt-invalid-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_receipt_invalid')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
      resolveStepVerification: async (context) => {
        const currentGoal = await goalStore.get(context.goalId)
        return currentGoal
          ? manager.resolvePlanStepVerificationFact(currentGoal, context)
          : null
      },
      resolveReviewer: async (context) => {
        const currentGoal = await goalStore.get(context.goalId)
        return currentGoal
          ? manager.resolvePlanReviewerFact(currentGoal, context)
          : null
      },
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    const plan = manager.planStore.get(planId)!
    manager.planStore.save({
      ...plan,
      status: PlanStatus.COMPLETED,
      completedAt: plan.updatedAt + 1,
      steps: plan.steps.map((step, index) => ({
        ...step,
        status: 'done',
        files: index === 0 ? ['src/a.ts', 'src/b.ts', 'src/c.ts'] : step.files,
        evidence: [],
      })),
    })

    const missingVerification = await bridge.planCompletionReceipt(goal.id)
    expect(missingVerification.completed).toBe(false)
    expect(missingVerification.invalidReasons).toContain(
      'required_verification_incomplete',
    )
    expect(missingVerification.invalidReasons).toContain('reviewer_incomplete')

    const current = manager.planStore.get(planId)!
    for (const step of current.steps) {
      const requirement = requirementsForStep(step).find(
        (item) => item.required,
      )!
      manager.recordPlanVerificationResult({
        planId,
        stepId: step.id,
        result: {
          requirement_id: requirement.id,
          command: requirement.command,
          passed: true,
          exit_code: 0,
          tool_call_id: `call_${step.id}`,
        },
      })
    }
    const reviewerMissing = await bridge.planCompletionReceipt(goal.id)
    expect(reviewerMissing.completed).toBe(false)
    expect(reviewerMissing.invalidReasons).not.toContain(
      'required_verification_incomplete',
    )
    expect(reviewerMissing.invalidReasons).toContain('reviewer_incomplete')

    const firstStep = manager.planStore.get(planId)!.steps[0]!
    const firstRequirement = requirementsForStep(firstStep).find(
      (item) => item.required,
    )!
    manager.recordPlanVerificationResult({
      planId,
      stepId: firstStep.id,
      result: {
        requirement_id: firstRequirement.id,
        command: firstRequirement.command,
        passed: false,
        exit_code: 1,
        tool_call_id: 'call_step_1_latest_fail',
      },
    })
    expect(
      (await bridge.planCompletionReceipt(goal.id)).invalidReasons,
    ).toContain('required_verification_incomplete')
    manager.recordPlanVerificationResult({
      planId,
      stepId: firstStep.id,
      result: {
        requirement_id: firstRequirement.id,
        command: firstRequirement.command,
        passed: true,
        exit_code: 0,
        tool_call_id: 'call_step_1_latest_pass',
      },
    })
    expect(
      (await bridge.planCompletionReceipt(goal.id)).invalidReasons,
    ).not.toContain('required_verification_incomplete')

    const verifiedSteps = manager.planStore.get(planId)!
    manager.planStore.save({
      ...verifiedSteps,
      verification: [
        ...verifiedSteps.verification,
        {
          source: 'independent_verification_waiver',
          waived: true,
          passed: true,
          approved_by: 'model',
          command: 'npm test',
        },
      ],
    })
    expect(
      (await bridge.planCompletionReceipt(goal.id)).invalidReasons,
    ).toContain('reviewer_incomplete')

    manager.recordIndependentVerificationResult({
      planId,
      result: {
        passed: true,
        commands: ['npm test'],
        summary: 'model-authored PASS must not become a Core receipt',
      },
    })
    expect(
      (await bridge.planCompletionReceipt(goal.id)).invalidReasons,
    ).toContain('reviewer_incomplete')

    manager.waiveIndependentVerification({
      planId,
      reason: 'User explicitly accepts the disclosed residual risk.',
    })
    const waived = await bridge.planCompletionReceipt(goal.id)
    expect(waived.completed).toBe(true)
    expect(waived.reviewer).toMatchObject({
      required: true,
      satisfied: true,
      waived: true,
    })
  })

  it('fails closed for legacy or cross-Goal Plan bindings', async () => {
    const root = tmp('emperor-goal-plan-assessment-legacy-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_assessment_legacy')
    const manager = new ControlManager(root)
    const legacy = makePlanRecord({
      id: 'plan_legacy_assessment',
      title: 'Legacy Plan',
      summary: 'No explicit Goal ownership.',
      status: PlanStatus.COMPLETED,
      createdAt: 1,
      updatedAt: 1,
      approvedAt: 1,
      completedAt: 1,
      sessionId: goal.scope.sessionId,
      metadata: {
        scope: {
          session_id: goal.scope.sessionId,
          mode: goal.scope.mode,
          project_id: goal.scope.projectId,
          workspace_root: goal.scope.workspaceRoot,
          project_fingerprint: goal.scope.projectFingerprint,
        },
      },
    })
    manager.planStore.save(legacy)
    await goalStore.append(goal.id, {
      type: 'goal_updated',
      record: {
        ...goal,
        runtime: { ...goal.runtime, currentPlanId: legacy.id },
      },
      expectedLastEventSeq: goal.lastEventSeq,
    })
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
    })

    expect(await bridge.currentPlanAssessment(goal.id)).toMatchObject({
      status: 'invalid',
      scopeMatches: false,
    })
    expect((await bridge.planCompletionReceipt(goal.id)).completed).toBe(false)
  })

  it('does not treat an explicitly bound but empty completed Plan as complete', async () => {
    const root = tmp('emperor-goal-plan-assessment-empty-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_assessment_empty')
    const manager = new ControlManager(root)
    const empty = makePlanRecord({
      id: 'plan_empty_assessment',
      title: 'Empty Plan',
      summary: 'A corrupt or legacy empty Plan must fail closed.',
      status: PlanStatus.COMPLETED,
      createdAt: 1,
      updatedAt: 1,
      approvedAt: 1,
      completedAt: 1,
      sessionId: goal.scope.sessionId,
      goalId: goal.id,
      metadata: {
        scope: {
          session_id: goal.scope.sessionId,
          mode: goal.scope.mode,
          project_id: goal.scope.projectId,
          workspace_root: goal.scope.workspaceRoot,
          project_fingerprint: goal.scope.projectFingerprint,
        },
      },
    })
    manager.planStore.save(empty)
    await goalStore.append(goal.id, {
      type: 'goal_updated',
      record: {
        ...goal,
        runtime: { ...goal.runtime, currentPlanId: empty.id },
      },
      expectedLastEventSeq: goal.lastEventSeq,
    })
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
    })

    expect((await bridge.currentPlanAssessment(goal.id)).status).toBe('invalid')
    expect((await bridge.planCompletionReceipt(goal.id)).completed).toBe(false)
  })

  it('requires a typed verification requirement for every non-waived Goal step', async () => {
    const root = tmp('emperor-goal-plan-missing-requirement-')
    const goalStore = new GoalStore(root)
    const goal = await planningGoal(goalStore, 'goal_missing_requirement')
    const { manager, taskManager, planId } = approvedGoalPlan(root, goal)
    const bridge = new GoalPlanBridge({
      goalStore,
      planStore: manager.planStore,
      taskManager,
    })
    await bridge.bindApprovedPlan({ goalId: goal.id, planId })
    const current = manager.planStore.get(planId)!
    manager.planStore.save({
      ...current,
      status: PlanStatus.COMPLETED,
      completedAt: current.updatedAt + 1,
      steps: current.steps.map((step) => ({
        ...step,
        status: 'done',
        commands: [],
        verification: [],
      })),
    })

    const receipt = await bridge.planCompletionReceipt(goal.id)
    expect(receipt.completed).toBe(false)
    expect(receipt.invalidReasons).toContain('required_verification_incomplete')
    expect(receipt.steps[0]!.verificationBlockingErrors).toContain(
      'missing required typed verification requirement',
    )
  })
})

function skipIntentStage(plan: PlanRecord): string | null {
  const intent = plan.metadata.goal_skip_intent
  return intent && typeof intent === 'object' && !Array.isArray(intent)
    ? String((intent as Record<string, unknown>).stage ?? '') || null
    : null
}
