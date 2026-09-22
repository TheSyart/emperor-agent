import { describe, expect, it } from 'vitest'
import { McpImportError, normalizeMcpImport } from './import'

describe('normalizeMcpImport', () => {
  it('imports the Claude-style http server pasted by the user', () => {
    const result = normalizeMcpImport(
      '{"mcpServers":{"aihot":{"type":"http","url":"https://aihot.news/api/mcp?aihot_actor=abc123"}}}',
    )
    expect(result.warnings).toEqual([])
    expect(result.servers).toEqual({
      aihot: {
        transport: 'http',
        enabled: true,
        url: 'https://aihot.news/api/mcp?aihot_actor=abc123',
      },
    })
  })

  it('accepts Claude Desktop / Cursor stdio servers with env', () => {
    const result = normalizeMcpImport({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          env: { DEBUG: 1 },
        },
        off: { command: 'off-server', disabled: true },
      },
    })
    expect(result.servers).toEqual({
      filesystem: {
        transport: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { DEBUG: '1' },
      },
      off: { transport: 'stdio', enabled: false, command: 'off-server' },
    })
  })

  it('accepts VS Code / Emperor servers and maps transport spellings', () => {
    const result = normalizeMcpImport({
      servers: {
        streamable: { type: 'streamable-http', url: 'https://a.test/mcp' },
        camel: { transport: 'streamableHttp', baseUrl: 'https://b.test/mcp' },
        legacy: {
          transport: 'sse',
          url: 'https://c.test/sse',
          headers: { Authorization: 'Bearer ${TOKEN}' },
        },
        emperor: {
          transport: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          enabled: false,
          tool_overrides: { search: { read_only: true } },
        },
      },
      inputs: [],
    })
    expect(result.warnings).toEqual([])
    expect(result.servers.streamable).toEqual({
      transport: 'http',
      enabled: true,
      url: 'https://a.test/mcp',
    })
    expect(result.servers.camel).toMatchObject({
      transport: 'http',
      url: 'https://b.test/mcp',
    })
    expect(result.servers.legacy).toEqual({
      transport: 'sse',
      enabled: true,
      url: 'https://c.test/sse',
      headers: { Authorization: 'Bearer ${TOKEN}' },
    })
    expect(result.servers.emperor).toEqual({
      transport: 'stdio',
      enabled: false,
      command: 'node',
      args: ['server.mjs'],
      tool_overrides: { search: { read_only: true } },
    })
  })

  it('defaults a url-only server to http and a command-only server to stdio', () => {
    const result = normalizeMcpImport({
      remote: { url: 'https://remote.test/mcp' },
      local: { command: 'uvx', args: ['mcp-server-time'] },
    })
    expect(result.servers.remote?.transport).toBe('http')
    expect(result.servers.local?.transport).toBe('stdio')
  })

  it('imports a single named server object and warns when the name is missing', () => {
    expect(
      normalizeMcpImport({ name: 'docs', url: 'https://docs.test/mcp' }),
    ).toEqual({
      servers: {
        docs: {
          transport: 'http',
          enabled: true,
          url: 'https://docs.test/mcp',
        },
      },
      warnings: [],
    })
    const unnamed = normalizeMcpImport({ command: 'npx', args: ['x'] })
    expect(unnamed.servers).toEqual({})
    expect(unnamed.warnings.join('\n')).toContain('缺少 name')
  })

  it('repairs JSONC and fragments with a warning', () => {
    const jsonc = normalizeMcpImport(`{
      // VS Code mcp.json allows comments
      "servers": { "a": { "type": "http", "url": "https://a.test/mcp" }, },
    }`)
    expect(jsonc.servers.a?.transport).toBe('http')
    expect(jsonc.warnings.join('\n')).toContain('自动修复')
    const fragment = normalizeMcpImport(
      '"aihot": { "type": "http", "url": "https://aihot.news/api/mcp" }',
    )
    expect(fragment.servers.aihot?.url).toBe('https://aihot.news/api/mcp')
  })

  it('skips unsupported or incomplete servers with warnings', () => {
    const result = normalizeMcpImport({
      mcpServers: {
        socket: { type: 'websocket', url: 'wss://x.test' },
        empty: {},
        badurl: { type: 'http', url: 'ftp://x.test' },
        stdioNoCommand: { type: 'stdio', url: 'https://x.test' },
        ok: { command: 'ok', cwd: '/tmp', autoApprove: [] },
      },
    })
    expect(Object.keys(result.servers)).toEqual(['ok'])
    const text = result.warnings.join('\n')
    expect(text).toContain('不支持的 transport "websocket"')
    expect(text).toContain('"empty"：缺少 command 或 url')
    expect(text).toContain('http(s)')
    expect(text).toContain('stdio server 缺少 command')
    expect(text).toContain('cwd, autoApprove')
  })

  it('sanitizes server names that cannot become tool prefixes', () => {
    const result = normalizeMcpImport({
      mcpServers: { 'my server.v2': { url: 'https://x.test/mcp' } },
    })
    expect(Object.keys(result.servers)).toEqual(['my-server-v2'])
    expect(result.warnings.join('\n')).toContain('已规范为')
  })

  it('rejects input that is not a JSON object', () => {
    expect(() => normalizeMcpImport('not json at all [')).toThrow(
      McpImportError,
    )
    expect(() => normalizeMcpImport([1, 2])).toThrow(McpImportError)
    expect(() => normalizeMcpImport('   ')).toThrow(McpImportError)
  })
})
