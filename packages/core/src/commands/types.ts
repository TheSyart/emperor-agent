export type CommandKind = 'local_ui' | 'core_action' | 'agent_prompt'

export type CommandBusyPolicy = 'immediate' | 'after_turn' | 'reject_when_busy'

export type CommandInvocationSource = 'desktop' | 'automation' | 'acp'

export type CommandSource =
  | 'builtin'
  | 'builtin_skill'
  | 'user_skill'
  | 'project_skill'
  | 'verified_plugin'

export type CommandSurface =
  | 'command_center'
  | 'status'
  | 'diagnostics'
  | 'context'
  | 'cost'
  | 'config'
  | 'theme'
  | 'session_search'
  | 'rename_session'
  | 'export_session'
  | 'model'
  | 'effort'
  | 'permissions'
  | 'plan'
  | 'goal'
  | 'memory'
  | 'skills'
  | 'tools'
  | 'mcp'
  | 'hooks'
  | 'agents'
  | 'tasks'
  | 'review'
  | 'files'
  | 'terminal'
  | 'scheduler'
  | 'plugins'

export interface CommandArgumentSpec {
  name: string
  type: 'string' | 'boolean' | 'enum' | 'id' | 'relative_path'
  required?: boolean
  positional?: boolean
  values?: string[]
  description?: string
  variadic?: boolean
}

export interface SkillCommandBinding {
  name: string
  context: 'inline' | 'fork'
  agent: string | null
  allowedTools: string[]
  effort: string | null
}

export interface CommandDescriptor {
  id: string
  name: string
  aliases: string[]
  category: string
  description: string
  kind: CommandKind
  source: CommandSource
  busyPolicy: CommandBusyPolicy
  argumentSchema: CommandArgumentSpec[]
  argumentHint?: string
  userInvocable: boolean
  invocationSources: CommandInvocationSource[]
  available: boolean
  unavailableReason?: string
  sensitiveArguments?: string[]
  uiSurface?: CommandSurface
  hiddenAliases?: string[]
  skill?: SkillCommandBinding
  dangerous?: boolean
}

export interface CommandCompletion {
  value: string
  label: string
  description?: string
  kind?: string
}

export interface CommandReceipt {
  commandId: string
  code: string
  message: string
  deprecatedSyntax?: string
  replacementSyntax?: string
  data?: Record<string, unknown>
}

export type CommandInvocationResult =
  | {
      status: 'opened'
      surface: CommandSurface
      params?: Record<string, unknown>
    }
  | { status: 'completed'; receipt?: CommandReceipt }
  | { status: 'queued'; requestId: string }
  | { status: 'submitted'; promptId: string }
  | { status: 'rejected'; code: string; message: string }

export interface SkillCommandMetadata {
  userInvocable: boolean
  name: string | null
  aliases: string[]
  argumentHint: string
  arguments: CommandArgumentSpec[]
  context: 'inline' | 'fork'
  agent: string | null
  allowedTools: string[]
  effort: string | null
  invocationSources: CommandInvocationSource[]
  sensitiveArguments: string[]
}
