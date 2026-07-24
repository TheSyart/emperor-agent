import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  PlanStatus,
  PlanStepStatus,
  planToDict,
  type PlanRecord,
} from '../plans/models'
import { requirementsForStep } from '../plans/verification'
import { nowTs } from '../util/time'
import { canonicalJson } from '../goals/events'
import {
  InteractionKind,
  InteractionStatus,
  interactionFromDict,
  interactionToDict,
  interactionToPublicDict,
  makeAsk,
  questionFromDict,
  touchInteraction,
  type Interaction,
} from './models'
import { CoreControlActionSigner } from './core-action-signature'
import type { ControlManager } from './manager'

export const PLAN_EXECUTION_ACTION_QUESTION_ID = 'plan_execution_action'

export type PlanExecutionAction =
  | 'continue_verification'
  | 'manual_verification_passed'
  | 'waive_verification_and_complete'
  | 'cancel_plan'

export interface PlanExecutionActionRequest {
  version: 1
  interactionId: string
  sessionId: string
  planId: string
  planStepId: string
  approvalGeneration: number
  requirementIds: string[]
  allowedActions: PlanExecutionAction[]
  issuedBy: 'core'
}

export interface PlanExecutionActionResolution {
  action: PlanExecutionAction
  disposition: 'resume' | 'complete' | 'cancel'
  settlementId: string
  plan: PlanRecord
  message: string
  event: Record<string, unknown>
}

interface PlanExecutionSettlementRecord {
  version: 1
  id: string
  status: 'prepared' | 'applied'
  action: PlanExecutionAction
  request: PlanExecutionActionRequest
  interaction: Record<string, unknown>
  preparedAt: number
  appliedAt: number | null
}

interface PlanExecutionSettlementDocument {
  version: 1
  records: PlanExecutionSettlementRecord[]
}

class PlanExecutionSettlementStore {
  private readonly path: string

  constructor(root: string) {
    this.path = join(root, 'control', 'plan-execution-settlements.json')
  }

  prepare(input: {
    action: PlanExecutionAction
    request: PlanExecutionActionRequest
    interaction: Interaction
  }): PlanExecutionSettlementRecord {
    const document = this.load()
    const existing = document.records.find(
      (record) =>
        record.request.interactionId === input.request.interactionId &&
        record.action === input.action,
    )
    if (existing) return existing
    const record: PlanExecutionSettlementRecord = {
      version: 1,
      id: `plan_settlement_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      status: 'prepared',
      action: input.action,
      request: { ...input.request },
      interaction: interactionToDict(input.interaction),
      preparedAt: nowTs(),
      appliedAt: null,
    }
    document.records.push(record)
    this.save(document)
    return record
  }

  markApplied(id: string): void {
    const document = this.load()
    const record = document.records.find((candidate) => candidate.id === id)
    if (!record || record.status === 'applied') return
    record.status = 'applied'
    record.appliedAt = nowTs()
    this.save(document)
  }

  pending(): PlanExecutionSettlementRecord[] {
    return this.load().records.filter((record) => record.status === 'prepared')
  }

  private load(): PlanExecutionSettlementDocument {
    if (!existsSync(this.path)) return { version: 1, records: [] }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8') || '{}')
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.records))
        return { version: 1, records: [] }
      const records = raw.records
        .filter(
          (record: unknown) =>
            record && typeof record === 'object' && !Array.isArray(record),
        )
        .map(
          (record: Record<string, unknown>) =>
            record as unknown as PlanExecutionSettlementRecord,
        )
      return { version: 1, records }
    } catch {
      return { version: 1, records: [] }
    }
  }

  private save(document: PlanExecutionSettlementDocument): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, this.path)
  }
}

export class PlanExecutionActionManager {
  private readonly signer: CoreControlActionSigner
  private readonly settlements: PlanExecutionSettlementStore

  constructor(private readonly cm: ControlManager) {
    this.signer = new CoreControlActionSigner(cm.store.root)
    this.settlements = new PlanExecutionSettlementStore(cm.store.root)
  }

  request(input: {
    turnId: string
    executionId: string
  }): Interaction | null {
    const record = this.cm.latestExecutablePlan()
    if (
      record === null ||
      (record.status !== PlanStatus.APPROVED &&
        record.status !== PlanStatus.EXECUTING)
    )
      return null
    const step = record.steps.find(
      (candidate) => candidate.status === PlanStepStatus.ACTIVE,
    )
    if (!step || !hasImplementationClaim(record, step.id)) return null
    const phase = executionPhase(record, step.id)
    const unresolved = requirementsForStep(step).filter(
      (requirement) =>
        requirement.required &&
        requirement.status !== 'passed' &&
        requirement.status !== 'skipped',
    )
    if (!unresolved.length) return null
    const repeatedVerificationFailure =
      hasRepeatedVerificationFailure(step)
    if (
      phase === 'completed' ||
      phase === 'cancelled' ||
      phase === 'waiting_user' ||
      (phase === 'repairing' && !repeatedVerificationFailure)
    )
      return null
    if (
      !unresolved.some((requirement) => requirement.kind === 'manual') &&
      !repeatedVerificationFailure
    )
      return null
    this.cm.ensureNoPending()
    const allowedActions = allowedActionsFor(unresolved)
    const interaction = makeAsk({
      questions: [
        questionFromDict({
          id: PLAN_EXECUTION_ACTION_QUESTION_ID,
          header: '计划验证',
          question:
            '实现已经完成声明，但必需验证仍未满足。请选择如何处理当前计划。',
          options: actionOptions(allowedActions),
        }),
      ],
      context: unresolved
        .map(
          (requirement) =>
            requirement.description || requirement.command || requirement.id,
        )
        .join('\n')
        .slice(0, 1000),
      meta: {},
    })
    const request: PlanExecutionActionRequest = {
      version: 1,
      interactionId: interaction.id,
      sessionId: planSessionId(record, this.cm),
      planId: record.id,
      planStepId: step.id,
      approvalGeneration: Number(record.metadata.approval_generation ?? 0),
      requirementIds: unresolved.map((requirement) => requirement.id),
      allowedActions,
      issuedBy: 'core',
    }
    const waiting = this.cm.planStore.save(
      updateExecutionPhase(record, step.id, 'waiting_user'),
    )
    this.cm.execution.pauseExecution({
      reason: 'user_input_required',
      turnId: String(input.turnId ?? '').trim(),
      executionId: String(input.executionId ?? '').trim(),
      pausedAt: nowTs(),
      evaluationCount: 0,
      totalIterations: 0,
      nextActions: unresolved.map(
        (requirement) =>
          requirement.description || requirement.command || requirement.id,
      ),
    })
    interaction.meta = {
      interaction_type: 'plan_execution',
      control_session_id: request.sessionId,
      control_turn_id: String(input.turnId ?? '').trim(),
      execution_id: String(input.executionId ?? '').trim(),
      plan_execution_action_request: {
        ...request,
        coreSignature: this.signer.sign(
          request as unknown as Record<string, unknown>,
        ),
      },
    }
    interaction.meta.plan_updated_at = waiting.updatedAt
    this.cm.setPending(interaction)
    return interaction
  }

  resolve(interaction: Interaction): PlanExecutionActionResolution | null {
    const raw = interaction.meta.plan_execution_action_request
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const request = raw as unknown as PlanExecutionActionRequest & {
      coreSignature?: string
    }
    const signed = requestPayload(request)
    const action = answerAction(interaction)
    if (
      interaction.kind !== InteractionKind.ASK ||
      interaction.status !== InteractionStatus.ANSWERED ||
      request.version !== 1 ||
      request.issuedBy !== 'core' ||
      request.interactionId !== interaction.id ||
      !request.allowedActions.includes(action) ||
      !this.signer.verify(
        signed as unknown as Record<string, unknown>,
        request.coreSignature,
      )
    )
      throw new Error('Plan execution action request is invalid')
    const record = this.cm.planStore.get(request.planId)
    const step = record?.steps.find(
      (candidate) => candidate.id === request.planStepId,
    )
    if (
      !record ||
      !step ||
      planSessionId(record, this.cm) !== request.sessionId ||
      Number(record.metadata.approval_generation ?? 0) !==
        request.approvalGeneration ||
      step.status !== PlanStepStatus.ACTIVE
    )
      throw new Error('Plan execution action request is stale')
    const currentIds = requirementsForStep(step)
      .filter(
        (requirement) =>
          requirement.required &&
          requirement.status !== 'passed' &&
          requirement.status !== 'skipped',
      )
      .map((requirement) => requirement.id)
    if (canonicalJson(currentIds as never) !== canonicalJson(request.requirementIds as never))
      throw new Error('Plan verification requirements changed')

    const settlement = this.settlements.prepare({
      action,
      request: signed,
      interaction,
    })
    const plan = this.apply(settlement)
    const disposition =
      action === 'cancel_plan'
        ? 'cancel'
        : plan.status === PlanStatus.COMPLETED
          ? 'complete'
          : 'resume'
    return {
      action,
      disposition,
      settlementId: settlement.id,
      plan,
      message: resolutionMessage(action, plan),
      event: {
        event: 'plan_execution_settled',
        settlement_id: settlement.id,
        action,
        disposition,
        plan: planToDict(plan),
        interaction: interactionToPublicDict(interaction),
      },
    }
  }

  reconcilePrepared(): void {
    for (const settlement of this.settlements.pending()) {
      try {
        const interaction = interactionFromDict(settlement.interaction)
        const plan = this.apply(settlement)
        this.completeRecoveredInteraction(interaction)
        if (
          plan.status === PlanStatus.COMPLETED ||
          plan.status === PlanStatus.CANCELLED ||
          settlement.action === 'continue_verification'
        )
          this.settlements.markApplied(settlement.id)
      } catch {
        // The prepared record remains durable and will be retried later.
      }
    }
  }

  completeSettlement(settlementId: string): void {
    this.settlements.markApplied(String(settlementId ?? '').trim())
  }

  private apply(settlement: PlanExecutionSettlementRecord): PlanRecord {
    const record = this.cm.planStore.get(settlement.request.planId)
    if (!record) throw new Error('Plan settlement target is unavailable')
    if (hasSettlement(record, settlement.id)) return record
    if (settlement.action === 'cancel_plan')
      return this.cm.execution.cancelPlanFromUserAction({
        planId: record.id,
        stepId: settlement.request.planStepId,
        interactionId: settlement.request.interactionId,
        settlementId: settlement.id,
      })
    if (settlement.action === 'continue_verification') {
      const resumed =
        this.cm.execution.resumeExecution({
          turnId: `control:${settlement.request.interactionId}`,
        }) ?? record
      const updated = stampSettlement(
        updateExecutionPhase(
          resumed,
          settlement.request.planStepId,
          'verifying',
        ),
        settlement,
      )
      return this.cm.planStore.save(updated)
    }
    const targetStep = record.steps.find(
      (step) => step.id === settlement.request.planStepId,
    )
    if (!targetStep) throw new Error('Plan settlement step is unavailable')
    const resolvedRequirementIds =
      settlement.action === 'manual_verification_passed'
        ? requirementsForStep(targetStep)
            .filter(
              (requirement) =>
                requirement.kind === 'manual' &&
                settlement.request.requirementIds.includes(requirement.id),
            )
            .map((requirement) => requirement.id)
        : [...settlement.request.requirementIds]
    if (!resolvedRequirementIds.length)
      throw new Error('Plan settlement has no applicable requirements')
    const now = nowTs()
    const receipt = {
      source:
        settlement.action === 'manual_verification_passed'
          ? 'user_manual_verification'
          : 'user_plan_verification_waiver',
      issued_by: 'core',
      approved_by: 'user',
      settlement_id: settlement.id,
      interaction_id: settlement.request.interactionId,
      plan_id: record.id,
      plan_step_id: settlement.request.planStepId,
      requirement_ids: resolvedRequirementIds,
      checked_at: now,
      passed: settlement.action === 'manual_verification_passed',
      waived: settlement.action === 'waive_verification_and_complete',
    }
    const resumedRecord = withoutExecutionPause(record)
    const steps = resumedRecord.steps.map((step) => {
      if (step.id !== settlement.request.planStepId) return step
      const requirementEvidence = resolvedRequirementIds.map(
        (requirementId) => ({
          ...receipt,
          requirement_id: requirementId,
        }),
      )
      if (settlement.action === 'manual_verification_passed') {
        return {
          ...step,
          evidence: [...step.evidence, ...requirementEvidence],
        }
      }
      return {
        ...step,
        verification: step.verification.map((requirement) =>
          resolvedRequirementIds.includes(requirement.id)
            ? {
                ...requirement,
                status: 'skipped',
                reason: 'user explicitly waived manual verification',
              }
            : requirement,
        ),
        evidence: [...step.evidence, ...requirementEvidence],
      }
    })
    const settledStep = steps.find(
      (step) => step.id === settlement.request.planStepId,
    )!
    const verificationResolved = requirementsForStep(settledStep).every(
      (requirement) =>
        !requirement.required ||
        requirement.status === 'passed' ||
        requirement.status === 'skipped',
    )
    const saved = this.cm.planStore.save(
      stampSettlement(
        updateExecutionPhase(
          { ...resumedRecord, steps, updatedAt: now },
          settlement.request.planStepId,
          verificationResolved ? 'completed' : 'verifying',
        ),
        settlement,
      ),
    )
    return this.cm.execution.reconcileAfterVerification(saved)
  }

  private completeRecoveredInteraction(interaction: Interaction): void {
    const state = this.cm.store.load()
    if (state.pending?.id !== interaction.id) return
    const answered = touchInteraction(interaction, {
      status: InteractionStatus.ANSWERED,
    })
    state.pending = null
    state.lastInteraction = answered
    state.updatedAt = nowTs()
    this.cm.store.save(state)
  }
}

function actionOptions(actions: PlanExecutionAction[]) {
  const options: Record<
    PlanExecutionAction,
    { id: PlanExecutionAction; label: string; description: string }
  > = {
    continue_verification: {
      id: 'continue_verification',
      label: '继续自动验证',
      description: '继续执行当前环境能够完成的验证。',
    },
    manual_verification_passed: {
      id: 'manual_verification_passed',
      label: '我已人工验证通过',
      description: '记录由用户明确确认的人工验证证据。',
    },
    waive_verification_and_complete: {
      id: 'waive_verification_and_complete',
      label: '跳过验证并完成',
      description: '记录可审计风险豁免；最终报告会明确披露。',
    },
    cancel_plan: {
      id: 'cancel_plan',
      label: '取消计划',
      description: '停止当前计划，不自动回滚已经修改的文件。',
    },
  }
  return actions.map((action) => options[action])
}

function allowedActionsFor(
  requirements: ReturnType<typeof requirementsForStep>,
): PlanExecutionAction[] {
  const actions: PlanExecutionAction[] = []
  if (requirements.some((requirement) => requirement.kind !== 'manual'))
    actions.push('continue_verification')
  if (requirements.some((requirement) => requirement.kind === 'manual'))
    actions.push('manual_verification_passed')
  actions.push('waive_verification_and_complete', 'cancel_plan')
  return actions
}

function answerAction(interaction: Interaction): PlanExecutionAction {
  const answer = interaction.answers[PLAN_EXECUTION_ACTION_QUESTION_ID]
  if (!answer || typeof answer !== 'object' || Array.isArray(answer))
    throw new Error('Plan execution action answer is missing')
  return String(
    (answer as Record<string, unknown>).option_id ?? '',
  ) as PlanExecutionAction
}

function requestPayload(
  request: PlanExecutionActionRequest & { coreSignature?: string },
): PlanExecutionActionRequest {
  return {
    version: 1,
    interactionId: String(request.interactionId),
    sessionId: String(request.sessionId),
    planId: String(request.planId),
    planStepId: String(request.planStepId),
    approvalGeneration: Number(request.approvalGeneration),
    requirementIds: [...(request.requirementIds ?? [])].map(String),
    allowedActions: [...(request.allowedActions ?? [])],
    issuedBy: 'core',
  }
}

function hasImplementationClaim(record: PlanRecord, stepId: string): boolean {
  const claims = record.metadata.implementation_claims
  return Boolean(
    claims &&
      typeof claims === 'object' &&
      !Array.isArray(claims) &&
      (claims as Record<string, unknown>)[stepId],
  )
}

function executionPhase(record: PlanRecord, stepId: string): string {
  const phases = record.metadata.plan_step_execution_phases
  if (!phases || typeof phases !== 'object' || Array.isArray(phases)) return ''
  return String((phases as Record<string, unknown>)[stepId] ?? '').trim()
}

function hasRepeatedVerificationFailure(
  step: PlanRecord['steps'][number],
): boolean {
  let signature = ''
  let count = 0
  for (let index = step.evidence.length - 1; index >= 0; index -= 1) {
    const evidence = step.evidence[index]!
    if (
      evidence.source !== 'core_plan_step_verification' ||
      evidence.passed !== false
    )
      continue
    const current = canonicalJson({
      command: String(evidence.command ?? ''),
      exit_code: evidence.exit_code ?? null,
      summary: String(evidence.summary ?? evidence.error ?? ''),
    } as never)
    if (!signature) signature = current
    if (signature !== current) break
    count += 1
    if (count >= 3) return true
  }
  return false
}

function planSessionId(record: PlanRecord, cm: ControlManager): string {
  const scope = cm.planScopeMetadata()
  return String(
    record.sessionId ?? scope?.session_id ?? record.metadata.session_id ?? '',
  ).trim()
}

function updateExecutionPhase(
  record: PlanRecord,
  stepId: string,
  phase: string,
): PlanRecord {
  const phases = {
    ...((record.metadata.plan_step_execution_phases as Record<
      string,
      string
    >) ?? {}),
    [stepId]: phase,
  }
  return {
    ...record,
    metadata: {
      ...record.metadata,
      plan_step_execution_phases: phases,
    },
  }
}

function withoutExecutionPause(record: PlanRecord): PlanRecord {
  const metadata = { ...record.metadata }
  delete metadata.execution_pause
  return { ...record, metadata }
}

function stampSettlement(
  record: PlanRecord,
  settlement: PlanExecutionSettlementRecord,
): PlanRecord {
  const receipts = [
    ...(((record.metadata.plan_execution_settlements as unknown[]) ?? [])
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({ ...(item as Record<string, unknown>) }))),
    {
      settlement_id: settlement.id,
      interaction_id: settlement.request.interactionId,
      action: settlement.action,
      issued_by: 'core',
      applied_at: nowTs(),
    },
  ]
  return {
    ...record,
    metadata: {
      ...record.metadata,
      plan_execution_settlements: receipts,
    },
  }
}

function hasSettlement(record: PlanRecord, settlementId: string): boolean {
  const receipts = record.metadata.plan_execution_settlements
  return (
    Array.isArray(receipts) &&
    receipts.some(
      (receipt) =>
        receipt &&
        typeof receipt === 'object' &&
        String((receipt as Record<string, unknown>).settlement_id ?? '') ===
          settlementId,
    )
  )
}

function resolutionMessage(
  action: PlanExecutionAction,
  plan: PlanRecord,
): string {
  if (action === 'cancel_plan')
    return '[CONTROL:PLAN_EXECUTION_CANCELLED]\n当前计划已取消；已写入的文件不会自动回滚。'
  if (action === 'manual_verification_passed')
    return '[CONTROL:PLAN_MANUAL_VERIFICATION_RECORDED]\n已记录用户明确确认的人工验证结果。'
  if (action === 'waive_verification_and_complete')
    return '[CONTROL:PLAN_VERIFICATION_WAIVED]\n已记录用户明确豁免；最终报告必须披露手动验证未执行。'
  return `[CONTROL:PLAN_VERIFICATION_CONTINUE]\n继续验证计划 ${plan.id}。`
}
