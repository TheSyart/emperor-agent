/**
 * PlanVerificationManager (MIG-CTRL-008)。对齐 Python `agent/control/plan_verification.py`。
 * 命令型 step 验证 + 独立 reviewer 流程。
 */
import { nowTs } from '../util/time'
import { PlanStatus, PlanStepStatus, planToDict, type PlanRecord } from '../plans/models'
import { requirementsForStep } from '../plans/verification'
import { ControlMode, InteractionStatus } from './models'
import {
  INDEPENDENT_VERIFICATION_SOURCE,
  INDEPENDENT_VERIFICATION_WAIVER_SOURCE,
  dedupeStrings,
  hasCommandEvidence,
  independentVerificationRiskSignals,
  latestIndependentVerificationEvidence,
  normalizeCommand,
  planChangedFiles,
  planCommands,
  planStepsFinished,
} from './plan-helpers'
import type { ControlManagerHost } from './host'

interface ReviewRequest {
  planId: string
  changedFiles: string[]
  commands: string[]
  riskSignals: string[]
  createdAt: number
  reason: string
}

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
  constructor(cm: ControlManagerHost) { this.cm = cm }

  planVerificationTarget(command: string): Record<string, string> | null {
    const record = this.cm.latestExecutablePlan()
    if (record === null) return null
    const requested = normalizeCommand(command)
    for (const step of record.steps) {
      if (step.status !== PlanStepStatus.ACTIVE) continue
      for (const requirement of requirementsForStep(step)) {
        if (requirement.kind !== 'command' || !requirement.command) continue
        if (normalizeCommand(requirement.command) === requested) {
          return { plan_id: record.id, step_id: step.id, command: requirement.command, requirement_id: requirement.id }
        }
      }
    }
    return null
  }

  recordPlanVerificationResult(opts: { planId: string; stepId: string; result: Record<string, unknown> }): PlanRecord | null {
    const record = this.cm.planStore.get(opts.planId)
    if (record === null) return null
    const now = nowTs()
    const steps = record.steps.map((step) =>
      step.id === opts.stepId
        ? { ...step, evidence: [...step.evidence, opts.result] }
        : step,
    )
    const metadata = { ...record.metadata }
    const updated = { ...record, status: PlanStatus.EXECUTING, updatedAt: now, steps, metadata }
    this.cm.planStore.save(updated)
    this.cm.appendPlanStepVerification(updated, { stepId: opts.stepId, result: opts.result })
    return updated
  }

  recordIndependentVerificationResult(opts: { planId: string; result: Record<string, unknown> }): PlanRecord | null {
    const record = this.cm.planStore.get(opts.planId)
    if (record === null) return null
    const now = nowTs()
    const payload = { ...(opts.result ?? {}) }
    payload.source = String(payload.source ?? INDEPENDENT_VERIFICATION_SOURCE)
    payload.checked_at = Number(payload.checked_at ?? now) || now
    if ('commands' in payload) {
      payload.commands = dedupeStrings(((payload.commands as unknown[]) ?? []).map((item) => String(item)))
    }
    const metadata = { ...record.metadata }
    metadata.independent_verification_latest = payload
    const updated = { ...record, updatedAt: now, verification: [...record.verification, payload], metadata }
    this.cm.planStore.save(updated)
    return updated
  }

  waiveIndependentVerification(opts: { planId: string; reason: string }): PlanRecord | null {
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
      checked_at: now,
    }
    const metadata = { ...record.metadata }
    metadata.independent_verification_waiver = payload
    const updated = { ...record, updatedAt: now, verification: [...record.verification, payload], metadata }
    this.cm.planStore.save(updated)
    return updated
  }

  planIndependentVerificationFollowup(opts?: { dispatchAvailable?: boolean }): Record<string, unknown> | null {
    let record = this.cm.latestReviewablePlan()
    if (record === null || !record.steps.length || !planStepsFinished(record)) return null
    const request = this.independentVerificationRequest(record)
    if (request === null) return null
    record = this.persistIndependentVerificationRequest(record, request)
    const latest = latestIndependentVerificationEvidence(record)
    if (latest !== null && latest.source === INDEPENDENT_VERIFICATION_WAIVER_SOURCE) return null
    if (latest !== null && latest.passed === false) {
      return {
        status: 'failed',
        plan_id: record.id,
        request: reviewRequestToDict(request),
        message: this.independentVerificationFailedMessage(record, request, latest),
        plan: planToDict(record),
      }
    }
    if (latest !== null && latest.passed === true && hasCommandEvidence(latest)) return null
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

  private independentVerificationRequest(record: PlanRecord): ReviewRequest | null {
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

  private persistIndependentVerificationRequest(record: PlanRecord, request: ReviewRequest): PlanRecord {
    const payload = reviewRequestToDict(request)
    if (JSON.stringify(record.metadata.independent_verification_request) === JSON.stringify(payload)) return record
    const metadata = { ...record.metadata }
    metadata.independent_verification_request = payload
    const updated = { ...record, updatedAt: nowTs(), metadata }
    this.cm.planStore.save(updated)
    return updated
  }

  private independentVerificationRequiredMessage(
    record: PlanRecord,
    request: ReviewRequest,
    opts: { dispatchAvailable: boolean; missingCommandEvidence: boolean },
  ): string {
    const state = this.cm.store.load()
    const hasPending = Boolean(state.pending && state.pending.status === InteractionStatus.WAITING)
    const canDispatch = Boolean(opts.dispatchAvailable && state.mode !== ControlMode.PLAN && !hasPending)
    const lines = [
      '[PLAN_INDEPENDENT_VERIFICATION_REQUIRED]',
      `plan_id: ${record.id}`,
      `changed_files: ${request.changedFiles.length}`,
      `risk_signals: ${request.riskSignals.join('; ')}`,
      '',
      '该计划属于非平凡或敏感项目变更，不能在没有独立复核证据时最终答复。',
    ]
    if (opts.missingCommandEvidence) lines.push('已有复核声明缺少 command evidence，因此不能视为 PASS。')
    if (request.changedFiles.length) {
      lines.push('', 'changed_files:')
      for (const path of request.changedFiles.slice(0, 12)) lines.push(`- ${path}`)
    }
    if (request.commands.length) {
      lines.push('', 'commands_to_spot_check:')
      for (const command of request.commands.slice(0, 8)) lines.push(`- ${command}`)
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

  private independentVerificationFailedMessage(record: PlanRecord, request: ReviewRequest, latest: Record<string, unknown>): string {
    const summary = String(latest.summary ?? latest.reason ?? 'independent verification failed').trim()
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
