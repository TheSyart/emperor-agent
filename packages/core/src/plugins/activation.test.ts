import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  pluginContributions,
  pluginDataDirectory,
  pluginMcpToolName,
  type ActivePluginPackage,
} from './activation'
import { resolvePluginPackage } from './manifest-resolver'
import {
  MCP_SCHEMA_URL,
  portablePackage,
  tempDirectory,
  writePackage,
  type PackageFiles,
} from './testing'

function active(
  name: string,
  files: PackageFiles,
  scope: ActivePluginPackage['scope'] = 'user',
): ActivePluginPackage {
  const root = writePackage(tempDirectory(), portablePackage(name, files))
  return {
    pluginId: name,
    scope,
    resolved: resolvePluginPackage(root, { strict: true }),
  }
}

function mcpFile(servers: Record<string, unknown>) {
  return { 'mcp.json': { $schema: MCP_SCHEMA_URL, mcpServers: servers } }
}

const HOME = '/Users/tester/.emperor'

function contributions(
  packages: ActivePluginPackage[],
  options: { userServers?: string[]; env?: Record<string, string> } = {},
) {
  return pluginContributions({
    packages,
    userServerNames: options.userServers ?? [],
    emperorHome: HOME,
    env: options.env ?? { HOME: '/Users/tester', PATH: '/usr/bin' },
  })
}

describe('plugin MCP names', () => {
  it('keys servers by plugin and server, renaming only the plugin side on a clash', () => {
    const kit = active(
      'search-kit',
      mcpFile({ web: { type: 'stdio', command: 'web' } }),
    )
    const other = active(
      'search',
      mcpFile({ 'kit-web': { type: 'stdio', command: 'x' } }),
    )
    const plain = contributions([kit])
    expect(plain.mcp.map((server) => server.key)).toEqual(['search-kit-web'])

    const clashing = contributions([kit, other], {
      userServers: ['search-kit-web'],
    })
    const keys = clashing.mcp.map((server) => [server.pluginId, server.key])
    expect(keys[1]).toEqual([
      'search-kit',
      expect.stringMatching(/^search-kit-web_[0-9a-f]{6}$/),
    ])
    // `search` sorts first and would also produce `search-kit-web`; the user's server keeps its name.
    expect(keys[0]).toEqual([
      'search',
      expect.stringMatching(/^search-kit-web_[0-9a-f]{6}$/),
    ])
    expect(keys[0]![1]).not.toBe(keys[1]![1])
    // Deterministic across runs.
    expect(
      contributions([kit, other], { userServers: ['search-kit-web'] }).mcp,
    ).toEqual(clashing.mcp)
  })

  it('builds tool names within 64 safe characters and keeps them stable', () => {
    expect(
      pluginMcpToolName('search-kit-web', 'search-kit', 'web', 'fetch.page'),
    ).toBe('mcp_search-kit-web_fetch_page')
    const longKey = `k${'e'.repeat(70)}`
    const a = pluginMcpToolName(longKey, 'p', 's', 'read')
    expect(a.length).toBeLessThanOrEqual(64)
    expect(a).toMatch(/^mcp_ke+_[0-9a-f]{6}_read$/)
    const longTool = 'x'.repeat(80)
    const b1 = pluginMcpToolName('short-key', 'p', 's', `${longTool}1`)
    const b2 = pluginMcpToolName('short-key', 'p', 's', `${longTool}2`)
    expect(b1.length).toBe(64)
    expect(b1).not.toBe(b2)
    expect(b1.startsWith('mcp_short-key_')).toBe(true)
    const both = pluginMcpToolName(longKey, 'p', 's', longTool)
    expect(both.length).toBe(64)
    expect(both).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pluginMcpToolName(longKey, 'p', 's', longTool)).toBe(both)
  })
})

describe('plugin MCP servers', () => {
  it('expands plugin variables and gives stdio servers the plugin root as cwd', () => {
    const kit = active(
      'files-kit',
      mcpFile({
        files: {
          type: 'stdio',
          command: '${PLUGIN_ROOT}/bin/files',
          args: ['--data', '${PLUGIN_DATA}', '--home', '${HOME}'],
          env: { ROOT: '${CLAUDE_PLUGIN_ROOT}' },
        },
        docs: {
          type: 'streamable-http',
          url: 'https://docs.example/${CLAUDE_PLUGIN_DATA}',
          headers: { 'x-root': '${PLUGIN_ROOT}' },
        },
        nested: { type: 'stdio', command: 'run', cwd: './bin' },
      }),
    )
    const root = kit.resolved.rootPath
    const data = pluginDataDirectory(HOME, 'files-kit')
    expect(data).toBe(join(HOME, 'plugins', 'data', 'files-kit'))
    const [files, docs, nested] = contributions([kit]).mcp
    expect(files).toMatchObject({
      key: 'files-kit-files',
      blocked: null,
      config: {
        name: 'files-kit-files',
        transport: 'stdio',
        enabled: true,
        command: `${root}/bin/files`,
        args: ['--data', data, '--home', '/Users/tester'],
        cwd: root,
        env: {
          ROOT: root,
          PLUGIN_ROOT: root,
          CLAUDE_PLUGIN_ROOT: root,
          PLUGIN_DATA: data,
          CLAUDE_PLUGIN_DATA: data,
        },
      },
    })
    expect(docs!.config).toMatchObject({
      transport: 'http',
      url: `https://docs.example/${data}`,
      headers: { 'x-root': root },
      env: {},
    })
    expect(nested!.config!.cwd).toBe(join(root, 'bin'))
  })

  it('does not start a server that needs a variable it may not read', () => {
    const kit = active(
      'secret-kit',
      mcpFile({
        api: {
          type: 'streamable-http',
          url: 'https://api.example/mcp',
          headers: { authorization: 'Bearer ${API_TOKEN}' },
        },
        escape: { type: 'stdio', command: 'run', cwd: '../../outside' },
      }),
    )
    const [api, escape] = contributions([kit], {
      env: { HOME: '/Users/tester', API_TOKEN: 'from-the-process' },
    }).mcp
    expect(api).toMatchObject({
      config: null,
      blocked: '需要环境变量 API_TOKEN',
    })
    expect(escape).toMatchObject({
      config: null,
      blocked: '工作目录越出了插件目录',
    })
  })
})

describe('plugin hooks', () => {
  it('turns translated Codex entries into exact Emperor matchers with the plugin variables', () => {
    const kit = active('guard-kit', {
      ...mcpFile({ 'my-files': { type: 'stdio', command: 'files' } }),
      'hooks/hooks.json': {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash|Write',
              hooks: [{ command: 'guard.sh', timeout: 5 }],
            },
            {
              matcher: '^mcp__my-files__read$',
              hooks: [{ command: 'files.sh' }],
            },
            { matcher: 'NotebookEdit', hooks: [{ command: 'never.sh' }] },
          ],
          SessionStart: [
            { matcher: 'startup', hooks: [{ command: 'start.sh' }] },
          ],
          Stop: [{ hooks: [{ command: 'stop.sh' }] }],
        },
      },
    })
    const root = kit.resolved.rootPath
    const data = pluginDataDirectory(HOME, 'guard-kit')
    const [set] = contributions([kit]).hooks
    expect(set).toEqual({
      pluginId: 'guard-kit',
      scope: 'user',
      env: {
        PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_ROOT: root,
        PLUGIN_DATA: data,
        CLAUDE_PLUGIN_DATA: data,
      },
      config: {
        PreToolUse: [
          {
            matcher: 'bash|edit|write',
            hooks: [{ command: 'guard.sh', timeoutSec: 5 }],
          },
          {
            matcher: '^(?:mcp_guard-kit-my-files_read)$',
            hooks: [{ command: 'files.sh' }],
          },
        ],
        SessionStart: [
          { matcher: 'startup', hooks: [{ command: 'start.sh' }] },
        ],
        Stop: [{ hooks: [{ command: 'stop.sh' }] }],
      },
    })
  })

  it('keeps Emperor-dialect matchers as written and skips packages without runnable hooks', () => {
    const legacyRoot = writePackage(tempDirectory(), {
      '.emperor-plugin/plugin.json': {
        schemaVersion: 1,
        id: 'acme/legacy',
        name: 'Legacy',
        version: '1.0.0',
        hooks: ['hooks.json'],
      },
      'hooks.json': {
        hooks: {
          PostToolUse: [{ matcher: 'mcp_.*', hooks: [{ command: 'log.sh' }] }],
        },
      },
    })
    const legacy: ActivePluginPackage = {
      pluginId: 'acme/legacy',
      scope: 'user',
      resolved: resolvePluginPackage(legacyRoot, { strict: true }),
    }
    const quiet = active('quiet-kit', {
      'hooks/hooks.json': {
        hooks: { SessionEnd: [{ hooks: [{ command: 'x' }] }] },
      },
    })
    const { hooks } = contributions([legacy, quiet])
    expect(hooks).toHaveLength(1)
    expect(hooks[0]!.config).toEqual({
      PostToolUse: [{ matcher: 'mcp_.*', hooks: [{ command: 'log.sh' }] }],
    })
    expect(hooks[0]!.env.PLUGIN_DATA).toBe(
      join(HOME, 'plugins', 'data', 'acme', 'legacy'),
    )
  })
})
