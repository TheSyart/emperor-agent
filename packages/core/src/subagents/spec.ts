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

export type SubagentContextMode = 'fresh' | 'fork' | 'resume'

export interface SubagentDispatchContractV2 {
  agentType: string
  contextMode: SubagentContextMode
  objective: string
  rationale: string
  knownFacts: string[]
  rejectedApproaches: string[]
  targetFiles: string[]
  scopeLimit: string
  expectedOutput: string
  evidenceRequired: string[]
  ownerWorkItemId?: string
  workspaceMode: 'shared' | 'worktree'
  resumeTaskId?: string
}
