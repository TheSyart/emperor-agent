/**
 * PlanExecutionManager (MIG-CTRL-007)。对齐 Python `agent/control/plan_execution.py`。
 * approved→executing 激活、todo↔step 同步、step 任务同步、工具输出 sidechain。
 * task_manager 为 null 时（W14 未迁移）所有任务绑定逻辑 no-op —— 与 Python 一致。
 */
import { nowTs } from '../util/time'
import {
  PlanDraftPhase,
  PlanStatus,
  PlanStepStatus,
  planFromDict,
  planToDict,
  stepToDict,
  type PlanRecord,
  type PlanStep,
} from '../plans/models'
import { PlanExecutionState } from '../plans/execution-state'
import type { Interaction } from './models'
import {
  isPositiveInt,
  planStatusFromTodo,
  stepVerificationStatus,
  taskStatusFromPlanStep,
} from './plan-helpers'
import type { ControlManagerHost } from './host'

const TASK_KIND_PLAN_STEP = 'plan_step' // agent/tasks TaskKind.PLAN_STEP
const TASK_STATUS_FAILED = 'failed'

export class PlanExecutionManager {
  private readonly cm: ControlManagerHost
  constructor(cm: ControlManagerHost) { this.cm = cm }

  /**
   * todo→plan step 完成投影（2026-07-05 B1）：update_todos 落地后由 runner 调用，
   * 把 todo 状态同步进当前可执行计划的步骤；全部 done/skipped 时计划置 COMPLETED。
   * 这是计划状态机唯一的常规完成路径。
   */
  syncPlanFromTodos(todos: Array<Record<string, unknown>>, opts?: { evidence?: Record<string, unknown> | null }): PlanRecord | null {
    const record = this.cm.latestExecutablePlan()
    if (record === null || !record.steps.length) return null
    const evidence = opts?.evidence ?? null
    const todoByStepId = new Map<string, Record<string, unknown>>()
    for (const item of todos) {
      if (item && typeof item === 'object' && String(item.plan_step_id ?? '').trim()) {
        todoByStepId.set(String(item.plan_step_id), item)
      }
    }
    const todoByIndex = new Map<number, Record<string, unknown>>()
    for (const item of todos) {
      if (item && typeof item === 'object' && isPositiveInt(item.id)) {
        todoByIndex.set(Number(item.id) - 1, item)
      }
    }
    const now = nowTs()
    const steps: PlanStep[] = []
    record.steps.forEach((step, index) => {
      const todo = todoByStepId.get(step.id) ?? todoByIndex.get(index)
      if (todo === undefined) {
        steps.push(step)
        return
      }
      const todoStatus = String(todo.status ?? 'pending')
      const nextStatus = planStatusFromTodo(todoStatus)
      const stepEvidence = [...step.evidence]
      if (nextStatus === PlanStepStatus.DONE && step.status !== PlanStepStatus.DONE) {
        stepEvidence.push({
          ...(evidence ?? {}),
          todo_id: todo.id,
          plan_step_id: todo.plan_step_id ?? step.id,
          todo_status: todoStatus,
          synced_at: now,
        })
      }
      if (nextStatus === PlanStepStatus.BLOCKED && step.status !== PlanStepStatus.BLOCKED) {
        stepEvidence.push({
          ...(evidence ?? {}),
          todo_id: todo.id,
          plan_step_id: todo.plan_step_id ?? step.id,
          todo_status: todoStatus,
          blocked_reason: String(todo.blocked_reason ?? '').trim(),
          synced_at: now,
        })
      }
      steps.push({ ...step, status: nextStatus, evidence: stepEvidence })
    })

    const allDone = steps.length > 0 && steps.every((s) => s.status === PlanStepStatus.DONE || s.status === PlanStepStatus.SKIPPED)
    const planStatus = allDone ? PlanStatus.COMPLETED : PlanStatus.EXECUTING
    let updated: PlanRecord = {
      ...record,
      status: planStatus,
      completedAt: planStatus === PlanStatus.COMPLETED ? now : record.completedAt,
      updatedAt: now,
      steps,
    }
    updated = this.syncPlanStepTasks(updated)
    this.cm.planStore.save(updated)
    return updated
  }

  /** 批准新计划时取代同 store 内滞留的 approved/executing 旧计划，防止僵尸累积（B1）。 */
  supersedeStaleExecutingPlans(newPlanId: string): void {
    const now = nowTs()
    for (const record of this.cm.planStore.list()) {
      if (record.id === newPlanId) continue
      if (record.status !== PlanStatus.APPROVED && record.status !== PlanStatus.EXECUTING) continue
      // 不碰 updatedAt：取代是记账而非活动，latest() 必须继续指向新计划
      this.cm.planStore.save({
        ...record,
        status: PlanStatus.CANCELLED,
        metadata: { ...record.metadata, superseded_by: newPlanId, superseded_at: now },
      })
    }
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
    if (record === null || step === null || taskId === null || this.cm.taskManager === null) return null
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

  private syncPlanStepTasks(record: PlanRecord): PlanRecord {
    if (this.cm.taskManager === null || !record.steps.length) return record
    const mapping = { ...((record.metadata.plan_step_tasks as Record<string, string>) ?? {}) }
    const scope = planStepTaskScope(record, this.cm.planScopeMetadata())
    record.steps.forEach((step, idx) => {
      const index = idx + 1
      const metadata = {
        plan_id: record.id,
        plan_step_id: step.id,
        sequence: index,
        verification_status: stepVerificationStatus(step),
        ...(scope ? { scope } : {}),
      }
      const taskId = String(mapping[step.id] ?? '')
      const status = taskStatusFromPlanStep(step.status)
      if (taskId && this.cm.taskManager!.store.get(taskId) !== null) {
        const task = this.cm.taskManager!.store.get(taskId)
        const progress = task !== null ? { ...task.progress } : {}
        progress.verification_status = metadata.verification_status
        this.cm.taskManager!.updateTask(taskId, { status, title: step.title, metadata, progress })
        return
      }
      const task = this.cm.taskManager!.startTask({
        kind: TASK_KIND_PLAN_STEP,
        title: step.title,
        source: 'plan_step',
        status,
        sessionId: record.sessionId ?? ((this.cm.planScopeMetadata()?.session_id as string | undefined) ?? null),
        metadata,
      })
      mapping[step.id] = task.id
    })
    const metadata = { ...record.metadata }
    metadata.plan_step_tasks = mapping
    return { ...record, metadata }
  }

  private activePlanStepTask(): [PlanRecord | null, PlanStep | null, string | null] {
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

  appendPlanStepVerification(record: PlanRecord, opts: { stepId: string; result: Record<string, unknown> }): void {
    if (this.cm.taskManager === null) return
    const mapping = record.metadata.plan_step_tasks
    if (!mapping || typeof mapping !== 'object') return
    const taskId = String((mapping as Record<string, string>)[opts.stepId] ?? '')
    if (!taskId) return
    const passed = opts.result.passed
    const verificationStatus = passed === true ? 'passed' : passed === false ? 'failed' : 'unknown'
    this.cm.taskManager.appendSidechain(taskId, {
      kind: 'verification',
      role: 'tool',
      plan_id: record.id,
      plan_step_id: opts.stepId,
      tool_name: String(opts.result.source ?? 'run_command'),
      command: String(opts.result.command ?? ''),
      content: String(opts.result.summary ?? opts.result.error ?? '').slice(0, 2000),
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

  updatePlanStatus(interaction: Interaction, status: string, opts?: { approved?: boolean }): void {
    const planId = String(interaction.meta.plan_id ?? '')
    if (!planId) return
    const record = this.cm.planStore.get(planId)
    if (record === null) return
    const now = nowTs()
    let draft = record.draft
    if (opts?.approved) draft = { ...draft, phase: PlanDraftPhase.APPROVED }
    const scope = this.cm.planScopeMetadata()
    const metadata = { ...record.metadata, ...(scope && !record.metadata.scope ? { scope } : {}) }
    const payload: Record<string, unknown> = {
      ...planToDict(record),
      status,
      updated_at: now,
      draft: { ...planToDict({ ...record, draft }).draft as Record<string, unknown> },
      metadata,
    }
    if (opts?.approved) payload.approved_at = now
    this.cm.planStore.save(planFromDict(payload))
  }

  activateApprovedPlan(interaction: Interaction): PlanRecord | null {
    const planId = String(interaction.meta.plan_id ?? '')
    if (!planId) return null
    const record = this.cm.planStore.get(planId)
    if (record === null) return null
    if (this.cm.todoStore === null || !record.steps.length) return record
    let activated = new PlanExecutionState(record).startNextStep()
    activated = { ...activated, draft: { ...activated.draft, phase: PlanDraftPhase.EXECUTING } }
    activated = this.cm.permissionTokens.issue(activated)
    activated = this.syncPlanStepTasks(activated)
    this.cm.planStore.save(activated)
    this.cm.todoStore.syncFromPlanSteps(activated.steps.map(stepToDict))
    return activated
  }
}

function planStepTaskScope(record: PlanRecord, current: Record<string, unknown> | null): Record<string, unknown> | null {
  const saved = record.metadata.scope
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) return { ...(saved as Record<string, unknown>) }
  return current ? { ...current } : null
}
