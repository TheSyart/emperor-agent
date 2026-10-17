/** Browser-safe canonical child-agent DTO and formatting, shared by every view. */
export type AgentBackend = 'internal' | 'claude-code' | 'codex'
export type AgentPhase =
  'running' | 'waiting' | 'completed' | 'failed' | 'unknown'
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
    waiting: '等待输入',
    completed: '已完成',
    failed: '失败',
    unknown: '状态未知',
  }[phase]
}
