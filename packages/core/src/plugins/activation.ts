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
import type { Agent } from '../harness/agent/agent'
import type {
  PluginHookScope,
  PluginHookSet,
} from '../harness/hooks/claude-code'
import type { ClaudeCodeHookConfig } from '../harness/hooks/config'
import type { MatcherGroup } from '../harness/hooks/types'
import { SAFE_ENV_KEYS } from '../mcp/connection'
import type { PluginMcpServer } from '../mcp/client'
import type { ServerConfig } from '../mcp/config'
import { logger } from '../util/log'
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
  /** Names its manifest's `env` lets the hooks read when they run (SEC-07). */
  readonly allowedEnv: readonly string[]
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
        allowedEnv: [...item.resolved.envAllowlist],
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
          id: hook.id,
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
  /**
   * The packages in effect (active and winning their scope) for a project;
   * `null` asks for what applies everywhere (user-wide and shipped).
   */
  readonly packages: (
    projectRoot: string | null,
  ) => readonly ActivePluginPackage[]
  readonly userServerNames: () => Promise<readonly string[]>
  readonly emperorHome: string
  readonly env: () => Readonly<Record<string, string | undefined>>
  /** The global MCP client: user-wide and shipped plugins' servers. */
  readonly mcp: {
    setPluginServers(servers: readonly PluginMcpServer[]): boolean
    reload(): Promise<void>
    pluginServerSnapshot(key: string): MCPConnectionSnapshot | null
    pluginSkippedTools(key: string): string[]
  }
  /** Project instances: project-scoped plugins' servers (KRN-01). */
  readonly projectMcp?: {
    setServerResolver(
      resolver: (projectRoot: string) => readonly PluginMcpServer[],
    ): void
    refresh(): Promise<void>
    client(projectRoot: string):
      | {
          pluginServerSnapshot(key: string): MCPConnectionSnapshot | null
          pluginSkippedTools(key: string): string[]
        }
      | undefined
  }
  readonly hooks: {
    setPluginHooks(sets: readonly PluginHookSet[]): void
    setPluginHookScope?(scope: PluginHookScope | null): void
  }
  /** The project an agent works in (its root session's); null for Chat. */
  readonly projectOf?: (agent: Agent | undefined) => string | null
}

/** What a project's own (project- or local-scoped) plugins contribute. */
interface ProjectContributions extends PluginContributions {
  /** Plugin ids whose user-wide copy the project's copy replaces there. */
  readonly hidden: ReadonlySet<string>
}

const PROJECT_SCOPES: ReadonlySet<PluginScope> = new Set(['project', 'local'])

/**
 * Applies what active plugins contribute: MCP servers under their keys and
 * hook sets with their own variables. User-wide and shipped plugins apply
 * everywhere (the global MCP client, the global hook sets); a project's own
 * plugins apply only to sessions of that project (its MCP instance, its
 * hook sets), computed per project and never from the session in view
 * (KRN-01). Runs are serialized; a run with no MCP change never reconnects
 * anything.
 */
export class PluginActivationController {
  private contributions: PluginContributions = { mcp: [], hooks: [] }
  private readonly projects = new Map<string, ProjectContributions>()
  private userNames: readonly string[] = []
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: PluginActivationDeps) {
    deps.projectMcp?.setServerResolver((projectRoot) =>
      this.servers(this.project(projectRoot).mcp),
    )
    deps.hooks.setPluginHookScope?.({
      projectOf: (agent) => deps.projectOf?.(agent) ?? null,
      project: (projectRoot) => {
        const project = this.project(projectRoot)
        return { sets: hookSets(project.hooks), hidden: project.hidden }
      },
    })
  }

  /**
   * Apply the current plugins. `waitForMcp: false` (launch) returns once
   * Hooks and server lists are set; the global servers connect in the
   * background (KRN-04).
   */
  sync(options: { waitForMcp?: boolean } = {}): Promise<void> {
    const run = this.chain.then(() => this.apply(options.waitForMcp !== false))
    this.chain = run.catch(() => {})
    return run
  }

  /** Resolves once every requested sync has finished. */
  settled(): Promise<void> {
    return this.chain
  }

  /** Plugin ids whose user-wide copy a project replaces with its own there. */
  replacedIn(projectRoot: string): ReadonlySet<string> {
    return this.project(projectRoot).hidden
  }

  /**
   * Live facts of one plugin MCP server for the detail view (contract §2);
   * a project-scoped server is read from `projectRoot`'s instance.
   */
  mcpServer(
    pluginId: string,
    scope: PluginScope,
    serverName: string,
    projectRoot: string | null,
  ): PluginMcpRuntimeState | null {
    const contribution = this.contribution(
      pluginId,
      scope,
      serverName,
      projectRoot,
    )
    if (!contribution) return null
    if (contribution.blocked)
      return { state: 'connecting', blocked: contribution.blocked }
    const source = PROJECT_SCOPES.has(scope)
      ? projectRoot === null
        ? undefined
        : this.deps.projectMcp?.client(projectRoot)
      : this.deps.mcp
    const snapshot = source?.pluginServerSnapshot(contribution.key) ?? null
    if (!snapshot) return null
    return {
      state: snapshot.state,
      toolCount: snapshot.toolCount,
      lastError: snapshot.lastError?.message ?? null,
      skippedTools: source?.pluginSkippedTools(contribution.key) ?? [],
    }
  }

  /** The name one plugin MCP server runs under (its tools' server), or `null` when it cannot start. */
  mcpServerKey(
    pluginId: string,
    scope: PluginScope,
    serverName: string,
    projectRoot: string | null,
  ): string | null {
    const contribution = this.contribution(
      pluginId,
      scope,
      serverName,
      projectRoot,
    )
    return contribution?.config ? contribution.key : null
  }

  private contribution(
    pluginId: string,
    scope: PluginScope,
    serverName: string,
    projectRoot: string | null,
  ): PluginMcpContribution | undefined {
    const list = PROJECT_SCOPES.has(scope)
      ? projectRoot === null
        ? []
        : this.project(projectRoot).mcp
      : this.contributions.mcp
    return list.find(
      (item) =>
        item.pluginId === pluginId &&
        item.scope === scope &&
        item.serverName === serverName,
    )
  }

  /** A project's own contributions, computed once per sync. */
  private project(projectRoot: string): ProjectContributions {
    const root = resolve(projectRoot)
    const cached = this.projects.get(root)
    if (cached) return cached
    const own = this.deps
      .packages(root)
      .filter((item) => PROJECT_SCOPES.has(item.scope))
    this.ensureDataFolders(own)
    const contributions = pluginContributions({
      packages: own,
      // Keys never collide with a global server's, so a name means one server.
      userServerNames: [
        ...this.userNames,
        ...this.contributions.mcp.map((item) => item.key),
      ],
      emperorHome: this.deps.emperorHome,
      env: this.deps.env(),
    })
    const project: ProjectContributions = {
      ...contributions,
      hidden: new Set(own.map((item) => item.pluginId)),
    }
    this.projects.set(root, project)
    return project
  }

  private servers(
    contributions: readonly PluginMcpContribution[],
  ): PluginMcpServer[] {
    return contributions.flatMap((item) =>
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
  }

  private ensureDataFolders(packages: readonly ActivePluginPackage[]): void {
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
  }

  private async apply(waitForMcp: boolean): Promise<void> {
    const packages = this.deps
      .packages(null)
      .filter((item) => !PROJECT_SCOPES.has(item.scope))
    this.ensureDataFolders(packages)
    this.userNames = await this.deps.userServerNames()
    const contributions = pluginContributions({
      packages,
      userServerNames: this.userNames,
      emperorHome: this.deps.emperorHome,
      env: this.deps.env(),
    })
    this.contributions = contributions
    this.projects.clear()
    this.deps.hooks.setPluginHooks(hookSets(contributions.hooks))
    if (this.deps.mcp.setPluginServers(this.servers(contributions.mcp))) {
      const reload = this.deps.mcp.reload()
      if (waitForMcp) await reload
      else
        void reload.catch((error: unknown) =>
          logger.warn('plugin MCP reload failed', { error: String(error) }),
        )
    }
    await this.deps.projectMcp?.refresh()
  }
}

function hookSets(
  contributions: readonly PluginHookContribution[],
): PluginHookSet[] {
  return contributions.map((set) => ({
    id: `${set.pluginId}@${set.scope}`,
    pluginId: set.pluginId,
    env: set.env,
    allowedEnv: set.allowedEnv,
    config: set.config,
  }))
}
