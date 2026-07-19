import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../tools/registry'
import { MCPToolAdapter } from './adapter'
import {
  loadMcpConfig,
  loadMcpConfigUnresolved,
  resolveMcpConfig,
  saveMcpConfig,
} from './config'
import {
  buildStdioEnv,
  MCPConnection,
  StdioConnection,
  type MCPCallToolResult,
  type MCPToolDefinition,
} from './connection'
import { MCPClient } from './client'
import { ExecutionEnvironment } from '../environment/snapshot'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

class FakeConnection extends MCPConnection {
  readonly tools: MCPToolDefinition[]
  readonly output: MCPCallToolResult
  connectOk: boolean
  connectCount = 0
  disconnectCount = 0
  called: Array<{ tool: string; args: Record<string, unknown> }> = []

  constructor(
    serverName: string,
    tools: MCPToolDefinition[],
    opts: { connectOk?: boolean; output?: MCPCallToolResult | string } = {},
  ) {
    super(serverName)
    this.tools = tools
    this.connectOk = opts.connectOk ?? true
    this.output =
      typeof opts.output === 'string'
        ? { content: opts.output, isError: false }
        : (opts.output ?? { content: 'ok', isError: false })
  }

  override async connect(): Promise<boolean> {
    this.connectCount += 1
    this.connected = this.connectOk
    return this.connected
  }

  override async disconnect(): Promise<void> {
    this.disconnectCount += 1
    this.connected = false
  }

  override async listTools(): Promise<MCPToolDefinition[]> {
    return this.connected ? this.tools : []
  }

  override async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPCallToolResult> {
    this.called.push({ tool: toolName, args })
    return {
      ...this.output,
      content: `${this.output.content}:${toolName}:${JSON.stringify(args)}`,
    }
  }
}

function executionEnvironment(
  character: string,
  privateEnv: Record<string, string> = {},
): ExecutionEnvironment {
  return new ExecutionEnvironment(
    {
      revision: character.repeat(64),
      catalogRevision: 'a'.repeat(64),
      projectFingerprint: 'b'.repeat(64),
      createdAt: '2026-07-11T02:00:00.000Z',
      platform: 'darwin',
      pathEntries: [`/${character}/bin`],
      env: { PATH: `/${character}/bin`, HOME: '/tmp' },
      toolPaths: {},
    },
    privateEnv,
  )
}

class ReconfigurableConnection extends FakeConnection {
  readonly applied: string[] = []
  private releaseFirst: (() => void) | null = null
  private firstStarted: (() => void) | null = null
  readonly started = new Promise<void>((resolve) => {
    this.firstStarted = resolve
  })

  constructor() {
    super('reconfigurable', [])
  }

  protected override async applyExecutionEnvironment(
    snapshot: ExecutionEnvironment,
  ): Promise<void> {
    this.applied.push(snapshot.revision)
  }

  override async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPCallToolResult> {
    if (toolName === 'first') {
      this.firstStarted?.()
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve
      })
    }
    return await super.callTool(toolName, args)
  }

  release(): void {
    this.releaseFirst?.()
  }
}

describe('MCP config', () => {
  it('loads defaults, deep-merges mcp_config.json, and expands env placeholders', async () => {
    const root = tmp('emperor-mcp-config-')
    writeFileSync(
      join(root, 'mcp_config.json'),
      JSON.stringify({
        defaults: { read_only: true, max_result_chars: 777 },
        servers: {
          alpha: {
            transport: 'stdio',
            command: '${BIN}/server',
            args: ['--token=${TOKEN}', 42],
            env: { API_TOKEN: '${TOKEN}' },
            tool_overrides: { search: { read_only: false } },
          },
          ignored: 'bad',
        },
      }),
      'utf8',
    )

    const cfg = await loadMcpConfig(root, { BIN: '/bin', TOKEN: 'secret' })
    expect(cfg.defaults).toMatchObject({
      read_only: true,
      exclusive: false,
      max_result_chars: 777,
    })
    expect(Object.keys(cfg.servers)).toEqual(['alpha'])
    expect(cfg.servers.alpha!.command).toBe('/bin/server')
    expect(cfg.servers.alpha!.args).toEqual(['--token=secret', '42'])
    expect(cfg.servers.alpha!.env.API_TOKEN).toBe('secret')
    expect(cfg.servers.alpha!.tool_overrides.search).toEqual({
      read_only: false,
    })
  })

  it('keeps legacy partial config valid when servers is omitted', async () => {
    const root = tmp('emperor-mcp-partial-')
    writeFileSync(
      join(root, 'mcp_config.json'),
      JSON.stringify({ defaults: { read_only: true } }),
      'utf8',
    )

    await expect(loadMcpConfig(root)).resolves.toMatchObject({
      servers: {},
      defaults: { read_only: true, exclusive: false },
    })
  })

  it('keeps credential placeholders unresolved in the renderer editing payload', async () => {
    const root = tmp('emperor-mcp-unresolved-editor-')
    writeFileSync(
      join(root, 'mcp_config.json'),
      JSON.stringify({
        servers: {
          remote: {
            transport: 'sse',
            url: 'https://mcp.example.test',
            headers: { Authorization: 'Bearer ${MCP_SECRET_TOKEN}' },
          },
        },
      }),
      'utf8',
    )

    const runtime = await loadMcpConfig(root, {
      MCP_SECRET_TOKEN: 'runtime-secret-value',
    })
    const editor = await loadMcpConfigUnresolved(root)

    expect(runtime.servers.remote?.headers.Authorization).toBe(
      'Bearer runtime-secret-value',
    )
    expect(editor.servers.remote?.headers.Authorization).toBe(
      'Bearer ${MCP_SECRET_TOKEN}',
    )
    expect(JSON.stringify(editor)).not.toContain('runtime-secret-value')
  })

  it('keeps the legacy loader result while exposing its user-layer provenance', async () => {
    const root = tmp('emperor-mcp-config-resolution-')
    writeFileSync(
      join(root, 'mcp_config.json'),
      JSON.stringify({
        defaults: { read_only: true },
        servers: {
          remote: {
            transport: 'sse',
            url: 'https://mcp.example.test',
            headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
          },
        },
      }),
      'utf8',
    )

    const legacy = await loadMcpConfigUnresolved(root)
    const resolved = await resolveMcpConfig(root, {})

    expect(resolved.config).toEqual(legacy)
    expect(resolved.resolution.source).toMatchObject({
      kind: 'user',
      id: 'mcp_config.json',
      trust: 'trusted',
    })
    expect(resolved.resolution.key.secretPaths).toEqual([
      'servers.*.args',
      'servers.*.env',
      'servers.*.headers',
      'servers.*.url',
    ])
  })

  it('validates and writes raw config compatibly', async () => {
    const root = tmp('emperor-mcp-save-')
    await expect(saveMcpConfig(root, { servers: [] })).rejects.toThrow(
      /servers/,
    )
    await saveMcpConfig(root, {
      servers: {},
      defaults: { read_only: true },
    })
    expect(
      JSON.parse(readFileSync(join(root, 'mcp_config.json'), 'utf8')).defaults
        .read_only,
    ).toBe(true)
    expect(statSync(join(root, 'mcp_config.json')).mode & 0o777).toBe(0o600)
  })

  it('isolates truncated JSON and starts with no enabled servers', async () => {
    const root = tmp('emperor-mcp-corrupt-')
    const path = join(root, 'mcp_config.json')
    writeFileSync(path, '{"servers":', 'utf8')

    const config = await loadMcpConfig(root)

    expect(config.servers).toEqual({})
    expect(existsSync(path)).toBe(false)
    const backup = readdirSync(root).find((name) =>
      name.startsWith('mcp_config.json.corrupt-'),
    )
    expect(backup).toBeDefined()
    expect(readFileSync(join(root, backup!), 'utf8')).toBe('{"servers":')
  })

  it('isolates parseable MCP config with an invalid schema', async () => {
    const root = tmp('emperor-mcp-invalid-')
    const path = join(root, 'mcp_config.json')
    writeFileSync(path, JSON.stringify({ servers: [] }), 'utf8')

    await expect(loadMcpConfig(root)).resolves.toMatchObject({ servers: {} })

    expect(existsSync(path)).toBe(false)
    expect(
      readdirSync(root).some((name) =>
        name.startsWith('mcp_config.json.corrupt-'),
      ),
    ).toBe(true)
  })
})

describe('MCP connection env', () => {
  it('keeps only safe inherited env and explicit server env', () => {
    const env = buildStdioEnv(
      { env: { SECRET_TOKEN: 'allowed-by-config', PATH: '/custom/bin' } },
      {
        PATH: '/bin',
        HOME: '/Users/me',
        OPENAI_API_KEY: 'leak',
        LANG: 'en_US.UTF-8',
      },
    )
    expect(env).toEqual({
      PATH: '/custom/bin',
      HOME: '/Users/me',
      LANG: 'en_US.UTF-8',
      SECRET_TOKEN: 'allowed-by-config',
    })
  })

  it('primes stdio connections with the supplied snapshot PATH', () => {
    const snapshot = executionEnvironment('f')
    const connection = new StdioConnection(
      'alpha',
      {
        name: 'alpha',
        transport: 'stdio',
        enabled: true,
        command: '/usr/bin/example',
        args: [],
        env: {},
        url: null,
        headers: {},
        tool_overrides: {},
      },
      { executionEnvironment: snapshot },
    )

    expect(connection.stdioParams(snapshot.env).env).toMatchObject({
      PATH: '/f/bin',
      HOME: '/tmp',
    })
    expect(connection.executionEnvironmentRevision).toBe(snapshot.revision)
  })

  it('re-resolves stdio command and env templates before switching revisions', async () => {
    const initial = executionEnvironment('6', { MCP_BIN: '/old/server' })
    const next = executionEnvironment('7', { MCP_BIN: '/new/server' })
    const baseConfig = {
      name: 'alpha',
      transport: 'stdio',
      enabled: true,
      command: '/old/server',
      args: [],
      env: { MCP_BIN: '/old/server' },
      url: null,
      headers: {},
      tool_overrides: {},
    }
    const connection = new (class extends StdioConnection {
      override async callTool(): Promise<MCPCallToolResult> {
        return {
          content: `${this.config.command}:${this.config.env.MCP_BIN}`,
          isError: false,
        }
      }
    })('alpha', baseConfig, {
      executionEnvironment: initial,
      configResolver: (snapshot) => {
        const value = snapshot.selectEnv(['MCP_BIN']).MCP_BIN
        return value
          ? { ...baseConfig, command: value, env: { MCP_BIN: value } }
          : null
      },
    })

    const result = await connection.callToolWithEnvironment('inspect', {}, next)

    expect(result.content).toBe('/new/server:/new/server')
    expect(connection.executionEnvironmentRevision).toBe(next.revision)
  })
})

describe('MCP adapter/client', () => {
  it('reconnects lazily for a new snapshot without interrupting an active call', async () => {
    const connection = new ReconfigurableConnection()
    await connection.connect()
    const firstEnvironment = executionEnvironment('c')
    const secondEnvironment = executionEnvironment('d')

    const first = connection.callToolWithEnvironment(
      'first',
      {},
      firstEnvironment,
    )
    await connection.started
    const second = connection.callToolWithEnvironment(
      'second',
      {},
      secondEnvironment,
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(connection.applied).toEqual(['c'.repeat(64)])

    connection.release()
    await Promise.all([first, second])
    expect(connection.applied).toEqual(['c'.repeat(64), 'd'.repeat(64)])
    expect(connection.executionEnvironmentRevision).toBe('d'.repeat(64))
  })

  it('wraps tools as emperor Tool instances', async () => {
    const conn = new FakeConnection('alpha', [])
    await conn.connect()
    const adapter = new MCPToolAdapter({
      serverName: 'alpha',
      toolName: 'search',
      description: 'Search docs',
      parametersSchema: { type: 'object', properties: {}, required: [] },
      connection: conn,
      readOnly: true,
      exclusive: false,
      maxResultChars: 50,
    })

    expect(adapter.name).toBe('mcp_alpha_search')
    expect(adapter.description).toBe('[MCP:alpha] Search docs')
    expect(adapter.readOnly).toBe(true)
    expect(await adapter.execute({ q: 'hello' })).toMatchObject({
      isError: false,
      metadata: {
        mcp: true,
        untrusted: true,
        server: 'alpha',
        tool: 'mcp_alpha_search',
        mcp_tool: 'search',
      },
    })
    expect(conn.called).toEqual([{ tool: 'search', args: { q: 'hello' } }])
  })

  it('passes the task abort signal through the MCP adapter', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const conn = new (class extends FakeConnection {
      override async callTool(
        toolName: string,
        args: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<MCPCallToolResult> {
        observedSignal = signal
        return await super.callTool(toolName, args)
      }
    })('alpha', [])
    await conn.connect()
    const adapter = new MCPToolAdapter({
      serverName: 'alpha',
      toolName: 'search',
      description: 'Search docs',
      parametersSchema: { type: 'object', properties: {}, required: [] },
      connection: conn,
    })

    await adapter.execute(
      { q: 'abortable' },
      {
        root: tmp('emperor-mcp-signal-'),
        arguments: {},
        signal: controller.signal,
      },
    )
    expect(observedSignal).toBe(controller.signal)
  })

  it('marks MCP protocol errors as failed untrusted tool results', async () => {
    const conn = new FakeConnection('alpha', [], {
      output: { content: 'remote failed', isError: true },
    })
    await conn.connect()
    const adapter = new MCPToolAdapter({
      serverName: 'alpha',
      toolName: 'search',
      description: 'Search docs',
      parametersSchema: { type: 'object', properties: {}, required: [] },
      connection: conn,
      readOnly: true,
      exclusive: false,
    })
    const registry = new ToolRegistry()
    registry.register(adapter)

    const result = await registry.executeResult('mcp_alpha_search', { q: 'x' })

    expect(result.isError).toBe(true)
    expect(result.metadata).toMatchObject({
      mcp: true,
      untrusted: true,
      server: 'alpha',
      tool: 'mcp_alpha_search',
      mcp_tool: 'search',
    })
    expect(result.modelContent).toContain('不可信输入')
    expect(result.modelContent).toContain('remote failed:search')
  })

  it('initializes enabled servers, ignores failures, applies overrides, and registers tools', async () => {
    const root = tmp('emperor-mcp-client-')
    writeFileSync(
      join(root, 'mcp_config.json'),
      JSON.stringify({
        defaults: { read_only: true, exclusive: false, max_result_chars: 123 },
        servers: {
          alpha: {
            enabled: true,
            transport: 'stdio',
            command: '${EMPEROR_MCP_SNAPSHOT_ONLY_6E4D}',
            tool_overrides: {
              search: {
                read_only: false,
                exclusive: true,
                max_result_chars: 456,
              },
            },
          },
          beta: { enabled: true, transport: 'sse' },
          off: { enabled: false, transport: 'stdio' },
        },
      }),
      'utf8',
    )
    const conns: Record<string, FakeConnection> = {
      alpha: new FakeConnection('alpha', [
        {
          name: 'search',
          description: 'Search',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ]),
      beta: new FakeConnection(
        'beta',
        [
          {
            name: 'lookup',
            description: 'Lookup',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
        ],
        { connectOk: false },
      ),
      off: new FakeConnection('off', [
        {
          name: 'disabled',
          description: '',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ]),
    }
    const initialEnvironment = executionEnvironment('e', {
      EMPEROR_MCP_SNAPSHOT_ONLY_6E4D: '/snapshot/mcp-server',
    })
    const factoryEnvironments: Array<ExecutionEnvironment | null | undefined> =
      []
    const factoryCommands: Array<string | null> = []
    const client = new MCPClient(root, {
      connectionFactory: (cfg, environment) => {
        factoryEnvironments.push(environment)
        factoryCommands.push(cfg.command)
        return conns[cfg.name]!
      },
    })

    await client.initialize(initialEnvironment)
    const tools = client.getTools()
    expect(tools.map((tool) => tool.name)).toEqual(['mcp_alpha_search'])
    expect(tools[0]!.readOnly).toBe(false)
    expect(tools[0]!.exclusive).toBe(true)
    expect(tools[0]!.maxResultChars).toBe(456)
    expect(client.getConnection('beta')?.connected).toBe(false)
    expect(factoryEnvironments).toEqual([
      initialEnvironment,
      initialEnvironment,
    ])
    expect(factoryCommands).toEqual(['/snapshot/mcp-server', null])

    const registry = new ToolRegistry()
    client.registerTools(registry)
    expect(registry.has('mcp_alpha_search')).toBe(true)
    expect(await registry.execute('mcp_alpha_search', { q: 'x' })).toContain(
      'ok:search',
    )

    await client.close()
    expect(client.getTools()).toEqual([])
  })

  it('preserves a healthy generation for an unchanged config and replaces only the changed server', async () => {
    const root = tmp('emperor-mcp-reload-')
    const configPath = join(root, 'mcp_config.json')
    const writeConfig = (command: string) =>
      writeFileSync(
        configPath,
        JSON.stringify({
          servers: {
            alpha: { enabled: true, transport: 'stdio', command },
          },
        }),
        'utf8',
      )
    writeConfig('/bin/one')
    const created: FakeConnection[] = []
    const client = new MCPClient(root, {
      connectionFactory: (cfg) => {
        const connection = new FakeConnection(
          cfg.name,
          [
            {
              name: 'search',
              description: 'Search',
              inputSchema: { type: 'object', properties: {}, required: [] },
            },
          ],
          { output: String(cfg.command) },
        )
        created.push(connection)
        return connection
      },
      supervisor: {
        clientIdFactory: (generation) => `reload_client_${generation}`,
      },
    })

    await client.initialize()
    expect(client.snapshot()).toMatchObject({
      configured: 1,
      ready: 1,
      tools: 1,
      servers: [
        {
          serverName: 'alpha',
          generation: 1,
          clientId: 'reload_client_1',
          state: 'ready',
        },
      ],
    })

    await client.reload()
    expect(created).toHaveLength(1)
    expect(created[0]!.disconnectCount).toBe(0)

    writeConfig('/bin/two')
    await client.reload()
    expect(created).toHaveLength(2)
    expect(created[0]!.connected).toBe(false)
    expect(created[1]!.connected).toBe(true)
    expect(client.snapshot().servers[0]).toMatchObject({
      generation: 2,
      clientId: 'reload_client_2',
      state: 'ready',
    })
    expect(await client.getTools()[0]!.execute({ q: 'new' })).toMatchObject({
      rawContent: expect.stringContaining('/bin/two:search'),
    })
  })

  it('creates a replacement with the latest execution environment rather than a captured startup snapshot', async () => {
    const root = tmp('emperor-mcp-environment-reload-')
    writeFileSync(
      join(root, 'mcp_config.json'),
      JSON.stringify({
        servers: {
          alpha: {
            enabled: true,
            transport: 'stdio',
            command: '${MCP_BIN}',
          },
        },
      }),
      'utf8',
    )
    const initial = executionEnvironment('8', { MCP_BIN: '/bin/old-mcp' })
    const next = executionEnvironment('9', { MCP_BIN: '/bin/new-mcp' })
    const observed: Array<{ command: string | null; revision: string | null }> =
      []
    const client = new MCPClient(root, {
      connectionFactory: (cfg, environment) => {
        observed.push({
          command: cfg.command,
          revision: environment?.revision ?? null,
        })
        return new FakeConnection(cfg.name, [])
      },
    })

    await client.initialize(initial)
    await client.reload(next)
    await client.reload(next)

    expect(observed).toEqual([
      { command: '/bin/old-mcp', revision: initial.revision },
      { command: '/bin/new-mcp', revision: next.revision },
    ])
    expect(client.snapshot().servers[0]?.generation).toBe(2)
  })

  it('stores the exact large MCP result as an artifact while bounding model content', async () => {
    const root = tmp('emperor-mcp-large-result-')
    const full = 'large-result-'.repeat(2_000)
    const connection = new FakeConnection('alpha', [], { output: full })
    await connection.connect()
    const adapter = new MCPToolAdapter({
      serverName: 'alpha',
      toolName: 'dump',
      description: 'Dump a large result',
      parametersSchema: { type: 'object', properties: {}, required: [] },
      connection,
      maxResultChars: 1_000,
    })
    const registry = new ToolRegistry(root)
    registry.register(adapter)

    const result = await registry.executeResult(
      adapter.name,
      {},
      {
        root,
        turnId: 'turn_large_mcp',
        parentCallId: 'call_large_mcp',
      },
    )

    expect(result.modelContent.length).toBeLessThanOrEqual(1_000)
    expect(result.modelContent).toContain('[truncated')
    const ref = String(result.metadata.full_output_ref ?? '')
    expect(ref).toMatch(/^memory\/tool-results\/[a-f0-9]+\.txt$/)
    expect(readFileSync(join(root, ref), 'utf8')).toBe(`${full}:dump:{}`)
  })
})
