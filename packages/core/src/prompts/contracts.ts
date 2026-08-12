/** Prompt manifest 与投影器共享的中立类型契约。 */
export type PromptSectionOwner =
  | 'core'
  | 'agent_role'
  | 'mode'
  | 'plan'
  | 'goal'
  | 'project'
  | 'memory'
  | 'default'
  | 'tool'
  | 'user_append'

export interface PromptSectionInput {
  name: string
  content: string
  source: string
  priority: number
  budgetChars: number | null
  version: string | null
  scope?: string | null
  stability?: 'stable' | 'dynamic'
  owner?: PromptSectionOwner
  ruleIds?: string[]
}

export type PromptSectionStability = 'stable' | 'dynamic'
export type PromptCacheBreakClassification =
  'initial' | 'none' | 'expected' | 'unexpected'

export interface PromptProjectionLeaf {
  id: string
  kind: 'section' | 'message' | 'tools'
  index: number
  name: string
  hash: string
  byteCount: number
  version: string | null
  source: string
  stability: PromptSectionStability
  hasAttachment?: boolean
}

export interface PromptProjectionHashGroup {
  hash: string
  byteCount: number
  leaves: PromptProjectionLeaf[]
}

export interface PromptCacheBreak {
  classification: PromptCacheBreakClassification
  reasonCode: string
  firstChanged: {
    kind: PromptProjectionLeaf['kind']
    id: string
    index: number
  } | null
  previousStablePrefixHash: string | null
}

export interface PromptProjectionSnapshot {
  version: 1
  sessionId: string | null
  turnId: string
  stablePrefix: PromptProjectionHashGroup
  dynamicSuffix: PromptProjectionHashGroup
  canonicalHistoryHash: string
  projectedMessagesHash: string
  toolDefinitionsHash: string
  cacheBreak: PromptCacheBreak
}
