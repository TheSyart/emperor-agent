/**
 * What active plugins contribute at run time (plugin contract §3–§4): MCP
 * server configurations under stable keys, and hook sets in Emperor's shape.
 *
 * Pure: the caller passes the packages in effect and the user's own MCP
 * server names; nothing here connects, spawns or writes. Contributions never
 * touch `mcp_config.json` or the user's `hooks.json`.
 */

import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PluginHookSet } from '../harness/hooks/claude-code'
import type { ClaudeCodeHookConfig } from '../harness/hooks/config'
import type { MatcherGroup } from '../harness/hooks/types'
import { SAFE_ENV_KEYS } from '../mcp/connection'
import type { PluginMcpServer } from '../mcp/client'
import type { ServerConfig } from '../mcp/config'
import {
  pluginMcpToolName,
  sanitizeMcpName,
  shortHash,
} from '../mcp/plugin-names'
import { isPathWithin } from '../util/paths'
import type { MCPConnectionSnapshot } from '../mcp/supervisor'
import type {
  PluginMcpRuntimeState,
  PluginMcpServerSpec,
  PluginScope,
  ResolvedPluginPackage,
} from './models'

export interface ActivePluginPackage {
  readonly pluginId: string
  readonly scope: PluginScope
  readonly resolved: ResolvedPluginPackage
}

export interface PluginMcpContribution {
  readonly pluginId: string
  readonly scope: PluginScope
  /** The server name the package declares. */
  readonly serverName: string
  /** The name Emperor runs it under (contract §3.1). */
  readonly key: string
  /** `null` when the server cannot start; `blocked` says why. */
  readonly config: (ServerConfig & { cwd?: string | null }) | null
  readonly blocked: string | null
}

export interface PluginHookContribution {
  readonly pluginId: string
  readonly scope: PluginScope
  /** `PLUGIN_ROOT`, `PLUGIN_DATA` and their `CLAUDE_` aliases for this package only. */
  readonly env: Record<string, string>
  readonly config: ClaudeCodeHookConfig
}

export interface PluginContributions {
  readonly mcp: PluginMcpContribution[]
  readonly hooks: PluginHookContribution[]
}

export { pluginMcpToolName }

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export function pluginContributions(input: {
  readonly packages: readonly ActivePluginPackage[]
  readonly userServerNames: readonly string[]
  readonly emperorHome: string
  /** Process environment; only `SAFE_ENV_KEYS` are ever read from it. */
  readonly env: Readonly<Record<string, string | undefined>>
}): PluginContributions {
  const packages = [...input.packages].sort((left, right) =>
    left.pluginId < right.pluginId
      ? -1
      : left.pluginId > right.pluginId
        ? 1
        : 0,
  )
  const keys = serverKeys(packages, input.userServerNames)
  const mcp: PluginMcpContribution[] = []
  const hooks: PluginHookContribution[] = []
  for (const item of packages) {
    const vars = pluginVariables(input.emperorHome, item)
    for (const server of item.resolved.mcpServers) {
      const key = keys.get(keyOf(item.pluginId, server.name))!
      mcp.push({
        pluginId: item.pluginId,
        scope: item.scope,
        serverName: server.name,
        key,
        ...serverConfig(server, key, item.resolved.rootPath, vars, input.env),
      })
    }
    const config = hookConfig(item, keys)
    if (Object.keys(config).length)
      hooks.push({
        pluginId: item.pluginId,
        scope: item.scope,
        env: { ...vars },
        config,
      })
  }
  return { mcp, hooks }
}

/** Writable data folder of one plugin, shared by its scopes. */
export function pluginDataDirectory(
  emperorHome: string,
  pluginId: string,
): string {
  return join(resolve(emperorHome), 'plugins', 'data', ...pluginId.split('/'))
}

function serverKeys(
  packages: readonly ActivePluginPackage[],
  userServerNames: readonly string[],
): Map<string, string> {
  const taken = new Set(userServerNames)
  const keys = new Map<string, string>()
  for (const item of packages)
    for (const server of item.resolved.mcpServers) {
      const base = sanitizeMcpName(`${item.pluginId}-${server.name}`)
      const key = taken.has(base)
        ? `${base}_${shortHash(`${item.pluginId}\0${server.name}`)}`
        : base
      taken.add(key)
      keys.set(keyOf(item.pluginId, server.name), key)
    }
  return keys
}

function serverConfig(
  server: PluginMcpServerSpec,
  key: string,
  root: string,
  vars: Record<string, string>,
  env: Readonly<Record<string, string | undefined>>,
): Pick<PluginMcpContribution, 'config' | 'blocked'> {
  const missing = new Set<string>()
  const expand = (text: string) =>
    text.replace(VARIABLE, (match, name: string) => {
      if (name in vars) return vars[name]!
      const value = SAFE_ENV_KEYS.has(name) ? env[name] : undefined
      if (value !== undefined) return value
      missing.add(name)
      return match
    })
  const expandMap = (map: Readonly<Record<string, string>> | undefined) =>
    Object.fromEntries(
      Object.entries(map ?? {}).map(([name, value]) => [name, expand(value)]),
    )
  const stdio = server.transport === 'stdio'
  const cwd = stdio
    ? server.cwd === undefined
      ? root
      : resolve(root, expand(server.cwd))
    : null
  const config = {
    name: key,
    transport: server.transport,
    enabled: true,
    command: server.command === undefined ? null : expand(server.command),
    args: (server.args ?? []).map(expand),
    env: stdio ? { ...expandMap(server.env), ...vars } : {},
    url: server.url === undefined ? null : expand(server.url),
    headers: expandMap(server.headers),
    tool_overrides: {},
    cwd,
    // The sandbox hides Emperor Home; a server may read its own package and write its data.
    ...(stdio
      ? { stateGrants: { read: [root], write: [vars.PLUGIN_DATA!] } }
      : {}),
  }
  if (missing.size)
    return {
      config: null,
      blocked: `需要环境变量 ${[...missing].sort().join('、')}`,
    }
  if (
    cwd !== null &&
    !isPathWithin(cwd, root) &&
    !isPathWithin(cwd, vars.PLUGIN_DATA!)
  )
    return { config: null, blocked: '工作目录越出了插件目录' }
  return { config, blocked: null }
}

function hookConfig(
  item: ActivePluginPackage,
  keys: ReadonlyMap<string, string>,
): ClaudeCodeHookConfig {
  const config: ClaudeCodeHookConfig = {}
  for (const hook of item.resolved.hooks) {
    const mapped = hook.mapped
    if (!mapped) continue
    let matcher: string | undefined
    if (hook.dialect === 'emperor') matcher = mapped.matcher
    else if (mapped.subjects !== undefined || mapped.mcpTools !== undefined) {
      const names = [
        ...(mapped.subjects ?? []),
        ...(mapped.mcpTools ?? []).map((tool) =>
          pluginMcpToolName(
            keys.get(keyOf(item.pluginId, tool.server))!,
            item.pluginId,
            tool.server,
            tool.tool,
          ),
        ),
      ]
      matcher = names.every((name) => /^[A-Za-z0-9_]+$/.test(name))
        ? names.join('|')
        : `^(?:${names.map(escapeRegex).join('|')})$`
    }
    const group: MatcherGroup = {
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [
        {
          command: hook.command,
          ...(hook.timeoutSec !== undefined
            ? { timeoutSec: hook.timeoutSec }
            : {}),
        },
      ],
    }
    config[mapped.event] = [...(config[mapped.event] ?? []), group]
  }
  return config
}

function pluginVariables(
  emperorHome: string,
  item: ActivePluginPackage,
): Record<string, string> {
  const root = item.resolved.rootPath
  const data = pluginDataDirectory(emperorHome, item.pluginId)
  return {
    PLUGIN_ROOT: root,
    CLAUDE_PLUGIN_ROOT: root,
    PLUGIN_DATA: data,
    CLAUDE_PLUGIN_DATA: data,
  }
}

function keyOf(pluginId: string, serverName: string): string {
  return `${pluginId}\0${serverName}`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface PluginActivationDeps {
  /** The packages in effect (active and winning their scope) for the active project. */
  readonly packages: () => readonly ActivePluginPackage[]
  readonly userServerNames: () => Promise<readonly string[]>
  readonly emperorHome: string
  readonly env: () => Readonly<Record<string, string | undefined>>
  readonly mcp: {
    setPluginServers(servers: readonly PluginMcpServer[]): boolean
    reload(): Promise<void>
    pluginServerSnapshot(key: string): MCPConnectionSnapshot | null
    pluginSkippedTools(key: string): string[]
  }
  readonly hooks: { setPluginHooks(sets: readonly PluginHookSet[]): void }
}

/**
 * Applies what active plugins contribute: MCP servers under their keys and
 * hook sets with their own variables. Runs are serialized; a run with no MCP
 * change never reconnects anything.
 */
export class PluginActivationController {
  private contributions: PluginContributions = { mcp: [], hooks: [] }
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: PluginActivationDeps) {}

  sync(): Promise<void> {
    const run = this.chain.then(() => this.apply())
    this.chain = run.catch(() => {})
    return run
  }

  /** Resolves once every requested sync has finished. */
  settled(): Promise<void> {
    return this.chain
  }

  /** Live facts of one plugin MCP server for the detail view (contract §2). */
  mcpServer(
    pluginId: string,
    scope: PluginScope,
    serverName: string,
  ): PluginMcpRuntimeState | null {
    const contribution = this.contributions.mcp.find(
      (item) =>
        item.pluginId === pluginId &&
        item.scope === scope &&
        item.serverName === serverName,
    )
    if (!contribution) return null
    if (contribution.blocked)
      return { state: 'connecting', blocked: contribution.blocked }
    const snapshot = this.deps.mcp.pluginServerSnapshot(contribution.key)
    if (!snapshot) return null
    return {
      state: snapshot.state,
      toolCount: snapshot.toolCount,
      lastError: snapshot.lastError?.message ?? null,
      skippedTools: this.deps.mcp.pluginSkippedTools(contribution.key),
    }
  }

  private async apply(): Promise<void> {
    const packages = this.deps.packages()
    // Data folders exist before anything that may write there starts.
    for (const item of packages)
      if (
        item.resolved.hooks.some((hook) => hook.mapped) ||
        item.resolved.mcpServers.some((server) => server.transport === 'stdio')
      )
        mkdirSync(pluginDataDirectory(this.deps.emperorHome, item.pluginId), {
          recursive: true,
          mode: 0o700,
        })
    const contributions = pluginContributions({
      packages,
      userServerNames: await this.deps.userServerNames(),
      emperorHome: this.deps.emperorHome,
      env: this.deps.env(),
    })
    this.contributions = contributions
    this.deps.hooks.setPluginHooks(
      contributions.hooks.map((set) => ({
        id: `${set.pluginId}@${set.scope}`,
        env: set.env,
        config: set.config,
      })),
    )
    const servers = contributions.mcp.flatMap((item) =>
      item.config
        ? [
            {
              key: item.key,
              pluginId: item.pluginId,
              serverName: item.serverName,
              config: item.config,
            },
          ]
        : [],
    )
    if (this.deps.mcp.setPluginServers(servers)) await this.deps.mcp.reload()
  }
}
