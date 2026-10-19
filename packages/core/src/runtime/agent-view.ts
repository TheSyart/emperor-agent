/** Browser-safe canonical child-agent DTO and formatting, shared by every view. */
export type AgentBackend = 'internal' | 'claude-code' | 'codex'
/** `interrupted`: an external run cut off by a restart or an interrupt (AGT-04). */
export type AgentPhase =
  'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'unknown'
export interface AgentView {
  id: string
  kind: 'internal' | 'external'
  backend: AgentBackend
  rootSessionId: string
  /** The actual parent; a root's direct child points to rootSessionId. */
  parentAgentId: string
  title: string
  phase: AgentPhase
  createdAt: number
  updatedAt: number
  currentRunId?: string
  parentCallId?: string
  stopReason?: string
  /** External: a run ended without an outcome; offer 「标记为已结束」 (AGT-04). */
  needsExit?: true
  unavailable?:
    | 'missing_log'
    | 'corrupt_log'
    | 'missing_parent'
    | 'foreign_parent'
    | 'cyclic_parent'
    | 'conflicting_parent'
    | 'needs_recovery'
}
export function agentSourceLabel(backend: AgentBackend): string {
  return { internal: 'Emperor', 'claude-code': 'Claude Code', codex: 'Codex' }[
    backend
  ]
}
export function agentTitle(
  description: string | undefined,
  backend: AgentBackend,
): string {
  return typeof description === 'string' && description.trim()
    ? description
    : `${agentSourceLabel(backend)} 子智能体`
}
export function agentPhaseLabel(phase: AgentPhase): string {
  return {
    running: '运行中',
    waiting: '等待回答',
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
    unknown: '结果待确认',
  }[phase]
}

/**
 * An external task whose last run did not end normally (Emperor or the
 * computer restarted, or its stop could not be confirmed): it waits for the
 * user, who can mark it as ended (AGT-04). A live run is stopped instead.
 */
export function delegationNeedsExit(
  record: { availability: string; dispatchPaused?: boolean } | undefined,
  run: { phase: string; recoveryResolved?: boolean } | undefined,
): boolean {
  if (!record || record.availability === 'closed') return false
  if (record.availability === 'needs_recovery') return true
  if (!run) return false
  if (run.phase === 'outcome_unknown') return !run.recoveryResolved
  // Never dispatched before a restart: the queue waits for the user.
  return run.phase === 'queued' && record.dispatchPaused === true
}
