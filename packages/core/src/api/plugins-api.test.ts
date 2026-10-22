import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invokeCoreOperation } from './operations'
import { makeApi, tmp, type ApiFixture } from './test-helpers'
import {
  MCP_SCHEMA_URL,
  portablePackage,
  skillMarkdown,
  STDIO_MCP_SERVER,
  writePackage,
  type PackageFiles,
} from '../plugins/testing'

/** The renderer shows no session (KRN-01 view scope). */
const VIEW = { sessionId: null }

let fixture: ApiFixture | null = null

afterEach(async () => {
  vi.unstubAllEnvs()
  await fixture?.api.close()
  fixture = null
})

async function installKit(api: ApiFixture['api']) {
  const source = writePackage(
    join(tmp('emperor-plugin-api-'), 'hello-kit'),
    portablePackage('hello-kit', {
      'skills/hello/SKILL.md': skillMarkdown('hello', 'Say hello'),
      'skills/wave/SKILL.md': skillMarkdown('wave', 'Wave'),
    }),
  )
  const preview = await api.plugins.inspect({ kind: 'local', path: source })
  return api.plugins.install(
    {
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    },
    VIEW,
  )
}

describe('plugins through CoreApi', () => {
  it('serves the detail, feeds the Skill catalog and announces changes', async () => {
    fixture = await makeApi()
    const { api, events } = fixture
    await installKit(api)

    expect(events).toContainEqual(
      expect.objectContaining({ event: 'plugins_changed', reason: 'plugins' }),
    )
    const names = () => api.skills.list(VIEW).skills.map((skill) => skill.name)
    expect(names()).toEqual(expect.arrayContaining(['hello', 'wave']))
    const detail = await invokeCoreOperation(
      api,
      'plugins.getDetail',
      [{ pluginId: 'hello-kit', scope: 'user' }],
      { view: VIEW },
    )
    expect(detail).toMatchObject({
      pluginId: 'hello-kit',
      format: 'portable',
      activation: 'active',
      components: [
        { kind: 'skill', id: 'hello', state: 'available' },
        { kind: 'skill', id: 'wave', state: 'available' },
      ],
    })

    events.length = 0
    api.plugins.setEnabled(
      {
        pluginId: 'hello-kit',
        scope: 'user',
        enabled: false,
      },
      VIEW,
    )
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'plugins_changed', reason: 'plugins' }),
    )
    expect(names()).not.toContain('hello')
  })

  it('marks a plugin Skill that a personal Skill of the same name overrides', async () => {
    fixture = await makeApi()
    const { api, stateRoot } = fixture
    mkdirSync(join(stateRoot, 'skills', 'hello'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'hello', 'SKILL.md'),
      skillMarkdown('hello', 'Mine'),
    )
    await installKit(api)
    expect(
      (
        await api.plugins.getDetail(
          { pluginId: 'hello-kit', scope: 'user' },
          VIEW,
        )
      ).components.map(({ id, state, reason }) => [id, state, reason]),
    ).toEqual([
      ['hello', 'failed', '与个人的同名 Skill 冲突，未生效'],
      ['wave', 'available', null],
    ])
  })

  it('rejects an unknown plugin with a stable code', async () => {
    fixture = await makeApi()
    await expect(
      fixture!.api.plugins.getDetail(
        { pluginId: 'nobody', scope: 'user' },
        VIEW,
      ),
    ).rejects.toMatchObject({ code: 'plugin_not_found' })
  })
})

const WHERE_KIT: PackageFiles = portablePackage('where-kit', {
  'server.js': STDIO_MCP_SERVER,
  'mcp.json': {
    $schema: MCP_SCHEMA_URL,
    mcpServers: {
      where: {
        type: 'stdio',
        command: process.execPath,
        args: ['${PLUGIN_ROOT}/server.js'],
      },
    },
  },
  'hooks/hooks.json': {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'echo "$PLUGIN_ROOT" >> "$PLUGIN_DATA/hook.log"',
            },
          ],
        },
      ],
    },
  },
})

const TOOL = 'mcp_where-kit-where_where'

function bashTurn(id: string) {
  return [
    {
      tools: [
        {
          id,
          name: 'bash',
          args: { command: `echo ${id}`, description: 'Print a word' },
        },
      ],
    },
    { text: 'done' },
  ]
}

describe('packages shipped with Emperor through CoreApi', () => {
  it('lists them as managed, keeps their toggles across restarts and refuses to uninstall them', async () => {
    const root = tmp('emperor-plugin-bundled-')
    writePackage(
      join(root, 'bundled-plugins', 'github'),
      portablePackage('github', {}, { version: '1.0.0' }),
    )
    writePackage(
      join(root, 'bundled-plugins', 'computer-use'),
      portablePackage('computer-use'),
    )
    fixture = await makeApi({ root })
    const { api, stateRoot } = fixture
    const rows = () =>
      fixture!.api.plugins
        .list(VIEW)
        .map(({ pluginId, scope, enabled, toggleable, uninstallable }) => [
          pluginId,
          scope,
          enabled,
          toggleable,
          uninstallable,
        ])
    // This host runs without Computer Use, so its package cannot be switched on.
    expect(rows()).toEqual([
      ['computer-use', 'managed', false, false, false],
      ['github', 'managed', true, true, false],
    ])
    await invokeCoreOperation(
      api,
      'plugins.setEnabled',
      [{ pluginId: 'github', scope: 'managed', enabled: false }],
      { view: VIEW },
    )
    await expect(
      invokeCoreOperation(
        api,
        'plugins.uninstall',
        [{ pluginId: 'github', scope: 'managed' }],
        { view: VIEW },
      ),
    ).rejects.toMatchObject({ code: 'plugin_managed_uninstall_denied' })
    await expect(
      invokeCoreOperation(api, 'plugins.install', [
        {
          previewId: `plugin_preview_${'a'.repeat(24)}`,
          digest: 'a'.repeat(64),
          scope: 'managed',
        },
      ]),
    ).rejects.toMatchObject({ name: 'CoreOperationArgumentsError' })

    await api.close()
    fixture = await makeApi({ root, stateRoot })
    expect(rows()[1]).toEqual(['github', 'managed', false, true, false])
  })
})

/** No real gh in unit tests: an absent CLI, or a scripted one. */
const NO_GH = { github: { resolveRuntime: async () => null } }

describe('GitHub reads through CoreApi', () => {
  it('serves Issue and CI reads only while the GitHub plugin is on', async () => {
    const root = tmp('emperor-plugin-github-')
    writePackage(
      join(root, 'bundled-plugins', 'github'),
      portablePackage('github', {}, { version: '1.0.0' }),
    )
    fixture = await makeApi({ root, extra: NO_GH })
    const { api } = fixture
    // On: the call reaches gh (none in this sandbox), not the plugin gate.
    await expect(
      invokeCoreOperation(api, 'github.listIssues', [{ filter: 'assigned' }]),
    ).rejects.toMatchObject({ code: 'pull_request_gh_missing' })
    await api.plugins.setEnabled(
      {
        pluginId: 'github',
        scope: 'managed',
        enabled: false,
      },
      VIEW,
    )
    for (const [key, input] of [
      ['github.listIssues', {}],
      ['github.viewIssue', { repo: 'acme/widgets', number: 1 }],
      ['github.listRuns', { repo: 'acme/widgets' }],
      ['github.viewRun', { repo: 'acme/widgets', runId: 1 }],
    ] as const)
      await expect(
        invokeCoreOperation(api, key, [input]),
      ).rejects.toMatchObject({
        code: 'github_plugin_disabled',
      })
  })

  it('shows whether the GitHub plugin can reach gh in its detail', async () => {
    const root = tmp('emperor-plugin-github-')
    writePackage(
      join(root, 'bundled-plugins', 'github'),
      portablePackage(
        'github',
        { '.app.json': { apps: { github: { title: 'GitHub（本机 gh）' } } } },
        { extensions: { 'com.openai': { apps: './.app.json' } } },
      ),
    )
    fixture = await makeApi({ root, extra: NO_GH })
    const detail = await fixture.api.plugins.getDetail(
      {
        pluginId: 'github',
        scope: 'managed',
      },
      VIEW,
    )
    expect(detail.components).toEqual([
      expect.objectContaining({
        kind: 'app',
        id: 'github',
        state: 'needs_connection',
        reason: expect.stringContaining('gh'),
      }),
    ])
    await fixture.api.close()

    // A logged-in gh: the member is available and names the account.
    fixture = await makeApi({
      root,
      extra: {
        github: {
          resolveRuntime: async () => ({
            executable: '/fake/gh',
            env: {},
            version: '2.73.0',
          }),
          run: async () => ({ exitCode: 0, stdout: 'octo-dev\n', stderr: '' }),
        },
      },
    })
    expect(
      (
        await fixture.api.plugins.getDetail(
          {
            pluginId: 'github',
            scope: 'managed',
          },
          VIEW,
        )
      ).components[0],
    ).toMatchObject({ state: 'available', reason: '已登录 octo-dev' })

    // Another package's app of the same name is not the shipped GitHub app:
    // it stays unsupported instead of borrowing the gh login.
    const source = writePackage(
      join(tmp('emperor-plugin-app-'), 'lookalike'),
      portablePackage(
        'lookalike',
        { '.app.json': { apps: { github: { title: 'GitHub' } } } },
        { extensions: { 'com.openai': { apps: './.app.json' } } },
      ),
    )
    const preview = await fixture.api.plugins.inspect({
      kind: 'local',
      path: source,
    })
    await fixture.api.plugins.install(
      {
        previewId: preview.previewId,
        digest: preview.digest,
        scope: 'user',
      },
      VIEW,
    )
    expect(
      (
        await fixture.api.plugins.getDetail(
          {
            pluginId: 'lookalike',
            scope: 'user',
          },
          VIEW,
        )
      ).components,
    ).toEqual([
      expect.objectContaining({
        kind: 'app',
        id: 'github',
        state: 'unsupported',
      }),
    ])
  })
})

describe('plugin MCP servers and hooks through CoreApi', () => {
  it('runs them for real, stops them when disabled, and never touches user files', async () => {
    fixture = await makeApi({ replies: [...bashTurn('b1'), ...bashTurn('b2')] })
    const { api, stateRoot } = fixture
    const userMcp = join(stateRoot, 'mcp_config.json')
    const userHooks = join(stateRoot, 'hooks.json')
    writeFileSync(userMcp, JSON.stringify({ servers: {} }))
    writeFileSync(userHooks, JSON.stringify({ hooks: {} }))
    const before = [
      readFileSync(userMcp, 'utf8'),
      readFileSync(userHooks, 'utf8'),
    ]

    const source = writePackage(
      join(tmp('emperor-plugin-api-'), 'where-kit'),
      WHERE_KIT,
    )
    const preview = await api.plugins.inspect({ kind: 'local', path: source })
    await api.plugins.install(
      {
        previewId: preview.previewId,
        digest: preview.digest,
        scope: 'user',
      },
      VIEW,
    )

    // MCP: a real stdio server, started in the package with its variables.
    expect(api.host.tools.names()).toContain(TOOL)
    const adapter = api.host.kept.mcpClient
      .getTools()
      .find((tool) => tool.name === TOOL)!
    const where = JSON.parse(
      (await adapter.execute({ note: 'one' })).rawContent,
    ) as {
      cwd: string
      root: string
    }
    expect(
      api.skills.tools(VIEW).find((tool) => tool.name === TOOL),
    ).toMatchObject({
      source: 'mcp',
      server: 'where-kit-where',
      plugin_id: 'where-kit',
    })
    const packageRoot = realpathSync(where.root)
    expect(
      packageRoot.startsWith(realpathSync(join(stateRoot, 'plugins', 'cache'))),
    ).toBe(true)
    expect(realpathSync(where.cwd)).toBe(packageRoot)
    const data = join(stateRoot, 'plugins', 'data', 'where-kit')
    expect(readFileSync(join(data, 'calls.log'), 'utf8')).toBe('one\n')
    expect(
      (
        await api.plugins.getDetail(
          { pluginId: 'where-kit', scope: 'user' },
          VIEW,
        )
      ).components.map(({ kind, state }) => [kind, state]),
    ).toEqual([
      ['mcp', 'running'],
      ['hook', 'available'],
    ])

    // Hook: runs on a real bash call with this plugin's variables.
    const sessionId = String(api.sessions.create({ title: 'Chat' }).id)
    await api.chat.submit({ content: 'run', sessionId })
    expect(readFileSync(join(data, 'hook.log'), 'utf8')).toBe(`${where.root}\n`)

    // Disabled: the tool and the hook are gone, and nothing new happens.
    await api.plugins.setEnabled(
      {
        pluginId: 'where-kit',
        scope: 'user',
        enabled: false,
      },
      VIEW,
    )
    expect(api.host.tools.names()).not.toContain(TOOL)
    expect(
      api.host.kept.mcpClient.pluginServerSnapshot('where-kit-where'),
    ).toBeNull()
    expect(api.host.hooks.describe().plugins).toEqual([])
    await api.chat.submit({ content: 'again', sessionId })
    expect(readFileSync(join(data, 'hook.log'), 'utf8')).toBe(`${where.root}\n`)
    expect(readFileSync(join(data, 'calls.log'), 'utf8')).toBe('one\n')

    // Enabled again: registered exactly once.
    await api.plugins.setEnabled(
      {
        pluginId: 'where-kit',
        scope: 'user',
        enabled: true,
      },
      VIEW,
    )
    expect(api.host.tools.names().filter((name) => name === TOOL)).toHaveLength(
      1,
    )
    expect(api.host.hooks.describe().plugins).toEqual(['where-kit@user'])

    expect([
      readFileSync(userMcp, 'utf8'),
      readFileSync(userHooks, 'utf8'),
    ]).toEqual(before)
  })

  it('never runs members of an unverified URL package', async () => {
    const archive = writePackage(
      join(tmp('emperor-plugin-url-'), 'where-kit'),
      WHERE_KIT,
    )
    const zipped = zipDirectory(archive)
    fixture = await makeApi({
      extra: {
        webFetchClient: {
          get: async () => ({
            kind: 'response' as const,
            status: 200,
            url: 'https://plugins.example/where-kit.zip',
            headers: {},
            body: zipped,
          }),
        },
      },
    })
    const { api } = fixture
    const preview = await api.plugins.inspect({
      kind: 'url',
      url: 'https://plugins.example/where-kit.zip',
    })
    await api.plugins.install(
      {
        previewId: preview.previewId,
        digest: preview.digest,
        scope: 'user',
      },
      VIEW,
    )
    expect(api.plugins.list(VIEW)[0]).toMatchObject({
      activation: 'blocked_unverified',
    })
    expect(api.host.tools.names()).not.toContain(TOOL)
    expect(api.host.hooks.describe().plugins).toEqual([])
  })

  // The detail's 工具 (PLAN-CAP-001 ST-09): each MCP member's tools while
  // its server runs, and a plain word when it does not.
  it('lists an MCP member’s tools in the detail while its server runs', async () => {
    fixture = await makeApi()
    const { api } = fixture
    const source = writePackage(
      join(tmp('emperor-plugin-api-'), 'where-kit'),
      WHERE_KIT,
    )
    const preview = await api.plugins.inspect({ kind: 'local', path: source })
    await api.plugins.install(
      {
        previewId: preview.previewId,
        digest: preview.digest,
        scope: 'user',
      },
      VIEW,
    )
    const tools = async () =>
      (
        await api.plugins.getDetail(
          { pluginId: 'where-kit', scope: 'user' },
          VIEW,
        )
      ).tools

    expect(await tools()).toEqual({
      note: null,
      groups: [
        {
          id: 'where',
          kind: 'mcp',
          title: 'where',
          note: null,
          tools: [
            {
              name: TOOL,
              description:
                '[MCP:where-kit-where] Report where the server runs.',
              parameters: {
                type: 'object',
                properties: { note: { type: 'string' } },
              },
              readOnly: false,
            },
          ],
        },
      ],
    })

    await api.plugins.setEnabled(
      {
        pluginId: 'where-kit',
        scope: 'user',
        enabled: false,
      },
      VIEW,
    )
    expect((await tools()).groups).toEqual([
      {
        id: 'where',
        kind: 'mcp',
        title: 'where',
        note: '服务器没有运行',
        tools: [],
      },
    ])
  })
})

/** A plugin whose hook logs every bash call into its data folder. */
const HOOK_KIT: PackageFiles = portablePackage('hook-kit', {
  'hooks/hooks.json': {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'echo fired >> "$PLUGIN_DATA/hook.log"',
            },
          ],
        },
      ],
    },
  },
})

async function installAs(
  api: ApiFixture['api'],
  files: PackageFiles,
  name: string,
  scope: 'user' | 'project',
  view: { sessionId: string | null },
): Promise<void> {
  const source = writePackage(join(tmp('emperor-sec07-'), name), files)
  const preview = await api.plugins.inspect({ kind: 'local', path: source })
  await api.plugins.install(
    { previewId: preview.previewId, digest: preview.digest, scope },
    view,
  )
}

function projectIntents(stateRoot: string, project: string): string {
  const id = createHash('sha256')
    .update(realpathSync(project), 'utf8')
    .digest('hex')
    .slice(0, 16)
  return join(stateRoot, 'projects', id, 'plugins.json')
}

describe('plugin trust through CoreApi (SEC-07)', () => {
  it('6–7: the Agent writing .emperor/settings.json only suggests; the user’s confirmation enables it, kept in stateRoot', async () => {
    fixture = await makeApi({
      replies: [
        // In project B the Agent turns the plugin on in the repository file.
        {
          tools: [
            {
              id: 'w1',
              name: 'write',
              args: {
                file_path: '.emperor/settings.json',
                content: '{"enabledPlugins":{"hook-kit":true}}\n',
              },
            },
          ],
        },
        ...bashTurn('b1'),
        ...bashTurn('b2'),
      ],
    })
    const { api, stateRoot } = fixture
    const projectA = realpathSync(tmp('emperor-sec07-a-'))
    const projectB = realpathSync(tmp('emperor-sec07-b-'))
    const a = api.sessions.create({
      title: 'A',
      mode: 'build',
      project_path: projectA,
    })
    const b = api.sessions.create({
      title: 'B',
      mode: 'build',
      project_path: projectB,
    })
    const viewB = { sessionId: String(b.id) }
    await installAs(api, HOOK_KIT, 'hook-kit', 'project', {
      sessionId: String(a.id),
    })
    const log = join(stateRoot, 'plugins', 'data', 'hook-kit', 'hook.log')
    const row = async () =>
      (
        await invokeCoreOperation(api, 'plugins.list', [], { view: viewB })
      ).find(
        (plugin) =>
          plugin.pluginId === 'hook-kit' && plugin.scope === 'project',
      )!

    await api.chat.submit({ content: 'turn it on', sessionId: String(b.id) })
    expect(
      readFileSync(join(projectB, '.emperor', 'settings.json'), 'utf8'),
    ).toContain('hook-kit')
    // The bash call after the write: the plugin's hook did not run.
    expect(existsSync(log)).toBe(false)
    expect(await row()).toMatchObject({
      enabled: false,
      activation: 'disabled',
      suggested: true,
    })

    await invokeCoreOperation(
      api,
      'plugins.setEnabled',
      [{ pluginId: 'hook-kit', scope: 'project', enabled: true }],
      { view: viewB },
    )
    expect(await row()).toMatchObject({ enabled: true, activation: 'active' })
    expect((await row()).suggested).toBeFalsy()
    expect(
      JSON.parse(readFileSync(projectIntents(stateRoot, projectB), 'utf8')),
    ).toMatchObject({ enabledPlugins: { project: { 'hook-kit': true } } })
    expect(
      readFileSync(join(projectB, '.emperor', 'settings.json'), 'utf8'),
    ).toBe('{"enabledPlugins":{"hook-kit":true}}\n')

    await api.chat.submit({ content: 'again', sessionId: String(b.id) })
    expect(readFileSync(log, 'utf8')).toBe('fired\n')
  })

  it('8: a project’s choice from before 0.2 moves to stateRoot at the first start and stays enabled', async () => {
    const root = tmp('emperor-sec07-upgrade-')
    const stateRoot = join(root, 'home')
    fixture = await makeApi({ root, stateRoot })
    const project = realpathSync(tmp('emperor-sec07-old-'))
    const session = fixture.api.sessions.create({
      title: 'Old',
      mode: 'build',
      project_path: project,
    })
    const view = { sessionId: String(session.id) }
    await installAs(fixture.api, HOOK_KIT, 'hook-kit', 'project', view)
    await fixture.api.close()
    fixture = null
    // What 0.1 left: the choice in the project's own file, none in stateRoot,
    // and no record that the move already ran.
    rmSync(projectIntents(stateRoot, project), { force: true })
    rmSync(join(stateRoot, 'plugins', 'project-intents-migration.json'), {
      force: true,
    })
    mkdirSync(join(project, '.emperor'), { recursive: true })
    writeFileSync(
      join(project, '.emperor', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'hook-kit': true } }),
    )

    fixture = await makeApi({ root, stateRoot })
    const plugin = fixture.api.plugins
      .list(view)
      .find((item) => item.pluginId === 'hook-kit')!
    expect(plugin).toMatchObject({ enabled: true, activation: 'active' })
    expect(plugin.suggested).toBeFalsy()
    expect(existsSync(projectIntents(stateRoot, project))).toBe(true)
  })

  it('2, 3: a plugin hook gets the variables its manifest declares and not the credentials; a failure reaches the detail', async () => {
    vi.stubEnv('SEC07_DECLARED', 'declared-value')
    vi.stubEnv('OPENAI_API_KEY', 'sk-sec07-core-api')
    fixture = await makeApi({ replies: [...bashTurn('e1')] })
    const { api, stateRoot, events } = fixture
    await installAs(
      api,
      portablePackage(
        'env-kit',
        {
          'hooks/hooks.json': {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [
                    {
                      type: 'command',
                      command: 'env > "$PLUGIN_DATA/env.txt"',
                    },
                    {
                      type: 'command',
                      command:
                        'test -n "$SEC07_NEEDED" || { echo "SEC07_NEEDED missing" >&2; exit 3; }',
                    },
                  ],
                },
              ],
            },
          },
        },
        { env: ['SEC07_DECLARED'] },
      ),
      'env-kit',
      'user',
      VIEW,
    )
    events.length = 0
    const sessionId = String(api.sessions.create({ title: 'Chat' }).id)
    await api.chat.submit({ content: 'run', sessionId })

    const env = readFileSync(
      join(stateRoot, 'plugins', 'data', 'env-kit', 'env.txt'),
      'utf8',
    )
    expect(env).toContain('SEC07_DECLARED=declared-value')
    expect(env).not.toContain('OPENAI_API_KEY')
    expect(env).not.toContain('sk-sec07-core-api')

    const detail = await api.plugins.getDetail(
      { pluginId: 'env-kit', scope: 'user' },
      VIEW,
    )
    expect(detail.permissions.env).toEqual(['SEC07_DECLARED'])
    expect(
      detail.components.map(({ id, state, reason, variables }) => ({
        id,
        state,
        reason,
        variables,
      })),
    ).toEqual([
      {
        id: 'PreToolUse#1',
        state: 'available',
        reason: null,
        variables: undefined,
      },
      {
        id: 'PreToolUse#2',
        state: 'failed',
        reason: '最近一次运行失败（退出码 3）：SEC07_NEEDED missing',
        variables: [{ name: 'SEC07_NEEDED', state: 'undeclared' }],
      },
    ])
    // The open detail and list re-read when a hook starts failing.
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'plugins_changed', reason: 'hooks' }),
    )
  })
})

/** A stored (uncompressed) ZIP of every file under `root`. */
function zipDirectory(root: string): Buffer {
  const files: Array<{ name: string; data: Buffer }> = []
  const visit = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(path, name)
      else files.push({ name: `where-kit/${name}`, data: readFileSync(path) })
    }
  }
  visit(root, '')
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(file.data.byteLength, 18)
    local.writeUInt32LE(file.data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    locals.push(local, name, file.data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(file.data.byteLength, 20)
    central.writeUInt32LE(file.data.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.byteLength + name.byteLength + file.data.byteLength
  }
  const size = centrals.reduce((total, part) => total + part.byteLength, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
