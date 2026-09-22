/**
 * Legacy compaction decision shapes, still re-exported through the public API
 * for renderer typings. The history-based memory consolidation pipeline that
 * produced them is retired; no core code emits these anymore.
 */

export interface CompactionDecision {
  sourceSeqs: number[]
  content: string
  destination:
    | 'user_profile'
    | 'global_memory'
    | 'project_memory'
    | 'episode'
    | 'discarded'
  classification:
    | 'stable_user_preference'
    | 'working_style'
    | 'long_term_constraint'
    | 'cross_session_fact'
    | 'cross_project_learning'
    | 'project_fact'
    | 'project_command'
    | 'project_decision'
    | 'project_open_task'
    | 'daily_event'
    | 'temporary_detail'
    | 'sensitive'
    | 'duplicate'
  reason: string
  confidence: 'low' | 'medium' | 'high'
}

export interface DiscardedItem {
  sourceSeqs: number[]
  summary: string
  reason:
    | 'temporary_tool_output'
    | 'duplicate'
    | 'not_durable'
    | 'sensitive'
    | 'low_confidence'
    | 'already_captured'
}
