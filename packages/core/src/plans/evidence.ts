/**
 * Plan 证据门。
 * 评估 step 的 verification 是否满足证据要求；blocking_errors / risk_notes。
 */
import {
  requirementsForStep,
  type VerificationRequirement,
} from './verification'
import type { PlanStep } from './models'

export class PlanEvidenceError extends Error {
  readonly code: string
  readonly stepId: string
  readonly reason: string
  constructor(code: string, opts: { stepId: string; reason: string }) {
    super(formatPlanEvidenceError(code, opts))
    this.name = 'PlanEvidenceError'
    this.code = code
    this.stepId = opts.stepId
    this.reason = opts.reason
  }
}

export function formatPlanEvidenceError(
  code: string,
  opts: { stepId: string; reason: string },
): string {
  return [
    `Error: ${code}`,
    `step: ${opts.stepId}`,
    `reason: ${opts.reason}`,
    'Repair: keep the step active or blocked; run the declared verification or ask_user before marking it done.',
  ].join('\n')
}

export interface PlanVerificationAssessment {
  requirements: VerificationRequirement[]
  blockingErrors: string[]
  riskNotes: string[]
}

export function failedRequired(a: PlanVerificationAssessment): string[] {
  return a.blockingErrors.filter((item) => item.includes('failed'))
}

export function missingRequired(a: PlanVerificationAssessment): string[] {
  return a.blockingErrors.filter((item) =>
    item.includes('missing required evidence'),
  )
}

export function assessStepVerification(
  step: PlanStep,
): PlanVerificationAssessment {
  const requirements = requirementsForStep(step)
  const blockingErrors: string[] = []
  const riskNotes: string[] = []
  for (const requirement of requirements) {
    if (requirement.status === 'skipped') {
      if (!requirement.reason)
        blockingErrors.push(`${requirement.id} skipped without reason`)
      else riskNotes.push(`${requirement.id} skipped: ${requirement.reason}`)
      continue
    }
    if (requirement.required) {
      if (requirement.status === 'failed') {
        blockingErrors.push(
          `${requirement.id} failed: ${requirementDetail(requirement)}`,
        )
      } else if (requirement.status !== 'passed') {
        blockingErrors.push(`${requirement.id} missing required evidence`)
      }
      continue
    }
    if (requirement.status === 'failed') {
      riskNotes.push(
        `${requirement.id} failed: ${requirementDetail(requirement)}`,
      )
    }
  }
  return { requirements, blockingErrors, riskNotes }
}

function requirementDetail(requirement: VerificationRequirement): string {
  return (
    requirement.reason ||
    requirement.description ||
    requirement.command ||
    requirement.kind
  )
}
