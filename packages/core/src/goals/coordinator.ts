import { randomUUID } from 'node:crypto'
import { CancelledTaskError, type ActiveTaskRegistry } from '../runtime/active'
import type { GoalGateResult } from './completion-gate'
import type { GoalRecord } from './models'
import { isGoalTerminal } from './models'
import { GoalProgressGuard, type GoalProgressSnapshot } from './progress-guard'
import type { GoalStore } from './store'
import { assertGoalTransition } from './validation'

export interface GoalCycleReceipt {
  readonly goalId: string
  readonly runId: string
  readonly cycle: number
  readonly turnId: string
  readonly startedAt: string
  readonly endedAt: string
  readonly progressSignatureBefore: string
  readonly progressSignatureAfter: string
  readonly outcome:
    'progress' | 'awaiting_user' | 'paused' | 'terminal' | 'failed'
  readonly reason?: string
}

export interface GoalRunHandle {
  readonly goalId: string
  readonly taskId: string
  readonly sessionId: string
  readonly promise: Promise<void>
  readonly abortController: AbortController
}

export interface GoalCycleTurnInput {
  readonly goal: GoalRecord
  readonly content: string
  readonly displayContent: string
  readonly source: 'goal'
  readonly uiHidden: boolean
  readonly useActiveTask: false
  readonly taskId: string
  readonly turnId: string
  readonly signal: AbortSignal
}

export interface GoalCoordinatorOptions {
  readonly goalStore: GoalStore
  readonly activeTasks: ActiveTaskRegistry
  readonly runTurn?: (input: GoalCycleTurnInput) => Promise<void>
  readonly evaluateGate?: (goalId: string) => Promise<GoalGateResult>
  readonly prepareVerification?: (goal: GoalRecord) => Promise<string | null>
  readonly progressSnapshot?: (
    goal: GoalRecord,
  ) => Promise<GoalProgressSnapshot> | GoalProgressSnapshot
  readonly pendingInteractionId?: (goal: GoalRecord) => string | null
  readonly estimatedCostUsd?: (goal: GoalRecord) => number | null
  readonly planStatus?: (planId: string) => string | null
  readonly executionPaused?: (goal: GoalRecord) => boolean
  readonly validateScope?: (goal: GoalRecord) => boolean | Promise<boolean>
  readonly now?: () => string
}

const CONTINUE_PROMPT =
  '[CONTROL:GOAL_CONTINUATION_RESUMED]\n继续推进当前 Goal；只依赖持久化 Goal、Plan 与 Evidence 状态，完成计划后进入验证。'
const COMPLETE_PROMPT =
  '当前 Goal Gate 已通过。现在必须调用 complete_goal 完成 Goal；不要只用文字宣称完成。'

export class GoalCoordinator {
  private readonly handles = new Map<string, GoalRunHandle>()
  private readonly guard = new GoalProgressGuard()
  private readonly now: () => string
  private turnSubmitter: GoalCoordinatorOptions['runTurn']
  private launchBarrier: Promise<void> = Promise.resolve()

  constructor(private readonly options: GoalCoordinatorOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.turnSubmitter = options.runTurn
  }

  setTurnSubmitter(submitter: GoalCoordinatorOptions['runTurn']): void {
    this.turnSubmitter = submitter
  }

  active(goalId: string): GoalRunHandle | null {
    return this.handles.get(goalId) ?? null
  }

  listActive(): readonly GoalRunHandle[] {
    return [...this.handles.values()]
  }

  async start(
    goalOrId: GoalRecord | string,
    initialContent?: string,
    initialDisplayContent?: string,
  ): Promise<GoalRecord> {
    return await this.serializeLaunch(async () => {
      return await this.startUnlocked(
        goalOrId,
        initialContent,
        initialDisplayContent,
      )
    })
  }

  private async startUnlocked(
    goalOrId: GoalRecord | string,
    initialContent?: string,
    initialDisplayContent?: string,
  ): Promise<GoalRecord> {
    let goal =
      typeof goalOrId === 'string'
        ? await this.requireGoal(goalOrId)
        : await this.ensurePersisted(goalOrId)
    if (isGoalTerminal(goal.status)) throw new Error('Goal is terminal.')
    if (goal.runtime.phase === 'awaiting_user')
      throw new Error('Goal is awaiting user control resolution.')
    if (this.handles.has(goal.id)) throw new Error('Goal is already running.')
    this.assertGlobalSerial(goal.id)
    const runId = randomUUID()
    goal = await this.update(
      goal,
      {
        runtime: {
          ...goal.runtime,
          currentRunId: runId,
          phase:
            goal.runtime.phase === 'paused'
              ? this.resumePhase(goal)
              : goal.runtime.phase,
          pauseReason: null,
        },
      },
      { reason: 'goal_run_started', runId },
    )
    const content = initialContent ?? goal.contract.outcome
    this.launch(goal, runId, content, initialDisplayContent ?? content)
    return goal
  }

  async resume(goalId: string, displayContent = ''): Promise<GoalRecord> {
    const goal = await this.requireGoal(goalId)
    if (goal.runtime.phase !== 'paused')
      throw new Error('Only a paused Goal can be resumed.')
    return await this.start(goal.id, CONTINUE_PROMPT, displayContent)
  }

  async resumeAfterControl(
    goalId: string,
    interactionId: string,
  ): Promise<GoalRecord> {
    let goal = await this.requireGoal(goalId)
    if (
      goal.runtime.phase !== 'awaiting_user' ||
      goal.runtime.pendingInteractionId !== interactionId
    )
      throw new Error('Goal control interaction does not match.')
    goal = await this.settleAfterControl(goal, interactionId)
    return await this.start(goal.id, CONTINUE_PROMPT, '')
  }

  async settleControl(
    goalId: string,
    interactionId: string,
  ): Promise<GoalRecord> {
    const goal = await this.requireGoal(goalId)
    return await this.settleAfterControl(goal, interactionId)
  }

  private async settleAfterControl(
    goal: GoalRecord,
    interactionId: string,
  ): Promise<GoalRecord> {
    if (
      goal.runtime.phase !== 'awaiting_user' ||
      goal.runtime.pendingInteractionId !== interactionId
    )
      throw new Error('Goal control interaction does not match.')
    return await this.update(
      goal,
      {
        runtime: {
          ...goal.runtime,
          phase: this.resumePhase(goal),
          pendingInteractionId: null,
          pauseReason: null,
        },
      },
      { reason: 'goal_control_resolved', interactionId },
    )
  }

  async pause(goalId: string, reason = 'user_stop'): Promise<GoalRecord> {
    const handle = this.handles.get(goalId)
    if (handle && !handle.abortController.signal.aborted)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    handle?.abortController.abort(reason)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.requireGoal(goalId)
      if (isGoalTerminal(current.status)) return current
      try {
        return await this.persistPause(current, reason)
      } catch (error) {
        if (!isGoalEventConflict(error) || attempt === 2) throw error
      }
    }
    throw new Error('Goal pause could not be persisted.')
  }

  async cancel(goalId: string, reason = 'user_cancelled'): Promise<GoalRecord> {
    const handle = this.handles.get(goalId)
    if (handle && !handle.abortController.signal.aborted)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    handle?.abortController.abort(reason)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.requireGoal(goalId)
      if (isGoalTerminal(current.status)) return current
      const now = this.now()
      try {
        return await this.update(
          current,
          {
            status: 'cancelled',
            runtime: {
              ...current.runtime,
              phase: 'terminal',
              currentRunId: null,
              pendingInteractionId: null,
              pauseReason: reason,
            },
            terminalAt: now,
            updatedAt: now,
          },
          { reason },
        )
      } catch (error) {
        if (!isGoalEventConflict(error) || attempt === 2) throw error
      }
    }
    throw new Error('Goal cancellation could not be persisted.')
  }

  async shutdown(): Promise<void> {
    const handles = [...this.handles.values()]
    await Promise.all(
      handles.map(async (handle) => {
        try {
          await this.pause(handle.goalId, 'shutdown_recovery_required')
        } catch {
          handle.abortController.abort('shutdown')
        }
      }),
    )
    await Promise.allSettled(handles.map((handle) => handle.promise))
  }

  private launch(
    goal: GoalRecord,
    runId: string,
    initialContent: string,
    initialDisplayContent: string,
  ): void {
    const taskId = `goal:${goal.id}`
    const abortController = new AbortController()
    const promise = this.options.activeTasks
      .run({
        taskId,
        kind: 'goal',
        label: `Goal: ${goal.contract.outcome.slice(0, 80)}`,
        sessionId: goal.scope.sessionId,
        abort: () => abortController.abort('active_task_cancelled'),
        execute: async () =>
          await this.runLoop(
            goal.id,
            runId,
            initialContent,
            initialDisplayContent,
            abortController.signal,
          ),
      })
      .catch(async (error: unknown) => {
        if (
          error instanceof CancelledTaskError ||
          abortController.signal.aborted
        )
          return
        const current = await this.options.goalStore.inspect(goal.id)
        if (
          current.record &&
          !current.issue &&
          !isGoalTerminal(current.record.status)
        )
          await this.persistPause(current.record, 'internal_error')
      })
      .finally(() => {
        if (this.handles.get(goal.id)?.promise === promise)
          this.handles.delete(goal.id)
      })
    this.handles.set(goal.id, {
      goalId: goal.id,
      taskId,
      sessionId: goal.scope.sessionId,
      promise,
      abortController,
    })
  }

  private async runLoop(
    goalId: string,
    runId: string,
    initialContent: string,
    initialDisplayContent: string,
    signal: AbortSignal,
  ): Promise<void> {
    let first = true
    let requestCompletion = false
    while (!signal.aborted) {
      let goal = await this.requireGoal(goalId)
      if (isGoalTerminal(goal.status) || goal.runtime.currentRunId !== runId)
        return
      if (
        goal.runtime.phase === 'paused' ||
        goal.runtime.phase === 'awaiting_user'
      )
        return
      if (
        this.options.validateScope &&
        !(await this.options.validateScope(goal))
      ) {
        await this.persistPause(goal, 'scope_mismatch')
        return
      }
      const policyReason = this.policyStopReason(goal)
      if (policyReason) {
        await this.stopByPolicy(goal, policyReason)
        return
      }
      const pendingBefore = this.options.pendingInteractionId?.(goal) ?? null
      if (pendingBefore) {
        await this.awaitControl(goal, pendingBefore)
        return
      }

      const before = await this.progressSnapshot(goal)
      if (signal.aborted) return
      const cycle = goal.runtime.cyclesUsed + 1
      const turnId = randomUUID().replaceAll('-', '').slice(0, 16)
      const startedAt = this.now()
      this.options.activeTasks.update(`goal:${goal.id}`, { turnId })
      const submit = this.turnSubmitter
      if (!submit) throw new Error('Goal turn submitter is not configured.')
      await submit({
        goal,
        content: requestCompletion
          ? COMPLETE_PROMPT
          : first
            ? initialContent
            : CONTINUE_PROMPT,
        displayContent: first ? initialDisplayContent : '',
        source: 'goal',
        uiHidden: !first || !initialDisplayContent,
        useActiveTask: false,
        taskId: `goal:${goal.id}`,
        turnId,
        signal,
      })
      first = false
      if (signal.aborted) return

      goal = await this.requireGoal(goalId)
      if (isGoalTerminal(goal.status)) return
      if (this.options.executionPaused?.(goal)) {
        await this.persistPause(goal, 'continuation_pause')
        return
      }
      const pendingAfter = this.options.pendingInteractionId?.(goal) ?? null
      if (pendingAfter) {
        await this.awaitControl(goal, pendingAfter)
        return
      }
      if (goal.runtime.phase === 'executing' && this.planCompleted(goal)) {
        goal = await this.update(
          goal,
          {
            runtime: { ...goal.runtime, phase: 'verifying' },
          },
          { reason: 'plan_completed' },
        )
      }
      let gate: GoalGateResult | null | undefined = null
      if (goal.runtime.phase === 'verifying') {
        const verificationInteraction =
          (await this.options.prepareVerification?.(goal)) ?? null
        goal = await this.requireGoal(goal.id)
        if (verificationInteraction) {
          await this.awaitControl(goal, verificationInteraction)
          return
        }
        gate = await this.options.evaluateGate?.(goal.id)
      }
      if (gate?.pass) {
        if (requestCompletion) {
          await this.persistPause(goal, 'completion_tool_not_called')
          return
        }
        requestCompletion = true
      }

      const after = await this.progressSnapshot(goal)
      const assessment = this.guard.assessCycle({
        before,
        after,
        previousConsecutiveNoEvidenceCycles:
          goal.runtime.consecutiveNoEvidenceCycles,
        pauseAfterCycles: goal.guardPolicy.noEvidencePauseAfterCycles,
      })
      const receipt: GoalCycleReceipt = {
        goalId: goal.id,
        runId,
        cycle,
        turnId,
        startedAt,
        endedAt: this.now(),
        progressSignatureBefore: assessment.beforeSignature,
        progressSignatureAfter: assessment.afterSignature,
        outcome: assessment.shouldPause
          ? 'paused'
          : assessment.progressed
            ? 'progress'
            : 'failed',
        ...(assessment.shouldPause ? { reason: 'no_new_evidence' } : {}),
      }
      goal = await this.update(
        goal,
        {
          runtime: {
            ...goal.runtime,
            cyclesUsed: cycle,
            consecutiveNoEvidenceCycles: assessment.consecutiveNoEvidenceCycles,
            ...(assessment.shouldPause
              ? {
                  phase: 'paused' as const,
                  currentRunId: null,
                  pauseReason: 'no_new_evidence',
                }
              : {}),
          },
        },
        { receipt },
      )
      if (assessment.shouldPause) return
    }
  }

  private planCompleted(goal: GoalRecord): boolean {
    const planId = goal.runtime.currentPlanId
    if (!planId) return false
    return this.options.planStatus?.(planId) === 'completed'
  }

  private resumePhase(goal: GoalRecord): GoalRecord['runtime']['phase'] {
    if (goal.status === 'draft') return 'contract'
    if (!goal.runtime.currentPlanId) return 'planning'
    return this.planCompleted(goal) ? 'verifying' : 'executing'
  }

  private policyStopReason(goal: GoalRecord): string | null {
    const policy = goal.guardPolicy
    if (
      policy.maxCycles !== null &&
      goal.runtime.cyclesUsed >= policy.maxCycles
    )
      return 'max_cycles'
    if (
      policy.deadlineAt !== null &&
      Date.parse(this.now()) >= Date.parse(policy.deadlineAt)
    )
      return 'deadline'
    if (policy.maxEstimatedCostUsd !== null) {
      const cost = this.options.estimatedCostUsd?.(goal)
      if (
        cost !== null &&
        cost !== undefined &&
        cost >= policy.maxEstimatedCostUsd
      )
        return 'max_estimated_cost'
    }
    return null
  }

  private async stopByPolicy(
    goal: GoalRecord,
    reason: string,
  ): Promise<GoalRecord> {
    const now = this.now()
    return await this.update(
      goal,
      {
        status: 'stopped_by_policy',
        runtime: {
          ...goal.runtime,
          phase: 'terminal',
          currentRunId: null,
          pendingInteractionId: null,
          pauseReason: reason,
        },
        terminalAt: now,
        updatedAt: now,
      },
      { reason, kind: 'goal_policy_stop' },
    )
  }

  private async awaitControl(
    goal: GoalRecord,
    interactionId: string,
  ): Promise<GoalRecord> {
    return await this.update(
      goal,
      {
        runtime: {
          ...goal.runtime,
          phase: 'awaiting_user',
          currentRunId: null,
          pendingInteractionId: interactionId,
          pauseReason: null,
        },
      },
      { reason: 'pending_control', interactionId },
    )
  }

  private async persistPause(
    goal: GoalRecord,
    reason: string,
  ): Promise<GoalRecord> {
    if (goal.runtime.phase === 'paused' && goal.runtime.pauseReason === reason)
      return goal
    return await this.update(
      goal,
      {
        runtime: {
          ...goal.runtime,
          phase: 'paused',
          currentRunId: null,
          pendingInteractionId: null,
          pauseReason: reason,
        },
      },
      { reason },
    )
  }

  private async progressSnapshot(
    goal: GoalRecord,
  ): Promise<GoalProgressSnapshot> {
    if (this.options.progressSnapshot)
      return await this.options.progressSnapshot(goal)
    const observations = await this.options.goalStore.readObservationsReadonly(
      goal.id,
    )
    return {
      lastEventSeq: goal.lastEventSeq,
      planUpdatedAt: null,
      activePlanStepId: null,
      activePlanStepStatus: null,
      evidenceIds: Object.values(goal.latestEvidenceByCriterion),
      observationCount: observations.records.length,
      pendingInteractionId: goal.runtime.pendingInteractionId,
    }
  }

  private async ensurePersisted(goal: GoalRecord): Promise<GoalRecord> {
    const existing = await this.options.goalStore.inspect(goal.id)
    if (existing.issue) throw new Error('Goal storage requires recovery.')
    return existing.record ?? (await this.options.goalStore.create(goal))
  }

  private async serializeLaunch<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.launchBarrier
    let release!: () => void
    this.launchBarrier = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await action()
    } finally {
      release()
    }
  }

  private async requireGoal(goalId: string): Promise<GoalRecord> {
    const inspected = await this.options.goalStore.inspect(goalId)
    if (inspected.issue) throw new Error('Goal storage requires recovery.')
    if (!inspected.record) throw new Error('Goal does not exist.')
    return inspected.record
  }

  private async update(
    current: GoalRecord,
    patch: Partial<GoalRecord>,
    data: Record<string, unknown>,
  ): Promise<GoalRecord> {
    const now = this.now()
    const next = assertGoalTransition(current, {
      ...current,
      ...patch,
      runtime: patch.runtime ?? current.runtime,
      updatedAt: patch.updatedAt ?? now,
    })
    return await this.options.goalStore.append(current.id, {
      type: 'goal_updated',
      record: next,
      createdAt: next.updatedAt,
      data: data as never,
      expectedLastEventSeq: current.lastEventSeq,
    })
  }

  private assertGlobalSerial(goalId: string): void {
    if (
      this.options.activeTasks
        .list()
        .some((task) => task.id !== `goal:${goalId}`)
    )
      throw new Error('Another mutation task is already running.')
  }
}

function isGoalEventConflict(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'goal_event_conflict'
  )
}
