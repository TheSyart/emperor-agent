/**
 * ControlManager (MIG-CTRL-002/011)。对齐 Python `agent/control/manager.py`。
 * 薄门面，委托 8 个子管理器；Ask/Plan 交互流 + 模式管理 + resume 消息逐字保真。
 */
import { nowTs } from '../util/time'
import { PermissionManager } from '../permissions/manager'
import type { PlanPermissionToken } from '../permissions/models'
import type { PermissionRuleInput } from '../permissions/rules'
import type { PermissionSemanticClassifier } from '../permissions/semantic-classifier'
import type { ModelRouter } from '../model/router'
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
  controlStateToPublicDict,
  interactionToPublicDict,
  makeAsk,
  questionFromDict,
  touchInteraction,
  type ControlState,
  type ControlStatePayload,
  type Interaction,
  type InteractionPayload,
} from './models'
import { PlanDraftingManager } from './plan-drafting'
import {
  PlanExecutionManager,
  type PlanExecutionPauseInput,
} from './plan-execution'
import { PlanExecutionActionManager } from './plan-execution-actions'
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
  executionId?: string
  executionDisposition?: 'resume' | 'pause' | 'complete' | 'cancel'
  settlementId?: string
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
  readonly planExecutionActions: PlanExecutionActionManager
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
    opts: {
      permissionRules?: PermissionRuleInput[] | null
      permissionClassifier?: PermissionSemanticClassifier | null
      modelRouter?: Pick<ModelRouter, 'route'> | null
    } = {},
  ) {
    this.store = new ControlStore(root)
    this.goalMutations = new GoalGateMutationLedger(root)
    this.planStore = new PlanStore(root)
    this.policy = new ControlPolicy(this)
    this.clarificationPolicy = new ClarificationPolicy()
    this.planDecisionPolicy = new PlanDecisionPolicy()
    this.permissionManager = new PermissionManager(
      this as unknown as ConstructorParameters<typeof PermissionManager>[0],
      {
        stateRoot: root,
        rules: opts.permissionRules ?? [],
        classifier: opts.permissionClassifier,
        modelRouter: opts.modelRouter,
      },
    )
    this.permissionTokens = new PlanPermissionTokenManager(this)
    this.verification = new PlanVerificationManager(this)
    this.drafting = new PlanDraftingManager(this)
    this.execution = new PlanExecutionManager(this)
    this.planExecutionActions = new PlanExecutionActionManager(this)
    this.goalBlocker = new GoalBlockerControlManager(this)
    this.goalManualEvidence = new GoalManualEvidenceControlManager(this)
    this.planExecutionActions.reconcilePrepared()
    this.reconcilePendingInteraction()
  }

  private reconcilePendingInteraction(): void {
    const state = this.store.load()
    const pending = state.pending
    if (!pending) return
    if (isObsoleteLegacyGuard(pending)) {
      const cancelled = touchInteraction(pending, {
        status: InteractionStatus.CANCELLED,
      })
      state.pending = null
      state.lastInteraction = cancelled
      state.updatedAt = nowTs()
      this.store.save(state)
      return
    }
    if (pending.kind === InteractionKind.PLAN) {
      const planId = String(pending.meta.plan_id ?? '').trim()
      const generation = Number(pending.meta.approval_generation ?? 0)
      const plan = planId ? this.planStore.get(planId) : null
      const persistedGeneration = Number(
        plan?.metadata.approval_generation ?? 0,
      )
      if (
        plan === null ||
        plan.status !== PlanStatus.WAITING_APPROVAL ||
        plan.sourceInteractionId !== pending.id ||
        !Number.isInteger(generation) ||
        generation < 1 ||
        generation !== persistedGeneration
      ) {
        const cancelled = touchInteraction(pending, {
          status: InteractionStatus.CANCELLED,
        })
        state.pending = null
        state.lastInteraction = cancelled
        state.updatedAt = nowTs()
        this.store.save(state)
      }
      return
    }
    if (pending.meta?.interaction_type !== 'permission') return
    if (this.permissionManager.isWaitingRequestRecoverable(pending)) return
    const cancelled = touchInteraction(pending, {
      status: InteractionStatus.CANCELLED,
    })
    state.pending = null
    state.lastInteraction = cancelled
    state.updatedAt = nowTs()
    this.store.save(state)
  }

  setTodoStore(todoStore: TodoStoreLike | null): void {
    this.todoStore = todoStore
  }

  /**
   * Bind one synchronous Plan/Todo operation to its owning session store.
   * The callback must not return a Promise: restoring immediately is what
   * prevents another Session Actor from observing this temporary binding.
   */
  withTodoStore<T>(todoStore: TodoStoreLike | null, action: () => T): T {
    const previous = this.todoStore
    this.todoStore = todoStore
    try {
      const result = action()
      if (
        result !== null &&
        typeof result === 'object' &&
        typeof (result as { then?: unknown }).then === 'function'
      )
        throw new Error('withTodoStore only supports synchronous operations')
      return result
    } finally {
      this.todoStore = previous
    }
  }

  setTaskManager(taskManager: TaskManagerLike | null): void {
    this.taskManager = taskManager
    if (taskManager !== null) {
      this.execution.reconcileRevokedPlanTasks()
      this.execution.reconcileExecutablePlanTasks()
    }
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
    return controlStateToPublicDict(this.store.load())
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
      value = ControlMode.SMART_AUTO
    else if (value === 'auto' || value === 'automatic')
      value = ControlMode.FULL_ACCESS
    if (
      value !== ControlMode.ASK_BEFORE_EDIT &&
      value !== ControlMode.SMART_AUTO &&
      value !== ControlMode.FULL_ACCESS &&
      value !== ControlMode.PLAN
    ) {
      throw new Error(
        'mode must be ask_before_edit, smart_auto, full_access or plan',
      )
    }
    const state = this.store.load()
    const oldMode = state.mode
    let cancelledPendingPlan: Interaction | null = null
    if (value === ControlMode.PLAN && oldMode !== ControlMode.PLAN) {
      // A missing session scope must never make this operation global.  The
      // ordinary Plan draft flow remains available, but no durable Plan is
      // replaced until the Core has bound this manager to a session.
      if (this.planScopeMetadata()?.session_id) {
        const draft = this.drafting.newPlanModeDraft()
        const replacement = this.execution.beginPlanReplacement(draft)
        if (replacement !== null) {
          const pendingPlanId = String(state.pending?.meta.plan_id ?? '').trim()
          if (
            state.pending?.kind === InteractionKind.PLAN &&
            replacement.cancelledPlanIds.includes(pendingPlanId)
          ) {
            cancelledPendingPlan = touchInteraction(state.pending, {
              status: InteractionStatus.CANCELLED,
            })
            state.pending = null
            state.lastInteraction = cancelledPendingPlan
          }
        }
      }
    }
    if (value === ControlMode.PLAN && state.mode !== ControlMode.PLAN) {
      state.previousMode = state.mode
    } else if (value !== ControlMode.PLAN) {
      state.previousMode = null
    }
    state.mode = value
    state.updatedAt = nowTs()
    this.store.save(state)
    if (cancelledPendingPlan !== null)
      this.notifyPendingCleared(cancelledPendingPlan)
    if (value !== oldMode) {
      this.revokePlanPermissionTokens({ reason: 'control mode changed' })
    }
    return this.payload()
  }

  setPermissionMode(mode: string): ControlStatePayload {
    const raw = String(mode ?? '')
      .trim()
      .toLowerCase()
    const value =
      raw === 'accept_edits' || raw === 'accept-edits' || raw === 'edits'
        ? ControlMode.SMART_AUTO
        : raw === 'auto'
          ? ControlMode.FULL_ACCESS
          : raw
    if (
      value !== ControlMode.ASK_BEFORE_EDIT &&
      value !== ControlMode.SMART_AUTO &&
      value !== ControlMode.FULL_ACCESS
    ) {
      throw new Error(
        'permission mode must be ask_before_edit, smart_auto or full_access',
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
    interactionId?: string
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
      ...(opts.interactionId ? { id: opts.interactionId } : {}),
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
    return this.drafting.createPlan({
      ...opts,
      meta: {
        ...(this.askMetaProvider?.() ?? {}),
        ...(opts.meta ?? {}),
      },
    })
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
    const planExecutionAnswer = this.planExecutionActions.resolve(updated)
    if (planExecutionAnswer) {
      const resumeModel = planExecutionAnswer.disposition !== 'cancel'
      this.complete(updated)
      this.planExecutionActions.completeSettlement(
        planExecutionAnswer.settlementId,
      )
      return {
        interaction: interactionToPublicDict(updated),
        message: planExecutionAnswer.message,
        event: {
          ...planExecutionAnswer.event,
          interaction: interactionToPublicDict(updated),
          resume_model: resumeModel,
        },
        resume: resumeModel,
        ...executionResumeIdentity(updated),
        executionDisposition: planExecutionAnswer.disposition,
        settlementId: planExecutionAnswer.settlementId,
      }
    }
    const permissionAnswer = this.permissionManager.recordAnswer(
      updated as unknown as {
        meta?: Record<string, unknown>
        answers?: Record<string, unknown>
      },
    )
    this.drafting.recordPlanResolvedQuestions(updated)
    this.complete(updated)
    this.maybeEnterPlanModeFromAnswer(updated)
    const message = this.answerMessage(updated, permissionAnswer)
    return {
      interaction: interactionToPublicDict(updated),
      message,
      event: {
        event: 'ask_answered',
        interaction: interactionToPublicDict(updated),
        resume_model: true,
      },
      resume: true,
      ...executionResumeIdentity(updated),
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
      interaction: interactionToPublicDict(updated),
      message,
      event: {
        event: 'plan_comment_added',
        interaction: interactionToPublicDict(updated),
        comment: text,
      },
      resume: true,
      ...executionResumeIdentity(updated),
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
      interaction: interactionToPublicDict(updated),
      control: this.payload(),
    }
    if (planRecord !== null) event.plan = planToDict(planRecord)
    if (this.todoStore !== null) event.todos = [...this.todoStore.todos]
    return {
      interaction: interactionToPublicDict(updated),
      message,
      event,
      resume: true,
      ...executionResumeIdentity(updated),
    }
  }

  cancel(interactionId: string): Record<string, unknown> {
    const pending = this.requirePending(interactionId)
    this.permissionManager.cancelRequest(pending)
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
      const runningPlan = this.latestExecutablePlan()
      if (runningPlan !== null) {
        const paused = this.execution.pauseExecution({
          reason: 'user_input_required',
          turnId: String(
            pending.meta?.control_turn_id ?? pending.meta?.turn_id ?? '',
          ).trim(),
          executionId: String(pending.meta?.execution_id ?? '').trim(),
          pausedAt: nowTs(),
          evaluationCount: 0,
          totalIterations: 0,
          nextActions: ['继续执行当前计划或明确取消计划'],
        })
        if (paused !== null) {
          return {
            event: 'plan_execution_settled',
            action: 'pause',
            disposition: 'pause',
            interaction: interactionToPublicDict(updated),
            plan: planToDict(paused),
            control: this.payload(),
            message: '计划已暂停，等待用户明确继续或取消。',
          }
        }
      }
    }
    return {
      event: 'interaction_cancelled',
      interaction: interactionToPublicDict(updated),
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
        const requestedOptionId = String(
          (value as Record<string, unknown>).option_id ??
            (value as Record<string, unknown>).optionId ??
            '',
        ).trim()
        const requestedChoice = String(
          (value as Record<string, unknown>).choice ?? '',
        ).trim()
        const question = interaction.questions.find(
          (candidate) => candidate.id === qid,
        )
        const optionById = requestedOptionId
          ? question?.options.find((option) => option.id === requestedOptionId)
          : undefined
        const legacyOption =
          !requestedOptionId && requestedChoice
            ? question?.options.find(
                (option) => option.label === requestedChoice,
              )
            : undefined
        if (
          requestedOptionId &&
          !optionById &&
          interaction.meta?.interaction_type !== 'permission'
        )
          throw new Error(`unknown option id for ${qid}: ${requestedOptionId}`)
        normalized[qid] = {
          option_id:
            optionById?.id ??
            legacyOption?.id ??
            (interaction.meta?.interaction_type === 'permission'
              ? requestedOptionId
              : ''),
          choice: optionById?.label ?? legacyOption?.label ?? requestedChoice,
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

  private answerMessage(
    interaction: Interaction,
    permissionAnswer:
      import('../permissions/manager').PermissionAnswerResult | null,
  ): string {
    if (permissionAnswer) {
      return [
        '[CONTROL:PERMISSION_ANSWERED]',
        `interaction_id: ${interaction.id}`,
        `authorization_id: ${permissionAnswer.requestId}`,
        `decision: ${permissionAnswer.outcome}`,
        '权限层已经记录本批精确操作的决定。请直接重新发起同一批工具调用；不要再用自然语言要求用户确认。',
      ].join('\n')
    }
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
      '- PlanRecord and PlanStep are the authoritative execution state.',
      '- Do not create a Todo merely to mirror a one-step or otherwise simple Plan.',
      '- After the active step implementation is actually complete, call complete_plan_step with its stable step id and a concrete summary.',
      '- complete_plan_step records an implementation claim only; Core still enforces every required verification.',
      '- Use update_todos only when the work contains multiple independent implementation items that need an additional session checklist. Todo never decides PlanStep or verification status.',
      '- Run relevant tests, builds, commands, or an independent reviewer before final reporting when the change is non-trivial.',
      '- If verification failed, diagnose and repair the failure, rerun checks, then call complete_plan_step again only after the implementation is ready.',
      '- If the step is blocked by missing input, access, cost, safety, or unrecoverable ambiguity, call ask_user and keep the step blocked until resolved.',
      '- Do not claim final completion while PlanStep or required verification remains unfinished.',
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
        '当前阶段只允许探索、提问、设计、复核和提交计划；用户批准前不得实施。\n\n' +
        '## Workflow\n' +
        '1. Explore：读取现有实现、关键文件、复用点、调用方和验证入口。\n' +
        '2. Question：只有会改变方案且无法由代码回答的产品取舍才调用 `ask_user`。\n' +
        '3. Design：提出一个推荐方案，列出拒绝的替代方案、依赖、风险与回滚。\n' +
        '4. Review：对照原任务和 discovery 复核覆盖范围与验证能力。\n' +
        '5. Submit：门禁满足后只能通过 `propose_plan` 进入 PlanCard。\n\n' +
        '## Boundaries\n' +
        '- 不允许修改文件、执行变更命令、更新 Todo 或创建队友。\n' +
        '- 可派遣 registry 明确标记的 Plan 只读 Explore/Inventory/Planner/Verifier；主 Agent 必须综合并复核关键证据。\n' +
        '- 不得猜测 discovery_refs，不得用普通最终回复替代计划卡。\n' +
        '- 浏览器目视与主观观感默认 optional。只有用户明确要求由其人工验收时，才可设 `human_required=true` 并阻塞完成。\n' +
        '- 没有 Browser 工具时，优先规划可执行的结构、测试或静态验证，并在计划中披露视觉回归限制。\n\n' +
        '## Submission gate\n' +
        '- 至少一条成功 discovery、无未解决问题、步骤引用真实证据、验证与当前能力匹配，并存在 review receipt。\n\n' +
        this.drafting.promptContext()
      )
    }
    return (
      '# Control Tools\n\n' +
      `- 当前权限模式：${this.mode}。\n` +
      '- `ask_before_edit`（询问确认）只自动执行只读操作；编辑、Shell 与外部写入会先询问。\n' +
      '- `smart_auto`（智能自动）会自动执行工作区编辑、构建测试和确定安全的本地命令；高影响或不确定操作会先询问。\n' +
      '- `full_access`（完全访问）不发起普通权限审批，但仍受明确拒绝、Plan 只读、schema、工具可用性和系统边界约束。\n' +
      '- `ask_user` 只用于目标、范围、产品取舍等真实歧义，绝不能代替运行时权限审批。\n' +
      '- 删除、覆盖、提交、推送、发布和部署是否需要确认，只由权限层按当前模式判断。目标和精确对象已经明确时，直接调用工具；不要再次用自然语言要求确认。\n' +
      '- 可通过只读探索确认的事实先探索；只有仍存在会改变实施方案的关键取舍时才提问。\n' +
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

  async assessPermission(
    name: string,
    args: Record<string, unknown>,
    registry: ToolRegistry | null,
    opts?: {
      sessionId?: string | null
      turnId?: string | null
      workspaceRoot?: string | null
      cwd?: string | null
      taskIntent?: string | null
      authorizationId?: string | null
    },
  ) {
    return await this.permissionManager.assess(name, args, {
      registry,
      ...opts,
    })
  }

  async assessPermissionBatch(
    calls: import('../permissions/manager').PermissionAssessmentCall[],
    registry: ToolRegistry | null,
    opts?: {
      sessionId?: string | null
      turnId?: string | null
      workspaceRoot?: string | null
      cwd?: string | null
      taskIntent?: string | null
      authorizationId?: string | null
    },
  ) {
    return await this.permissionManager.assessBatch(calls, {
      registry,
      ...opts,
    })
  }

  permissionApprovalResult(
    decision: Parameters<PermissionManager['requireApproval']>[0],
    opts?: { parentCallId?: string | null; sessionId?: string | null },
  ): string {
    return this.permissionManager.requireApproval(decision, {
      parentCallId: opts?.parentCallId ?? null,
      sessionId: opts?.sessionId ?? null,
    })
  }

  permissionBatchApprovalResult(
    batch: Parameters<PermissionManager['requireApprovalBatch']>[0],
    opts?: {
      parentCallId?: string | null
      sessionId?: string | null
      workspaceRoot?: string | null
      cwd?: string | null
    },
  ): string {
    return this.permissionManager.requireApprovalBatch(batch, opts)
  }

  requestPlanExecutionDecision(input: {
    turnId: string
    executionId: string
  }): Interaction | null {
    return this.planExecutionActions.request(input)
  }

  normalizePlanTodoUpdate(
    todos: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    return this.execution.normalizeTodoUpdate(todos)
  }

  migrateLegacyPlanTodoMirrors(): void {
    this.execution.migrateLegacyPlanTodoMirrors()
  }

  pausePlanExecution(input: PlanExecutionPauseInput): PlanRecord | null {
    return this.execution.pauseExecution(input)
  }

  resumePlanExecution(input: { turnId: string }): PlanRecord | null {
    return this.execution.resumeExecution(input)
  }

  pausedPlanExecutionId(): string | null {
    const record = this.latestExecutablePlan()
    const pause =
      record?.metadata.execution_pause &&
      typeof record.metadata.execution_pause === 'object' &&
      !Array.isArray(record.metadata.execution_pause)
        ? (record.metadata.execution_pause as Record<string, unknown>)
        : null
    const executionId = String(
      pause?.execution_id ?? pause?.turn_id ?? '',
    ).trim()
    return executionId || null
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

  completePlanStep(
    input: Parameters<PlanExecutionManager['completePlanStep']>[0],
  ): PlanRecord {
    return this.execution.completePlanStep(input)
  }

  hasExecutablePlan(): boolean {
    return this.latestExecutablePlan() !== null
  }

  shouldExposeUpdateTodos(): boolean {
    const record = this.latestExecutablePlan()
    return record === null || record.steps.length >= 3
  }

  recordPlanVerificationResult(opts: {
    planId: string
    stepId: string
    result: Record<string, unknown>
  }): PlanRecord | null {
    const saved = this.verification.recordPlanVerificationResult(opts)
    return saved === null
      ? null
      : this.execution.reconcileAfterVerification(saved)
  }

  currentPlanExecutionPhase(): {
    planId: string
    stepId: string
    phase:
      | 'implementing'
      | 'verifying'
      | 'repairing'
      | 'waiting_user'
      | 'completed'
      | 'cancelled'
  } | null {
    const record = this.latestExecutablePlan()
    const step = record?.steps.find(
      (candidate) => candidate.status === PlanStepStatus.ACTIVE,
    )
    if (!record || !step) return null
    const phases = record.metadata.plan_step_execution_phases
    const raw =
      phases && typeof phases === 'object' && !Array.isArray(phases)
        ? String((phases as Record<string, unknown>)[step.id] ?? '')
        : ''
    const phase =
      raw === 'verifying' ||
      raw === 'repairing' ||
      raw === 'waiting_user' ||
      raw === 'completed' ||
      raw === 'cancelled'
        ? raw
        : 'implementing'
    return { planId: record.id, stepId: step.id, phase }
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

  recordIndependentVerificationToolResult(opts: {
    toolCallId: string
    agentType: string
    output: string
  }): PlanRecord | null {
    return this.verification.recordIndependentVerificationToolResult(opts)
  }

  independentVerificationDispatchGuard(agentType: string): string | null {
    return this.verification.independentVerificationDispatchGuard(agentType)
  }

  independentVerificationAskGuard(): string | null {
    return this.verification.independentVerificationAskGuard()
  }

  markIndependentVerificationDelivered(): PlanRecord | null {
    return this.verification.markIndependentVerificationDelivered()
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
   * 收尾诚实性：返回当前 scope 内「实现已声明完成，但必需验证尚未满足」
   * 的步骤。执行中的验证门禁必须在每次过早 final reply 时继续生效；
   * 已经终结的历史计划仍只提醒一次，避免跨 turn 重复噪声。
   */
  claimUnverifiedPlanSteps(): {
    planId: string
    steps: Array<{ id: string; title: string }>
  } | null {
    const record = this.latestReviewablePlan()
    if (record === null) return null
    const implementationClaims =
      record.metadata.implementation_claims &&
      typeof record.metadata.implementation_claims === 'object' &&
      !Array.isArray(record.metadata.implementation_claims)
        ? (record.metadata.implementation_claims as Record<string, unknown>)
        : {}
    const activeUnverified = record.steps.filter(
      (step) =>
        step.status === PlanStepStatus.ACTIVE &&
        implementationClaims[step.id] !== undefined &&
        stepVerificationStatus(step) === 'pending',
    )
    if (activeUnverified.length)
      return {
        planId: record.id,
        steps: activeUnverified.map((step) => ({
          id: step.id,
          title: step.title,
        })),
      }

    if (record.metadata.verification_honesty_nudged) return null
    if (record.status !== PlanStatus.COMPLETED && !planStepsFinished(record))
      return null
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
      state.previousMode === ControlMode.SMART_AUTO ||
      state.previousMode === ControlMode.FULL_ACCESS
    ) {
      return state.previousMode
    }
    return ControlMode.ASK_BEFORE_EDIT
  }

  static interactionEvent(interaction: Interaction): Record<string, unknown> {
    const event =
      interaction.kind === InteractionKind.ASK ? 'ask_request' : 'plan_draft'
    return { event, interaction: interactionToPublicDict(interaction) }
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

function executionResumeIdentity(
  interaction: Interaction,
): { executionId: string } | Record<string, never> {
  const executionId = String(
    interaction.meta.execution_id ?? interaction.meta.control_turn_id ?? '',
  ).trim()
  return executionId ? { executionId } : {}
}

function isObsoleteLegacyGuard(interaction: Interaction): boolean {
  if (interaction.kind !== InteractionKind.ASK) return false
  return /^(?:Ask|Permission) Guard\s*:/i.test(
    String(interaction.context ?? '').trim(),
  )
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
  // An unbound manager may only see legacy/unscoped Plans. Treating a missing
  // current scope as a wildcard leaks drafts across desktop sessions.
  if (current === null)
    return record.sessionId === null && planRuntimeScope(record) === null
  const saved = planRuntimeScope(record)
  if (saved === null) return false
  if (record.goalId !== null) return goalScopesEqual(saved, current)
  let compared = false
  const keys: Array<keyof Required<ControlRuntimeScope>> = [
    'sessionId',
    'mode',
    'projectId',
    'workspaceRoot',
    'projectFingerprint',
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
