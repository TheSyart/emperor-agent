import type { ControlResume } from '../control/manager'
import type { PlanExecutionPauseInput } from '../control/plan-execution'
import type { ControlStatePayload, Interaction } from '../control/models'
import type { GoalRecord } from '../goals/models'
import type {
  BindApprovedPlanInput,
  GoalPlanBindingResult,
  GoalPlanSkipRecoveryResult,
  GoalReplanResult,
  PreflightPlanApprovalInput,
  RequestReplanInput,
  SkipPlanStepWithWaiverInput,
} from '../goals/plan-bridge'
import { planToDict, type PlanRecord } from './models'

export interface PlanningControlPort {
  readonly sessionId: string | null
  readonly store: {
    load(): { pending: Interaction | null }
  }
  readonly planStore: {
    get(planId: string): PlanRecord | null
  }
  readonly execution: {
    activateApprovedPlan(interaction: Interaction): PlanRecord | null
  }
  setActiveGoalPlanContext(goal: GoalRecord | null): void
  setMode(mode: string): ControlStatePayload
  createPlan(input: PlanProposalInput): Interaction
  comment(interactionId: string, comment: string): ControlResume
  approve(interactionId: string): ControlResume
  cancel(interactionId: string): Record<string, unknown>
  recordPlanDiscovery(input: PlanDiscoveryInput): PlanRecord | null
  recordPlanStepToolOutput(input: PlanStepToolOutputInput): unknown
  completePlanStep(input: PlanStepClaimInput): PlanRecord
  recordPlanVerificationResult(input: PlanVerificationInput): PlanRecord | null
  pausePlanExecution(input: PlanExecutionPauseInput): PlanRecord | null
  resumePlanExecution(input: { turnId: string }): PlanRecord | null
}

export interface GoalPlanPort {
  preflightApproval(
    input: PreflightPlanApprovalInput,
  ): Promise<GoalPlanBindingResult>
  prepareApproval(
    input: PreflightPlanApprovalInput,
  ): Promise<GoalPlanBindingResult>
  bindApprovedPlan(input: BindApprovedPlanInput): Promise<GoalPlanBindingResult>
  abortFailedApproval(input: BindApprovedPlanInput): void
  skipStepWithWaiver(input: SkipPlanStepWithWaiverInput): Promise<PlanRecord>
  requestReplan(input: RequestReplanInput): Promise<GoalReplanResult>
  recoverQuarantinedApprovals(): Promise<number>
  recoverIncompleteSkips(): Promise<GoalPlanSkipRecoveryResult>
  recoverIncompleteReplans(): Promise<number>
}

export interface PlanProposalInput {
  title: string
  summary: string
  planMarkdown: string
  assumptions?: string[] | null
  riskLevel?: string
  steps?: Array<Record<string, unknown>> | null
  parentCallId?: string | null
  meta?: Record<string, unknown> | null
  enforceQuality?: boolean
}

export interface PlanDiscoveryInput {
  source: string
  summary: string
  files?: string[] | null
  symbols?: string[] | null
  evidenceRefs?: string[] | null
}

export interface PlanStepClaimInput {
  stepId: string
  summary: string
  toolCallId?: string | null
  turnId?: string | null
}

export interface PlanVerificationInput {
  planId: string
  stepId: string
  result: Record<string, unknown>
}

export interface PlanStepToolOutputInput {
  toolName: string
  summary: string
  toolCallId?: string | null
  artifacts?: Array<Record<string, unknown>> | null
  metadata?: Record<string, unknown> | null
  isError?: boolean
}

export interface PlanningRunnerUseCases {
  recordPlanDiscovery(input: PlanDiscoveryInput): PlanRecord | null
  recordPlanStepToolOutput(input: PlanStepToolOutputInput): unknown
  recordPlanVerificationResult(input: PlanVerificationInput): PlanRecord | null
  pausePlanExecution(input: PlanExecutionPauseInput): PlanRecord | null
  resumePlanExecution(input: { turnId: string }): PlanRecord | null
}

export interface PlanningSessionUseCases extends PlanningRunnerUseCases {
  createPlan(input: PlanProposalInput): Interaction
  completePlanStep(input: PlanStepClaimInput): PlanRecord
}

export interface PlanningRecoveryResult {
  approvals: number
  skips: number
  replans: number
}

/**
 * Single application boundary for Plan use cases. During the first migration
 * stage it delegates the already hardened domain operations; callers no longer
 * orchestrate Control and Goal compensation themselves.
 */
export class PlanningApplicationService {
  private readonly controlForSession: (sessionId: string) => PlanningControlPort
  private readonly controlForInteraction: (
    interactionId: string,
  ) => PlanningControlPort
  private readonly goalPlans: GoalPlanPort

  constructor(input: {
    controlForSession(sessionId: string): PlanningControlPort
    controlForInteraction(interactionId: string): PlanningControlPort
    goalPlans: GoalPlanPort
  }) {
    this.controlForSession = input.controlForSession
    this.controlForInteraction = input.controlForInteraction
    this.goalPlans = input.goalPlans
  }

  forSession(sessionId: string): PlanningSessionUseCases {
    const owner = requiredSessionId(sessionId)
    return Object.freeze({
      createPlan: (input: PlanProposalInput) => this.propose(owner, input),
      recordPlanDiscovery: (input: PlanDiscoveryInput) =>
        this.recordDiscovery(owner, input),
      recordPlanStepToolOutput: (input: PlanStepToolOutputInput) =>
        this.recordStepToolOutput(owner, input),
      completePlanStep: (input: PlanStepClaimInput) =>
        this.claimStep(owner, input),
      recordPlanVerificationResult: (input: PlanVerificationInput) =>
        this.recordVerification(owner, input),
      pausePlanExecution: (input: PlanExecutionPauseInput) =>
        this.pause(owner, input),
      resumePlanExecution: (input: { turnId: string }) =>
        this.resume(owner, input),
    })
  }

  enterPlan(
    sessionId: string,
    goal: GoalRecord | null = null,
  ): ControlStatePayload {
    const control = this.sessionControl(sessionId)
    control.setActiveGoalPlanContext(goal)
    return control.setMode('plan')
  }

  setMode(sessionId: string, mode: string): ControlStatePayload {
    return this.sessionControl(sessionId).setMode(mode)
  }

  recordDiscovery(
    sessionId: string,
    input: PlanDiscoveryInput,
  ): PlanRecord | null {
    return this.sessionControl(sessionId).recordPlanDiscovery(input)
  }

  propose(sessionId: string, input: PlanProposalInput): Interaction {
    return this.sessionControl(sessionId).createPlan(input)
  }

  comment(interactionId: string, comment: string): ControlResume {
    return this.interactionControl(interactionId).comment(
      interactionId,
      comment,
    )
  }

  async approve(interactionId: string): Promise<ControlResume> {
    const control = this.interactionControl(interactionId)
    const pending = control.store.load().pending
    const pendingPlanId = String(pending?.meta.plan_id ?? '').trim()
    const pendingPlan = pendingPlanId
      ? control.planStore.get(pendingPlanId)
      : null
    const approvalInput = pendingPlan?.goalId
      ? {
          goalId: pendingPlan.goalId,
          planId: pendingPlan.id,
          interactionId,
          approvalGeneration: Number(
            pending?.meta.approval_generation ?? Number.NaN,
          ),
        }
      : null
    if (approvalInput) {
      await this.goalPlans.preflightApproval(approvalInput)
      await this.goalPlans.prepareApproval(approvalInput)
    }
    try {
      const approval = control.approve(interactionId)
      const planPayload = record(approval.event.plan)
      const planId = String(planPayload?.id ?? '').trim()
      if (planId) {
        const plan = control.planStore.get(planId)
        if (plan?.goalId) {
          await this.goalPlans.bindApprovedPlan({
            goalId: plan.goalId,
            planId,
          })
          const rebound = control.planStore.get(planId)
          if (rebound) approval.event.plan = planToDict(rebound)
        }
      }
      return approval
    } catch (cause) {
      if (approvalInput)
        this.goalPlans.abortFailedApproval({
          goalId: approvalInput.goalId,
          planId: approvalInput.planId,
        })
      throw cause
    }
  }

  activate(sessionId: string, interaction: Interaction): PlanRecord | null {
    return this.sessionControl(sessionId).execution.activateApprovedPlan(
      interaction,
    )
  }

  claimStep(sessionId: string, input: PlanStepClaimInput): PlanRecord {
    return this.sessionControl(sessionId).completePlanStep(input)
  }

  recordStepToolOutput(
    sessionId: string,
    input: PlanStepToolOutputInput,
  ): unknown {
    return this.sessionControl(sessionId).recordPlanStepToolOutput(input)
  }

  recordVerification(
    sessionId: string,
    input: PlanVerificationInput,
  ): PlanRecord | null {
    return this.sessionControl(sessionId).recordPlanVerificationResult(input)
  }

  pause(sessionId: string, input: PlanExecutionPauseInput): PlanRecord | null {
    return this.sessionControl(sessionId).pausePlanExecution(input)
  }

  resume(sessionId: string, input: { turnId: string }): PlanRecord | null {
    return this.sessionControl(sessionId).resumePlanExecution(input)
  }

  skip(input: SkipPlanStepWithWaiverInput): Promise<PlanRecord> {
    return this.goalPlans.skipStepWithWaiver(input)
  }

  replan(input: RequestReplanInput): Promise<GoalReplanResult> {
    return this.goalPlans.requestReplan(input)
  }

  cancel(interactionId: string): Record<string, unknown> {
    return this.interactionControl(interactionId).cancel(interactionId)
  }

  async recover(): Promise<PlanningRecoveryResult> {
    const approvals = await this.goalPlans.recoverQuarantinedApprovals()
    const skipResult = await this.goalPlans.recoverIncompleteSkips()
    const replans = await this.goalPlans.recoverIncompleteReplans()
    return { approvals, skips: skipResult.count, replans }
  }

  private sessionControl(sessionId: string): PlanningControlPort {
    const owner = requiredSessionId(sessionId)
    const control = this.controlForSession(owner)
    if (control.sessionId !== owner)
      throw new Error('Planning Control session ownership mismatch')
    return control
  }

  private interactionControl(interactionId: string): PlanningControlPort {
    const target = String(interactionId ?? '').trim()
    if (!target) throw new Error('Planning interaction ID is required')
    return this.controlForInteraction(target)
  }
}

function requiredSessionId(sessionId: string): string {
  const value = String(sessionId ?? '').trim()
  if (!value) throw new Error('Planning session ID is required')
  return value
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
