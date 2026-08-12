import type { PromptSectionOwner } from '../prompts/contracts'

/** Context 构建器、规划器和装配器共享的中立段落契约。 */
export interface ContextSection {
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
