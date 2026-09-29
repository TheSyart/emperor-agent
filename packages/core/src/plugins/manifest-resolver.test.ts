import { cpSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findPluginPackageRoot,
  pluginVersionSegment,
  resolvePluginPackage,
} from './manifest-resolver'
import {
  MCP_SCHEMA_URL,
  PLUGIN_SCHEMA_URL,
  portablePackage,
  skillMarkdown,
  tempDirectory,
  writePackage,
  type PackageFiles,
} from './testing'

function packageAt(files: PackageFiles): string {
  return writePackage(tempDirectory(), files)
}

function resolveStrict(root: string) {
  return resolvePluginPackage(root, { strict: true })
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

function summary(root: string) {
  const resolved = resolveStrict(root)
  return {
    ...resolved,
    components: resolved.components.map(({ kind, id, state }) => [
      kind,
      id,
      state,
    ]),
  }
}

const CODEX_HOOKS = {
  hooks: {
    PreToolUse: [
      { matcher: '^Bash$', hooks: [{ type: 'command', command: 'check.sh' }] },
    ],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'bye.sh' }] }],
  },
}

describe('portable packages', () => {
  it('reads a root manifest with only a Skill', () => {
    const root = packageAt(
      portablePackage('hello-kit', {
        'skills/hello/SKILL.md': skillMarkdown('hello', 'Say hello'),
      }),
    )
    expect(summary(root)).toMatchObject({
      pluginId: 'hello-kit',
      format: 'portable',
      version: null,
      displayName: 'hello-kit',
      description: null,
      skillRoots: [join(root, 'skills')],
      mcpServers: [],
      hooks: [],
      components: [['skill', 'hello', 'available']],
    })
  })

  it('reads a root manifest with only MCP servers', () => {
    const root = packageAt(
      portablePackage('mcp-kit', {
        'mcp.json': {
          $schema: MCP_SCHEMA_URL,
          mcpServers: {
            search: {
              type: 'streamable-http',
              url: 'https://search.example/mcp',
            },
            files: { type: 'stdio', command: '${PLUGIN_ROOT}/bin/files' },
          },
        },
      }),
    )
    const resolved = resolveStrict(root)
    expect(resolved.skillRoots).toEqual([])
    expect(resolved.mcpServers.map((server) => server.name)).toEqual([
      'search',
      'files',
    ])
    expect(resolved.components).toEqual([
      expect.objectContaining({
        kind: 'mcp',
        id: 'files',
        description: 'stdio · files',
      }),
      expect.objectContaining({
        kind: 'mcp',
        id: 'search',
        description: 'http · search.example',
      }),
    ])
  })

  it('reads a mixed package with interface fields, apps, hooks and unsupported members', () => {
    const root = packageAt(
      portablePackage(
        'mixed-kit',
        {
          'skills/alpha/SKILL.md': skillMarkdown('alpha', 'First'),
          'skills/beta/SKILL.md': skillMarkdown('beta', 'Second'),
          'mcp.json': {
            $schema: MCP_SCHEMA_URL,
            mcpServers: { files: { type: 'stdio', command: 'files' } },
          },
          'hooks/hooks.json': CODEX_HOOKS,
          '.app.json': { apps: { calendar: { id: 'cal' } } },
          'agents/reviewer.md': '# Reviewer',
          'commands/ship/deploy.md': '# Deploy',
          'assets/logo.png': 'png',
        },
        {
          version: '1.2.0',
          description: 'Root description',
          author: { name: 'Acme' },
          homepage: 'https://acme.example',
          license: 'MIT',
          extensions: {
            'com.openai': {
              apps: './.app.json',
              interface: {
                displayName: 'Mixed Kit',
                shortDescription: 'Short',
                longDescription: 'Long',
                category: 'Tools',
                defaultPrompt: ['one', 'two', 'three', 'four'],
                logo: './assets/logo.png',
              },
            },
          },
        },
      ),
    )
    const resolved = resolveStrict(root)
    expect(resolved).toMatchObject({
      version: '1.2.0',
      displayName: 'Mixed Kit',
      description: 'Short',
      longDescription: 'Long',
      developerName: 'Acme',
      category: 'Tools',
      homepage: 'https://acme.example',
      license: 'MIT',
      prompts: ['one', 'two', 'three'],
      logoPath: join(root, 'assets', 'logo.png'),
      logoIssue: null,
    })
    expect(summary(root).components).toEqual([
      ['skill', 'alpha', 'available'],
      ['skill', 'beta', 'available'],
      ['mcp', 'files', 'available'],
      ['app', 'calendar', 'unsupported'],
      ['hook', 'PreToolUse#1', 'available'],
      ['hook', 'SessionEnd#1', 'unsupported'],
      ['agent', 'agents/reviewer.md', 'unsupported'],
      ['command', 'commands/ship/deploy.md', 'unsupported'],
    ])
    expect(resolved.hooks[0]!.mapped).toEqual({
      event: 'PreToolUse',
      subjects: ['bash'],
    })
  })

  it('lets an extensions.com.openai object replace .codex-plugin wholesale', () => {
    const root = packageAt(
      portablePackage(
        'override-kit',
        {
          '.codex-plugin/plugin.json': {
            name: 'override-kit',
            interface: {
              displayName: 'From Codex',
              developerName: 'Codex Dev',
            },
            hooks: CODEX_HOOKS,
          },
        },
        {
          extensions: {
            'com.openai': { interface: { displayName: 'From Root' } },
          },
        },
      ),
    )
    const resolved = resolveStrict(root)
    expect(resolved.displayName).toBe('From Root')
    expect(resolved.developerName).toBeNull()
    expect(resolved.hooks).toEqual([])
  })

  it('reads OpenAI settings from .codex-plugin when the root has none', () => {
    const root = packageAt(
      portablePackage('fallback-kit', {
        '.codex-plugin/plugin.json': {
          name: 'fallback-kit',
          version: '9.9.9',
          interface: { displayName: 'Fallback', developerName: 'Codex Dev' },
          hooks: CODEX_HOOKS,
        },
      }),
    )
    const resolved = resolveStrict(root)
    expect(resolved).toMatchObject({
      format: 'portable',
      version: null,
      displayName: 'Fallback',
      developerName: 'Codex Dev',
    })
    expect(resolved.hooks.map((hook) => hook.id)).toEqual([
      'PreToolUse#1',
      'SessionEnd#1',
    ])
  })

  it('does not read a renamed .mcp.json as the portable mcp.json', () => {
    const root = packageAt(
      portablePackage('renamed-kit', {
        '.mcp.json': { mcpServers: { files: { command: 'files' } } },
      }),
    )
    expect(resolveStrict(root).mcpServers).toEqual([])
  })
})

describe('codex-compat packages', () => {
  it('reads .codex-plugin/plugin.json alone with the older .mcp.json shape', () => {
    const root = packageAt({
      '.codex-plugin/plugin.json': {
        name: 'codex-kit',
        version: '2.0.0',
        description: 'Codex only',
        skills: './skills/',
        interface: { displayName: 'Codex Kit', defaultPrompt: 'Try it' },
      },
      'skills/gamma/SKILL.md': skillMarkdown('gamma', 'Third'),
      '.mcp.json': {
        mcpServers: {
          local: { command: 'node', args: ['server.js'] },
          remote: { url: 'https://remote.example/mcp' },
        },
      },
      '.app.json': { apps: { drive: {} } },
      'hooks/hooks.json': CODEX_HOOKS,
    })
    const resolved = resolveStrict(root)
    expect(resolved).toMatchObject({
      pluginId: 'codex-kit',
      format: 'codex-compat',
      version: '2.0.0',
      displayName: 'Codex Kit',
      description: 'Codex only',
      prompts: ['Try it'],
    })
    expect(resolved.mcpServers).toEqual([
      {
        name: 'local',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
      },
      { name: 'remote', transport: 'http', url: 'https://remote.example/mcp' },
    ])
    expect(summary(root).components).toEqual([
      ['skill', 'gamma', 'available'],
      ['mcp', 'local', 'available'],
      ['mcp', 'remote', 'available'],
      ['app', 'drive', 'unsupported'],
      ['hook', 'PreToolUse#1', 'available'],
      ['hook', 'SessionEnd#1', 'unsupported'],
    ])
  })

  it('accepts inline hooks and MCP servers in the manifest', () => {
    const root = packageAt({
      '.codex-plugin/plugin.json': {
        name: 'inline-kit',
        mcpServers: { files: { command: 'files' } },
        hooks: [CODEX_HOOKS],
      },
    })
    const resolved = resolveStrict(root)
    expect(resolved.mcpServers.map((server) => server.name)).toEqual(['files'])
    expect(resolved.hooks).toHaveLength(2)
  })
})

describe('emperor-v1 packages', () => {
  it('reads the old manifest unchanged and lists agents, commands and LSP as unsupported', () => {
    const root = packageAt({
      '.emperor-plugin/plugin.json': {
        schemaVersion: 1,
        id: 'official/agent-reach',
        name: 'Agent Reach',
        version: '1.0.0',
        description: 'Reach the web',
        skills: ['skills'],
        agents: ['agents/scout.md'],
        commands: ['commands'],
        lspServers: ['lsp.json'],
        hooks: ['hooks.json'],
        mcpServers: ['servers.json'],
      },
      'skills/agent-reach/SKILL.md': skillMarkdown(
        'agent-reach',
        'Reach the web',
      ),
      'agents/scout.md': '# Scout',
      'commands/run.md': '# Run',
      'lsp.json': '{}',
      'hooks.json': {
        hooks: {
          PreToolUse: [
            {
              matcher: 'bash',
              hooks: [{ type: 'command', command: 'guard.sh' }],
            },
          ],
        },
      },
      'servers.json': { mcpServers: { reach: { command: 'reach' } } },
    })
    const resolved = resolveStrict(root)
    expect(resolved).toMatchObject({
      pluginId: 'official/agent-reach',
      format: 'emperor-v1',
      version: '1.0.0',
      displayName: 'Agent Reach',
      description: 'Reach the web',
      skillRoots: [join(root, 'skills')],
    })
    expect(resolved.hooks[0]!.mapped).toEqual({
      event: 'PreToolUse',
      matcher: 'bash',
    })
    expect(summary(root).components).toEqual([
      ['skill', 'agent-reach', 'available'],
      ['mcp', 'reach', 'available'],
      ['hook', 'PreToolUse#1', 'available'],
      ['agent', 'agents/scout.md', 'unsupported'],
      ['command', 'commands', 'unsupported'],
      ['lsp', 'lsp.json', 'unsupported'],
    ])
  })
})

describe('package errors', () => {
  it('finds the shallowest root and treats deeper manifests as content', () => {
    const top = packageAt({
      ...Object.fromEntries(
        Object.entries(
          portablePackage('outer-kit', {
            'examples/demo/plugin.json': {
              $schema: PLUGIN_SCHEMA_URL,
              name: 'demo',
            },
          }),
        ).map(([path, value]) => [`outer/${path}`, value]),
      ),
    })
    expect(findPluginPackageRoot(top)).toBe(join(top, 'outer'))
    expect(findPluginPackageRoot(join(top, 'outer'))).toBe(join(top, 'outer'))
  })

  it('rejects two package roots on the same layer', () => {
    const top = packageAt({
      'one/plugin.json': { $schema: PLUGIN_SCHEMA_URL, name: 'one' },
      'two/.codex-plugin/plugin.json': { name: 'two' },
    })
    expect(errorCode(() => findPluginPackageRoot(top))).toBe(
      'plugin_preview_multiple_roots',
    )
  })

  it('reports a missing manifest and a plugin.json without the agent-plugins schema', () => {
    expect(
      errorCode(() => findPluginPackageRoot(packageAt({ 'README.md': 'x' }))),
    ).toBe('plugin_preview_manifest_missing')
    expect(
      errorCode(() =>
        findPluginPackageRoot(packageAt({ 'plugin.json': { name: 'x' } })),
      ),
    ).toBe('plugin_preview_manifest_invalid')
  })

  it.each<[string, PackageFiles, string]>([
    [
      'identity mismatch',
      portablePackage('a-kit', {
        '.codex-plugin/plugin.json': { name: 'b-kit' },
      }),
      'plugin_preview_identity_mismatch',
    ],
    [
      'unknown schema version',
      {
        'plugin.json': {
          $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json',
          name: 'next-kit',
        },
      },
      'plugin_preview_schema_unsupported',
    ],
    [
      'invalid name',
      portablePackage('Bad_Name'),
      'plugin_preview_name_invalid',
    ],
    [
      'path escape',
      {
        '.codex-plugin/plugin.json': {
          name: 'escape-kit',
          skills: '../outside',
        },
      },
      'plugin_preview_path_unsafe',
    ],
    [
      'absolute path',
      {
        '.codex-plugin/plugin.json': {
          name: 'abs-kit',
          apps: '/etc/apps.json',
        },
      },
      'plugin_preview_path_unsafe',
    ],
    [
      'missing member file',
      {
        '.codex-plugin/plugin.json': {
          name: 'gone-kit',
          mcpServers: './gone.json',
        },
      },
      'plugin_preview_member_invalid',
    ],
    [
      'unparseable member file',
      portablePackage('broken-kit', { 'mcp.json': '{nope' }),
      'plugin_preview_member_invalid',
    ],
    [
      'unparseable manifest',
      { '.codex-plugin/plugin.json': '{nope' },
      'plugin_preview_manifest_invalid',
    ],
    [
      'duplicate Skill names across sources',
      {
        '.codex-plugin/plugin.json': {
          name: 'dup-kit',
          skills: ['./a', './b'],
        },
        'a/same/SKILL.md': skillMarkdown('same', 'One'),
        'b/same/SKILL.md': skillMarkdown('same', 'Two'),
      },
      'plugin_preview_duplicate_member',
    ],
    [
      'duplicate MCP servers across files',
      {
        '.emperor-plugin/plugin.json': {
          schemaVersion: 1,
          id: 'dup/mcp',
          name: 'Dup',
          version: '1.0.0',
          mcpServers: ['one.json', 'two.json'],
        },
        'one.json': { mcpServers: { same: { command: 'a' } } },
        'two.json': { mcpServers: { same: { command: 'b' } } },
      },
      'plugin_preview_duplicate_member',
    ],
  ])('fails the preview for %s', (_name, files, code) => {
    const root = packageAt(files)
    expect(errorCode(() => resolveStrict(findPluginPackageRoot(root)))).toBe(
      code,
    )
  })

  it('rejects a symlinked member that points outside the package', () => {
    const outside = packageAt({
      'same/SKILL.md': skillMarkdown('same', 'Outside'),
    })
    const root = packageAt({
      '.codex-plugin/plugin.json': { name: 'link-kit', skills: './linked' },
    })
    symlinkSync(outside, join(root, 'linked'))
    expect(errorCode(() => resolveStrict(root))).toBe(
      'plugin_preview_path_unsafe',
    )
  })

  it('keeps an installed package usable when one member breaks', () => {
    const root = packageAt(
      portablePackage('lenient-kit', {
        'skills/fine/SKILL.md': skillMarkdown('fine', 'Still works'),
        'mcp.json': '{nope',
      }),
    )
    expect(errorCode(() => resolveStrict(root))).toBe(
      'plugin_preview_member_invalid',
    )
    const resolved = resolvePluginPackage(root, { strict: false })
    expect(
      resolved.components.map(({ kind, id, state }) => [kind, id, state]),
    ).toEqual([
      ['skill', 'fine', 'available'],
      ['mcp', 'mcp.json', 'failed'],
    ])
    expect(resolved.components[1]!.reason).toContain('无法解析')
  })

  it('reports a logo outside assets/ without failing the package', () => {
    const root = packageAt(
      portablePackage(
        'logo-kit',
        { 'logo.png': 'png' },
        {
          extensions: { 'com.openai': { interface: { logo: './logo.png' } } },
        },
      ),
    )
    expect(resolveStrict(root)).toMatchObject({
      logoPath: null,
      logoIssue: 'Logo 必须是包内 ./assets/ 下的文件',
    })
  })
})

describe('determinism', () => {
  it('resolves copies of a package to the same result', () => {
    const first = packageAt(
      portablePackage('stable-kit', {
        'skills/b/SKILL.md': skillMarkdown('b', 'B'),
        'skills/a/SKILL.md': skillMarkdown('a', 'A'),
        'hooks/hooks.json': CODEX_HOOKS,
        'mcp.json': {
          $schema: MCP_SCHEMA_URL,
          mcpServers: {
            z: { type: 'stdio', command: 'z' },
            y: { type: 'sse', url: 'https://y.example' },
          },
        },
      }),
    )
    const second = join(tempDirectory(), 'copy')
    mkdirSync(second)
    cpSync(first, second, { recursive: true })
    const strip = (root: string) => {
      const {
        rootPath: _root,
        manifestPath: _manifest,
        skillRoots: _skills,
        ...rest
      } = resolveStrict(root)
      return {
        ...rest,
        components: rest.components.map(
          ({ sourcePath: _source, ...component }) => component,
        ),
      }
    }
    expect(strip(second)).toEqual(strip(first))
  })

  it('derives cache segments from versions', () => {
    expect(pluginVersionSegment(null)).toBe('unversioned')
    expect(pluginVersionSegment('1.0.0')).toBe('1.0.0')
    expect(pluginVersionSegment('1.0.0+build.5')).toBe('1.0.0_build.5')
    expect(pluginVersionSegment('.hidden')).toBe('v.hidden')
    expect(pluginVersionSegment('版本 2')).toBe('v___2')
  })
})
