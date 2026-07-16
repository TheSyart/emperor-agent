export const GOAL_SCHEMA_VERSION = 'emperor.goal.v1' as const

export const GOAL_STATUSES = [
  'draft',
  'active',
  'completed',
  'blocked',
  'cancelled',
  'stopped_by_policy',
] as const

export type GoalStatus = (typeof GOAL_STATUSES)[number]

export const GOAL_PHASES = [
  'contract',
  'planning',
  'executing',
  'verifying',
  'awaiting_user',
  'paused',
  'terminal',
] as const

export type GoalPhase = (typeof GOAL_PHASES)[number]

export interface GoalScope {
  readonly sessionId: string
  readonly mode: 'chat' | 'build'
  readonly projectId: string | null
  readonly workspaceRoot: string
  readonly projectFingerprint: string
}

export type GoalVerificationKind =
  'command' | 'artifact' | 'manual' | 'reviewer'

export interface GoalAcceptanceCriterion {
  readonly id: string
  readonly description: string
  readonly required: boolean
  readonly verification: {
    readonly kind: GoalVerificationKind
    readonly requirement: string
  }
}

export interface GoalContract {
  readonly outcome: string
  readonly inScope: readonly string[]
  readonly outOfScope: readonly string[]
  readonly constraints: readonly string[]
  readonly acceptanceCriteria: readonly GoalAcceptanceCriterion[]
  readonly escalationConditions: readonly string[]
  readonly lockedAt: string | null
  readonly revision: 1
}

export interface GoalContractDefinition {
  readonly inScope: readonly string[]
  readonly outOfScope: readonly string[]
  readonly constraints: readonly string[]
  readonly acceptanceCriteria: readonly GoalAcceptanceCriterion[]
  readonly escalationConditions: readonly string[]
}

export interface GoalGuardPolicy {
  readonly maxCycles: number | null
  readonly deadlineAt: string | null
  readonly maxEstimatedCostUsd: number | null
  readonly noEvidencePauseAfterCycles: number
}

export const DEFAULT_GOAL_GUARD_POLICY: Readonly<GoalGuardPolicy> =
  Object.freeze({
    maxCycles: null,
    deadlineAt: null,
    maxEstimatedCostUsd: null,
    noEvidencePauseAfterCycles: 3,
  })

export interface GoalRuntimeState {
  readonly phase: GoalPhase
  readonly cyclesUsed: number
  readonly consecutiveNoEvidenceCycles: number
  readonly currentRunId: string | null
  readonly currentPlanId: string | null
  readonly pendingInteractionId: string | null
  readonly lastEvidenceAt: string | null
  readonly pauseReason: string | null
}

export interface GoalRecord {
  readonly schemaVersion: typeof GOAL_SCHEMA_VERSION
  readonly id: string
  readonly status: GoalStatus
  readonly scope: GoalScope
  readonly contract: GoalContract
  readonly runtime: GoalRuntimeState
  readonly guardPolicy: GoalGuardPolicy
  readonly latestEvidenceByCriterion: Readonly<Record<string, string>>
  readonly supersedesGoalId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly terminalAt: string | null
  readonly lastEventSeq: number
}

export type GoalGateReasonCode =
  | 'goal_not_found'
  | 'goal_not_active'
  | 'goal_phase_not_verifying'
  | 'contract_unlocked'
  | 'plan_missing'
  | 'plan_not_completed'
  | 'plan_step_incomplete'
  | 'plan_step_failed'
  | 'plan_step_blocked'
  | 'plan_step_skipped_without_waiver'
  | 'plan_verification_incomplete'
  | 'plan_quarantined'
  | 'plan_intent_incomplete'
  | 'criterion_missing_evidence'
  | 'criterion_latest_failed'
  | 'criterion_evidence_invalid'
  | 'independent_verification_missing'
  | 'independent_verification_failed'
  | 'pending_interaction'
  | 'scope_mismatch'
  | 'storage_recovery_required'
  | 'hard_constraint_violation'
  | 'guard_policy_exceeded'

export interface GoalSummary {
  readonly id: string
  readonly status: GoalStatus
  readonly phase: GoalPhase
  readonly outcome: string
  readonly sessionId: string
  readonly currentPlanId: string | null
  readonly cyclesUsed: number
  readonly acceptance: {
    readonly passed: number
    readonly failed: number
    readonly missing: number
    readonly total: number
    readonly criteria?: readonly GoalAcceptanceSummary[]
  }
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastEventSeq: number
}

export type GoalEvidenceVerdict = 'pass' | 'fail'

export interface GoalAcceptanceSummary {
  readonly id: string
  readonly description: string
  readonly required: boolean
  readonly verificationKind: GoalVerificationKind
  readonly verdict: GoalEvidenceVerdict | 'missing'
  readonly evidenceSummary: string | null
}

export interface GoalSummaryEvidence {
  readonly verdict: GoalEvidenceVerdict
  readonly summary?: string | null
}

const TERMINAL_GOAL_STATUSES = new Set<GoalStatus>([
  'completed',
  'blocked',
  'cancelled',
  'stopped_by_policy',
])

export function isGoalTerminal(status: GoalStatus): boolean {
  return TERMINAL_GOAL_STATUSES.has(status)
}

export function goalSummary(
  record: GoalRecord,
  evidenceById: Readonly<
    Record<string, GoalEvidenceVerdict | GoalSummaryEvidence>
  > = {},
): GoalSummary {
  let passed = 0
  let failed = 0
  let missing = 0
  const criteria: GoalAcceptanceSummary[] = []
  for (const criterion of record.contract.acceptanceCriteria) {
    const evidenceId = record.latestEvidenceByCriterion[criterion.id]
    const evidence = evidenceId ? evidenceById[evidenceId] : undefined
    const verdict = typeof evidence === 'string' ? evidence : evidence?.verdict
    if (verdict === 'pass') passed += 1
    else if (verdict === 'fail') failed += 1
    else missing += 1
    criteria.push({
      id: criterion.id,
      description: criterion.description,
      required: criterion.required,
      verificationKind: criterion.verification.kind,
      verdict: verdict ?? 'missing',
      evidenceSummary:
        evidence && typeof evidence !== 'string'
          ? String(evidence.summary ?? '') || null
          : null,
    })
  }
  return {
    id: record.id,
    status: record.status,
    phase: record.runtime.phase,
    outcome: record.contract.outcome,
    sessionId: record.scope.sessionId,
    currentPlanId: record.runtime.currentPlanId,
    cyclesUsed: record.runtime.cyclesUsed,
    acceptance: {
      passed,
      failed,
      missing,
      total: record.contract.acceptanceCriteria.length,
      criteria,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastEventSeq: record.lastEventSeq,
  }
}
