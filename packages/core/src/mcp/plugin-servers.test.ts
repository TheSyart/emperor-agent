import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutionEnvironment } from '../environment/snapshot'
import { STDIO_MCP_SERVER } from '../plugins/testing'
import { MCPClient, type PluginMcpServer } from './client'
import type { ServerConfig } from './config'
import { startMcpHttpFixture, type McpHttpFixture } from './testing'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

async function httpFixture(toolName = 'echo'): Promise<McpHttpFixture> {
  const fixture = await startMcpHttpFixture({ toolName })
  cleanups.push(() => fixture.close())
  return fixture
}

function client(root: string): MCPClient {
  const value = new MCPClient(root)
  cleanups.push(() => value.close())
  return value
}

function remote(key: string, url: string): ServerConfig {
  return {
    name: key,
    transport: 'http',
    enabled: true,
    command: null,
    args: [],
    env: {},
    url,
    headers: {},
    tool_overrides: {},
  }
}

function plugin(
  key: string,
  config: ServerConfig,
  pluginId = 'docs-kit',
  serverName = 'docs',
): PluginMcpServer {
  return { key, pluginId, serverName, config }
}

describe('plugin MCP servers in the client', () => {
  it('runs a plugin server under its key with contract tool names, beside the user file', async () => {
    const root = tmp('emperor-plugin-mcp-')
    const userFile = join(root, 'mcp_config.json')
    writeFileSync(
      userFile,
      JSON.stringify({
        servers: { mine: { transport: 'stdio', command: 'x', enabled: false } },
      }),
    )
    const before = readFileSync(userFile, 'utf8')
    const fixture = await httpFixture()
    const mcp = client(root)
    expect(
      mcp.setPluginServers([
        plugin('docs-kit-docs', remote('docs-kit-docs', fixture.url)),
      ]),
    ).toBe(true)
    // Setting the same list again is not a change.
    expect(
      mcp.setPluginServers([
        plugin('docs-kit-docs', remote('docs-kit-docs', fixture.url)),
      ]),
    ).toBe(false)
    await mcp.reload()

    const tools = mcp.getTools()
    expect(
      tools.map((tool) => [tool.name, tool.mcpServerName, tool.pluginId]),
    ).toEqual([['mcp_docs-kit-docs_echo', 'docs-kit-docs', 'docs-kit']])
    const result = await tools[0]!.execute({ text: 'hi' })
    expect(result.modelContent).toContain('echo:hi')
    expect(mcp.pluginServerSnapshot('docs-kit-docs')).toMatchObject({
      state: 'ready',
    })
    expect(mcp.snapshot().configured).toBe(1)
    expect(readFileSync(userFile, 'utf8')).toBe(before)

    mcp.setPluginServers([])
    await mcp.reload()
    expect(mcp.getTools()).toEqual([])
    expect(mcp.pluginServerSnapshot('docs-kit-docs')).toBeNull()
    expect(readFileSync(userFile, 'utf8')).toBe(before)
  })

  it('skips a plugin tool whose name is already taken and says which', async () => {
    const root = tmp('emperor-plugin-mcp-')
    const fixture = await httpFixture('read')
    const mcp = client(root)
    mcp.setReservedToolNames(() => new Set(['mcp_docs-kit-docs_read']))
    mcp.setPluginServers([
      plugin('docs-kit-docs', remote('docs-kit-docs', fixture.url)),
    ])
    await mcp.reload()
    expect(mcp.getTools()).toEqual([])
    expect(mcp.pluginSkippedTools('docs-kit-docs')).toEqual(['read'])
  })

  it('starts a stdio plugin server in its own folder and survives an environment change', async () => {
    const root = tmp('emperor-plugin-mcp-')
    const pluginRoot = tmp('emperor-plugin-root-')
    writeFileSync(join(pluginRoot, 'server.js'), STDIO_MCP_SERVER)
    const config: ServerConfig & { cwd: string } = {
      name: 'where-kit-where',
      transport: 'stdio',
      enabled: true,
      command: process.execPath,
      args: [join(pluginRoot, 'server.js')],
      env: { PLUGIN_ROOT: pluginRoot },
      url: null,
      headers: {},
      tool_overrides: {},
      cwd: pluginRoot,
    }
    const mcp = client(root)
    mcp.setPluginServers([
      plugin('where-kit-where', config, 'where-kit', 'where'),
    ])
    await mcp.reload()
    const [tool] = mcp.getTools()
    expect(tool!.name).toBe('mcp_where-kit-where_where')
    const first = JSON.parse(
      (await tool!.execute({ note: 'one' })).rawContent,
    ) as { cwd: string; root: string }
    expect(realpathSync(first.cwd)).toBe(pluginRoot)
    expect(first.root).toBe(pluginRoot)

    // A call under a new execution environment re-resolves the server by
    // name; a plugin server must still be found (it is not in mcp_config.json).
    const environment = new ExecutionEnvironment(
      {
        revision: 'c'.repeat(64),
        catalogRevision: 'a'.repeat(64),
        projectFingerprint: 'b'.repeat(64),
        createdAt: '2026-09-30T02:00:00.000Z',
        platform: 'darwin',
        pathEntries: ['/usr/bin'],
        env: { PATH: '/usr/bin', HOME: root },
        toolPaths: {},
      },
      {},
    )
    const second = JSON.parse(
      (
        await tool!.execute(
          { note: 'two' },
          { executionEnvironment: environment },
        )
      ).rawContent,
    ) as { note: string; cwd: string }
    expect(second.note).toBe('two')
    expect(realpathSync(second.cwd)).toBe(pluginRoot)
  })
})
