import { MCPToolAdapter } from './adapter'
import { loadMcpConfig, type MCPConfig, type ServerConfig } from './config'
import { pluginMcpToolName } from './plugin-names'
import {
  HttpConnection,
  InvalidConfigConnection,
  MCPConnection,
  SSEConnection,
  StdioConnection,
} from './connection'
import type { ExecutionEnvironment } from '../environment/snapshot'
import {
  MCPConnectionSupervisor,
  type MCPConnectionSnapshot,
  type MCPConnectionSupervisorOptions,
} from './supervisor'
import type { OwnedProcessRuntime } from '../processes/runtime'
import type { SecretSealer } from '../security/secret-sealer'

export type MCPConnectionFactory = (
  cfg: ServerConfig,
  executionEnvironment?: ExecutionEnvironment | null,
) => MCPConnection

export interface MCPClientSnapshot {
  readonly initialized: boolean
  readonly servers: MCPConnectionSnapshot[]
  readonly ready: number
  readonly configured: number
  readonly tools: number
  readonly toolCapabilities: MCPToolCapabilitySnapshot[]
}

export interface MCPToolCapabilitySnapshot {
  readonly name: string
  readonly serverName: string
  readonly toolName: string
  readonly readOnly: boolean
  readonly exclusive: boolean
  readonly evidencePolicy: 'context_only'
  readonly readOnlySource: string
  readonly exclusiveSource: string
  readonly generation: number | null
  readonly clientId: string | null
}

/** An MCP server a plugin contributes, run under its contract key (plugin contract §3). */
export interface PluginMcpServer {
  readonly key: string
  readonly pluginId: string
  readonly serverName: string
  readonly config: ServerConfig
}

export interface MCPClientOptions {
  readonly processRuntime?: OwnedProcessRuntime | null
  readonly workspaceRoot?: (() => string) | null
  readonly ownerSessionId?: (() => string | null) | null
  readonly connectionFactory?: MCPConnectionFactory
  /** Opens sealed `headers` / `env` values of `mcp_config.json` (SEC-06). */
  readonly sealer?: SecretSealer | null
  readonly onStateChange?: (
    snapshot: MCPConnectionSnapshot,
  ) => void | Promise<void>
  readonly supervisor?: Partial<
    Pick<
      MCPConnectionSupervisorOptions,
      | 'callTimeoutMs'
      | 'clientIdFactory'
      | 'connectTimeoutMs'
      | 'maxRestartAttempts'
      | 'now'
      | 'requestIdFactory'
      | 'sleep'
    >
  >
}

export class MCPClient {
  readonly root: string
  config: MCPConfig | null = null
  private readonly connectionFactory: MCPConnectionFactory
  private readonly connections = new Map<string, MCPConnectionSupervisor>()
  private readonly effectiveConfigs = new Map<string, ServerConfig>()
  private readonly tools: MCPToolAdapter[] = []
  /** Plugin servers by key; they never come from or go to `mcp_config.json`. */
  private pluginServers = new Map<string, PluginMcpServer>()
  private readonly skippedPluginTools = new Map<string, string[]>()
  private reservedToolNames: () => ReadonlySet<string> = () => new Set()
  private readonly opts: MCPClientOptions
  private executionEnvironment: ExecutionEnvironment | null = null
  private initialized = false

  constructor(root: string, opts: MCPClientOptions = {}) {
    this.root = root
    this.opts = opts
    this.connectionFactory =
      opts.connectionFactory ??
      ((config, executionEnvironment) =>
        createConnection(
          config,
          executionEnvironment,
          (snapshot) => this.configForSnapshot(config.name, snapshot),
          {
            processRuntime: opts.processRuntime ?? null,
            workspaceRoot: opts.workspaceRoot?.() ?? null,
            stateRoot: this.root,
            ownerSessionId: opts.ownerSessionId?.() ?? null,
          },
        ))
  }

  /**
   * Replace the plugin servers; returns whether anything changed. The next
   * `reload()` connects new ones and disconnects removed ones.
   */
  setPluginServers(servers: readonly PluginMcpServer[]): boolean {
    const next = new Map(
      servers.map((server) => [server.key, structuredClone(server)]),
    )
    const fingerprint = (map: Map<string, PluginMcpServer>) =>
      JSON.stringify([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
    if (fingerprint(next) === fingerprint(this.pluginServers)) return false
    this.pluginServers = next
    return true
  }

  /** Names plugin tools must not take (the host's own tools). */
  setReservedToolNames(names: () => ReadonlySet<string>): void {
    this.reservedToolNames = names
  }

  /** Tools of one plugin server left out because their name was taken. */
  pluginSkippedTools(key: string): string[] {
    return [...(this.skippedPluginTools.get(key) ?? [])]
  }

  pluginServerSnapshot(key: string): MCPConnectionSnapshot | null {
    if (!this.pluginServers.has(key)) return null
    return this.connections.get(key)?.snapshot() ?? null
  }

  async initialize(
    executionEnvironment: ExecutionEnvironment | null = null,
  ): Promise<void> {
    if (this.initialized) return
    await this.reload(executionEnvironment)
  }

  async reload(
    executionEnvironment: ExecutionEnvironment | null = this
      .executionEnvironment,
  ): Promise<void> {
    const config = executionEnvironment
      ? await loadMcpConfigForEnvironment(
          this.root,
          executionEnvironment,
          this.opts.sealer,
        )
      : await loadMcpConfig(this.root, process.env, {
          sealer: this.opts.sealer ?? null,
        })
    this.executionEnvironment = executionEnvironment
    const desired = new Set<string>()
    const userNames = new Set(Object.keys(config.servers))
    const plugins = [...this.pluginServers.values()]
      // A user server that later took the same name wins until keys are recomputed.
      .filter((server) => !userNames.has(server.key))
      .map((server) => ({ ...server.config, name: server.key }))

    for (const server of [...Object.values(config.servers), ...plugins]) {
      if (!server.enabled) continue
      desired.add(server.name)
      const existing = this.connections.get(server.name)
      if (existing) {
        if (await existing.reconfigure(server))
          this.effectiveConfigs.set(server.name, server)
        continue
      }
      const supervisor = new MCPConnectionSupervisor({
        serverName: server.name,
        config: server,
        connectionFactory: (candidate) =>
          this.connectionFactory(candidate, this.executionEnvironment),
        ...(this.opts.supervisor ?? {}),
        onStateChange: this.opts.onStateChange,
      })
      this.connections.set(server.name, supervisor)
      if (await supervisor.connect())
        this.effectiveConfigs.set(server.name, server)
    }

    for (const [name, connection] of [...this.connections]) {
      if (desired.has(name)) continue
      this.connections.delete(name)
      this.effectiveConfigs.delete(name)
      await connection.disconnect().catch(() => {})
    }

    this.config = config
    await this.rebuildTools()
    this.initialized = true
  }

  private async rebuildTools(): Promise<void> {
    this.tools.length = 0
    this.skippedPluginTools.clear()
    const defaults = this.config?.defaults ?? {}
    for (const server of Object.values(this.config?.servers ?? {})) {
      if (!server.enabled) continue
      const conn = this.connections.get(server.name)
      if (!conn) continue
      const effectiveConfig = this.effectiveConfigs.get(server.name)
      if (!effectiveConfig) continue
      const discovered = await conn.listTools()
      for (const tool of discovered) {
        const overrides = effectiveConfig.tool_overrides[tool.name] ?? {}
        const connectionSnapshot = conn.snapshot()
        this.tools.push(
          new MCPToolAdapter({
            serverName: server.name,
            toolName: tool.name,
            description: tool.description ?? '',
            parametersSchema: tool.inputSchema ?? {
              type: 'object',
              properties: {},
              required: [],
            },
            connection: conn,
            transport: effectiveConfig.transport,
            readOnly: booleanOption(
              overrides.read_only,
              defaults.read_only,
              false,
            ),
            exclusive: booleanOption(
              overrides.exclusive,
              defaults.exclusive,
              false,
            ),
            readOnlySource: booleanOptionSource(
              overrides.read_only,
              defaults.read_only,
              'fallback_write',
            ),
            exclusiveSource: booleanOptionSource(
              overrides.exclusive,
              defaults.exclusive,
              'fallback_serialized',
            ),
            generation: connectionSnapshot.generation || null,
            clientId: connectionSnapshot.clientId,
            maxResultChars: positiveInt(
              overrides.max_result_chars ?? defaults.max_result_chars,
            ),
            callTimeoutMs: positiveInt(
              overrides.call_timeout_ms ?? defaults.call_timeout_ms,
            ),
          }),
        )
      }
    }
    await this.addPluginTools()
  }

  /**
   * Plugin tools come after the user's, in plugin order; one whose contract
   * name is already taken is left out and remembered, never registered twice.
   */
  private async addPluginTools(): Promise<void> {
    const taken = new Set([
      ...this.reservedToolNames(),
      ...this.tools.map((tool) => tool.name),
    ])
    const servers = [...this.pluginServers.values()].sort((left, right) =>
      left.pluginId === right.pluginId
        ? left.key < right.key
          ? -1
          : 1
        : left.pluginId < right.pluginId
          ? -1
          : 1,
    )
    for (const server of servers) {
      const conn = this.connections.get(server.key)
      const effectiveConfig = this.effectiveConfigs.get(server.key)
      if (!conn || !effectiveConfig) continue
      const skipped: string[] = []
      for (const tool of await conn.listTools()) {
        const name = pluginMcpToolName(
          server.key,
          server.pluginId,
          server.serverName,
          tool.name,
        )
        if (taken.has(name)) {
          skipped.push(tool.name)
          continue
        }
        taken.add(name)
        const connectionSnapshot = conn.snapshot()
        this.tools.push(
          new MCPToolAdapter({
            serverName: server.key,
            toolName: tool.name,
            name,
            pluginId: server.pluginId,
            description: tool.description ?? '',
            parametersSchema: tool.inputSchema ?? {
              type: 'object',
              properties: {},
              required: [],
            },
            connection: conn,
            transport: effectiveConfig.transport,
            generation: connectionSnapshot.generation || null,
            clientId: connectionSnapshot.clientId,
          }),
        )
      }
      if (skipped.length) this.skippedPluginTools.set(server.key, skipped)
    }
  }

  getTools(): MCPToolAdapter[] {
    return [...this.tools]
  }

  getConnection(serverName: string): MCPConnection | undefined {
    return this.connections.get(serverName)
  }

  snapshot(): MCPClientSnapshot {
    const configured =
      Object.values(this.config?.servers ?? {}).filter(
        (server) => server.enabled,
      ).length + this.pluginServers.size
    const servers = [...this.connections.values()]
      .map((connection) => connection.snapshot())
      .sort((left, right) => left.serverName.localeCompare(right.serverName))
    const serverByName = new Map(
      servers.map((server) => [server.serverName, server]),
    )
    const toolCapabilities = this.tools
      .map((tool): MCPToolCapabilitySnapshot => {
        const descriptor = tool.capabilityDescriptor()
        const provenance = descriptor.provenance
        const server = serverByName.get(tool.mcpServerName)
        return {
          name: tool.name,
          serverName: tool.mcpServerName,
          toolName: tool.mcpToolName,
          readOnly: tool.readOnly,
          exclusive: tool.exclusive,
          evidencePolicy: 'context_only',
          readOnlySource: provenance.readOnlySource,
          exclusiveSource: provenance.exclusiveSource,
          generation: server?.generation ?? null,
          clientId: server?.clientId ?? null,
        }
      })
      .sort((left, right) => left.name.localeCompare(right.name))
    return {
      initialized: this.initialized,
      servers,
      ready: servers.filter((server) => server.state === 'ready').length,
      configured,
      tools: this.tools.length,
      toolCapabilities,
    }
  }

  async close(): Promise<void> {
    for (const conn of this.connections.values())
      await conn.disconnect().catch(() => {})
    this.connections.clear()
    this.effectiveConfigs.clear()
    this.tools.length = 0
    this.initialized = false
    this.executionEnvironment = null
  }

  private async configForSnapshot(
    serverName: string,
    snapshot: ExecutionEnvironment,
  ): Promise<ServerConfig | null> {
    // Plugin servers live here, not in mcp_config.json.
    const plugin = this.pluginServers.get(serverName)
    if (plugin) return { ...plugin.config, name: plugin.key }
    const config = (
      await loadMcpConfigForEnvironment(this.root, snapshot, this.opts.sealer)
    ).servers[serverName]
    return config?.enabled ? config : null
  }
}

function createConnection(
  cfg: ServerConfig,
  executionEnvironment: ExecutionEnvironment | null = null,
  configResolver:
    | ((
        snapshot: ExecutionEnvironment,
      ) => ServerConfig | null | Promise<ServerConfig | null>)
    | null = null,
  owned: {
    processRuntime: OwnedProcessRuntime | null
    workspaceRoot: string | null
    stateRoot: string
    ownerSessionId: string | null
  } = {
    processRuntime: null,
    workspaceRoot: null,
    stateRoot: process.cwd(),
    ownerSessionId: null,
  },
): MCPConnection {
  const invalid = invalidConfigReason(cfg)
  if (invalid !== null) return new InvalidConfigConnection(cfg.name, invalid)
  if (cfg.transport === 'http') return new HttpConnection(cfg.name, cfg)
  if (cfg.transport === 'sse') return new SSEConnection(cfg.name, cfg)
  return new StdioConnection(cfg.name, cfg, {
    executionEnvironment,
    configResolver,
    processRuntime: owned.processRuntime,
    workspaceRoot: owned.workspaceRoot,
    stateRoot: owned.stateRoot,
    ownerSessionId: owned.ownerSessionId,
  })
}

/** Why a server cannot be connected as configured, or null. Never falls back to stdio. */
export function invalidConfigReason(cfg: ServerConfig): string | null {
  if (cfg.transport === 'stdio')
    return cfg.command
      ? null
      : `MCP server '${cfg.name}' uses stdio but has no command`
  if (cfg.transport === 'http' || cfg.transport === 'sse')
    return cfg.url
      ? null
      : `MCP server '${cfg.name}' uses ${cfg.transport} but has no url`
  return `MCP server '${cfg.name}' has unsupported transport '${String(cfg.transport).slice(0, 40)}' (expected stdio, sse, or http)`
}

async function loadMcpConfigForEnvironment(
  root: string,
  executionEnvironment: ExecutionEnvironment,
  sealer: SecretSealer | null | undefined,
): Promise<MCPConfig> {
  return await loadMcpConfig(
    root,
    (name) => executionEnvironment.selectEnv([name])[name],
    { sealer: sealer ?? null },
  )
}

function booleanOption(
  value: unknown,
  fallback: unknown,
  defaultValue: boolean,
): boolean {
  if (typeof value === 'boolean') return value
  if (typeof fallback === 'boolean') return fallback
  return defaultValue
}

function booleanOptionSource<
  T extends 'fallback_write' | 'fallback_serialized',
>(
  value: unknown,
  fallback: unknown,
  defaultSource: T,
): 'tool_override' | 'config_default' | T {
  if (typeof value === 'boolean') return 'tool_override'
  if (typeof fallback === 'boolean') return 'config_default'
  return defaultSource
}

function positiveInt(value: unknown): number | null {
  if (typeof value === 'boolean') return null
  if (typeof value === 'number' && Number.isInteger(value) && value > 0)
    return value
  return null
}
