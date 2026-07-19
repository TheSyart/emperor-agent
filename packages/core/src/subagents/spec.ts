import type {
  AgentDefinition,
  ExtensionSourceSnapshot,
} from '../extensions/resolver'

export interface SubagentSpec {
  name: string
  description: string
  systemPrompt: string
  toolNames: string[]
  maxTurns: number
  planReadonlyExplorer: boolean
  definition: AgentDefinition
  source: ExtensionSourceSnapshot
  revision: string
}
