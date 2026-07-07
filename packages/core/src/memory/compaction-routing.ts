import { memoryContentHash, type MemoryPatch } from './patch'

export type CompactionDecisionKind = 'user_preference' | 'global_fact' | 'project_fact' | 'episode_note'
export type CompactionDecisionConfidence = 'low' | 'medium' | 'high'

export interface CompactionMemoryDecision {
  kind: CompactionDecisionKind
  section: string
  content: string
  confidence: CompactionDecisionConfidence
  rationale: string
  crossProjectLearning?: boolean
}

export interface ChatRoutingContext {
  userProfile: string
  globalMemory: string
  projectId?: string | null
  projectMemory?: string | null
}

export interface BuildRoutingContext {
  projectId: string
  projectMemory: string
  globalMemory: string
  userProfile?: string | null
}

export interface DiscardedCompactionDecision {
  decision: CompactionMemoryDecision
  reason: string
}

export interface CompactionRoutingResult {
  patches: MemoryPatch[]
  discarded: DiscardedCompactionDecision[]
}

export function routeChatDecision(decision: CompactionMemoryDecision, ctx: ChatRoutingContext): CompactionRoutingResult {
  if (decision.kind === 'user_preference') {
    return patchResult(decision, { kind: 'user_profile' }, ctx.userProfile)
  }
  if (decision.kind === 'global_fact') {
    return patchResult(decision, { kind: 'global' }, ctx.globalMemory)
  }
  if (decision.kind === 'project_fact') {
    const projectId = String(ctx.projectId ?? '').trim()
    if (!projectId || ctx.projectMemory === undefined || ctx.projectMemory === null) {
      return discardResult(decision, 'chat_project_write_requires_binding')
    }
    return patchResult(decision, { kind: 'project', projectId }, ctx.projectMemory)
  }
  return discardResult(decision, 'chat_episode_write_not_supported')
}

export function routeBuildDecision(decision: CompactionMemoryDecision, ctx: BuildRoutingContext): CompactionRoutingResult {
  if (decision.kind === 'project_fact') {
    return patchResult(decision, { kind: 'project', projectId: ctx.projectId }, ctx.projectMemory)
  }
  if (decision.kind === 'global_fact') {
    if (!decision.crossProjectLearning) {
      return discardResult(decision, 'build_global_write_requires_cross_project_learning')
    }
    if (decision.confidence === 'low') {
      return discardResult(decision, 'build_global_write_requires_medium_confidence')
    }
    return patchResult(decision, { kind: 'global' }, ctx.globalMemory)
  }
  if (decision.kind === 'user_preference') {
    const userProfile = ctx.userProfile ?? ''
    if (!userProfile) return discardResult(decision, 'build_user_profile_write_requires_binding')
    return patchResult(decision, { kind: 'user_profile' }, userProfile)
  }
  return discardResult(decision, 'build_episode_write_not_supported')
}

function patchResult(
  decision: CompactionMemoryDecision,
  target: MemoryPatch['target'],
  baseContent: string,
): CompactionRoutingResult {
  return {
    patches: [{
      target,
      baseVersion: 1,
      baseHash: memoryContentHash(baseContent),
      operations: [{ op: 'append_section_item', section: decision.section, item: decision.content }],
      rationale: decision.rationale,
    }],
    discarded: [],
  }
}

function discardResult(decision: CompactionMemoryDecision, reason: string): CompactionRoutingResult {
  return {
    patches: [],
    discarded: [{ decision, reason }],
  }
}
