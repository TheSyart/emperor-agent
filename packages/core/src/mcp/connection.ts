import type { ServerConfig } from './config'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ExecutionEnvironment } from '../environment/snapshot'
import { EmperorError } from '../errors'
import type { OwnedProcessRuntime } from '../processes/runtime'
import { logger } from '../util/log'
import { OwnedStdioClientTransport } from './owned-stdio-transport'

export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface MCPCallToolResult {
  content: string
  isError: boolean
  requestId?: string
  generation?: number
  clientId?: string
}

export type MCPConnectionErrorCode =
  | 'mcp_aborted'
  | 'mcp_auth_failed'
  | 'mcp_config_invalid'
  | 'mcp_connection_failed'
  | 'mcp_protocol_error'
  | 'mcp_restart_exhausted'
  | 'mcp_transport_timeout'
  | 'mcp_unavailable'

export class MCPConnectionError extends EmperorError {
  constructor(
    code: MCPConnectionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, code, options)
  }
}

export type MCPConnectionLifecycleEvent =
  | { type: 'closed'; reason?: string; intentional?: boolean }
  | { type: 'error'; error: unknown; fatal?: boolean }

export interface MCPCallRequestOptions {
  requestId?: string | null
  signal?: AbortSignal | null
  timeoutMs?: number | null
  executionEnvironment?: ExecutionEnvironment | null
}

export const SAFE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TERM',
  'PWD',
  'USERPROFILE',
  'USERNAME',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
])

export abstract class MCPConnection {
  readonly serverName: string
  connected = false
  protected connectionFailure: unknown = null
  private activeCalls = 0
  private environmentRevision: string | null = null
  private environmentQueue: Promise<void> = Promise.resolve()
  private readonly idleWaiters = new Set<() => void>()
  private lifecycleListener:
    ((event: MCPConnectionLifecycleEvent) => void | Promise<void>) | null = null

  constructor(serverName: string) {
    this.serverName = serverName
  }

  abstract connect(): Promise<boolean>
  abstract disconnect(): Promise<void>
  abstract listTools(): Promise<MCPToolDefinition[]>
  abstract callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<MCPCallToolResult>

  get lastConnectionFailure(): unknown {
    return this.connectionFailure
  }

  setLifecycleListener(
    listener:
      ((event: MCPConnectionLifecycleEvent) => void | Promise<void>) | null,
  ): void {
    this.lifecycleListener = listener
  }

  async callToolRequest(
    toolName: string,
    args: Record<string, unknown>,
    opts: MCPCallRequestOptions = {},
  ): Promise<MCPCallToolResult> {
    if (opts.executionEnvironment)
      await this.prepareExecutionEnvironment(opts.executionEnvironment)
    throwIfAborted(opts.signal ?? undefined)
    this.activeCalls += 1
    try {
      return await this.callTool(
        toolName,
        args,
        opts.signal ?? undefined,
        positiveTimeout(opts.timeoutMs),
      )
    } finally {
      this.activeCalls -= 1
      if (this.activeCalls === 0) {
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
      }
    }
  }

  get executionEnvironmentRevision(): string | null {
    return this.environmentRevision
  }

  async callToolWithEnvironment(
    toolName: string,
    args: Record<string, unknown>,
    snapshot: ExecutionEnvironment,
    signal?: AbortSignal,
  ): Promise<MCPCallToolResult> {
    return await this.callToolRequest(toolName, args, {
      executionEnvironment: snapshot,
      signal,
    })
  }

  protected reportLifecycle(event: MCPConnectionLifecycleEvent): void {
    void this.lifecycleListener?.(event)
  }

  protected async applyExecutionEnvironment(
    _snapshot: ExecutionEnvironment,
  ): Promise<void> {}

  protected adoptExecutionEnvironment(snapshot: ExecutionEnvironment): void {
    this.environmentRevision = snapshot.revision
  }

  private async prepareExecutionEnvironment(
    snapshot: ExecutionEnvironment,
  ): Promise<void> {
    const operation = this.environmentQueue.then(async () => {
      if (this.environmentRevision === snapshot.revision) return
      if (this.activeCalls > 0)
        await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
      if (this.environmentRevision === snapshot.revision) return
      await this.applyExecutionEnvironment(snapshot)
      this.environmentRevision = snapshot.revision
    })
    this.environmentQueue = operation.catch(() => {})
    await operation
  }
}

export function buildStdioEnv(
  config: Pick<ServerConfig, 'env'> | { env?: Record<string, string> },
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && SAFE_ENV_KEYS.has(key)) out[key] = value
  }
  for (const [key, value] of Object.entries(config.env ?? {})) out[key] = value
  return out
}

export class StdioConnection extends MCPConnection {
  config: ServerConfig
  private client: Client | null = null
  private executionEnvironment: ExecutionEnvironment | null
  private intentionalDisconnect = false
  private readonly processRuntime: OwnedProcessRuntime | null
  private readonly workspaceRoot: string | null
  private readonly stateRoot: string | null
  private readonly ownerSessionId: string | null
  private readonly configResolver:
    | ((
        snapshot: ExecutionEnvironment,
      ) => ServerConfig | null | Promise<ServerConfig | null>)
    | null

  constructor(
    serverName: string,
    config: ServerConfig,
    opts: {
      executionEnvironment?: ExecutionEnvironment | null
      configResolver?:
        | ((
            snapshot: ExecutionEnvironment,
          ) => ServerConfig | null | Promise<ServerConfig | null>)
        | null
      processRuntime?: OwnedProcessRuntime | null
      workspaceRoot?: string | null
      stateRoot?: string | null
      ownerSessionId?: string | null
    } = {},
  ) {
    super(serverName)
    this.config = config
    this.executionEnvironment = opts.executionEnvironment ?? null
    this.configResolver = opts.configResolver ?? null
    this.processRuntime = opts.processRuntime ?? null
    this.workspaceRoot = opts.workspaceRoot ?? null
    this.stateRoot = opts.stateRoot ?? null
    this.ownerSessionId = opts.ownerSessionId ?? null
    if (this.executionEnvironment)
      this.adoptExecutionEnvironment(this.executionEnvironment)
  }

  stdioParams(env: Record<string, string | undefined> = process.env): {
    command: string
    args: string[]
    env: Record<string, string> | undefined
  } {
    const childEnv = buildStdioEnv(this.config, env)
    return {
      command: this.config.command ?? '',
      args: this.config.args,
      env: Object.keys(childEnv).length ? childEnv : undefined,
    }
  }

  async connect(): Promise<boolean> {
    try {
      const params = this.stdioParams(
        this.executionEnvironment?.env ?? process.env,
      )
      const transport = this.processRuntime
        ? new OwnedStdioClientTransport({
            runtime: this.processRuntime,
            serverName: this.serverName,
            ownerSessionId: this.ownerSessionId,
            workspaceRoot: this.workspaceRoot ?? process.cwd(),
            stateRoot: this.stateRoot ?? this.workspaceRoot ?? process.cwd(),
            command: params.command,
            args: params.args,
            ...(params.env ? { env: params.env } : {}),
          })
        : new StdioClientTransport({ ...params, stderr: 'inherit' })
      const client = new Client({ name: 'emperor-agent', version: '0.0.0' })
      client.onclose = () => {
        if (this.client === client) this.client = null
        this.connected = false
        this.reportLifecycle({
          type: 'closed',
          reason: this.intentionalDisconnect
            ? 'intentional disconnect'
            : 'transport closed',
          intentional: this.intentionalDisconnect,
        })
      }
      client.onerror = (error) => {
        this.connectionFailure = error
        this.reportLifecycle({ type: 'error', error })
      }
      await client.connect(transport)
      this.client = client
      this.connected = true
      this.connectionFailure = null
      return true
    } catch (error) {
      this.connectionFailure = error
      this.client = null
      this.connected = false
      return false
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client
    this.intentionalDisconnect = true
    try {
      await client?.close().catch(() => {})
    } finally {
      if (this.client === client) this.client = null
      this.connected = false
      this.intentionalDisconnect = false
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.client || !this.connected) return []
    const result = await this.client.listTools()
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }))
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<MCPCallToolResult> {
    if (!this.client || !this.connected)
      throw new Error(`MCP server '${this.serverName}' not connected`)
    const client = this.client
    if (!client)
      throw new Error(`MCP server '${this.serverName}' not connected`)
    return normalizeCallToolResult(
      await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        signal || timeoutMs
          ? {
              ...(signal ? { signal } : {}),
              ...(timeoutMs
                ? { timeout: timeoutMs, maxTotalTimeout: timeoutMs }
                : {}),
            }
          : undefined,
      ),
    )
  }

  protected override async applyExecutionEnvironment(
    snapshot: ExecutionEnvironment,
  ): Promise<void> {
    const resolvedConfig = await this.configResolver?.(snapshot)
    if (this.configResolver && !resolvedConfig)
      throw new Error(`MCP server '${this.serverName}' is no longer configured`)
    if (resolvedConfig) this.config = resolvedConfig
    const reconnect = this.connected
    this.executionEnvironment = snapshot
    if (!reconnect) return
    await this.disconnect()
    if (!(await this.connect()))
      throw new Error(`MCP server '${this.serverName}' failed to reconnect`)
  }
}

/**
 * Shared client plumbing of the network transports (SSE, Streamable HTTP):
 * one SDK `Client` per successful `attach`, lifecycle forwarded to the
 * supervisor, tool listing and calls delegated to the SDK.
 */
abstract class RemoteConnection extends MCPConnection {
  readonly config: ServerConfig
  private client: Client | null = null
  private intentionalDisconnect = false

  constructor(serverName: string, config: ServerConfig) {
    super(serverName)
    this.config = config
  }

  /** Connect a fresh client over `transport`; throws on failure (client closed). */
  protected async attach(transport: Transport): Promise<void> {
    const client = new Client({ name: 'emperor-agent', version: '0.0.0' })
    client.onclose = () => {
      if (this.client === client) this.client = null
      if (this.client === null) this.connected = false
      this.reportLifecycle({
        type: 'closed',
        reason: this.intentionalDisconnect
          ? 'intentional disconnect'
          : 'transport closed',
        intentional: this.intentionalDisconnect,
      })
    }
    client.onerror = (error) => {
      this.connectionFailure = error
      this.reportLifecycle({ type: 'error', error })
    }
    try {
      await client.connect(transport)
    } catch (error) {
      client.onclose = undefined
      client.onerror = undefined
      await client.close().catch(() => {})
      throw error
    }
    this.client = client
    this.connected = true
    this.connectionFailure = null
  }

  protected requestHeaders(): Record<string, string> | undefined {
    return Object.keys(this.config.headers).length
      ? { ...this.config.headers }
      : undefined
  }

  protected sseTransport(url: URL): SSEClientTransport {
    const headers = this.requestHeaders()
    return new SSEClientTransport(url, {
      eventSourceInit: headers
        ? ({ fetch: withHeaders(headers) } as never)
        : undefined,
      requestInit: headers ? { headers } : undefined,
    })
  }

  protected configuredUrl(label: string): URL {
    if (!this.config.url)
      throw new MCPConnectionError(
        'mcp_config_invalid',
        `MCP server '${this.serverName}' has no ${label} url`,
      )
    try {
      return new URL(this.config.url)
    } catch (error) {
      throw new MCPConnectionError(
        'mcp_config_invalid',
        `MCP server '${this.serverName}' has an invalid ${label} url`,
        { cause: error },
      )
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client
    this.intentionalDisconnect = true
    try {
      await client?.close().catch(() => {})
    } finally {
      if (this.client === client) this.client = null
      this.connected = false
      this.intentionalDisconnect = false
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.client || !this.connected) return []
    const result = await this.client.listTools()
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }))
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<MCPCallToolResult> {
    if (!this.client || !this.connected)
      throw new Error(`MCP server '${this.serverName}' not connected`)
    return normalizeCallToolResult(
      await this.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        signal || timeoutMs
          ? {
              ...(signal ? { signal } : {}),
              ...(timeoutMs
                ? { timeout: timeoutMs, maxTotalTimeout: timeoutMs }
                : {}),
            }
          : undefined,
      ),
    )
  }
}

export class SSEConnection extends RemoteConnection {
  async connect(): Promise<boolean> {
    try {
      await this.attach(this.sseTransport(this.configuredUrl('SSE')))
      return true
    } catch (error) {
      this.connectionFailure = error
      this.connected = false
      return false
    }
  }
}

/**
 * Streamable HTTP (MCP 2025-03-26+). Servers that only speak the legacy
 * HTTP+SSE transport are reached by falling back to SSE when the initial
 * Streamable HTTP handshake fails (authentication failures do not fall back).
 */
export class HttpConnection extends RemoteConnection {
  /** Transport actually in use after the last successful connect. */
  activeTransport: 'http' | 'sse' | null = null

  async connect(): Promise<boolean> {
    this.activeTransport = null
    let url: URL
    try {
      url = this.configuredUrl('HTTP')
    } catch (error) {
      this.connectionFailure = error
      this.connected = false
      return false
    }
    const headers = this.requestHeaders()
    try {
      await this.attach(
        new StreamableHTTPClientTransport(url, {
          ...(headers ? { requestInit: { headers } } : {}),
        }),
      )
      this.activeTransport = 'http'
      return true
    } catch (httpError) {
      if (isAuthFailure(httpError)) {
        this.connectionFailure = httpError
        this.connected = false
        return false
      }
      logger.warn(
        'MCP Streamable HTTP connect failed; falling back to legacy SSE',
        { server: this.serverName, error: errorMessage(httpError) },
      )
      try {
        await this.attach(this.sseTransport(url))
        this.activeTransport = 'sse'
        return true
      } catch (sseError) {
        this.connectionFailure = isAuthFailure(sseError) ? sseError : httpError
        this.connected = false
        return false
      }
    }
  }
}

/** Placeholder for a server whose configuration cannot be connected (never spawns). */
export class InvalidConfigConnection extends MCPConnection {
  private readonly reason: string

  constructor(serverName: string, reason: string) {
    super(serverName)
    this.reason = reason
  }

  async connect(): Promise<boolean> {
    this.connected = false
    this.connectionFailure = new MCPConnectionError(
      'mcp_config_invalid',
      this.reason,
    )
    return false
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    return []
  }

  async callTool(): Promise<MCPCallToolResult> {
    throw new MCPConnectionError('mcp_config_invalid', this.reason)
  }
}

function isAuthFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 401 || code === 403) return true
  return /\b(?:401|403)\b|unauthori[sz]ed|forbidden/i.test(errorMessage(error))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const error = new Error('MCP tool call aborted')
  error.name = 'AbortError'
  throw error
}

function positiveTimeout(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}

function normalizeCallToolResult(
  result: Awaited<ReturnType<Client['callTool']>>,
): MCPCallToolResult {
  if ('toolResult' in result)
    return {
      content: stringifyUnknown(result.toolResult),
      isError: Boolean(result.isError),
    }
  const content =
    'content' in result && Array.isArray(result.content) ? result.content : []
  const texts = content.map((item) => {
    if (item.type === 'text') return item.text
    if (item.type === 'resource' && 'resource' in item)
      return stringifyUnknown(item.resource)
    return stringifyUnknown(item)
  })
  if (
    !texts.length &&
    'structuredContent' in result &&
    result.structuredContent
  )
    texts.push(stringifyUnknown(result.structuredContent))
  const output = texts.join('\n') || '(empty result)'
  return { content: output, isError: Boolean(result.isError) }
}

function stringifyUnknown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function withHeaders(headers: Record<string, string>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const existing =
      init?.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : init?.headers &&
            typeof init.headers === 'object' &&
            !Array.isArray(init.headers)
          ? (init.headers as Record<string, string>)
          : {}
    return fetch(input, { ...init, headers: { ...existing, ...headers } })
  }) as typeof fetch
}
