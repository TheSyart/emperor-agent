import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCPClient } from './client'
import { startMcpHttpFixture, type McpHttpFixture } from './testing'

const fixtures: McpHttpFixture[] = []
const clients: MCPClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

function configRoot(servers: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'emperor-mcp-http-'))
  writeFileSync(
    join(root, 'mcp_config.json'),
    JSON.stringify({ servers }),
    'utf8',
  )
  return root
}

function client(root: string): MCPClient {
  const created = new MCPClient(root, {
    supervisor: { connectTimeoutMs: 5_000, maxRestartAttempts: 1 },
  })
  clients.push(created)
  return created
}

describe('MCP Streamable HTTP transport', () => {
  it('connects over Streamable HTTP, lists tools, and calls one', async () => {
    const fixture = await startMcpHttpFixture()
    fixtures.push(fixture)
    const mcp = client(
      configRoot({ local: { transport: 'http', url: fixture.url } }),
    )

    await mcp.initialize()

    const snapshot = mcp.snapshot()
    expect(snapshot.servers).toEqual([
      expect.objectContaining({
        serverName: 'local',
        transport: 'http',
        state: 'ready',
        tools: ['echo'],
      }),
    ])
    const tool = mcp.getTools().find((item) => item.name === 'mcp_local_echo')
    expect(tool).toBeDefined()
    const result = await tool!.execute({ text: 'hi' })
    expect(result.isError).toBe(false)
    expect(result.rawContent).toBe('echo:hi')
    expect(fixture.requests.every((line) => line.endsWith(' /mcp'))).toBe(true)
  })

  it('treats a url-only server as http and forwards configured headers', async () => {
    const fixture = await startMcpHttpFixture({
      requireHeader: { name: 'X-Api-Key', value: 'k-123' },
    })
    fixtures.push(fixture)
    const mcp = client(
      configRoot({
        keyed: { url: fixture.url, headers: { 'X-Api-Key': 'k-123' } },
        missing: { url: fixture.url },
      }),
    )

    await mcp.initialize()

    const states = Object.fromEntries(
      mcp.snapshot().servers.map((server) => [server.serverName, server.state]),
    )
    expect(states).toEqual({ keyed: 'ready', missing: 'auth_failed' })
    expect(mcp.getTools().map((tool) => tool.name)).toEqual(['mcp_keyed_echo'])
  })

  it('does not fall back to legacy SSE after an authentication failure', async () => {
    const fixture = await startMcpHttpFixture({
      requireHeader: { name: 'Authorization', value: 'Bearer ok' },
    })
    fixtures.push(fixture)
    const mcp = client(configRoot({ locked: { url: fixture.url } }))

    await mcp.initialize()

    expect(mcp.snapshot().servers[0]).toMatchObject({
      state: 'auth_failed',
      lastError: { code: 'mcp_auth_failed' },
    })
    expect(fixture.requests).toEqual(['POST /mcp'])
  })

  it('falls back to legacy SSE when the Streamable HTTP handshake fails', async () => {
    const fixture = await startMcpHttpFixture({ mode: 'sse-only' })
    fixtures.push(fixture)
    const mcp = client(
      configRoot({ legacy: { transport: 'http', url: fixture.url } }),
    )

    await mcp.initialize()

    expect(mcp.snapshot().servers[0]).toMatchObject({
      serverName: 'legacy',
      state: 'ready',
      tools: ['echo'],
    })
    expect(fixture.requests.slice(0, 2)).toEqual(['POST /sse', 'GET /sse'])
    const result = await mcp.getTools()[0]!.execute({ text: 'old' })
    expect(result.rawContent).toBe('echo:old')
  })

  it('reports unknown transports and missing endpoints as configuration errors', async () => {
    const mcp = client(
      configRoot({
        socket: { transport: 'websocket', url: 'wss://x.test' },
        nocommand: { transport: 'stdio' },
        nourl: { transport: 'http' },
      }),
    )

    await mcp.initialize()

    const servers = mcp.snapshot().servers
    expect(servers.map((server) => server.serverName)).toEqual([
      'nocommand',
      'nourl',
      'socket',
    ])
    for (const server of servers) {
      expect(server.state).toBe('failed')
      expect(server.lastError?.code).toBe('mcp_config_invalid')
    }
    expect(servers[2]?.lastError?.message).toContain(
      "unsupported transport 'websocket'",
    )
    expect(mcp.getTools()).toEqual([])
  })
})
