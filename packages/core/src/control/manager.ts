/**
 * ControlManager (MIG-CTRL-002/011)。对齐 Python `agent/control/manager.py`。
 * 薄门面，委托 8 个子管理器；Ask/Plan 交互流 + 模式管理 + resume 消息逐字保真。
 */
import { nowTs } from '../util/time'
import { PermissionManager } from '../permissions/manager'
import type { PlanPermissionToken } from '../permissions/models'
import type { PermissionRuleInput } from '../permissions/rules'
import {
  PlanStatus,
  PlanStepStatus,
  planToDict,
  type PlanRecord,
} from '../plans/models'
import { PlanStore } from '../plans/store'
import type { ToolRegistry } from '../tools/registry'
import type { ToolDefinition } from '../tools/base'
import type { GoalRecord } from '../goals/models'
import { goalScopesEqual } from '../goals/scope'
import { GoalGateMutationLedger } from '../goals/mutation-ledger'
import { canonicalJson } from '../goals/events'
import {
  ClarificationPolicy,
  type ClarificationAssessment,
} from './clarification'
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
  type ControlStatePayload,
  type Interaction,
  type InteractionPayload,
} from './models'
import { PlanDraftingManager } from './plan-drafting'
import { PlanExecutionManager } from './plan-execution'
import {
  isPlanInvalidated,
  latestApprovedPlanGeneration,
  planStepsFinished,
  stepVerificationStatus,
} from './plan-helpers'
import { PlanPermissionTokenManager } from './plan-permissions'
import { PlanDecision, PlanDecisionPolicy } from './plan-policy'
import { PlanVerificationManager } from './plan-verification'
import { ControlPolicy } from './policy'
import { ControlStore } from './store'
import { GoalBlockerControlManager } from './goal-blocker'
import { GoalManualEvidenceControlManager } from './goal-manual-evidence'
import type {
  ControlManagerHost,
  ControlRuntimeScope,
  TaskManagerLike,
  TodoStoreLike,
} from './host'
import {
  PLAN_MODE_REQUEST_APPROVE_LABEL,
  PLAN_MODE_REQUEST_QUESTION_ID,
  type ToolManagerHost,
} from './tools'

export interface ControlResume {
  interaction: InteractionPayload
  message: string
  event: Record<string, unknown>
  resume: boolean
}

export interface ControlPendingObserver {
  setPending(interaction: Interaction): void
  clearPending(interaction: Interaction): void
}

export type AskMetaProvider = () => Record<string, unknown> | null

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
  readonly goalBlocker: GoalBlockerControlManager
  readonly goalManualEvidence: GoalManualEvidenceControlManager
  todoStore: TodoStoreLike | null = null
  taskManager: TaskManagerLike | null = null
  private pendingObserver: ControlPendingObserver | null = null
  private askMetaProvider: AskMetaProvider | null = null
  private runtimeScope: Required<ControlRuntimeScope> | null = null
  private goalPlanContext: GoalRecord | null = null
  private readonly goalMutations: GoalGateMutationLedger

  constructor(
    root: string,
    opts: { permissionRules?: PermissionRuleInput[] | null } = {},
  ) {
    this.store = new ControlStore(root)
    this.goalMutations = new GoalGateMutationLedger(root)
    this.planStore = new PlanStore(root)
    this.policy = new ControlPolicy(this)
    this.clarificationPolicy = new ClarificationPolicy()
    this.planDecisionPolicy = new PlanDecisionPolicy()
    this.permissionManager = new PermissionManager(
      this as unknown as ConstructorParameters<typeof PermissionManager>[0],
      { rules: opts.permissionRules ?? [] },
    )
    this.permissionTokens = new PlanPermissionTokenManager(this)
    this.verification = new PlanVerificationManager(this)
    this.drafting = new PlanDraftingManager(this)
    this.execution = new PlanExecutionManager(this)
    this.goalBlocker = new GoalBlockerControlManager(this)
    this.goalManualEvidence = new GoalManualEvidenceControlManager(this)
  }

  setTodoStore(todoStore: TodoStoreLike | null): void {
    this.todoStore = todoStore
  }

  setTaskManager(taskManager: TaskManagerLike | null): void {
    this.taskManager = taskManager
  }

  setRuntimeScope(scope: ControlRuntimeScope | null): void {
    const next = normalizeRuntimeScope(scope)
    if (canonicalJson(next) === canonicalJson(this.runtimeScope)) return
    this.goalMutations.withSynchronousMutation(
      'scope',
      `runtime-scope:${canonicalJson(next)}`,
      () => {
        this.runtimeScope = next
      },
    )
  }

  runtimeScopeSnapshot(): Required<ControlRuntimeScope> | null {
    return this.runtimeScope ? Object.freeze({ ...this.runtimeScope }) : null
  }

  setActiveGoalPlanContext(goal: GoalRecord | null): void {
    this.goalPlanContext = goal
  }

  activeGoalPlanContext(): GoalRecord | null {
    const goal = this.goalPlanContext
    if (goal === null) return null
    if (goal.status !== 'active' || goal.runtime.phase !== 'planning')
      throw new Error('active Goal must be in planning phase to propose a Plan')
    const current = this.runtimeScope
    if (current === null || !goalScopesEqual(current, goal.scope))
      throw new Error('active Goal scope does not match the current Plan scope')
    return goal
  }

  setPendingObserver(observer: ControlPendingObserver | null): void {
    this.pendingObserver = observer
  }

  setAskMetaProvider(provider: AskMetaProvider | null): void {
    this.askMetaProvider = provider
  }

  get mode(): string {
    return this.store.load().mode
  }

  payload(): ControlStatePayload {
    return controlStateToDict(this.store.load())
  }

  setMode(mode: string): ControlStatePayload {
    let value = String(mode ?? '')
      .trim()
      .toLowerCase()
    if (value === 'on' || value === 'plan') value = ControlMode.PLAN
    else if (
      value === 'off' ||
      value === 'normal' ||
      value === 'ask' ||
      value === 'ask_before_edit' ||
      value === 'edit_before_ask'
    )
      value = ControlMode.ASK_BEFORE_EDIT
    else if (
      value === 'accept_edits' ||
      value === 'accept-edits' ||
      value === 'accept edits' ||
      value === 'edits'
    )
      value = ControlMode.ACCEPT_EDITS
    else if (value === 'auto' || value === 'automatic') value = ControlMode.AUTO
    if (
      value !== ControlMode.ASK_BEFORE_EDIT &&
      value !== ControlMode.ACCEPT_EDITS &&
      value !== ControlMode.AUTO &&
      value !== ControlMode.PLAN
    ) {
      throw new Error(
        'mode must be ask_before_edit, accept_edits, auto or plan',
      )
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

  setPermissionMode(mode: string): ControlStatePayload {
    const value = String(mode ?? '')
      .trim()
      .toLowerCase()
    if (
      value !== ControlMode.ASK_BEFORE_EDIT &&
      value !== ControlMode.ACCEPT_EDITS &&
      value !== ControlMode.AUTO
    ) {
      throw new Error(
        'permission mode must be ask_before_edit, accept_edits or auto',
      )
    }

    const state = this.store.load()
    const previousPermission =
      state.mode === ControlMode.PLAN
        ? ControlManager.restoreMode(state)
        : state.mode
    if (state.mode === ControlMode.PLAN) state.previousMode = value
    else {
      state.mode = value
      state.previousMode = null
    }
    state.updatedAt = nowTs()
    this.store.save(state)
    if (value !== previousPermission) {
      this.revokePlanPermissionTokens({ reason: 'control permission changed' })
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
    const interactionMeta = {
      ...(this.askMetaProvider?.() ?? {}),
      ...(opts.meta ?? {}),
    }
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

  assessClarification(
    history: Array<Record<string, unknown>>,
  ): ClarificationAssessment {
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

  updatePendingMeta(
    interactionId: string,
    meta: Record<string, unknown>,
  ): Interaction {
    const pending = this.requirePending(interactionId)
    const updated = touchInteraction(pending)
    updated.meta = { ...updated.meta, ...meta }
    this.setPending(updated)
    return updated
  }

  answer(
    interactionId: string,
    answers: Record<string, unknown>,
  ): ControlResume {
    const interaction = this.requirePending(interactionId, InteractionKind.ASK)
    const normalized = this.normalizeAnswers(interaction, answers)
    const updated = touchInteraction(interaction, {
      status: InteractionStatus.ANSWERED,
    })
    updated.answers = normalized
    this.permissionManager.recordAnswer(
      updated as unknown as {
        meta?: Record<string, unknown>
        answers?: Record<string, unknown>
      },
    )
    this.drafting.recordPlanResolvedQuestions(updated)
    this.cancelExecutablePlanIfRequested(updated)
    this.complete(updated)
    this.maybeEnterPlanModeFromAnswer(updated)
    const message = this.answerMessage(updated)
    return {
      interaction: interactionToDict(updated),
      message,
      event: {
        event: 'ask_answered',
        interaction: interactionToDict(updated),
        resume_model: true,
      },
      resume: true,
    }
  }

  /** request_plan_mode 的一键批准：用户选择同意时由后端直接切入计划模式。 */
  private maybeEnterPlanModeFromAnswer(interaction: Interaction): void {
    if (!interaction.meta?.plan_mode_request) return
    const answer = (interaction.answers ?? {})[
      PLAN_MODE_REQUEST_QUESTION_ID
    ] as Record<string, unknown> | undefined
    const choice = String(answer?.choice ?? '').trim()
    if (choice !== PLAN_MODE_REQUEST_APPROVE_LABEL) return
    if (this.mode === ControlMode.PLAN) return
    this.setMode(ControlMode.PLAN)
  }

  comment(interactionId: string, comment: string): ControlResume {
    const interaction = this.requirePending(interactionId, InteractionKind.PLAN)
    const text = String(comment ?? '').trim()
    if (!text) throw new Error('comment is required')
    const updated = touchInteraction(interaction, {
      status: InteractionStatus.COMMENTED,
    })
    updated.comments = [
      ...updated.comments,
      { content: text.slice(0, 4000), timestamp: nowTs() },
    ]
    this.drafting.recordPlanComment(updated, text)
    this.complete(updated)
    const message = this.commentMessage(updated, text)
    return {
      interaction: interactionToDict(updated),
      message,
      event: {
        event: 'plan_comment_added',
        interaction: interactionToDict(updated),
        comment: text,
      },
      resume: true,
    }
  }

  approve(interactionId: string): ControlResume {
    const interaction = this.requirePending(interactionId, InteractionKind.PLAN)
    const pendingPlanId = String(interaction.meta.plan_id ?? '').trim()
    const pendingPlan = pendingPlanId ? this.planStore.get(pendingPlanId) : null
    const interactionGeneration = Number(
      interaction.meta.approval_generation ?? 0,
    )
    const persistedGeneration = Number(
      pendingPlan?.metadata.approval_generation ?? 0,
    )
    if (
      pendingPlan === null ||
      pendingPlan.status !== PlanStatus.WAITING_APPROVAL ||
      pendingPlan.sourceInteractionId !== interaction.id ||
      !Number.isInteger(interactionGeneration) ||
      interactionGeneration < 1 ||
      interactionGeneration !== persistedGeneration
    )
      throw new Error('pending Plan approval generation is stale')
    const updated = touchInteraction(interaction, {
      status: InteractionStatus.APPROVED,
    })
    this.execution.updatePlanStatus(updated, PlanStatus.APPROVED, {
      approved: true,
    })
    // 先取代旧的 approved/executing 计划再激活新计划，保证 latest() 指向新计划（B1）
    const approvedPlanId = String(updated.meta.plan_id ?? '')
    if (approvedPlanId)
      this.execution.supersedeStaleExecutingPlans(approvedPlanId)
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
    return {
      interaction: interactionToDict(updated),
      message,
      event,
      resume: true,
    }
  }

  cancel(interactionId: string): Record<string, unknown> {
    const pending = this.requirePending(interactionId)
    const updated = touchInteraction(pending, {
      status: InteractionStatus.CANCELLED,
    })
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

  private cancelExecutablePlanIfRequested(
    interaction: Interaction,
  ): PlanRecord | null {
    const record = this.latestExecutablePlan()
    if (record === null) return null
    if (!askAnswerCancelsPlan(interaction)) return null
    const now = nowTs()
    const evidence = {
      source: 'ask_answer',
      interaction_id: interaction.id,
      reason: 'user chose to abandon or ignore the active plan',
      cancelled_at: now,
    }
    const steps = record.steps.map((step) => {
      if (
        step.status === PlanStepStatus.DONE ||
        step.status === PlanStepStatus.SKIPPED
      )
        return step
      return {
        ...step,
        status: PlanStepStatus.SKIPPED,
        evidence: [...step.evidence, evidence],
      }
    })
    const metadata = {
      ...record.metadata,
      cancelled_by: 'ask_answer',
      cancelled_interaction_id: interaction.id,
      cancel_reason: 'user chose to abandon or ignore the active plan',
    }
    const updated: PlanRecord = {
      ...record,
      status: PlanStatus.CANCELLED,
      updatedAt: now,
      steps,
      metadata,
    }
    return this.planStore.save(updated)
  }

  private notifyPendingSet(interaction: Interaction): void {
    this.pendingObserver?.setPending(interaction)
  }

  planScopeMetadata(): Record<string, unknown> | null {
    if (this.runtimeScope === null) return null
    const scope: Record<string, unknown> = {}
    if (this.runtimeScope.sessionId)
      scope.session_id = this.runtimeScope.sessionId
    if (this.runtimeScope.mode) scope.mode = this.runtimeScope.mode
    if (this.runtimeScope.projectId)
      scope.project_id = this.runtimeScope.projectId
    if (this.runtimeScope.workspaceRoot)
      scope.workspace_root = this.runtimeScope.workspaceRoot
    if (this.runtimeScope.projectFingerprint)
      scope.project_fingerprint = this.runtimeScope.projectFingerprint
    return Object.keys(scope).length ? scope : null
  }

  planMatchesCurrentScope(record: PlanRecord): boolean {
    return planMatchesScope(record, this.runtimeScope)
  }

  private notifyPendingCleared(interaction: Interaction): void {
    this.pendingObserver?.clearPending(interaction)
  }

  private requirePending(
    interactionId: string,
    kind?: InteractionKind,
  ): Interaction {
    const pending = this.store.load().pending
    if (pending === null) throw new Error('no pending interaction')
    if (pending.id !== String(interactionId))
      throw new Error(`pending interaction mismatch: ${pending.id}`)
    if (kind !== undefined && pending.kind !== kind)
      throw new Error(`pending interaction is not ${kind}`)
    if (pending.status !== InteractionStatus.WAITING)
      throw new Error(`interaction is not waiting: ${pending.status}`)
    return pending
  }

  private normalizeAnswers(
    interaction: Interaction,
    answers: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers))
      throw new Error('answers must be an object')
    const questionIds = new Set(interaction.questions.map((q) => q.id))
    const normalized: Record<string, unknown> = {}
    for (const [qid, value] of Object.entries(answers)) {
      if (!questionIds.has(qid) && qid !== '_freeform') continue
      if (value && typeof value === 'object') {
        normalized[qid] = {
          choice: String(
            (value as Record<string, unknown>).choice ?? '',
          ).trim(),
          freeform: String(
            (value as Record<string, unknown>).freeform ?? '',
          ).trim(),
        }
      } else {
        normalized[qid] = { choice: String(value ?? '').trim(), freeform: '' }
      }
    }
    if (!Object.keys(normalized).length)
      throw new Error('at least one answer is required')
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
      const answer =
        (interaction.answers[question.id] as Record<string, unknown>) ?? {}
      const choice =
        answer && typeof answer === 'object' ? answer.choice : String(answer)
      const freeform =
        answer && typeof answer === 'object' ? answer.freeform : ''
      lines.push(`- ${question.header}: ${question.question}`)
      if (choice) lines.push(`  answer: ${choice}`)
      if (freeform) lines.push(`  note: ${freeform}`)
    }
    const extra = interaction.answers._freeform
    if (
      extra &&
      typeof extra === 'object' &&
      (extra as Record<string, unknown>).freeform
    ) {
      lines.push(
        `- additional note: ${(extra as Record<string, unknown>).freeform}`,
      )
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

  private approvalMessage(
    interaction: Interaction,
    planRecord: PlanRecord | null = null,
  ): string {
    const lines = [
      '[CONTROL:PLAN_APPROVED]',
      `interaction_id: ${interaction.id}`,
    ]
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
      '- Treat the approved plan as execution context, not as a live task database.',
      '- Use update_todos as the session checklist for complex work; it is not a verification tool and does not decide PlanStep status.',
      '- Keep exactly one active todo while executing. Mark a todo completed only when the described work is actually complete.',
      '- Run relevant tests, builds, commands, or an independent reviewer before final reporting when the change is non-trivial.',
      '- If verification failed, keep the relevant todo in_progress or blocked, diagnose and repair the failure, rerun checks, then continue.',
      '- If the step is blocked by missing input, access, cost, safety, or unrecoverable ambiguity, call ask_user and keep the step blocked until resolved.',
      '- Do not claim completion while the session todo list still has pending, in_progress, or blocked items.',
    )
    if (planRecord !== null && planRecord.steps.length) {
      lines.push('', '[PLAN_STEPS]')
      for (const step of planRecord.steps) {
        lines.push(`- ${step.id} [${step.status}] ${step.title}`)
        if (step.files.length)
          lines.push(`  files: ${step.files.slice(0, 5).join('; ')}`)
        if (step.commands.length)
          lines.push(`  commands: ${step.commands.slice(0, 5).join('; ')}`)
        if (step.acceptance.length)
          lines.push(`  acceptance: ${step.acceptance.slice(0, 5).join('; ')}`)
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
      '- 只有在进入 Plan 模式后，才使用 `propose_plan` 提交等待批准的计划。\n' +
      '- 当任务属于高影响改动且当前不在 Plan 模式时，调用 `request_plan_mode` 请求用户一键切换到计划模式，不要用 `ask_user` 现场组织措辞。'
    )
  }

  toolDefinitions(registry: ToolRegistry): ToolDefinition[] {
    return this.policy.filteredDefinitions(registry)
  }

  isToolAllowed(name: string, registry: ToolRegistry): boolean {
    return this.policy.isToolAllowed(name, registry)
  }

  assessPermission(
    name: string,
    args: Record<string, unknown>,
    registry: ToolRegistry | null,
  ) {
    return this.permissionManager.assess(name, args, { registry })
  }

  permissionApprovalResult(
    decision: Parameters<PermissionManager['requireApproval']>[0],
    opts?: { parentCallId?: string | null },
  ): string {
    return this.permissionManager.requireApproval(decision, {
      parentCallId: opts?.parentCallId ?? null,
    })
  }

  syncPlanFromTodos(
    todos: Array<Record<string, unknown>>,
    opts?: { evidence?: Record<string, unknown> | null },
  ): PlanRecord | null {
    return this.execution.syncPlanFromTodos(todos, opts)
  }

  hasAskInteraction(): boolean {
    const state = this.store.load()
    return [state.pending, state.lastInteraction].some(
      (item) => item !== null && item.kind === InteractionKind.ASK,
    )
  }

  planVerificationTarget(command: string): Record<string, string> | null {
    return this.verification.planVerificationTarget(command)
  }

  resolveGoalPlanVerificationFact(
    goalId: string,
    goal: import('../goals/models').GoalRecord,
    source: import('../goals/evidence').GoalPlanVerificationSource,
  ): import('../goals/evidence').GoalPlanVerificationFact | null {
    return this.verification.resolveGoalPlanVerificationFact(
      goalId,
      goal,
      source,
    )
  }

  resolvePlanStepVerificationFact(
    goal: import('../goals/models').GoalRecord,
    context: import('../goals/plan-bridge').PlanStepVerificationContext,
    knownPlan?: import('../plans/models').PlanRecord,
  ): import('../goals/plan-bridge').PlanStepVerificationFact | null {
    return this.verification.resolvePlanStepVerificationFact(
      goal,
      context,
      knownPlan,
    )
  }

  resolvePlanStepWaiverFact(
    goal: import('../goals/models').GoalRecord,
    context: import('../goals/plan-bridge').PlanStepWaiverContext,
    knownPlan?: import('../plans/models').PlanRecord,
  ): import('../goals/plan-bridge').PlanStepWaiverFact | null {
    return this.verification.resolvePlanStepWaiverFact(goal, context, knownPlan)
  }

  resolvePlanReviewerFact(
    goal: import('../goals/models').GoalRecord,
    context: import('../goals/plan-bridge').PlanReviewerContext,
  ): import('../goals/plan-bridge').PlanReviewerFact | null {
    return this.verification.resolvePlanReviewerFact(goal, context)
  }

  requestGoalReviewerWaiver(opts: {
    goal: import('../goals/models').GoalRecord
    planId: string
    planEventSeq: number
    riskSignals: readonly string[]
    riskFactVersion: string | null
    reason: string
  }): Interaction {
    return this.verification.requestGoalReviewerWaiver(opts)
  }

  resolveGoalReviewerWaiverAction(
    goal: import('../goals/models').GoalRecord,
    context: import('../goals/reviewer').GoalReviewerWaiverActionContext,
  ): import('../goals/reviewer').GoalReviewerWaiverActionFact | null {
    return this.verification.resolveGoalReviewerWaiverAction(goal, context)
  }

  recordPlanDiscovery(opts: {
    source: string
    summary: string
    files?: string[] | null
    symbols?: string[] | null
    evidenceRefs?: string[] | null
  }): PlanRecord | null {
    return this.drafting.recordPlanDiscovery(opts)
  }

  recordPlanStepToolOutput(
    opts: Parameters<PlanExecutionManager['recordPlanStepToolOutput']>[0],
  ): unknown {
    return this.execution.recordPlanStepToolOutput(opts)
  }

  recordPlanVerificationResult(opts: {
    planId: string
    stepId: string
    result: Record<string, unknown>
  }): PlanRecord | null {
    return this.verification.recordPlanVerificationResult(opts)
  }

  appendPlanStepVerification(
    record: PlanRecord,
    opts: { stepId: string; result: Record<string, unknown> },
  ): void {
    this.execution.appendPlanStepVerification(record, opts)
  }

  issuePlanPermissionTokens(record: PlanRecord): PlanRecord {
    return this.permissionTokens.issue(record)
  }

  consumePlanPermissionToken(opts: {
    toolName: string
    arguments: Record<string, unknown>
  }): PlanPermissionToken | null {
    return this.permissionTokens.consume(opts)
  }

  revokePlanPermissionTokens(opts?: {
    planId?: string | null
    reason?: string
  }): PlanRecord | null {
    return this.permissionTokens.revoke(opts)
  }

  clearPendingInteractionForGoal(targetId: string): boolean {
    const target = String(targetId ?? '').trim()
    if (!target) return false
    const state = this.store.load()
    const pending = state.pending
    if (
      !pending ||
      (pending.id !== target &&
        String(pending.meta.goal_id ?? '').trim() !== target)
    )
      return false
    state.pending = null
    state.lastInteraction = pending
    state.updatedAt = nowTs()
    this.store.save(state)
    this.notifyPendingCleared(pending)
    return true
  }

  /** Returns the durable Goal binding for a resolved control interaction. */
  goalIdForInteraction(interactionId: string): string | null {
    const target = String(interactionId ?? '').trim()
    if (!target) return null
    const interaction = this.store.load().lastInteraction
    if (!interaction || interaction.id !== target) return null
    const direct = String(interaction.meta.goal_id ?? '').trim()
    if (direct) return direct
    for (const key of [
      'goal_manual_evidence_request',
      'goal_permission_blocker_request',
      'goal_reviewer_waiver_request',
    ]) {
      const value = interaction.meta[key]
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const goalId = String(
        (value as Record<string, unknown>).goal_id ?? '',
      ).trim()
      if (goalId) return goalId
    }
    return null
  }

  recordIndependentVerificationResult(opts: {
    planId: string
    result: Record<string, unknown>
  }): PlanRecord | null {
    return this.verification.recordIndependentVerificationResult(opts)
  }

  waiveIndependentVerification(opts: {
    planId: string
    reason: string
  }): PlanRecord | null {
    return this.verification.waiveIndependentVerification(opts)
  }

  planIndependentVerificationFollowup(opts?: {
    dispatchAvailable?: boolean
  }): Record<string, unknown> | null {
    return this.verification.planIndependentVerificationFollowup(opts)
  }

  latestExecutablePlan(): PlanRecord | null {
    const current = latestApprovedPlanGeneration(
      this.planStore.list(),
      (record) => this.planMatchesCurrentScope(record),
    )
    if (
      current === null ||
      this.planStore.isExecutionBlocked(current.id) ||
      isPlanInvalidated(current) ||
      (current.status !== PlanStatus.APPROVED &&
        current.status !== PlanStatus.EXECUTING)
    )
      return null
    return current
  }

  reviewablePlanId(): string | null {
    const record = this.latestReviewablePlan()
    if (record === null || !record.steps.length || !planStepsFinished(record))
      return null
    return record.id
  }

  /**
   * 收尾诚实性（2026-07-05 B4.2）：取当前 scope 内最新计划中「有验证要求但无命令证据」
   * 的步骤，并在计划上盖章防止跨 turn 重复提醒。一次性领取语义。
   */
  claimUnverifiedPlanSteps(): {
    planId: string
    steps: Array<{ id: string; title: string }>
  } | null {
    const record = this.latestReviewablePlan()
    if (record === null || record.metadata.verification_honesty_nudged)
      return null
    // 只在「宣称完工」时提醒（步骤全部 done/skipped 或计划已 COMPLETED）；执行中途的 stop 不拦
    if (record.status !== PlanStatus.COMPLETED && !planStepsFinished(record))
      return null
    // stepVerificationStatus='pending' 即「有验证要求（含从 commands 派生）但缺必需证据」
    const unverified = record.steps.filter(
      (step) =>
        step.status !== PlanStepStatus.SKIPPED &&
        stepVerificationStatus(step) === 'pending',
    )
    if (!unverified.length) return null
    this.planStore.save({
      ...record,
      metadata: { ...record.metadata, verification_honesty_nudged: nowTs() },
    })
    return {
      planId: record.id,
      steps: unverified.map((step) => ({ id: step.id, title: step.title })),
    }
  }

  latestReviewablePlan(): PlanRecord | null {
    const current = latestApprovedPlanGeneration(
      this.planStore.list(),
      (record) => this.planMatchesCurrentScope(record),
    )
    if (
      current === null ||
      this.planStore.isExecutionBlocked(current.id) ||
      isPlanInvalidated(current) ||
      (current.status !== PlanStatus.APPROVED &&
        current.status !== PlanStatus.EXECUTING &&
        current.status !== PlanStatus.COMPLETED)
    )
      return null
    return current
  }

  static restoreMode(state: ControlState): string {
    if (
      state.previousMode === ControlMode.ASK_BEFORE_EDIT ||
      state.previousMode === ControlMode.ACCEPT_EDITS ||
      state.previousMode === ControlMode.AUTO
    ) {
      return state.previousMode
    }
    return ControlMode.ASK_BEFORE_EDIT
  }

  static interactionEvent(interaction: Interaction): Record<string, unknown> {
    const event =
      interaction.kind === InteractionKind.ASK ? 'ask_request' : 'plan_draft'
    return { event, interaction: interactionToDict(interaction) }
  }

  static interactionFromMarker(marker: string): Record<string, unknown> | null {
    let raw: unknown
    try {
      raw = JSON.parse(marker)
    } catch {
      return null
    }
    const interaction =
      raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>).interaction
        : null
    return interaction && typeof interaction === 'object'
      ? (interaction as Record<string, unknown>)
      : null
  }
}

function normalizeRuntimeScope(
  scope: ControlRuntimeScope | null | undefined,
): Required<ControlRuntimeScope> | null {
  if (!scope) return null
  const normalized = {
    sessionId: cleanScopeValue(scope.sessionId),
    mode: cleanScopeValue(scope.mode) as 'chat' | 'build',
    projectId: cleanScopeValue(scope.projectId),
    workspaceRoot: cleanScopeValue(scope.workspaceRoot),
    projectFingerprint: cleanScopeValue(scope.projectFingerprint),
  }
  return normalized.sessionId ||
    normalized.mode ||
    normalized.projectId ||
    normalized.workspaceRoot ||
    normalized.projectFingerprint
    ? normalized
    : null
}

function cleanScopeValue(value: unknown): string {
  return String(value ?? '').trim()
}

function planMatchesScope(
  record: PlanRecord,
  current: Required<ControlRuntimeScope> | null,
): boolean {
  if (current === null) return true
  const saved = planRuntimeScope(record)
  if (saved === null) return false
  if (record.goalId !== null) return goalScopesEqual(saved, current)
  let compared = false
  const keys: Array<keyof Required<ControlRuntimeScope>> = [
    'sessionId',
    'projectId',
    'workspaceRoot',
  ]
  for (const key of keys) {
    const currentValue = current[key]
    const savedValue = saved[key]
    if (!currentValue && !savedValue) continue
    compared = true
    if (!currentValue || !savedValue || currentValue !== savedValue)
      return false
  }
  return compared
}

function planRuntimeScope(
  record: PlanRecord,
): Required<ControlRuntimeScope> | null {
  const metadata = record.metadata ?? {}
  const scope =
    metadata.scope && typeof metadata.scope === 'object'
      ? (metadata.scope as Record<string, unknown>)
      : {}
  const normalized = normalizeRuntimeScope({
    sessionId: cleanScopeValue(
      scope.session_id ??
        scope.sessionId ??
        metadata.session_id ??
        metadata.sessionId,
    ),
    projectId: cleanScopeValue(
      scope.project_id ??
        scope.projectId ??
        metadata.project_id ??
        metadata.projectId,
    ),
    workspaceRoot: cleanScopeValue(
      scope.workspace_root ??
        scope.workspaceRoot ??
        metadata.workspace_root ??
        metadata.workspaceRoot,
    ),
    mode: cleanScopeValue(scope.mode ?? metadata.mode) as 'chat' | 'build',
    projectFingerprint: cleanScopeValue(
      scope.project_fingerprint ??
        scope.projectFingerprint ??
        metadata.project_fingerprint ??
        metadata.projectFingerprint,
    ),
  })
  return normalized
}

function askAnswerCancelsPlan(interaction: Interaction): boolean {
  const parts: string[] = []
  for (const question of interaction.questions) {
    parts.push(question.id, question.header, question.question)
  }
  for (const answer of Object.values(interaction.answers)) {
    if (answer && typeof answer === 'object') {
      parts.push(String((answer as Record<string, unknown>).choice ?? ''))
      parts.push(String((answer as Record<string, unknown>).freeform ?? ''))
    } else {
      parts.push(String(answer ?? ''))
    }
  }
  const text = parts.join('\n').toLowerCase()
  return (
    /无视系统继续|放弃该计划|放弃这个计划|放弃旧计划|取消计划|终止计划|停止计划/.test(
      text,
    ) ||
    /\b(abandon|cancel|ignore)\b[\s\S]{0,40}\b(plan|stuck plan)\b/i.test(text)
  )
}
