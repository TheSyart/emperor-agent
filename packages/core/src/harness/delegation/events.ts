/** Browser-safe references to durable external-agent journals. */
export type DelegationRuntimeName =
  | 'delegation_created'
  | 'delegation_run_changed'
  | 'delegation_output'
  | 'delegation_interaction'
  | 'delegation_receipt'
export interface DelegationProjection {
  event: DelegationRuntimeName
  delegation_id: string
  run_id?: string
  journal_seq: number
  parent_call_id?: string
  current_run_id?: string
  backend?: 'claude-code' | 'codex'
  task?: Record<string, unknown>
  output?: { role: string; content: string }[]
}
declare module '../../session-log/types' {
  interface SessionEventMap {
    'delegation/projection': DelegationProjection
  }
}
