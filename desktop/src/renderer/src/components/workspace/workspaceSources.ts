import type { ContentBlock } from '@emperor/core/runtime-contract'
import type { ChatSnapshot } from '../../conversation/types'
import type { WorkspaceSource } from './workspaceTypes'

/**
 * Attachments and tool-result images of the loaded conversation window,
 * deduplicated (environment card sources).
 */
export function workspaceSourcesFromSnapshot(
  snapshot: ChatSnapshot | null | undefined,
): WorkspaceSource[] {
  if (!snapshot) return []
  const seen = new Set<string>()
  const sources: WorkspaceSource[] = []
  const remember = (id: string) => {
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  }
  const images = (blocks: readonly ContentBlock[] | undefined) => {
    for (const block of blocks ?? []) {
      if (block.type !== 'image') continue
      const id = block.attachment.attachmentId
      if (remember(id)) sources.push({ id, name: id, kind: 'media' })
    }
  }
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key)
    if (node?.kind === 'user') {
      for (const attachment of node.data.attachments) {
        const id = typeof attachment.id === 'string' ? attachment.id : ''
        if (!remember(id)) continue
        const name = typeof attachment.name === 'string' ? attachment.name : id
        sources.push({ id, name, kind: 'attachment' })
      }
      continue
    }
    if (node?.kind === 'tool') images(node.data.result?.content)
  }
  return sources
}

/**
 * Environment card 来源 kinds: user attachments, tool-result images, web
 * search / fetch, MCP servers and invoked Skills.
 */
export type EnvironmentSourceKind =
  'attachment' | 'media' | 'web' | 'mcp' | 'skill'

export interface EnvironmentSource {
  /** Stable identity (`attachment:<id>`, `mcp:<server>`, `skill:<name>`, `web`). */
  id: string
  name: string
  kind: EnvironmentSourceKind
  /** Uses in the loaded window (an attachment or image counts once). */
  count: number
  /** Order position of the latest use (sources sort most recent first). */
  last: number
}

/** Tool descriptor subset (`skills.tools` / bootstrap `tools`). */
export interface SourceToolInfo {
  name: string
  source?: string
  server?: string
}

export const WEB_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  'web_search',
  'web_fetch',
])
export const SKILL_TOOL = 'skill'

/**
 * MCP server behind an `mcp_*` tool call. The tool catalog is authoritative
 * (server names may contain `_`, and builtins such as `mcp_config` share the
 * prefix); a tool missing from it falls back to the result meta, then to the
 * `mcp_<server>_<tool>` name.
 */
export function mcpServerOf(
  name: string,
  meta: unknown,
  tools: ReadonlyMap<string, SourceToolInfo>,
): string | null {
  if (!name.startsWith('mcp_')) return null
  const entry = tools.get(name)
  if (entry) return entry.source === 'mcp' && entry.server ? entry.server : null
  if (name === 'mcp_config') return null
  if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
    const server = (meta as Record<string, unknown>).server
    if (typeof server === 'string' && server) return server
  }
  const rest = name.slice(4)
  const split = rest.indexOf('_')
  return (split > 0 ? rest.slice(0, split) : rest) || null
}

function skillName(argsRaw: string): string {
  try {
    const value: unknown = JSON.parse(argsRaw)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const name = (value as Record<string, unknown>).name
      return typeof name === 'string' ? name.trim() : ''
    }
  } catch {
    // Truncated arguments: the invocation still counts, unnamed.
  }
  return ''
}

/**
 * Sources used in the loaded conversation window, most recently used first:
 * user attachments, tool-result images, 网页搜索 (web_search + web_fetch),
 * one entry per MCP server and one per invoked Skill.
 */
export function sourcesFromSnapshot(
  snapshot: ChatSnapshot | null | undefined,
  options: { tools?: readonly SourceToolInfo[] } = {},
): EnvironmentSource[] {
  if (!snapshot) return []
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]))
  const byId = new Map<string, EnvironmentSource>()
  const use = (
    id: string,
    name: string,
    kind: EnvironmentSourceKind,
    position: number,
    once = false,
  ) => {
    const existing = byId.get(id)
    if (existing) {
      if (!once) existing.count += 1
      existing.last = position
      return
    }
    byId.set(id, { id, name, kind, count: 1, last: position })
  }
  snapshot.order.forEach((key, position) => {
    const node = snapshot.nodes.get(key)
    if (node?.kind === 'user') {
      for (const attachment of node.data.attachments) {
        const id = typeof attachment.id === 'string' ? attachment.id : ''
        if (!id) continue
        const name = typeof attachment.name === 'string' ? attachment.name : id
        use(`attachment:${id}`, name, 'attachment', position, true)
      }
      return
    }
    if (node?.kind !== 'tool') return
    const data = node.data
    for (const block of data.result?.content ?? []) {
      if (block.type !== 'image') continue
      const id = block.attachment.attachmentId
      if (id) use(`media:${id}`, id, 'media', position, true)
    }
    if (WEB_SOURCE_TOOLS.has(data.name)) {
      use('web', '网页搜索', 'web', position)
      return
    }
    if (data.name === SKILL_TOOL) {
      const name = skillName(data.argsRaw)
      use(`skill:${name || '?'}`, name || 'Skill', 'skill', position)
      return
    }
    const server = mcpServerOf(data.name, data.result?.meta, tools)
    if (server) use(`mcp:${server}`, server, 'mcp', position)
  })
  return [...byId.values()].sort((left, right) => right.last - left.last)
}
