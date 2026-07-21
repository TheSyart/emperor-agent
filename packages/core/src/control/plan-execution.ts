/**
 * PlanExecutionManager (MIG-CTRL-007)。对齐 Python `agent/control/plan_execution.py`。
 * approved→executing 激活、legacy todo→step 投影、step 任务同步、工具输出 sidechain。
 * task_manager 为 null 时（W14 未迁移）所有任务绑定逻辑 no-op —— 与 Python 一致。
 */
import { nowTs } from '../util/time'
import {
  PlanDraftPhase,
  PlanStatus,
  PlanStepStatus,
  planFromDict,
  planToDict,
  type PlanRecord,
  type PlanStep,
} from '../plans/models'
import { PlanExecutionState } from '../plans/execution-state'
import type { Interaction } from './models'
import { plansShareFullGoalScope } from '../goals/scope'
import { isTerminalTaskStatus } from '../tasks/models'
import {
  metadataWithoutPlanPermissionTokens,
  planStatusFromTodo,
  stepVerificationStatus,
  taskStatusFromPlanStep,
} from './plan-helpers'
import type { ControlManagerHost } from './host'

const TASK_KIND_PLAN_STEP = 'plan_step' // agent/tasks TaskKind.PLAN_STEP
const TASK_STATUS_FAILED = 'failed'

export type PlanExecutionPauseReason =
  | 'continuation_rejected'
  | 'no_progress'
  | 'evaluation_failed'
  | 'budget_exhausted'
  | 'verification_required'

export interface PlanExecutionPauseInput {
  reason: PlanExecutionPauseReason
  turnId: string
  pausedAt: number
  evaluationCount: number
  totalIterations: number
  nextActions: string[]
}

export class PlanExecutionManager {
  private readonly cm: ControlManagerHost
  constructor(cm: ControlManagerHost) {
    this.cm = cm
  }

  /**
   * Reconcile model Todo completion claims into the authoritative Plan.
   * A Todo may claim implementation completion, but a PlanStep only becomes
   * DONE after its required verification evidence is present.
   */
  syncPlanFromTodos(
    todos: Array<Record<string, unknown>>,
    opts?: { evidence?: Record<string, unknown> | null },
  ): PlanRecord | null {
    const record = this.cm.latestExecutablePlan()
    if (record === null || !record.steps.length) return null
    const evidence = opts?.evidence ?? null
    if (record.goalId !== null) {
      const activeGoal = this.cm.activeGoalPlanContext()
      if (!activeGoal || activeGoal.id !== record.goalId)
        throw new Error('Goal Todo binding does not match the current Goal')
    }
    const generation = Number(record.metadata.approval_generation ?? 0)
    const todoByStepId = new Map<string, Record<string, unknown>>()
    const independentTodos: Array<Record<string, unknown>> = []
    for (const item of todos) {
      if (!item || typeof item !== 'object') continue
      const planId = String(item.plan_id ?? '').trim()
      const stepId = String(item.plan_step_id ?? '').trim()
      const itemGeneration = Number(item.approval_generation)
      const carriesBinding =
        Boolean(planId) || Boolean(stepId) || Number.isFinite(itemGeneration)
      if (!carriesBinding) {
        independentTodos.push(item)
        continue
      }
      if (
        planId !== record.id ||
        !stepId ||
        !Number.isInteger(itemGeneration) ||
        itemGeneration !== generation
      )
        throw new Error(
          'Todo binding must match current plan_id, plan_step_id and approval_generation',
        )
      if (!record.steps.some((step) => step.id === stepId))
        throw new Error(`unknown todo plan_step_id: ${stepId}`)
      if (todoByStepId.has(stepId))
        throw new Error(`duplicate todo plan_step_id: ${stepId}`)
      todoByStepId.set(stepId, item)
    }
    if (todoByStepId.size !== record.steps.length)
      throw new Error(
        'Plan Todo projection must include every current Plan step',
      )
    const now = nowTs()
    let updated: PlanRecord = {
      ...record,
      metadata: {
        ...record.metadata,
        implementation_claims: {
          ...((record.metadata.implementation_claims as Record<
            string,
            unknown
          >) ?? {}),
        },
      },
    }
    for (const originalStep of record.steps) {
      const todo = todoByStepId.get(originalStep.id)!
      const todoStatus = String(todo.status ?? 'pending')
      const nextStatus = planStatusFromTodo(todoStatus)
      const currentStep = updated.steps.find(
        (step) => step.id === originalStep.id,
      )!
      const transitionEvidence = {
        ...(evidence ?? {}),
        todo_id: todo.id,
        plan_step_id: originalStep.id,
        todo_status: todoStatus,
        ...(nextStatus === PlanStepStatus.BLOCKED
          ? { blocked_reason: String(todo.blocked_reason ?? '').trim() }
          : {}),
        synced_at: now,
      }
      if (nextStatus === PlanStepStatus.DONE) {
        if (currentStep.status === PlanStepStatus.PENDING)
          throw new Error(
            `plan step ${originalStep.id} dependencies are not satisfied`,
          )
        const claims = {
          ...(updated.metadata.implementation_claims as Record<
            string,
            unknown
          >),
          [originalStep.id]: {
            ...transitionEvidence,
            plan_id: record.id,
            approval_generation: generation,
            source: 'todo_implementation_claim',
          },
        }
        updated = {
          ...updated,
          metadata: { ...updated.metadata, implementation_claims: claims },
        }
        const verifiable =
          stepVerificationStatus(currentStep) === 'passed' ||
          stepVerificationStatus(currentStep) === 'not_required'
        if (currentStep.status === PlanStepStatus.ACTIVE && verifiable) {
          updated = new PlanExecutionState(updated).completeStep(
            originalStep.id,
            { evidence: claims[originalStep.id] as Record<string, unknown> },
          )
          if (updated.status !== PlanStatus.COMPLETED)
            updated = new PlanExecutionState(updated).startNextStep()
        }
      } else if (nextStatus === PlanStepStatus.BLOCKED) {
        if (currentStep.status === PlanStepStatus.ACTIVE)
          updated = new PlanExecutionState(updated).blockStep(originalStep.id, {
            evidence: transitionEvidence,
          })
      } else if (
        nextStatus === PlanStepStatus.ACTIVE &&
        currentStep.status !== PlanStepStatus.ACTIVE
      ) {
        throw new Error(
          `plan step ${originalStep.id} dependencies are not satisfied`,
        )
      }
    }
    updated = { ...updated, updatedAt: now }
    updated = this.syncPlanStepTasks(updated)
    const saved = this.cm.planStore.save(updated)
    this.projectTodos(saved, independentTodos)
    return saved
  }

  normalizeTodoUpdate(
    todos: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const record = this.cm.latestExecutablePlan()
    if (record === null || !record.steps.length)
      return todos.map((todo) => ({ ...todo }))
    const generation = Number(record.metadata.approval_generation ?? 0)
    const stepsById = new Map(record.steps.map((step) => [step.id, step]))
    const updatesByStep = new Map<string, Record<string, unknown>>()
    const independent: Array<Record<string, unknown>> = []

    for (const raw of todos) {
      if (!raw || typeof raw !== 'object') continue
      const stableId = String(raw.id ?? '').trim()
      const stableStepId = stableId.startsWith('plan:')
        ? stableId.slice('plan:'.length).trim()
        : ''
      const explicitPlanId = String(raw.plan_id ?? raw.planId ?? '').trim()
      const explicitStepId = String(
        raw.plan_step_id ?? raw.planStepId ?? '',
      ).trim()
      const rawGeneration = raw.approval_generation ?? raw.approvalGeneration
      const explicitGeneration = Number(rawGeneration)
      const carriesExplicitBinding =
        Boolean(explicitPlanId) ||
        Boolean(explicitStepId) ||
        rawGeneration !== undefined
      const stepId = stableStepId || explicitStepId

      if (!stepId && !carriesExplicitBinding) {
        independent.push({ ...raw })
        continue
      }
      if (
        !stepId ||
        !stepsById.has(stepId) ||
        (carriesExplicitBinding &&
          (explicitPlanId !== record.id ||
            explicitStepId !== stepId ||
            !Number.isInteger(explicitGeneration) ||
            explicitGeneration !== generation))
      )
        throw new Error(
          'Todo binding must match the current Plan, step, and approval generation',
        )
      if (updatesByStep.has(stepId))
        throw new Error(`duplicate Todo binding for Plan step ${stepId}`)
      updatesByStep.set(stepId, raw)
    }

    const executionPaused = Boolean(record.metadata.execution_pause)
    const statusMap: Record<string, string> = {
      [PlanStepStatus.PENDING]: 'pending',
      [PlanStepStatus.ACTIVE]: executionPaused ? 'pending' : 'in_progress',
      [PlanStepStatus.DONE]: 'completed',
      [PlanStepStatus.FAILED]: 'pending',
      [PlanStepStatus.BLOCKED]: 'pending',
      [PlanStepStatus.SKIPPED]: 'completed',
    }
    const validStatuses = new Set([
      'pending',
      'in_progress',
      'completed',
      'blocked',
    ])
    const bound = record.steps.map((step) => {
      const raw = updatesByStep.get(step.id)
      const requestedStatus = String(raw?.status ?? '')
      const status = validStatuses.has(requestedStatus)
        ? requestedStatus
        : (statusMap[step.status] ?? 'pending')
      const item: Record<string, unknown> = {
        id: `plan:${step.id}`,
        plan_id: record.id,
        plan_step_id: step.id,
        approval_generation: generation,
        content: step.title,
        status,
      }
      const activeForm = String(
        raw?.active_form ?? raw?.activeForm ?? '',
      ).trim()
      if (activeForm) item.active_form = activeForm.slice(0, 240)
      const blockedReason = String(
        raw?.blocked_reason ?? raw?.blockedReason ?? '',
      ).trim()
      if (blockedReason) item.blocked_reason = blockedReason.slice(0, 1000)
      return item
    })
    const hasActivePlanStep = record.steps.some(
      (step) => step.status === PlanStepStatus.ACTIVE,
    )
    const normalized = [
      ...bound,
      ...independent.map((todo) =>
        hasActivePlanStep && String(todo.status ?? '') === 'in_progress'
          ? { ...todo, status: 'pending' }
          : { ...todo },
      ),
    ]
    this.validateTodoTransitions(record, normalized)
    return normalized
  }

  private validateTodoTransitions(
    record: PlanRecord,
    todos: Array<Record<string, unknown>>,
  ): void {
    const todoByStepId = new Map(
      todos
        .filter((todo) => String(todo.plan_step_id ?? '').trim())
        .map((todo) => [String(todo.plan_step_id), todo] as const),
    )
    let simulated = record
    for (const original of record.steps) {
      const todo = todoByStepId.get(original.id)
      if (!todo) continue
      const requested = planStatusFromTodo(String(todo.status ?? 'pending'))
      const current = simulated.steps.find((step) => step.id === original.id)!
      if (requested === PlanStepStatus.DONE) {
        if (current.status === PlanStepStatus.PENDING)
          throw new Error(
            `plan step ${original.id} dependencies are not satisfied`,
          )
        if (
          current.status === PlanStepStatus.ACTIVE &&
          (stepVerificationStatus(current) === 'passed' ||
            stepVerificationStatus(current) === 'not_required')
        ) {
          simulated = new PlanExecutionState(simulated).completeStep(
            original.id,
            { evidence: { source: 'todo_preflight' } },
          )
          if (simulated.status !== PlanStatus.COMPLETED)
            simulated = new PlanExecutionState(simulated).startNextStep()
        }
      } else if (
        requested === PlanStepStatus.ACTIVE &&
        current.status !== PlanStepStatus.ACTIVE
      ) {
        throw new Error(
          `plan step ${original.id} dependencies are not satisfied`,
        )
      }
    }
  }

  restoreCurrentPlanTodoProjection(): void {
    const record = this.cm.latestExecutablePlan()
    if (record === null) return
    const independent = (this.cm.todoStore?.todos ?? []).filter(
      (todo) =>
        !String(todo.plan_id ?? '').trim() &&
        !String(todo.plan_step_id ?? '').trim() &&
        !Number.isFinite(Number(todo.approval_generation)),
    )
    this.projectTodos(record, independent)
  }

  pauseExecution(input: PlanExecutionPauseInput): PlanRecord | null {
    const record = this.cm.latestExecutablePlan()
    if (record === null) return null
    const executionPause = {
      version: 1,
      reason: input.reason,
      turn_id: input.turnId,
      paused_at: input.pausedAt,
      evaluation_count: Math.max(0, Math.trunc(input.evaluationCount)),
      total_iterations: Math.max(0, Math.trunc(input.totalIterations)),
      next_actions: input.nextActions
        .map((action) => String(action).trim())
        .filter(Boolean)
        .slice(0, 12),
    }
    let paused: PlanRecord = {
      ...record,
      updatedAt: nowTs(),
      metadata: {
        ...record.metadata,
        execution_pause: executionPause,
      },
    }
    paused = this.cm.planStore.save(paused)
    try {
      paused = this.syncPlanStepTasks(paused)
      paused = this.cm.planStore.save(paused)
    } catch {
      this.reconcileExecutablePlanTasks()
      paused = this.cm.planStore.get(paused.id) ?? paused
    }
    const independent = (this.cm.todoStore?.todos ?? []).filter(
      (todo) => !String(todo.plan_id ?? '').trim(),
    )
    try {
      this.projectTodos(paused, independent)
    } catch {
      // Plan metadata remains authoritative; session attach/restart replays it.
    }
    return paused
  }

  resumeExecution(input: { turnId: string }): PlanRecord | null {
    const record = this.cm.latestExecutablePlan()
    if (record === null || !record.metadata.execution_pause) return null
    const metadata = { ...record.metadata }
    delete metadata.execution_pause
    metadata.last_execution_resume = {
      turn_id: input.turnId,
      resumed_at: nowTs(),
    }
    let resumed: PlanRecord = {
      ...record,
      updatedAt: nowTs(),
      metadata,
    }
    resumed = this.cm.planStore.save(resumed)
    try {
      resumed = this.syncPlanStepTasks(resumed)
      resumed = this.cm.planStore.save(resumed)
    } catch {
      this.reconcileExecutablePlanTasks()
      resumed = this.cm.planStore.get(resumed.id) ?? resumed
    }
    const independent = (this.cm.todoStore?.todos ?? []).filter(
      (todo) => !String(todo.plan_id ?? '').trim(),
    )
    try {
      this.projectTodos(resumed, independent)
    } catch {
      // Plan metadata remains authoritative; session attach/restart replays it.
    }
    return resumed
  }

  /**
   * Entering Plan mode starts a new, permanent planning lineage for exactly
   * the active runtime scope.  There is deliberately no restoration path:
   * cancelling the successor leaves every predecessor cancelled.
   */
  beginPlanReplacement(successor: PlanRecord): {
    successor: PlanRecord
    cancelledPlanIds: string[]
  } | null {
    const scope = this.cm.planScopeMetadata()
    if (!scope?.session_id) return null
    const activeGoalId = this.cm.activeGoalPlanContext()?.id ?? null
    const replaceable = this.cm.planStore
      .list()
      .filter(
        (record) =>
          record.goalId === activeGoalId &&
          this.cm.planMatchesCurrentScope(record) &&
          (record.status === PlanStatus.DRAFT ||
            record.status === PlanStatus.WAITING_APPROVAL ||
            record.status === PlanStatus.APPROVED ||
            record.status === PlanStatus.EXECUTING),
      )
    const predecessor = replaceable.reduce<PlanRecord | null>(
      (latest, record) =>
        latest === null ||
        record.updatedAt > latest.updatedAt ||
        (record.updatedAt === latest.updatedAt && record.id > latest.id)
          ? record
          : latest,
      null,
    )
    const now = nowTs()
    const cancelledPlanIds: string[] = []
    const cancelledRecords: PlanRecord[] = []
    for (const record of replaceable) {
      const taskMap =
        record.metadata.plan_step_tasks &&
        typeof record.metadata.plan_step_tasks === 'object' &&
        !Array.isArray(record.metadata.plan_step_tasks)
          ? {
              ...(record.metadata.plan_step_tasks as Record<string, string>),
            }
          : {}
      const metadata = metadataWithoutPlanPermissionTokens(record.metadata, {
        reason: 'Plan mode entered with a replacement draft',
      })
      metadata.plan_step_tasks_revoked = taskMap
      metadata.plan_step_tasks_revocation_pending = Object.values(taskMap)
      metadata.plan_step_tasks = {}
      metadata.superseded_by = successor.id
      metadata.superseded_at = now
      metadata.superseded_reason = 'Plan mode entered with a replacement draft'
      metadata.supersession_audit = {
        predecessor_plan_id: record.id,
        successor_plan_id: successor.id,
        goal_id: activeGoalId,
        reason: 'Plan mode entered with a replacement draft',
        at: now,
      }
      cancelledRecords.push({
        ...record,
        status: PlanStatus.CANCELLED,
        updatedAt: now,
        metadata,
      })
      cancelledPlanIds.push(record.id)
    }
    const successorWithLineage = {
      ...successor,
      supersedesPlanId: predecessor?.id ?? null,
    }
    const saved = this.cm.planStore.saveBatch([
      ...cancelledRecords,
      successorWithLineage,
    ])
    const savedSuccessor = saved.find((record) => record.id === successor.id)
    if (!savedSuccessor)
      throw new Error('Plan replacement did not persist its successor')
    // Durable task revocation metadata is committed with the Plan batch;
    // reconciliation is idempotent and reruns when TaskManager attaches.
    this.reconcileRevokedPlanTasks(cancelledPlanIds)
    this.removeTodoBindings(cancelledPlanIds)
    return {
      successor: savedSuccessor,
      cancelledPlanIds,
    }
  }

  reconcileRevokedPlanTasks(onlyPlanIds?: readonly string[]): void {
    if (this.cm.taskManager === null) return
    const only = onlyPlanIds ? new Set(onlyPlanIds) : null
    for (const record of this.cm.planStore.list()) {
      if (record.status !== PlanStatus.CANCELLED) continue
      if (only && !only.has(record.id)) continue
      const raw = record.metadata.plan_step_tasks_revocation_pending
      if (!Array.isArray(raw)) continue
      const taskIds = raw
        .map((item) => String(item ?? '').trim())
        .filter(Boolean)
      let reconciled = true
      for (const taskId of taskIds) {
        try {
          const current = this.cm.taskManager.store.get(taskId)
          if (current === null) continue
          const status = String(current.status ?? '')
          if (isTerminalTaskStatus(status)) continue
          const cancelled = this.cm.taskManager.cancelTask(taskId, {
            reason: 'Plan mode entered with a replacement draft',
          })
          if (String(cancelled?.status ?? '') !== 'cancelled')
            reconciled = false
        } catch {
          reconciled = false
        }
      }
      if (!reconciled) continue
      const metadata = { ...record.metadata }
      delete metadata.plan_step_tasks_revocation_pending
      metadata.plan_step_tasks_reconciled_at = nowTs()
      try {
        this.cm.planStore.save({ ...record, metadata })
      } catch {
        // The pending marker remains durable and will be retried later.
      }
    }
  }

  /**
   * Plan metadata is the durable authority. Rebuild Task projections from it
   * whenever TaskManager attaches so a crash between Plan, Task, and Todo
   * writes cannot leave an active step permanently running or pending.
   */
  reconcileExecutablePlanTasks(): void {
    if (this.cm.taskManager === null) return
    for (const record of this.cm.planStore.list()) {
      if (
        record.status !== PlanStatus.APPROVED &&
        record.status !== PlanStatus.EXECUTING
      )
        continue
      try {
        const reconciled = this.syncPlanStepTasks(record)
        this.cm.planStore.save(reconciled)
      } catch {
        // The authoritative Plan remains durable; attachment/restart retries.
      }
    }
  }

  /** 批准新计划时取代同 store 内滞留的 approved/executing 旧计划，防止僵尸累积（B1）。 */
  supersedeStaleExecutingPlans(newPlanId: string): void {
    const successor = this.cm.planStore.get(newPlanId)
    if (successor === null) throw new Error('successor Plan does not exist')
    const now = nowTs()
    const cancelledRecords: PlanRecord[] = []
    const cancelledPlanIds: string[] = []
    for (const record of this.cm.planStore.list()) {
      if (record.id === newPlanId) continue
      if (
        record.status !== PlanStatus.APPROVED &&
        record.status !== PlanStatus.EXECUTING
      )
        continue
      if (
        record.goalId !== successor.goalId ||
        !plansShareFullGoalScope(record, successor)
      )
        continue
      const taskMap =
        record.metadata.plan_step_tasks &&
        typeof record.metadata.plan_step_tasks === 'object' &&
        !Array.isArray(record.metadata.plan_step_tasks)
          ? {
              ...(record.metadata.plan_step_tasks as Record<string, string>),
            }
          : {}
      const metadata = metadataWithoutPlanPermissionTokens(record.metadata, {
        reason: 'Plan superseded by an approved successor',
      })
      metadata.plan_step_tasks_revoked = taskMap
      metadata.plan_step_tasks_revocation_pending = Object.values(taskMap)
      metadata.plan_step_tasks = {}
      metadata.superseded_by = newPlanId
      metadata.superseded_at = now
      metadata.supersession_audit = {
        predecessor_plan_id: record.id,
        successor_plan_id: newPlanId,
        goal_id: successor.goalId,
      }
      // 不碰 updatedAt：取代是记账而非活动，latest() 必须继续指向新计划
      cancelledRecords.push({
        ...record,
        status: PlanStatus.CANCELLED,
        metadata,
      })
      cancelledPlanIds.push(record.id)
    }
    if (!cancelledRecords.length) return
    this.cm.planStore.saveBatch(cancelledRecords)
    this.reconcileRevokedPlanTasks(cancelledPlanIds)
    this.removeTodoBindings(cancelledPlanIds)
  }

  recordPlanStepToolOutput(opts: {
    toolName: string
    summary: string
    toolCallId?: string | null
    artifacts?: Array<Record<string, unknown>> | null
    metadata?: Record<string, unknown> | null
    isError?: boolean
  }): unknown {
    const [record, step, taskId] = this.activePlanStepTask()
    if (
      record === null ||
      step === null ||
      taskId === null ||
      this.cm.taskManager === null
    )
      return null
    const message = {
      kind: 'tool_output',
      role: 'tool',
      plan_id: record.id,
      plan_step_id: step.id,
      tool_name: String(opts.toolName ?? ''),
      tool_call_id: opts.toolCallId ?? null,
      content: String(opts.summary ?? '').slice(0, 2000),
      artifacts: opts.artifacts ?? [],
      metadata: opts.metadata ?? {},
      is_error: Boolean(opts.isError),
    }
    this.cm.taskManager.appendSidechain(taskId, message)
    const task = this.cm.taskManager.store.get(taskId)
    const progress = task !== null ? { ...task.progress } : {}
    progress.last_tool = String(opts.toolName ?? '')
    progress.last_summary = String(opts.summary ?? '').slice(0, 500)
    progress.last_tool_call_id = opts.toolCallId ?? null
    return this.cm.taskManager.updateTask(taskId, { progress })
  }

  reconcileAfterVerification(record: PlanRecord): PlanRecord {
    const claims =
      record.metadata.implementation_claims &&
      typeof record.metadata.implementation_claims === 'object' &&
      !Array.isArray(record.metadata.implementation_claims)
        ? (record.metadata.implementation_claims as Record<
            string,
            Record<string, unknown>
          >)
        : {}
    const active = record.steps.find(
      (step) => step.status === PlanStepStatus.ACTIVE,
    )
    let updated = record
    if (
      active &&
      claims[active.id] &&
      stepVerificationStatus(active) === 'passed'
    ) {
      updated = new PlanExecutionState(updated).completeStep(active.id, {
        evidence: claims[active.id]!,
      })
      if (updated.status !== PlanStatus.COMPLETED)
        updated = new PlanExecutionState(updated).startNextStep()
      updated = this.syncPlanStepTasks(updated)
      updated = this.cm.planStore.save(updated)
    }
    const independent = (this.cm.todoStore?.todos ?? []).filter(
      (todo) => !String(todo.plan_id ?? '').trim(),
    )
    this.projectTodos(updated, independent)
    return updated
  }

  private projectTodos(
    record: PlanRecord,
    independentTodos: Array<Record<string, unknown>>,
  ): void {
    if (this.cm.todoStore === null) return
    const generation = Number(record.metadata.approval_generation ?? 0)
    const statusMap: Record<string, string> = {
      [PlanStepStatus.PENDING]: 'pending',
      [PlanStepStatus.ACTIVE]: 'in_progress',
      [PlanStepStatus.DONE]: 'completed',
      [PlanStepStatus.FAILED]: 'pending',
      [PlanStepStatus.BLOCKED]: 'pending',
      [PlanStepStatus.SKIPPED]: 'completed',
    }
    const executionPaused = Boolean(record.metadata.execution_pause)
    const bound = record.steps.map((step) => ({
      id: `plan:${step.id}`,
      plan_id: record.id,
      plan_step_id: step.id,
      approval_generation: generation,
      content: step.title,
      status:
        executionPaused && step.status === PlanStepStatus.ACTIVE
          ? 'pending'
          : (statusMap[step.status] ?? 'pending'),
      ...(step.status === PlanStepStatus.BLOCKED
        ? { blocked_reason: 'Plan step is blocked' }
        : {}),
    }))
    const hasActivePlanStep = bound.some(
      (todo) => todo.status === 'in_progress',
    )
    const independent = independentTodos.map((todo) =>
      hasActivePlanStep && String(todo.status ?? '') === 'in_progress'
        ? { ...todo, status: 'pending' }
        : todo,
    )
    this.replaceTodos([...bound, ...independent])
  }

  private removeTodoBindings(planIds: readonly string[]): void {
    if (!planIds.length || this.cm.todoStore === null) return
    const cancelled = new Set(planIds)
    this.replaceTodos(
      this.cm.todoStore.todos.filter(
        (todo) => !cancelled.has(String(todo.plan_id ?? '').trim()),
      ),
    )
  }

  private replaceTodos(items: Array<Record<string, unknown>>): void {
    if (this.cm.todoStore === null) return
    if (!this.cm.todoStore.update) {
      this.cm.todoStore.todos = items
      return
    }
    const result = this.cm.todoStore.update(items)
    if (/^Error:/i.test(result.trim()))
      throw new Error(`Plan Todo projection failed: ${result}`)
  }

  private syncPlanStepTasks(record: PlanRecord): PlanRecord {
    if (this.cm.taskManager === null || !record.steps.length) return record
    const mapping = {
      ...((record.metadata.plan_step_tasks as Record<string, string>) ?? {}),
    }
    const scope = planStepTaskScope(record, this.cm.planScopeMetadata())
    record.steps.forEach((step, idx) => {
      const index = idx + 1
      const metadata = {
        plan_id: record.id,
        plan_step_id: step.id,
        approval_generation: Number(record.metadata.approval_generation ?? 0),
        sequence: index,
        verification_status: stepVerificationStatus(step),
        ...(scope ? { scope } : {}),
      }
      const taskId = String(mapping[step.id] ?? '')
      const executionPause = record.metadata.execution_pause
      const status =
        executionPause && step.status === PlanStepStatus.ACTIVE
          ? 'pending'
          : taskStatusFromPlanStep(step.status)
      if (taskId && this.cm.taskManager!.store.get(taskId) !== null) {
        const task = this.cm.taskManager!.store.get(taskId)
        const progress = task !== null ? { ...task.progress } : {}
        progress.verification_status = metadata.verification_status
        if (executionPause && step.status === PlanStepStatus.ACTIVE)
          progress.execution_pause = executionPause
        else delete progress.execution_pause
        this.cm.taskManager!.updateTask(taskId, {
          status,
          title: step.title,
          metadata,
          progress,
        })
        return
      }
      const task = this.cm.taskManager!.startTask({
        kind: TASK_KIND_PLAN_STEP,
        title: step.title,
        source: 'plan_step',
        status,
        sessionId:
          record.sessionId ??
          (this.cm.planScopeMetadata()?.session_id as string | undefined) ??
          null,
        metadata,
      })
      mapping[step.id] = task.id
    })
    const metadata = { ...record.metadata }
    metadata.plan_step_tasks = mapping
    return { ...record, metadata }
  }

  private activePlanStepTask(): [
    PlanRecord | null,
    PlanStep | null,
    string | null,
  ] {
    const record = this.cm.latestExecutablePlan()
    if (record === null) return [null, null, null]
    const mapping = record.metadata.plan_step_tasks
    if (!mapping || typeof mapping !== 'object') return [record, null, null]
    for (const step of record.steps) {
      if (step.status !== PlanStepStatus.ACTIVE) continue
      const taskId = String((mapping as Record<string, string>)[step.id] ?? '')
      return [record, step, taskId || null]
    }
    return [record, null, null]
  }

  appendPlanStepVerification(
    record: PlanRecord,
    opts: { stepId: string; result: Record<string, unknown> },
  ): void {
    if (this.cm.taskManager === null) return
    const mapping = record.metadata.plan_step_tasks
    if (!mapping || typeof mapping !== 'object') return
    const taskId = String(
      (mapping as Record<string, string>)[opts.stepId] ?? '',
    )
    if (!taskId) return
    const passed = opts.result.passed
    const verificationStatus =
      passed === true ? 'passed' : passed === false ? 'failed' : 'unknown'
    this.cm.taskManager.appendSidechain(taskId, {
      kind: 'verification',
      role: 'tool',
      plan_id: record.id,
      plan_step_id: opts.stepId,
      tool_name: String(opts.result.source ?? 'run_command'),
      command: String(opts.result.command ?? ''),
      content: String(opts.result.summary ?? opts.result.error ?? '').slice(
        0,
        2000,
      ),
      passed,
      result: { ...opts.result },
    })
    const task = this.cm.taskManager.store.get(taskId)
    const progress = task !== null ? { ...task.progress } : {}
    progress.verification_status = verificationStatus
    progress.last_verification = { ...opts.result }
    const fields: Record<string, unknown> = { progress }
    if (passed === false) fields.status = TASK_STATUS_FAILED
    this.cm.taskManager.updateTask(taskId, fields)
  }

  updatePlanStatus(
    interaction: Interaction,
    status: string,
    opts?: { approved?: boolean },
  ): PlanRecord | null {
    const planId = String(interaction.meta.plan_id ?? '')
    if (!planId) return null
    const record = this.cm.planStore.get(planId)
    if (record === null) return null
    const now = nowTs()
    let draft = record.draft
    if (opts?.approved) draft = { ...draft, phase: PlanDraftPhase.APPROVED }
    const scope = this.cm.planScopeMetadata()
    const metadata = {
      ...record.metadata,
      ...(scope && !record.metadata.scope ? { scope } : {}),
    }
    const payload: Record<string, unknown> = {
      ...planToDict(record),
      status,
      updated_at: now,
      draft: {
        ...(planToDict({ ...record, draft }).draft as Record<string, unknown>),
      },
      metadata,
    }
    if (opts?.approved) payload.approved_at = now
    return this.cm.planStore.save(planFromDict(payload))
  }

  activateApprovedPlan(interaction: Interaction): PlanRecord | null {
    const planId = String(interaction.meta.plan_id ?? '')
    if (!planId) return null
    const record = this.cm.planStore.get(planId)
    if (record === null) return null
    if (this.cm.todoStore === null || !record.steps.length) return record
    let activated = new PlanExecutionState(record).startNextStep()
    activated = {
      ...activated,
      draft: { ...activated.draft, phase: PlanDraftPhase.EXECUTING },
    }
    activated = this.cm.permissionTokens.issue(activated)
    activated = this.syncPlanStepTasks(activated)
    const saved = this.cm.planStore.save(activated)
    const independent = this.cm.todoStore.todos.filter(
      (todo) => !String(todo.plan_id ?? '').trim(),
    )
    this.projectTodos(saved, independent)
    return saved
  }
}

function planStepTaskScope(
  record: PlanRecord,
  current: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const saved = record.metadata.scope
  if (saved && typeof saved === 'object' && !Array.isArray(saved))
    return { ...(saved as Record<string, unknown>) }
  return current ? { ...current } : null
}
