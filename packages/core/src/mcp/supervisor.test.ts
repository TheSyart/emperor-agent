import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerConfig } from './config'
import {
  MCPConnection,
  MCPConnectionError,
  type MCPCallToolResult,
  type MCPConnectionLifecycleEvent,
  type MCPToolDefinition,
} from './connection'
import {
  MCPConnectionSupervisor,
  classifyMcpConnectionError,
  type MCPClientIdentity,
} from './supervisor'

function config(command = '/bin/mcp'): ServerConfig {
  return {
    name: 'alpha',
    transport: 'stdio',
    enabled: true,
    command,
    args: [],
    env: {},
    url: null,
    headers: {},
    tool_overrides: {},
  }
}

class ControlledConnection extends MCPConnection {
  readonly tools: MCPToolDefinition[]
  connectResult: boolean | Error = true
  connectCount = 0
  disconnectCount = 0
  callCount = 0
  listError: Error | null = null
  private disconnectGate: Promise<void> | null = null
  private releaseDisconnect: (() => void) | null = null
  private connectGate: Promise<void> | null = null
  private releaseConnect: (() => void) | null = null
  private callImpl:
    ((signal?: AbortSignal) => Promise<MCPCallToolResult>) | null = null

  constructor(
    readonly label: string,
    tools: MCPToolDefinition[] = [
      {
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
    ],
  ) {
    super('alpha')
    this.tools = tools
  }

  override async connect(): Promise<boolean> {
    this.connectCount += 1
    await this.connectGate
    if (this.connectResult instanceof Error) throw this.connectResult
    this.connected = this.connectResult
    return this.connected
  }

  override async disconnect(): Promise<void> {
    this.disconnectCount += 1
    await this.disconnectGate
    this.connected = false
  }

  override async listTools(): Promise<MCPToolDefinition[]> {
    if (this.listError) throw this.listError
    return this.tools
  }

  override async callTool(
    toolName: string,
    _args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPCallToolResult> {
    this.callCount += 1
    if (this.callImpl) return await this.callImpl(signal)
    return { content: `${this.label}:${toolName}`, isError: false }
  }

  holdDisconnect(): void {
    this.disconnectGate = new Promise<void>((resolve) => {
      this.releaseDisconnect = resolve
    })
  }

  holdConnect(): void {
    this.connectGate = new Promise<void>((resolve) => {
      this.releaseConnect = resolve
    })
  }

  releaseHeldConnect(): void {
    this.releaseConnect?.()
  }

  releaseHeldDisconnect(): void {
    this.releaseDisconnect?.()
  }

  pendingCall(): void {
    this.callImpl = async (signal) =>
      await new Promise<MCPCallToolResult>((_resolve, reject) => {
        const abort = () => {
          const error = new Error('remote elicitation aborted')
          error.name = 'AbortError'
          reject(error)
        }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
  }

  report(event: MCPConnectionLifecycleEvent): void {
    this.reportLifecycle(event)
  }
}

describe('MCPConnectionSupervisor', () => {
  it('installs a replacement before closing the old client and ignores stale liveness events', async () => {
    const oldConnection = new ControlledConnection('old')
    const replacement = new ControlledConnection('new')
    oldConnection.holdDisconnect()
    const identities: MCPClientIdentity[] = []
    const queue = [oldConnection, replacement]
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config('/bin/old'),
      connectionFactory: (_server, identity) => {
        identities.push(identity)
        return queue.shift()!
      },
      clientIdFactory: (generation) => `client_${generation}`,
    })

    await expect(supervisor.connect()).resolves.toBe(true)
    const replacing = supervisor.reconfigure(config('/bin/new'))
    await replacementConnected(replacement, supervisor)

    expect(supervisor.snapshot()).toMatchObject({
      generation: 2,
      clientId: 'client_2',
      state: 'ready',
      health: 'healthy',
      toolCount: 1,
    })
    oldConnection.report({ type: 'closed', reason: 'late old close' })
    expect(supervisor.snapshot()).toMatchObject({
      generation: 2,
      clientId: 'client_2',
      state: 'ready',
    })

    oldConnection.releaseHeldDisconnect()
    await replacing
    expect(identities.map((item) => item.generation)).toEqual([1, 2])
    await expect(supervisor.callTool('search', {})).resolves.toMatchObject({
      content: 'new:search',
      generation: 2,
      clientId: 'client_2',
    })
  })

  it('singleflights concurrent restarts and applies the bounded 1/4/16 backoff schedule', async () => {
    const delays: number[] = []
    const connections = Array.from({ length: 4 }, (_, index) => {
      const connection = new ControlledConnection(`failed_${index}`)
      connection.connectResult = false
      return connection
    })
    let created = 0
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config(),
      connectionFactory: () => connections[created++]!,
      sleep: async (ms) => {
        delays.push(ms)
      },
      maxRestartAttempts: 3,
      random: () => 0.5, // no jitter
    })

    await expect(supervisor.connect()).resolves.toBe(false)
    await Promise.all([
      supervisor.restart('transport_closed'),
      supervisor.restart('transport_closed'),
      supervisor.restart('transport_closed'),
    ])
    await supervisor.restart('transport_closed')
    await supervisor.restart('transport_closed')

    expect(delays).toEqual([1_000, 4_000, 16_000])
    expect(created).toBe(4)
    await expect(supervisor.restart('transport_closed')).resolves.toBe(false)
    expect(created).toBe(4)
    expect(supervisor.snapshot()).toMatchObject({
      state: 'failed',
      restartAttempts: 3,
      lastError: { code: 'mcp_restart_exhausted' },
    })
  })

  it('does not automatically retry authentication failures', async () => {
    const connection = new ControlledConnection('auth')
    connection.connectResult = new MCPConnectionError(
      'mcp_auth_failed',
      'authentication rejected',
    )
    let created = 0
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config(),
      connectionFactory: () => {
        created += 1
        return connection
      },
      sleep: async () => {
        throw new Error('auth failures must not back off and retry')
      },
    })

    await expect(supervisor.connect()).resolves.toBe(false)
    await expect(supervisor.restart('automatic')).resolves.toBe(false)
    expect(created).toBe(1)
    expect(supervisor.snapshot()).toMatchObject({
      state: 'auth_failed',
      auth: 'failed',
      lastError: { code: 'mcp_auth_failed' },
    })
  })

  it('does not publish a ready empty snapshot when tool discovery fails', async () => {
    const connection = new ControlledConnection('bad-tools')
    connection.listError = new Error('invalid listTools response')
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config(),
      connectionFactory: () => connection,
    })

    await expect(supervisor.connect()).resolves.toBe(false)
    expect(supervisor.snapshot()).toMatchObject({
      state: 'failed',
      health: 'unhealthy',
      toolCount: 0,
      lastError: { code: 'mcp_protocol_error' },
    })
    expect(connection.connected).toBe(false)
  })

  it('keeps a healthy current generation when a replacement fails authentication and redacts its error', async () => {
    const current = new ControlledConnection('current')
    const rejected = new ControlledConnection('rejected')
    rejected.connectResult = new MCPConnectionError(
      'mcp_auth_failed',
      'secret-token-value was rejected',
    )
    const queue = [current, rejected]
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config('/bin/current'),
      connectionFactory: () => queue.shift()!,
      clientIdFactory: (generation) => `preserved_${generation}`,
    })
    await supervisor.connect()

    await expect(
      supervisor.reconfigure(config('/bin/replacement')),
    ).resolves.toBe(false)

    expect(supervisor.snapshot()).toMatchObject({
      generation: 1,
      clientId: 'preserved_1',
      state: 'ready',
      health: 'healthy',
      auth: 'ok',
      lastError: {
        code: 'mcp_auth_failed',
        message: 'MCP server authentication failed',
      },
    })
    expect(JSON.stringify(supervisor.snapshot())).not.toContain(
      'secret-token-value',
    )
    await expect(supervisor.callTool('search', {})).resolves.toMatchObject({
      content: 'current:search',
      generation: 1,
    })
  })

  it('aborts an in-flight elicitation with its request ID and leaves no active request', async () => {
    const connection = new ControlledConnection('pending')
    connection.pendingCall()
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config(),
      connectionFactory: () => connection,
    })
    await supervisor.connect()
    const controller = new AbortController()
    const call = supervisor.callToolRequest(
      'ask_user',
      {},
      {
        requestId: 'mcp_req_abort',
        signal: controller.signal,
        timeoutMs: 10_000,
      },
    )

    controller.abort('user cancelled')

    await expect(call).rejects.toMatchObject({ code: 'mcp_aborted' })
    expect(supervisor.snapshot()).toMatchObject({ activeRequestCount: 0 })
  })

  it('times out a transport call without retrying the possibly mutating tool call', async () => {
    const connection = new ControlledConnection('timeout')
    connection.pendingCall()
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config(),
      connectionFactory: () => connection,
    })
    await supervisor.connect()

    await expect(
      supervisor.callToolRequest(
        'mutate',
        {},
        {
          requestId: 'mcp_req_timeout',
          timeoutMs: 5,
        },
      ),
    ).rejects.toMatchObject({ code: 'mcp_transport_timeout' })
    expect(connection.callCount).toBe(1)
    expect(supervisor.snapshot()).toMatchObject({
      state: 'degraded',
      health: 'unhealthy',
      activeRequestCount: 0,
    })
  })

  it('bounds connection establishment and cleans up a client that connects after the deadline', async () => {
    const connection = new ControlledConnection('late-connect')
    connection.holdConnect()
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config(),
      connectionFactory: () => connection,
      connectTimeoutMs: 5,
    })

    await expect(supervisor.connect()).resolves.toBe(false)
    expect(supervisor.snapshot()).toMatchObject({
      state: 'failed',
      health: 'unhealthy',
      lastError: { code: 'mcp_transport_timeout' },
    })

    connection.releaseHeldConnect()
    for (
      let index = 0;
      index < 20 && connection.disconnectCount < 2;
      index += 1
    )
      await Promise.resolve()
    await Promise.resolve()
    expect(connection.connected).toBe(false)
    expect(connection.disconnectCount).toBeGreaterThanOrEqual(2)
  })
})

async function replacementConnected(
  connection: ControlledConnection,
  supervisor: MCPConnectionSupervisor,
): Promise<void> {
  for (
    let index = 0;
    index < 20 && supervisor.snapshot().generation < 2;
    index += 1
  )
    await Promise.resolve()
  expect(connection.connectCount).toBe(1)
  expect(supervisor.snapshot().generation).toBe(2)
}

describe('MCPConnectionSupervisor health and backoff (KRN-04)', () => {
  it('5 · a late response with an unknown id leaves the connection healthy', async () => {
    const connection = new ControlledConnection('live')
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config(),
      connectionFactory: () => connection,
      sleep: async () => {},
    })
    await expect(supervisor.connect()).resolves.toBe(true)
    connection.report({
      type: 'error',
      error: new Error(
        'Received a response for an unknown message ID: {"jsonrpc":"2.0","id":41,"result":{}}',
      ),
    })
    await Promise.resolve()
    expect(supervisor.snapshot()).toMatchObject({
      state: 'ready',
      health: 'healthy',
      auth: 'ok',
    })
  })

  it('6 · only an HTTP 401 or 403 status means the server rejected the credentials', () => {
    const body = new Error(
      'tool failed: upstream said "403 Forbidden" in its body',
    )
    expect(
      classifyMcpConnectionError(body, 'mcp_connection_failed').code,
    ).not.toBe('mcp_auth_failed')
    const forbidden = Object.assign(new Error('Error POSTing to endpoint'), {
      code: 403,
    })
    expect(
      classifyMcpConnectionError(forbidden, 'mcp_connection_failed').code,
    ).toBe('mcp_auth_failed')
    const unauthorized = Object.assign(new Error('Unauthorized'), {
      name: 'UnauthorizedError',
    })
    expect(
      classifyMcpConnectionError(unauthorized, 'mcp_connection_failed').code,
    ).toBe('mcp_auth_failed')
  })

  it('7 · a server that exits at once fails after six attempts with jittered 1/4/16/60 s backoff', async () => {
    const delays: number[] = []
    let created = 0
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config(),
      connectionFactory: () => {
        created += 1
        const connection = new ControlledConnection(`exits_${created}`)
        connection.connectResult = false
        return connection
      },
      sleep: async (ms) => {
        delays.push(ms)
      },
      random: () => 0, // the low end of ±20%
    })
    await expect(supervisor.connect()).resolves.toBe(false)
    for (let index = 0; index < 8; index++) await supervisor.restart('liveness')
    expect(created).toBe(6)
    expect(delays).toEqual([800, 3_200, 12_800, 48_000, 48_000])
    expect(supervisor.snapshot()).toMatchObject({
      state: 'failed',
      lastError: { code: 'mcp_restart_exhausted' },
    })
  })

  it('resets the restart budget only after 60 s of stable running', async () => {
    const delays: number[] = []
    let clock = 0
    const connections: ControlledConnection[] = []
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config(),
      connectionFactory: () => {
        const connection = new ControlledConnection(`c${connections.length}`)
        connections.push(connection)
        return connection
      },
      sleep: async (ms) => {
        delays.push(ms)
      },
      now: () => clock,
      random: () => 0.5, // no jitter
    })
    await supervisor.connect()
    clock = 1_000
    await supervisor.restart('liveness')
    clock = 2_000
    await supervisor.restart('liveness')
    clock = 80_000
    await supervisor.restart('liveness')
    expect(delays).toEqual([1_000, 4_000, 1_000])
  })

  describe('timeouts', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('4 · a connect that never answers times out after 15 s by default', async () => {
      vi.useFakeTimers()
      const connection = new ControlledConnection('stuck')
      connection.holdConnect()
      const supervisor = new MCPConnectionSupervisor({
        serverName: 'alpha',
        config: config(),
        connectionFactory: () => connection,
      })
      let result: boolean | null = null
      void supervisor.connect().then((value) => {
        result = value
      })
      await vi.advanceTimersByTimeAsync(14_999)
      expect(result).toBeNull()
      expect(supervisor.snapshot().state).toBe('connecting')
      await vi.advanceTimersByTimeAsync(1)
      expect(result).toBe(false)
      expect(supervisor.snapshot()).toMatchObject({
        state: 'failed',
        lastError: { code: 'mcp_transport_timeout' },
      })
    })

    it('4 · a tool list that never arrives times out after 15 s by default', async () => {
      vi.useFakeTimers()
      const connection = new ControlledConnection('quiet')
      connection.listTools = () => new Promise<never>(() => {})
      const supervisor = new MCPConnectionSupervisor({
        serverName: 'alpha',
        config: config(),
        connectionFactory: () => connection,
      })
      let result: boolean | null = null
      void supervisor.connect().then((value) => {
        result = value
      })
      await vi.advanceTimersByTimeAsync(14_999)
      expect(result).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(result).toBe(false)
      expect(supervisor.snapshot()).toMatchObject({
        state: 'failed',
        lastError: { code: 'mcp_transport_timeout' },
      })
      expect(connection.disconnectCount).toBeGreaterThan(0)
    })
  })

  it('9 · a disconnect during a connect closes the new connection when it lands', async () => {
    const connection = new ControlledConnection('late')
    connection.holdConnect()
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config(),
      connectionFactory: () => connection,
    })
    const connecting = supervisor.connect()
    await Promise.resolve()
    await supervisor.disconnect()
    connection.releaseHeldConnect()
    await expect(connecting).resolves.toBe(false)
    expect(connection.connected).toBe(false)
    expect(supervisor.snapshot()).toMatchObject({ state: 'stopped' })
    expect(await supervisor.listTools()).toEqual([])
  })

  it('a reconfigure during a connect for the old config installs the new config', async () => {
    const created: ControlledConnection[] = []
    const supervisor = new MCPConnectionSupervisor({
      serverName: 'alpha',
      config: config('/bin/old'),
      connectionFactory: (candidate) => {
        const connection = new ControlledConnection(String(candidate.command))
        if (!created.length) connection.holdConnect()
        created.push(connection)
        return connection
      },
    })
    const first = supervisor.connect()
    await Promise.resolve()
    const second = supervisor.reconfigure(config('/bin/new'))
    created[0]!.releaseHeldConnect()
    await first
    await expect(second).resolves.toBe(true)
    expect(created.map((connection) => connection.label)).toEqual([
      '/bin/old',
      '/bin/new',
    ])
    expect(created[0]!.connected).toBe(false)
    expect(supervisor.snapshot()).toMatchObject({
      state: 'ready',
      generation: 2,
    })
  })
})
