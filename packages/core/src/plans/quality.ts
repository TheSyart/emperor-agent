/**
 * PlanQualityGate (MIG-CTRL-013)。对齐 Python `agent/plans/quality.py`。
 * 在计划成为审批卡前拒绝弱计划：scope / 未知 discovery / 泛标题 / 验证 / 高风险 note+rollback。
 */
import type { PlanDraftState, PlanStep } from './models'

export interface PlanQualityResult {
  ok: boolean
  errors: string[]
}

export class PlanQualityError extends Error {
  readonly errors: string[]
  constructor(errors: string[]) {
    super(formatPlanQualityError(errors))
    this.name = 'PlanQualityError'
    this.errors = [...errors]
  }
}

export class PlanQualityGate {
  assess(opts: {
    steps: PlanStep[]
    draft: PlanDraftState
  }): PlanQualityResult {
    const errors: string[] = []
    if (!opts.steps.length) {
      errors.push('plan has no structured steps')
      return { ok: false, errors }
    }
    errors.push(...planTopologyErrors(opts.steps))
    const discoveryIds = new Set<string>()
    for (const item of opts.draft.discoveries) {
      if (item && typeof item === 'object') {
        const id = String((item as Record<string, unknown>).id ?? '').trim()
        if (id) discoveryIds.add(id)
      }
    }
    if (discoveryIds.size === 0) {
      errors.push('plan has no successful read-only exploration evidence')
    }
    if (opts.draft.openQuestions.length > 0) {
      errors.push(
        'plan has unresolved design questions and cannot enter approval',
      )
    }
    if (
      discoveryIds.size > 0 &&
      !opts.steps.some((step) =>
        step.discoveryRefs.some((ref) => discoveryIds.has(ref)),
      )
    ) {
      errors.push('plan steps do not cite any recorded exploration evidence')
    }
    const hasDraftVerification = opts.draft.verificationStrategy.length > 0
    for (const step of opts.steps) {
      errors.push(...assessStep(step, discoveryIds, hasDraftVerification))
    }
    return { ok: errors.length === 0, errors }
  }

  requireOk(opts: { steps: PlanStep[]; draft: PlanDraftState }): void {
    const result = this.assess(opts)
    if (!result.ok) throw new PlanQualityError(result.errors)
  }
}

export function planTopologyErrors(
  steps: readonly PlanStep[],
  isSkippedDependencyWaived: (step: PlanStep) => boolean = () => false,
): string[] {
  const errors: string[] = []
  const byId = new Map<string, PlanStep>()
  for (const step of steps) {
    if (byId.has(step.id)) errors.push(`duplicate plan step id: ${step.id}`)
    else byId.set(step.id, step)
  }
  const active = steps.filter((step) => step.status === 'active')
  if (active.length > 1)
    errors.push('plan must contain at most one active step')
  for (const step of steps) {
    for (const dependencyId of step.dependsOn) {
      if (dependencyId === step.id) {
        errors.push(`${step.id} cannot depend on itself`)
        continue
      }
      if (!byId.has(dependencyId))
        errors.push(`${step.id} references unknown dependency: ${dependencyId}`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) {
      errors.push(`plan dependency cycle includes ${stepId}`)
      return
    }
    if (visited.has(stepId)) return
    visiting.add(stepId)
    for (const dependencyId of byId.get(stepId)?.dependsOn ?? []) {
      if (byId.has(dependencyId)) visit(dependencyId)
    }
    visiting.delete(stepId)
    visited.add(stepId)
  }
  for (const step of steps) visit(step.id)
  for (const step of steps) {
    if (step.status !== 'active' && step.status !== 'done') continue
    for (const dependencyId of step.dependsOn) {
      const dependency = byId.get(dependencyId)
      if (
        dependency &&
        dependency.status !== 'done' &&
        !(
          dependency.status === 'skipped' &&
          isSkippedDependencyWaived(dependency)
        )
      ) {
        errors.push(
          `${step.id} dependency ${dependencyId} is not done or explicitly waived`,
        )
      }
    }
  }
  return [...new Set(errors)]
}

export function formatPlanQualityError(errors: string[]): string {
  return [
    'Error: plan quality gate failed',
    ...errors.map((e) => `- ${e}`),
  ].join('\n')
}

function assessStep(
  step: PlanStep,
  discoveryIds: Set<string>,
  hasDraftVerification: boolean,
): string[] {
  const sid = step.id
  const errors: string[] = []
  if (!hasScope(step, discoveryIds)) {
    errors.push(
      `${sid} has no target files, discovery reference, or concrete scope`,
    )
  }
  const unknownRefs = step.discoveryRefs.filter(
    (ref) => discoveryIds.size > 0 && !discoveryIds.has(ref),
  )
  if (unknownRefs.length) {
    errors.push(
      `${sid} references unknown discoveries: ${unknownRefs.slice(0, 3).join(', ')}`,
    )
  }
  if (hasGenericTitle(step)) {
    errors.push(`${sid} title is too generic; add concrete acceptance`)
  }
  if (!hasVerification(step, hasDraftVerification)) {
    errors.push(
      `${sid} has no verification command or manual verification rule`,
    )
  }
  errors.push(...verificationCapabilityErrors(step))
  if (step.risk.trim().toLowerCase() === 'high') {
    if (!step.riskNote.trim())
      errors.push(`${sid} is high risk but has no risk note`)
    if (!step.rollback.trim())
      errors.push(`${sid} is high risk but has no rollback path`)
  }
  return errors
}

function hasScope(step: PlanStep, discoveryIds: Set<string>): boolean {
  if (step.files.length) return true
  if (
    step.discoveryRefs.length &&
    (discoveryIds.size === 0 ||
      step.discoveryRefs.some((ref) => discoveryIds.has(ref)))
  ) {
    return true
  }
  if (step.acceptance.length) return true
  return step.description.trim().length >= 24
}

const GENERIC_TITLES = new Set([
  'fix issue',
  'fix bug',
  'improve code',
  'update code',
  'make changes',
  'implement',
  'refactor',
  '修复问题',
  '优化代码',
  '改进代码',
])

function hasGenericTitle(step: PlanStep): boolean {
  const title = step.title
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((p) => p)
    .join(' ')
  return GENERIC_TITLES.has(title) && !step.acceptance.length
}

function hasVerification(
  step: PlanStep,
  hasDraftVerification: boolean,
): boolean {
  return Boolean(
    step.commands.length ||
    step.verification.length ||
    step.acceptance.length ||
    hasDraftVerification,
  )
}

function verificationCapabilityErrors(step: PlanStep): string[] {
  const errors: string[] = []
  for (const requirement of step.verification) {
    const kind = String(requirement.kind || 'command').trim()
    const command = String(requirement.command || '').trim()
    const description = String(requirement.description || '').trim()
    if (kind === 'manual') {
      if (!description && !command)
        errors.push(
          `${step.id} verification ${requirement.id} has no manual verification instruction`,
        )
      if (requirement.required && !requirement.humanRequired)
        errors.push(
          `${step.id} verification ${requirement.id} cannot block completion unless the user explicitly requires manual acceptance`,
        )
      continue
    }
    if (!command) {
      errors.push(
        `${step.id} verification ${requirement.id} has no executable command`,
      )
      continue
    }
    if (looksLikeManualBrowserInstruction(command)) {
      errors.push(
        `${step.id} verification ${requirement.id} requires manual verification; it is not an executable command`,
      )
    }
    if (createsTemporaryVerificationSource(command)) {
      errors.push(
        `${step.id} verification ${requirement.id} writes a temporary verification source file`,
      )
    }
  }
  return errors
}

function looksLikeManualBrowserInstruction(command: string): boolean {
  return (
    /\b(?:open|launch|inspect|view)\b.*\b(?:browser|page|website)\b/i.test(
      command,
    ) || /(?:浏览器|目视|人工查看|视觉检查)/.test(command)
  )
}

function createsTemporaryVerificationSource(command: string): boolean {
  return /(?:^|[/\\])_(?:verify|verification|chk|check)\.(?:py|js|mjs|cjs|ts)\b/i.test(
    command,
  )
}
