import { createHash } from 'node:crypto'
import { EmperorError } from '../errors'
import {
  independentVerificationRiskSignals,
  planChangedFiles,
} from '../control/plan-helpers'
import { parseReviewerVerdict } from '../plans/reviewer'
import type { PlanRecord } from '../plans/models'
import type { PlanStore } from '../plans/store'
import type { TaskManager } from '../tasks/manager'
import { TaskKind, TaskStatus, type TaskRecord } from '../tasks/models'
import type { TaskStore } from '../tasks/store'
import { SidechainTranscript } from '../tasks/sidechain'
import { newId } from '../util/ids'
import { relativePortable } from '../util/paths'
import { canonicalJson } from './events'
import type {
  GoalEvidence,
  GoalEvidenceLedger,
  GoalIndependentReviewerFact,
  GoalIndependentReviewerSource,
} from './evidence'
import { verifyObservationIntegrity, type GoalObservation } from './evidence'
import type {
  PlanReviewerContext,
  PlanReviewerFact,
} from './contracts/planning'
import { planMatchesGoalScope } from './scope'
import type { GoalRecord } from './models'
import type { GoalStore } from './store'
import { GoalStoreError } from './store'
import { assertGoalTransition } from './validation'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GOAL_REVIEWER_DISPATCH_SCHEMA_VERSION =
  'emperor.goal.reviewer-dispatch.v1' as const

export interface GoalReviewerRequirement {
  readonly required: boolean
  readonly riskSignals: readonly string[]
}

export interface GoalReviewerRiskFact {
  readonly kind: 'core_goal_reviewer_risk'
  readonly issuedBy: 'core'
  readonly version: string
  readonly goalId: string
  readonly planId: string
  readonly planEventSeq: number
  readonly readonlyProven: boolean
  readonly changedFiles: readonly string[]
  readonly capabilitySignals: readonly string[]
}

export interface GoalReviewerRiskContext {
  readonly goalId: string
  readonly planId: string
  readonly planEventSeq: number
  readonly currentReviewer?: {
    readonly taskId: string
    readonly agentId: string
    readonly binding: 'prospective' | 'dispatch_baseline' | 'receipt'
  } | null
}

export type GoalReviewerRiskFactResolver = (
  context: GoalReviewerRiskContext,
) => GoalReviewerRiskFact | null | Promise<GoalReviewerRiskFact | null>

export interface GoalReviewerReceipt {
  readonly id: string
  readonly goalId: string
  readonly planId: string
  readonly planEventSeq: number
  readonly verdict: 'pass' | 'fail'
  readonly riskSignals: readonly string[]
  readonly riskFactVersion?: string | null
  readonly taskId: string
  readonly dispatchReceiptId: string
  readonly dispatchOrdinal: number
  readonly agentId: string
  readonly transcriptRef: string
  readonly transcriptSha256: string
  readonly commandEvidenceIds: readonly string[]
  readonly commandObservationIds: readonly string[]
  readonly summary: string
  readonly createdAt: string
  readonly integritySha256: string
}

export interface GoalReviewerDispatchReceipt {
  readonly schemaVersion: typeof GOAL_REVIEWER_DISPATCH_SCHEMA_VERSION
  readonly id: string
  readonly dispatchOrdinal: number
  readonly taskId: string
  readonly agentId: string
  readonly turnId: string
  readonly goalId: string
  readonly planId: string
  readonly planEventSeq: number
  readonly approvalGeneration: number
  readonly riskSignals: readonly string[]
  readonly riskFactVersion: string | null
  readonly issuedBy: 'core'
  readonly createdAt: string
  readonly integritySha256: string
}

export interface DispatchGoalReviewerInput {
  readonly goalId: string
  readonly planId: string
  readonly planEventSeq: number
}

export interface GoalReviewerDispatch {
  readonly task: TaskRecord
  readonly receipt: GoalReviewerDispatchReceipt
}

export interface RecordReviewerReceiptInput {
  readonly goalId: string
  readonly planId: string
  readonly planEventSeq: number
  readonly taskId: string
}

export interface GoalReviewerWaiverActionContext {
  readonly goalId: string
  readonly planId: string
  readonly planEventSeq: number
  readonly interactionId: string
  readonly riskSignals: readonly string[]
  readonly riskFactVersion: string | null
}

export type RecordReviewerWaiverInput = Omit<
  GoalReviewerWaiverActionContext,
  'riskSignals' | 'riskFactVersion'
>

export interface GoalReviewerWaiverActionFact extends GoalReviewerWaiverActionContext {
  readonly kind: 'explicit_user_goal_reviewer_waiver_action'
  readonly issuedBy: 'core'
  readonly approvedBy: 'user'
  readonly verdict: 'waived'
}

export type GoalReviewerWaiverActionResolver = (
  context: GoalReviewerWaiverActionContext,
) =>
  | GoalReviewerWaiverActionFact
  | null
  | Promise<GoalReviewerWaiverActionFact | null>

export interface GoalReviewerWaiverReceipt {
  readonly id: string
  readonly goalId: string
  readonly planId: string
  readonly planEventSeq: number
  readonly verdict: 'waived'
  readonly riskSignals: readonly string[]
  readonly riskFactVersion?: string | null
  readonly interactionId: string
  readonly dispatchReceiptId: string
  readonly dispatchOrdinal: number
  readonly issuedBy: 'core'
  readonly approvedBy: 'user'
  readonly createdAt: string
  readonly integritySha256: string
}

export class GoalReviewerError extends EmperorError {
  constructor(code: string, message: string) {
    super(message, code)
  }
}

export class GoalReviewerPolicy {
  requirementFor(
    plan: PlanRecord,
    coreFact: GoalReviewerRiskFact | null = null,
  ): GoalReviewerRequirement {
    const declaredSignals = independentVerificationRiskSignals(
      plan,
      planChangedFiles(plan),
    )
    const trusted = exactRiskFact(coreFact, plan) ? coreFact : null
    const riskSignals = [...declaredSignals]
    if (trusted) {
      for (const signal of independentVerificationRiskSignals(plan, [
        ...trusted.changedFiles,
      ]))
        appendUnique(riskSignals, signal)
      if (trusted.changedFiles.length > 0)
        appendUnique(riskSignals, 'core_changed_files>=1')
      for (const capability of trusted.capabilitySignals)
        appendUnique(riskSignals, `core_capability:${capability}`)
      if (!trusted.readonlyProven)
        appendUnique(riskSignals, 'readonly_unproven')
    } else {
      appendUnique(riskSignals, 'readonly_unproven')
    }
    const canonical = canonicalRiskSignals(riskSignals)
    return deepFreeze({
      required: canonical.length > 0,
      riskSignals: canonical,
    })
  }
}

/** Resolves risk from the exact Goal/Plan scope and Core tool observations. */
export class GoalReviewerCoreRiskAdapter {
  constructor(
    private readonly planStore: PlanStore,
    private readonly goalStore: Pick<
      GoalStore,
      'readEventsReadonly' | 'readObservationsReadonly'
    >,
    private readonly taskStore: Pick<TaskStore, 'inspectIncludingArchive'>,
  ) {}

  async resolve(
    context: GoalReviewerRiskContext,
  ): Promise<GoalReviewerRiskFact | null> {
    const planInspection = this.planStore.inspectIncludingArchive(
      context.planId,
    )
    const quarantine = this.planStore.inspectQuarantine(context.planId)
    const plan = planInspection.record
    if (
      planInspection.issue ||
      quarantine.issue ||
      quarantine.quarantined ||
      !plan ||
      plan.id !== context.planId ||
      plan.goalId !== context.goalId ||
      plan.eventSeq !== context.planEventSeq
    )
      return null
    const goal = await readonlyGoalRecord(this.goalStore, context.goalId)
    if (
      !goal ||
      goal.status !== 'active' ||
      goal.runtime.currentPlanId !== plan.id ||
      !planMatchesGoalScope(plan, goal)
    )
      return null
    const observationRead =
      await this.goalStore.readObservationsReadonly<unknown>(goal.id)
    if (observationRead.badLines.length > 0) return null
    const currentReviewer = await this.resolveCurrentReviewer(context)
    if (context.currentReviewer && !currentReviewer) return null
    const observations: GoalObservation[] = []
    const mutationFrontier: GoalObservation[] = []
    const ids = new Set<string>()
    for (const raw of observationRead.records) {
      if (!verifyObservationIntegrity(raw as GoalObservation)) return null
      const observation = raw as GoalObservation
      if (observation.goalId !== goal.id || ids.has(observation.id)) return null
      ids.add(observation.id)
      if (observation.taskId && observation.agentId) {
        const taskInspection = this.taskStore.inspectIncludingArchive(
          observation.taskId,
        )
        const task = taskInspection.record
        if (taskInspection.issue || !task) return null
        const isCurrentReviewer = Boolean(
          currentReviewer &&
          currentReviewer.taskId === observation.taskId &&
          currentReviewer.agentId === observation.agentId &&
          task.source === 'goal_reviewer_dispatch' &&
          task.metadata.goal_id === goal.id &&
          task.metadata.plan_id === plan.id &&
          task.metadata.agent_id === observation.agentId,
        )
        if (
          isCurrentReviewer &&
          context.currentReviewer?.binding === 'dispatch_baseline'
        )
          continue
        if (
          currentReviewer &&
          isCurrentReviewer === false &&
          currentReviewer.taskId === observation.taskId
        )
          return null
      }
      observations.push(observation)
      mutationFrontier.push(observation)
    }
    const changedFiles: string[] = []
    const capabilitySignals = canonicalStrings(
      observations.flatMap(observationCapabilitySignals),
    )
    const readonlyProven = capabilitySignals.length === 0
    const base = {
      kind: 'core_goal_reviewer_risk' as const,
      issuedBy: 'core' as const,
      goalId: context.goalId,
      planId: context.planId,
      planEventSeq: context.planEventSeq,
      readonlyProven,
      changedFiles,
      capabilitySignals,
      mutationFrontier: mutationFrontier
        .map((observation) => ({
          id: observation.id,
          integritySha256: observation.integritySha256,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      scope: {
        sessionId: goal.scope.sessionId,
        mode: goal.scope.mode,
        projectId: goal.scope.projectId,
        workspaceRoot: goal.scope.workspaceRoot,
        projectFingerprint: goal.scope.projectFingerprint,
      },
      currentReviewer: currentReviewer
        ? {
            taskId: currentReviewer.taskId,
            agentId: currentReviewer.agentId,
          }
        : null,
    }
    return deepFreeze({
      kind: base.kind,
      issuedBy: base.issuedBy,
      goalId: base.goalId,
      planId: base.planId,
      planEventSeq: base.planEventSeq,
      readonlyProven: base.readonlyProven,
      changedFiles: base.changedFiles,
      capabilitySignals: base.capabilitySignals,
      version: `risk:${sha256(canonicalJson(base))}`,
    })
  }

  private async resolveCurrentReviewer(
    context: GoalReviewerRiskContext,
  ): Promise<{ readonly taskId: string; readonly agentId: string } | null> {
    const current = context.currentReviewer
    if (!current) return null
    const taskId = requiredId(current.taskId, 'reviewer task')
    const agentId = requiredId(current.agentId, 'reviewer agent')
    if (current.binding === 'prospective') {
      const inspection = this.taskStore.inspectIncludingArchive(taskId)
      return !inspection.issue && !inspection.record
        ? { taskId, agentId }
        : null
    }
    const events = await this.goalStore.readEventsReadonly(context.goalId)
    const receipts = events
      .filter((event) => isRecord(event.payload.reviewerDispatchReceipt))
      .map((event) =>
        parseReviewerDispatchReceipt(event.payload.reviewerDispatchReceipt),
      )
      .filter(
        (receipt) =>
          receipt.taskId === taskId &&
          receipt.agentId === agentId &&
          receipt.goalId === context.goalId &&
          receipt.planId === context.planId &&
          receipt.planEventSeq === context.planEventSeq,
      )
    return receipts.length === 1 ? { taskId, agentId } : null
  }
}

const READONLY_OBSERVATION_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'Skill',
])

function observationCapabilitySignals(observation: GoalObservation): string[] {
  const signals: string[] = []
  if (
    observation.toolName === 'write_file' ||
    observation.toolName === 'edit_file'
  )
    signals.push('filesystem_write')
  else if (observation.toolName === 'run_command')
    signals.push('command_execution')
  else if (observation.toolName === 'scheduler')
    signals.push('scheduler_mutation')
  else if (observation.toolName === 'manage_skill')
    signals.push('skill_mutation')
  else if (!READONLY_OBSERVATION_TOOLS.has(observation.toolName))
    signals.push(`unclassified_tool:${observation.toolName}`)
  if (observation.artifactRefs.length > 0) signals.push('artifact_output')
  return signals
}

export class GoalReviewerLedger {
  private readonly now: () => string
  private readonly idFactory: () => string
  private readonly policy: GoalReviewerPolicy
  private readonly mutex = new AsyncKeyedMutex()

  constructor(
    private readonly options: {
      readonly goalStore: GoalStore
      readonly planStore: PlanStore
      readonly taskManager: TaskManager
      readonly evidenceLedger: GoalEvidenceLedger
      readonly policy?: GoalReviewerPolicy
      readonly now?: () => string
      readonly idFactory?: () => string
      readonly resolveWaiverAction?: GoalReviewerWaiverActionResolver | null
      readonly resolveRiskFact?: GoalReviewerRiskFactResolver | null
      readonly beforeAppendAttempt?: (context: {
        readonly receipt: GoalReviewerReceipt
        readonly attempt: number
        readonly snapshotLastEventSeq: number
      }) => void | Promise<void>
    },
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? (() => newId('review_'))
    this.policy = options.policy ?? new GoalReviewerPolicy()
  }

  /**
   * The sole Core-owned reviewer dispatch path. Provenance is written both to
   * the immutable Goal event ledger and to protected task metadata; a normal
   * `dispatch_subagent` task can never be promoted into a reviewer afterward.
   */
  async dispatchGoalReviewer(
    input: DispatchGoalReviewerInput,
  ): Promise<GoalReviewerDispatch> {
    const normalized = {
      goalId: requiredId(input.goalId, 'Goal'),
      planId: requiredId(input.planId, 'Plan'),
      planEventSeq: requiredPositiveInt(
        input.planEventSeq,
        'Plan event sequence',
      ),
    }
    return await this.mutex.run(normalized.goalId, async () => {
      const { goal, plan } = await this.resolveCurrentGoalPlan(normalized)
      const approvalGeneration = requiredPositiveInt(
        plan.metadata.approval_generation,
        'Plan approval generation',
      )
      const createdAt = requiredTimestamp(this.now())
      const dispatchOrdinal = await this.nextDispatchOrdinal(goal.id)
      const dispatchReceiptId = newId('reviewer_dispatch_')
      const agentId = newId('reviewer_agent_')
      const turnId = newId('reviewer_turn_')
      const taskId = newId('subagent_')
      const risk = await this.resolveRiskAssessment(goal.id, plan, {
        taskId,
        agentId,
        binding: 'prospective',
      })
      const riskSignals = [...risk.requirement.riskSignals]
      const task = this.options.taskManager.startGoalReviewerTask({
        taskId,
        kind: TaskKind.SUBAGENT,
        title: `Independent Goal review: ${plan.title}`,
        sessionId: goal.scope.sessionId,
        turnId,
        metadata: {
          schema_version: GOAL_REVIEWER_DISPATCH_SCHEMA_VERSION,
          issued_by: 'core',
          agent_type: 'verification_reviewer',
          agent_id: agentId,
          turn_id: turnId,
          goal_id: goal.id,
          plan_id: plan.id,
          plan_event_seq: plan.eventSeq,
          approval_generation: approvalGeneration,
          risk_signals: riskSignals,
          risk_fact_version: risk.factVersion,
          dispatch_receipt_id: dispatchReceiptId,
          dispatch_ordinal: dispatchOrdinal,
        },
      })
      const base: Omit<GoalReviewerDispatchReceipt, 'integritySha256'> = {
        schemaVersion: GOAL_REVIEWER_DISPATCH_SCHEMA_VERSION,
        id: dispatchReceiptId,
        dispatchOrdinal,
        taskId: task.id,
        agentId,
        turnId,
        goalId: goal.id,
        planId: plan.id,
        planEventSeq: plan.eventSeq,
        approvalGeneration,
        riskSignals,
        riskFactVersion: risk.factVersion,
        issuedBy: 'core',
        createdAt,
      }
      const receipt = deepFreeze({
        ...base,
        integritySha256: sha256(canonicalJson(base)),
      })
      try {
        await this.options.goalStore.append(goal.id, {
          type: 'goal_updated',
          record: assertGoalTransition(goal, {
            ...goal,
            updatedAt: maxTimestamp(goal.updatedAt, createdAt),
          }),
          createdAt,
          expectedLastEventSeq: goal.lastEventSeq,
          data: { reviewerDispatchReceipt: receipt as unknown as never },
        })
        this.options.taskManager.appendSidechain(task.id, {
          role: 'user',
          content: reviewerInstructions(receipt),
        })
        return { task, receipt }
      } catch (cause) {
        this.options.taskManager.deleteGoalReviewerTask(task.id)
        throw cause
      }
    })
  }

  async recordReviewerReceipt(
    input: RecordReviewerReceiptInput,
  ): Promise<GoalReviewerReceipt> {
    const goalId = requiredId(input.goalId, 'Goal')
    const planId = requiredId(input.planId, 'Plan')
    const taskId = requiredId(input.taskId, 'reviewer task')
    const planEventSeq = requiredPositiveInt(
      input.planEventSeq,
      'Plan event sequence',
    )
    return await this.mutex.run(goalId, async () => {
      const id = requiredId(this.idFactory(), 'reviewer receipt')
      const createdAt = requiredTimestamp(this.now())
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const facts = await this.resolveCurrentFacts({
          goalId,
          planId,
          planEventSeq,
          taskId,
        })
        const existing = await this.listReviewerReceipts(goalId)
        if (
          existing.some(
            (receipt) =>
              receipt.id === id ||
              (receipt.planId === planId && receipt.taskId === taskId),
          )
        )
          throw reviewerError(
            'goal_reviewer_receipt_duplicate',
            'Reviewer receipt source is already recorded.',
          )
        const base: Omit<GoalReviewerReceipt, 'integritySha256'> = {
          id,
          goalId,
          planId,
          planEventSeq,
          verdict: facts.verdict,
          riskSignals: [...facts.riskSignals],
          riskFactVersion: facts.riskFactVersion,
          taskId,
          dispatchReceiptId: facts.dispatchReceiptId,
          dispatchOrdinal: facts.dispatchOrdinal,
          agentId: facts.agentId,
          transcriptRef: facts.transcriptRef,
          transcriptSha256: facts.transcriptSha256,
          commandEvidenceIds: [...facts.commandEvidenceIds],
          commandObservationIds: [...facts.commandObservationIds],
          summary: facts.summary,
          createdAt,
        }
        const receipt = deepFreeze({
          ...base,
          integritySha256: sha256(canonicalJson(base)),
        })
        const updatedAt = maxTimestamp(facts.goal.updatedAt, createdAt)
        const next = assertGoalTransition(facts.goal, {
          ...facts.goal,
          updatedAt,
        })
        if (attempt === 1)
          await this.options.beforeAppendAttempt?.({
            receipt,
            attempt,
            snapshotLastEventSeq: facts.goal.lastEventSeq,
          })
        try {
          await this.options.goalStore.append(goalId, {
            type: 'goal_updated',
            record: next,
            createdAt: updatedAt,
            expectedLastEventSeq: facts.goal.lastEventSeq,
            data: { reviewerReceipt: receipt as unknown as never },
          })
          return receipt
        } catch (cause) {
          if (
            !(cause instanceof GoalStoreError) ||
            cause.code !== 'goal_event_conflict'
          )
            throw cause
        }
      }
      throw reviewerError(
        'goal_reviewer_concurrent_update',
        'Reviewer receipt could not be recorded after concurrent updates.',
      )
    })
  }

  async listReviewerReceipts(
    goalIdValue: string,
  ): Promise<GoalReviewerReceipt[]> {
    const goalId = requiredId(goalIdValue, 'Goal')
    const events = await this.options.goalStore.readEvents(goalId)
    const receipts: GoalReviewerReceipt[] = []
    const ids = new Set<string>()
    for (const event of events) {
      if (!isRecord(event.payload.reviewerReceipt)) continue
      const receipt = parseReviewerReceipt(event.payload.reviewerReceipt)
      if (receipt.goalId !== goalId || ids.has(receipt.id))
        throw reviewerError(
          'goal_reviewer_ledger_invalid',
          'Reviewer receipt ledger is invalid.',
        )
      ids.add(receipt.id)
      receipts.push(receipt)
    }
    return receipts
  }

  async recordReviewerWaiver(
    input: RecordReviewerWaiverInput,
  ): Promise<GoalReviewerWaiverReceipt> {
    const normalized: RecordReviewerWaiverInput = {
      goalId: requiredId(input.goalId, 'Goal'),
      planId: requiredId(input.planId, 'Plan'),
      planEventSeq: requiredPositiveInt(
        input.planEventSeq,
        'Plan event sequence',
      ),
      interactionId: requiredId(input.interactionId, 'Control interaction'),
    }
    return await this.mutex.run(normalized.goalId, async () => {
      const id = requiredId(this.idFactory(), 'reviewer waiver receipt')
      const dispatchReceiptId = `reviewer_waiver_dispatch_${sha256(id).slice(0, 24)}`
      const createdAt = requiredTimestamp(this.now())
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const { goal, plan } = await this.resolveCurrentGoalPlan(normalized)
        const dispatchOrdinal = await this.nextDispatchOrdinal(goal.id)
        const risk = await this.resolveRiskAssessment(goal.id, plan)
        const context: GoalReviewerWaiverActionContext = {
          ...normalized,
          riskSignals: [...risk.requirement.riskSignals],
          riskFactVersion: risk.factVersion,
        }
        const fact = await this.options.resolveWaiverAction?.(context)
        if (!exactWaiverActionFact(fact, context))
          throw reviewerError(
            'goal_reviewer_waiver_untrusted',
            'Reviewer waiver requires an exact explicit user Control action.',
          )
        const existing = await this.listReviewerWaiverReceipts(goal.id)
        if (
          existing.some(
            (receipt) =>
              receipt.id === id ||
              (receipt.planId === plan.id &&
                receipt.interactionId === context.interactionId),
          )
        )
          throw reviewerError(
            'goal_reviewer_receipt_duplicate',
            'Reviewer waiver source is already recorded.',
          )
        const base: Omit<GoalReviewerWaiverReceipt, 'integritySha256'> = {
          id,
          goalId: goal.id,
          planId: plan.id,
          planEventSeq: plan.eventSeq,
          verdict: 'waived',
          riskSignals: [...risk.requirement.riskSignals],
          riskFactVersion: risk.factVersion,
          interactionId: context.interactionId,
          dispatchReceiptId,
          dispatchOrdinal,
          issuedBy: 'core',
          approvedBy: 'user',
          createdAt,
        }
        const receipt = deepFreeze({
          ...base,
          integritySha256: sha256(canonicalJson(base)),
        })
        const updatedAt = maxTimestamp(goal.updatedAt, createdAt)
        const next = assertGoalTransition(goal, { ...goal, updatedAt })
        try {
          await this.options.goalStore.append(goal.id, {
            type: 'goal_updated',
            record: next,
            createdAt: updatedAt,
            expectedLastEventSeq: goal.lastEventSeq,
            data: { reviewerWaiverReceipt: receipt as unknown as never },
          })
          return receipt
        } catch (cause) {
          if (
            !(cause instanceof GoalStoreError) ||
            cause.code !== 'goal_event_conflict'
          )
            throw cause
        }
      }
      throw reviewerError(
        'goal_reviewer_concurrent_update',
        'Reviewer waiver could not be recorded after concurrent updates.',
      )
    })
  }

  async listReviewerWaiverReceipts(
    goalIdValue: string,
  ): Promise<GoalReviewerWaiverReceipt[]> {
    const goalId = requiredId(goalIdValue, 'Goal')
    const events = await this.options.goalStore.readEvents(goalId)
    const receipts: GoalReviewerWaiverReceipt[] = []
    const ids = new Set<string>()
    for (const event of events) {
      if (!isRecord(event.payload.reviewerWaiverReceipt)) continue
      const receipt = parseReviewerWaiverReceipt(
        event.payload.reviewerWaiverReceipt,
      )
      if (receipt.goalId !== goalId || ids.has(receipt.id))
        throw invalidLedger()
      ids.add(receipt.id)
      receipts.push(receipt)
    }
    return receipts
  }

  async latestReviewerReceipt(
    goalIdValue: string,
    knownGoal?: import('./models').GoalRecord | null,
  ): Promise<GoalReviewerReceipt | null> {
    const goalId = requiredId(goalIdValue, 'Goal')
    const goal =
      knownGoal === undefined
        ? await readonlyGoalRecord(this.options.goalStore, goalId)
        : knownGoal
    if (!goal?.runtime.currentPlanId) return null
    const frontier = await this.reviewerFrontier(goal.id)
    const latest =
      frontier.valid && frontier.decision?.verdict !== 'waived'
        ? frontier.decision
        : null
    if (!latest) return null
    try {
      const facts = await this.resolveCurrentFacts(
        {
          goalId: latest.goalId,
          planId: latest.planId,
          planEventSeq: latest.planEventSeq,
          taskId: latest.taskId,
        },
        goal,
      )
      if (
        latest.verdict !== facts.verdict ||
        latest.transcriptRef !== facts.transcriptRef ||
        latest.transcriptSha256 !== facts.transcriptSha256 ||
        !sameStrings(latest.commandEvidenceIds, facts.commandEvidenceIds) ||
        !sameStrings(
          latest.commandObservationIds,
          facts.commandObservationIds,
        ) ||
        latest.agentId !== facts.agentId ||
        latest.summary !== facts.summary ||
        latest.dispatchReceiptId !== facts.dispatchReceiptId ||
        latest.dispatchOrdinal !== facts.dispatchOrdinal ||
        !sameStrings(latest.riskSignals, facts.riskSignals) ||
        (latest.riskFactVersion ?? null) !== facts.riskFactVersion
      )
        return null
      return latest
    } catch {
      return null
    }
  }

  async resolvePlanReviewerFact(
    goalId: string,
    context: PlanReviewerContext,
  ): Promise<PlanReviewerFact | null> {
    if (goalId !== context.goalId) return null
    const decision = await this.latestReviewerDecision(goalId)
    if (
      !decision ||
      decision.planId !== context.planId ||
      decision.planEventSeq !== context.planEventSeq ||
      decision.verdict === 'fail'
    )
      return null
    return deepFreeze({
      ...context,
      kind: 'core_independent_plan_review',
      issuedBy: 'core',
      verdict: decision.verdict,
      receiptId: decision.id,
      commandEvidenceRefs:
        decision.verdict === 'pass'
          ? [
              ...(decision.commandEvidenceIds.length > 0
                ? decision.commandEvidenceIds
                : decision.commandObservationIds),
            ]
          : [],
    })
  }

  independentReviewerSource(
    receipt: GoalReviewerReceipt,
    criterionIdValue: string,
  ): GoalIndependentReviewerSource {
    const criterionId = requiredId(criterionIdValue, 'reviewer criterion')
    return deepFreeze({
      reviewerReceiptId: receipt.id,
      dispatchReceiptId: receipt.dispatchReceiptId,
      dispatchOrdinal: receipt.dispatchOrdinal,
      planId: receipt.planId,
      planEventSeq: receipt.planEventSeq,
      taskId: receipt.taskId,
      agentId: receipt.agentId,
      transcriptRef: receipt.transcriptRef,
      transcriptSha256: receipt.transcriptSha256,
      riskFactVersion: receipt.riskFactVersion ?? null,
      riskSignalsSha256: sha256(canonicalJson(receipt.riskSignals)),
      commandObservationsSha256: sha256(
        canonicalJson(receipt.commandObservationIds),
      ),
      criterionId,
      verdict: receipt.verdict,
    })
  }

  async resolveIndependentReviewerFact(
    goalIdValue: string,
    source: GoalIndependentReviewerSource,
  ): Promise<GoalIndependentReviewerFact | null> {
    const goalId = requiredId(goalIdValue, 'Goal')
    try {
      const goal = await readonlyGoalRecord(this.options.goalStore, goalId)
      const criterion = goal?.contract.acceptanceCriteria.find(
        (candidate) => candidate.id === source.criterionId,
      )
      if (!goal || criterion?.verification.kind !== 'reviewer') return null
      const receipt = await this.latestReviewerReceipt(goalId, goal)
      if (!receipt || receipt.id !== source.reviewerReceiptId) return null
      const expected = this.independentReviewerSource(
        receipt,
        source.criterionId,
      )
      if (canonicalJson(expected) !== canonicalJson(source)) return null
      return deepFreeze({
        ...expected,
        goalId,
        summary: receipt.summary,
      })
    } catch {
      return null
    }
  }

  async latestReviewerDecision(
    goalId: string,
    knownGoal?: import('./models').GoalRecord | null,
  ): Promise<GoalReviewerReceipt | GoalReviewerWaiverReceipt | null> {
    const goal =
      knownGoal === undefined
        ? await readonlyGoalRecord(this.options.goalStore, goalId)
        : knownGoal
    if (!goal?.runtime.currentPlanId) return null
    const frontier = await this.reviewerFrontier(goal.id)
    if (!frontier.valid) return null
    const latest = frontier.decision
    if (!latest || latest.planId !== goal.runtime.currentPlanId) return null
    if (latest.verdict !== 'waived')
      return await this.latestReviewerReceipt(goal.id, goal)
    try {
      const { plan } = await this.resolveCurrentGoalPlan(latest, goal)
      const risk = await this.resolveRiskAssessment(goal.id, plan)
      if (
        !sameStrings(latest.riskSignals, risk.requirement.riskSignals) ||
        (latest.riskFactVersion ?? null) !== risk.factVersion
      )
        return null
      return latest
    } catch {
      return null
    }
  }

  private async nextDispatchOrdinal(goalId: string): Promise<number> {
    const frontier = await this.reviewerFrontier(goalId)
    if (!frontier.valid) throw invalidLedger()
    return frontier.ordinal + 1
  }

  private async reviewerFrontier(goalId: string): Promise<{
    readonly valid: boolean
    readonly ordinal: number
    readonly dispatchReceiptId: string | null
    readonly decision: GoalReviewerReceipt | GoalReviewerWaiverReceipt | null
  }> {
    try {
      const events = await this.options.goalStore.readEventsReadonly(goalId)
      let ordinal = 0
      let dispatchReceiptId: string | null = null
      const dispatchIds = new Set<string>()
      const reviewerTaskIds = new Set<string>()
      const decisionIds = new Set<string>()
      const generations = new Map<
        number,
        | {
            readonly kind: 'reviewer'
            readonly dispatch: GoalReviewerDispatchReceipt
            decision: GoalReviewerReceipt | null
          }
        | {
            readonly kind: 'waiver'
            readonly waiver: GoalReviewerWaiverReceipt
            readonly decision: GoalReviewerWaiverReceipt
          }
      >()
      const invalid = () => ({
        valid: false as const,
        ordinal,
        dispatchReceiptId,
        decision: null,
      })
      for (const event of events) {
        const hasDispatch = Object.prototype.hasOwnProperty.call(
          event.payload,
          'reviewerDispatchReceipt',
        )
        const hasWaiver = Object.prototype.hasOwnProperty.call(
          event.payload,
          'reviewerWaiverReceipt',
        )
        const hasReceipt = Object.prototype.hasOwnProperty.call(
          event.payload,
          'reviewerReceipt',
        )
        if (Number(hasDispatch) + Number(hasWaiver) + Number(hasReceipt) > 1)
          return invalid()
        if (hasDispatch) {
          if (!isRecord(event.payload.reviewerDispatchReceipt)) return invalid()
          const dispatch = parseReviewerDispatchReceipt(
            event.payload.reviewerDispatchReceipt,
          )
          if (
            dispatch.goalId !== goalId ||
            dispatch.dispatchOrdinal !== ordinal + 1 ||
            dispatchIds.has(dispatch.id) ||
            reviewerTaskIds.has(dispatch.taskId)
          )
            return invalid()
          ordinal = dispatch.dispatchOrdinal
          dispatchReceiptId = dispatch.id
          dispatchIds.add(dispatch.id)
          reviewerTaskIds.add(dispatch.taskId)
          generations.set(ordinal, {
            kind: 'reviewer',
            dispatch,
            decision: null,
          })
        }
        if (hasWaiver) {
          if (!isRecord(event.payload.reviewerWaiverReceipt)) return invalid()
          const waiver = parseReviewerWaiverReceipt(
            event.payload.reviewerWaiverReceipt,
          )
          if (
            waiver.goalId !== goalId ||
            waiver.dispatchOrdinal !== ordinal + 1 ||
            dispatchIds.has(waiver.dispatchReceiptId) ||
            decisionIds.has(waiver.id)
          )
            return invalid()
          ordinal = waiver.dispatchOrdinal
          dispatchReceiptId = waiver.dispatchReceiptId
          dispatchIds.add(waiver.dispatchReceiptId)
          decisionIds.add(waiver.id)
          generations.set(ordinal, {
            kind: 'waiver',
            waiver,
            decision: waiver,
          })
        }
        if (hasReceipt) {
          if (!isRecord(event.payload.reviewerReceipt)) return invalid()
          const receipt = parseReviewerReceipt(event.payload.reviewerReceipt)
          const generation = generations.get(receipt.dispatchOrdinal)
          if (
            receipt.goalId !== goalId ||
            !generation ||
            generation.kind !== 'reviewer' ||
            generation.decision ||
            decisionIds.has(receipt.id) ||
            !reviewerReceiptMatchesDispatch(receipt, generation.dispatch)
          )
            return invalid()
          generation.decision = receipt
          decisionIds.add(receipt.id)
        }
      }
      const current = generations.get(ordinal)
      return {
        valid: true,
        ordinal,
        dispatchReceiptId,
        decision: current?.decision ?? null,
      }
    } catch {
      return {
        valid: false,
        ordinal: 0,
        dispatchReceiptId: null,
        decision: null,
      }
    }
  }

  private async resolveCurrentFacts(
    input: RecordReviewerReceiptInput,
    knownGoal?: import('./models').GoalRecord | null,
  ) {
    const { goal, plan } = await this.resolveCurrentGoalPlan(input, knownGoal)
    const dispatch = await this.resolveDispatchReceipt(goal.id, input.taskId)
    const taskFacts = this.resolveTaskFacts(
      this.options.taskManager.store.inspectIncludingArchive(input.taskId),
      input,
      dispatch,
    )
    const observationRead =
      await this.options.goalStore.readObservationsReadonly<GoalObservation>(
        goal.id,
      )
    if (observationRead.badLines.length > 0)
      throw reviewerError(
        'goal_reviewer_evidence_untrusted',
        'Reviewer command observation ledger is corrupt.',
      )
    const commandObservations: GoalObservation[] = []
    const observationIds = new Set<string>()
    for (const observation of observationRead.records) {
      if (!verifyObservationIntegrity(observation))
        throw reviewerError(
          'goal_reviewer_evidence_untrusted',
          'Reviewer command observation integrity is invalid.',
        )
      if (
        observation.taskId !== taskFacts.taskId ||
        observation.agentId !== taskFacts.agentId
      )
        continue
      if (
        observation.goalId !== goal.id ||
        observation.turnId !== dispatch.turnId ||
        observation.toolName !== 'run_command' ||
        observation.evidencePolicy !== 'eligible' ||
        observation.eligible !== true ||
        Date.parse(observation.createdAt) < Date.parse(dispatch.createdAt) ||
        observationIds.has(observation.id)
      )
        throw reviewerError(
          'goal_reviewer_evidence_untrusted',
          'Reviewer command observation provenance is invalid.',
        )
      observationIds.add(observation.id)
      commandObservations.push(observation)
    }
    if (
      commandObservations.length === 0 ||
      (taskFacts.verdict === 'pass' &&
        commandObservations.some((observation) => observation.isError))
    )
      throw reviewerError(
        'goal_reviewer_evidence_required',
        'Reviewer receipt requires a successful task-owned command observation.',
      )
    const evidence: GoalEvidence[] = []
    for (const evidenceId of taskFacts.commandEvidenceIds) {
      const item =
        await this.options.evidenceLedger.validatedReviewerEvidenceById(
          goal.id,
          evidenceId,
          {
            taskId: taskFacts.taskId,
            agentId: taskFacts.agentId,
            dispatchedAt: taskFacts.dispatchedAt,
          },
        )
      if (!item || item.goalId !== goal.id)
        throw reviewerError(
          'goal_reviewer_evidence_untrusted',
          'Reviewer command or artifact evidence is unavailable or untrusted.',
        )
      const criterion = goal.contract.acceptanceCriteria.find(
        (candidate) => candidate.id === item.criterionId,
      )
      if (
        !criterion ||
        (criterion.verification.kind !== 'command' &&
          criterion.verification.kind !== 'artifact') ||
        (taskFacts.verdict === 'pass' && item.verdict !== 'pass')
      )
        throw reviewerError(
          'goal_reviewer_evidence_untrusted',
          'Reviewer evidence is not a valid command or artifact fact.',
        )
      evidence.push(item)
    }
    const risk = await this.resolveRiskAssessment(goal.id, plan, {
      taskId: dispatch.taskId,
      agentId: dispatch.agentId,
      binding: 'receipt',
    })
    const dispatchBaseline = await this.resolveRiskAssessment(goal.id, plan, {
      taskId: dispatch.taskId,
      agentId: dispatch.agentId,
      binding: 'dispatch_baseline',
    })
    if (
      dispatch.riskFactVersion !== dispatchBaseline.factVersion ||
      !sameStrings(
        dispatch.riskSignals,
        dispatchBaseline.requirement.riskSignals,
      )
    )
      throw reviewerError(
        'goal_reviewer_task_untrusted',
        'Reviewer dispatch baseline changed and requires a fresh review.',
      )
    return {
      goal,
      plan,
      ...taskFacts,
      commandObservationIds: commandObservations
        .map((observation) => observation.id)
        .sort(),
      riskSignals: risk.requirement.riskSignals,
      riskFactVersion: risk.factVersion,
    }
  }

  private async resolveRiskRequirement(
    goalId: string,
    plan: PlanRecord,
  ): Promise<GoalReviewerRequirement> {
    return (await this.resolveRiskAssessment(goalId, plan)).requirement
  }

  private async resolveRiskAssessment(
    goalId: string,
    plan: PlanRecord,
    currentReviewer: GoalReviewerRiskContext['currentReviewer'] = null,
  ): Promise<{
    readonly requirement: GoalReviewerRequirement
    readonly factVersion: string | null
  }> {
    let fact: GoalReviewerRiskFact | null = null
    try {
      fact =
        (await this.options.resolveRiskFact?.({
          goalId,
          planId: plan.id,
          planEventSeq: plan.eventSeq,
          currentReviewer,
        })) ?? null
    } catch {
      fact = null
    }
    return {
      requirement: this.policy.requirementFor(plan, fact),
      factVersion: exactRiskFact(fact, plan) ? fact.version : null,
    }
  }

  private async resolveDispatchReceipt(
    goalId: string,
    taskId: string,
  ): Promise<GoalReviewerDispatchReceipt> {
    const events = await this.options.goalStore.readEventsReadonly(goalId)
    const matches = events
      .filter((event) => isRecord(event.payload.reviewerDispatchReceipt))
      .map((event) =>
        parseReviewerDispatchReceipt(event.payload.reviewerDispatchReceipt),
      )
      .filter((receipt) => receipt.taskId === taskId)
    if (matches.length !== 1)
      throw reviewerError(
        'goal_reviewer_task_untrusted',
        'Reviewer task has no unique Core dispatch receipt.',
      )
    return matches[0]!
  }

  private async resolveCurrentGoalPlan(
    input: {
      readonly goalId: string
      readonly planId: string
      readonly planEventSeq: number
    },
    knownGoal?: import('./models').GoalRecord | null,
  ) {
    const goal =
      knownGoal === undefined
        ? await readonlyGoalRecord(this.options.goalStore, input.goalId)
        : knownGoal
    if (!goal || goal.status !== 'active')
      throw reviewerError(
        'goal_reviewer_goal_inactive',
        'Reviewer receipts require an active Goal.',
      )
    if (goal.runtime.currentPlanId !== input.planId)
      throw reviewerError(
        'goal_reviewer_plan_stale',
        'Reviewer receipt does not target the current Goal Plan.',
      )
    const planInspection = this.options.planStore.inspectIncludingArchive(
      input.planId,
    )
    const plan = planInspection.record
    const quarantine = this.options.planStore.inspectQuarantine(input.planId)
    if (
      planInspection.issue ||
      quarantine.issue ||
      !plan ||
      plan.goalId !== goal.id ||
      plan.eventSeq !== input.planEventSeq ||
      !planMatchesGoalScope(plan, goal) ||
      quarantine.quarantined
    )
      throw reviewerError(
        'goal_reviewer_plan_stale',
        'Reviewer receipt does not target the current trusted Plan generation.',
      )
    return { goal, plan }
  }

  private resolveTaskFacts(
    inspection: {
      readonly record: TaskRecord | null
      readonly issue: { readonly code: string } | null
    },
    input: RecordReviewerReceiptInput,
    dispatch: GoalReviewerDispatchReceipt,
  ): {
    verdict: 'pass' | 'fail'
    transcriptRef: string
    transcriptSha256: string
    commandEvidenceIds: string[]
    summary: string
    taskId: string
    agentId: string
    dispatchedAt: string
    dispatchReceiptId: string
    dispatchOrdinal: number
  } {
    const task = inspection.record
    if (
      inspection.issue ||
      !task ||
      task.kind !== TaskKind.SUBAGENT ||
      task.status !== TaskStatus.COMPLETED ||
      task.source !== 'goal_reviewer_dispatch' ||
      task.metadata.schema_version !== GOAL_REVIEWER_DISPATCH_SCHEMA_VERSION ||
      task.metadata.issued_by !== 'core' ||
      task.metadata.agent_type !== 'verification_reviewer' ||
      task.metadata.agent_id !== dispatch.agentId ||
      task.metadata.turn_id !== dispatch.turnId ||
      task.metadata.dispatch_receipt_id !== dispatch.id ||
      Number(task.metadata.dispatch_ordinal) !== dispatch.dispatchOrdinal ||
      task.turn_id !== dispatch.turnId ||
      task.metadata.goal_id !== input.goalId ||
      task.metadata.plan_id !== input.planId ||
      Number(task.metadata.plan_event_seq) !== input.planEventSeq ||
      dispatch.taskId !== task.id ||
      dispatch.goalId !== input.goalId ||
      dispatch.planId !== input.planId ||
      dispatch.planEventSeq !== input.planEventSeq ||
      dispatch.approvalGeneration !==
        Number(task.metadata.approval_generation) ||
      dispatch.riskFactVersion !==
        (typeof task.metadata.risk_fact_version === 'string'
          ? task.metadata.risk_fact_version
          : null) ||
      !sameStrings(
        dispatch.riskSignals,
        boundedStringArray(task.metadata.risk_signals),
      )
    )
      throw reviewerError(
        'goal_reviewer_task_untrusted',
        'Reviewer task is unavailable, non-terminal, or has the wrong provenance.',
      )
    const transcript = new SidechainTranscript(
      this.options.taskManager.root,
      task.id,
    )
    if (
      !task.transcript_path ||
      task.transcript_path !==
        relativePortable(this.options.taskManager.root, transcript.path)
    )
      throw reviewerError(
        'goal_reviewer_transcript_untrusted',
        'Reviewer transcript reference is unavailable or untrusted.',
      )
    let page: ReturnType<SidechainTranscript['inspectAll']>
    try {
      page = transcript.inspectAll({
        maxBytes: 1_048_576,
        maxMessages: 10_000,
      })
    } catch {
      throw reviewerError(
        'goal_reviewer_transcript_untrusted',
        'Reviewer transcript reference is unavailable or untrusted.',
      )
    }
    if (page.issue)
      throw reviewerError(
        'goal_reviewer_transcript_untrusted',
        'Reviewer transcript is malformed, truncated, or over the bounded limit.',
      )
    const assistant = [...page.messages]
      .reverse()
      .find((message) => message.role === 'assistant')
    const verdict = parseReviewerVerdict(
      typeof assistant?.content === 'string' ? assistant.content : null,
    )
    const commandEvidenceIds = uniqueEvidenceIds(verdict?.commandEvidence ?? [])
    if (!verdict)
      throw reviewerError(
        'goal_reviewer_task_untrusted',
        'Reviewer transcript does not contain a valid terminal verdict.',
      )
    return {
      verdict: verdict.passed ? 'pass' : 'fail',
      transcriptRef: `task:${task.id}:transcript`,
      transcriptSha256: sha256(canonicalJson(page.messages)),
      commandEvidenceIds,
      summary: boundedReviewerSummary(verdict.summary),
      taskId: task.id,
      agentId: dispatch.agentId,
      dispatchedAt: dispatch.createdAt,
      dispatchReceiptId: dispatch.id,
      dispatchOrdinal: dispatch.dispatchOrdinal,
    }
  }
}

function reviewerInstructions(receipt: GoalReviewerDispatchReceipt): string {
  return [
    'Perform an independent verification of this Goal Plan generation.',
    `Goal: ${receipt.goalId}`,
    `Plan: ${receipt.planId} @ event ${receipt.planEventSeq}`,
    'Run the required command or artifact checks through tools in this reviewer task.',
    'Return one fenced verdict JSON object containing passed, summary, commands, and command_evidence evidence_id entries.',
  ].join('\n')
}

function parseReviewerDispatchReceipt(
  value: unknown,
): GoalReviewerDispatchReceipt {
  if (!isRecord(value)) throw invalidLedger()
  const receipt: GoalReviewerDispatchReceipt = {
    schemaVersion:
      value.schemaVersion === GOAL_REVIEWER_DISPATCH_SCHEMA_VERSION
        ? value.schemaVersion
        : invalidLedger(),
    id: requiredId(value.id, 'reviewer dispatch receipt'),
    dispatchOrdinal: requiredPositiveInt(
      value.dispatchOrdinal,
      'reviewer dispatch ordinal',
    ),
    taskId: requiredId(value.taskId, 'reviewer task'),
    agentId: requiredId(value.agentId, 'reviewer agent'),
    turnId: requiredId(value.turnId, 'reviewer turn'),
    goalId: requiredId(value.goalId, 'Goal'),
    planId: requiredId(value.planId, 'Plan'),
    planEventSeq: requiredPositiveInt(
      value.planEventSeq,
      'Plan event sequence',
    ),
    approvalGeneration: requiredPositiveInt(
      value.approvalGeneration,
      'Plan approval generation',
    ),
    riskSignals: boundedStringArray(value.riskSignals),
    riskFactVersion:
      value.riskFactVersion === null
        ? null
        : requiredId(value.riskFactVersion, 'reviewer risk fact version'),
    issuedBy: value.issuedBy === 'core' ? value.issuedBy : invalidLedger(),
    createdAt: requiredTimestamp(value.createdAt),
    integritySha256: requiredSha256(value.integritySha256),
  }
  const { integritySha256, ...base } = receipt
  if (sha256(canonicalJson(base)) !== integritySha256) throw invalidLedger()
  return deepFreeze(receipt)
}

function parseReviewerReceipt(value: unknown): GoalReviewerReceipt {
  if (!isRecord(value)) throw invalidLedger()
  const receipt: GoalReviewerReceipt = {
    id: requiredId(value.id, 'reviewer receipt'),
    goalId: requiredId(value.goalId, 'Goal'),
    planId: requiredId(value.planId, 'Plan'),
    planEventSeq: requiredPositiveInt(
      value.planEventSeq,
      'Plan event sequence',
    ),
    verdict:
      value.verdict === 'pass' || value.verdict === 'fail'
        ? value.verdict
        : invalidLedger(),
    riskSignals: boundedStringArray(value.riskSignals),
    ...(value.riskFactVersion !== undefined
      ? {
          riskFactVersion:
            value.riskFactVersion === null
              ? null
              : requiredId(value.riskFactVersion, 'reviewer risk fact version'),
        }
      : {}),
    taskId: requiredId(value.taskId, 'reviewer task'),
    dispatchReceiptId: requiredId(
      value.dispatchReceiptId,
      'reviewer dispatch receipt',
    ),
    dispatchOrdinal: requiredPositiveInt(
      value.dispatchOrdinal,
      'reviewer dispatch ordinal',
    ),
    agentId: requiredId(value.agentId, 'reviewer agent'),
    transcriptRef: requiredTaskTranscriptRef(value.transcriptRef),
    transcriptSha256: requiredSha256(value.transcriptSha256),
    commandEvidenceIds: idArray(
      value.commandEvidenceIds,
      'command evidence IDs',
    ),
    commandObservationIds: idArray(
      value.commandObservationIds,
      'command observation IDs',
    ),
    summary: boundedReviewerSummary(value.summary),
    createdAt: requiredTimestamp(value.createdAt),
    integritySha256: requiredSha256(value.integritySha256),
  }
  const { integritySha256, ...base } = receipt
  if (
    receipt.commandObservationIds.length === 0 ||
    sha256(canonicalJson(base)) !== integritySha256
  )
    throw invalidLedger()
  return deepFreeze(receipt)
}

function boundedReviewerSummary(value: unknown): string {
  const summary = String(value ?? '')
    .trim()
    .slice(0, 500)
  if (!summary) throw invalidLedger()
  return summary
}

function parseReviewerWaiverReceipt(value: unknown): GoalReviewerWaiverReceipt {
  if (!isRecord(value)) throw invalidLedger()
  const receipt: GoalReviewerWaiverReceipt = {
    id: requiredId(value.id, 'reviewer waiver receipt'),
    goalId: requiredId(value.goalId, 'Goal'),
    planId: requiredId(value.planId, 'Plan'),
    planEventSeq: requiredPositiveInt(
      value.planEventSeq,
      'Plan event sequence',
    ),
    verdict: value.verdict === 'waived' ? 'waived' : invalidLedger(),
    riskSignals: boundedStringArray(value.riskSignals),
    ...(value.riskFactVersion !== undefined
      ? {
          riskFactVersion:
            value.riskFactVersion === null
              ? null
              : requiredId(value.riskFactVersion, 'reviewer risk fact version'),
        }
      : {}),
    interactionId: requiredId(value.interactionId, 'Control interaction'),
    dispatchReceiptId: requiredId(
      value.dispatchReceiptId,
      'reviewer waiver dispatch receipt',
    ),
    dispatchOrdinal: requiredPositiveInt(
      value.dispatchOrdinal,
      'reviewer dispatch ordinal',
    ),
    issuedBy: value.issuedBy === 'core' ? 'core' : invalidLedger(),
    approvedBy: value.approvedBy === 'user' ? 'user' : invalidLedger(),
    createdAt: requiredTimestamp(value.createdAt),
    integritySha256: requiredSha256(value.integritySha256),
  }
  const { integritySha256, ...base } = receipt
  if (sha256(canonicalJson(base)) !== integritySha256) throw invalidLedger()
  return deepFreeze(receipt)
}

function exactWaiverActionFact(
  fact: GoalReviewerWaiverActionFact | null | undefined,
  context: GoalReviewerWaiverActionContext,
): fact is GoalReviewerWaiverActionFact {
  return Boolean(
    fact &&
    fact.kind === 'explicit_user_goal_reviewer_waiver_action' &&
    fact.issuedBy === 'core' &&
    fact.approvedBy === 'user' &&
    fact.verdict === 'waived' &&
    fact.goalId === context.goalId &&
    fact.planId === context.planId &&
    fact.planEventSeq === context.planEventSeq &&
    fact.interactionId === context.interactionId &&
    sameStrings(fact.riskSignals, context.riskSignals) &&
    fact.riskFactVersion === context.riskFactVersion,
  )
}

function uniqueEvidenceIds(
  values: readonly Record<string, unknown>[],
): string[] {
  const ids: string[] = []
  for (const value of values) {
    const raw = value.evidence_id ?? value.evidenceId
    if (raw === undefined || raw === null) continue
    const id = requiredId(raw, 'command evidence')
    if (!ids.includes(id)) ids.push(id)
  }
  return ids.sort()
}

function idArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw invalidLedger()
  const values = value.map((item) => requiredId(item, label))
  if (new Set(values).size !== values.length) throw invalidLedger()
  return values
}

function boundedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidLedger()
  const values = value.map((item) => String(item ?? '').trim())
  if (
    values.some((item) => !item || item.length > 120) ||
    new Set(values).size !== values.length
  )
    throw invalidLedger()
  return values
}

function requiredTaskTranscriptRef(value: unknown): string {
  const ref = String(value ?? '').trim()
  if (!/^task:[A-Za-z0-9_-][A-Za-z0-9_.:-]*:transcript$/.test(ref))
    throw invalidLedger()
  return ref
}

function requiredId(value: unknown, label: string): string {
  const id = String(value ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id))
    throw reviewerError('goal_reviewer_input_invalid', `${label} is invalid.`)
  return id
}

function requiredPositiveInt(value: unknown, label: string): number {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1)
    throw reviewerError('goal_reviewer_input_invalid', `${label} is invalid.`)
  return result
}

function requiredTimestamp(value: unknown): string {
  const timestamp = String(value ?? '')
  if (!Number.isFinite(Date.parse(timestamp)))
    throw reviewerError(
      'goal_reviewer_input_invalid',
      'Reviewer timestamp is invalid.',
    )
  return timestamp
}

function requiredSha256(value: unknown): string {
  const hash = String(value ?? '')
  if (!SHA256_PATTERN.test(hash)) throw invalidLedger()
  return hash
}

function reviewerReceiptMatchesDispatch(
  receipt: GoalReviewerReceipt,
  dispatch: GoalReviewerDispatchReceipt,
): boolean {
  return (
    receipt.dispatchReceiptId === dispatch.id &&
    receipt.dispatchOrdinal === dispatch.dispatchOrdinal &&
    receipt.goalId === dispatch.goalId &&
    receipt.planId === dispatch.planId &&
    receipt.planEventSeq === dispatch.planEventSeq &&
    receipt.taskId === dispatch.taskId &&
    receipt.agentId === dispatch.agentId &&
    receipt.transcriptRef === `task:${dispatch.taskId}:transcript` &&
    Date.parse(receipt.createdAt) >= Date.parse(dispatch.createdAt)
  )
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return canonicalJson(left) === canonicalJson(right)
}

function exactRiskFact(
  fact: GoalReviewerRiskFact | null,
  plan: PlanRecord,
): fact is GoalReviewerRiskFact {
  return Boolean(
    fact &&
    fact.kind === 'core_goal_reviewer_risk' &&
    fact.issuedBy === 'core' &&
    typeof fact.version === 'string' &&
    fact.version.trim().length > 0 &&
    (plan.goalId === null || fact.goalId === plan.goalId) &&
    fact.planId === plan.id &&
    fact.planEventSeq === plan.eventSeq &&
    typeof fact.readonlyProven === 'boolean' &&
    Array.isArray(fact.changedFiles) &&
    fact.changedFiles.every((item) => typeof item === 'string') &&
    Array.isArray(fact.capabilitySignals) &&
    fact.capabilitySignals.every(
      (item) => typeof item === 'string' && item.trim().length > 0,
    ),
  )
}

export function canonicalRiskSignals(
  values: readonly string[],
): readonly string[] {
  const normalized = canonicalStrings(
    values.map((value) =>
      String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_'),
    ),
  )
  return normalized.sort(
    (left, right) =>
      riskSignalRank(left) - riskSignalRank(right) || left.localeCompare(right),
  )
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  )
}

function riskSignalRank(value: string): number {
  if (
    value === 'security' ||
    value === 'permission' ||
    value === 'deletion' ||
    value === 'external_send'
  )
    return 0
  if (
    value === 'deployment' ||
    value === 'data_migration' ||
    value === 'long_running'
  )
    return 1
  if (
    value.startsWith('changed_files') ||
    value.startsWith('core_changed_files')
  )
    return 2
  if (value.startsWith('core_capability:')) return 3
  return 4
}

function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

function maxTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function reviewerError(code: string, message: string): GoalReviewerError {
  return new GoalReviewerError(code, message)
}

function invalidLedger(): never {
  throw reviewerError(
    'goal_reviewer_ledger_invalid',
    'Reviewer receipt ledger is invalid.',
  )
}

async function readonlyGoalRecord(
  store: Pick<GoalStore, 'readEventsReadonly'>,
  goalId: string,
): Promise<GoalRecord | null> {
  const events = await store.readEventsReadonly(goalId)
  const record = events.at(-1)?.payload.record
  return record ? structuredClone(record) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

class AsyncKeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
