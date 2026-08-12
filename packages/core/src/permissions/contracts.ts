/**
 * 权限解析的中立数据契约。
 *
 * 该模块不得依赖权限 manager/pipeline/rules 实现，避免模型、规则解析器
 * 与解释结果之间形成 type-only cycle。
 */
export type PermissionRuleAction = 'allow' | 'ask' | 'deny'

export type PermissionRuleTrust =
  | 'system'
  | 'managed'
  | 'user'
  | 'project'
  | 'runtime'
  | 'untrusted'
  | 'unknown'

export interface PermissionRuleSource {
  kind: string
  id: string
  trust: PermissionRuleTrust
}

export interface PermissionRuleCandidate {
  id: string
  action: PermissionRuleAction
  matched: boolean
  source: PermissionRuleSource
  precedence: string
}

export interface ToolPermissionProfile {
  name: string
  arguments: Record<string, unknown>
  readOnly: boolean
  concurrencySafe: boolean
  destructive: boolean
  path: string | null
  paths: string[]
  command: string
  schedulerAction: string
}
