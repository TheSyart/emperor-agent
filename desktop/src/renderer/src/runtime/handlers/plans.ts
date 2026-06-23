import type { ControlInteraction, RuntimePlanEntryDecision, RuntimePlanRecord, RuntimePlanStep, WsEvent } from '../../types'

export interface PlanProjection {
  plans: RuntimePlanRecord[]
  entryDecisions: RuntimePlanEntryDecision[]
}

type PlanEvent = Extract<WsEvent, {
  event: 'plan_approved' | 'plan_entry_decision' | 'plan_runtime_update' | 'plan_step_update' | 'plan_verification_start' | 'plan_verification_done'
}>

export type IndependentVerificationStatus =
  | 'none'
  | 'required'
  | 'passed'
  | 'failed'
  | 'waived'
  | 'missing_command_evidence'

export interface PlanExecutionSummary {
  activeStep: RuntimePlanStep | null
  failedVerificationSummary: string
  blockedReason: string
  openQuestionsCount: number
  independentVerificationStatus: IndependentVerificationStatus
  independentVerificationSummary: string
  independentVerificationCommands: string[]
  riskSignals: string[]
}

export function applyPlanEvent(projection: PlanProjection, event: PlanEvent): PlanProjection {
  const entryDecisions = projection.entryDecisions || []
  if (event.event === 'plan_entry_decision') {
    return {
      ...projection,
      entryDecisions: [
        ...entryDecisions,
        {
          decision: event.decision || 'proceed',
          reason: event.reason || '',
          triggers: stringList(event.triggers),
          suggestedQuestions: stringList(event.suggested_questions),
          recommendedReadonlyScopes: stringList(event.recommended_readonly_scopes),
        },
      ].slice(-20),
    }
  }

  if (event.event === 'plan_runtime_update' || event.event === 'plan_approved') {
    if (!event.plan?.id) return projection
    const existing = projection.plans.findIndex((plan) => plan.id === event.plan?.id)
    const plans = [...projection.plans]
    if (existing >= 0) plans[existing] = { ...plans[existing], ...event.plan }
    else plans.push(event.plan)
    return { ...projection, plans }
  }

  const planId = event.plan_id
  if (!planId) return projection
  return {
    ...projection,
    plans: projection.plans.map((plan) => {
      if (plan.id !== planId) return plan
      if (event.event === 'plan_step_update' && event.step?.id) {
        return { ...plan, steps: upsertStep(plan.steps || [], event.step) }
      }
      if (event.event === 'plan_verification_done' && event.step_id && event.result) {
        return {
          ...plan,
          steps: (plan.steps || []).map((step) =>
            step.id === event.step_id
              ? { ...step, evidence: [...(step.evidence || []), event.result || {}] }
              : step,
          ),
        }
      }
      return plan
    }),
  }
}

export function latestPlanForInteraction(
  plans: RuntimePlanRecord[],
  interaction?: ControlInteraction | null,
): RuntimePlanRecord | null {
  if (!plans.length) return null
  const planId = planIdFromInteraction(interaction)
  if (planId) return plans.find((plan) => plan.id === planId) || null
  return plans[plans.length - 1] || null
}

export function planIdFromInteraction(interaction?: ControlInteraction | null): string {
  const value = interaction?.meta?.plan_id
  return typeof value === 'string' ? value.trim() : ''
}

export function planExecutionSummary(plan?: RuntimePlanRecord | null): PlanExecutionSummary {
  const steps = plan?.steps || []
  const activeStep = steps.find((step) => step.status === 'active') || null
  const failedEvidence = latestFailedStepEvidence(steps)
  const blockedStep = steps.find((step) => step.status === 'blocked') || null
  const independent = latestIndependentVerification(plan)
  const request = independentVerificationRequest(plan)
  const openQuestions = plan?.draft?.open_questions
  return {
    activeStep,
    failedVerificationSummary: evidenceSummary(failedEvidence),
    blockedReason: blockedReason(blockedStep),
    openQuestionsCount: Array.isArray(openQuestions) ? openQuestions.length : 0,
    independentVerificationStatus: independentVerificationStatus(independent, request),
    independentVerificationSummary: independentVerificationSummary(independent),
    independentVerificationCommands: independentVerificationCommands(independent),
    riskSignals: stringList(request?.risk_signals),
  }
}

function upsertStep(steps: RuntimePlanStep[], step: RuntimePlanStep): RuntimePlanStep[] {
  const existing = steps.findIndex((item) => item.id === step.id)
  const next = [...steps]
  if (existing >= 0) next[existing] = { ...next[existing], ...step }
  else next.push(step)
  return next
}

function latestFailedStepEvidence(steps: RuntimePlanStep[]): Record<string, unknown> | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const evidence = latestEvidence(steps[index])
    if (evidence?.passed === false) return evidence
  }
  return null
}

function latestEvidence(step?: RuntimePlanStep | null): Record<string, unknown> | null {
  const items = step?.evidence || []
  const item = items[items.length - 1]
  return item && typeof item === 'object' ? item : null
}

function evidenceSummary(evidence: Record<string, unknown> | null): string {
  return stringValue(evidence, 'summary') ||
    stringValue(evidence, 'error') ||
    stringValue(evidence, 'stderr_tail') ||
    stringValue(evidence, 'stdout_tail')
}

function blockedReason(step?: RuntimePlanStep | null): string {
  if (!step) return ''
  return stringValue(step as unknown as Record<string, unknown>, 'blocked_reason') ||
    stringValue(latestEvidence(step), 'blocked_reason') ||
    stringValue(latestEvidence(step), 'reason') ||
    evidenceSummary(latestEvidence(step))
}

function latestIndependentVerification(plan?: RuntimePlanRecord | null): Record<string, unknown> | null {
  const items = plan?.verification || []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!item || typeof item !== 'object') continue
    const source = stringValue(item, 'source')
    if (
      source === 'independent_verification' ||
      source === 'verification_reviewer' ||
      source === 'verification_subagent' ||
      source === 'reviewer' ||
      source === 'independent_verification_waiver'
    ) {
      return item
    }
  }
  return null
}

function independentVerificationRequest(plan?: RuntimePlanRecord | null): Record<string, unknown> | null {
  const value = plan?.metadata?.independent_verification_request
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function independentVerificationStatus(
  evidence: Record<string, unknown> | null,
  request: Record<string, unknown> | null,
): IndependentVerificationStatus {
  if (!evidence) return request ? 'required' : 'none'
  const source = stringValue(evidence, 'source')
  if (source === 'independent_verification_waiver' || evidence.waived === true) return 'waived'
  if (evidence.passed === false) return 'failed'
  if (evidence.passed === true) return hasCommandEvidence(evidence) ? 'passed' : 'missing_command_evidence'
  return request ? 'required' : 'none'
}

function independentVerificationSummary(evidence: Record<string, unknown> | null): string {
  if (!evidence) return ''
  return stringValue(evidence, 'summary') ||
    stringValue(evidence, 'reason') ||
    stringValue(evidence, 'error') ||
    stringValue(evidence, 'stderr_tail') ||
    stringValue(evidence, 'stdout_tail')
}

function independentVerificationCommands(evidence: Record<string, unknown> | null): string[] {
  if (!evidence) return []
  const direct = stringValue(evidence, 'command')
  const commands = stringList(evidence.commands)
  return direct ? [direct, ...commands.filter((item) => item !== direct)] : commands
}

function hasCommandEvidence(evidence: Record<string, unknown>): boolean {
  if (stringValue(evidence, 'command')) return true
  if (stringList(evidence.commands).length) return true
  const items = evidence.command_evidence
  return Array.isArray(items) && items.some((item) =>
    item && typeof item === 'object' && stringValue(item as Record<string, unknown>, 'command')
  )
}

function stringValue(source: Record<string, unknown> | null | undefined, key: string): string {
  const value = source?.[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}
