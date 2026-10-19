import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalKeySealer } from '../security/secret-sealer'
import { MCPClient } from './client'
import {
  loadMcpConfig,
  loadMcpConfigRaw,
  loadMcpConfigUnresolved,
  saveMcpConfig,
} from './config'
import { importMcpServers } from './manage'
import { startMcpHttpFixture, type McpHttpFixture } from './testing'

const fixtures: McpHttpFixture[] = []
const clients: MCPClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

function root(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-mcp-sealed-'))
}

function disk(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, 'mcp_config.json'), 'utf8'))
}

describe('MCP secrets at rest (SEC-06)', () => {
  it('seals the Authorization header and opens it when connecting (card 4)', async () => {
    const fixture = await startMcpHttpFixture({
      requireHeader: { name: 'Authorization', value: 'Bearer mcp-live-7788' },
    })
    fixtures.push(fixture)
    const dir = root()
    const sealer = createLocalKeySealer(dir)
    await saveMcpConfig(
      dir,
      {
        servers: {
          remote: {
            transport: 'http',
            url: fixture.url,
            headers: {
              Authorization: 'Bearer mcp-live-7788',
              'X-Trace': 'visible',
            },
          },
        },
      },
      { sealer },
    )
    const raw = readFileSync(join(dir, 'mcp_config.json'), 'utf8')
    expect(raw).not.toContain('mcp-live-7788')
    const stored = disk(dir).servers.remote.headers
    expect(stored.Authorization).toMatch(/^el1:/)
    expect(stored['X-Trace']).toBe('visible')

    const client = new MCPClient(dir, {
      sealer,
      supervisor: { connectTimeoutMs: 5_000, maxRestartAttempts: 1 },
    })
    clients.push(client)
    await client.initialize()
    expect(client.snapshot().servers[0]).toMatchObject({
      serverName: 'remote',
      state: 'ready',
    })
    const result = await client.getTools()[0]!.execute({ text: 'hi' })
    expect(result.rawContent).toBe('echo:hi')
  })

  it('seals secret-named env values only, keeps ${VAR} references readable, and backs up plaintext once', async () => {
    const dir = root()
    const legacy = {
      servers: {
        local: {
          command: 'node',
          args: ['server.js'],
          env: {
            GITHUB_TOKEN: 'ghp_plaintext_1234',
            API_KEY: 'k-plain',
            DB_PASSWORD: 'hunter2',
            LOG_LEVEL: 'debug',
            REF_TOKEN: '${GITHUB_TOKEN}',
          },
          headers: { authorization: 'Bearer ${API_TOKEN}' },
        },
      },
    }
    writeFileSync(join(dir, 'mcp_config.json'), JSON.stringify(legacy), 'utf8')
    const sealer = createLocalKeySealer(dir)
    // Plaintext is still read.
    expect(
      (await loadMcpConfig(dir, {}, { sealer })).servers.local!.env.API_KEY,
    ).toBe('k-plain')

    await importMcpServers(
      dir,
      { servers: { other: { url: 'https://mcp.example.test/mcp' } } },
      { sealer },
    )
    const env = disk(dir).servers.local.env
    expect(env.GITHUB_TOKEN).toMatch(/^el1:/)
    expect(env.API_KEY).toMatch(/^el1:/)
    expect(env.DB_PASSWORD).toMatch(/^el1:/)
    expect(env.LOG_LEVEL).toBe('debug')
    expect(env.REF_TOKEN).toBe('${GITHUB_TOKEN}')
    expect(disk(dir).servers.local.headers.authorization).toBe(
      'Bearer ${API_TOKEN}',
    )
    const backups = readdirSync(dir).filter((name) =>
      name.startsWith('mcp_config.json.pre-seal-'),
    )
    expect(backups).toHaveLength(1)

    // Runtime and raw views open them; the editor view still masks them.
    const runtime = await loadMcpConfig(dir, {}, { sealer })
    expect(runtime.servers.local!.env.GITHUB_TOKEN).toBe('ghp_plaintext_1234')
    expect(
      ((await loadMcpConfigRaw(dir, { sealer })).servers as any).local.env
        .DB_PASSWORD,
    ).toBe('hunter2')
    const editor = await loadMcpConfigUnresolved(dir, { sealer })
    expect(editor.servers.local!.env.GITHUB_TOKEN).toBe('[REDACTED]')

    // Re-importing the same server is still recognised as unchanged.
    const again = await importMcpServers(
      dir,
      { servers: { local: legacy.servers.local } },
      { sealer, dryRun: true },
    )
    expect(again.skipped).toEqual(['local'])
  })

  it('keeps an unreadable sealed value through an editor save and drops it when connecting', async () => {
    const dir = root()
    const sealer = createLocalKeySealer(dir)
    await saveMcpConfig(
      dir,
      {
        servers: {
          remote: {
            url: 'https://mcp.example.test/mcp',
            headers: { 'X-Api-Key': 'k-123' },
          },
        },
      },
      { sealer },
    )
    const sealed = disk(dir).servers.remote.headers['X-Api-Key'] as string
    // A sealer for another key file cannot open it.
    const stranger = createLocalKeySealer(root())
    expect(
      (await loadMcpConfig(dir, {}, { sealer: stranger })).servers.remote!
        .headers,
    ).toEqual({})
    const editor = await loadMcpConfigUnresolved(dir, { sealer: stranger })
    await saveMcpConfig(dir, editor as unknown as Record<string, unknown>, {
      sealer: stranger,
    })
    expect(disk(dir).servers.remote.headers['X-Api-Key']).toBe(sealed)
  })
})
