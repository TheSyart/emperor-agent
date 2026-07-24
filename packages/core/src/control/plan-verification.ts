/**
 * PlanVerificationManager (MIG-CTRL-008)。对齐 Python `agent/control/plan_verification.py`。
 * 命令型 step 验证 + 独立 reviewer 流程。
 */
import { nowTs } from '../util/time'
import {
  computeGoalToolInputSha256,
  type GoalPlanVerificationFact,
  type GoalPlanVerificationSource,
} from '../goals/evidence'
import type { GoalRecord } from '../goals/models'
import { planMatchesGoalScope } from '../goals/scope'
import type {
  PlanReviewerContext,
  PlanReviewerFact,
  PlanStepVerificationContext,
  PlanStepVerificationFact,
  PlanStepWaiverContext,
  PlanStepWaiverFact,
} from '../goals/plan-bridge'
import type {
  GoalReviewerWaiverActionContext,
  GoalReviewerWaiverActionFact,
} from '../goals/reviewer'
import { parseReviewerVerdict, verdictToPayload } from '../plans/reviewer'
import {
  PlanStatus,
  PlanStepStatus,
  planToDict,
  type PlanRecord,
} from '../plans/models'
import { requirementsForStep } from '../plans/verification'
import {
  ControlMode,
  InteractionStatus,
  makeAsk,
  questionFromDict,
  type Interaction,
} from './models'
import {
  INDEPENDENT_VERIFICATION_SOURCE,
  INDEPENDENT_VERIFICATION_WAIVER_SOURCE,
  dedupeStrings,
  hasCommandEvidence,
  independentVerificationRiskSignals,
  latestIndependentVerificationEvidence,
  isPlanInvalidated,
  latestApprovedPlanGeneration,
  planChangedFiles,
  planCommands,
  planStepsFinished,
} from './plan-helpers'
import type { ControlManagerHost } from './host'
import { CoreControlActionSigner } from './core-action-signature'
import { canonicalJson } from '../goals/events'

interface ReviewRequest {
  planId: string
  changedFiles: string[]
  commands: string[]
  riskSignals: string[]
  createdAt: number
  reason: string
}

export const GOAL_REVIEWER_WAIVER_QUESTION_ID = 'goal_reviewer_waiver'
export const GOAL_REVIEWER_WAIVER_APPROVE_LABEL =
  'Waive independent verification'
export const GOAL_REVIEWER_WAIVER_DECLINE_LABEL = 'Keep verification required'

function reviewRequestToDict(r: ReviewRequest): Record<string, unknown> {
  return {
    plan_id: r.planId,
    changed_files: r.changedFiles,
    commands: r.commands,
    risk_signals: r.riskSignals,
    created_at: r.createdAt,
    reason: r.reason,
  }
}

export class PlanVerificationManager {
  private readonly cm: ControlManagerHost
  private readonly signer: CoreControlActionSigner
  constructor(cm: ControlManagerHost) {
    this.cm = cm
    this.signer = new CoreControlActionSigner(cm.store.root)
  }

  planVerificationTarget(command: string): Record<string, string> | null {
    const record = this.cm.latestExecutablePlan()
    if (record === null) return null
    const requested = String(command ?? '')
    for (const step of record.steps) {
      if (step.status !== PlanStepStatus.ACTIVE) continue
      for (const requirement of requirementsForStep(step)) {
        if (requirement.kind !== 'command' || !requirement.command) continue
        if (requirement.command === requested) {
          return {
            plan_id: record.id,
            step_id: step.id,
            command: requirement.command,
            requirement_id: requirement.id,
            approved_input_hash: computeGoalToolInputSha256('run_command', {
              command: requirement.command,
            }).inputSha256,
          }
        }
      }
    }
    return null
  }

  resolveGoalPlanVerificationFact(
    goalId: string,
    goal: GoalRecord,
    source: GoalPlanVerificationSource,
  ): GoalPlanVerificationFact | null {
    if (goal.id !== goalId || goal.status !== 'active') return null
    const record = this.currentGoalPlan(goal, source.planId)
    if (!record || goal.runtime.currentPlanId !== record.id) return null
    const step = record.steps.find((item) => item.id === source.stepId)
    if (!step) return null
    const requirement = requirementsForStep(step).find(
      (item) =>
        item.id === source.requirementId &&
        item.kind === 'command' &&
        typeof item.command === 'string',
    )
    if (!requirement?.command) return null
    const approvedInputHash = computeGoalToolInputSha256('run_command', {
      command: requirement.command,
    }).inputSha256
    if (approvedInputHash !== source.approvedInputHash) return null
    const evidence = [...step.evidence]
      .reverse()
      .find(
        (item) =>
          String(item.requirement_id ?? item.verification_id ?? '') ===
            source.requirementId &&
          String(item.tool_call_id ?? '') === source.toolCallId &&
          String(item.command ?? '') === requirement.command &&
          item.passed === true &&
          Number(item.exit_code) === 0,
      )
    if (!evidence) return null
    return {
      ...source,
      goalId,
      passed: true,
      summary: String(evidence.summary ?? 'Plan command verification'),
    }
  }

  resolvePlanStepVerificationFact(
    goal: GoalRecord,
    context: PlanStepVerificationContext,
    knownPlan?: PlanRecord,
  ): PlanStepVerificationFact | null {
    const record = knownPlan
      ? this.validateKnownGoalPlan(goal, context.planId, knownPlan)
      : this.currentGoalPlan(goal, context.planId)
    if (!record || record.eventSeq !== context.planEventSeq) return null
    const step = record.steps.find((item) => item.id === context.stepId)
    const requirement = step
      ? requirementsForStep(step).find(
          (item) =>
            item.id === context.requirementId &&
            item.kind === context.requirementKind &&
            item.command === context.command,
        )
      : null
    if (!step || !requirement) return null
    const evidence = [...step.evidence]
      .reverse()
      .find(
        (item) =>
          item.source === 'core_plan_step_verification' &&
          item.issued_by === 'core' &&
          item.plan_id === record.id &&
          item.plan_step_id === step.id &&
          String(item.requirement_id ?? item.verification_id ?? '') ===
            requirement.id &&
          String(item.command ?? '') === requirement.command &&
          String(item.tool_call_id ?? '').trim(),
      )
    if (
      !evidence ||
      evidence.passed !== true ||
      Number(evidence.exit_code) !== 0
    )
      return null
    return {
      ...context,
      kind: 'core_plan_step_verification',
      issuedBy: 'core',
      verdict: 'pass',
      receiptId: String(evidence.tool_call_id),
    }
  }

  resolvePlanStepWaiverFact(
    goal: GoalRecord,
    context: PlanStepWaiverContext,
    knownPlan?: PlanRecord,
  ): PlanStepWaiverFact | null {
    const record = knownPlan
      ? this.validateKnownGoalPlan(goal, context.planId, knownPlan)
      : this.currentGoalPlan(goal, context.planId)
    const step = record?.steps.find((item) => item.id === context.stepId)
    if (!record || !step || step.status !== PlanStepStatus.SKIPPED) return null
    const evidence = [...step.evidence]
      .reverse()
      .find(
        (item) =>
          item.source === 'goal_plan_step_waiver' &&
          item.issued_by === 'core' &&
          item.approved_by === 'user' &&
          item.goal_id === goal.id &&
          item.plan_id === record.id &&
          item.plan_step_id === step.id &&
          String(item.receipt_id ?? '').trim(),
      )
    if (!evidence) return null
    return {
      ...context,
      kind: 'explicit_user_plan_step_waiver',
      issuedBy: 'core',
      approvedBy: 'user',
      receiptId: String(evidence.receipt_id),
    }
  }

  resolvePlanReviewerFact(
    goal: GoalRecord,
    context: PlanReviewerContext,
  ): PlanReviewerFact | null {
    const record = this.currentGoalPlan(goal, context.planId)
    if (!record || record.eventSeq !== context.planEventSeq) return null
    const latest = latestIndependentVerificationEvidence(record)
    if (!latest || latest.issued_by !== 'core') return null
    const receiptId = String(latest.receipt_id ?? '').trim()
    if (!receiptId) return null
    if (
      latest.source === INDEPENDENT_VERIFICATION_WAIVER_SOURCE &&
      latest.waived === true &&
      latest.passed === true &&
      latest.approved_by === 'user'
    )
      return {
        ...context,
        kind: 'core_independent_plan_review',
        issuedBy: 'core',
        verdict: 'waived',
        receiptId,
        commandEvidenceRefs: [],
      }
    if (
      latest.source !== INDEPENDENT_VERIFICATION_SOURCE ||
      latest.passed !== true ||
      !hasCommandEvidence(latest)
    )
      return null
    return {
      ...context,
      kind: 'core_independent_plan_review',
      issuedBy: 'core',
      verdict: 'pass',
      receiptId,
      commandEvidenceRefs: dedupeStrings(
        ((latest.commands as unknown[]) ?? []).map(
          (_command, index) => `${receiptId}:command:${index + 1}`,
        ),
      ),
    }
  }

  requestGoalReviewerWaiver(opts: {
    goal: GoalRecord
    planId: string
    planEventSeq: number
    riskSignals: readonly string[]
    riskFactVersion: string | null
    reason: string
  }): Interaction {
    const reason = String(opts.reason ?? '').trim()
    if (!reason) throw new Error('reviewer waiver reason is required')
    const plan = this.currentGoalPlan(opts.goal, String(opts.planId ?? ''))
    if (!plan || plan.eventSeq !== Number(opts.planEventSeq))
      throw new Error('Goal reviewer waiver Plan generation is stale')
    const riskSignals = normalizeRiskSignals(opts.riskSignals)
    if (riskSignals.length === 0)
      throw new Error('reviewer waiver risk disclosure is required')
    this.cm.ensureNoPending()
    const interaction = makeAsk({
      questions: [
        questionFromDict({
          id: GOAL_REVIEWER_WAIVER_QUESTION_ID,
          header: 'Verification',
          question:
            'Independent verification is required. Do you explicitly accept the disclosed verification risk?',
          options: [
            {
              label: GOAL_REVIEWER_WAIVER_APPROVE_LABEL,
              description:
                'Complete without independent verification and disclose the waiver in the receipt.',
            },
            {
              label: GOAL_REVIEWER_WAIVER_DECLINE_LABEL,
              description:
                'Keep the Goal blocked until a reviewer is available.',
            },
          ],
        }),
      ],
      context: [
        `Reason: ${reason}`,
        `Core risk signals: ${riskSignals.join(', ')}`,
        `Core risk frontier: ${normalizeRiskFactVersion(opts.riskFactVersion) ?? 'unavailable'}`,
      ].join('\n'),
      meta: {},
    })
    const request = {
      version: 1,
      issued_by: 'core',
      action: 'waive_goal_independent_verification',
      interaction_id: interaction.id,
      goal_id: opts.goal.id,
      plan_id: plan.id,
      plan_event_seq: plan.eventSeq,
      risk_signals: riskSignals,
      risk_fact_version: normalizeRiskFactVersion(opts.riskFactVersion),
      question: reviewerWaiverQuestionIdentity(interaction),
    }
    interaction.meta = {
      goal_reviewer_waiver_request: {
        ...request,
        core_signature: this.signer.sign(request),
      },
    }
    this.cm.setPending(interaction)
    return interaction
  }

  resolveGoalReviewerWaiverAction(
    goal: GoalRecord,
    context: GoalReviewerWaiverActionContext,
  ): GoalReviewerWaiverActionFact | null {
    const plan = this.currentGoalPlan(goal, context.planId)
    if (!plan || plan.eventSeq !== context.planEventSeq) return null
    const interaction = this.cm.store.load().lastInteraction
    if (
      !interaction ||
      interaction.id !== context.interactionId ||
      interaction.kind !== 'ask' ||
      interaction.status !== InteractionStatus.ANSWERED
    )
      return null
    const request = interaction.meta.goal_reviewer_waiver_request
    if (!request || typeof request !== 'object' || Array.isArray(request))
      return null
    const stamped = request as Record<string, unknown>
    const signed = {
      version: stamped.version,
      issued_by: stamped.issued_by,
      action: stamped.action,
      interaction_id: stamped.interaction_id,
      goal_id: stamped.goal_id,
      plan_id: stamped.plan_id,
      plan_event_seq: stamped.plan_event_seq,
      risk_signals: stamped.risk_signals,
      risk_fact_version: stamped.risk_fact_version,
      question: stamped.question,
    }
    if (
      stamped.version !== 1 ||
      stamped.issued_by !== 'core' ||
      stamped.action !== 'waive_goal_independent_verification' ||
      stamped.interaction_id !== interaction.id ||
      stamped.goal_id !== context.goalId ||
      stamped.plan_id !== context.planId ||
      Number(stamped.plan_event_seq) !== context.planEventSeq ||
      canonicalJson(stamped.risk_signals as never) !==
        canonicalJson(context.riskSignals as never) ||
      normalizeRiskFactVersion(stamped.risk_fact_version) !==
        context.riskFactVersion ||
      canonicalJson(stamped.question as never) !==
        canonicalJson(reviewerWaiverQuestionIdentity(interaction) as never) ||
      !this.signer.verify(signed, stamped.core_signature)
    )
      return null
    const answer = interaction.answers[GOAL_REVIEWER_WAIVER_QUESTION_ID]
    if (
      !answer ||
      typeof answer !== 'object' ||
      Array.isArray(answer) ||
      String((answer as Record<string, unknown>).choice ?? '') !==
        GOAL_REVIEWER_WAIVER_APPROVE_LABEL
    )
      return null
    return {
      ...context,
      kind: 'explicit_user_goal_reviewer_waiver_action',
      issuedBy: 'core',
      approvedBy: 'user',
      verdict: 'waived',
      riskSignals: [...context.riskSignals],
      riskFactVersion: context.riskFactVersion,
    }
  }

  recordPlanVerificationResult(opts: {
    planId: string
    stepId: string
    result: Record<string, unknown>
  }): PlanRecord | null {
    const record = this.cm.planStore
      .list()
      .find((item) => item.id === opts.planId)
    if (
      record === undefined ||
      isPlanInvalidated(record) ||
      (record.status !== PlanStatus.APPROVED &&
        record.status !== PlanStatus.EXECUTING &&
        record.status !== PlanStatus.COMPLETED)
    )
      return null
    if (this.cm.latestReviewablePlan()?.id !== record.id) return null
    if (!record.steps.some((step) => step.id === opts.stepId)) return null
    const now = nowTs()
    const trustedResult = {
      ...opts.result,
      source: 'core_plan_step_verification',
      issued_by: 'core',
      plan_id: record.id,
      plan_step_id: opts.stepId,
    }
    const steps = record.steps.map((step) =>
      step.id === opts.stepId
        ? { ...step, evidence: [...step.evidence, trustedResult] }
        : step,
    )
    const metadata = { ...record.metadata }
    const updated = {
      ...record,
      status:
        record.status === PlanStatus.COMPLETED
          ? PlanStatus.COMPLETED
          : PlanStatus.EXECUTING,
      updatedAt: now,
      steps,
      metadata,
    }
    const saved = this.cm.planStore.save(updated)
    this.cm.appendPlanStepVerification(saved, {
      stepId: opts.stepId,
      result: trustedResult,
    })
    return saved
  }

  recordIndependentVerificationResult(opts: {
    planId: string
    result: Record<string, unknown>
  }): PlanRecord | null {
    return this.saveIndependentVerificationResult(opts, false)
  }

  private saveIndependentVerificationResult(
    opts: {
      planId: string
      result: Record<string, unknown>
    },
    trusted: boolean,
  ): PlanRecord | null {
    const record = this.cm.planStore.get(opts.planId)
    if (record === null) return null
    const now = nowTs()
    const payload = { ...(opts.result ?? {}) }
    payload.source = INDEPENDENT_VERIFICATION_SOURCE
    if (trusted) {
      payload.issued_by = 'core'
      const suppliedReceipt = String(payload.receipt_id ?? '').trim()
      payload.receipt_id =
        suppliedReceipt ||
        `independent_review_${record.id}_${record.eventSeq + 1}`
    } else {
      // This compatibility entry point may be reached with model-authored
      // payloads. Keep the observation for Plan follow-up, but never let
      // caller-supplied trust fields become a Core/Goal reviewer receipt.
      delete payload.issued_by
      delete payload.receipt_id
    }
    payload.checked_at = Number(payload.checked_at ?? now) || now
    if ('commands' in payload) {
      payload.commands = dedupeStrings(
        ((payload.commands as unknown[]) ?? []).map((item) => String(item)),
      )
    }
    const metadata = { ...record.metadata }
    metadata.independent_verification_latest = payload
    const updated = {
      ...record,
      updatedAt: now,
      verification: [...record.verification, payload],
      metadata,
    }
    return this.cm.planStore.save(updated)
  }

  /**
   * Consume a Core-executed verification_reviewer result as authoritative Plan
   * evidence. The model never writes this evidence directly.
   */
  recordIndependentVerificationToolResult(opts: {
    toolCallId: string
    agentType: string
    output: string
  }): PlanRecord | null {
    const toolCallId = String(opts.toolCallId ?? '').trim()
    if (
      String(opts.agentType ?? '').trim() !== 'verification_reviewer' ||
      !toolCallId
    )
      return null
    const record = this.cm.latestReviewablePlan()
    if (
      record === null ||
      !record.steps.length ||
      !planStepsFinished(record) ||
      !record.metadata.independent_verification_request
    )
      return null
    const duplicate = record.verification.some(
      (item) =>
        item &&
        typeof item === 'object' &&
        String((item as Record<string, unknown>).source ?? '') ===
          INDEPENDENT_VERIFICATION_SOURCE &&
        String((item as Record<string, unknown>).tool_call_id ?? '') ===
          toolCallId,
    )
    if (duplicate) return record

    const verdict = parseReviewerVerdict(String(opts.output ?? ''))
    if (verdict === null) return null
    const payload = {
      ...verdictToPayload(verdict),
      reviewer: 'verification_reviewer',
      tool_call_id: toolCallId,
      receipt_id: `independent_review_${record.id}_${toolCallId}`,
      checked_at: nowTs(),
    }
    const saved = this.saveIndependentVerificationResult(
      {
        planId: record.id,
        result: payload,
      },
      true,
    )
    if (saved === null) return null
    return this.cm.planStore.save({
      ...saved,
      metadata: {
        ...saved.metadata,
        independent_verification_terminal: {
          status: 'ready',
          tool_call_id: toolCallId,
          approval_generation: Number(saved.metadata.approval_generation ?? 0),
          passed: verdict.passed,
          checked_at: payload.checked_at,
        },
      },
    })
  }

  independentVerificationDispatchGuard(agentType: string): string | null {
    if (String(agentType ?? '').trim() !== 'verification_reviewer') return null
    const record = this.cm.latestReviewablePlan()
    if (record === null) return null
    const latest = latestIndependentVerificationEvidence(record)
    if (latest?.passed === true && hasCommandEvidence(latest)) {
      return (
        'Error: independent verification already passed for the current Plan ' +
        'generation. Do not dispatch another reviewer; produce the final reply.'
      )
    }
    return null
  }

  independentVerificationAskGuard(): string | null {
    const record = this.cm.latestReviewablePlan()
    if (record === null) return null
    const terminal = record.metadata.independent_verification_terminal
    if (
      !terminal ||
      typeof terminal !== 'object' ||
      Array.isArray(terminal) ||
      String((terminal as Record<string, unknown>).status ?? '') !== 'ready'
    )
      return null
    return (
      'Error: the current Plan has passed independent verification and is ' +
      'ready for its single final delivery. Do not ask whether the user is ' +
      'satisfied or whether the session should end; produce the final reply now.'
    )
  }

  markIndependentVerificationDelivered(): PlanRecord | null {
    const record = this.cm.latestReviewablePlan()
    if (record === null) return null
    const terminal = record.metadata.independent_verification_terminal
    if (
      !terminal ||
      typeof terminal !== 'object' ||
      Array.isArray(terminal) ||
      String((terminal as Record<string, unknown>).status ?? '') !== 'ready'
    )
      return record
    return this.cm.planStore.save({
      ...record,
      metadata: {
        ...record.metadata,
        independent_verification_terminal: {
          ...(terminal as Record<string, unknown>),
          status: 'delivered',
          delivered_at: nowTs(),
        },
      },
    })
  }

  waiveIndependentVerification(opts: {
    planId: string
    reason: string
  }): PlanRecord | null {
    const record = this.cm.planStore.get(opts.planId)
    if (record === null) return null
    const text = String(opts.reason ?? '').trim()
    if (!text) throw new Error('waiver reason is required')
    const now = nowTs()
    const payload = {
      source: INDEPENDENT_VERIFICATION_WAIVER_SOURCE,
      waived: true,
      passed: true,
      reason: text.slice(0, 1000),
      approved_by: 'user',
      issued_by: 'core',
      receipt_id: `review_waiver_${record.id}_${record.eventSeq + 1}`,
      checked_at: now,
    }
    const metadata = { ...record.metadata }
    metadata.independent_verification_waiver = payload
    const updated = {
      ...record,
      updatedAt: now,
      verification: [...record.verification, payload],
      metadata,
    }
    return this.cm.planStore.save(updated)
  }

  private currentGoalPlan(goal: GoalRecord, planId: string): PlanRecord | null {
    if (goal.status !== 'active' || goal.runtime.currentPlanId !== planId)
      return null
    const catalog = this.cm.planStore.inspectAllIncludingArchives()
    const quarantine = this.cm.planStore.inspectQuarantine(planId)
    if (catalog.issue || quarantine.issue || quarantine.quarantined) return null
    const record = latestApprovedPlanGeneration([...catalog.records], (item) =>
      planBelongsToGoal(item, goal),
    )
    return record &&
      record.id === planId &&
      isExecutionTrustedPlan(record) &&
      planWasApprovedForGoal(record, goal)
      ? record
      : null
  }

  private validateKnownGoalPlan(
    goal: GoalRecord,
    planId: string,
    record: PlanRecord,
  ): PlanRecord | null {
    if (
      goal.status !== 'active' ||
      goal.runtime.currentPlanId !== planId ||
      record.id !== planId ||
      !planBelongsToGoal(record, goal) ||
      !isExecutionTrustedPlan(record) ||
      !planWasApprovedForGoal(record, goal)
    )
      return null
    return record
  }

  planIndependentVerificationFollowup(opts?: {
    dispatchAvailable?: boolean
  }): Record<string, unknown> | null {
    let record = this.cm.latestReviewablePlan()
    if (record === null || !record.steps.length || !planStepsFinished(record))
      return null
    const request = this.independentVerificationRequest(record)
    if (request === null) return null
    record = this.persistIndependentVerificationRequest(record, request)
    const latest = latestIndependentVerificationEvidence(record)
    if (
      latest !== null &&
      latest.source === INDEPENDENT_VERIFICATION_WAIVER_SOURCE
    )
      return null
    if (latest !== null && latest.passed === false) {
      return {
        status: 'failed',
        plan_id: record.id,
        request: reviewRequestToDict(request),
        message: this.independentVerificationFailedMessage(
          record,
          request,
          latest,
        ),
        plan: planToDict(record),
      }
    }
    if (latest !== null && latest.passed === true && hasCommandEvidence(latest))
      return null
    const status = latest === null ? 'required' : 'missing_command_evidence'
    return {
      status,
      plan_id: record.id,
      request: reviewRequestToDict(request),
      message: this.independentVerificationRequiredMessage(record, request, {
        dispatchAvailable: Boolean(opts?.dispatchAvailable),
        missingCommandEvidence: latest !== null,
      }),
      plan: planToDict(record),
    }
  }

  private independentVerificationRequest(
    record: PlanRecord,
  ): ReviewRequest | null {
    const changedFiles = planChangedFiles(record)
    const riskSignals = independentVerificationRiskSignals(record, changedFiles)
    if (!riskSignals.length) return null
    const existing = record.metadata.independent_verification_request
    let createdAt = nowTs()
    if (existing && typeof existing === 'object') {
      const v = Number((existing as Record<string, unknown>).created_at)
      if (Number.isFinite(v)) createdAt = v
    }
    return {
      planId: record.id,
      changedFiles,
      commands: planCommands(record),
      riskSignals,
      createdAt,
      reason: riskSignals.join('; '),
    }
  }

  private persistIndependentVerificationRequest(
    record: PlanRecord,
    request: ReviewRequest,
  ): PlanRecord {
    const payload = reviewRequestToDict(request)
    if (
      JSON.stringify(record.metadata.independent_verification_request) ===
      JSON.stringify(payload)
    )
      return record
    const metadata = { ...record.metadata }
    metadata.independent_verification_request = payload
    const updated = { ...record, updatedAt: nowTs(), metadata }
    return this.cm.planStore.save(updated)
  }

  private independentVerificationRequiredMessage(
    record: PlanRecord,
    request: ReviewRequest,
    opts: { dispatchAvailable: boolean; missingCommandEvidence: boolean },
  ): string {
    const state = this.cm.store.load()
    const hasPending = Boolean(
      state.pending && state.pending.status === InteractionStatus.WAITING,
    )
    const canDispatch = Boolean(
      opts.dispatchAvailable && state.mode !== ControlMode.PLAN && !hasPending,
    )
    const lines = [
      '[PLAN_INDEPENDENT_VERIFICATION_REQUIRED]',
      `plan_id: ${record.id}`,
      `changed_files: ${request.changedFiles.length}`,
      `risk_signals: ${request.riskSignals.join('; ')}`,
      '',
      '该计划属于非平凡或敏感项目变更，不能在没有独立复核证据时最终答复。',
    ]
    if (opts.missingCommandEvidence)
      lines.push('已有复核声明缺少 command evidence，因此不能视为 PASS。')
    if (request.changedFiles.length) {
      lines.push('', 'changed_files:')
      for (const path of request.changedFiles.slice(0, 12))
        lines.push(`- ${path}`)
    }
    if (request.commands.length) {
      lines.push('', 'commands_to_spot_check:')
      for (const command of request.commands.slice(0, 8))
        lines.push(`- ${command}`)
    }
    lines.push('')
    if (canDispatch) {
      lines.push(
        '请先调用 `dispatch_subagent` 派遣独立复核：',
        '- agent_type: "verification_reviewer"',
        '- task: 复核变更文件、计划证据和关键验证命令，输出 PASS/FAIL、证据和风险。',
        '复核 PASS 后，必须把 reviewer 结论和 command evidence 记录为 plan independent verification evidence；若 FAIL，先修复再重新验证。',
      )
    } else {
      lines.push(
        '当前不能安全自动派遣 reviewer。请调用 `ask_user` 请求明确豁免，',
        '或先恢复到可派遣状态后再派 `verification_reviewer`。用户豁免必须记录为 plan verification evidence。',
      )
    }
    return lines.join('\n')
  }

  private independentVerificationFailedMessage(
    record: PlanRecord,
    request: ReviewRequest,
    latest: Record<string, unknown>,
  ): string {
    const summary = String(
      latest.summary ?? latest.reason ?? 'independent verification failed',
    ).trim()
    const lines = [
      '[PLAN_INDEPENDENT_VERIFICATION_FAILED]',
      `plan_id: ${record.id}`,
      `reviewer: ${latest.reviewer ?? latest.source ?? 'unknown'}`,
      `risk_signals: ${request.riskSignals.join('; ')}`,
      `summary: ${summary.slice(0, 800)}`,
      '',
      '独立复核为 FAIL。不要最终答复；先按复核意见诊断并修复，再重新执行关键验证命令。',
      '修复后需要重新取得 independent verification PASS，或取得用户明确豁免并入库。',
    ]
    const commands = latest.commands
    if (Array.isArray(commands) && commands.length) {
      lines.push('', 'review_commands:')
      for (const command of commands.slice(0, 8)) lines.push(`- ${command}`)
    }
    return lines.join('\n')
  }
}

function isExecutionTrustedPlan(record: PlanRecord): boolean {
  if (
    record.status !== PlanStatus.APPROVED &&
    record.status !== PlanStatus.EXECUTING &&
    record.status !== PlanStatus.COMPLETED
  )
    return false
  if (!Number.isFinite(record.approvedAt) || record.approvedAt === null)
    return false
  return !isPlanInvalidated(record)
}

function planBelongsToGoal(record: PlanRecord, goal: GoalRecord): boolean {
  return record.goalId === goal.id && planMatchesGoalScope(record, goal)
}

function planWasApprovedForGoal(record: PlanRecord, goal: GoalRecord): boolean {
  const goalCreatedAt = Date.parse(goal.createdAt) / 1000
  return (
    Number.isFinite(goalCreatedAt) &&
    record.approvedAt !== null &&
    record.approvedAt >= goalCreatedAt
  )
}

function normalizeRiskFactVersion(value: unknown): string | null {
  if (value === null) return null
  const version = String(value ?? '').trim()
  if (!version) throw new Error('reviewer waiver risk frontier is invalid')
  return version
}

function normalizeRiskSignals(values: readonly string[]): string[] {
  if (!Array.isArray(values)) return []
  const output: string[] = []
  for (const value of values) {
    const signal = String(value ?? '').trim()
    if (signal && !output.includes(signal)) output.push(signal)
  }
  return output
}

function reviewerWaiverQuestionIdentity(
  interaction: Interaction,
): Record<string, unknown> {
  if (interaction.questions.length !== 1)
    return { invalid_question_count: interaction.questions.length }
  const question = interaction.questions[0]!
  return {
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    context: interaction.context,
  }
}
