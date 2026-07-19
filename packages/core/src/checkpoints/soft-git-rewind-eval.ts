import { createHash } from 'node:crypto'
import type { SoftGitRewindEvaluationGateReceipt } from './soft-git-rewind'

export const SOFT_GIT_REWIND_EVALUATION_CASES = [
  'managed_file_only',
  'linear_commit_soft_reset',
  'unrelated_dirty_abort',
  'unrelated_dirty_stash',
  'stale_preview_veto',
  'file_conflict_veto',
  'divergent_head_veto',
  'git_operation_veto',
  'linked_worktree_veto',
  'private_storage_symlink_veto',
  'project_filter_veto',
  'stash_volume_veto',
  'head_index_rollback',
  'restart_readonly_reconcile',
  'corrupt_journal_isolation',
  'forbidden_command_scan',
] as const

export type SoftGitRewindEvaluationCaseId =
  (typeof SOFT_GIT_REWIND_EVALUATION_CASES)[number]

export const SOFT_GIT_REWIND_EVALUATION_DATASET_SHA256 = createHash('sha256')
  .update(
    JSON.stringify({
      schemaVersion: 1,
      datasetId: 'soft-git-rewind-safety-v1',
      cases: SOFT_GIT_REWIND_EVALUATION_CASES,
    }),
  )
  .digest('hex')

export interface SoftGitRewindEvaluationCaseReceipt {
  id: SoftGitRewindEvaluationCaseId
  passed: boolean
  durationMs: number
}

export interface SoftGitRewindEvaluationReport {
  schemaVersion: 1
  datasetId: 'soft-git-rewind-safety-v1'
  datasetSha256: string
  platform: string
  gitVersion: string
  cases: SoftGitRewindEvaluationCaseReceipt[]
  forbiddenCommandsObserved: string[]
}

export interface SoftGitRewindEvaluationDecision {
  passed: boolean
  reasons: string[]
}

export function decideSoftGitRewindEvaluationGate(
  report: SoftGitRewindEvaluationReport,
): SoftGitRewindEvaluationDecision {
  const reasons: string[] = []
  if (
    report.schemaVersion !== 1 ||
    report.datasetId !== 'soft-git-rewind-safety-v1'
  )
    reasons.push('report_invalid')
  if (
    String(report.datasetSha256 ?? '').toLowerCase() !==
    SOFT_GIT_REWIND_EVALUATION_DATASET_SHA256
  )
    reasons.push('dataset_mismatch')
  if (
    !['darwin', 'linux', 'win32'].includes(String(report.platform ?? '')) ||
    !/^\d+(?:\.\d+){1,3}$/.test(String(report.gitVersion ?? ''))
  )
    reasons.push('runtime_identity_invalid')
  if (!Array.isArray(report.cases)) reasons.push('report_invalid')
  else {
    const required = new Set<string>(SOFT_GIT_REWIND_EVALUATION_CASES)
    const observed = new Set<string>()
    let invalidCase = false
    let failedCase = false
    for (const item of report.cases) {
      const id = String(item?.id ?? '')
      if (
        !required.has(id) ||
        observed.has(id) ||
        !Number.isFinite(item?.durationMs) ||
        item.durationMs < 0 ||
        item.durationMs > 120_000
      )
        invalidCase = true
      observed.add(id)
      if (item?.passed !== true) failedCase = true
    }
    if ([...required].some((id) => !observed.has(id)))
      reasons.push('required_case_missing')
    if (invalidCase) reasons.push('case_receipt_invalid')
    if (failedCase) reasons.push('safety_case_failed')
  }
  if (
    !Array.isArray(report.forbiddenCommandsObserved) ||
    report.forbiddenCommandsObserved.length > 0
  )
    reasons.push('forbidden_command_observed')
  return { passed: reasons.length === 0, reasons: [...new Set(reasons)] }
}

export function softGitRewindGateReceipt(
  report: SoftGitRewindEvaluationReport,
): SoftGitRewindEvaluationGateReceipt | null {
  if (!decideSoftGitRewindEvaluationGate(report).passed) return null
  const passed = new Set(
    report.cases.filter((item) => item.passed).map((item) => item.id),
  )
  return {
    passed: true,
    datasetSha256: report.datasetSha256,
    platform: report.platform,
    gitVersion: report.gitVersion,
    stashVerified:
      passed.has('unrelated_dirty_stash') &&
      passed.has('project_filter_veto') &&
      passed.has('stash_volume_veto'),
    rollbackVerified: passed.has('head_index_rollback'),
    conflictVetoVerified:
      passed.has('file_conflict_veto') &&
      passed.has('divergent_head_veto') &&
      passed.has('git_operation_veto'),
    forbiddenCommandScanVerified: passed.has('forbidden_command_scan'),
  }
}
