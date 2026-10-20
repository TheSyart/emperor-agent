/** Browser-safe references to durable external-agent journals. */
import type {
  TurnFileEntry,
  TurnRevertSkip,
} from '../../workspace/turn-snapshots'
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
/**
 * The result card of a write run (AGT-06), appended to the parent's log
 * when the result is recorded and again whenever it changes state; the
 * conversation shows one card per delegation, updated in place.
 */
export interface DelegationResultRecord {
  delegation_id: string
  run_id: string
  parent_call_id?: string
  backend: 'claude-code' | 'codex'
  title: string
  state: 'ready' | 'conflicted' | 'applied' | 'reverted' | 'discarded'
  files: TurnFileEntry[]
  totals: { files: number; additions: number; deletions: number }
  truncated?: true
  conflicts?: string[]
  at: number
  by?: 'user' | 'model'
  /** Applied with an undo record: 撤销 can put the files back. */
  undoable?: true
  reverted?: { reverted: string[]; skipped: TurnRevertSkip[] }
  /** 高级 › 验证后再应用 was on: the card sends the user to the checks. */
  verify_first?: true
}
declare module '../../session-log/types' {
  interface SessionEventMap {
    'delegation/projection': DelegationProjection
    'delegation/result': DelegationResultRecord
  }
}
