import { createHash, randomUUID } from 'node:crypto'
import type { ServerConfig } from './config'
import {
  MCPConnection,
  MCPConnectionError,
  type MCPCallRequestOptions,
  type MCPCallToolResult,
  type MCPConnectionErrorCode,
  type MCPConnectionLifecycleEvent,
  type MCPToolDefinition,
} from './connection'

export type MCPConnectionState =
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'backoff'
  | 'auth_failed'
  | 'failed'
  | 'stopped'

export type MCPConnectionHealth = 'unknown' | 'healthy' | 'unhealthy'
export type MCPConnectionAuth = 'unknown' | 'ok' | 'failed'

export interface MCPClientIdentity {
  readonly generation: number
  readonly clientId: string
}

export interface MCPConnectionDiagnosticError {
  readonly code: MCPConnectionErrorCode
  readonly message: string
}

export interface MCPConnectionSnapshot {
  readonly serverName: string
  readonly transport: string
  readonly generation: number
  readonly clientId: string | null
  readonly state: MCPConnectionState
  readonly health: MCPConnectionHealth
  readonly auth: MCPConnectionAuth
  readonly toolCount: number
  readonly tools: string[]
  readonly restartAttempts: number
  readonly nextRetryAt: number | null
  readonly activeRequestCount: number
  readonly activeRequestIds: string[]
  readonly lastError: MCPConnectionDiagnosticError | null
}

export interface MCPConnectionSupervisorOptions {
  readonly serverName: string
  readonly config: ServerConfig
  readonly connectionFactory: (
    config: ServerConfig,
    identity: MCPClientIdentity,
  ) => MCPConnection
  readonly clientIdFactory?: (generation: number) => string
  readonly requestIdFactory?: () => string
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly now?: () => number
  /** Jitter source in [0, 1) (tests pin it). */
  readonly random?: () => number
  readonly maxRestartAttempts?: number
  readonly callTimeoutMs?: number
  readonly connectTimeoutMs?: number
  /** How long a new client may take to list its tools (default 15 s). */
  readonly listToolsTimeoutMs?: number
  readonly onStateChange?: (
    snapshot: MCPConnectionSnapshot,
  ) => void | Promise<void>
}

interface ManagedClient extends MCPClientIdentity {
  readonly connection: MCPConnection
  readonly configFingerprint: string
  readonly tools: MCPToolDefinition[]
}

/**
 * Restart backoff (KRN-04): 1, 4, 16, then 60 s between attempts, each
 * ±20%; five restarts after the first failure, so the sixth consecutive
 * failure leaves the server `failed` with no more automatic restarts. The
 * count resets only after 60 s of stable running.
 */
const DEFAULT_BACKOFF_MS = [1_000, 4_000, 16_000, 60_000] as const
const DEFAULT_MAX_RESTARTS = 5
const STABLE_RESET_MS = 60_000
const DEFAULT_CALL_TIMEOUT_MS = 60_000

/**
 * Owns one logical MCP server. A generated client can only mutate state while
 * its generation and client ID are still current, so a late close/error from a
 * replaced transport cannot tear down the replacement.
 */
export class MCPConnectionSupervisor extends MCPConnection {
  private desiredConfig: ServerConfig
  private readonly connectionFactory: MCPConnectionSupervisorOptions['connectionFactory']
  private readonly clientIdFactory: (generation: number) => string
  private readonly requestIdFactory: () => string
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => number
  private readonly maxRestartAttempts: number
  private readonly callTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly listToolsTimeoutMs: number
  private readonly onStateChange:
    MCPConnectionSupervisorOptions['onStateChange'] | null
  private current: ManagedClient | null = null
  private generation = 0
  private state: MCPConnectionState = 'stopped'
  private health: MCPConnectionHealth = 'unknown'
  private auth: MCPConnectionAuth = 'unknown'
  private restartAttempts = 0
  /** When the current client became ready (the stable-running clock). */
  private readyAt: number | null = null
  private readonly random: () => number
  private nextRetryAt: number | null = null
  private lastError: MCPConnectionDiagnosticError | null = null
  private operation: Promise<boolean> | null = null
  /**
   * Bumped by disconnect(): an attempt begun before it closes whatever it
   * opened when it lands and changes nothing (KRN-04, no orphan processes).
   */
  private epoch = 0
  /** The connection an attempt in flight is opening. */
  private candidate: MCPConnection | null = null
  private stopped = false
  private readonly activeRequests = new Set<string>()

  constructor(opts: MCPConnectionSupervisorOptions) {
    super(opts.serverName)
    this.desiredConfig = structuredClone(opts.config)
    this.connectionFactory = opts.connectionFactory
    this.clientIdFactory =
      opts.clientIdFactory ??
      ((generation) =>
        `mcp_client_${generation}_${randomUUID().replace(/-/g, '')}`)
    this.requestIdFactory =
      opts.requestIdFactory ??
      (() => `mcp_req_${randomUUID().replace(/-/g, '')}`)
    this.sleep = opts.sleep ?? abortableDelay
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? Math.random
    this.maxRestartAttempts = boundedPositiveInt(
      opts.maxRestartAttempts,
      DEFAULT_MAX_RESTARTS,
    )
    this.callTimeoutMs = boundedPositiveInt(
      opts.callTimeoutMs,
      DEFAULT_CALL_TIMEOUT_MS,
    )
    this.connectTimeoutMs = boundedPositiveInt(opts.connectTimeoutMs, 15_000)
    this.listToolsTimeoutMs = boundedPositiveInt(
      opts.listToolsTimeoutMs,
      15_000,
    )
    this.onStateChange = opts.onStateChange ?? null
  }

  override async connect(): Promise<boolean> {
    if (this.current && this.state === 'ready') return true
    if (this.state === 'auth_failed') return false
    this.stopped = false
    return await this.singleflight(() =>
      this.installCandidate(this.desiredConfig),
    )
  }

  override async disconnect(): Promise<void> {
    this.stopped = true
    this.epoch += 1
    // The next connect starts afresh instead of joining a stale attempt.
    this.operation = null
    const candidate = this.candidate
    this.candidate = null
    const previous = this.current
    this.current = null
    this.connected = false
    this.state = 'stopped'
    this.health = 'unknown'
    this.auth = 'unknown'
    this.nextRetryAt = null
    this.activeRequests.clear()
    this.emitState()
    if (previous) {
      previous.connection.setLifecycleListener(null)
      await previous.connection.disconnect().catch(() => {})
    }
    if (candidate) {
      candidate.setLifecycleListener(null)
      await candidate.disconnect().catch(() => {})
    }
  }

  override async listTools(): Promise<MCPToolDefinition[]> {
    return this.current?.tools.map((tool) => structuredClone(tool)) ?? []
  }

  override async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<MCPCallToolResult> {
    return await this.callToolRequest(toolName, args, {
      signal,
      timeoutMs,
    })
  }

  override async callToolRequest(
    toolName: string,
    args: Record<string, unknown>,
    opts: MCPCallRequestOptions = {},
  ): Promise<MCPCallToolResult> {
    if (!this.current || this.state !== 'ready')
      await this.restart('call_requires_connection')
    const client = this.current
    if (!client || this.state !== 'ready') throw this.unavailableError()

    const requestId = cleanRequestId(opts.requestId) || this.requestIdFactory()
    const timeoutMs = boundedPositiveInt(opts.timeoutMs, this.callTimeoutMs)
    const controller = new AbortController()
    let abortKind: 'external' | 'timeout' | null = null
    const abortFromParent = () => {
      abortKind = 'external'
      controller.abort(opts.signal?.reason)
    }
    if (opts.signal?.aborted) abortFromParent()
    else opts.signal?.addEventListener('abort', abortFromParent, { once: true })
    const timer = setTimeout(() => {
      abortKind = 'timeout'
      controller.abort(`MCP request ${requestId} timed out`)
    }, timeoutMs)
    timer.unref?.()
    this.activeRequests.add(requestId)
    this.emitState()

    try {
      const result = await raceWithAbort(
        client.connection.callToolRequest(toolName, args, {
          requestId,
          signal: controller.signal,
          timeoutMs,
          executionEnvironment: opts.executionEnvironment ?? null,
        }),
        controller.signal,
      )
      if (!this.isCurrent(client)) throw this.unavailableError()
      return {
        ...result,
        requestId,
        generation: client.generation,
        clientId: client.clientId,
      }
    } catch (error) {
      if (abortKind === 'timeout') {
        const typed = new MCPConnectionError(
          'mcp_transport_timeout',
          `MCP server '${this.serverName}' request timed out`,
          { cause: error },
        )
        this.markCurrentDegraded(client, typed)
        throw typed
      }
      if (abortKind === 'external' || opts.signal?.aborted) {
        throw new MCPConnectionError(
          'mcp_aborted',
          `MCP server '${this.serverName}' request was cancelled`,
          { cause: error },
        )
      }
      const typed = classifyMcpConnectionError(error, 'mcp_protocol_error')
      if (typed.code === 'mcp_auth_failed') this.markAuthFailed(client, typed)
      else this.markCurrentDegraded(client, typed)
      throw typed
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', abortFromParent)
      this.activeRequests.delete(requestId)
      this.emitState()
    }
  }

  /** Explicit config changes may replace an auth-failed generation once. */
  async reconfigure(config: ServerConfig): Promise<boolean> {
    this.desiredConfig = structuredClone(config)
    this.stopped = false
    const fingerprint = configFingerprint(config)
    // An attempt for an older config may be in flight: let it land, then
    // install this one (unless a newer reconfigure or a disconnect came).
    if (this.operation) await this.operation.catch(() => false)
    if (this.stopped || configFingerprint(this.desiredConfig) !== fingerprint)
      return false
    if (
      this.current?.configFingerprint === fingerprint &&
      this.state === 'ready'
    )
      return true
    return await this.singleflight(() => this.installCandidate(config))
  }

  /**
   * Reconnects the transport, never the tool call. Concurrent callers share one
   * attempt. Authentication failure is terminal until an explicit reconfigure.
   */
  async restart(_reason: string): Promise<boolean> {
    if (this.operation) return await this.operation
    if (this.stopped || this.state === 'auth_failed') return false
    // A client that ran long enough starts a fresh budget.
    if (this.readyAt !== null && this.now() - this.readyAt >= STABLE_RESET_MS)
      this.restartAttempts = 0
    this.readyAt = null
    if (this.restartAttempts >= this.maxRestartAttempts) {
      this.markRestartExhausted()
      return false
    }
    const attemptIndex = this.restartAttempts
    this.restartAttempts += 1
    const base =
      DEFAULT_BACKOFF_MS[Math.min(attemptIndex, DEFAULT_BACKOFF_MS.length - 1)]!
    const delay = Math.round(base * (0.8 + 0.4 * this.random()))
    this.state = 'backoff'
    this.nextRetryAt = this.now() + delay
    this.emitState()
    return await this.singleflight(async () => {
      await this.sleep(delay)
      if (this.stopped) return false
      this.nextRetryAt = null
      const connected = await this.installCandidate(this.desiredConfig)
      if (!connected && this.restartAttempts >= this.maxRestartAttempts)
        this.markRestartExhausted()
      return connected
    })
  }

  snapshot(): MCPConnectionSnapshot {
    const current = this.current
    return {
      serverName: this.serverName,
      transport: this.desiredConfig.transport,
      generation: current?.generation ?? this.generation,
      clientId: current?.clientId ?? null,
      state: this.state,
      health: this.health,
      auth: this.auth,
      toolCount: current?.tools.length ?? 0,
      tools: current?.tools.map((tool) => tool.name) ?? [],
      restartAttempts: this.restartAttempts,
      nextRetryAt: this.nextRetryAt,
      activeRequestCount: this.activeRequests.size,
      activeRequestIds: [...this.activeRequests].sort(),
      lastError: this.lastError ? { ...this.lastError } : null,
    }
  }

  private async installCandidate(config: ServerConfig): Promise<boolean> {
    const epoch = this.epoch
    const stale = () => epoch !== this.epoch
    this.state = 'connecting'
    this.health = this.current ? this.health : 'unknown'
    this.nextRetryAt = null
    this.emitState()
    const identity: MCPClientIdentity = {
      generation: this.generation + 1,
      clientId: this.clientIdFactory(this.generation + 1),
    }
    this.generation = identity.generation
    const connection = this.connectionFactory(structuredClone(config), identity)
    connection.setLifecycleListener((event) =>
      this.onClientLifecycle(identity, event),
    )
    this.candidate = connection

    let connected = false
    let connectOperation: Promise<boolean> | null = null
    try {
      connectOperation = connection.connect()
      connected = await withTimeout(
        connectOperation,
        this.connectTimeoutMs,
        () =>
          new MCPConnectionError(
            'mcp_transport_timeout',
            `MCP server '${this.serverName}' connection timed out`,
          ),
      )
      if (stale()) return await dropStale(connection)
      if (!connected) {
        const failure = classifyMcpConnectionError(
          connection.lastConnectionFailure,
          'mcp_connection_failed',
        )
        this.recordCandidateFailure(failure)
        connection.setLifecycleListener(null)
        await connection.disconnect().catch(() => {})
        return false
      }
      const tools = await withTimeout(
        connection.listTools(),
        this.listToolsTimeoutMs,
        () =>
          new MCPConnectionError(
            'mcp_transport_timeout',
            `MCP server '${this.serverName}' did not list its tools in time`,
          ),
      )
      if (stale()) return await dropStale(connection)
      const candidate: ManagedClient = {
        ...identity,
        connection,
        configFingerprint: configFingerprint(config),
        tools: normalizeTools(tools),
      }
      const previous = this.current
      this.current = candidate
      this.connected = true
      this.state = 'ready'
      this.health = 'healthy'
      this.auth = 'ok'
      this.readyAt = this.now()
      this.nextRetryAt = null
      this.lastError = null
      this.emitState()

      if (previous) {
        previous.connection.setLifecycleListener(null)
        await previous.connection.disconnect().catch(() => {})
      }
      return true
    } catch (error) {
      if (
        connectOperation &&
        error instanceof MCPConnectionError &&
        error.code === 'mcp_transport_timeout'
      ) {
        void connectOperation
          .then(async () => await connection.disconnect().catch(() => {}))
          .catch(() => {})
      }
      if (stale()) return await dropStale(connection)
      const failure = classifyMcpConnectionError(
        error,
        connected ? 'mcp_protocol_error' : 'mcp_connection_failed',
      )
      this.recordCandidateFailure(failure)
      connection.setLifecycleListener(null)
      await connection.disconnect().catch(() => {})
      return false
    } finally {
      if (this.candidate === connection) this.candidate = null
    }
  }

  private async onClientLifecycle(
    identity: MCPClientIdentity,
    event: MCPConnectionLifecycleEvent,
  ): Promise<void> {
    const current = this.current
    if (
      !current ||
      current.generation !== identity.generation ||
      current.clientId !== identity.clientId ||
      (event.type === 'closed' && event.intentional)
    )
      return
    const error =
      event.type === 'error'
        ? classifyMcpConnectionError(event.error, 'mcp_connection_failed')
        : new MCPConnectionError(
            'mcp_connection_failed',
            `MCP server '${this.serverName}' transport closed`,
          )
    // A JSON-RPC level error (a late reply with an unknown id, one dropped
    // oversized message) concerns one call, not the connection's health.
    if (
      event.type === 'error' &&
      !event.fatal &&
      error.code !== 'mcp_auth_failed'
    ) {
      this.lastError = diagnosticError(error)
      this.emitState()
      return
    }
    if (error.code === 'mcp_auth_failed') this.markAuthFailed(current, error)
    else this.markCurrentDegraded(current, error)
    if (event.type === 'closed' || event.fatal) void this.restart('liveness')
  }

  private recordCandidateFailure(error: MCPConnectionError): void {
    this.lastError = diagnosticError(error)
    if (this.current) {
      this.state = 'ready'
    } else if (error.code === 'mcp_auth_failed') {
      this.state = 'auth_failed'
      this.auth = 'failed'
    } else {
      this.state = 'failed'
      this.health = 'unhealthy'
    }
    this.connected = Boolean(this.current)
    this.emitState()
  }

  private markCurrentDegraded(
    client: ManagedClient,
    error: MCPConnectionError,
  ): void {
    if (!this.isCurrent(client)) return
    this.connected = false
    this.state = 'degraded'
    this.health = 'unhealthy'
    this.lastError = diagnosticError(error)
    this.emitState()
  }

  private markAuthFailed(
    client: ManagedClient,
    error: MCPConnectionError,
  ): void {
    if (!this.isCurrent(client)) return
    this.connected = false
    this.state = 'auth_failed'
    this.health = 'unhealthy'
    this.auth = 'failed'
    this.lastError = diagnosticError(error)
    this.emitState()
  }

  private markRestartExhausted(): void {
    this.state = 'failed'
    this.health = 'unhealthy'
    this.connected = false
    this.nextRetryAt = null
    this.lastError = diagnosticError(
      new MCPConnectionError(
        'mcp_restart_exhausted',
        `MCP server '${this.serverName}' exhausted its restart budget`,
      ),
    )
    this.emitState()
  }

  private unavailableError(): MCPConnectionError {
    if (this.lastError?.code === 'mcp_auth_failed')
      return new MCPConnectionError(
        'mcp_auth_failed',
        `MCP server '${this.serverName}' authentication failed`,
      )
    if (this.lastError?.code === 'mcp_restart_exhausted')
      return new MCPConnectionError(
        'mcp_restart_exhausted',
        `MCP server '${this.serverName}' restart budget is exhausted`,
      )
    return new MCPConnectionError(
      'mcp_unavailable',
      `MCP server '${this.serverName}' is unavailable`,
    )
  }

  private isCurrent(client: MCPClientIdentity): boolean {
    return (
      this.current?.generation === client.generation &&
      this.current.clientId === client.clientId
    )
  }

  private async singleflight(
    operation: () => Promise<boolean>,
  ): Promise<boolean> {
    if (this.operation) return await this.operation
    const pending = operation()
    this.operation = pending
    try {
      return await pending
    } finally {
      if (this.operation === pending) this.operation = null
    }
  }

  private emitState(): void {
    try {
      void Promise.resolve(this.onStateChange?.(this.snapshot())).catch(
        () => {},
      )
    } catch {
      // Diagnostics must never break connection state transitions.
    }
  }
}

export function classifyMcpConnectionError(
  error: unknown,
  fallback: MCPConnectionErrorCode,
): MCPConnectionError {
  if (error instanceof MCPConnectionError) return error
  const message = error instanceof Error ? error.message : String(error ?? '')
  const normalized = message.toLowerCase()
  // Only the HTTP status (or the SDK's own auth error) says the server
  // rejected the credentials; a "403" inside a body is not one (KRN-04).
  const status =
    error && typeof error === 'object'
      ? ((error as { code?: unknown }).code ??
        (error as { status?: unknown }).status)
      : undefined
  if (
    status === 401 ||
    status === 403 ||
    (error instanceof Error && error.name === 'UnauthorizedError')
  )
    return new MCPConnectionError(
      'mcp_auth_failed',
      'MCP server authentication failed',
      error instanceof Error ? { cause: error } : undefined,
    )
  if (error instanceof Error && error.name === 'AbortError')
    return new MCPConnectionError('mcp_aborted', 'MCP request was cancelled', {
      cause: error,
    })
  if (/timed?\s*out|timeout/.test(normalized))
    return new MCPConnectionError(
      'mcp_transport_timeout',
      'MCP transport timed out',
      error instanceof Error ? { cause: error } : undefined,
    )
  return new MCPConnectionError(
    fallback,
    fallback === 'mcp_protocol_error'
      ? 'MCP server returned a protocol error'
      : 'MCP server connection failed',
    error instanceof Error ? { cause: error } : undefined,
  )
}

function diagnosticError(
  error: MCPConnectionError,
): MCPConnectionDiagnosticError {
  const code = error.code as MCPConnectionErrorCode
  // Configuration and sandbox errors are composed locally from names and
  // the host's sandbox probe only (no secrets).
  if (
    code === 'mcp_config_invalid' ||
    code === 'mcp_sandbox_refused' ||
    code === 'mcp_sandbox_consent_required'
  )
    return { code, message: error.message.slice(0, 400) }
  return { code, message: diagnosticMessage(code) }
}

function diagnosticMessage(code: MCPConnectionErrorCode): string {
  if (code === 'mcp_auth_failed') return 'MCP server authentication failed'
  if (code === 'mcp_transport_timeout') return 'MCP transport timed out'
  if (code === 'mcp_aborted') return 'MCP request was cancelled'
  if (code === 'mcp_protocol_error') return 'MCP server protocol failed'
  if (code === 'mcp_restart_exhausted')
    return 'MCP server restart budget was exhausted'
  if (code === 'mcp_unavailable') return 'MCP server is unavailable'
  if (code === 'mcp_config_invalid')
    return 'MCP server configuration is invalid'
  if (code === 'mcp_sandbox_refused')
    return 'MCP server was refused by the process sandbox'
  if (code === 'mcp_sandbox_consent_required')
    return 'MCP server is waiting for the user to allow it outside the sandbox'
  return 'MCP server connection failed'
}

function normalizeTools(tools: MCPToolDefinition[]): MCPToolDefinition[] {
  const seen = new Set<string>()
  const normalized: MCPToolDefinition[] = []
  for (const tool of tools) {
    const name = String(tool.name ?? '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    normalized.push({
      name,
      description: String(tool.description ?? ''),
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? structuredClone(tool.inputSchema)
          : { type: 'object', properties: {}, required: [] },
    })
  }
  return normalized
}

function configFingerprint(config: ServerConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

function cleanRequestId(value: unknown): string {
  return String(value ?? '')
    .trim()
    .slice(0, 160)
}

function boundedPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : fallback
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortError(signal.reason)
  let remove = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const listener = () => reject(abortError(signal.reason))
    signal.addEventListener('abort', listener, { once: true })
    remove = () => signal.removeEventListener('abort', listener)
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    remove()
  }
}

function abortError(reason: unknown): Error {
  const error = new Error(
    typeof reason === 'string' && reason ? reason : 'MCP request aborted',
  )
  error.name = 'AbortError'
  return error
}

async function abortableDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

/** An attempt that landed after a disconnect: close what it opened. */
async function dropStale(connection: MCPConnection): Promise<false> {
  connection.setLifecycleListener(null)
  await connection.disconnect().catch(() => {})
  return false
}

async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  errorFactory: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(errorFactory()), milliseconds)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
