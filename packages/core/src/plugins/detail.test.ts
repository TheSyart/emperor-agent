import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NO_PLUGIN_RUNTIME,
  pathScrubber,
  pluginComponentViews,
  pluginPermissions,
  type PluginPackageVerdict,
} from './detail'
import { resolvePluginPackage } from './manifest-resolver'
import type { PluginMcpRuntimeState, PluginRuntimeView } from './models'
import {
  MCP_SCHEMA_URL,
  portablePackage,
  skillMarkdown,
  tempDirectory,
  writePackage,
  type PackageFiles,
} from './testing'

const HOOKS = {
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'check.sh' }] }],
    PostToolUse: [
      { matcher: 'NotebookEdit', hooks: [{ command: 'notebook.sh' }] },
    ],
  },
}

function kit(files: PackageFiles = {}) {
  const root = writePackage(
    tempDirectory(),
    portablePackage(
      'state-kit',
      {
        'skills/alpha/SKILL.md': skillMarkdown('alpha', 'First'),
        'skills/beta/SKILL.md': skillMarkdown('beta', 'Second'),
        'mcp.json': {
          $schema: MCP_SCHEMA_URL,
          mcpServers: {
            files: { type: 'stdio', command: 'files' },
            search: {
              type: 'streamable-http',
              url: 'https://search.example/mcp',
              headers: { authorization: 'Bearer secret-token' },
            },
          },
        },
        'hooks/hooks.json': HOOKS,
        '.app.json': { apps: { calendar: {} } },
        ...files,
      },
      { extensions: { 'com.openai': { apps: './.app.json' } } },
    ),
  )
  return resolvePluginPackage(root, { strict: false })
}

function views(
  resolved: ReturnType<typeof kit>,
  verdict: PluginPackageVerdict = { kind: 'active' },
  runtime: PluginRuntimeView = NO_PLUGIN_RUNTIME,
) {
  return pluginComponentViews({
    pluginId: 'state-kit',
    scope: 'user',
    resolved,
    verdict,
    projectRoot: null,
    runtime,
  })
}

function states(list: ReturnType<typeof views>) {
  return list.map(({ kind, id, state, reason }) => [kind, id, state, reason])
}

function mcpRuntime(
  byServer: Record<string, PluginMcpRuntimeState | null>,
): PluginRuntimeView {
  return {
    mcpServer: (_plugin, _scope, server) => byServer[server] ?? null,
    effectiveSkills: () => new Map(),
  }
}

describe('plugin member states', () => {
  it('gives every member of an active package its own state and reason', () => {
    const resolved = kit()
    expect(
      states(
        views(
          resolved,
          { kind: 'active' },
          mcpRuntime({
            files: { state: 'ready', toolCount: 3 },
            search: { state: 'auth_failed' },
          }),
        ),
      ),
    ).toEqual([
      ['skill', 'alpha', 'available', null],
      ['skill', 'beta', 'available', null],
      ['mcp', 'files', 'running', null],
      ['mcp', 'search', 'needs_connection', '需要登录或凭据'],
      ['app', 'calendar', 'unsupported', 'Emperor 还不支持这个应用连接'],
      ['hook', 'PreToolUse#1', 'available', null],
      [
        'hook',
        'PostToolUse#1',
        'unsupported',
        'Emperor 没有与「NotebookEdit」对应的工具',
      ],
    ])
  })

  it('maps live MCP facts', () => {
    const resolved = kit()
    const state = (live: PluginMcpRuntimeState | null) =>
      views(resolved, { kind: 'active' }, mcpRuntime({ files: live })).find(
        (view) => view.id === 'files',
      )!
    expect(state(null)).toMatchObject({ state: 'starting', reason: '正在连接' })
    expect(state({ state: 'connecting' })).toMatchObject({ state: 'starting' })
    expect(
      state({ state: 'failed', lastError: 'spawn files ENOENT' }),
    ).toMatchObject({
      state: 'failed',
      reason: 'spawn files ENOENT',
    })
    expect(state({ state: 'backoff' })).toMatchObject({
      state: 'failed',
      reason: '连接失败',
    })
    expect(
      state({ state: 'connecting', blocked: '需要环境变量 API_KEY' }),
    ).toMatchObject({
      state: 'needs_connection',
      reason: '需要环境变量 API_KEY',
    })
    expect(
      state({ state: 'ready', skippedTools: ['read', 'write'] }),
    ).toMatchObject({
      state: 'running',
      reason: '已跳过重名工具：read、write',
    })
  })

  it('fails a Skill that loses a name clash and leaves its siblings alone', () => {
    const resolved = kit()
    const runtime: PluginRuntimeView = {
      mcpServer: () => ({ state: 'ready' }),
      effectiveSkills: () =>
        new Map([
          [
            'alpha',
            {
              source: 'user' as const,
              skillFile: '/home/me/.emperor/skills/alpha/SKILL.md',
            },
          ],
          [
            'beta',
            {
              source: 'plugin' as const,
              skillFile: join(resolved.rootPath, 'skills', 'beta', 'SKILL.md'),
            },
          ],
        ]),
    }
    expect(
      states(views(resolved, { kind: 'active' }, runtime)).slice(0, 2),
    ).toEqual([
      ['skill', 'alpha', 'failed', '与个人的同名 Skill 冲突，未生效'],
      ['skill', 'beta', 'available', null],
    ])
  })

  it.each<[PluginPackageVerdict, string, string]>([
    [{ kind: 'disabled' }, 'disabled', '插件已停用'],
    [{ kind: 'blocked_unverified' }, 'unsupported', '来源未验证，成员不会运行'],
    [
      { kind: 'shadowed', by: 'project' },
      'disabled',
      '已由项目范围的同一插件提供',
    ],
  ])(
    'lets the package verdict %j decide every member',
    (verdict, state, reason) => {
      const list = views(
        kit(),
        verdict,
        mcpRuntime({ files: { state: 'ready' } }),
      )
      expect(list).toHaveLength(7)
      expect(
        new Set(list.map((view) => `${view.state}:${view.reason}`)),
      ).toEqual(new Set([`${state}:${reason}`]))
    },
  )

  it('lists no members when the content is missing', () => {
    expect(views(kit(), { kind: 'missing' })).toEqual([])
    expect(views(null as never)).toEqual([])
  })

  it('keeps one broken member from hiding the others', () => {
    const resolved = kit({ 'mcp.json': '{nope' })
    expect(
      states(views(resolved)).map(([kind, id, state]) => [kind, id, state]),
    ).toEqual([
      ['skill', 'alpha', 'available'],
      ['skill', 'beta', 'available'],
      ['mcp', 'mcp.json', 'failed'],
      ['app', 'calendar', 'unsupported'],
      ['hook', 'PreToolUse#1', 'available'],
      ['hook', 'PostToolUse#1', 'unsupported'],
    ])
  })

  it('never shows the package path or a server secret', () => {
    const resolved = kit({
      'hooks/hooks.json': {
        hooks: {
          Stop: [
            { hooks: [{ command: `${join(tempDirectory(), 'x')} && echo` }] },
          ],
        },
      },
    })
    const withRootCommand = {
      ...resolved,
      components: resolved.components.map((component) =>
        component.kind === 'hook'
          ? {
              ...component,
              description: `python3 ${resolved.rootPath}/hooks/stop.py`,
            }
          : component,
      ),
    }
    const text = JSON.stringify(
      views(
        withRootCommand,
        { kind: 'active' },
        mcpRuntime({
          files: {
            state: 'failed',
            lastError: `cannot open ${resolved.rootPath}/bin/files`,
          },
        }),
      ),
    )
    expect(text).not.toContain(resolved.rootPath)
    expect(text).toContain('python3 hooks/stop.py')
    expect(text).toContain('cannot open bin/files')
    expect(text).not.toContain('secret-token')
    expect(pathScrubber(resolved.rootPath)(resolved.rootPath)).toBe(
      '${PLUGIN_ROOT}',
    )
  })

  it('reports what an active package may do', () => {
    expect(pluginPermissions(kit())).toEqual({
      runsCommands: true,
      network: true,
      env: [],
    })
    const quiet = resolvePluginPackage(
      writePackage(
        tempDirectory(),
        portablePackage('quiet-kit', {
          'skills/only/SKILL.md': skillMarkdown('only', 'Only'),
        }),
      ),
      { strict: true },
    )
    expect(pluginPermissions(quiet)).toEqual({
      runsCommands: false,
      network: false,
      env: [],
    })
    expect(pluginPermissions(null)).toEqual({
      runsCommands: false,
      network: false,
      env: [],
    })
  })

  it('names the variables its manifest lets its hooks read (SEC-07)', () => {
    const declared = resolvePluginPackage(
      writePackage(
        tempDirectory(),
        portablePackage(
          'env-kit',
          { 'hooks/hooks.json': HOOKS },
          { env: ['ACME_TOKEN'] },
        ),
      ),
      { strict: true },
    )
    expect(pluginPermissions(declared)).toEqual({
      runsCommands: true,
      network: false,
      env: ['ACME_TOKEN'],
    })
  })

  it('shows a failed hook with its reason and the variables it may need (SEC-07)', () => {
    const runtime: PluginRuntimeView = {
      ...NO_PLUGIN_RUNTIME,
      hookFailure: (pluginId, hookId) =>
        pluginId === 'state-kit' && hookId === 'PreToolUse#1'
          ? {
              reason: '最近一次运行失败（退出码 1）：ACME_TOKEN is not set',
              variables: [{ name: 'ACME_TOKEN', state: 'undeclared' }],
            }
          : null,
    }
    const hooks = views(kit(), { kind: 'active' }, runtime).filter(
      (view) => view.kind === 'hook',
    )
    expect(hooks).toEqual([
      expect.objectContaining({
        id: 'PreToolUse#1',
        state: 'failed',
        reason: '最近一次运行失败（退出码 1）：ACME_TOKEN is not set',
        variables: [{ name: 'ACME_TOKEN', state: 'undeclared' }],
      }),
      expect.objectContaining({ id: 'PostToolUse#1', state: 'unsupported' }),
    ])
    expect(hooks[1]).not.toHaveProperty('variables')
    // A stopped package shows no stale failure.
    expect(
      views(kit(), { kind: 'disabled' }, runtime).find(
        (view) => view.id === 'PreToolUse#1',
      ),
    ).toMatchObject({ state: 'disabled', reason: '插件已停用' })
  })
})
