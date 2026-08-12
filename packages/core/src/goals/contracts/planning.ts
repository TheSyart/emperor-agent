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
