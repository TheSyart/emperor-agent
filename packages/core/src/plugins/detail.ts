/**
 * Member states for the plugin detail view (plugin contract §2).
 *
 * The package-level verdict comes first, in this order: content missing,
 * disabled, source unverified, another scope in effect. Only an active
 * package shows each member's own facts: its static verdict from the
 * package, the Skill that wins a name clash, and the live MCP state.
 * One member's failure never changes another's state.
 */

import { resolve, sep } from 'node:path'
import { canonicalizeExistingPath } from '../util/paths'
import type {
  PluginComponentView,
  PluginMcpRuntimeState,
  PluginRuntimeView,
  PluginScope,
  ResolvedPluginComponent,
  ResolvedPluginPackage,
} from './models'

export type PluginPackageVerdict =
  | { readonly kind: 'missing' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'blocked_unverified' }
  | { readonly kind: 'shadowed'; readonly by: PluginScope }
  | { readonly kind: 'active' }

/** Scopes in the order they win (contract §2): a closer scope beats a wider one. */
export const PLUGIN_SCOPE_PRECEDENCE: readonly PluginScope[] = [
  'local',
  'project',
  'user',
  'managed',
]

export const PLUGIN_SCOPE_LABELS: Record<PluginScope, string> = {
  local: '本地项目',
  project: '项目',
  user: '用户',
  managed: '受管',
}

const SKILL_SOURCE_LABELS = {
  project: '项目',
  user: '个人',
  plugin: '另一个插件',
  builtin: '内置',
} as const

export const NO_PLUGIN_RUNTIME: PluginRuntimeView = {
  mcpServer: () => null,
  effectiveSkills: () => new Map(),
}

export function pluginComponentViews(input: {
  readonly pluginId: string
  readonly scope: PluginScope
  readonly resolved: ResolvedPluginPackage | null
  readonly verdict: PluginPackageVerdict
  readonly projectRoot: string | null
  readonly runtime: PluginRuntimeView
}): PluginComponentView[] {
  const { resolved, verdict } = input
  if (!resolved || verdict.kind === 'missing') return []
  const scrub = pathScrubber(resolved.rootPath)
  const uniform = uniformState(verdict)
  const skills =
    uniform === null && resolved.components.some((c) => c.kind === 'skill')
      ? input.runtime.effectiveSkills(input.projectRoot)
      : new Map()
  return resolved.components.map((component) => {
    const base = {
      kind: component.kind,
      id: component.id,
      title: component.title,
      description: scrub(component.description),
    }
    if (uniform) return { ...base, ...uniform }
    const own = memberState(component, input, skills)
    return {
      ...base,
      state: own.state,
      reason: own.reason === null ? null : scrub(own.reason),
    }
  })
}

/** What the package may do once active: run local commands, reach the network. */
export function pluginPermissions(resolved: ResolvedPluginPackage | null): {
  runsCommands: boolean
  network: boolean
} {
  if (!resolved) return { runsCommands: false, network: false }
  return {
    runsCommands:
      resolved.mcpServers.some((server) => server.transport === 'stdio') ||
      resolved.hooks.some((hook) => hook.mapped !== undefined),
    network:
      resolved.mcpServers.some((server) => server.transport !== 'stdio') ||
      resolved.components.some((component) => component.kind === 'app'),
  }
}

/** Rewrite the package root (lexical and resolved) out of text shown to the renderer. */
export function pathScrubber(root: string): (text: string) => string {
  const roots = [...new Set([resolve(root), canonicalizeExistingPath(root)])]
  return (text) => {
    let out = text
    for (const path of roots) {
      out = out.split(`${path}${sep}`).join('')
      out = out.split(path).join('${PLUGIN_ROOT}')
    }
    return out
  }
}

function uniformState(
  verdict: PluginPackageVerdict,
): Pick<PluginComponentView, 'state' | 'reason'> | null {
  switch (verdict.kind) {
    case 'disabled':
      return { state: 'disabled', reason: '插件已停用' }
    case 'blocked_unverified':
      return { state: 'unsupported', reason: '来源未验证，成员不会运行' }
    case 'shadowed':
      return {
        state: 'disabled',
        reason: `已由${PLUGIN_SCOPE_LABELS[verdict.by]}范围的同一插件提供`,
      }
    default:
      return null
  }
}

function memberState(
  component: ResolvedPluginComponent,
  input: {
    readonly pluginId: string
    readonly scope: PluginScope
    readonly runtime: PluginRuntimeView
  },
  skills: ReturnType<PluginRuntimeView['effectiveSkills']>,
): Pick<PluginComponentView, 'state' | 'reason'> {
  if (component.kind === 'app') {
    const connection =
      input.runtime.appConnection?.(
        input.pluginId,
        input.scope,
        component.id,
      ) ?? null
    if (connection)
      return connection.state === 'connected'
        ? { state: 'available', reason: connection.reason }
        : { state: connection.state, reason: connection.reason }
  }
  if (component.state !== 'available')
    return { state: component.state, reason: component.reason }
  if (component.kind === 'skill') {
    const winner = skills.get(component.id)
    if (
      winner &&
      component.sourcePath !== null &&
      resolve(winner.skillFile) !== resolve(component.sourcePath)
    )
      return {
        state: 'failed',
        reason: `与${SKILL_SOURCE_LABELS[winner.source]}的同名 Skill 冲突，未生效`,
      }
    return { state: 'available', reason: null }
  }
  if (component.kind === 'mcp')
    return mcpState(
      input.runtime.mcpServer(input.pluginId, input.scope, component.id),
    )
  return { state: 'available', reason: null }
}

function mcpState(
  live: PluginMcpRuntimeState | null,
): Pick<PluginComponentView, 'state' | 'reason'> {
  if (live === null) return { state: 'starting', reason: '正在连接' }
  if (live.blocked) return { state: 'needs_connection', reason: live.blocked }
  const skipped = live.skippedTools?.length
    ? `已跳过重名工具：${live.skippedTools.join('、')}`
    : null
  switch (live.state) {
    case 'connecting':
      return { state: 'starting', reason: '正在连接' }
    case 'ready':
      return { state: 'running', reason: skipped }
    case 'auth_failed':
      return { state: 'needs_connection', reason: '需要登录或凭据' }
    case 'stopped':
      return { state: 'failed', reason: '已断开' }
    default:
      return {
        state: 'failed',
        reason: [live.lastError || '连接失败', skipped]
          .filter(Boolean)
          .join('；'),
      }
  }
}
