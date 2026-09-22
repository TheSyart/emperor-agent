import { MCPToolAdapter } from './adapter'
import { loadMcpConfig, type MCPConfig, type ServerConfig } from './config'
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

export interface MCPClientOptions {
  readonly processRuntime?: OwnedProcessRuntime | null
  readonly workspaceRoot?: (() => string) | null
  readonly ownerSessionId?: (() => string | null) | null
  readonly connectionFactory?: MCPConnectionFactory
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
      ? await loadMcpConfigForEnvironment(this.root, executionEnvironment)
      : await loadMcpConfig(this.root)
    this.executionEnvironment = executionEnvironment
    const desired = new Set<string>()

    for (const server of Object.values(config.servers)) {
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
  }

  getTools(): MCPToolAdapter[] {
    return [...this.tools]
  }

  getConnection(serverName: string): MCPConnection | undefined {
    return this.connections.get(serverName)
  }

  snapshot(): MCPClientSnapshot {
    const configured = Object.values(this.config?.servers ?? {}).filter(
      (server) => server.enabled,
    ).length
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
    const config = (await loadMcpConfigForEnvironment(this.root, snapshot))
      .servers[serverName]
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
): Promise<MCPConfig> {
  return await loadMcpConfig(
    root,
    (name) => executionEnvironment.selectEnv([name])[name],
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
