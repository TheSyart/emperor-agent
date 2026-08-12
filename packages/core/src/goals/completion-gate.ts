import { createHash } from 'node:crypto'
import { EmperorError } from '../errors'
import { canonicalJson } from './events'
import { verifyGoalPlanCompletionReceiptIntegrity } from './plan-bridge'
import type { GoalGateReasonCode, GoalRecord } from './models'
import {
  commitAuthorizedGoalTerminal,
  goalCompletionGateOptions,
  trustedGoalCompletionGateOptions,
} from './goal-terminal-internal'
import { assertGoalTransition } from './validation'
import {
  GoalGateMutationLedger,
  type GoalGateMutationSnapshot,
} from './mutation-ledger'
import type { GoalMutationLease } from './mutation-guard'
import { GoalPostCommitDiagnosticsStore } from './post-commit-diagnostics'
import { type GoalGateFactBundle, type GoalGateFactRecord } from './gate-facts'
import {
  GoalCleanupJournal,
  type GoalCleanupObligation,
} from './cleanup-journal'
import {
  goalBlockReasonSha256,
  normalizeGoalBlockReason,
  type GoalBlockerFact,
  type GoalTypedBlockerCode,
} from './blocker-facts'
import {
  GOAL_COMPLETION_RECEIPT_SCHEMA_VERSION,
  type GoalCleanupExecutionContext,
  type GoalCleanupObligationRecord,
  type GoalCleanupRecoveryResult,
  type GoalCompletionGateOptions,
  type GoalCompletionReceipt,
  type GoalCompletionResult,
  type GoalEvidenceFact,
  type GoalGateFactVersions,
  type GoalGateReason,
  type GoalGateResult,
  type GoalGateRiskDisclosure,
  type GoalGateRiskCode,
  type GoalPostCommitFailure,
  type GoalPostCommitFailureCode,
  type GoalReviewerDecision,
} from './contracts/completion'
import type { GoalPlanCompletionReceipt } from './contracts/planning'
export { GOAL_COMPLETION_RECEIPT_SCHEMA_VERSION } from './contracts/completion'
export type {
  GoalCleanupExecutionContext,
  GoalCleanupObligationRecord,
  GoalCleanupRecoveryResult,
  GoalCompletionCleanup,
  GoalCompletionGateOptions,
  GoalCompletionReceipt,
  GoalCompletionResult,
  GoalGateFactVersions,
  GoalGateReason,
  GoalGateResult,
  GoalGateRiskCode,
  GoalGateRiskDisclosure,
  GoalPostCommitFailure,
  GoalPostCommitFailureCode,
} from './contracts/completion'

type GoalPostCommitActionFailureCode = Exclude<
  GoalPostCommitFailureCode,
  'diagnostic_persist_failed'
>

export type GoalBlockerCode = GoalTypedBlockerCode

export interface GoalBlockInput {
  readonly code: GoalBlockerCode
  readonly reason: string
}

export interface GoalGateVersionedFact {
  readonly version: string
}

export class GoalCompletionGateError extends EmperorError {
  readonly gate: GoalGateResult | null

  constructor(
    code: string,
    message: string,
    gate: GoalGateResult | null = null,
  ) {
    super(message, code)
    this.gate = gate
  }
}

export class GoalCompletionGate {
  constructor(private readonly options: GoalCompletionGateOptions) {}

  async evaluate(goalIdValue: string): Promise<GoalGateResult> {
    const options = goalCompletionGateOptions(this, this.options)
    const mutations = new GoalGateMutationLedger(options.goalStore.stateRoot)
    return await mutations.guard.runExclusive(
      'mutation',
      async (lease) =>
        await this.evaluateUnderLease(goalIdValue, options, mutations, lease),
    )
  }

  private async evaluateUnderLease(
    goalIdValue: string,
    options: GoalCompletionGateOptions,
    mutations: GoalGateMutationLedger,
    lease: GoalMutationLease,
  ): Promise<GoalGateResult> {
    mutations.guard.assertLease(lease)
    const goalId = String(goalIdValue ?? '').trim()
    const evaluatedAt = trustedNow(options)
    const reasons: GoalGateReason[] = []
    const risks: GoalGateRiskDisclosure[] = []
    let mutationPrecondition: GoalGateMutationSnapshot | null = null
    let goal: GoalRecord | null = null
    let facts: GoalGateFactBundle | null = null
    try {
      const inspection = goalId
        ? await options.goalStore.inspect(goalId)
        : { record: null, issue: null }
      goal = inspection.record
      if (inspection.issue) appendReason(reasons, 'storage_recovery_required')
    } catch {
      appendReason(reasons, 'storage_recovery_required')
    }
    if (!goal) {
      appendReason(reasons, 'goal_not_found')
      return result({
        goalId,
        evaluatedAt,
        reasons,
        risks,
        evidenceIds: [],
        planReceiptId: null,
        reviewerReceiptId: null,
        verificationWaived: false,
        factVersions: emptyFactVersions(),
        mutationPrecondition,
      })
    }

    try {
      facts = await readGateFacts(goal, options)
    } catch {
      appendReason(reasons, 'storage_recovery_required')
    }
    try {
      mutationPrecondition = mutations.inspect()
    } catch {
      appendReason(reasons, 'storage_recovery_required')
    }

    if (goal.contract.lockedAt === null)
      appendReason(reasons, 'contract_unlocked')
    if (goal.status !== 'active') appendReason(reasons, 'goal_not_active')
    if (goal.runtime.phase !== 'verifying')
      appendReason(reasons, 'goal_phase_not_verifying')

    const planReceipt = await this.readPlanReceipt(goal, options)
    const planMatchesCurrent = Boolean(
      planReceipt &&
      planReceipt.goalId === goal.id &&
      planReceipt.planId === goal.runtime.currentPlanId,
    )
    if (!planReceipt || !planMatchesCurrent || !planReceipt.planId) {
      appendReason(reasons, 'plan_missing')
    } else {
      if (
        !verifyGoalPlanCompletionReceiptIntegrity(planReceipt) ||
        planReceipt.approvalGeneration < 1 ||
        planReceipt.completed !== true ||
        planReceipt.invalidReasons.length > 0 ||
        planReceipt.assessmentStatus === 'waiting_approval' ||
        planReceipt.assessmentStatus === 'executing' ||
        planReceipt.assessmentStatus === 'invalid'
      )
        appendReason(reasons, 'plan_not_completed')
      for (const step of planReceipt.steps) {
        if (step.status === 'pending' || step.status === 'active')
          appendReason(reasons, 'plan_step_incomplete', {
            planStepId: step.id,
          })
        else if (step.status === 'failed')
          appendReason(reasons, 'plan_step_failed', {
            planStepId: step.id,
          })
        else if (step.status === 'blocked')
          appendReason(reasons, 'plan_step_blocked', {
            planStepId: step.id,
          })
        else if (step.status === 'skipped' && !step.waiverReceiptId)
          appendReason(reasons, 'plan_step_skipped_without_waiver', {
            planStepId: step.id,
          })
        if (!step.requiredVerificationComplete)
          appendReason(reasons, 'plan_verification_incomplete', {
            planStepId: step.id,
          })
      }
      if (
        planReceipt.invalidReasons.includes(
          'required_verification_incomplete',
        ) &&
        !reasons.some(
          (reason) => reason.code === 'plan_verification_incomplete',
        )
      )
        appendReason(reasons, 'plan_verification_incomplete')
      if (planReceipt.executionBlocked)
        appendReason(reasons, 'plan_quarantined')
      if (planReceipt.hasIncompleteIntent)
        appendReason(reasons, 'plan_intent_incomplete')
    }

    const evidenceIds: string[] = []
    for (const criterion of goal.contract.acceptanceCriteria) {
      const evidenceId = goal.latestEvidenceByCriterion[criterion.id]
      if (!evidenceId) {
        if (criterion.required)
          appendReason(reasons, 'criterion_missing_evidence', {
            criterionId: criterion.id,
          })
        else
          risks.push({
            code: 'optional_criterion_missing_evidence',
            criterionId: criterion.id,
          })
        continue
      }
      let evidence: GoalEvidenceFact | null = null
      try {
        evidence = await options.evidenceLedger.validatedEvidenceById(
          goal.id,
          evidenceId,
        )
      } catch {
        evidence = null
      }
      if (
        !evidence ||
        evidence.id !== evidenceId ||
        evidence.goalId !== goal.id ||
        evidence.criterionId !== criterion.id
      ) {
        if (criterion.required)
          appendReason(reasons, 'criterion_evidence_invalid', {
            criterionId: criterion.id,
          })
        else
          risks.push({
            code: 'optional_criterion_evidence_invalid',
            criterionId: criterion.id,
          })
        continue
      }
      evidenceIds.push(evidence.id)
      if (evidence.verdict === 'fail') {
        if (criterion.required)
          appendReason(reasons, 'criterion_latest_failed', {
            criterionId: criterion.id,
          })
        else
          risks.push({
            code: 'optional_criterion_latest_failed',
            criterionId: criterion.id,
          })
      }
    }

    let reviewerDecision: GoalReviewerDecision | null = null
    let reviewerReceiptId: string | null = null
    let verificationWaived = false
    if (planReceipt?.reviewer.required) {
      try {
        reviewerDecision = await options.reviewerLedger.latestReviewerDecision(
          goal.id,
          goal,
        )
      } catch {
        reviewerDecision = null
      }
      const exact = Boolean(
        reviewerDecision &&
        reviewerDecision.goalId === goal.id &&
        reviewerDecision.planId === planReceipt.planId &&
        reviewerDecision.planEventSeq === planReceipt.planEventSeq,
      )
      if (exact && reviewerDecision!.verdict === 'fail') {
        reviewerReceiptId = reviewerDecision!.id
        appendReason(reasons, 'independent_verification_failed')
      } else if (
        exact &&
        (reviewerDecision!.verdict === 'pass' ||
          reviewerDecision!.verdict === 'waived') &&
        planReceipt.reviewer.satisfied
      ) {
        reviewerReceiptId = reviewerDecision!.id
        verificationWaived = reviewerDecision!.verdict === 'waived'
        if (verificationWaived)
          risks.push({ code: 'independent_verification_waived' })
      } else {
        appendReason(reasons, 'independent_verification_missing')
      }
    }

    const runtime = facts?.runtime ?? null
    if (
      !runtime ||
      goal.runtime.pendingInteractionId !== null ||
      runtime.value.pendingInteractionId !== null
    )
      appendReason(reasons, 'pending_interaction')

    const scope = facts?.scope ?? null
    if (
      !scope ||
      scope.value.matches !== true ||
      (planReceipt !== null && !planReceipt.scopeMatches) ||
      !planMatchesCurrent
    )
      appendReason(reasons, 'scope_mismatch')

    const storage = facts?.storage ?? null
    if (!storage || storage.value.healthy !== true)
      appendReason(reasons, 'storage_recovery_required')

    const constraints = facts?.hardConstraints ?? null
    if (!constraints || constraints.value.satisfied !== true)
      appendReason(reasons, 'hard_constraint_violation')

    const cost = facts?.cost ?? null
    const estimatedCostUsd = cost?.value.estimatedCostUsd ?? null
    if (!cost || guardExceeded(goal, evaluatedAt, estimatedCostUsd))
      appendReason(reasons, 'guard_policy_exceeded')

    return result({
      goalId: goal.id,
      evaluatedAt,
      reasons,
      risks,
      evidenceIds,
      planReceiptId:
        planReceipt?.planId && planReceipt.planEventSeq > 0
          ? `plan:${planReceipt.planId}:${planReceipt.planEventSeq}:${planReceipt.approvalGeneration}:${planReceipt.integritySha256}`
          : null,
      reviewerReceiptId,
      verificationWaived,
      factVersions: {
        runtime: factVersion(runtime),
        control: factVersion(runtime),
        scope: factVersion(scope),
        storage: factVersion(storage),
        hardConstraints: factVersion(constraints),
        cost: factVersion(cost),
      },
      mutationPrecondition,
    })
  }

  async complete(goalIdValue: string): Promise<GoalCompletionResult> {
    const goalId = String(goalIdValue ?? '').trim()
    const options = trustedGoalCompletionGateOptions(this)
    const trustedEvaluator = new GoalCompletionGate(options)
    return GLOBAL_GOAL_COMPLETION_MUTEX.run(
      `${options.goalStore.goalsRoot}:${goalId}`,
      async () => {
        const first = await trustedEvaluator.evaluate(goalId)
        if (!first.pass)
          throw new GoalCompletionGateError(
            'goal_completion_gate_failed',
            'Goal completion gate did not pass.',
            first,
          )

        const snapshotInspection = await options.goalStore.inspect(goalId)
        const snapshot = snapshotInspection.record
        if (!snapshot || snapshotInspection.issue)
          throw new GoalCompletionGateError(
            'goal_not_found',
            'Goal does not exist.',
          )

        await options.beforeCompletionRecheck?.(snapshot)
        // Re-read every fact immediately before preparing the terminal CAS.
        const gate = await trustedEvaluator.evaluate(goalId)
        if (!gate.pass)
          throw new GoalCompletionGateError(
            'goal_completion_gate_failed',
            'Goal completion gate changed before terminal commit.',
            gate,
          )
        if (!gate.planReceiptId)
          throw new GoalCompletionGateError(
            'goal_completion_gate_failed',
            'Goal completion requires an exact Plan receipt.',
            gate,
          )
        if (!gate.mutationPrecondition)
          throw new GoalCompletionGateError(
            'storage_recovery_required',
            'Goal mutation precondition is unavailable.',
            gate,
          )

        const terminalAt = trustedNow(options)
        const receipt = completionReceipt(
          snapshot,
          gate,
          terminalAt,
          trustedCleanupObligations(snapshot, options),
        )
        const terminal = assertGoalTransition(snapshot, {
          ...snapshot,
          status: 'completed',
          runtime: {
            ...snapshot.runtime,
            phase: 'terminal',
            currentRunId: null,
            pendingInteractionId: null,
            pauseReason: null,
          },
          terminalAt,
          updatedAt: maxTimestamp(snapshot.updatedAt, terminalAt),
        })

        await options.beforeCompletionWrite?.(snapshot)
        const goal = await commitAuthorizedGoalTerminal(
          this,
          goalId,
          'goal_completed',
          {
            record: terminal,
            expectedLastEventSeq: snapshot.lastEventSeq,
            createdAt: terminalAt,
            data: { completionReceipt: receipt as unknown as never },
            mutationPrecondition: gate.mutationPrecondition,
            validatePrecondition: () =>
              validateTrustedCompletionPrecondition(snapshot, gate, options),
          },
        )
        const failures = await this.runPostCommit(
          goal,
          receipt,
          terminalAt,
          options,
        )
        return deepFreeze({
          goal,
          gate,
          receipt,
          postCommitFailures: failures,
        })
      },
    )
  }

  async blockGoal(
    goalIdValue: string,
    input: GoalBlockInput,
    blockerFactVersionValue: string,
  ): Promise<GoalRecord> {
    const goalId = String(goalIdValue ?? '').trim()
    const blockerFactVersion = String(blockerFactVersionValue ?? '').trim()
    const options = trustedGoalCompletionGateOptions(this)
    return GLOBAL_GOAL_COMPLETION_MUTEX.run(
      `${options.goalStore.goalsRoot}:${goalId}`,
      async () => {
        if (!isGoalBlockerCode((input as { code?: unknown })?.code))
          throw new GoalCompletionGateError(
            'goal_block_reason_invalid',
            'Goal blocker code is invalid.',
          )
        const reason = normalizeGoalBlockReason(input.reason)
        const first = await this.refreshBlockSnapshot(goalId, options)
        const { goal, runtime, storage, blockerFact: fact } = first
        if (!runtime || !storage || storage.value.healthy !== true)
          throw new GoalCompletionGateError(
            'goal_block_control_untrusted',
            'Goal blocking requires a versioned Core Control fact.',
          )
        if (hasAnswerableRuntime(goal, runtime))
          throw new GoalCompletionGateError(
            'goal_block_interaction_answerable',
            'Resolve the active Control interaction before blocking the Goal.',
          )
        const reasonSha256 = goalBlockReasonSha256(reason)
        if (
          !exactBlockerFact(fact, goal, input, reasonSha256, blockerFactVersion)
        )
          throw new GoalCompletionGateError(
            'goal_blocker_fact_untrusted',
            'Goal blocking requires an exact trusted Core blocker fact.',
          )

        // Refresh Goal and external facts once more immediately before CAS.
        await options.beforeBlockerRecheck?.()
        const current = await this.refreshBlockSnapshot(goalId, options)
        const currentGoal = current.goal
        if (
          currentGoal.status !== 'active' ||
          currentGoal.lastEventSeq !== goal.lastEventSeq
        )
          throw new GoalCompletionGateError(
            'goal_not_active',
            'Goal changed before it could be blocked.',
          )
        const currentRuntime = current.runtime
        const currentStorage = current.storage
        if (
          !currentRuntime ||
          !currentStorage ||
          runtime.version !== currentRuntime.version ||
          storage.version !== currentStorage.version ||
          currentStorage.value.healthy !== true ||
          hasAnswerableRuntime(currentGoal, currentRuntime)
        )
          throw new GoalCompletionGateError(
            'goal_terminal_precondition_conflict',
            'Control facts changed before Goal block commit.',
          )
        const currentFact = current.blockerFact
        if (
          !exactBlockerFact(
            currentFact,
            currentGoal,
            input,
            reasonSha256,
            blockerFactVersion,
          ) ||
          !sameBlockerFact(fact, currentFact)
        )
          throw new GoalCompletionGateError(
            'goal_terminal_precondition_conflict',
            'Goal blocker fact changed before terminal commit.',
          )

        const mutationPrecondition = current.mutationPrecondition

        const terminalAt = trustedNow(options)
        const terminal = assertGoalTransition(currentGoal, {
          ...currentGoal,
          status: 'blocked',
          runtime: {
            ...currentGoal.runtime,
            phase: 'terminal',
            currentRunId: null,
            pendingInteractionId: null,
            pauseReason: null,
          },
          terminalAt,
          updatedAt: maxTimestamp(currentGoal.updatedAt, terminalAt),
        })
        return await commitAuthorizedGoalTerminal(
          this,
          currentGoal.id,
          'goal_blocked',
          {
            record: terminal,
            expectedLastEventSeq: currentGoal.lastEventSeq,
            createdAt: terminalAt,
            data: {
              blockerReceipt: {
                code: input.code,
                reason,
                factVersion: currentFact.version,
                reasonSha256: currentFact.reasonSha256,
                evidenceReceiptId: currentFact.evidenceReceiptId,
                evidenceVersion: currentFact.evidenceVersion,
                source: 'core',
                createdAt: terminalAt,
              },
            },
            mutationPrecondition,
            validatePrecondition: async () => {
              await options.beforeBlockerTerminalValidation?.()
              const facts = await readGateFacts(currentGoal, options)
              const runtimeFact = facts.runtime
              const storageFact = facts.storage
              const blockerFact = options.blockerFactStore.inspect(currentGoal)
              if (
                !runtimeFact ||
                !storageFact ||
                currentRuntime.version !== runtimeFact.version ||
                currentStorage.version !== storageFact.version ||
                storageFact.value.healthy !== true ||
                hasAnswerableRuntime(currentGoal, runtimeFact) ||
                !exactBlockerFact(
                  blockerFact,
                  currentGoal,
                  input,
                  reasonSha256,
                  blockerFactVersion,
                ) ||
                !sameBlockerFact(currentFact, blockerFact)
              )
                throw new GoalCompletionGateError(
                  'goal_terminal_precondition_conflict',
                  'Control or blocker facts changed before Goal block commit.',
                )
            },
          },
        )
      },
    )
  }

  private async refreshBlockSnapshot(
    goalId: string,
    options: GoalCompletionGateOptions,
  ): Promise<{
    readonly goal: GoalRecord
    readonly runtime: GoalGateFactRecord<'runtime'> | null
    readonly storage: GoalGateFactRecord<'storage'> | null
    readonly blockerFact: GoalBlockerFact | null
    readonly mutationPrecondition: GoalGateMutationSnapshot
  }> {
    const mutations = new GoalGateMutationLedger(options.goalStore.stateRoot)
    try {
      return await mutations.guard.runExclusive('mutation', async () => {
        const inspection = await options.goalStore.inspect(goalId)
        const goal = inspection.record
        if (!goal || inspection.issue)
          throw new GoalCompletionGateError(
            goal ? 'storage_recovery_required' : 'goal_not_found',
            goal
              ? 'Goal storage requires recovery before blocking.'
              : 'Goal does not exist.',
          )
        if (goal.status !== 'active')
          throw new GoalCompletionGateError(
            'goal_not_active',
            'Only an active Goal can be blocked.',
          )
        const facts = await readGateFacts(goal, options)
        return Object.freeze({
          goal,
          runtime: facts.runtime,
          storage: facts.storage,
          blockerFact: options.blockerFactStore.inspect(goal),
          mutationPrecondition: mutations.inspect(),
        })
      })
    } catch (error) {
      if (error instanceof GoalCompletionGateError) throw error
      throw new GoalCompletionGateError(
        'storage_recovery_required',
        'Goal blocker facts could not be read atomically.',
      )
    }
  }

  private async runPostCommit(
    goal: GoalRecord,
    receipt: GoalCompletionReceipt,
    occurredAt: string,
    options: GoalCompletionGateOptions,
  ): Promise<GoalPostCommitFailure[]> {
    const failures: GoalPostCommitFailure[] = []
    const diagnostics = trustedDiagnostics(options)
    const journal = trustedCleanupJournal(options)
    for (const obligation of receipt.cleanupObligations) {
      const code = cleanupFailureCode(obligation.obligation)
      try {
        await this.executeClaimedCleanup(
          goal,
          receipt,
          obligation,
          options,
          journal,
        )
      } catch {
        failures.push({ code })
        try {
          await diagnostics.append({
            goalId: goal.id,
            code,
            occurredAt,
          })
        } catch {
          if (
            !failures.some(
              (failure) => failure.code === 'diagnostic_persist_failed',
            )
          )
            failures.push({ code: 'diagnostic_persist_failed' })
          await diagnostics
            .markRecoveryRequired({ goalId: goal.id, code, occurredAt })
            .catch(() => {})
        }
        try {
          await options.recordDiagnostic?.({
            goalId: goal.id,
            code,
            occurredAt,
          })
        } catch {
          // Optional observers cannot affect the required durable journal.
        }
      }
    }
    return failures
  }

  async recoverPostCommitCleanup(): Promise<GoalCleanupRecoveryResult> {
    const options = trustedGoalCompletionGateOptions(this)
    const cleanupJournal = trustedCleanupJournal(options)
    // Claims serialize live workers, but recovery remains deliberately
    // at-least-once across process crashes. Cleanup hosts use the stable
    // execution context to make their side effects idempotent.
    return await GLOBAL_GOAL_COMPLETION_MUTEX.run(
      `${options.goalStore.goalsRoot}:cleanup-recovery`,
      async () => {
        const inspection = await cleanupJournal.inspect()
        const acknowledged = new Set(
          inspection.acknowledgements.map(
            (item) => `${item.receiptId}:${item.obligation}`,
          ),
        )
        let pending = 0
        let recovered = 0
        let failed = 0
        const goals = await options.goalStore.list()
        for (const goal of goals) {
          if (goal.status !== 'completed') continue
          let receipt: GoalCompletionReceipt | null = null
          try {
            const events = await options.goalStore.readEventsReadonly(goal.id)
            const raw = [...events]
              .reverse()
              .find((event) => event.type === 'goal_completed')
              ?.payload.completionReceipt
            receipt = parseCompletionReceipt(raw)
          } catch {
            receipt = null
          }
          if (!receipt) continue
          for (const obligation of receipt.cleanupObligations) {
            const key = `${receipt.id}:${obligation.obligation}`
            if (!inspection.issue && acknowledged.has(key)) continue
            pending += 1
            try {
              const executed = await this.executeClaimedCleanup(
                goal,
                receipt,
                obligation,
                options,
                cleanupJournal,
              )
              if (executed) recovered += 1
            } catch {
              failed += 1
            }
          }
        }
        return {
          pending,
          recovered,
          failed,
          journalCorrupt: inspection.issue !== null,
        }
      },
    )
  }

  private async executeCleanupObligation(
    goal: GoalRecord,
    receipt: GoalCompletionReceipt,
    obligation: GoalCleanupObligationRecord,
    options: GoalCompletionGateOptions,
  ): Promise<void> {
    switch (obligation.obligation) {
      case 'revoke_plan_tokens':
        if (!options.cleanup?.revokePlanTokens)
          throw new Error('Plan token cleanup is unavailable.')
        await options.cleanup.revokePlanTokens(
          obligation.targetId,
          cleanupExecutionContext(goal, receipt, obligation.obligation),
        )
        return
      case 'clear_active_run':
        if (!options.cleanup?.clearActiveRun)
          throw new Error('Active run cleanup is unavailable.')
        await options.cleanup.clearActiveRun(
          goal,
          obligation.targetId,
          cleanupExecutionContext(goal, receipt, obligation.obligation),
        )
        return
      case 'clear_pending_interaction':
        if (!options.cleanup?.clearPendingInteraction)
          throw new Error('Pending interaction cleanup is unavailable.')
        await options.cleanup.clearPendingInteraction(
          goal,
          obligation.targetId,
          cleanupExecutionContext(goal, receipt, obligation.obligation),
        )
        return
      case 'emit_runtime_event':
        if (!options.emitRuntimeEvent)
          throw new Error('Runtime event emitter is unavailable.')
        await options.emitRuntimeEvent({
          type: 'goal_completed',
          goalId: goal.id,
          receiptId: receipt.id,
          occurredAt: receipt.createdAt,
        })
    }
  }

  private async executeClaimedCleanup(
    goal: GoalRecord,
    receipt: GoalCompletionReceipt,
    obligation: GoalCleanupObligationRecord,
    options: GoalCompletionGateOptions,
    journal: GoalCleanupJournal,
  ): Promise<boolean> {
    const inspected = await journal.inspect()
    if (inspected.issue)
      throw new Error('Goal cleanup acknowledgement journal is corrupt.')
    if (cleanupAcknowledged(inspected, receipt.id, obligation.obligation))
      return false
    const claim = await journal.claim({
      receiptId: receipt.id,
      obligation: obligation.obligation,
    })
    if (!claim) return false
    try {
      const refreshed = await journal.inspect()
      if (refreshed.issue)
        throw new Error('Goal cleanup acknowledgement journal is corrupt.')
      if (cleanupAcknowledged(refreshed, receipt.id, obligation.obligation))
        return false
      await this.executeCleanupObligation(goal, receipt, obligation, options)
      await journal.acknowledge({
        goalId: goal.id,
        receiptId: receipt.id,
        obligation: obligation.obligation,
        acknowledgedAt: trustedNow(options),
      })
      return true
    } finally {
      await journal.releaseClaim(claim)
    }
  }

  private async readPlanReceipt(
    goal: GoalRecord,
    options: GoalCompletionGateOptions,
  ): Promise<GoalPlanCompletionReceipt | null> {
    try {
      return await options.planBridge.planCompletionReceipt(goal.id, goal)
    } catch {
      return null
    }
  }
}

function trustedNow(options: GoalCompletionGateOptions): string {
  return options.now?.() ?? new Date().toISOString()
}

function trustedCleanupJournal(
  options: GoalCompletionGateOptions,
): GoalCleanupJournal {
  return new GoalCleanupJournal(options.goalStore.stateRoot, {
    beforeAppend: options.beforeCleanupAck,
    onClaimTrace: options.onCleanupClaimTrace,
  })
}

function trustedDiagnostics(
  options: GoalCompletionGateOptions,
): GoalPostCommitDiagnosticsStore {
  return new GoalPostCommitDiagnosticsStore(options.goalStore.stateRoot, {
    beforeAppend: options.beforeDiagnosticAppend,
  })
}

function cleanupAcknowledged(
  inspection: Awaited<ReturnType<GoalCleanupJournal['inspect']>>,
  receiptId: string,
  obligation: GoalCleanupObligation,
): boolean {
  return Boolean(
    !inspection.issue &&
    inspection.acknowledgements.some(
      (item) => item.receiptId === receiptId && item.obligation === obligation,
    ),
  )
}

function cleanupFailureCode(
  obligation: GoalCleanupObligation,
): GoalPostCommitActionFailureCode {
  switch (obligation) {
    case 'revoke_plan_tokens':
      return 'plan_token_revoke_failed'
    case 'clear_active_run':
      return 'active_run_clear_failed'
    case 'clear_pending_interaction':
      return 'pending_interaction_clear_failed'
    case 'emit_runtime_event':
      return 'runtime_event_emit_failed'
  }
}

function trustedCleanupObligations(
  goal: GoalRecord,
  options: GoalCompletionGateOptions,
): GoalCleanupObligationRecord[] {
  const obligations: GoalCleanupObligationRecord[] = []
  if (goal.runtime.currentPlanId && options.cleanup?.revokePlanTokens)
    obligations.push({
      obligation: 'revoke_plan_tokens',
      targetId: goal.runtime.currentPlanId,
    })
  if (options.cleanup?.clearActiveRun)
    obligations.push({
      obligation: 'clear_active_run',
      targetId: goal.runtime.currentRunId ?? goal.id,
    })
  if (options.cleanup?.clearPendingInteraction)
    obligations.push({
      obligation: 'clear_pending_interaction',
      targetId: goal.runtime.pendingInteractionId ?? goal.id,
    })
  if (options.emitRuntimeEvent)
    obligations.push({
      obligation: 'emit_runtime_event',
      targetId: goal.id,
    })
  return obligations
}

async function validateTrustedCompletionPrecondition(
  goal: GoalRecord,
  gate: GoalGateResult,
  options: GoalCompletionGateOptions,
): Promise<void> {
  const [plan, facts] = await Promise.all([
    readTrustedPlanReceipt(goal, options),
    safeFact(() => readGateFacts(goal, options)),
  ])
  const runtime = facts?.runtime ?? null
  const scope = facts?.scope ?? null
  const storage = facts?.storage ?? null
  const constraints = facts?.hardConstraints ?? null
  const cost = facts?.cost ?? null
  const current = {
    planReceiptId:
      plan?.planId && plan.planEventSeq > 0
        ? `plan:${plan.planId}:${plan.planEventSeq}:${plan.approvalGeneration}:${plan.integritySha256}`
        : null,
    runtime: factVersion(runtime),
    control: factVersion(runtime),
    scope: factVersion(scope),
    storage: factVersion(storage),
    hardConstraints: factVersion(constraints),
    cost: factVersion(cost),
  }
  const expected = {
    planReceiptId: gate.planReceiptId,
    ...gate.factVersions,
  }
  if (!plan)
    throw new GoalCompletionGateError(
      'goal_terminal_precondition_conflict',
      'Goal Plan receipt became unavailable before terminal commit.',
    )
  if (
    canonicalJson(current) !== canonicalJson(expected) ||
    !runtime ||
    runtime.value.pendingInteractionId !== null ||
    !scope ||
    scope.value.matches !== true ||
    !storage ||
    storage.value.healthy !== true ||
    !constraints ||
    constraints.value.satisfied !== true ||
    !cost ||
    (goal.guardPolicy.maxEstimatedCostUsd !== null &&
      (cost.value.estimatedCostUsd === null ||
        cost.value.estimatedCostUsd >= goal.guardPolicy.maxEstimatedCostUsd)) ||
    plan.completed !== true ||
    plan.invalidReasons.length > 0
  )
    throw new GoalCompletionGateError(
      'goal_terminal_precondition_conflict',
      'Gate-sensitive facts changed before terminal commit.',
    )
}

async function readTrustedPlanReceipt(
  goal: GoalRecord,
  options: GoalCompletionGateOptions,
): Promise<GoalPlanCompletionReceipt | null> {
  try {
    return await options.planBridge.planCompletionReceipt(goal.id, goal)
  } catch {
    return null
  }
}

function isGoalBlockerCode(value: unknown): value is GoalBlockerCode {
  return (
    value === 'external_dependency' ||
    value === 'missing_permission' ||
    value === 'missing_access' ||
    value === 'unrecoverable_ambiguity' ||
    value === 'safety_policy'
  )
}

function hasAnswerableRuntime(
  goal: GoalRecord,
  fact: GoalGateFactRecord<'runtime'> | null,
): boolean {
  return Boolean(
    goal.runtime.pendingInteractionId !== null ||
    (fact?.value.directlyAnswerable === true &&
      fact.value.pendingInteractionId !== null),
  )
}

function exactBlockerFact(
  fact: GoalBlockerFact | null,
  goal: GoalRecord,
  input: GoalBlockInput,
  reasonSha256: string,
  blockerFactVersion: string,
): fact is GoalBlockerFact {
  return Boolean(
    fact &&
    fact.kind === 'core_goal_blocker' &&
    fact.goalId === goal.id &&
    fact.goalEventSeq === goal.lastEventSeq &&
    fact.code === input.code &&
    fact.blocking === true &&
    fact.source === 'core' &&
    fact.reasonSha256 === reasonSha256 &&
    fact.version === blockerFactVersion &&
    fact.evidenceReceiptId.trim() &&
    fact.evidenceVersion.trim(),
  )
}

function sameBlockerFact(
  left: GoalBlockerFact,
  right: GoalBlockerFact,
): boolean {
  return (
    left.version === right.version &&
    left.integritySha256 === right.integritySha256 &&
    left.goalId === right.goalId &&
    left.goalEventSeq === right.goalEventSeq &&
    left.code === right.code &&
    left.reasonSha256 === right.reasonSha256 &&
    left.evidenceReceiptId === right.evidenceReceiptId &&
    left.evidenceVersion === right.evidenceVersion &&
    left.blocking === right.blocking &&
    left.source === right.source
  )
}

function completionReceipt(
  goal: GoalRecord,
  gate: GoalGateResult,
  createdAt: string,
  cleanupObligations: readonly GoalCleanupObligationRecord[],
): GoalCompletionReceipt {
  const base: Omit<GoalCompletionReceipt, 'integritySha256'> = {
    schemaVersion: GOAL_COMPLETION_RECEIPT_SCHEMA_VERSION,
    id: `completion_${goal.id}_${goal.lastEventSeq + 1}`,
    goalId: goal.id,
    goalEventSeq: goal.lastEventSeq + 1,
    planReceiptId: gate.planReceiptId!,
    reviewerReceiptId: gate.reviewerReceiptId,
    evidenceIds: [...gate.evidenceIds],
    verificationWaived: gate.verificationWaived,
    riskDisclosures: gate.riskDisclosures.map((risk) => ({ ...risk })),
    factVersions: { ...gate.factVersions },
    mutationEpoch: gate.mutationPrecondition!.epoch,
    mutationVersions: { ...gate.mutationPrecondition!.versions },
    cleanupObligations: cleanupObligations.map((item) => ({ ...item })),
    createdAt,
  }
  return deepFreeze({
    ...base,
    integritySha256: createHash('sha256')
      .update(canonicalJson(base), 'utf8')
      .digest('hex'),
  })
}

function cleanupExecutionContext(
  goal: GoalRecord,
  receipt: GoalCompletionReceipt,
  obligation: GoalCleanupObligation,
): GoalCleanupExecutionContext {
  return Object.freeze({
    receiptId: receipt.id,
    goalId: goal.id,
    obligation,
  })
}

function parseCompletionReceipt(value: unknown): GoalCompletionReceipt | null {
  if (!isRecord(value) || !Array.isArray(value.cleanupObligations)) return null
  const obligations: GoalCleanupObligationRecord[] = []
  const seen = new Set<GoalCleanupObligation>()
  for (const raw of value.cleanupObligations) {
    if (!isRecord(raw)) return null
    const obligation = raw.obligation
    if (
      obligation !== 'revoke_plan_tokens' &&
      obligation !== 'clear_active_run' &&
      obligation !== 'clear_pending_interaction' &&
      obligation !== 'emit_runtime_event'
    )
      return null
    const targetId = String(raw.targetId ?? '').trim()
    if (!targetId || seen.has(obligation)) return null
    seen.add(obligation)
    obligations.push({ obligation, targetId })
  }
  const integritySha256 = String(value.integritySha256 ?? '')
  const base = { ...value } as Record<string, unknown>
  delete base.integritySha256
  if (
    !/^[a-f0-9]{64}$/.test(integritySha256) ||
    createHash('sha256').update(canonicalJson(base), 'utf8').digest('hex') !==
      integritySha256
  )
    return null
  return deepFreeze({
    ...(value as unknown as GoalCompletionReceipt),
    cleanupObligations: obligations,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function safeFact<T>(read: () => T | Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

async function readGateFacts(
  goal: GoalRecord,
  options: GoalCompletionGateOptions,
): Promise<GoalGateFactBundle> {
  return options.inspectLiveFacts
    ? await options.inspectLiveFacts(goal)
    : options.factStore.inspectBundle(goal)
}

function guardExceeded(
  goal: GoalRecord,
  evaluatedAt: string,
  estimatedCostUsd: number | null,
): boolean {
  const policy = goal.guardPolicy
  return Boolean(
    (policy.maxCycles !== null &&
      goal.runtime.cyclesUsed >= policy.maxCycles) ||
    (policy.deadlineAt !== null &&
      Date.parse(evaluatedAt) >= Date.parse(policy.deadlineAt)) ||
    (policy.maxEstimatedCostUsd !== null &&
      (estimatedCostUsd === null ||
        estimatedCostUsd >= policy.maxEstimatedCostUsd)),
  )
}

function appendReason(
  reasons: GoalGateReason[],
  code: GoalGateReasonCode,
  detail: Pick<GoalGateReason, 'criterionId' | 'planStepId'> = {},
): void {
  const candidate: GoalGateReason = {
    code,
    message: REASON_MESSAGES[code],
    ...(detail.criterionId ? { criterionId: detail.criterionId } : {}),
    ...(detail.planStepId ? { planStepId: detail.planStepId } : {}),
  }
  if (
    reasons.some(
      (item) =>
        item.code === candidate.code &&
        item.criterionId === candidate.criterionId &&
        item.planStepId === candidate.planStepId,
    )
  )
    return
  reasons.push(candidate)
}

const REASON_MESSAGES: Readonly<Record<GoalGateReasonCode, string>> = {
  goal_not_found: 'Goal does not exist.',
  goal_not_active: 'Goal is not active.',
  goal_phase_not_verifying: 'Goal is not in the verifying phase.',
  contract_unlocked: 'Goal contract is not locked.',
  plan_missing: 'Current Goal Plan is missing.',
  plan_not_completed: 'Current Goal Plan is not completed.',
  plan_step_incomplete: 'A Goal Plan step is incomplete.',
  plan_step_failed: 'A Goal Plan step failed.',
  plan_step_blocked: 'A Goal Plan step is blocked.',
  plan_step_skipped_without_waiver:
    'A Goal Plan step was skipped without an explicit user waiver.',
  plan_verification_incomplete:
    'Required Goal Plan verification is incomplete.',
  plan_quarantined: 'Current Goal Plan is quarantined.',
  plan_intent_incomplete: 'Current Goal Plan has an incomplete durable intent.',
  criterion_missing_evidence:
    'A required acceptance criterion has no evidence.',
  criterion_latest_failed:
    'Latest evidence for a required acceptance criterion failed.',
  criterion_evidence_invalid:
    'Latest evidence for a required acceptance criterion is invalid.',
  independent_verification_missing:
    'Required independent verification is missing.',
  independent_verification_failed: 'Latest independent verification failed.',
  pending_interaction: 'A Control interaction is still pending.',
  scope_mismatch: 'Current execution scope does not match the Goal.',
  storage_recovery_required: 'Goal storage requires recovery.',
  hard_constraint_violation: 'A hard Goal constraint is not satisfied.',
  guard_policy_exceeded: 'Goal guard policy is exceeded.',
}

const REASON_CODE_ORDER: readonly GoalGateReasonCode[] = [
  'goal_not_found',
  'goal_not_active',
  'goal_phase_not_verifying',
  'contract_unlocked',
  'plan_missing',
  'plan_not_completed',
  'plan_step_incomplete',
  'plan_step_failed',
  'plan_step_blocked',
  'plan_step_skipped_without_waiver',
  'plan_verification_incomplete',
  'plan_quarantined',
  'plan_intent_incomplete',
  'criterion_missing_evidence',
  'criterion_latest_failed',
  'criterion_evidence_invalid',
  'independent_verification_missing',
  'independent_verification_failed',
  'pending_interaction',
  'scope_mismatch',
  'storage_recovery_required',
  'hard_constraint_violation',
  'guard_policy_exceeded',
]

const REASON_CODE_RANK = new Map(
  REASON_CODE_ORDER.map((code, rank) => [code, rank]),
)

const RISK_CODE_ORDER: readonly GoalGateRiskCode[] = [
  'optional_criterion_missing_evidence',
  'optional_criterion_latest_failed',
  'optional_criterion_evidence_invalid',
  'independent_verification_waived',
]

const RISK_CODE_RANK = new Map(
  RISK_CODE_ORDER.map((code, rank) => [code, rank]),
)

function result(input: {
  goalId: string
  evaluatedAt: string
  reasons: GoalGateReason[]
  risks: GoalGateRiskDisclosure[]
  evidenceIds: string[]
  planReceiptId: string | null
  reviewerReceiptId: string | null
  verificationWaived: boolean
  factVersions: GoalGateFactVersions
  mutationPrecondition: GoalGateMutationSnapshot | null
}): GoalGateResult {
  const reasons = [...input.reasons].sort(
    (left, right) =>
      (REASON_CODE_RANK.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
        (REASON_CODE_RANK.get(right.code) ?? Number.MAX_SAFE_INTEGER) ||
      (left.criterionId ?? '').localeCompare(right.criterionId ?? '') ||
      (left.planStepId ?? '').localeCompare(right.planStepId ?? '') ||
      left.message.localeCompare(right.message),
  )
  const risks = [...input.risks].sort(
    (left, right) =>
      (RISK_CODE_RANK.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
        (RISK_CODE_RANK.get(right.code) ?? Number.MAX_SAFE_INTEGER) ||
      (left.criterionId ?? '').localeCompare(right.criterionId ?? ''),
  )
  return deepFreeze({
    pass: reasons.length === 0,
    goalId: input.goalId,
    evaluatedAt: input.evaluatedAt,
    reasons,
    evidenceIds: [...new Set(input.evidenceIds)].sort(),
    planReceiptId: input.planReceiptId,
    reviewerReceiptId: input.reviewerReceiptId,
    verificationWaived: input.verificationWaived,
    riskDisclosures: risks,
    factVersions: input.factVersions,
    mutationPrecondition: input.mutationPrecondition,
  })
}

function emptyFactVersions(): GoalGateFactVersions {
  return {
    runtime: null,
    control: null,
    scope: null,
    storage: null,
    hardConstraints: null,
    cost: null,
  }
}

function validFactVersion(fact: GoalGateVersionedFact): boolean {
  return typeof fact.version === 'string' && fact.version.trim().length > 0
}

function factVersion(fact: GoalGateVersionedFact | null): string | null {
  return fact && validFactVersion(fact) ? fact.version : null
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value))
    return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function maxTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right
}

class AsyncKeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent
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

const GLOBAL_GOAL_COMPLETION_MUTEX = new AsyncKeyedMutex()
