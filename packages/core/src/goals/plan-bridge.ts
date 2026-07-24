import {
  PlanStatus,
  PlanStepStatus,
  emptyDraft,
  makePlanRecord,
  type PlanRecord,
  type PlanStep,
} from '../plans/models'
import { PlanExecutionState } from '../plans/execution-state'
import { createHash, randomUUID } from 'node:crypto'
import {
  planApprovalIntent,
  planSkipIntent,
  type PlanApprovalIntent,
  type PlanSkipIntent,
  type PlanSkipIntentStage,
  type PlanStore,
} from '../plans/store'
import type { TaskManager } from '../tasks/manager'
import { TaskKind, TaskStatus, type TaskRecord } from '../tasks/models'
import type { GoalRecord } from './models'
import type { GoalStore } from './store'
import { planMatchesGoalScope, plansShareFullGoalScope } from './scope'
import { assertGoalTransition } from './validation'
import {
  comparePlanApprovalGeneration,
  isPlanInvalidated,
  metadataWithoutPlanPermissionTokens,
  taskStatusFromPlanStep,
} from '../control/plan-helpers'
import { requirementsForStep } from '../plans/verification'
import { planTopologyErrors } from '../plans/quality'
import { canonicalJson } from './events'
import {
  GoalReviewerPolicy,
  type GoalReviewerRiskFactResolver,
} from './reviewer'

export interface PlanStepWaiverContext {
  readonly goalId: string
  readonly planId: string
  readonly stepId: string
}

export interface PlanStepWaiverFact extends PlanStepWaiverContext {
  readonly kind: 'explicit_user_plan_step_waiver'
  readonly issuedBy: 'core'
  readonly approvedBy: 'user'
  readonly receiptId: string
}

export interface PlanStepResolutionSnapshot {
  readonly goal: GoalRecord
  readonly plan: PlanRecord
}

export type PlanStepWaiverResolver = (
  context: PlanStepWaiverContext,
  snapshot: PlanStepResolutionSnapshot,
) => PlanStepWaiverFact | null | Promise<PlanStepWaiverFact | null>

export interface PlanStepVerificationContext extends PlanStepWaiverContext {
  readonly planEventSeq: number
  readonly requirementId: string
  readonly requirementKind: string
  readonly command: string
}

export interface PlanStepVerificationFact extends PlanStepVerificationContext {
  readonly kind: 'core_plan_step_verification'
  readonly issuedBy: 'core'
  readonly verdict: 'pass'
  readonly receiptId: string
}

export type PlanStepVerificationResolver = (
  context: PlanStepVerificationContext,
  snapshot: PlanStepResolutionSnapshot,
) => PlanStepVerificationFact | null | Promise<PlanStepVerificationFact | null>

export interface PlanReviewerContext {
  readonly goalId: string
  readonly planId: string
  readonly planEventSeq: number
}

export interface PlanReviewerFact extends PlanReviewerContext {
  readonly kind: 'core_independent_plan_review'
  readonly issuedBy: 'core'
  readonly verdict: 'pass' | 'waived'
  readonly receiptId: string
  readonly commandEvidenceRefs: readonly string[]
}

export type PlanReviewerResolver = (
  context: PlanReviewerContext,
) => PlanReviewerFact | null | Promise<PlanReviewerFact | null>

export interface GoalPlanAssessment {
  readonly goalId: string
  readonly planId: string | null
  readonly status:
    'missing' | 'waiting_approval' | 'executing' | 'completed' | 'invalid'
  readonly incompleteStepIds: string[]
  readonly failedStepIds: string[]
  readonly skippedWithoutWaiverIds: string[]
  readonly scopeMatches: boolean
}

export interface GoalPlanStepReceipt {
  readonly id: string
  readonly status: string
  readonly requiredVerificationComplete: boolean
  readonly verificationBlockingErrors: string[]
  readonly waiverReceiptId: string | null
}

export interface GoalPlanReviewerReceipt {
  readonly required: boolean
  readonly satisfied: boolean
  readonly waived: boolean
  readonly riskSignals: string[]
  readonly evidenceSource: string | null
}

export interface SupersededPlanReceipt {
  readonly planId: string
  readonly status: string
  readonly eventSeq: number
  readonly supersededBy: string | null
  readonly chainValid: boolean
  readonly invalidReason: string | null
  readonly failure: {
    readonly code: string
    readonly summary: string
  } | null
}

export interface GoalPlanCompletionReceipt {
  readonly goalId: string
  readonly planId: string | null
  readonly completed: boolean
  readonly assessmentStatus: GoalPlanAssessment['status']
  readonly scopeMatches: boolean
  readonly planEventSeq: number
  readonly invalidReasons: string[]
  readonly steps: GoalPlanStepReceipt[]
  readonly reviewer: GoalPlanReviewerReceipt
  readonly supersededPlans: SupersededPlanReceipt[]
  readonly executionBlocked: boolean
  readonly hasIncompleteIntent: boolean
  readonly approvalGeneration: number
  readonly integritySha256: string
}

export interface GoalPlanBridgeOptions {
  readonly goalStore: GoalStore
  readonly planStore: PlanStore
  readonly taskManager?: TaskManager | null
  readonly now?: () => string
  readonly resolveStepWaiver?: PlanStepWaiverResolver | null
  readonly resolveStepVerification?: PlanStepVerificationResolver | null
  readonly resolveReviewer?: PlanReviewerResolver | null
  readonly resolveReviewerRiskFact?: GoalReviewerRiskFactResolver | null
  readonly hooks?: {
    readonly afterReplanStage?: (
      stage: ReplanIntentStage,
    ) => void | Promise<void>
  } | null
}

export interface GoalPlanSkipRecoveryResult {
  readonly count: number
}

export type ReplanIntentStage =
  | 'intent_persisted'
  | 'tasks_cancelled'
  | 'predecessor_cancelled'
  | 'successor_created'
  | 'goal_updated'
  | 'completed'
  | 'aborted'

export interface PreflightPlanApprovalInput {
  readonly goalId: string
  readonly planId: string
  readonly interactionId: string
  readonly approvalGeneration: number
}

export interface BindApprovedPlanInput {
  readonly goalId: string
  readonly planId: string
}

export interface SkipPlanStepWithWaiverInput extends BindApprovedPlanInput {
  readonly stepId: string
}

export interface GoalPlanBindingResult {
  readonly goal: GoalRecord
  readonly plan: PlanRecord
}

export interface RequestReplanInput {
  readonly goalId: string
  readonly reason: string
}

export interface GoalReplanResult {
  readonly goal: GoalRecord
  readonly plan: PlanRecord
  readonly previousPlan: PlanRecord
}

export class GoalPlanBridge {
  private readonly goalStore: GoalStore
  private readonly planStore: PlanStore
  private readonly taskManager: TaskManager | null
  private readonly now: () => string
  private readonly resolveStepWaiver: PlanStepWaiverResolver | null
  private readonly resolveStepVerification: PlanStepVerificationResolver | null
  private readonly resolveReviewer: PlanReviewerResolver | null
  private readonly resolveReviewerRiskFact: GoalReviewerRiskFactResolver | null
  private readonly reviewerPolicy = new GoalReviewerPolicy()
  private readonly afterReplanStage:
    ((stage: ReplanIntentStage) => void | Promise<void>) | null
  private readonly mutex = new KeyedMutex()

  constructor(options: GoalPlanBridgeOptions) {
    this.goalStore = options.goalStore
    this.planStore = options.planStore
    this.taskManager = options.taskManager ?? null
    this.now = options.now ?? (() => new Date().toISOString())
    this.resolveStepWaiver = options.resolveStepWaiver ?? null
    this.resolveStepVerification = options.resolveStepVerification ?? null
    this.resolveReviewer = options.resolveReviewer ?? null
    this.resolveReviewerRiskFact = options.resolveReviewerRiskFact ?? null
    this.afterReplanStage = options.hooks?.afterReplanStage ?? null
  }

  async preflightApproval(
    input: PreflightPlanApprovalInput,
  ): Promise<GoalPlanBindingResult> {
    const goalId = requiredId(input.goalId, 'Goal')
    const planId = requiredId(input.planId, 'Plan')
    const interactionId = requiredId(input.interactionId, 'Interaction')
    const approvalGeneration = Number(input.approvalGeneration)
    const goal = await this.goalStore.get(goalId)
    if (!goal) throw new Error('Goal does not exist')
    const plan = this.planStore.get(planId)
    if (!plan) throw new Error('Plan does not exist')
    const prepared = planApprovalIntent(plan)
    if (
      this.planStore.isQuarantined(plan.id) &&
      !approvalIntentMatches(prepared, {
        goalId,
        planId,
        interactionId,
        approvalGeneration,
      })
    )
      throw new Error('Plan is quarantined pending compensation')
    if (!goalAcceptsPlanApproval(goal, interactionId))
      throw new Error('Goal does not own the pending Plan approval')
    if (
      goal.runtime.currentPlanId !== null &&
      goal.runtime.currentPlanId !== plan.id
    )
      throw new Error('Goal already points to a different current Plan')
    if (plan.status !== PlanStatus.WAITING_APPROVAL)
      throw new Error('Plan is not waiting for approval')
    if (plan.goalId !== goal.id || !planMatchesGoalScope(plan, goal))
      throw new Error('Plan scope does not match Goal scope')
    if (plan.sourceInteractionId !== interactionId)
      throw new Error('Plan source interaction is stale')
    const persistedGeneration = Number(plan.metadata.approval_generation)
    if (
      !Number.isInteger(approvalGeneration) ||
      approvalGeneration < 1 ||
      persistedGeneration !== approvalGeneration
    )
      throw new Error('Plan approval generation is stale')
    return { goal, plan }
  }

  async prepareApproval(
    input: PreflightPlanApprovalInput,
  ): Promise<GoalPlanBindingResult> {
    const validated = await this.preflightApproval(input)
    const prepared = this.planStore.prepareApprovalQuarantine({
      planId: validated.plan.id,
      goalId: validated.goal.id,
      interactionId: validated.plan.sourceInteractionId!,
      approvalGeneration: Number(validated.plan.metadata.approval_generation),
      preparedAt: Date.parse(this.now()) / 1000,
    })
    return { goal: validated.goal, plan: prepared }
  }

  async bindApprovedPlan(
    input: BindApprovedPlanInput,
  ): Promise<GoalPlanBindingResult> {
    const goalId = requiredId(input.goalId, 'Goal')
    const planId = requiredId(input.planId, 'Plan')
    return this.mutex.run(goalId, async () => {
      const goal = await this.goalStore.get(goalId)
      if (!goal) throw new Error('Goal does not exist')
      let plan = this.planStore.get(planId)
      if (!plan) throw new Error('Plan does not exist')
      if (this.goalIsExactlyBound(goal, plan)) {
        this.assertApprovalProvenance(goal, plan, { allowQuarantine: true })
        plan = this.ensureGoalPlanTasks(plan)
        this.clearBoundApprovalQuarantine(plan.id)
        return { goal, plan: this.planStore.get(plan.id) ?? plan }
      }

      // Pure identity/scope/generation validation must finish before any
      // quarantine or compensation mutation is allowed.
      this.assertBindable(goal, plan)
      // Foreground Plans do not create persistent step Tasks. Goal execution
      // is a durable coordinator workflow, so GoalPlanBridge owns the task
      // projection and creates it only after Goal scope/provenance validation.
      plan = this.ensureGoalPlanTasks(plan)
      plan = this.planStore.prepareApprovalQuarantine({
        planId: plan.id,
        goalId: goal.id,
        interactionId: plan.sourceInteractionId!,
        approvalGeneration: Number(plan.metadata.approval_generation),
        preparedAt: Date.parse(this.now()) / 1000,
      })
      const updatedAt = this.now()
      const next = assertGoalTransition(goal, {
        ...goal,
        runtime: {
          ...goal.runtime,
          phase:
            goal.runtime.phase === 'awaiting_user'
              ? 'awaiting_user'
              : 'executing',
          currentPlanId: plan.id,
        },
        updatedAt,
      })
      try {
        const bound = await this.goalStore.append(goal.id, {
          type: 'goal_updated',
          record: next,
          createdAt: updatedAt,
          expectedLastEventSeq: goal.lastEventSeq,
          data: {
            planBinding: {
              goalId: goal.id,
              planId: plan.id,
              approvalGeneration: Number(
                plan.metadata.approval_generation ?? 0,
              ),
              sourceInteractionId: plan.sourceInteractionId,
            },
          },
        })
        this.clearBoundApprovalQuarantine(plan.id)
        return { goal: bound, plan: this.planStore.get(plan.id) ?? plan }
      } catch (cause) {
        const freshGoal = await this.goalStore.get(goal.id)
        const freshPlan = this.planStore.get(plan.id) ?? plan
        if (freshGoal && this.goalIsExactlyBound(freshGoal, freshPlan)) {
          this.assertApprovalProvenance(freshGoal, freshPlan, {
            allowQuarantine: true,
          })
          this.clearBoundApprovalQuarantine(freshPlan.id)
          return {
            goal: freshGoal,
            plan: this.planStore.get(freshPlan.id) ?? freshPlan,
          }
        }
        try {
          this.compensateFailedBinding(planId)
        } catch (compensationCause) {
          throw new AggregateError(
            [cause, compensationCause],
            'Goal Plan binding failed and compensation remains quarantined.',
          )
        }
        throw cause
      }
    })
  }

  abortFailedApproval(input: BindApprovedPlanInput): void {
    const goalId = requiredId(input.goalId, 'Goal')
    const planId = requiredId(input.planId, 'Plan')
    const plan = this.planStore.get(planId)
    const intent = planApprovalIntent(plan)
    if (!plan || plan.goalId !== goalId || !intent || intent.goalId !== goalId)
      throw new Error('Goal Plan approval abort ownership is invalid')
    this.compensateFailedBinding(planId)
  }

  async recoverQuarantinedApprovals(): Promise<number> {
    let recovered = 0
    const candidates = new Set(this.planStore.listQuarantined())
    for (const plan of this.planStore.list()) {
      if (
        plan.goalId &&
        (plan.status === PlanStatus.APPROVED ||
          plan.status === PlanStatus.EXECUTING)
      )
        candidates.add(plan.id)
    }
    for (const planId of candidates) {
      const plan = this.planStore.get(planId)
      if (!plan) {
        this.planStore.clearApprovalQuarantine(planId)
        recovered += 1
        continue
      }
      const intent = planApprovalIntent(plan)
      if (plan.status === PlanStatus.WAITING_APPROVAL && intent) {
        this.planStore.clearApprovalQuarantine(plan.id)
        recovered += 1
        continue
      }
      if (
        plan.status !== PlanStatus.APPROVED &&
        plan.status !== PlanStatus.EXECUTING
      ) {
        if (this.planStore.isQuarantined(plan.id)) {
          this.planStore.clearApprovalQuarantine(plan.id)
          recovered += 1
        }
        continue
      }
      const goal = plan.goalId ? await this.goalStore.get(plan.goalId) : null
      if (
        goal &&
        this.approvedPlanProvenanceMatches(goal, plan, {
          allowQuarantine: true,
        })
      ) {
        this.assertApprovalProvenance(goal, plan, { allowQuarantine: true })
        if (this.planStore.isQuarantined(plan.id)) {
          this.planStore.clearApprovalQuarantine(plan.id)
          recovered += 1
        }
        continue
      }
      this.planStore.quarantine(plan.id, 'goal_plan_compensation_required', {
        goal_id: plan.goalId,
      })
      if (this.compensateFailedBinding(plan.id)) recovered += 1
    }
    return recovered
  }

  async skipStepWithWaiver(
    input: SkipPlanStepWithWaiverInput,
  ): Promise<PlanRecord> {
    const goalId = requiredId(input.goalId, 'Goal')
    const planId = requiredId(input.planId, 'Plan')
    const stepId = requiredId(input.stepId, 'Plan step')
    return GLOBAL_SKIP_MUTEX.run(
      `${this.planStore.root}:${planId}`,
      async () => {
        let plan = this.planStore.get(planId)
        if (!plan) throw new Error('Plan does not exist')
        const existingIntent = planSkipIntent(plan)
        if (existingIntent && existingIntent.stage !== 'completed') {
          await this.recoverSkip(plan.id)
          plan = this.planStore.get(plan.id)!
          if (
            existingIntent.goalId === goalId &&
            existingIntent.stepId === stepId
          )
            return plan
        } else if (
          existingIntent?.stage === 'completed' &&
          existingIntent.goalId === goalId &&
          existingIntent.stepId === stepId
        ) {
          await this.durableSkipGoal(plan, existingIntent)
          return plan
        }
        const goal = await this.goalStore.get(goalId)
        if (
          !goal ||
          goal.status !== 'active' ||
          goal.runtime.phase !== 'executing'
        )
          throw new Error('Goal is not actively executing')
        if (goal.runtime.currentPlanId !== planId)
          throw new Error('Plan is not the current Goal Plan')
        plan = this.planStore.get(planId)
        if (!plan) throw new Error('Plan does not exist')
        this.assertApprovalProvenance(goal, plan)
        if (
          plan.status !== PlanStatus.APPROVED &&
          plan.status !== PlanStatus.EXECUTING
        )
          throw new Error('Plan is not executable')
        const step = plan.steps.find((candidate) => candidate.id === stepId)
        if (!step) throw new Error('Plan step does not exist')
        if (step.status !== PlanStepStatus.ACTIVE)
          throw new Error(`plan step ${stepId} must be active before skip`)
        const waiver = await this.resolveTrustedStepWaiver(goal, plan, step)
        if (!waiver) throw new Error('Trusted Plan step waiver is required')
        const intent: PlanSkipIntent = {
          version: 1,
          goalId,
          planId,
          approvalGeneration: Number(plan.metadata.approval_generation),
          stepId,
          receiptId: waiver.receiptId,
          startedAt: Date.parse(this.now()) / 1000,
          stage: 'intent_persisted',
        }
        this.planStore.save({
          ...plan,
          metadata: {
            ...plan.metadata,
            goal_skip_intent: skipIntentToDict(intent),
          },
        })
        await this.recoverSkip(plan.id)
        return this.planStore.get(plan.id)!
      },
    )
  }

  async recoverIncompleteSkips(): Promise<GoalPlanSkipRecoveryResult> {
    const candidates = this.planStore
      .list()
      .map((plan) => ({ plan, intent: planSkipIntent(plan) }))
      .filter(
        (item): item is { plan: PlanRecord; intent: PlanSkipIntent } =>
          item.intent !== null && item.intent.stage !== 'completed',
      )
      .sort((left, right) => left.intent.startedAt - right.intent.startedAt)
    const bySession = new Map<
      string,
      { plan: PlanRecord; intent: PlanSkipIntent }
    >()
    for (const candidate of candidates) {
      const goal = await this.currentSkipRecoveryGoal(
        candidate.plan,
        candidate.intent,
      )
      if (!goal) continue
      const sessionId = candidate.plan.sessionId
      if (!sessionId) continue
      const existing = bySession.get(sessionId)
      if (!existing || compareSkipRecoveryCandidate(candidate, existing) > 0)
        bySession.set(sessionId, candidate)
    }
    let recovered = 0
    const selected = [...bySession.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )
    for (const [, candidate] of selected) {
      const changed = await GLOBAL_SKIP_MUTEX.run(
        `${this.planStore.root}:${candidate.plan.id}`,
        async () => this.recoverSkip(candidate.plan.id),
      )
      if (!changed) continue
      recovered += 1
    }
    return { count: recovered }
  }

  private async recoverSkip(planId: string): Promise<boolean> {
    let plan = this.planStore.get(planId)
    if (!plan) return false
    let intent = planSkipIntent(plan)
    if (!intent || intent.stage === 'completed') return false
    await this.durableSkipGoal(plan, intent)

    if (skipStageBefore(intent.stage, 'plan_skipped')) {
      const stepId = intent.stepId
      const step = plan.steps.find((candidate) => candidate.id === stepId)
      if (!step || step.status !== PlanStepStatus.ACTIVE)
        throw new Error('durable Goal Plan skip step is not active')
      let updated = new PlanExecutionState(plan).skipStepWithWaiver(
        stepId,
        skipIntentWaiver(intent),
      )
      if (updated.status === PlanStatus.EXECUTING) {
        updated = new PlanExecutionState(updated, {
          isSkippedDependencyWaived: (candidate) =>
            storedSkipWaiverMatches(updated, candidate),
        }).startNextStep()
      }
      plan = this.planStore.save({
        ...updated,
        metadata: {
          ...updated.metadata,
          goal_skip_intent: skipIntentToDict({
            ...intent,
            stage: 'plan_skipped',
          }),
        },
      })
      intent = planSkipIntent(plan)!
    }

    if (skipStageBefore(intent.stage, 'tasks_synced')) {
      const mapping = this.syncSkipTasks(plan)
      plan = this.planStore.save({
        ...plan,
        metadata: {
          ...plan.metadata,
          plan_step_tasks: mapping,
          goal_skip_intent: skipIntentToDict({
            ...intent,
            stage: 'tasks_synced',
          }),
        },
      })
      intent = planSkipIntent(plan)!
    }

    if (skipStageBefore(intent.stage, 'todo_synced')) {
      plan = this.persistSkipStage(plan, 'todo_synced')
      intent = planSkipIntent(plan)!
    }

    if (skipStageBefore(intent.stage, 'completed'))
      this.persistSkipStage(plan, 'completed')
    return true
  }

  private async durableSkipGoal(
    plan: PlanRecord,
    intent: PlanSkipIntent,
  ): Promise<GoalRecord> {
    const goal = await this.currentSkipRecoveryGoal(plan, intent)
    if (!goal) throw new Error('durable Goal Plan skip binding is invalid')
    return goal
  }

  private async currentSkipRecoveryGoal(
    plan: PlanRecord,
    intent: PlanSkipIntent,
  ): Promise<GoalRecord | null> {
    const goal = await this.goalStore.get(intent.goalId)
    if (
      !goal ||
      goal.status !== 'active' ||
      goal.runtime.phase !== 'executing' ||
      goal.runtime.currentPlanId !== plan.id ||
      plan.goalId !== goal.id ||
      !planMatchesGoalScope(plan, goal) ||
      Number(plan.metadata.approval_generation) !== intent.approvalGeneration ||
      latestGoalApproval(this.planStore, goal)?.id !== plan.id
    )
      return null
    return goal
  }

  async requestReplan(input: RequestReplanInput): Promise<GoalReplanResult> {
    const goalId = requiredId(input.goalId, 'Goal')
    const reason = text(input.reason)
    if (!reason) throw new Error('replan reason is required')
    return GLOBAL_REPLAN_MUTEX.run(
      `${this.planStore.root}:${goalId}`,
      async () => {
        let goal = await this.goalStore.get(goalId)
        if (!goal) throw new Error('Goal does not exist')
        const activeIntents = this.planStore
          .list()
          .map((plan) => ({ plan, intent: replanIntent(plan) }))
          .filter(
            (item): item is { plan: PlanRecord; intent: ReplanIntent } =>
              item.plan.goalId === goalId &&
              item.intent !== null &&
              item.intent.stage !== 'completed' &&
              item.intent.stage !== 'aborted',
          )
          .sort((left, right) => left.intent.startedAt - right.intent.startedAt)
        if (activeIntents.length > 1)
          throw new Error('Goal Plan replan recovery is required')
        if (activeIntents.length === 1) {
          const active = activeIntents[0]!
          await this.recoverReplan(active.plan.id)
          return this.replanResult(active.plan.id)
        }
        if (goal.status !== 'active' || goal.runtime.phase !== 'executing')
          throw new Error('Goal is not executing and cannot be replanned')
        const previousPlanId = goal.runtime.currentPlanId
        if (!previousPlanId)
          throw new Error('Goal has no current Plan to replan')
        const previous = this.planStore.get(previousPlanId)
        if (!previous) throw new Error('Goal current Plan does not exist')
        if (this.planStore.isExecutionBlocked(previous.id))
          throw new Error('Goal current Plan recovery is incomplete')
        if (
          previous.goalId !== goal.id ||
          !planMatchesGoalScope(previous, goal)
        )
          throw new Error('Goal current Plan binding or scope is invalid')
        if (
          previous.status !== PlanStatus.APPROVED &&
          previous.status !== PlanStatus.EXECUTING
        )
          throw new Error('Goal current Plan is not executable')

        const nextId = `plan_${randomUUID().replace(/-/g, '').slice(0, 12)}`
        const changedAt = this.now()
        const changedAtSeconds = Date.parse(changedAt) / 1000
        const intent: ReplanIntent = {
          version: 1,
          goalId: goal.id,
          predecessorPlanId: previous.id,
          successorPlanId: nextId,
          requestReason: reason.slice(0, 1000),
          startedAt: changedAtSeconds,
          stage: 'intent_persisted',
        }
        const taskMap = planStepTaskMap(previous)
        const revokedMetadata = metadataWithoutPlanPermissionTokens(
          previous.metadata,
          { reason: `replan requested: ${reason}` },
        )
        revokedMetadata.plan_step_tasks_revoked = taskMap
        revokedMetadata.plan_step_tasks = {}
        revokedMetadata.replan_started = {
          reason: reason.slice(0, 1000),
          started_at: changedAtSeconds,
          successor_plan_id: nextId,
        }
        revokedMetadata.replan_intent = replanIntentToDict(intent)
        this.planStore.save({
          ...previous,
          updatedAt: changedAtSeconds,
          metadata: revokedMetadata,
        })
        await this.notifyReplanStage('intent_persisted')
        await this.recoverReplan(previous.id, { notifyStages: true })
        goal = (await this.goalStore.get(goalId)) ?? goal
        return this.replanResult(previous.id, goal)
      },
    )
  }

  async recoverIncompleteReplans(): Promise<number> {
    const candidates = this.planStore
      .list()
      .map((plan) => ({ plan, intent: replanIntent(plan) }))
      .filter(
        (item): item is { plan: PlanRecord; intent: ReplanIntent } =>
          item.intent !== null &&
          item.intent.stage !== 'completed' &&
          item.intent.stage !== 'aborted',
      )
      .sort((left, right) => left.intent.startedAt - right.intent.startedAt)
    let recovered = 0
    for (const candidate of candidates) {
      const changed = await GLOBAL_REPLAN_MUTEX.run(
        `${this.planStore.root}:${candidate.intent.goalId}`,
        async () => this.recoverReplan(candidate.plan.id),
      )
      if (changed) recovered += 1
    }
    return recovered
  }

  private async recoverReplan(
    predecessorPlanId: string,
    opts: { notifyStages?: boolean } = {},
  ): Promise<boolean> {
    let predecessor = this.planStore.get(predecessorPlanId)
    if (!predecessor) return false
    let intent = replanIntent(predecessor)
    if (!intent || intent.stage === 'completed' || intent.stage === 'aborted')
      return false
    let goal = await this.goalStore.get(intent.goalId)
    if (
      !goal ||
      predecessor.goalId !== goal.id ||
      intent.predecessorPlanId !== predecessor.id ||
      !planMatchesGoalScope(predecessor, goal)
    )
      throw new Error('durable replan intent binding or scope is invalid')

    if (replanStageBefore(intent.stage, 'tasks_cancelled')) {
      const taskMap = revokedPlanStepTaskMap(predecessor)
      for (const taskId of Object.values(taskMap))
        this.taskManager?.cancelTask(taskId, {
          reason: 'Plan superseded during durable replan recovery',
        })
      predecessor = this.persistReplanStage(predecessor, 'tasks_cancelled')
      intent = replanIntent(predecessor)!
      if (opts.notifyStages) await this.notifyReplanStage('tasks_cancelled')
    }

    if (replanStageBefore(intent.stage, 'predecessor_cancelled')) {
      const cancelledMetadata = {
        ...predecessor.metadata,
        superseded_by: intent.successorPlanId,
        superseded_at: intent.startedAt,
        superseded_reason: intent.requestReason,
        replan_intent: replanIntentToDict({
          ...intent,
          stage: 'predecessor_cancelled',
        }),
      }
      predecessor = this.planStore.save({
        ...predecessor,
        status: PlanStatus.CANCELLED,
        metadata: cancelledMetadata,
      })
      intent = replanIntent(predecessor)!
      if (opts.notifyStages)
        await this.notifyReplanStage('predecessor_cancelled')
    }

    let successor = this.planStore.get(intent.successorPlanId)
    if (replanStageBefore(intent.stage, 'successor_created')) {
      if (successor === null)
        successor = this.planStore.save(
          this.successorForIntent(predecessor, intent),
        )
      predecessor = this.persistReplanStage(predecessor, 'successor_created')
      intent = replanIntent(predecessor)!
      if (opts.notifyStages) await this.notifyReplanStage('successor_created')
    }
    successor = this.planStore.get(intent.successorPlanId)
    if (
      !successor ||
      successor.goalId !== goal.id ||
      successor.supersedesPlanId !== predecessor.id ||
      successor.status !== PlanStatus.DRAFT ||
      !plansShareFullGoalScope(predecessor, successor)
    )
      throw new Error('durable replan successor binding or scope is invalid')

    goal = (await this.goalStore.get(goal.id)) ?? goal
    if (replanStageBefore(intent.stage, 'goal_updated')) {
      if (
        goal.status !== 'active' ||
        (goal.runtime.phase !== 'executing' &&
          goal.runtime.phase !== 'planning') ||
        (goal.runtime.currentPlanId !== predecessor.id &&
          goal.runtime.currentPlanId !== successor.id)
      )
        throw new Error('durable replan Goal pointer conflicts with recovery')
      if (
        goal.runtime.phase !== 'planning' ||
        goal.runtime.currentPlanId !== successor.id
      ) {
        const changedAt = this.now()
        const nextGoal = assertGoalTransition(goal, {
          ...goal,
          runtime: {
            ...goal.runtime,
            phase: 'planning',
            currentRunId: null,
            currentPlanId: successor.id,
            pendingInteractionId: null,
            pauseReason: null,
          },
          updatedAt: changedAt,
        })
        try {
          goal = await this.goalStore.append(goal.id, {
            type: 'goal_updated',
            record: nextGoal,
            createdAt: changedAt,
            expectedLastEventSeq: goal.lastEventSeq,
            data: {
              planReplanRecovery: {
                goalId: goal.id,
                previousPlanId: predecessor.id,
                planId: successor.id,
              },
            },
          })
        } catch (cause) {
          const fresh = await this.goalStore.get(goal.id)
          if (
            !fresh ||
            fresh.status !== 'active' ||
            fresh.runtime.phase !== 'planning' ||
            fresh.runtime.currentPlanId !== successor.id
          )
            throw cause
          goal = fresh
        }
      }
      predecessor = this.persistReplanStage(predecessor, 'goal_updated')
      intent = replanIntent(predecessor)!
      if (opts.notifyStages) await this.notifyReplanStage('goal_updated')
    }
    if (replanStageBefore(intent.stage, 'completed'))
      this.persistReplanStage(predecessor, 'completed')
    return true
  }

  private persistReplanStage(
    predecessor: PlanRecord,
    stage: ReplanIntentStage,
  ): PlanRecord {
    const fresh = this.planStore.get(predecessor.id)
    if (!fresh) throw new Error('durable replan predecessor is missing')
    const intent = replanIntent(fresh)
    if (!intent) throw new Error('durable replan intent is missing')
    if (!replanStageBefore(intent.stage, stage)) return fresh
    return this.planStore.save({
      ...fresh,
      metadata: {
        ...fresh.metadata,
        replan_intent: replanIntentToDict({ ...intent, stage }),
      },
    })
  }

  private async replanResult(
    predecessorPlanId: string,
    knownGoal?: GoalRecord,
  ): Promise<GoalReplanResult> {
    const previous = this.planStore.get(predecessorPlanId)
    if (!previous) throw new Error('Goal Plan replan predecessor is missing')
    const intent = replanIntent(previous)
    if (!intent || intent.stage !== 'completed')
      throw new Error('Goal Plan replan recovery is incomplete')
    const plan = this.planStore.get(intent.successorPlanId)
    const goal = knownGoal ?? (await this.goalStore.get(intent.goalId))
    if (
      !plan ||
      !goal ||
      goal.status !== 'active' ||
      goal.runtime.phase !== 'planning' ||
      goal.runtime.currentPlanId !== plan.id ||
      plan.goalId !== goal.id ||
      plan.supersedesPlanId !== previous.id
    )
      throw new Error('Goal Plan replan recovery result is invalid')
    return { goal, plan, previousPlan: previous }
  }

  private successorForIntent(
    predecessor: PlanRecord,
    intent: ReplanIntent,
  ): PlanRecord {
    return makePlanRecord({
      id: intent.successorPlanId,
      title: `Replan: ${predecessor.title}`.slice(0, 160),
      summary: intent.requestReason.slice(0, 1200),
      status: PlanStatus.DRAFT,
      createdAt: intent.startedAt,
      updatedAt: intent.startedAt,
      sessionId: predecessor.sessionId,
      goalId: intent.goalId,
      supersedesPlanId: predecessor.id,
      draft: emptyDraft(),
      metadata: {
        risk_level: predecessor.metadata.risk_level ?? 'medium',
        scope: cloneRecord(predecessor.metadata.scope),
        approval_generation: 0,
        replan_reason: intent.requestReason,
        replan_requested_at: intent.startedAt,
      },
    })
  }

  private async notifyReplanStage(stage: ReplanIntentStage): Promise<void> {
    if (!this.afterReplanStage) return
    try {
      await this.afterReplanStage(stage)
    } catch (cause) {
      throw new ReplanInterruptionError(cause)
    }
  }

  async currentPlanAssessment(
    goalIdInput: string,
    knownGoal?: GoalRecord | null,
  ): Promise<GoalPlanAssessment> {
    return (await this.assessCurrentPlan(goalIdInput, knownGoal)).assessment
  }

  async planCompletionReceipt(
    goalIdInput: string,
    knownGoal?: GoalRecord | null,
  ): Promise<GoalPlanCompletionReceipt> {
    const evaluated = await this.assessCurrentPlan(goalIdInput, knownGoal)
    const { goal, plan, assessment, waivers } = evaluated
    const invalidReasons: string[] = []
    if (assessment.status !== 'completed')
      appendUnique(invalidReasons, `plan_${assessment.status}`)
    if (!assessment.scopeMatches) appendUnique(invalidReasons, 'scope_mismatch')
    if (assessment.incompleteStepIds.length)
      appendUnique(invalidReasons, 'plan_step_incomplete')
    if (assessment.failedStepIds.length)
      appendUnique(invalidReasons, 'plan_step_failed')
    if (assessment.skippedWithoutWaiverIds.length)
      appendUnique(invalidReasons, 'plan_step_skipped_without_waiver')
    const quarantine = plan
      ? this.planStore.inspectQuarantine(plan.id)
      : { quarantined: false, issue: null }
    const executionBlocked = quarantine.quarantined || quarantine.issue !== null
    const hasIncompleteIntent = plan ? hasIncompletePlanIntent(plan) : false
    if (executionBlocked) appendUnique(invalidReasons, 'plan_execution_blocked')
    if (hasIncompleteIntent)
      appendUnique(invalidReasons, 'plan_intent_incomplete')

    const steps: GoalPlanStepReceipt[] = []
    for (const step of plan?.steps ?? []) {
      const waived = waivers.get(step.id) ?? null
      const blockingErrors: string[] = []
      if (waived === null) {
        const required = requirementsForStep(step).filter(
          (item) => item.required,
        )
        if (required.length === 0)
          blockingErrors.push('missing required typed verification requirement')
        for (const requirement of required) {
          const fact = await this.resolveTrustedStepVerification(
            goal,
            plan,
            step,
            requirement,
          )
          if (!fact)
            blockingErrors.push(
              `${requirement.id} missing trusted Core verification fact`,
            )
        }
      }
      const requiredVerificationComplete =
        waived !== null || blockingErrors.length === 0
      if (!requiredVerificationComplete)
        appendUnique(invalidReasons, 'required_verification_incomplete')
      steps.push({
        id: step.id,
        status: step.status,
        requiredVerificationComplete,
        verificationBlockingErrors: blockingErrors,
        waiverReceiptId: waived?.receiptId ?? null,
      })
    }

    const reviewer = await this.resolveReviewerReceipt(goal, plan)
    if (!reviewer.satisfied) appendUnique(invalidReasons, 'reviewer_incomplete')

    const supersessionChain = plan
      ? this.supersededPlanReceipts(plan)
      : { receipts: [], valid: true }
    if (!supersessionChain.valid)
      appendUnique(invalidReasons, 'supersession_chain_invalid')

    const base: Omit<GoalPlanCompletionReceipt, 'integritySha256'> = {
      goalId: goal?.id ?? requiredId(goalIdInput, 'Goal'),
      planId: plan?.id ?? assessment.planId,
      completed: invalidReasons.length === 0,
      assessmentStatus: assessment.status,
      scopeMatches: assessment.scopeMatches,
      planEventSeq: plan?.eventSeq ?? 0,
      invalidReasons,
      steps,
      reviewer,
      supersededPlans: supersessionChain.receipts,
      executionBlocked,
      hasIncompleteIntent,
      approvalGeneration: Math.max(
        0,
        Math.trunc(Number(plan?.metadata.approval_generation ?? 0)),
      ),
    }
    return {
      ...base,
      integritySha256: computeGoalPlanCompletionReceiptIntegrity(base),
    }
  }

  private async assessCurrentPlan(
    goalIdInput: string,
    knownGoal?: GoalRecord | null,
  ): Promise<{
    goal: GoalRecord | null
    plan: PlanRecord | null
    assessment: GoalPlanAssessment
    waivers: Map<string, PlanStepWaiverFact>
  }> {
    const goalId = requiredId(goalIdInput, 'Goal')
    const goal =
      knownGoal === undefined ? await this.goalStore.get(goalId) : knownGoal
    const planId = goal?.runtime.currentPlanId ?? null
    const inspected = planId
      ? this.planStore.inspectIncludingArchive(planId)
      : { record: null, issue: null }
    if (inspected.issue)
      throw new Error(
        `Goal Plan readonly inspection failed: ${inspected.issue.code}`,
      )
    const catalog = this.planStore.inspectAllIncludingArchives()
    if (catalog.issue)
      throw new Error(
        `Goal Plan readonly inspection failed: ${catalog.issue.code}`,
      )
    const plan = inspected.record
    const waivers = new Map<string, PlanStepWaiverFact>()
    if (!goal || !planId || !plan) {
      return {
        goal,
        plan,
        waivers,
        assessment: {
          goalId,
          planId,
          status: 'missing',
          incompleteStepIds: [],
          failedStepIds: [],
          skippedWithoutWaiverIds: [],
          scopeMatches: false,
        },
      }
    }

    for (const step of plan.steps) {
      if (step.status !== PlanStepStatus.SKIPPED) continue
      const waiver = await this.resolveTrustedStepWaiver(goal, plan, step)
      if (waiver) waivers.set(step.id, waiver)
    }
    const quarantine = this.planStore.inspectQuarantine(plan.id)
    if (quarantine.issue)
      throw new Error(
        `Goal Plan readonly inspection failed: ${quarantine.issue.code}`,
      )
    const scopeMatches =
      !quarantine.quarantined &&
      !hasIncompletePlanIntent(plan) &&
      plan.goalId === goal.id &&
      planMatchesGoalScope(plan, goal)
    const failedStepIds = plan.steps
      .filter((step) => step.status === PlanStepStatus.FAILED)
      .map((step) => step.id)
    const skippedWithoutWaiverIds = plan.steps
      .filter(
        (step) =>
          step.status === PlanStepStatus.SKIPPED && !waivers.has(step.id),
      )
      .map((step) => step.id)
    const incompleteStepIds = plan.steps
      .filter(
        (step) =>
          step.status !== PlanStepStatus.DONE &&
          !(step.status === PlanStepStatus.SKIPPED && waivers.has(step.id)),
      )
      .map((step) => step.id)
    const topologyErrors = plan.steps.length
      ? planTopologyErrors(plan.steps, (step) => waivers.has(step.id))
      : ['plan has no steps']
    let status: GoalPlanAssessment['status']
    if (!scopeMatches || topologyErrors.length) status = 'invalid'
    else if (
      plan.status === PlanStatus.DRAFT ||
      plan.status === PlanStatus.WAITING_APPROVAL
    )
      status = 'waiting_approval'
    else if (
      plan.status === PlanStatus.APPROVED ||
      plan.status === PlanStatus.EXECUTING
    )
      status = 'executing'
    else if (
      plan.status === PlanStatus.COMPLETED &&
      this.approvedPlanProvenanceMatches(goal, plan, {
        readonlyPlans: catalog.records,
        readonlyQuarantined: quarantine.quarantined,
      }) &&
      incompleteStepIds.length === 0 &&
      failedStepIds.length === 0 &&
      skippedWithoutWaiverIds.length === 0
    )
      status = 'completed'
    else status = 'invalid'
    return {
      goal,
      plan,
      waivers,
      assessment: {
        goalId: goal.id,
        planId: plan.id,
        status,
        incompleteStepIds,
        failedStepIds,
        skippedWithoutWaiverIds,
        scopeMatches,
      },
    }
  }

  private async resolveTrustedStepWaiver(
    goal: GoalRecord,
    plan: PlanRecord,
    step: PlanStep,
  ): Promise<PlanStepWaiverFact | null> {
    if (!this.resolveStepWaiver) return null
    const context = { goalId: goal.id, planId: plan.id, stepId: step.id }
    let fact: PlanStepWaiverFact | null
    try {
      fact = await this.resolveStepWaiver(context, { goal, plan })
    } catch {
      return null
    }
    if (
      !fact ||
      fact.kind !== 'explicit_user_plan_step_waiver' ||
      fact.issuedBy !== 'core' ||
      fact.approvedBy !== 'user' ||
      !text(fact.receiptId) ||
      fact.goalId !== context.goalId ||
      fact.planId !== context.planId ||
      fact.stepId !== context.stepId
    )
      return null
    return fact
  }

  private async resolveTrustedStepVerification(
    goal: GoalRecord | null,
    plan: PlanRecord | null,
    step: PlanStep,
    requirement: ReturnType<typeof requirementsForStep>[number],
  ): Promise<PlanStepVerificationFact | null> {
    if (!goal || !plan || !this.resolveStepVerification) return null
    const context: PlanStepVerificationContext = {
      goalId: goal.id,
      planId: plan.id,
      planEventSeq: plan.eventSeq,
      stepId: step.id,
      requirementId: requirement.id,
      requirementKind: requirement.kind,
      command: requirement.command,
    }
    let fact: PlanStepVerificationFact | null
    try {
      fact = await this.resolveStepVerification(context, { goal, plan })
    } catch {
      return null
    }
    return exactStepVerificationFact(fact, context) ? fact : null
  }

  private async resolveReviewerReceipt(
    goal: GoalRecord | null,
    plan: PlanRecord | null,
  ): Promise<GoalPlanReviewerReceipt> {
    let riskFact = null
    if (goal && plan && this.resolveReviewerRiskFact) {
      try {
        riskFact = await this.resolveReviewerRiskFact({
          goalId: goal.id,
          planId: plan.id,
          planEventSeq: plan.eventSeq,
        })
      } catch {
        riskFact = null
      }
    }
    const requirement = plan
      ? this.reviewerPolicy.requirementFor(plan, riskFact)
      : { required: false, riskSignals: [] as string[] }
    const riskSignals = [...requirement.riskSignals]
    const required = requirement.required
    if (!required)
      return {
        required: false,
        satisfied: true,
        waived: false,
        riskSignals,
        evidenceSource: null,
      }
    if (!goal || !plan || !this.resolveReviewer)
      return {
        required: true,
        satisfied: false,
        waived: false,
        riskSignals,
        evidenceSource: null,
      }
    const context: PlanReviewerContext = {
      goalId: goal.id,
      planId: plan.id,
      planEventSeq: plan.eventSeq,
    }
    let fact: PlanReviewerFact | null
    try {
      fact = await this.resolveReviewer(context)
    } catch {
      fact = null
    }
    const trusted = exactReviewerFact(fact, context)
    return {
      required: true,
      satisfied: trusted,
      waived: trusted && fact?.verdict === 'waived',
      riskSignals,
      evidenceSource: trusted ? fact!.kind : null,
    }
  }

  private approvedPlanProvenanceMatches(
    goal: GoalRecord,
    plan: PlanRecord,
    opts: {
      allowQuarantine?: boolean
      readonlyPlans?: readonly PlanRecord[]
      readonlyQuarantined?: boolean
    } = {},
  ): boolean {
    if (
      goal.status !== 'active' ||
      goal.runtime.currentPlanId !== plan.id ||
      plan.goalId !== goal.id ||
      !planMatchesGoalScope(plan, goal) ||
      plan.approvedAt === null ||
      !Number.isFinite(plan.approvedAt) ||
      !plan.sourceInteractionId ||
      isPlanInvalidated(plan)
    )
      return false
    if (
      !opts.allowQuarantine &&
      (opts.readonlyQuarantined ?? this.planStore.isExecutionBlocked(plan.id))
    )
      return false
    const approvalGeneration = Number(plan.metadata.approval_generation)
    if (!Number.isInteger(approvalGeneration) || approvalGeneration < 1)
      return false
    const latest = opts.readonlyPlans
      ? latestGoalApprovalFromPlans(opts.readonlyPlans, goal)
      : latestGoalApproval(this.planStore, goal)
    return latest?.id === plan.id
  }

  private syncSkipTasks(plan: PlanRecord): Record<string, string> {
    if (!this.taskManager)
      throw new Error('Task manager is required for durable Plan skip recovery')
    const approvalGeneration = Number(plan.metadata.approval_generation)
    const mapping = planStepTaskMap(plan)
    for (const [index, step] of plan.steps.entries()) {
      const desiredStatus =
        step.status === PlanStepStatus.SKIPPED
          ? TaskStatus.CANCELLED
          : taskStatusFromPlanStep(step.status)
      const terminal = new Set<string>([
        TaskStatus.COMPLETED,
        TaskStatus.FAILED,
        TaskStatus.CANCELLED,
      ])
      const exactCandidates = this.taskManager.store
        .list()
        .filter((task) =>
          taskMatchesPlanStep(task, plan.id, step.id, approvalGeneration),
        )
        .sort((left, right) => left.id.localeCompare(right.id))
      const mappedRecord = mapping[step.id]
        ? this.taskManager.store.get(mapping[step.id]!)
        : null
      const mapped =
        mappedRecord &&
        mappedRecord.metadata.plan_id === plan.id &&
        mappedRecord.metadata.plan_step_id === step.id
          ? mappedRecord
          : undefined
      const candidates = [
        ...(mapped ? [mapped] : []),
        ...exactCandidates.filter((task) => task.id !== mapped?.id),
      ]
      const needsLiveTask =
        desiredStatus === TaskStatus.RUNNING ||
        desiredStatus === TaskStatus.PENDING ||
        desiredStatus === TaskStatus.QUEUED
      let selected =
        (mapped && (!needsLiveTask || !terminal.has(mapped.status))
          ? mapped
          : undefined) ??
        candidates.find((task) => !needsLiveTask || !terminal.has(task.status))
      const metadata = {
        ...(selected?.metadata ?? {}),
        plan_id: plan.id,
        plan_step_id: step.id,
        approval_generation: approvalGeneration,
        sequence: index + 1,
      }
      if (!selected) {
        selected = this.taskManager.startTask({
          kind: TaskKind.PLAN_STEP,
          title: step.title,
          source: 'plan_step',
          status: desiredStatus,
          sessionId: plan.sessionId,
          metadata,
        })
      }
      if (desiredStatus === TaskStatus.CANCELLED) {
        if (
          selected.title !== step.title ||
          !taskMatchesPlanStep(selected, plan.id, step.id, approvalGeneration)
        ) {
          const updated = this.taskManager.updateTask(selected.id, {
            title: step.title,
            metadata,
          })
          if (!updated) throw new Error('Plan step task synchronization failed')
          selected = updated
        }
        if (selected.status !== TaskStatus.CANCELLED) {
          const cancelled = this.taskManager.cancelTask(selected.id, {
            reason: 'Goal Plan step skipped with explicit user waiver',
          })
          if (!cancelled)
            throw new Error('Skipped Plan step task cancellation failed')
          selected = cancelled
        }
      } else if (
        selected.status !== desiredStatus ||
        selected.title !== step.title ||
        !taskMatchesPlanStep(selected, plan.id, step.id, approvalGeneration)
      ) {
        const updated = this.taskManager.updateTask(selected.id, {
          status: desiredStatus,
          title: step.title,
          metadata,
        })
        if (!updated) throw new Error('Plan step task synchronization failed')
        selected = updated
      }
      mapping[step.id] = selected.id
      for (const duplicate of candidates) {
        if (duplicate.id === selected.id || terminal.has(duplicate.status))
          continue
        const cancelled = this.taskManager.cancelTask(duplicate.id, {
          reason: 'Duplicate Goal Plan step task reconciled during skip',
        })
        if (!cancelled)
          throw new Error('Duplicate Plan step task cancellation failed')
      }
    }
    return mapping
  }

  private ensureGoalPlanTasks(plan: PlanRecord): PlanRecord {
    const mapping = this.syncSkipTasks(plan)
    const current = planStepTaskMap(plan)
    if (
      Object.keys(mapping).length === Object.keys(current).length &&
      Object.entries(mapping).every(
        ([stepId, taskId]) => current[stepId] === taskId,
      )
    )
      return plan
    return this.planStore.save({
      ...plan,
      metadata: {
        ...plan.metadata,
        plan_step_tasks: mapping,
      },
    })
  }

  private persistSkipStage(
    plan: PlanRecord,
    stage: PlanSkipIntentStage,
  ): PlanRecord {
    const fresh = this.planStore.get(plan.id)
    if (!fresh) throw new Error('durable Goal Plan skip Plan is missing')
    const intent = planSkipIntent(fresh)
    if (!intent) throw new Error('durable Goal Plan skip intent is missing')
    if (!skipStageBefore(intent.stage, stage)) return fresh
    return this.planStore.save({
      ...fresh,
      metadata: {
        ...fresh.metadata,
        goal_skip_intent: skipIntentToDict({ ...intent, stage }),
      },
    })
  }

  private supersededPlanReceipts(plan: PlanRecord): {
    receipts: SupersededPlanReceipt[]
    valid: boolean
  } {
    const receipts: SupersededPlanReceipt[] = []
    const visited = new Set<string>([plan.id])
    let successor = plan
    let previousId = plan.supersedesPlanId
    let valid = true
    while (previousId && receipts.length < 120) {
      if (visited.has(previousId)) {
        valid = false
        receipts.push(
          missingSupersededPlanReceipt(previousId, 'cycle_detected'),
        )
        break
      }
      visited.add(previousId)
      const inspected = this.planStore.inspectIncludingArchive(previousId)
      const previous = inspected.record
      if (!previous || inspected.issue) {
        valid = false
        receipts.push(
          missingSupersededPlanReceipt(
            previousId,
            inspected.issue ? 'predecessor_corrupt' : 'predecessor_missing',
          ),
        )
        break
      }
      const invalidReason = supersessionLinkInvalidReason(previous, successor)
      if (invalidReason) valid = false
      receipts.push({
        planId: previous.id,
        status: previous.status,
        eventSeq: previous.eventSeq,
        supersededBy: nullableText(previous.metadata.superseded_by),
        chainValid: invalidReason === null,
        invalidReason,
        failure: stablePlanFailureSummary(previous),
      })
      successor = previous
      previousId = previous.supersedesPlanId
    }
    if (previousId && receipts.length >= 120) {
      valid = false
      const last = receipts.at(-1)
      if (last && last.chainValid)
        receipts[receipts.length - 1] = {
          ...last,
          chainValid: false,
          invalidReason: 'chain_too_deep',
        }
    }
    return { receipts, valid }
  }

  private assertBindable(goal: GoalRecord, plan: PlanRecord): void {
    if (!goalAcceptsPlanApproval(goal, plan.sourceInteractionId ?? ''))
      throw new Error('Goal does not own the pending Plan approval')
    if (
      goal.runtime.currentPlanId !== null &&
      goal.runtime.currentPlanId !== plan.id
    )
      throw new Error('Goal already points to a different current Plan')
    if (
      this.planStore.isQuarantined(plan.id) &&
      !approvalIntentMatches(planApprovalIntent(plan), {
        goalId: goal.id,
        planId: plan.id,
        interactionId: plan.sourceInteractionId ?? '',
        approvalGeneration: Number(plan.metadata.approval_generation),
      })
    )
      throw new Error('Plan is quarantined pending compensation')
    this.assertApprovalProvenance(goal, plan, { allowQuarantine: true })
  }

  private assertApprovalProvenance(
    goal: GoalRecord,
    plan: PlanRecord,
    opts: { allowQuarantine?: boolean } = {},
  ): void {
    if (!opts.allowQuarantine && this.planStore.isExecutionBlocked(plan.id))
      throw new Error('Plan is quarantined pending compensation')
    if (plan.goalId !== goal.id)
      throw new Error('Plan does not have the explicit Goal binding')
    if (
      plan.status !== PlanStatus.APPROVED &&
      plan.status !== PlanStatus.EXECUTING
    )
      throw new Error('Plan is not approved for execution')
    if (plan.approvedAt === null || !Number.isFinite(plan.approvedAt))
      throw new Error('Plan approval generation is invalid')
    if (!plan.sourceInteractionId)
      throw new Error('Plan approval generation has no source interaction')
    const approvalGeneration = Number(plan.metadata.approval_generation)
    if (!Number.isInteger(approvalGeneration) || approvalGeneration < 1)
      throw new Error('Plan approval generation is invalid')
    if (!planMatchesGoalScope(plan, goal))
      throw new Error('Plan scope does not match Goal scope')
    const latest = this.planStore
      .list()
      .filter(
        (candidate) =>
          candidate.goalId === goal.id && planMatchesGoalScope(candidate, goal),
      )
      .filter(
        (candidate) =>
          candidate.approvedAt !== null &&
          Number.isFinite(candidate.approvedAt),
      )
      .reduce<PlanRecord | null>(
        (current, candidate) =>
          current === null ||
          comparePlanApprovalGeneration(candidate, current) > 0
            ? candidate
            : current,
        null,
      )
    if (latest?.id !== plan.id)
      throw new Error('Plan is not the current approval generation')
  }

  private goalIsExactlyBound(goal: GoalRecord, plan: PlanRecord): boolean {
    return (
      (goal.runtime.phase === 'executing' ||
        goal.runtime.phase === 'awaiting_user') &&
      this.approvedPlanProvenanceMatches(goal, plan, {
        allowQuarantine: true,
      })
    )
  }

  private clearBoundApprovalQuarantine(planId: string): void {
    try {
      this.planStore.clearApprovalQuarantine(planId)
    } catch {
      // Both the durable Plan intent and sidecar are execution guards. If one
      // cannot be cleared after the Goal commit, startup recovery retries it.
    }
  }

  private compensateFailedBinding(planId: string): boolean {
    const failedAt = this.now()
    let quarantineFailure: unknown = null
    try {
      this.planStore.quarantine(planId, 'goal_plan_compensation_required')
    } catch (cause) {
      quarantineFailure = cause
    }
    const initial = this.planStore.get(planId)
    if (!initial) {
      try {
        this.planStore.clearApprovalQuarantine(planId)
      } catch {
        // Missing Plans have no execution authority even if cleanup is retried.
      }
      if (quarantineFailure) throw quarantineFailure
      return true
    }
    const taskIds = new Set(Object.values(planStepTaskMap(initial)))
    for (const task of this.taskManager?.store.list() ?? []) {
      if (String(task.metadata.plan_id ?? '') === planId) taskIds.add(task.id)
    }
    let planSaveFailures = 0
    let taskCancelFailures = 0
    const persistCancellation = (): boolean => {
      const fresh = this.planStore.get(planId)
      if (!fresh) return true
      const metadata = metadataWithoutPlanPermissionTokens(fresh.metadata, {
        reason: 'Goal binding failed',
      })
      metadata.goal_bind_failed = {
        code: 'goal_plan_bind_failed',
        failedAt,
        compensation: { planSaveFailures, taskCancelFailures },
      }
      try {
        this.planStore.save({
          ...fresh,
          status: PlanStatus.CANCELLED,
          updatedAt: Date.parse(failedAt) / 1000,
          metadata,
        })
        return true
      } catch {
        planSaveFailures += 1
        return false
      }
    }

    let persisted = persistCancellation()
    let tasksCancelled = true
    for (const taskId of taskIds) {
      let cancelled = false
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        try {
          this.taskManager?.cancelTask(taskId, {
            reason: 'Goal Plan binding failed',
          })
          cancelled = true
        } catch {
          taskCancelFailures += 1
        }
      }
      if (!cancelled) tasksCancelled = false
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      persisted = persistCancellation()
      if (persisted) break
    }
    if (persisted && tasksCancelled) {
      try {
        this.planStore.clearApprovalQuarantine(planId)
      } catch {
        return false
      }
      if (quarantineFailure) throw quarantineFailure
      return true
    }
    if (quarantineFailure) throw quarantineFailure
    return false
  }
}

function goalAcceptsPlanApproval(
  goal: GoalRecord,
  interactionId: string,
): boolean {
  if (goal.status !== 'active') return false
  if (goal.runtime.phase === 'planning') return true
  return (
    goal.runtime.phase === 'awaiting_user' &&
    goal.runtime.pendingInteractionId === interactionId
  )
}

export function computeGoalPlanCompletionReceiptIntegrity(
  receipt: Omit<GoalPlanCompletionReceipt, 'integritySha256'>,
): string {
  return createHash('sha256')
    .update(canonicalJson(receipt), 'utf8')
    .digest('hex')
}

export function verifyGoalPlanCompletionReceiptIntegrity(
  receipt: GoalPlanCompletionReceipt,
): boolean {
  const { integritySha256, ...base } = receipt
  return (
    /^[a-f0-9]{64}$/.test(integritySha256) &&
    computeGoalPlanCompletionReceiptIntegrity(base) === integritySha256
  )
}

function nullableText(value: unknown): string | null {
  const valueText = text(value)
  return valueText || null
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function requiredId(value: unknown, label: string): string {
  const id = text(value)
  if (!id) throw new Error(`${label} ID is required`)
  return id
}

function planStepTaskMap(plan: PlanRecord): Record<string, string> {
  return taskMapFromValue(plan.metadata.plan_step_tasks)
}

function revokedPlanStepTaskMap(plan: PlanRecord): Record<string, string> {
  const revoked = taskMapFromValue(plan.metadata.plan_step_tasks_revoked)
  return Object.keys(revoked).length ? revoked : planStepTaskMap(plan)
}

function taskMapFromValue(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([stepId, taskId]) => [stepId, text(taskId)] as const)
      .filter((entry) => entry[1]),
  )
}

const SKIP_STAGE_ORDER: Readonly<Record<PlanSkipIntentStage, number>> = {
  intent_persisted: 0,
  plan_skipped: 1,
  tasks_synced: 2,
  todo_synced: 3,
  completed: 4,
}

function skipStageBefore(
  current: PlanSkipIntentStage,
  target: PlanSkipIntentStage,
): boolean {
  return SKIP_STAGE_ORDER[current] < SKIP_STAGE_ORDER[target]
}

function skipIntentToDict(intent: PlanSkipIntent): Record<string, unknown> {
  return {
    version: intent.version,
    goal_id: intent.goalId,
    plan_id: intent.planId,
    approval_generation: intent.approvalGeneration,
    step_id: intent.stepId,
    receipt_id: intent.receiptId,
    started_at: intent.startedAt,
    stage: intent.stage,
  }
}

function skipIntentWaiver(intent: PlanSkipIntent): PlanStepWaiverFact {
  return {
    kind: 'explicit_user_plan_step_waiver',
    issuedBy: 'core',
    approvedBy: 'user',
    receiptId: intent.receiptId,
    goalId: intent.goalId,
    planId: intent.planId,
    stepId: intent.stepId,
  }
}

function hasIncompletePlanIntent(plan: PlanRecord): boolean {
  const approval = planApprovalIntent(plan)
  if (approval) return true
  if (plan.metadata.goal_skip_intent !== undefined) {
    const skip = planSkipIntent(plan)
    if (!skip || skip.stage !== 'completed') return true
  }
  if (plan.metadata.replan_intent !== undefined) {
    const replan = replanIntent(plan)
    if (!replan || (replan.stage !== 'completed' && replan.stage !== 'aborted'))
      return true
  }
  return false
}

function storedSkipWaiverMatches(plan: PlanRecord, step: PlanStep): boolean {
  return step.evidence.some(
    (item) =>
      item.source === 'goal_plan_step_waiver' &&
      item.issued_by === 'core' &&
      item.approved_by === 'user' &&
      text(item.receipt_id) !== '' &&
      item.goal_id === plan.goalId &&
      item.plan_id === plan.id &&
      item.plan_step_id === step.id,
  )
}

function taskMatchesPlanStep(
  task: TaskRecord,
  planId: string,
  stepId: string,
  approvalGeneration: number,
): boolean {
  return (
    task.metadata.plan_id === planId &&
    task.metadata.plan_step_id === stepId &&
    Number(task.metadata.approval_generation) === approvalGeneration
  )
}

interface ReplanIntent {
  readonly version: 1
  readonly goalId: string
  readonly predecessorPlanId: string
  readonly successorPlanId: string
  readonly requestReason: string
  readonly startedAt: number
  readonly stage: ReplanIntentStage
}

const REPLAN_STAGES = new Set<ReplanIntentStage>([
  'intent_persisted',
  'tasks_cancelled',
  'predecessor_cancelled',
  'successor_created',
  'goal_updated',
  'completed',
  'aborted',
])

const REPLAN_STAGE_ORDER: Readonly<Record<ReplanIntentStage, number>> = {
  intent_persisted: 0,
  tasks_cancelled: 1,
  predecessor_cancelled: 2,
  successor_created: 3,
  goal_updated: 4,
  completed: 5,
  aborted: 6,
}

function replanStageBefore(
  current: ReplanIntentStage,
  target: ReplanIntentStage,
): boolean {
  return REPLAN_STAGE_ORDER[current] < REPLAN_STAGE_ORDER[target]
}

function replanIntent(plan: PlanRecord): ReplanIntent | null {
  const value = plan.metadata.replan_intent
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const stage = text(raw.stage) as ReplanIntentStage
  const startedAt = Number(raw.started_at)
  const intent: ReplanIntent = {
    version: 1,
    goalId: text(raw.goal_id),
    predecessorPlanId: text(raw.predecessor_plan_id),
    successorPlanId: text(raw.successor_plan_id),
    requestReason: text(raw.request_reason).slice(0, 1000),
    startedAt,
    stage,
  }
  return Number(raw.version) === 1 &&
    intent.goalId &&
    intent.predecessorPlanId === plan.id &&
    intent.successorPlanId &&
    intent.requestReason &&
    Number.isFinite(startedAt) &&
    REPLAN_STAGES.has(stage)
    ? intent
    : null
}

function replanIntentToDict(intent: ReplanIntent): Record<string, unknown> {
  return {
    version: intent.version,
    goal_id: intent.goalId,
    predecessor_plan_id: intent.predecessorPlanId,
    successor_plan_id: intent.successorPlanId,
    request_reason: intent.requestReason,
    started_at: intent.startedAt,
    stage: intent.stage,
  }
}

class ReplanInterruptionError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : 'simulated interruption after durable replan stage',
      { cause },
    )
    this.name = 'ReplanInterruptionError'
  }
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...(value as Record<string, unknown>) }
}

function supersessionLinkInvalidReason(
  predecessor: PlanRecord,
  successor: PlanRecord,
): string | null {
  if (predecessor.goalId !== successor.goalId) return 'goal_mismatch'
  if (!plansShareFullGoalScope(predecessor, successor)) return 'scope_mismatch'
  if (predecessor.status !== PlanStatus.CANCELLED)
    return 'predecessor_not_cancelled'
  if (nullableText(predecessor.metadata.superseded_by) !== successor.id)
    return 'superseded_by_mismatch'
  return null
}

function missingSupersededPlanReceipt(
  planId: string,
  invalidReason: string,
): SupersededPlanReceipt {
  return {
    planId,
    status: 'missing',
    eventSeq: 0,
    supersededBy: null,
    chainValid: false,
    invalidReason,
    failure: null,
  }
}

function stablePlanFailureSummary(
  plan: PlanRecord,
): SupersededPlanReceipt['failure'] {
  if (plan.metadata.replan_failed)
    return {
      code: 'replan_failed',
      summary: 'Replan failed before Goal transition.',
    }
  if (plan.metadata.replan_aborted)
    return {
      code: 'replan_aborted',
      summary: 'Replan successor was cancelled during recovery.',
    }
  if (plan.metadata.goal_bind_failed)
    return {
      code: 'goal_plan_bind_failed',
      summary: 'Plan binding failed and execution was cancelled.',
    }
  return null
}

function exactStepVerificationFact(
  fact: PlanStepVerificationFact | null,
  context: PlanStepVerificationContext,
): boolean {
  return Boolean(
    fact &&
    fact.kind === 'core_plan_step_verification' &&
    fact.issuedBy === 'core' &&
    fact.verdict === 'pass' &&
    text(fact.receiptId) &&
    fact.goalId === context.goalId &&
    fact.planId === context.planId &&
    fact.planEventSeq === context.planEventSeq &&
    fact.stepId === context.stepId &&
    fact.requirementId === context.requirementId &&
    fact.requirementKind === context.requirementKind &&
    fact.command === context.command,
  )
}

function exactReviewerFact(
  fact: PlanReviewerFact | null,
  context: PlanReviewerContext,
): boolean {
  return Boolean(
    fact &&
    fact.kind === 'core_independent_plan_review' &&
    fact.issuedBy === 'core' &&
    (fact.verdict === 'pass' || fact.verdict === 'waived') &&
    text(fact.receiptId) &&
    fact.goalId === context.goalId &&
    fact.planId === context.planId &&
    fact.planEventSeq === context.planEventSeq &&
    (fact.verdict === 'waived' ||
      fact.commandEvidenceRefs.some((ref) => text(ref))),
  )
}

function latestGoalApproval(
  planStore: PlanStore,
  goal: GoalRecord,
): PlanRecord | null {
  return latestGoalApprovalFromPlans(planStore.list(), goal)
}

function latestGoalApprovalFromPlans(
  plans: readonly PlanRecord[],
  goal: GoalRecord,
): PlanRecord | null {
  return plans
    .filter(
      (candidate) =>
        candidate.goalId === goal.id && planMatchesGoalScope(candidate, goal),
    )
    .filter(
      (candidate) =>
        candidate.approvedAt !== null && Number.isFinite(candidate.approvedAt),
    )
    .reduce<PlanRecord | null>(
      (current, candidate) =>
        current === null ||
        comparePlanApprovalGeneration(candidate, current) > 0
          ? candidate
          : current,
      null,
    )
}

function compareSkipRecoveryCandidate(
  left: { plan: PlanRecord; intent: PlanSkipIntent },
  right: { plan: PlanRecord; intent: PlanSkipIntent },
): number {
  const generationDelta =
    left.intent.approvalGeneration - right.intent.approvalGeneration
  if (generationDelta !== 0) return generationDelta
  const approvalDelta =
    Number(left.plan.approvedAt ?? 0) - Number(right.plan.approvedAt ?? 0)
  if (approvalDelta !== 0) return approvalDelta
  const startedDelta = left.intent.startedAt - right.intent.startedAt
  if (startedDelta !== 0) return startedDelta
  const eventDelta = left.plan.eventSeq - right.plan.eventSeq
  if (eventDelta !== 0) return eventDelta
  return left.plan.id.localeCompare(right.plan.id)
}

function approvalIntentMatches(
  intent: PlanApprovalIntent | null,
  input: PreflightPlanApprovalInput,
): boolean {
  return Boolean(
    intent &&
    intent.goalId === input.goalId &&
    intent.interactionId === input.interactionId &&
    intent.approvalGeneration === input.approvalGeneration,
  )
}

function appendUnique(items: string[], item: string): void {
  if (!items.includes(item)) items.push(item)
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => tail)
    this.tails.set(key, queued)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.tails.get(key) === queued) this.tails.delete(key)
    }
  }
}

const GLOBAL_REPLAN_MUTEX = new KeyedMutex()
const GLOBAL_SKIP_MUTEX = new KeyedMutex()
