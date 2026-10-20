// KRN-04 (PLAN-V020, findings CORE-9 / CORE-12 / CORE-39): the client starts
// its servers in the background, in parallel and four at a time, so one
// server that never answers holds up neither the window nor the others; a
// reload is single-flight (concurrent reloads end on the last config); a
// disconnect during a connect leaves no child process behind; and the tools
// of the user's own servers get names a model API accepts.
import {
  realpathSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OsSandboxController } from '../environment/sandbox'
import { OwnedProcessRuntime } from '../processes/runtime'
import { HarnessHost } from '../harness/host/host'
import type { SandboxBackend } from '../harness/sandbox/backend'
import { MCPClient } from './client'
import {
  MCPConnection,
  type MCPCallToolResult,
  type MCPToolDefinition,
} from './connection'
import { userMcpToolName } from './plugin-names'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeServers(root: string, servers: Record<string, unknown>): void {
  writeFileSync(join(root, 'mcp_config.json'), JSON.stringify({ servers }))
}

const stdio = (command: string) => ({
  enabled: true,
  transport: 'stdio',
  command,
})

const tool = (name: string): MCPToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {}, required: [] },
})

/** A connection whose connect waits for `release()` (or forever). */
class GatedConnection extends MCPConnection {
  readonly calls: string[] = []
  disconnects = 0
  private open: (() => void) | null = null
  private readonly gate: Promise<void>

  constructor(
    serverName: string,
    private readonly toolList: MCPToolDefinition[],
    opened = false,
  ) {
    super(serverName)
    this.gate = opened
      ? Promise.resolve()
      : new Promise((resolve) => {
          this.open = resolve
        })
  }

  release(): void {
    this.open?.()
  }

  override async connect(): Promise<boolean> {
    await this.gate
    this.connected = true
    return true
  }

  override async disconnect(): Promise<void> {
    this.disconnects += 1
    this.connected = false
  }

  override async listTools(): Promise<MCPToolDefinition[]> {
    return this.toolList
  }

  override async callTool(name: string): Promise<MCPCallToolResult> {
    this.calls.push(name)
    return { content: `called ${name}`, isError: false }
  }
}

/** A connection that connects but never answers tools/list. */
class SilentListConnection extends GatedConnection {
  constructor(serverName: string) {
    super(serverName, [], true)
  }

  override async listTools(): Promise<MCPToolDefinition[]> {
    return await new Promise<never>(() => {})
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('MCP client startup (KRN-04)', () => {
  it('4 · one of three servers never answers: the other two are ready at once, it times out on its own', async () => {
    // The 15 s default is pinned in supervisor.test.ts (fake clock); here a
    // short timeout keeps the test fast with real file reads.
    const root = tmp('emperor-krn04-start-')
    writeServers(root, {
      alpha: stdio('/bin/alpha'),
      stuck: stdio('/bin/stuck'),
      gamma: stdio('/bin/gamma'),
    })
    const toolsChanged: string[][] = []
    const client = new MCPClient(root, {
      connectionFactory: (config) =>
        new GatedConnection(
          config.name,
          [tool('search')],
          config.name !== 'stuck',
        ),
      supervisor: { connectTimeoutMs: 1500 },
    })
    client.onToolsChanged(() =>
      toolsChanged.push(client.getTools().map((item) => item.name)),
    )
    cleanups.push(() => client.close())

    let settled = false
    const reload = client.reload().then(() => {
      settled = true
    })
    await waitFor(() => client.getTools().length === 2)
    expect(settled).toBe(false)
    expect(
      client
        .getTools()
        .map((item) => item.name)
        .sort(),
    ).toEqual(['mcp_alpha_search', 'mcp_gamma_search'])
    expect(toolsChanged.length).toBeGreaterThan(0)
    const stuck = () =>
      client.snapshot().servers.find((server) => server.serverName === 'stuck')
    expect(stuck()?.state).toBe('connecting')
    const alphaTool = client
      .getTools()
      .find((item) => item.name === 'mcp_alpha_search')!
    expect((await alphaTool.execute({})).rawContent).toContain('called search')

    await reload
    expect(stuck()).toMatchObject({
      state: 'failed',
      lastError: { code: 'mcp_transport_timeout' },
    })
    expect(client.snapshot().ready).toBe(2)
  })

  it('4 · a server that connects but never lists its tools times out too', async () => {
    const root = tmp('emperor-krn04-list-')
    writeServers(root, { quiet: stdio('/bin/quiet'), alpha: stdio('/bin/a') })
    const client = new MCPClient(root, {
      connectionFactory: (config) =>
        config.name === 'quiet'
          ? new SilentListConnection(config.name)
          : new GatedConnection(config.name, [tool('search')], true),
      supervisor: { listToolsTimeoutMs: 300 },
    })
    cleanups.push(() => client.close())
    await client.reload()
    const quiet = client
      .snapshot()
      .servers.find((server) => server.serverName === 'quiet')
    expect(quiet).toMatchObject({
      state: 'failed',
      lastError: { code: 'mcp_transport_timeout' },
    })
    expect(client.getTools().map((item) => item.name)).toEqual([
      'mcp_alpha_search',
    ])
  })

  it('connects at most four servers at a time', async () => {
    const root = tmp('emperor-krn04-pool-')
    const names = ['s1', 's2', 's3', 's4', 's5', 's6']
    writeServers(
      root,
      Object.fromEntries(names.map((name) => [name, stdio(`/bin/${name}`)])),
    )
    const connections = new Map<string, GatedConnection>()
    const client = new MCPClient(root, {
      connectionFactory: (config) => {
        const connection = new GatedConnection(config.name, [tool('t')])
        connections.set(config.name, connection)
        return connection
      },
    })
    cleanups.push(() => client.close())
    const reload = client.reload()
    await waitFor(() => connections.size === 4)
    await flush()
    expect(connections.size).toBe(4)
    for (const connection of connections.values()) connection.release()
    await waitFor(() => connections.size === 6)
    for (const connection of connections.values()) connection.release()
    await reload
    expect(client.snapshot().ready).toBe(6)
  })

  it('4 · the host starts without waiting for a server that never answers', async () => {
    const hung: Server = createServer(() => {
      // Accept the request and never answer it.
    })
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          hung.closeAllConnections()
          hung.close(() => resolve())
        }),
    )
    const port = (hung.address() as AddressInfo).port
    const root = tmp('emperor-krn04-host-')
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    writeServers(home, {
      hung: {
        enabled: true,
        transport: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
      },
    })
    const passthrough: SandboxBackend = {
      confine: (argv) => ({
        argv: [...argv],
        enforcement: 'full',
        denialSignatures: ['operation not permitted'],
        runnerFailureRules: [],
      }),
    }
    const started = Date.now()
    const host = await HarnessHost.create({
      root,
      stateRoot: home,
      stateRootSource: 'explicit',
      emperorHomePrepared: false,
      sandboxBackend: passthrough,
      startScheduler: false,
      watchSkills: false,
    })
    cleanups.push(() => host.close())
    expect(Date.now() - started).toBeLessThan(10_000)
    await waitFor(() =>
      host.kept.mcpClient
        .snapshot()
        .servers.some(
          (server) =>
            server.serverName === 'hung' && server.state === 'connecting',
        ),
    )
  }, 30_000)
})

describe('MCP client reload (KRN-04)', () => {
  it('8 · three concurrent reloads end on the last config', async () => {
    const root = tmp('emperor-krn04-reload-')
    writeServers(root, { alpha: stdio('/bin/first') })
    const commands: string[] = []
    const gates: GatedConnection[] = []
    const client = new MCPClient(root, {
      connectionFactory: (config) => {
        commands.push(String(config.command))
        const connection = new GatedConnection(config.name, [
          tool(String(config.command).replace('/bin/', '')),
        ])
        gates.push(connection)
        return connection
      },
    })
    cleanups.push(() => client.close())

    const first = client.reload()
    await waitFor(() => gates.length === 1)
    writeServers(root, { alpha: stdio('/bin/second') })
    const second = client.reload()
    writeServers(root, { alpha: stdio('/bin/third') })
    const third = client.reload()
    gates[0]!.release()
    await waitFor(() => gates.length === 2)
    gates[1]!.release()
    await Promise.all([first, second, third])

    // The two queued reloads ran once, on the config they were last asked for.
    expect(commands).toEqual(['/bin/first', '/bin/third'])
    expect(client.getTools().map((item) => item.name)).toEqual([
      'mcp_alpha_third',
    ])
    expect(client.snapshot().servers).toMatchObject([
      { serverName: 'alpha', state: 'ready', generation: 2 },
    ])
  })

  it('a reload asked for while one runs is not lost', async () => {
    const root = tmp('emperor-krn04-queue-')
    writeServers(root, {})
    const client = new MCPClient(root, {
      connectionFactory: (config) =>
        new GatedConnection(config.name, [tool('search')], true),
    })
    cleanups.push(() => client.close())
    const first = client.reload()
    writeServers(root, { added: stdio('/bin/added') })
    await Promise.all([first, client.reload()])
    expect(client.getTools().map((item) => item.name)).toEqual([
      'mcp_added_search',
    ])
  })

  it('a server removed while it connects is closed when the connect lands', async () => {
    const root = tmp('emperor-krn04-removed-')
    writeServers(root, { slow: stdio('/bin/slow') })
    const gates: GatedConnection[] = []
    const client = new MCPClient(root, {
      connectionFactory: (config) => {
        const connection = new GatedConnection(config.name, [tool('t')])
        gates.push(connection)
        return connection
      },
    })
    cleanups.push(() => client.close())
    const first = client.reload()
    await waitFor(() => gates.length === 1)
    await client.close()
    gates[0]!.release()
    await first
    await flush()
    expect(gates[0]!.disconnects).toBeGreaterThan(0)
    expect(gates[0]!.connected).toBe(false)
    expect(client.getTools()).toEqual([])
    expect(client.snapshot().servers).toEqual([])
  })

  it.runIf(process.platform === 'darwin')(
    '9 · disconnecting during a reload leaves no child process (process table)',
    async () => {
      const stateRoot = tmp('emperor-krn04-orphan-')
      const workspace = join(stateRoot, 'workspace')
      mkdirSync(workspace, { recursive: true })
      const serverDir = tmp('emperor-krn04-server-')
      writeFileSync(join(serverDir, 'server.js'), SLOW_SERVER)
      writeServers(stateRoot, {
        slow: {
          enabled: true,
          transport: 'stdio',
          command: process.execPath,
          args: [join(serverDir, 'server.js')],
        },
      })
      const runtime = new OwnedProcessRuntime(stateRoot, {
        sandbox: new OsSandboxController({}),
      })
      const client = new MCPClient(stateRoot, {
        processRuntime: runtime,
        workspaceRoot: workspace,
      })
      cleanups.push(() => client.close())

      const reload = client.reload()
      await waitFor(() => runtime.list({ activeOnly: true }).length === 1)
      const pid = runtime.list({ activeOnly: true })[0]!.pid
      expect(pid).toBeGreaterThan(0)
      await client.close()
      await reload
      // The server answers initialize after 600 ms; give it time to land.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(runtime.list({ activeOnly: true })).toEqual([])
      expect(alive(pid!)).toBe(false)
      expect(client.getTools()).toEqual([])
    },
    20_000,
  )
})

describe('tool names of the user’s servers (KRN-04)', () => {
  const VALID = /^[a-zA-Z0-9_-]{1,64}$/

  it('10 · a server named my.server gets a valid tool name that calls the tool', async () => {
    const root = tmp('emperor-krn04-names-')
    writeServers(root, { 'my.server': stdio('/bin/my') })
    const connections: GatedConnection[] = []
    const client = new MCPClient(root, {
      connectionFactory: (config) => {
        const connection = new GatedConnection(
          config.name,
          [tool('search.files')],
          true,
        )
        connections.push(connection)
        return connection
      },
    })
    cleanups.push(() => client.close())
    await client.reload()
    const [registered] = client.getTools()
    expect(registered!.name).toBe('mcp_my_server_search_files')
    expect(registered!.name).toMatch(VALID)
    expect(registered!.mcpServerName).toBe('my.server')
    expect(registered!.mcpToolName).toBe('search.files')
    expect((await registered!.execute({})).rawContent).toContain(
      'called search.files',
    )
    expect(connections[0]!.calls).toEqual(['search.files'])
  })

  it('keeps names that were already valid', () => {
    expect(userMcpToolName('alpha', 'search')).toBe('mcp_alpha_search')
    expect(userMcpToolName('my-server_2', 'read_file')).toBe(
      'mcp_my-server_2_read_file',
    )
  })

  it('cuts a long name to 64 characters, and distinct long names stay distinct', () => {
    const long = 'a'.repeat(80)
    const one = userMcpToolName(long, 'search')
    const two = userMcpToolName(`${long}b`, 'search')
    expect(one).toMatch(VALID)
    expect(two).toMatch(VALID)
    expect(one).not.toBe(two)
    expect(userMcpToolName('s', 't'.repeat(100))).toMatch(VALID)
  })

  it('two servers whose names clean to the same name both keep their tools', async () => {
    const root = tmp('emperor-krn04-clash-')
    writeServers(root, {
      'my.server': stdio('/bin/dot'),
      my_server: stdio('/bin/underscore'),
    })
    const client = new MCPClient(root, {
      connectionFactory: (config) =>
        new GatedConnection(config.name, [tool('search')], true),
    })
    cleanups.push(() => client.close())
    await client.reload()
    const names = client.getTools().map((item) => item.name)
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    for (const name of names) expect(name).toMatch(VALID)
    // The server whose name was already valid keeps the plain name.
    expect(
      client.getTools().find((item) => item.mcpServerName === 'my_server')!
        .name,
    ).toBe('mcp_my_server_search')
  })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Answers initialize only after 600 ms, so a test can disconnect mid-connect. */
const SLOW_SERVER = `
const readline = require('node:readline')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined) return
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result })
  if (m.method === 'initialize')
    return setTimeout(() => reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' } }), 600)
  if (m.method === 'tools/list')
    return reply({ tools: [{ name: 'slow', description: 'slow', inputSchema: { type: 'object', properties: {} } }] })
  if (m.method === 'ping') return reply({})
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } })
})
`
