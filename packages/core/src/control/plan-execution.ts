/**
 * PlanExecutionManager (MIG-CTRL-007)。对齐 Python `agent/control/plan_execution.py`。
 * approved→executing 激活、legacy Todo 迁移、已有后台 step 任务同步与工具输出 sidechain。
 * 前台 PlanStep 本身不创建持久 Task；Goal/后台协调器若显式建立了 task binding，
 * 本管理器只负责按 Plan 权威状态更新该既有绑定。
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
  stepVerificationStatus,
  taskStatusFromPlanStep,
} from './plan-helpers'
import type { ControlManagerHost } from './host'

const TASK_STATUS_FAILED = 'failed'

export type PlanExecutionPauseReason =
  | 'continuation_rejected'
  | 'no_progress'
  | 'verification_required'
  | 'user_input_required'

export interface PlanExecutionPauseInput {
  reason: PlanExecutionPauseReason
  turnId: string
  executionId?: string | null
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

  completePlanStep(input: {
    stepId: string
    summary: string
    toolCallId?: string | null
    turnId?: string | null
  }): PlanRecord {
    const record = this.cm.latestExecutablePlan()
    if (record === null) throw new Error('no executable Plan')
    const active = record.steps.find(
      (step) => step.status === PlanStepStatus.ACTIVE,
    )
    if (active === undefined) throw new Error('Plan has no active step')
    if (active.id !== String(input.stepId ?? '').trim())
      throw new Error(`active Plan step is ${active.id}`)
    const summary = String(input.summary ?? '').trim()
    if (!summary) throw new Error('Plan step completion summary is required')
    const now = nowTs()
    const generation = Number(record.metadata.approval_generation ?? 0)
    const claim = {
      source: 'plan_step_completion',
      issued_by: 'model',
      plan_id: record.id,
      plan_step_id: active.id,
      approval_generation: generation,
      summary: summary.slice(0, 2000),
      tool_call_id: String(input.toolCallId ?? '').trim() || null,
      turn_id: String(input.turnId ?? '').trim() || null,
      claimed_at: now,
    }
    const verificationStatus = stepVerificationStatus(active)
    const claims = {
      ...((record.metadata.implementation_claims as Record<string, unknown>) ??
        {}),
      [active.id]: claim,
    }
    const phases = {
      ...((record.metadata.plan_step_execution_phases as Record<
        string,
        string
      >) ?? {}),
      [active.id]:
        verificationStatus === 'failed'
          ? 'repairing'
          : verificationStatus === 'pending'
            ? 'verifying'
            : 'completed',
    }
    let updated: PlanRecord = {
      ...record,
      updatedAt: now,
      metadata: {
        ...record.metadata,
        implementation_claims: claims,
        plan_step_execution_phases: phases,
      },
    }
    if (
      verificationStatus === 'passed' ||
      verificationStatus === 'not_required'
    ) {
      updated = new PlanExecutionState(updated).completeStep(active.id, {
        evidence: claim,
      })
      if (updated.status !== PlanStatus.COMPLETED)
        updated = new PlanExecutionState(updated).startNextStep()
    }
    updated = this.syncPlanStepTasks(updated)
    return this.cm.planStore.save(updated)
  }

  normalizeTodoUpdate(
    todos: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    const independent: Array<Record<string, unknown>> = []

    for (const raw of todos) {
      if (!raw || typeof raw !== 'object') continue
      const stableId = String(raw.id ?? '').trim()
      const explicitPlanId = String(raw.plan_id ?? raw.planId ?? '').trim()
      const explicitStepId = String(
        raw.plan_step_id ?? raw.planStepId ?? '',
      ).trim()
      const rawGeneration = raw.approval_generation ?? raw.approvalGeneration
      const carriesExplicitBinding =
        Boolean(explicitPlanId) ||
        Boolean(explicitStepId) ||
        rawGeneration !== undefined

      if (carriesExplicitBinding)
        throw new Error(
          'Todo cannot bind to PlanStep authority; use complete_plan_step',
        )
      // One-time compatibility: old clients may still replay plan:<stepId>.
      // They are mirrors, not user WorkItems, so they are discarded.
      if (stableId.startsWith('plan:')) continue
      independent.push({ ...raw })
    }
    return independent
  }

  migrateLegacyPlanTodoMirrors(): void {
    if (this.cm.todoStore === null) return
    const plans = new Map(
      this.cm.planStore.list().map((record) => [record.id, record] as const),
    )
    const migrated: Array<Record<string, unknown>> = []
    for (const todo of this.cm.todoStore.todos) {
      const planId = String(todo.plan_id ?? '').trim()
      const stepId = String(todo.plan_step_id ?? '').trim()
      const stableId = String(todo.id ?? '').trim()
      const legacy = Boolean(planId || stepId || stableId.startsWith('plan:'))
      if (!legacy) {
        migrated.push({ ...todo })
        continue
      }
      const resolvedStepId =
        stepId || (stableId.startsWith('plan:') ? stableId.slice(5) : '')
      const step = plans
        .get(planId)
        ?.steps.find((candidate) => candidate.id === resolvedStepId)
      const content = String(todo.content ?? '').trim()
      if (!content || content === step?.title) continue
      migrated.push({
        id: `work:${resolvedStepId || stableId || migrated.length + 1}`,
        content,
        status: 'pending',
        work_item: true,
        ...(planId ? { owner_plan_id: planId } : {}),
        ...(resolvedStepId ? { covers_plan_step_ids: [resolvedStepId] } : {}),
      })
    }
    this.replaceTodos(migrated)
  }

  pauseExecution(input: PlanExecutionPauseInput): PlanRecord | null {
    const record = this.cm.latestExecutablePlan()
    if (record === null) return null
    const executionId = String(input.executionId ?? '').trim()
    const executionPause = {
      version: 1,
      reason: input.reason,
      turn_id: input.turnId,
      ...(executionId ? { execution_id: executionId } : {}),
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
    return paused
  }

  resumeExecution(input: { turnId: string }): PlanRecord | null {
    const record = this.cm.latestExecutablePlan()
    if (record === null || !record.metadata.execution_pause) return null
    const metadata = { ...record.metadata }
    delete metadata.execution_pause
    const active = record.steps.find(
      (step) => step.status === PlanStepStatus.ACTIVE,
    )
    if (active) {
      const phases = {
        ...((metadata.plan_step_execution_phases as Record<string, string>) ??
          {}),
      }
      if (phases[active.id] === 'waiting_user') {
        const claims =
          metadata.implementation_claims &&
          typeof metadata.implementation_claims === 'object' &&
          !Array.isArray(metadata.implementation_claims)
            ? (metadata.implementation_claims as Record<string, unknown>)
            : {}
        phases[active.id] = claims[active.id]
          ? stepVerificationStatus(active) === 'failed'
            ? 'repairing'
            : 'verifying'
          : 'implementing'
        metadata.plan_step_execution_phases = phases
      }
    }
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

  cancelPlanFromUserAction(input: {
    planId: string
    stepId: string
    interactionId: string
    settlementId: string
  }): PlanRecord {
    const record = this.cm.planStore.get(input.planId)
    if (record === null) throw new Error('Plan cancellation target is missing')
    const existingSettlements = Array.isArray(
      record.metadata.plan_execution_settlements,
    )
      ? (record.metadata.plan_execution_settlements as unknown[])
      : []
    if (
      record.status === PlanStatus.CANCELLED &&
      existingSettlements.some(
        (item) =>
          item &&
          typeof item === 'object' &&
          String((item as Record<string, unknown>).settlement_id ?? '') ===
            input.settlementId,
      )
    )
      return record
    if (
      record.status !== PlanStatus.APPROVED &&
      record.status !== PlanStatus.EXECUTING
    )
      throw new Error('Plan is no longer cancellable')
    const taskMap =
      record.metadata.plan_step_tasks &&
      typeof record.metadata.plan_step_tasks === 'object' &&
      !Array.isArray(record.metadata.plan_step_tasks)
        ? {
            ...(record.metadata.plan_step_tasks as Record<string, string>),
          }
        : {}
    const now = nowTs()
    const evidence = {
      source: 'user_plan_cancellation',
      issued_by: 'core',
      approved_by: 'user',
      settlement_id: input.settlementId,
      interaction_id: input.interactionId,
      plan_id: record.id,
      plan_step_id: input.stepId,
      cancelled_at: now,
    }
    const metadata = metadataWithoutPlanPermissionTokens(record.metadata, {
      reason: 'User cancelled the active Plan through a signed Core action',
    })
    delete metadata.execution_pause
    metadata.plan_step_tasks_revoked = taskMap
    metadata.plan_step_tasks_revocation_pending = Object.values(taskMap)
    metadata.plan_step_tasks = {}
    metadata.cancelled_by = 'user_plan_execution_action'
    metadata.cancelled_interaction_id = input.interactionId
    metadata.cancelled_settlement_id = input.settlementId
    metadata.plan_step_execution_phases = {
      ...((record.metadata.plan_step_execution_phases as Record<
        string,
        string
      >) ?? {}),
      [input.stepId]: 'cancelled',
    }
    metadata.plan_execution_settlements = [
      ...existingSettlements,
      {
        settlement_id: input.settlementId,
        interaction_id: input.interactionId,
        action: 'cancel_plan',
        issued_by: 'core',
        applied_at: now,
      },
    ]
    const cancelled = this.cm.planStore.save({
      ...record,
      status: PlanStatus.CANCELLED,
      updatedAt: now,
      steps: record.steps.map((step) =>
        step.status === PlanStepStatus.DONE ||
        step.status === PlanStepStatus.SKIPPED
          ? step
          : {
              ...step,
              status: PlanStepStatus.SKIPPED,
              evidence: [...step.evidence, evidence],
            },
      ),
      metadata,
    })
    this.reconcileRevokedPlanTasks([record.id])
    this.removeTodoBindings([record.id])
    return this.cm.planStore.get(record.id) ?? cancelled
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
    if (active && claims[active.id]) {
      const verificationStatus = stepVerificationStatus(active)
      const phases = {
        ...((updated.metadata.plan_step_execution_phases as Record<
          string,
          string
        >) ?? {}),
        [active.id]:
          verificationStatus === 'passed'
            ? 'completed'
            : verificationStatus === 'failed'
              ? 'repairing'
              : 'verifying',
      }
      updated = {
        ...updated,
        metadata: {
          ...updated.metadata,
          plan_step_execution_phases: phases,
        },
      }
    }
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
    }
    updated = this.syncPlanStepTasks(updated)
    updated = this.cm.planStore.save(updated)
    return updated
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
      throw new Error(`Legacy WorkItem migration failed: ${result}`)
  }

  private syncPlanStepTasks(record: PlanRecord): PlanRecord {
    if (this.cm.taskManager === null || !record.steps.length) return record
    const mapping = {
      ...((record.metadata.plan_step_tasks as Record<string, string>) ?? {}),
    }
    // PlanStep is the foreground execution authority. Persistent Tasks are
    // reserved for Goal/background/coordinated work and are created by those
    // owners. An ordinary approved Plan therefore has no task mapping.
    if (!Object.values(mapping).some((taskId) => String(taskId).trim()))
      return record
    record.steps.forEach((step, idx) => {
      const index = idx + 1
      const metadata = {
        plan_id: record.id,
        plan_step_id: step.id,
        approval_generation: Number(record.metadata.approval_generation ?? 0),
        sequence: index,
        verification_status: stepVerificationStatus(step),
      }
      const taskId = String(mapping[step.id] ?? '')
      if (!taskId) return
      const executionPause = record.metadata.execution_pause
      const status =
        executionPause && step.status === PlanStepStatus.ACTIVE
          ? 'pending'
          : taskStatusFromPlanStep(step.status)
      if (this.cm.taskManager!.store.get(taskId) !== null) {
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
      // A missing background binding is not silently recreated here: the
      // owner (Goal/coordinator) must recover it with its lease and scope.
      delete mapping[step.id]
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
    if (!record.steps.length) return record
    let activated = new PlanExecutionState(record).startNextStep()
    activated = {
      ...activated,
      draft: { ...activated.draft, phase: PlanDraftPhase.EXECUTING },
    }
    activated = this.cm.permissionTokens.issue(activated)
    activated = this.syncPlanStepTasks(activated)
    return this.cm.planStore.save(activated)
  }
}
