import type { JsonObject } from '../events'
import type { GoalGateFactBundle } from '../gate-facts'
import type { GoalBlockerFact } from '../blocker-facts'
import type {
  GoalCleanupAcknowledgement,
  GoalCleanupClaimTrace,
  GoalCleanupObligation,
} from '../cleanup-journal'
import type { GoalGateMutationSnapshot } from '../mutation-ledger'
import type { GoalGateReasonCode, GoalRecord } from '../models'
import type { GoalPlanCompletionReceipt } from './planning'

export interface GoalGateReason {
  readonly code: GoalGateReasonCode
  readonly message: string
  readonly criterionId?: string
  readonly planStepId?: string
}

export type GoalGateRiskCode =
  | 'optional_criterion_missing_evidence'
  | 'optional_criterion_latest_failed'
  | 'optional_criterion_evidence_invalid'
  | 'independent_verification_waived'

export interface GoalGateRiskDisclosure {
  readonly code: GoalGateRiskCode
  readonly criterionId?: string
}

export interface GoalGateFactVersions {
  readonly runtime: string | null
  /** @deprecated Runtime facts supersede the legacy Control resolver version. */
  readonly control: string | null
  readonly scope: string | null
  readonly storage: string | null
  readonly hardConstraints: string | null
  readonly cost: string | null
}

export interface GoalGateResult {
  readonly pass: boolean
  readonly goalId: string
  readonly evaluatedAt: string
  readonly reasons: readonly GoalGateReason[]
  readonly evidenceIds: readonly string[]
  readonly planReceiptId: string | null
  readonly reviewerReceiptId: string | null
  readonly verificationWaived: boolean
  readonly riskDisclosures: readonly GoalGateRiskDisclosure[]
  readonly factVersions: GoalGateFactVersions
  readonly mutationPrecondition: GoalGateMutationSnapshot | null
}

export const GOAL_COMPLETION_RECEIPT_SCHEMA_VERSION =
  'emperor.goal.completion-receipt.v1' as const

export interface GoalCompletionReceipt {
  readonly schemaVersion: typeof GOAL_COMPLETION_RECEIPT_SCHEMA_VERSION
  readonly id: string
  readonly goalId: string
  readonly goalEventSeq: number
  readonly planReceiptId: string
  readonly reviewerReceiptId: string | null
  readonly evidenceIds: readonly string[]
  readonly verificationWaived: boolean
  readonly riskDisclosures: readonly GoalGateRiskDisclosure[]
  readonly factVersions: GoalGateFactVersions
  readonly mutationEpoch: number
  readonly mutationVersions: Readonly<Record<string, string>>
  readonly cleanupObligations: readonly GoalCleanupObligationRecord[]
  readonly createdAt: string
  readonly integritySha256: string
}

export type GoalPostCommitFailureCode =
  | 'plan_token_revoke_failed'
  | 'active_run_clear_failed'
  | 'pending_interaction_clear_failed'
  | 'runtime_event_emit_failed'
  | 'diagnostic_persist_failed'

export interface GoalPostCommitFailure {
  readonly code: GoalPostCommitFailureCode
}

export interface GoalCompletionResult {
  readonly goal: GoalRecord
  readonly gate: GoalGateResult
  readonly receipt: GoalCompletionReceipt
  readonly postCommitFailures: readonly GoalPostCommitFailure[]
}

export interface GoalCleanupExecutionContext {
  readonly receiptId: string
  readonly goalId: string
  readonly obligation: GoalCleanupObligation
}

export interface GoalCompletionCleanup {
  readonly revokePlanTokens?: (
    planId: string,
    context: GoalCleanupExecutionContext,
  ) => void | Promise<void>
  readonly clearActiveRun?: (
    goal: GoalRecord,
    runId: string,
    context: GoalCleanupExecutionContext,
  ) => void | Promise<void>
  readonly clearPendingInteraction?: (
    goal: GoalRecord,
    interactionId: string,
    context: GoalCleanupExecutionContext,
  ) => void | Promise<void>
}

export interface GoalCleanupObligationRecord {
  readonly obligation: GoalCleanupObligation
  readonly targetId: string
}

export interface GoalCleanupRecoveryResult {
  readonly pending: number
  readonly recovered: number
  readonly failed: number
  readonly journalCorrupt: boolean
}

export interface GoalPostCommitDiagnostic {
  readonly schemaVersion: 'emperor.goal.post-commit-diagnostic.v1'
  readonly id: string
  readonly goalId: string
  readonly code: Exclude<GoalPostCommitFailureCode, 'diagnostic_persist_failed'>
  readonly occurredAt: string
  readonly recordedAt: string
  readonly integritySha256: string
}

export interface GoalTerminalCommitInput {
  readonly record: GoalRecord
  readonly createdAt?: string
  readonly data?: Readonly<JsonObject>
  readonly expectedLastEventSeq: number
  readonly mutationPrecondition: GoalGateMutationSnapshot
  readonly validatePrecondition: () => void | Promise<void>
}

export interface GoalEvidenceFact {
  readonly id: string
  readonly goalId: string
  readonly criterionId: string
  readonly verdict: 'pass' | 'fail'
}

export interface GoalReviewerDecision {
  readonly id: string
  readonly goalId: string
  readonly planId: string
  readonly planEventSeq: number
  readonly verdict: 'pass' | 'fail' | 'waived'
}

export interface GoalRepositoryPort {
  readonly stateRoot: string
  readonly goalsRoot: string
  inspect(goalId: string): Promise<{
    readonly record: GoalRecord | null
    readonly issue: unknown | null
  }>
  get(goalId: string): Promise<GoalRecord | null>
  list(): Promise<GoalRecord[]>
  readEventsReadonly(goalId: string): Promise<
    readonly {
      readonly type: string
      readonly payload: Record<string, unknown>
    }[]
  >
}

export interface GoalCompletionGateOptions {
  readonly goalStore: GoalRepositoryPort
  readonly planBridge: {
    planCompletionReceipt(
      goalId: string,
      knownGoal?: GoalRecord | null,
    ): Promise<GoalPlanCompletionReceipt>
  }
  readonly evidenceLedger: {
    validatedEvidenceById(
      goalId: string,
      evidenceId: string,
    ): Promise<GoalEvidenceFact | null>
  }
  readonly reviewerLedger: {
    latestReviewerDecision(
      goalId: string,
      knownGoal?: GoalRecord | null,
    ): Promise<GoalReviewerDecision | null>
  }
  readonly factStore: {
    inspectBundle(goal: GoalRecord): GoalGateFactBundle
  }
  readonly blockerFactStore: {
    inspect(goal: GoalRecord): GoalBlockerFact | null
  }
  readonly inspectLiveFacts?: (
    goal: GoalRecord,
  ) => GoalGateFactBundle | Promise<GoalGateFactBundle>
  readonly cleanup?: GoalCompletionCleanup
  readonly emitRuntimeEvent?: (event: {
    readonly type: 'goal_completed'
    readonly goalId: string
    readonly receiptId: string
    readonly occurredAt: string
  }) => void | Promise<void>
  readonly recordDiagnostic?: (diagnostic: {
    readonly goalId: string
    readonly code: GoalPostCommitFailureCode
    readonly occurredAt: string
  }) => void | Promise<void>
  readonly beforeDiagnosticAppend?: (
    diagnostic: GoalPostCommitDiagnostic,
  ) => void | Promise<void>
  readonly beforeCleanupAck?: (
    acknowledgement: GoalCleanupAcknowledgement,
  ) => void | Promise<void>
  readonly onCleanupClaimTrace?: (trace: GoalCleanupClaimTrace) => void
  readonly beforeCompletionWrite?: (goal: GoalRecord) => void | Promise<void>
  readonly beforeCompletionRecheck?: (goal: GoalRecord) => void | Promise<void>
  readonly beforeBlockerRecheck?: () => void | Promise<void>
  readonly beforeBlockerTerminalValidation?: () => void | Promise<void>
  readonly now?: () => string
}
