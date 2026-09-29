import { describe, expect, it } from 'vitest'
import { decodeLegacyMcp, decodePortableMcp } from './mcp-manifest'
import { MCP_SCHEMA_URL } from './testing'

function code(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('portable mcp.json', () => {
  it('decodes the three transports', () => {
    expect(
      decodePortableMcp(
        {
          $schema: MCP_SCHEMA_URL,
          mcpServers: {
            files: {
              type: 'stdio',
              command: '${PLUGIN_ROOT}/bin/files',
              args: ['--root', '.'],
              env: { LOG: 'quiet' },
              cwd: './bin',
            },
            docs: {
              type: 'streamable-http',
              url: 'https://docs.example/mcp',
              headers: { 'x-client': 'emperor' },
            },
            feed: { type: 'sse', url: 'https://feed.example/sse' },
          },
        },
        'mcp.json',
      ),
    ).toEqual([
      {
        name: 'files',
        transport: 'stdio',
        command: '${PLUGIN_ROOT}/bin/files',
        args: ['--root', '.'],
        env: { LOG: 'quiet' },
        cwd: './bin',
      },
      {
        name: 'docs',
        transport: 'http',
        url: 'https://docs.example/mcp',
        headers: { 'x-client': 'emperor' },
      },
      { name: 'feed', transport: 'sse', url: 'https://feed.example/sse' },
    ])
  })

  it('requires $schema, a supported version, and a type on every server', () => {
    const server = { type: 'stdio', command: 'run' }
    expect(
      code(() => decodePortableMcp({ mcpServers: { a: server } }, 'mcp.json')),
    ).toBe('plugin_preview_member_invalid')
    expect(
      code(() =>
        decodePortableMcp(
          {
            $schema: 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json',
            mcpServers: { a: server },
          },
          'mcp.json',
        ),
      ),
    ).toBe('plugin_preview_schema_unsupported')
    // The older shape (no type) is not accepted under the portable name.
    expect(
      code(() =>
        decodePortableMcp(
          { $schema: MCP_SCHEMA_URL, mcpServers: { a: { command: 'run' } } },
          'mcp.json',
        ),
      ),
    ).toBe('plugin_preview_member_invalid')
  })

  it('rejects unknown fields and reserved variables', () => {
    const decode = (servers: Record<string, unknown>, extra = {}) =>
      code(() =>
        decodePortableMcp(
          { $schema: MCP_SCHEMA_URL, mcpServers: servers, ...extra },
          'mcp.json',
        ),
      )
    expect(decode({ a: { type: 'stdio', command: 'run', timeout: 5 } })).toBe(
      'plugin_preview_member_invalid',
    )
    expect(
      decode({
        a: { type: 'stdio', command: 'run', env: { PLUGIN_ROOT: '/x' } },
      }),
    ).toBe('plugin_preview_member_invalid')
    expect(
      decode({ a: { type: 'sse', url: 'https://x', command: 'run' } }),
    ).toBe('plugin_preview_member_invalid')
    expect(decode({}, { servers: {} })).toBe('plugin_preview_member_invalid')
    expect(decode({ ' padded': { type: 'stdio', command: 'run' } })).toBe(
      'plugin_preview_member_invalid',
    )
  })
})

describe('legacy .mcp.json', () => {
  it('infers the transport, accepts a bare map, and ignores unknown fields', () => {
    expect(
      decodeLegacyMcp(
        {
          mcpServers: {
            local: { command: 'node', args: ['server.js'], note: 'ignored' },
            remote: { url: 'https://remote.example/mcp' },
            typed: { type: 'streamable-http', url: 'https://typed.example' },
            events: { type: 'sse', url: 'https://events.example' },
          },
        },
        '.mcp.json',
      ),
    ).toEqual([
      {
        name: 'local',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
      },
      { name: 'remote', transport: 'http', url: 'https://remote.example/mcp' },
      { name: 'typed', transport: 'http', url: 'https://typed.example' },
      { name: 'events', transport: 'sse', url: 'https://events.example' },
    ])
    expect(
      decodeLegacyMcp({ bare: { type: 'stdio', command: 'run' } }, '.mcp.json'),
    ).toEqual([{ name: 'bare', transport: 'stdio', command: 'run' }])
  })

  it('rejects servers it cannot start', () => {
    expect(
      code(() => decodeLegacyMcp({ mcpServers: { a: {} } }, '.mcp.json')),
    ).toBe('plugin_preview_member_invalid')
    expect(
      code(() =>
        decodeLegacyMcp(
          { mcpServers: { a: { type: 'ws', url: 'wss://x' } } },
          '.mcp.json',
        ),
      ),
    ).toBe('plugin_preview_member_invalid')
    expect(code(() => decodeLegacyMcp({ mcpServers: [] }, '.mcp.json'))).toBe(
      'plugin_preview_member_invalid',
    )
  })
})
