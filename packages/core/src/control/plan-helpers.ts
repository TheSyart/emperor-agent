/**
 * Plan-domain 纯函数 (MIG-CTRL-010)。对齐 Python `agent/control/plan_helpers.py`。
 * 无 ControlManager 状态；只接受 plain values / PlanRecord / PlanStep。
 */
import { nowTs } from '../util/time'
import {
  PlanDraftPhase,
  PlanStepStatus,
  draftToDict,
  makeStep,
  type PlanDraftState,
  type PlanRecord,
  type PlanStep,
} from '../plans/models'
import { assessStepVerification, failedRequired } from '../plans/evidence'
import { requirementFromDict } from '../plans/verification'

export const INDEPENDENT_VERIFICATION_SOURCE = 'independent_verification'
export const INDEPENDENT_VERIFICATION_WAIVER_SOURCE = 'independent_verification_waiver'
export const INDEPENDENT_VERIFICATION_SOURCES = new Set([
  INDEPENDENT_VERIFICATION_SOURCE,
  'verification_reviewer',
  'reviewer',
  'verification_subagent',
])

// Task status string values (W14 tasks/ not migrated — values match agent/tasks TaskStatus).
const TASK_STATUS = {
  RUNNING: 'running',
  QUEUED: 'queued',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PENDING: 'pending',
} as const

export function firstHeading(text: string): string {
  for (const line of text.split('\n')) {
    const stripped = line.trim()
    if (stripped.startsWith('#')) return stripped.replace(/^#+/, '').trim().slice(0, 160)
  }
  return ''
}

export function plainSummary(text: string): string {
  const compact = text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.trim().replace(/^[-*#\s]+/, ''))
    .join(' ')
  return (compact || '计划待预览。').slice(0, 1200)
}

export function looksLikePlan(text: string): boolean {
  return Boolean(
    text.includes('##') ||
      text.includes('\n-') ||
      text.includes('\n1.') ||
      text.includes('验收') ||
      text.includes('Test Plan'),
  )
}

export function parsePlanSteps(items: Array<Record<string, unknown>>): PlanStep[] {
  const steps: PlanStep[] = []
  items.forEach((item, idx) => {
    const index = idx + 1
    if (!item || typeof item !== 'object') return
    const title = String(item.title ?? '').trim()
    if (!title) return
    steps.push(
      makeStep({
        id: (String(item.id ?? `step_${index}`).trim() || `step_${index}`).slice(0, 64),
        title: title.slice(0, 160),
        description: String(item.description ?? '').trim().slice(0, 1000),
        files: ((item.files as unknown[]) ?? []).map((p) => String(p)).slice(0, 30),
        commands: ((item.commands as unknown[]) ?? []).map((c) => String(c)).slice(0, 12),
        acceptance: ((item.acceptance as unknown[]) ?? []).map((r) => String(r)).slice(0, 12),
        discoveryRefs: ((item.discovery_refs ?? item.discoveryRefs ?? []) as unknown[])
          .map((r) => String(r))
          .filter((r) => r.trim())
          .slice(0, 12),
        verification: ((item.verification ?? item.verification_requirements ?? []) as unknown[])
          .filter((raw) => raw && typeof raw === 'object')
          .map((raw) => requirementFromDict(raw as Record<string, unknown>))
          .slice(0, 20),
        risk: String(item.risk ?? 'medium').trim().slice(0, 24),
        riskNote: String(item.risk_note ?? item.riskNote ?? '').trim().slice(0, 1000),
        rollback: String(item.rollback ?? item.rollback_path ?? item.rollbackPath ?? '').trim().slice(0, 1000),
      }),
    )
  })
  return steps
}

export function readyForApprovalDraft(draft: PlanDraftState, opts: { summary: string; steps: PlanStep[] }): PlanDraftState {
  const files = [...draft.relevantFiles]
  const commands = [...draft.verificationStrategy]
  for (const step of opts.steps) {
    files.push(...step.files)
    commands.push(...step.commands)
  }
  return {
    ...draft,
    phase: PlanDraftPhase.READY_FOR_APPROVAL,
    relevantFiles: dedupeStrings(files),
    recommendedApproach: String(opts.summary ?? '').trim().slice(0, 1200),
    verificationStrategy: dedupeStrings(commands),
  }
}

export function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const text = String(item ?? '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

export function normalizeCommand(command: unknown): string {
  return String(command ?? '').trim().split(/\s+/).filter((p) => p).join(' ')
}

export function planStepsFinished(record: PlanRecord): boolean {
  return record.steps.length > 0 && record.steps.every((step) => step.status === PlanStepStatus.DONE || step.status === PlanStepStatus.SKIPPED)
}

export function planChangedFiles(record: PlanRecord): string[] {
  const files: string[] = [...record.draft.relevantFiles]
  for (const step of record.steps) files.push(...step.files)
  return dedupeStrings(files)
}

export function planCommands(record: PlanRecord): string[] {
  const commands: string[] = [...record.draft.verificationStrategy]
  for (const step of record.steps) commands.push(...step.commands)
  return dedupeStrings(commands)
}

export function independentVerificationRiskSignals(record: PlanRecord, changedFiles: string[]): string[] {
  const signals: string[] = []
  if (changedFiles.length >= 3) signals.push('changed_files>=3')
  for (const path of changedFiles) appendFileRiskSignals(signals, path)
  const text = planRiskText(record)
  const tokenSignals: Array<[string, string]> = [
    ['delete', 'deletion'], ['remove', 'deletion'], ['rm ', 'deletion'], ['删除', 'deletion'], ['移除', 'deletion'],
    ['deploy', 'deployment'], ['deployment', 'deployment'], ['publish', 'deployment'], ['release', 'deployment'], ['部署', 'deployment'], ['发布', 'deployment'],
    ['external send', 'external_send'], ['send_external', 'external_send'], ['outbound', 'external_send'], ['外发', 'external_send'], ['外部发送', 'external_send'],
    ['security', 'security'], ['auth', 'security'], ['secret', 'security'], ['token', 'security'],
    ['permission', 'permission'], ['权限', 'permission'], ['安全', 'security'],
    ['migration', 'data_migration'], ['migrate', 'data_migration'], ['schema', 'data_migration'], ['迁移', 'data_migration'],
  ]
  for (const [token, signal] of tokenSignals) {
    if (text.includes(token)) appendUnique(signals, signal)
  }
  return signals
}

function appendFileRiskSignals(signals: string[], path: string): void {
  const normalized = String(path ?? '').trim().replace(/\\/g, '/').toLowerCase()
  if (!normalized) return
  const checks: Array<[string[], string]> = [
    [['packages/core/src/api/', 'desktop/src/main/core-host', 'desktop/src/main/ipc', 'desktop/src/preload/', 'desktop/src/renderer/src/api/', 'agent/web/', 'agent/webui.py', 'webui.py', '/routes/', '/api/'], 'api'],
    [['packages/core/src/permissions/', 'agent/permissions/', 'permission'], 'permission'],
    [['packages/core/src/control/', 'packages/core/src/plans/', 'agent/control/'], 'control'],
    [['packages/core/src/scheduler/', 'agent/scheduler/', 'scheduler'], 'scheduler'],
    [['packages/core/src/runtime/', 'packages/core/src/agent/runtime-events', 'desktop/src/renderer/src/runtime/', 'agent/runtime/', '/runtime/'], 'runtime'],
    [['packages/core/src/external/', 'agent/external/', 'external', 'outbox', 'outbound'], 'external_send'],
    [['packages/core/src/agent/', 'packages/core/src/tools/', 'packages/core/src/tasks/', 'packages/core/src/team/', 'packages/core/src/subagents/', 'packages/core/src/mcp/', 'agent/runner.py', 'agent/loop.py', 'agent/tools/', 'agent/tasks/', 'agent/team/', 'agent/mcp/'], 'backend'],
    [['security', 'auth', 'secret', 'token', 'credential'], 'security'],
    [['migration', 'migrations', 'schema'], 'data_migration'],
    [['deploy', 'release', 'publish'], 'deployment'],
    [['delete', 'remove', 'unlink'], 'deletion'],
  ]
  for (const [needles, signal] of checks) {
    if (needles.some((n) => normalized.includes(n))) appendUnique(signals, signal)
  }
}

function planRiskText(record: PlanRecord): string {
  const parts: string[] = [record.title, record.summary, record.planMarkdown, ...(record.assumptions ?? [])]
  for (const step of record.steps) {
    parts.push(step.title, step.description, step.riskNote, step.rollback, ...(step.acceptance ?? []), ...(step.commands ?? []), ...(step.files ?? []))
  }
  return parts.map((item) => String(item ?? '')).join('\n').toLowerCase()
}

export function latestIndependentVerificationEvidence(record: PlanRecord): Record<string, unknown> | null {
  const candidates: Array<Record<string, unknown>> = []
  for (const item of record.verification) {
    if (!item || typeof item !== 'object') continue
    const source = String((item as Record<string, unknown>).source ?? '')
    if (INDEPENDENT_VERIFICATION_SOURCES.has(source) || source === INDEPENDENT_VERIFICATION_WAIVER_SOURCE) {
      candidates.push(item as Record<string, unknown>)
    }
  }
  return candidates.length ? candidates[candidates.length - 1]! : null
}

export function hasCommandEvidence(evidence: Record<string, unknown>): boolean {
  const command = String(evidence.command ?? '').trim()
  if (command) return true
  const commands = evidence.commands
  if (Array.isArray(commands) && commands.some((item) => String(item ?? '').trim())) return true
  const commandEvidence = evidence.command_evidence
  return Array.isArray(commandEvidence) && commandEvidence.some((item) => item && typeof item === 'object' && String((item as Record<string, unknown>).command ?? '').trim())
}

export function metadataWithoutPlanPermissionTokens(metadata: Record<string, unknown>, opts?: { reason?: string }): Record<string, unknown> {
  const payload = { ...(metadata ?? {}) }
  const hadTokens = Boolean(payload.permission_tokens && (payload.permission_tokens as unknown[]).length)
  payload.permission_tokens = []
  if (hadTokens) {
    payload.permission_tokens_revoked = {
      reason: String(opts?.reason ?? 'revoked').slice(0, 240),
      timestamp: nowTs(),
    }
  }
  return payload
}

export function taskStatusFromPlanStep(status: string): string {
  if (status === PlanStepStatus.ACTIVE) return TASK_STATUS.RUNNING
  if (status === PlanStepStatus.PENDING) return TASK_STATUS.QUEUED
  if (status === PlanStepStatus.DONE || status === PlanStepStatus.SKIPPED) return TASK_STATUS.COMPLETED
  if (status === PlanStepStatus.FAILED) return TASK_STATUS.FAILED
  if (status === PlanStepStatus.BLOCKED) return TASK_STATUS.PENDING
  return TASK_STATUS.PENDING
}

export function stepVerificationStatus(step: PlanStep): string {
  const assessment = assessStepVerification(step)
  if (failedRequired(assessment).length) return 'failed'
  if (assessment.requirements.length) {
    if (!assessment.blockingErrors.length) return 'passed'
    return 'pending'
  }
  return 'not_required'
}

function appendUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value)
}

/** draft.to_dict 透传（plan_helpers 内部用）。 */
export { draftToDict }
