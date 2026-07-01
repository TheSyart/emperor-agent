/**
 * ControlManager (MIG-CTRL-002/011)。对齐 Python `agent/control/manager.py`。
 * 薄门面，委托 8 个子管理器；Ask/Plan 交互流 + 模式管理 + resume 消息逐字保真。
 */
import { nowTs } from '../util/time'
import { PermissionManager } from '../permissions/manager'
import type { PlanPermissionToken } from '../permissions/models'
import { PlanStatus, planToDict, type PlanRecord } from '../plans/models'
import { PlanStore } from '../plans/store'
import type { ToolRegistry } from '../tools/registry'
import type { ToolDefinition } from '../tools/base'
import { ClarificationPolicy, type ClarificationAssessment } from './clarification'
import {
  ControlMode,
  InteractionKind,
  InteractionStatus,
  controlStateToDict,
  interactionToDict,
  makeAsk,
  questionFromDict,
  touchInteraction,
  type ControlState,
  type Interaction,
} from './models'
import { PlanDraftingManager } from './plan-drafting'
import { PlanExecutionManager } from './plan-execution'
import { planStepsFinished } from './plan-helpers'
import { PlanPermissionTokenManager } from './plan-permissions'
import { PlanDecision, PlanDecisionPolicy } from './plan-policy'
import { PlanVerificationManager } from './plan-verification'
import { ControlPolicy } from './policy'
import { ControlStore } from './store'
import type { ControlManagerHost, TaskManagerLike, TodoStoreLike } from './host'
import type { ToolManagerHost } from './tools'

export interface ControlResume {
  interaction: Record<string, unknown>
  message: string
  event: Record<string, unknown>
  resume: boolean
}

export interface ControlPendingObserver {
  setPending(interaction: Interaction): void
  clearPending(interaction: Interaction): void
}

export class ControlManager implements ControlManagerHost, ToolManagerHost {
  readonly store: ControlStore
  readonly planStore: PlanStore
  readonly policy: ControlPolicy
  readonly clarificationPolicy: ClarificationPolicy
  readonly planDecisionPolicy: PlanDecisionPolicy
  readonly permissionManager: PermissionManager
  readonly permissionTokens: PlanPermissionTokenManager
  readonly verification: PlanVerificationManager
  readonly drafting: PlanDraftingManager
  readonly execution: PlanExecutionManager
  todoStore: TodoStoreLike | null = null
  taskManager: TaskManagerLike | null = null
  private pendingObserver: ControlPendingObserver | null = null

  constructor(root: string) {
    this.store = new ControlStore(root)
    this.planStore = new PlanStore(root)
    this.policy = new ControlPolicy(this)
    this.clarificationPolicy = new ClarificationPolicy()
    this.planDecisionPolicy = new PlanDecisionPolicy()
    this.permissionManager = new PermissionManager(this as unknown as ConstructorParameters<typeof PermissionManager>[0])
    this.permissionTokens = new PlanPermissionTokenManager(this)
    this.verification = new PlanVerificationManager(this)
    this.drafting = new PlanDraftingManager(this)
    this.execution = new PlanExecutionManager(this)
  }

  setTodoStore(todoStore: TodoStoreLike | null): void {
    this.todoStore = todoStore
  }

  setTaskManager(taskManager: TaskManagerLike | null): void {
    this.taskManager = taskManager
  }

  setPendingObserver(observer: ControlPendingObserver | null): void {
    this.pendingObserver = observer
  }

  get mode(): string {
    return this.store.load().mode
  }

  payload(): Record<string, unknown> {
    return controlStateToDict(this.store.load())
  }

  setMode(mode: string): Record<string, unknown> {
    let value = String(mode ?? '').trim().toLowerCase()
    if (value === 'on' || value === 'plan') value = ControlMode.PLAN
    else if (value === 'off' || value === 'normal' || value === 'ask' || value === 'ask_before_edit' || value === 'edit_before_ask') value = ControlMode.ASK_BEFORE_EDIT
    else if (value === 'auto' || value === 'automatic') value = ControlMode.AUTO
    if (value !== ControlMode.ASK_BEFORE_EDIT && value !== ControlMode.AUTO && value !== ControlMode.PLAN) {
      throw new Error('mode must be ask_before_edit, auto or plan')
    }
    const state = this.store.load()
    const oldMode = state.mode
    if (value === ControlMode.PLAN && state.mode !== ControlMode.PLAN) {
      state.previousMode = state.mode
    } else if (value !== ControlMode.PLAN) {
      state.previousMode = null
    }
    state.mode = value
    state.updatedAt = nowTs()
    this.store.save(state)
    if (value !== oldMode) {
      this.revokePlanPermissionTokens({ reason: 'control mode changed' })
    }
    return this.payload()
  }

  ensureNoPending(): void {
    const pending = this.store.load().pending
    if (pending && pending.status === InteractionStatus.WAITING) {
      throw new Error(`pending interaction already exists: ${pending.id}`)
    }
  }

  createAsk(opts: {
    questions: Array<Record<string, unknown>>
    context?: string
    parentCallId?: string | null
    meta?: Record<string, unknown> | null
  }): Interaction {
    this.ensureNoPending()
    const parsed = opts.questions.map((item) => questionFromDict(item))
    const interactionMeta = { ...(opts.meta ?? {}) }
    if (this.mode === ControlMode.PLAN) {
      const draft = this.drafting.ensurePlanDraft()
      interactionMeta.plan_id = draft.id
    }
    const interaction = makeAsk({
      questions: parsed,
      context: opts.context ?? '',
      parentCallId: opts.parentCallId ?? null,
      meta: interactionMeta,
    })
    if (interactionMeta.plan_id) {
      this.drafting.recordPlanOpenQuestions(interaction)
    }
    this.setPending(interaction)
    return interaction
  }

  createPlan(opts: {
    title: string
    summary: string
    planMarkdown: string
    assumptions?: string[] | null
    riskLevel?: string
    steps?: Array<Record<string, unknown>> | null
    parentCallId?: string | null
    meta?: Record<string, unknown> | null
    enforceQuality?: boolean
  }): Interaction {
    return this.drafting.createPlan(opts)
  }

  createPlanFromText(text: string): Interaction {
    return this.drafting.createPlanFromText(text)
  }

  assessClarification(history: Array<Record<string, unknown>>): ClarificationAssessment {
    return this.clarificationPolicy.assess(history)
  }

  assessPlanDecision(userMessage: string): PlanDecision {
    return this.drafting.assessPlanDecision(userMessage)
  }

  shouldEnforcePlanFinal(): boolean {
    return this.mode === ControlMode.PLAN
  }

  setPending(interaction: Interaction): void {
    const state = this.store.load()
    state.pending = interaction
    state.lastInteraction = interaction
    state.updatedAt = nowTs()
    this.store.save(state)
    this.notifyPendingSet(interaction)
  }

  answer(interactionId: string, answers: Record<string, unknown>): ControlResume {
    const interaction = this.requirePending(interactionId, InteractionKind.ASK)
    const normalized = this.normalizeAnswers(interaction, answers)
    const updated = touchInteraction(interaction, { status: InteractionStatus.ANSWERED })
    updated.answers = normalized
    this.permissionManager.recordAnswer(updated as unknown as { meta?: Record<string, unknown>; answers?: Record<string, unknown> })
    this.drafting.recordPlanResolvedQuestions(updated)
    this.complete(updated)
    const message = this.answerMessage(updated)
    return {
      interaction: interactionToDict(updated),
      message,
      event: { event: 'ask_answered', interaction: interactionToDict(updated) },
      resume: true,
    }
  }

  comment(interactionId: string, comment: string): ControlResume {
    const interaction = this.requirePending(interactionId, InteractionKind.PLAN)
    const text = String(comment ?? '').trim()
    if (!text) throw new Error('comment is required')
    const updated = touchInteraction(interaction, { status: InteractionStatus.COMMENTED })
    updated.comments = [...updated.comments, { content: text.slice(0, 4000), timestamp: nowTs() }]
    this.drafting.recordPlanComment(updated, text)
    this.complete(updated)
    const message = this.commentMessage(updated, text)
    return {
      interaction: interactionToDict(updated),
      message,
      event: { event: 'plan_comment_added', interaction: interactionToDict(updated), comment: text },
      resume: true,
    }
  }

  approve(interactionId: string): ControlResume {
    const interaction = this.requirePending(interactionId, InteractionKind.PLAN)
    const updated = touchInteraction(interaction, { status: InteractionStatus.APPROVED })
    this.execution.updatePlanStatus(updated, PlanStatus.APPROVED, { approved: true })
    const planRecord = this.execution.activateApprovedPlan(updated)
    const state = this.store.load()
    state.mode = ControlManager.restoreMode(state)
    state.previousMode = null
    state.pending = null
    state.lastInteraction = updated
    state.updatedAt = nowTs()
    this.store.save(state)
    this.notifyPendingCleared(updated)
    const message = this.approvalMessage(updated, planRecord)
    const event: Record<string, unknown> = {
      event: 'plan_approved',
      interaction: interactionToDict(updated),
      control: this.payload(),
    }
    if (planRecord !== null) event.plan = planToDict(planRecord)
    if (this.todoStore !== null) event.todos = [...this.todoStore.todos]
    return { interaction: interactionToDict(updated), message, event, resume: true }
  }

  cancel(interactionId: string): Record<string, unknown> {
    const pending = this.requirePending(interactionId)
    const updated = touchInteraction(pending, { status: InteractionStatus.CANCELLED })
    if (pending.kind === InteractionKind.PLAN) {
      this.execution.updatePlanStatus(updated, PlanStatus.CANCELLED)
      const state = this.store.load()
      state.mode = ControlManager.restoreMode(state)
      state.previousMode = null
      state.pending = null
      state.lastInteraction = updated
      state.updatedAt = nowTs()
      this.store.save(state)
      this.notifyPendingCleared(updated)
    } else {
      this.complete(updated)
    }
    return {
      event: 'interaction_cancelled',
      interaction: interactionToDict(updated),
      control: this.payload(),
      message: this.cancelMessage(updated),
    }
  }

  private complete(interaction: Interaction): void {
    const state = this.store.load()
    state.pending = null
    state.lastInteraction = interaction
    state.updatedAt = nowTs()
    this.store.save(state)
    this.notifyPendingCleared(interaction)
  }

  private notifyPendingSet(interaction: Interaction): void {
    this.pendingObserver?.setPending(interaction)
  }

  private notifyPendingCleared(interaction: Interaction): void {
    this.pendingObserver?.clearPending(interaction)
  }

  private requirePending(interactionId: string, kind?: InteractionKind): Interaction {
    const pending = this.store.load().pending
    if (pending === null) throw new Error('no pending interaction')
    if (pending.id !== String(interactionId)) throw new Error(`pending interaction mismatch: ${pending.id}`)
    if (kind !== undefined && pending.kind !== kind) throw new Error(`pending interaction is not ${kind}`)
    if (pending.status !== InteractionStatus.WAITING) throw new Error(`interaction is not waiting: ${pending.status}`)
    return pending
  }

  private normalizeAnswers(interaction: Interaction, answers: Record<string, unknown>): Record<string, unknown> {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('answers must be an object')
    const questionIds = new Set(interaction.questions.map((q) => q.id))
    const normalized: Record<string, unknown> = {}
    for (const [qid, value] of Object.entries(answers)) {
      if (!questionIds.has(qid) && qid !== '_freeform') continue
      if (value && typeof value === 'object') {
        normalized[qid] = {
          choice: String((value as Record<string, unknown>).choice ?? '').trim(),
          freeform: String((value as Record<string, unknown>).freeform ?? '').trim(),
        }
      } else {
        normalized[qid] = { choice: String(value ?? '').trim(), freeform: '' }
      }
    }
    if (!Object.keys(normalized).length) throw new Error('at least one answer is required')
    return normalized
  }

  private answerMessage(interaction: Interaction): string {
    const lines = [
      '[CONTROL:ASK_ANSWERED]',
      `interaction_id: ${interaction.id}`,
      '用户已回答澄清问题，请结合答案继续推进。',
      '',
    ]
    for (const question of interaction.questions) {
      const answer = (interaction.answers[question.id] as Record<string, unknown>) ?? {}
      const choice = answer && typeof answer === 'object' ? answer.choice : String(answer)
      const freeform = answer && typeof answer === 'object' ? answer.freeform : ''
      lines.push(`- ${question.header}: ${question.question}`)
      if (choice) lines.push(`  answer: ${choice}`)
      if (freeform) lines.push(`  note: ${freeform}`)
    }
    const extra = interaction.answers._freeform
    if (extra && typeof extra === 'object' && (extra as Record<string, unknown>).freeform) {
      lines.push(`- additional note: ${(extra as Record<string, unknown>).freeform}`)
    }
    return lines.join('\n').trim()
  }

  private commentMessage(interaction: Interaction, comment: string): string {
    return (
      '[CONTROL:PLAN_COMMENT]\n' +
      `interaction_id: ${interaction.id}\n` +
      '用户对计划提出了评论，请保持 Plan 模式，只修订计划并再次调用 propose_plan。\n\n' +
      `评论：\n${comment.trim()}`
    )
  }

  private approvalMessage(interaction: Interaction, planRecord: PlanRecord | null = null): string {
    const lines = ['[CONTROL:PLAN_APPROVED]', `interaction_id: ${interaction.id}`]
    if (planRecord !== null) {
      lines.push(`plan_id: ${planRecord.id}`)
      lines.push(`plan_status: ${planRecord.status}`)
    }
    lines.push(
      '用户已批准以下计划。现在切换到执行模式，请按计划实施；执行中如出现新的高影响歧义，可再次 ask_user。',
      '',
      `# ${interaction.title}`,
      '',
      interaction.planMarkdown,
      '',
      '[PLAN_EXECUTION_CONTRACT]',
      '- Convert the approved plan into todos before editing, and keep the active todo aligned with the active PlanStep.',
      '- Keep exactly one active todo / active PlanStep while executing; move to the next step only after the current step has evidence.',
      '- Before marking a step done, record verification evidence by running declared commands or producing an explicit tool-backed check result.',
      '- If verification failed, keep or mark the step failed, diagnose and repair the failure, rerun verification, then continue.',
      '- If the step is blocked by missing input, access, cost, safety, or unrecoverable ambiguity, call ask_user and keep the step blocked until resolved.',
      '- Do not provide a final answer while any step is pending, active, failed, or blocked.',
    )
    if (planRecord !== null && planRecord.steps.length) {
      lines.push('', '[PLAN_STEPS]')
      for (const step of planRecord.steps) {
        lines.push(`- ${step.id} [${step.status}] ${step.title}`)
        if (step.files.length) lines.push(`  files: ${step.files.slice(0, 5).join('; ')}`)
        if (step.commands.length) lines.push(`  commands: ${step.commands.slice(0, 5).join('; ')}`)
        if (step.acceptance.length) lines.push(`  acceptance: ${step.acceptance.slice(0, 5).join('; ')}`)
      }
    }
    return lines.join('\n').trim()
  }

  private cancelMessage(interaction: Interaction): string {
    return (
      '[CONTROL:INTERACTION_CANCELLED]\n' +
      `interaction_id: ${interaction.id}\n` +
      `kind: ${interaction.kind}\n` +
      '用户取消了这次等待交互。不要继续等待该问题或计划；后续请以用户的新指令为准。'
    )
  }

  systemPrompt(): string {
    if (this.mode === ControlMode.PLAN) {
      return (
        '# Control Mode: Plan\n\n' +
        '- 当前处于 Plan 模式。你必须先通过只读探索理解环境，不允许修改文件、运行命令执行变更、派遣子代理或创建队友。\n' +
        '- 若需求存在会影响方案的偏好或取舍，调用 `ask_user` 提问。\n' +
        '- 当方案足够明确时，必须调用 `propose_plan` 提交完整计划，等待用户评论或批准。\n' +
        '- 用户批准前不要执行计划。\n' +
        '- 不允许用普通最终回复替代计划卡；最终必须通过 `propose_plan` 进入 PlanCard。'
      )
    }
    return (
      '# Control Tools\n\n' +
      `- 当前权限模式：${this.mode}。\n` +
      '- `ask_before_edit` 模式下，危险、不确定或高影响操作会触发权限审批；低风险读操作和普通编辑可继续执行。\n' +
      '- `auto` 模式下，工具层不主动审批，但仍受路径安全、schema 校验和工具自身安全策略约束。\n' +
      '- 当用户目标存在高影响歧义且无法通过读文件/搜索等方式确定时，调用 `ask_user` 提出结构化问题。\n' +
      '- 高影响歧义包括范围/验收不清的大改动、架构/重构/UI 取舍、提交推送、删除覆盖、发布部署、成本/权限/安全边界。\n' +
      '- 可通过只读探索确认的事实先探索；但在写入、高影响操作或最终答复前仍有关键取舍时，必须提问。\n' +
      '- 只有在用户显式开启 Plan 模式后，才使用 `propose_plan` 提交等待批准的计划。'
    )
  }

  toolDefinitions(registry: ToolRegistry): ToolDefinition[] {
    return this.policy.filteredDefinitions(registry)
  }

  isToolAllowed(name: string, registry: ToolRegistry): boolean {
    return this.policy.isToolAllowed(name, registry)
  }

  assessPermission(name: string, args: Record<string, unknown>, registry: ToolRegistry | null) {
    return this.permissionManager.assess(name, args, { registry })
  }

  permissionApprovalResult(decision: Parameters<PermissionManager['requireApproval']>[0], opts?: { parentCallId?: string | null }): string {
    return this.permissionManager.requireApproval(decision, { parentCallId: opts?.parentCallId ?? null })
  }

  syncPlanFromTodos(todos: Array<Record<string, unknown>>, opts?: { evidence?: Record<string, unknown> | null }): PlanRecord | null {
    return this.execution.syncPlanFromTodos(todos, opts)
  }

  hasAskInteraction(): boolean {
    const state = this.store.load()
    return [state.pending, state.lastInteraction].some((item) => item !== null && item.kind === InteractionKind.ASK)
  }

  planVerificationTarget(command: string): Record<string, string> | null {
    return this.verification.planVerificationTarget(command)
  }

  recordPlanDiscovery(opts: { source: string; summary: string; files?: string[] | null; symbols?: string[] | null; evidenceRefs?: string[] | null }): PlanRecord | null {
    return this.drafting.recordPlanDiscovery(opts)
  }

  recordPlanStepToolOutput(opts: Parameters<PlanExecutionManager['recordPlanStepToolOutput']>[0]): unknown {
    return this.execution.recordPlanStepToolOutput(opts)
  }

  recordPlanVerificationResult(opts: { planId: string; stepId: string; result: Record<string, unknown> }): PlanRecord | null {
    return this.verification.recordPlanVerificationResult(opts)
  }

  appendPlanStepVerification(record: PlanRecord, opts: { stepId: string; result: Record<string, unknown> }): void {
    this.execution.appendPlanStepVerification(record, opts)
  }

  issuePlanPermissionTokens(record: PlanRecord): PlanRecord {
    return this.permissionTokens.issue(record)
  }

  consumePlanPermissionToken(opts: { toolName: string; arguments: Record<string, unknown> }): PlanPermissionToken | null {
    return this.permissionTokens.consume(opts)
  }

  revokePlanPermissionTokens(opts?: { planId?: string | null; reason?: string }): PlanRecord | null {
    return this.permissionTokens.revoke(opts)
  }

  planCompletionFollowup(): Record<string, unknown> | null {
    return this.verification.planCompletionFollowup()
  }

  recordIndependentVerificationResult(opts: { planId: string; result: Record<string, unknown> }): PlanRecord | null {
    return this.verification.recordIndependentVerificationResult(opts)
  }

  waiveIndependentVerification(opts: { planId: string; reason: string }): PlanRecord | null {
    return this.verification.waiveIndependentVerification(opts)
  }

  planIndependentVerificationFollowup(opts?: { dispatchAvailable?: boolean }): Record<string, unknown> | null {
    return this.verification.planIndependentVerificationFollowup(opts)
  }

  latestExecutablePlan(): PlanRecord | null {
    const plans = this.planStore.list().filter((p) => p.status === PlanStatus.APPROVED || p.status === PlanStatus.EXECUTING)
    if (!plans.length) return null
    return plans.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
  }

  reviewablePlanId(): string | null {
    const record = this.latestReviewablePlan()
    if (record === null || !record.steps.length || !planStepsFinished(record)) return null
    return record.id
  }

  latestReviewablePlan(): PlanRecord | null {
    const plans = this.planStore
      .list()
      .filter((p) => p.status === PlanStatus.APPROVED || p.status === PlanStatus.EXECUTING || p.status === PlanStatus.COMPLETED)
    if (!plans.length) return null
    return plans.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
  }

  static restoreMode(state: ControlState): string {
    if (state.previousMode === ControlMode.ASK_BEFORE_EDIT || state.previousMode === ControlMode.AUTO) {
      return state.previousMode
    }
    return ControlMode.ASK_BEFORE_EDIT
  }

  static interactionEvent(interaction: Interaction): Record<string, unknown> {
    const event = interaction.kind === InteractionKind.ASK ? 'ask_request' : 'plan_draft'
    return { event, interaction: interactionToDict(interaction) }
  }

  static interactionFromMarker(marker: string): Record<string, unknown> | null {
    let raw: unknown
    try {
      raw = JSON.parse(marker)
    } catch {
      return null
    }
    const interaction = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).interaction : null
    return interaction && typeof interaction === 'object' ? (interaction as Record<string, unknown>) : null
  }
}
