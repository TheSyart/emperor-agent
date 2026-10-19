// SEC-08 (PLAN-V020, findings CORE-11 / CORE-33): MCP stdio servers run in
// the same containment as the Shell. npx / uvx / node / python servers start
// inside it (their own cache folder is npm_config_cache, UV_CACHE_DIR and
// TMPDIR); a plugin's server never runs outside it; a user's server runs
// outside it only after the user agreed, once per server.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OsSandboxController } from '../environment/sandbox'
import { OwnedProcessRuntime } from '../processes/runtime'
import { ContainmentBackend } from '../sandbox/policy'
import { UnsandboxedConsentRegistry } from '../sandbox/consent'
import { MCPClient, type MCPClientOptions } from './client'
import type { ServerConfig } from './config'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const darwin = process.platform === 'darwin'
const unavailable = () =>
  new ContainmentBackend({
    platform: 'darwin',
    probe: () => ({ ok: false, detail: 'mock: no sandbox on this host' }),
  })

/** A stdio MCP server reporting what it sees from inside its process. */
const PROBE_SERVER = `
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const attempt = (fn) => { try { return fn() } catch (e) { return 'ERR:' + e.code } }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined) return
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result })
  if (m.method === 'initialize')
    return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } })
  if (m.method === 'tools/list')
    return reply({ tools: [{ name: 'probe', description: 'probe', inputSchema: { type: 'object', properties: { read: { type: 'string' }, write: { type: 'string' } } } }] })
  if (m.method === 'tools/call') {
    const args = m.params.arguments || {}
    const temp = path.join(process.env.TMPDIR || '/nonexistent', 'probe.txt')
    return reply({ content: [{ type: 'text', text: JSON.stringify({
      TMPDIR: process.env.TMPDIR || null,
      npm_config_cache: process.env.npm_config_cache || null,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR || null,
      tempWrite: attempt(() => { fs.writeFileSync(temp, 'ok'); return 'ok' }),
      read: args.read ? attempt(() => fs.readFileSync(args.read, 'utf8')) : null,
      write: args.write ? attempt(() => { fs.writeFileSync(args.write, 'x'); return 'ok' }) : null,
    }) }] })
  }
  if (m.method === 'ping') return reply({})
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } })
})
`

function fixture(options: {
  backend?: ContainmentBackend
  servers?: Record<string, Partial<ServerConfig>>
  client?: Partial<MCPClientOptions>
}) {
  const stateRoot = tmp('emperor-sec08-home-')
  const workspace = join(stateRoot, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(stateRoot, 'model_config.json'), 'MODEL-CONFIG-SECRET')
  if (options.servers)
    writeFileSync(
      join(stateRoot, 'mcp_config.json'),
      JSON.stringify({ servers: options.servers }),
    )
  const runtime = new OwnedProcessRuntime(stateRoot, {
    sandbox: new OsSandboxController(
      options.backend ? { backend: options.backend } : {},
    ),
  })
  const client = new MCPClient(stateRoot, {
    processRuntime: runtime,
    workspaceRoot: workspace,
    supervisor: { connectTimeoutMs: 20_000, maxRestartAttempts: 1 },
    ...options.client,
  })
  cleanups.push(() => client.close())
  return { stateRoot, workspace, runtime, client }
}

function probeScript(): string {
  const dir = tmp('emperor-sec08-server-')
  writeFileSync(join(dir, 'server.js'), PROBE_SERVER)
  return join(dir, 'server.js')
}

function receipts(stateRoot: string): Array<Record<string, any>> {
  const file = join(stateRoot, 'processes', 'receipts.v1.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
}

function which(name: string): string | null {
  const found = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.trim() : null
}

async function callProbe(
  client: MCPClient,
  args: Record<string, string> = {},
): Promise<Record<string, string | null>> {
  const tool = client.getTools().find((item) => item.mcpToolName === 'probe')
  expect(tool, 'the probe server connected').toBeDefined()
  return JSON.parse((await tool!.execute(args)).rawContent)
}

describe('MCP stdio servers in the sandbox (SEC-08)', () => {
  it.runIf(darwin && which('npx') !== null)(
    '2: npx -y @modelcontextprotocol/server-filesystem starts inside the sandbox and lists its tools',
    async () => {
      const { client, workspace, stateRoot } = fixture({
        client: { supervisor: { connectTimeoutMs: 180_000 } },
      })
      writeFileSync(
        join(stateRoot, 'mcp_config.json'),
        JSON.stringify({
          servers: {
            files: {
              enabled: true,
              transport: 'stdio',
              command: 'npx',
              args: [
                '-y',
                '@modelcontextprotocol/server-filesystem',
                workspace,
              ],
            },
          },
        }),
      )
      await client.initialize()
      const snapshot = client
        .snapshot()
        .servers.find((server) => server.serverName === 'files')
      expect(snapshot?.lastError ?? null).toBeNull()
      expect(snapshot?.state).toBe('ready')
      const names = client.getTools().map((tool) => tool.mcpToolName)
      expect(names).toEqual(
        expect.arrayContaining(['read_text_file', 'list_directory']),
      )
      const receipt = receipts(stateRoot).find(
        (item) => item.owner.kind === 'mcp' && item.owner.id === 'files',
      )
      expect(receipt?.containment).toMatchObject({
        backend: 'seatbelt',
        decision: 'contained',
      })
      // The download went to the server's own cache, not ~/.npm.
      expect(existsSync(join(stateRoot, 'mcp', 'cache', 'files', '_npx'))).toBe(
        true,
      )
    },
    240_000,
  )

  const uvx = process.env.EMPEROR_SEC08_UVX
  it.runIf(darwin && Boolean(uvx))(
    '3: uvx mcp-server-fetch starts inside the sandbox (local receipt: EMPEROR_SEC08_UVX=<uvx>)',
    async () => {
      const { client, stateRoot } = fixture({
        client: { supervisor: { connectTimeoutMs: 600_000 } },
      })
      writeFileSync(
        join(stateRoot, 'mcp_config.json'),
        JSON.stringify({
          servers: {
            fetch: {
              enabled: true,
              transport: 'stdio',
              command: uvx === '1' ? 'uvx' : uvx,
              args: ['mcp-server-fetch'],
            },
          },
        }),
      )
      await client.initialize()
      expect(client.getTools().map((tool) => tool.mcpToolName)).toContain(
        'fetch',
      )
      expect(
        receipts(stateRoot).find((item) => item.owner.id === 'fetch')
          ?.containment,
      ).toMatchObject({ backend: 'seatbelt', decision: 'contained' })
    },
    660_000,
  )

  it.runIf(darwin)(
    'node and python servers named by path start, and see only what they were given',
    async () => {
      const script = probeScript()
      const outside = tmp('emperor-sec08-outside-')
      writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET')
      const python = which('python3')
      const pyDir = tmp('emperor-sec08-py-')
      writeFileSync(
        join(pyDir, 'server.py'),
        [
          'import json, sys',
          'for line in sys.stdin:',
          '    m = json.loads(line)',
          "    if 'id' not in m: continue",
          "    if m['method'] == 'initialize':",
          "        r = {'protocolVersion': m['params']['protocolVersion'], 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'py', 'version': '1'}}",
          "    elif m['method'] == 'tools/list':",
          "        r = {'tools': [{'name': 'pyprobe', 'description': 'x', 'inputSchema': {'type': 'object'}}]}",
          '    else:',
          '        r = {}',
          "    print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': r}), flush=True)",
        ].join('\n'),
      )
      const { client, stateRoot } = fixture({
        servers: {
          node: {
            enabled: true,
            transport: 'stdio',
            command: process.execPath,
            args: [script],
          },
          ...(python
            ? {
                py: {
                  enabled: true,
                  transport: 'stdio',
                  command: python,
                  args: [join(pyDir, 'server.py')],
                },
              }
            : {}),
        },
      })
      await client.initialize()
      const tools = client.getTools().map((tool) => tool.mcpToolName)
      expect(tools).toContain('probe')
      if (python) expect(tools).toContain('pyprobe')
      const seen = await callProbe(client, {
        read: join(outside, 'secret.txt'),
        write: join(outside, 'escaped.txt'),
      })
      expect(seen.read).toMatch(/^ERR:/)
      expect(seen.write).toMatch(/^ERR:/)
      expect(existsSync(join(outside, 'escaped.txt'))).toBe(false)
      const config = await callProbe(client, {
        read: join(stateRoot, 'model_config.json'),
      })
      expect(config.read).toMatch(/^ERR:/)
    },
    60_000,
  )

  it.runIf(darwin)(
    '6: TMPDIR, npm_config_cache and UV_CACHE_DIR point at the server cache folder',
    async () => {
      const { client, stateRoot } = fixture({
        servers: {
          probe: {
            enabled: true,
            transport: 'stdio',
            command: process.execPath,
            args: [probeScript()],
          },
        },
      })
      await client.initialize()
      const seen = await callProbe(client)
      const cache = join(stateRoot, 'mcp', 'cache', 'probe')
      expect(seen).toMatchObject({
        TMPDIR: cache,
        npm_config_cache: cache,
        UV_CACHE_DIR: cache,
        tempWrite: 'ok',
      })
      expect(readFileSync(join(cache, 'probe.txt'), 'utf8')).toBe('ok')
    },
    30_000,
  )
})

describe('when the sandbox is unavailable (SEC-08)', () => {
  it('4: a plugin server is refused, says why, and leaves a refused receipt', async () => {
    const { client, stateRoot } = fixture({ backend: unavailable() })
    const pluginRoot = join(stateRoot, 'plugins', 'cache', 'kit')
    mkdirSync(pluginRoot, { recursive: true })
    writeFileSync(join(pluginRoot, 'server.js'), PROBE_SERVER)
    client.setPluginServers([
      {
        key: 'kit-probe',
        pluginId: 'kit',
        serverName: 'probe',
        config: {
          name: 'kit-probe',
          transport: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [join(pluginRoot, 'server.js')],
          env: {},
          url: null,
          headers: {},
          tool_overrides: {},
          cwd: pluginRoot,
          stateGrants: { read: [pluginRoot], write: [] },
        },
      },
    ])
    await client.reload()
    expect(client.getTools()).toEqual([])
    const snapshot = client.pluginServerSnapshot('kit-probe')
    expect(snapshot).toMatchObject({
      state: 'failed',
      lastError: { code: 'mcp_sandbox_refused' },
    })
    expect(snapshot!.lastError!.message).toContain(
      'mock: no sandbox on this host',
    )
    expect(
      receipts(stateRoot).find((item) => item.owner.id === 'kit-probe'),
    ).toMatchObject({
      status: 'refused',
      containment: { backend: 'none', decision: 'refused' },
    })
  })

  it('5: a user server waits for one confirmation, then runs unsandboxed — remembered per server', async () => {
    const script = probeScript()
    const servers = {
      probe: {
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [script],
      },
      other: {
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [script],
      },
    }
    const first = fixture({ backend: unavailable(), servers })
    const consent = new UnsandboxedConsentRegistry(first.stateRoot)
    const client = new MCPClient(first.stateRoot, {
      processRuntime: first.runtime,
      workspaceRoot: first.workspace,
      unsandboxedConsent: consent,
      supervisor: { connectTimeoutMs: 20_000, maxRestartAttempts: 1 },
    })
    cleanups.push(() => client.close())
    await client.initialize()
    expect(client.getTools()).toEqual([])
    expect(
      client.snapshot().servers.find((server) => server.serverName === 'probe')
        ?.lastError?.code,
    ).toBe('mcp_sandbox_consent_required')
    const pending = consent.pending()
    expect(pending.map((request) => request.name).sort()).toEqual([
      'other',
      'probe',
    ])
    expect(pending[0]!.reason).toContain('mock: no sandbox on this host')

    consent.resolve(
      pending.find((item) => item.name === 'probe')!,
      'allowed',
    )
    consent.resolve(
      pending.find((item) => item.name === 'other')!,
      'denied',
    )
    await client.reload()
    expect(client.getTools().map((tool) => tool.mcpServerName)).toEqual([
      'probe',
    ])
    const allowed = receipts(first.stateRoot).filter(
      (item) => item.owner.id === 'probe',
    )
    expect(allowed.at(-1)?.containment).toMatchObject({
      backend: 'none',
      decision: 'user-allowed-unsandboxed',
    })

    // A later run reads the remembered answers: nothing is asked again.
    await client.close()
    const again = new UnsandboxedConsentRegistry(first.stateRoot)
    const restarted = new MCPClient(first.stateRoot, {
      processRuntime: first.runtime,
      workspaceRoot: first.workspace,
      unsandboxedConsent: again,
      supervisor: { connectTimeoutMs: 20_000, maxRestartAttempts: 1 },
    })
    cleanups.push(() => restarted.close())
    await restarted.initialize()
    expect(again.pending()).toEqual([])
    expect(restarted.getTools().map((tool) => tool.mcpServerName)).toEqual([
      'probe',
    ])

    // Another command under the same name is another server: asked again.
    writeFileSync(
      join(first.stateRoot, 'mcp_config.json'),
      JSON.stringify({
        servers: { probe: { ...servers.probe, args: [script, '--v2'] } },
      }),
    )
    await restarted.reload()
    expect(again.pending().map((request) => request.name)).toEqual(['probe'])
  })
})
