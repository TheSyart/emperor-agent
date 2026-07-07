import type { MemoryPatch, MemoryScope } from './patch'

export type { MemoryScope } from './patch'

export type CompactionTrigger =
  | { kind: 'manual'; force?: boolean }
  | { kind: 'token_threshold'; currentTokens: number; maxContext: number }
  | { kind: 'new_turns_threshold'; newTurns: number }
  | { kind: 'idle_session' }
  | { kind: 'session_close' }
  | { kind: 'archive_before_rotation' }

export interface CompactionRange {
  sessionId: string
  fromSeq: number
  toSeq: number
  keepTailFromSeq: number
  stableBoundarySeq: number
  completedTurnCount: number
  reason: CompactionTrigger['kind']
}

export interface SessionMemoryCursor {
  sessionId: string
  lastHistorySeq: number
  compactedUntilSeq: number
  archivedUntilSeq: number
  lastCompactionAt?: string
  lastCompactionId?: string
  status: 'active' | 'compacting' | 'archived' | 'closed'
}

export interface ProjectedCompactionMessage {
  seq: number
  turnId: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  kind:
    | 'user_text'
    | 'assistant_text'
    | 'assistant_tool_call'
    | 'tool_result'
    | 'runtime_context'
  content: string
  contentHash: string
  originalChars: number
  projectedChars: number
  truncated: boolean
  toolName?: string
  toolCallId?: string
  durableHint: 'candidate' | 'likely_transient' | 'sensitive_candidate' | 'audit_only'
  scopeHints: Array<'user_profile' | 'global' | 'project' | 'episode' | 'discard'>
}

export interface CompactionDraft {
  schemaVersion: 'emperor.compaction-draft.v1'
  episode?: DraftTarget
  userProfile?: DraftTarget
  globalMemory?: DraftTarget | null
  projectMemory?: DraftTarget | null
  decisions: CompactionDecision[]
  discarded: DiscardedItem[]
}

export interface DraftTarget {
  operations: DraftOperation[]
}

export interface DraftOperation {
  op: 'append_section_item' | 'update_item' | 'mark_deprecated' | 'replace_section'
  section: string
  itemId?: string
  content?: string
  reason: string
  sourceSeqs: number[]
  confidence: 'low' | 'medium' | 'high'
}

export interface CompactionDecision {
  sourceSeqs: number[]
  content: string
  destination: 'user_profile' | 'global_memory' | 'project_memory' | 'episode' | 'discarded'
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

export interface MemoryBindingTarget<TScope extends MemoryScope = MemoryScope> {
  scope: TScope
  readable: boolean
  writable: boolean
  path?: string | null
}

export interface ActiveMemoryBinding {
  profile: MemoryBindingTarget<{ kind: 'user_profile' }>
  longTerm:
    | MemoryBindingTarget<{ kind: 'global' }>
    | MemoryBindingTarget<{ kind: 'project'; projectId: string }>
  episode: MemoryBindingTarget<{ kind: 'episode'; date: string }>
}

export interface CompactionPatchBundle {
  compactionId: string
  sessionId: string
  mode: 'chat' | 'build'
  projectId?: string
  range: { fromSeq: number; toSeq: number }
  patches: {
    episodePatch?: MemoryPatch
    userProfilePatch?: MemoryPatch
    globalMemoryPatch?: MemoryPatch
    projectMemoryPatch?: MemoryPatch
  }
  decisions: CompactionDecision[]
  discarded: DiscardedItem[]
}

export interface CompactionRunRecord {
  compactionId: string
  sessionId: string
  mode: 'chat' | 'build'
  projectId?: string
  trigger: CompactionTrigger
  range: { fromSeq: number; toSeq: number }
  status:
    | 'started'
    | 'draft_generated'
    | 'validated'
    | 'applied'
    | 'failed'
    | 'rolled_back'
  activeMemoryBinding: ActiveMemoryBinding
  input: {
    historyHash: string
    historyCount: number
    userProfileHash: string
    globalMemoryHash?: string
    projectMemoryHash?: string
    episodeHash: string
  }
  output?: {
    decisions: CompactionDecision[]
    discarded: DiscardedItem[]
    targetVersions: Array<{
      scope: MemoryScope
      beforeVersion: number
      beforeHash: string
      afterVersion?: number
      afterHash?: string
      operationCount: number
    }>
  }
  error?: {
    code: string
    message: string
    validationErrors?: string[]
  }
}
