/**
 * PlanExecutionState。
 * start_next_step / complete_step / fail_step 的不可变状态机。
 */
import { nowTs } from '../util/time'
import {
  PlanStatus,
  PlanStepStatus,
  type PlanRecord,
  type PlanStep,
} from './models'
import { planTopologyErrors } from './quality'

export interface PlanExecutionStateOptions {
  isSkippedDependencyWaived?: (step: PlanStep) => boolean
}

export interface PlanStepSkipWaiverFact {
  readonly kind: 'explicit_user_plan_step_waiver'
  readonly issuedBy: 'core'
  readonly approvedBy: 'user'
  readonly receiptId: string
  readonly goalId: string
  readonly planId: string
  readonly stepId: string
}

export class PlanExecutionState {
  readonly plan: PlanRecord
  private readonly isSkippedDependencyWaived: (step: PlanStep) => boolean

  constructor(plan: PlanRecord, opts: PlanExecutionStateOptions = {}) {
    this.plan = plan
    this.isSkippedDependencyWaived =
      opts.isSkippedDependencyWaived ?? (() => false)
  }

  startNextStep(): PlanRecord {
    this.requireValidState()
    if (this.plan.steps.some((step) => step.status === PlanStepStatus.ACTIVE)) {
      return this.plan
    }
    const steps: PlanStep[] = []
    let activated = false
    for (const step of this.plan.steps) {
      if (
        !activated &&
        step.status === PlanStepStatus.PENDING &&
        this.dependenciesSatisfied(step)
      ) {
        steps.push({ ...step, status: PlanStepStatus.ACTIVE })
        activated = true
      } else {
        steps.push(step)
      }
    }
    return {
      ...this.plan,
      status: PlanStatus.EXECUTING,
      updatedAt: nowTs(),
      steps,
    }
  }

  completeStep(
    stepId: string,
    opts: { evidence: Record<string, unknown> },
  ): PlanRecord {
    this.requireValidState()
    const target = this.requireStep(stepId)
    if (!this.dependenciesSatisfied(target))
      throw new Error(`plan step ${stepId} dependencies are not satisfied`)
    if (target.status !== PlanStepStatus.ACTIVE)
      throw new Error(`plan step ${stepId} must be active before completion`)
    const steps = this.plan.steps.map((step) =>
      step.id === stepId
        ? {
            ...step,
            status: PlanStepStatus.DONE,
            evidence: [...step.evidence, opts.evidence],
          }
        : step,
    )
    const allDone =
      steps.length > 0 &&
      steps.every(
        (step) =>
          step.status === PlanStepStatus.DONE ||
          (step.status === PlanStepStatus.SKIPPED &&
            this.isSkippedDependencyWaived(step)),
      )
    const status = allDone ? PlanStatus.COMPLETED : PlanStatus.EXECUTING
    return {
      ...this.plan,
      status,
      completedAt:
        status === PlanStatus.COMPLETED ? nowTs() : this.plan.completedAt,
      updatedAt: nowTs(),
      steps,
    }
  }

  skipStepWithWaiver(stepId: string, fact: PlanStepSkipWaiverFact): PlanRecord {
    this.requireValidState()
    const target = this.requireStep(stepId)
    if (
      fact.kind !== 'explicit_user_plan_step_waiver' ||
      fact.issuedBy !== 'core' ||
      fact.approvedBy !== 'user' ||
      !fact.receiptId.trim() ||
      !this.plan.goalId ||
      fact.goalId !== this.plan.goalId ||
      fact.planId !== this.plan.id ||
      fact.stepId !== stepId
    )
      throw new Error('Plan step waiver fact is invalid')
    if (target.status !== PlanStepStatus.ACTIVE)
      throw new Error(`plan step ${stepId} must be active before skip`)
    const waiverEvidence = {
      source: 'goal_plan_step_waiver',
      issued_by: 'core',
      approved_by: 'user',
      receipt_id: fact.receiptId,
      goal_id: fact.goalId,
      plan_id: fact.planId,
      plan_step_id: fact.stepId,
    }
    const steps = this.plan.steps.map((step) =>
      step.id === stepId
        ? {
            ...step,
            status: PlanStepStatus.SKIPPED,
            evidence: [...step.evidence, waiverEvidence],
          }
        : step,
    )
    const allDone =
      steps.length > 0 &&
      steps.every(
        (step) =>
          step.status === PlanStepStatus.DONE ||
          (step.status === PlanStepStatus.SKIPPED &&
            (step.id === stepId || this.isSkippedDependencyWaived(step))),
      )
    const status = allDone ? PlanStatus.COMPLETED : PlanStatus.EXECUTING
    return {
      ...this.plan,
      status,
      completedAt:
        status === PlanStatus.COMPLETED ? nowTs() : this.plan.completedAt,
      updatedAt: nowTs(),
      steps,
    }
  }

  failStep(
    stepId: string,
    opts: { evidence: Record<string, unknown> },
  ): PlanRecord {
    this.requireValidState()
    const target = this.requireStep(stepId)
    if (target.status !== PlanStepStatus.ACTIVE)
      throw new Error(`plan step ${stepId} must be active before failure`)
    const steps = this.plan.steps.map((step) =>
      step.id === stepId
        ? {
            ...step,
            status: PlanStepStatus.FAILED,
            evidence: [...step.evidence, opts.evidence],
          }
        : step,
    )
    return {
      ...this.plan,
      status: PlanStatus.FAILED,
      updatedAt: nowTs(),
      steps,
    }
  }

  blockStep(
    stepId: string,
    opts: { evidence: Record<string, unknown> },
  ): PlanRecord {
    this.requireValidState()
    const target = this.requireStep(stepId)
    if (target.status !== PlanStepStatus.ACTIVE)
      throw new Error(`plan step ${stepId} must be active before blocking`)
    return {
      ...this.plan,
      status: PlanStatus.EXECUTING,
      updatedAt: nowTs(),
      steps: this.plan.steps.map((step) =>
        step.id === stepId
          ? {
              ...step,
              status: PlanStepStatus.BLOCKED,
              evidence: [...step.evidence, opts.evidence],
            }
          : step,
      ),
    }
  }

  private requireValidState(): void {
    const errors = planTopologyErrors(
      this.plan.steps,
      this.isSkippedDependencyWaived,
    )
    if (errors.length) throw new Error(errors.join('; '))
  }

  private requireStep(stepId: string): PlanStep {
    const step = this.plan.steps.find((item) => item.id === stepId)
    if (!step) throw new Error(`unknown plan step: ${stepId}`)
    return step
  }

  private dependenciesSatisfied(step: PlanStep): boolean {
    return step.dependsOn.every((dependencyId) => {
      const dependency = this.plan.steps.find(
        (item) => item.id === dependencyId,
      )
      return Boolean(
        dependency &&
        (dependency.status === PlanStepStatus.DONE ||
          (dependency.status === PlanStepStatus.SKIPPED &&
            this.isSkippedDependencyWaived(dependency))),
      )
    })
  }
}
