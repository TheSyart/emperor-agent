/**
 * Named edits of Emperor's own `mcp_config.json` (import/merge, enable,
 * remove). Shared by the CoreApi `mcp.*` operations and the model-facing
 * `mcp_config` tool. Callers own reloading the MCP client afterwards.
 */

import { EmperorError } from '../errors'
import {
  loadMcpConfigRaw,
  maskSecretUrl,
  saveMcpConfig,
  type McpConfigPersistenceOptions,
} from './config'
import { normalizeMcpImport, type ServerConfigRaw } from './import'

export type McpImportAction = 'add' | 'update' | 'skip'

export interface McpImportServerPlan {
  name: string
  transport: string
  /** stdio: command line; remote: URL with query values masked. */
  target: string
  enabled: boolean
  action: McpImportAction
  /** A server with this name already exists. */
  conflict: boolean
}

export interface McpImportPlan {
  added: string[]
  updated: string[]
  skipped: string[]
  conflicts: string[]
  warnings: string[]
  servers: McpImportServerPlan[]
  dryRun: boolean
}

export interface McpImportOptions extends McpConfigPersistenceOptions {
  /** Replace existing servers: `true` for all conflicts, or the names to replace. */
  overwrite?: boolean | readonly string[]
  /** Plan only; do not write. */
  dryRun?: boolean
}

export class McpServerNotFoundError extends EmperorError {
  constructor(name: string) {
    super(`MCP server '${name}' is not configured`, 'mcp_server_not_found')
  }
}

/** Normalize pasted config, merge by name into `mcp_config.json`, and (unless dry-run) save. */
export async function importMcpServers(
  root: string,
  raw: unknown,
  opts: McpImportOptions = {},
): Promise<McpImportPlan> {
  const normalized = normalizeMcpImport(raw)
  const stored = await loadMcpConfigRaw(root, opts)
  const current = serversOf(stored)
  const overwrite = opts.overwrite ?? false
  const replace = (name: string): boolean =>
    overwrite === true || (Array.isArray(overwrite) && overwrite.includes(name))
  const plan: McpImportPlan = {
    added: [],
    updated: [],
    skipped: [],
    conflicts: [],
    warnings: [...normalized.warnings],
    servers: [],
    dryRun: opts.dryRun === true,
  }
  const next = { ...current }
  for (const [name, server] of Object.entries(normalized.servers)) {
    const existing = current[name]
    const conflict = existing !== undefined
    let action: McpImportAction
    if (!conflict) {
      action = 'add'
      next[name] = { ...server }
      plan.added.push(name)
    } else {
      plan.conflicts.push(name)
      const merged = mergeExisting(existing, server)
      if (sameJson(comparable(name, existing), merged)) {
        action = 'skip'
        plan.skipped.push(name)
        plan.warnings.push(`server "${name}" 已存在且配置相同，未修改`)
      } else if (replace(name)) {
        action = 'update'
        next[name] = merged
        plan.updated.push(name)
      } else {
        action = 'skip'
        plan.skipped.push(name)
        plan.warnings.push(
          `server "${name}" 已存在，未覆盖（设置 overwrite 以替换）`,
        )
      }
    }
    plan.servers.push({
      name,
      transport: server.transport,
      target: describeServerTarget(server),
      enabled: server.enabled,
      action,
      conflict,
    })
  }
  if (!plan.dryRun && (plan.added.length || plan.updated.length))
    await saveMcpConfig(root, { ...stored, servers: next }, opts)
  return plan
}

export async function setMcpServerEnabled(
  root: string,
  name: string,
  enabled: boolean,
  opts: McpConfigPersistenceOptions = {},
): Promise<{ name: string; enabled: boolean; changed: boolean }> {
  const stored = await loadMcpConfigRaw(root, opts)
  const servers = serversOf(stored)
  const server = servers[name]
  if (server === undefined) throw new McpServerNotFoundError(name)
  const current = server.enabled !== false && server.disabled !== true
  if (current === enabled) return { name, enabled, changed: false }
  const updated: Record<string, unknown> = { ...server, enabled }
  delete updated.disabled
  await saveMcpConfig(
    root,
    { ...stored, servers: { ...servers, [name]: updated } },
    opts,
  )
  return { name, enabled, changed: true }
}

export async function removeMcpServer(
  root: string,
  name: string,
  opts: McpConfigPersistenceOptions = {},
): Promise<{ removed: string }> {
  const stored = await loadMcpConfigRaw(root, opts)
  const servers = serversOf(stored)
  if (servers[name] === undefined) throw new McpServerNotFoundError(name)
  const next = { ...servers }
  delete next[name]
  await saveMcpConfig(root, { ...stored, servers: next }, opts)
  return { removed: name }
}

/** Short, secret-safe description: command line for stdio, masked URL for remote. */
export function describeServerTarget(
  server: Pick<ServerConfigRaw, 'transport' | 'command' | 'args' | 'url'>,
): string {
  if (server.transport === 'stdio')
    return [server.command ?? '', ...(server.args ?? [])]
      .filter(Boolean)
      .join(' ')
  return server.url ? maskSecretUrl(server.url) : ''
}

/** Replacement keeps local-only fields (tool overrides) the import did not specify. */
function mergeExisting(
  existing: Record<string, unknown>,
  incoming: ServerConfigRaw,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...incoming }
  if (
    incoming.tool_overrides === undefined &&
    existing.tool_overrides !== undefined
  )
    merged.tool_overrides = existing.tool_overrides
  return merged
}

/** The stored server in import shape (defaults filled) so unchanged re-imports compare equal. */
function comparable(
  name: string,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  try {
    const normalized = normalizeMcpImport({ servers: { [name]: existing } })
      .servers[name]
    return normalized === undefined ? existing : { ...normalized }
  } catch {
    return existing
  }
}

function serversOf(
  stored: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const servers = stored.servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers))
    return {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, value] of Object.entries(servers))
    if (value && typeof value === 'object' && !Array.isArray(value))
      out[name] = value as Record<string, unknown>
  return out
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    )
  return value
}
