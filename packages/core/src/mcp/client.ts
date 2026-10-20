import { MCPToolAdapter } from './adapter'
import { loadMcpConfig, type MCPConfig, type ServerConfig } from './config'
import {
  distinctMcpToolName,
  pluginMcpToolName,
  userMcpToolName,
} from './plugin-names'
import {
  HttpConnection,
  InvalidConfigConnection,
  MCPConnection,
  SSEConnection,
  StdioConnection,
  type MCPToolDefinition,
} from './connection'
import type { ExecutionEnvironment } from '../environment/snapshot'
import {
  MCPConnectionSupervisor,
  type MCPConnectionSnapshot,
  type MCPConnectionSupervisorOptions,
} from './supervisor'
import { OwnedProcessRuntime } from '../processes/runtime'
import type { UnsandboxedConsentPort } from '../sandbox/consent'
import type { SecretSealer } from '../security/secret-sealer'
import type { McpServerSource } from './containment'

/** Servers that connect at once (KRN-04). */
const CONNECT_CONCURRENCY = 4

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
  /**
   * Where stdio servers are born and contained (SEC-08). Without one the
   * client makes its own over `root` (receipts in `<root>/processes`).
   */
  readonly processRuntime?: OwnedProcessRuntime | null
  /**
   * Asks the user before one of their own servers (mcp_config.json) runs
   * outside an unavailable sandbox. Without it such a server is refused.
   */
  readonly unsandboxedConsent?: UnsandboxedConsentPort | null
  /** Where stdio servers run and may write (the chat workspace, or a project root). */
  readonly workspaceRoot?: string | null
  /**
   * Run the servers of `mcp_config.json` (default). A project instance runs
   * only the plugin servers it is given (KRN-01).
   */
  readonly userServers?: boolean
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
      | 'listToolsTimeoutMs'
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
  /** Names in mcp_config.json at the last reload: the user's own servers. */
  private userServerNames = new Set<string>()
  private ownRuntime: OwnedProcessRuntime | null = null
  private toolsChanged: () => void = () => {}
  /** The reload running, and the one queued behind it (single flight). */
  private reloading: Promise<void> | null = null
  private queuedReload: {
    environment: ExecutionEnvironment | null
    run: Promise<void>
  } | null = null
  /** Bumped by close(): a reload begun before it stops touching the client. */
  private epoch = 0
  /** Tool rebuilds run one after another, each on the latest state. */
  private toolsRefresh: Promise<void> = Promise.resolve()

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
            processRuntime: this.processRuntime(),
            workspaceRoot: opts.workspaceRoot ?? null,
            stateRoot: this.root,
            // Servers serve every session of their scope: no session owns them.
            ownerSessionId: null,
            source: this.sourceOf(config.name),
            consent: opts.unsandboxedConsent ?? null,
          },
        ))
  }

  private processRuntime(): OwnedProcessRuntime {
    if (this.opts.processRuntime) return this.opts.processRuntime
    this.ownRuntime ??= new OwnedProcessRuntime(this.root)
    return this.ownRuntime
  }

  /** A server is the user's only when mcp_config.json names it; else a plugin's. */
  private sourceOf(name: string): McpServerSource {
    return this.opts.userServers !== false && this.userServerNames.has(name)
      ? 'user'
      : 'plugin'
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

  /**
   * Called whenever the tool list changes, as each server becomes ready
   * (the host re-registers its MCP tools).
   */
  onToolsChanged(listener: () => void): void {
    this.toolsChanged = listener
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

  /**
   * Apply the config: removed servers stop, new and changed ones connect in
   * parallel, four at a time, and each one's tools join as it becomes ready,
   * so a server that never answers holds up neither the others nor the
   * window (the host does not wait for its first reload). Resolves once
   * every server is ready or has failed (a silent one after its 15 s
   * timeout). Single flight (KRN-04): a reload asked for while one runs is
   * queued once, with the latest arguments, and its callers wait for it.
   */
  reload(
    executionEnvironment: ExecutionEnvironment | null = this
      .executionEnvironment,
  ): Promise<void> {
    if (this.queuedReload) {
      this.queuedReload.environment = executionEnvironment
      return this.queuedReload.run
    }
    if (!this.reloading) return this.startReload(executionEnvironment)
    const epoch = this.epoch
    const queued = { environment: executionEnvironment, run: Promise.resolve() }
    queued.run = this.reloading
      .catch(() => {})
      .then(async () => {
        if (this.queuedReload === queued) this.queuedReload = null
        if (epoch === this.epoch) await this.startReload(queued.environment)
      })
    this.queuedReload = queued
    return queued.run
  }

  /** Resolves once no reload is running or queued (the first one included). */
  async settled(): Promise<void> {
    while (this.reloading || this.queuedReload)
      await (this.queuedReload?.run ?? this.reloading)?.catch(() => {})
  }

  private startReload(
    executionEnvironment: ExecutionEnvironment | null,
  ): Promise<void> {
    const run = this.reloadOnce(executionEnvironment).finally(() => {
      if (this.reloading === run) this.reloading = null
    })
    this.reloading = run
    return run
  }

  private async reloadOnce(
    executionEnvironment: ExecutionEnvironment | null,
  ): Promise<void> {
    const epoch = this.epoch
    const config: MCPConfig =
      this.opts.userServers === false
        ? { servers: {}, defaults: {} }
        : executionEnvironment
          ? await loadMcpConfigForEnvironment(
              this.root,
              executionEnvironment,
              this.opts.sealer,
            )
          : await loadMcpConfig(this.root, process.env, {
              sealer: this.opts.sealer ?? null,
            })
    if (epoch !== this.epoch) return
    this.executionEnvironment = executionEnvironment
    const userNames = new Set(Object.keys(config.servers))
    this.userServerNames = userNames
    const plugins = [...this.pluginServers.values()]
      // A user server that later took the same name wins until keys are recomputed.
      .filter((server) => !userNames.has(server.key))
      .map((server) => ({ ...server.config, name: server.key }))
    const wanted = [...Object.values(config.servers), ...plugins].filter(
      (server) => server.enabled,
    )
    const desired = new Set(wanted.map((server) => server.name))

    for (const [name, connection] of [...this.connections]) {
      if (desired.has(name)) continue
      this.connections.delete(name)
      this.effectiveConfigs.delete(name)
      await connection.disconnect().catch(() => {})
    }
    this.config = config

    const connects = wanted.map((server) => async () => {
      if (epoch !== this.epoch) return
      let supervisor = this.connections.get(server.name)
      let ready: boolean
      if (supervisor) {
        ready = await supervisor.reconfigure(server)
      } else {
        supervisor = this.supervise(server)
        ready = await supervisor.connect()
      }
      if (
        !ready ||
        epoch !== this.epoch ||
        this.connections.get(server.name) !== supervisor
      )
        return
      this.effectiveConfigs.set(server.name, server)
      await this.refreshTools()
    })
    await settleAll(connects, CONNECT_CONCURRENCY)
    if (epoch !== this.epoch) return
    await this.refreshTools()
    this.initialized = true
  }

  private supervise(server: ServerConfig): MCPConnectionSupervisor {
    const supervisor = new MCPConnectionSupervisor({
      serverName: server.name,
      config: server,
      connectionFactory: (candidate) =>
        this.connectionFactory(candidate, this.executionEnvironment),
      ...(this.opts.supervisor ?? {}),
      onStateChange: this.opts.onStateChange,
    })
    this.connections.set(server.name, supervisor)
    return supervisor
  }

  private refreshTools(): Promise<void> {
    const run = this.toolsRefresh.then(async () => {
      await this.rebuildTools()
      this.toolsChanged()
    })
    this.toolsRefresh = run.catch(() => {})
    return run
  }

  private async rebuildTools(): Promise<void> {
    const tools: MCPToolAdapter[] = []
    const defaults = this.config?.defaults ?? {}
    const found: Array<{
      server: ServerConfig
      conn: MCPConnectionSupervisor
      effectiveConfig: ServerConfig
      tool: MCPToolDefinition
    }> = []
    for (const server of Object.values(this.config?.servers ?? {})) {
      if (!server.enabled) continue
      const conn = this.connections.get(server.name)
      if (!conn) continue
      const effectiveConfig = this.effectiveConfigs.get(server.name)
      if (!effectiveConfig) continue
      for (const tool of await conn.listTools())
        found.push({ server, conn, effectiveConfig, tool })
    }
    const names = userToolNames(
      found.map(({ server, tool }) => [server.name, tool.name]),
    )
    for (const [index, entry] of found.entries()) {
      const { server, conn, effectiveConfig, tool } = entry
      const overrides = effectiveConfig.tool_overrides[tool.name] ?? {}
      const connectionSnapshot = conn.snapshot()
      tools.push(
        new MCPToolAdapter({
          serverName: server.name,
          toolName: tool.name,
          name: names[index]!,
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
    const skipped = await this.addPluginTools(tools)
    this.tools.splice(0, this.tools.length, ...tools)
    this.skippedPluginTools.clear()
    for (const [key, names] of skipped) this.skippedPluginTools.set(key, names)
  }

  /**
   * Plugin tools come after the user's, in plugin order; one whose contract
   * name is already taken is left out and remembered, never registered twice.
   */
  private async addPluginTools(
    tools: MCPToolAdapter[],
  ): Promise<Map<string, string[]>> {
    const skippedByKey = new Map<string, string[]>()
    const taken = new Set([
      ...this.reservedToolNames(),
      ...tools.map((tool) => tool.name),
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
        tools.push(
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
      if (skipped.length) skippedByKey.set(server.key, skipped)
    }
    return skippedByKey
  }

  getTools(): MCPToolAdapter[] {
    return [...this.tools]
  }

  /** A server's last 200 stderr lines (stdio servers), or null for an unknown server. */
  serverStderr(serverName: string): string | null {
    return this.connections.get(serverName)?.stderrTail(200) ?? null
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
    // A reload in flight sees the new epoch and stops; a queued one never runs.
    this.epoch += 1
    this.reloading = null
    this.queuedReload = null
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
    if (this.opts.userServers === false) return null
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
    source?: McpServerSource
    consent?: UnsandboxedConsentPort | null
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
    source: owned.source ?? 'plugin',
    consent: owned.consent ?? null,
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

/**
 * Names for the tools of the user's servers, in order. A name that was
 * already valid keeps its plain form; a cleaned one that clashes with a
 * name already taken gets a hash of its server and tool (KRN-04).
 */
function userToolNames(
  tools: ReadonlyArray<readonly [server: string, tool: string]>,
): string[] {
  const plain = tools.map(
    ([server, tool]) =>
      userMcpToolName(server, tool) === `mcp_${server}_${tool}`,
  )
  const taken = new Set<string>()
  const names: Array<string | null> = tools.map(([server, tool], index) => {
    const name = userMcpToolName(server, tool)
    if (!plain[index] || taken.has(name)) return null
    taken.add(name)
    return name
  })
  return tools.map(([server, tool], index) => {
    const kept = names[index]
    if (kept) return kept
    let name = userMcpToolName(server, tool)
    if (taken.has(name)) name = distinctMcpToolName(name, `${server}\0${tool}`)
    taken.add(name)
    return name
  })
}

/** Run every task, at most `limit` at a time; failures stay with their task. */
async function settleAll(
  tasks: ReadonlyArray<() => Promise<void>>,
  limit: number,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!
      await task().catch(() => {})
    }
  }
  await Promise.allSettled(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
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
