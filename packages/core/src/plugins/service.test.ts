import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PluginMcpRuntimeState } from './models'
import { PluginApplicationService } from './service'
import {
  MCP_SCHEMA_URL,
  PLUGIN_SCHEMA_URL,
  portablePackage,
  skillMarkdown,
  tempDirectory,
  writePackage,
  type PackageFiles,
} from './testing'

function fixture(version = '1.0.0') {
  const emperorHome = mkdtempSync(join(tmpdir(), 'emperor-plugin-service-'))
  const pluginRoot = join(emperorHome, 'source-plugin')
  mkdirSync(join(pluginRoot, '.emperor-plugin'), { recursive: true })
  mkdirSync(join(pluginRoot, 'skills', 'agent-reach'), { recursive: true })
  writeFileSync(
    join(pluginRoot, '.emperor-plugin', 'plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'official/agent-reach',
      name: 'Agent Reach',
      version,
      skills: ['skills'],
    }),
  )
  writeFileSync(
    join(pluginRoot, 'skills', 'agent-reach', 'SKILL.md'),
    '---\nname: agent-reach\ndescription: Reach the web\n---\nUse it.\n',
  )
  return { emperorHome, pluginRoot }
}

describe('PluginApplicationService', () => {
  it('inspects, atomically installs, enables, disables, and uninstalls a Plugin', async () => {
    const { emperorHome, pluginRoot } = fixture()
    const changed = vi.fn()
    const service = new PluginApplicationService({
      emperorHome,
      onChanged: changed,
    })
    const preview = await service.inspect({ kind: 'local', path: pluginRoot })

    expect(preview).toMatchObject({
      pluginId: 'official/agent-reach',
      version: '1.0.0',
      signature: { status: 'local_user_source' },
      capabilities: { skills: ['agent-reach'] },
    })
    const installed = await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(installed.plugin).toMatchObject({
      pluginId: 'official/agent-reach',
      enabled: true,
      materialization: 'installed',
      activation: 'active',
    })
    expect(service.enabledSkillRoots()).toHaveLength(1)

    expect(
      service.setEnabled({
        pluginId: 'official/agent-reach',
        scope: 'user',
        enabled: false,
      }).plugin,
    ).toMatchObject({ enabled: false, materialization: 'installed' })
    expect(service.enabledSkillRoots()).toEqual([])

    const cachePath = service.store.get(
      'official/agent-reach',
      'user',
    )!.installPath
    expect(
      service.uninstall({ pluginId: 'official/agent-reach', scope: 'user' })
        .changed,
    ).toBe(true)
    expect(existsSync(cachePath)).toBe(true)
    expect(changed).toHaveBeenCalled()
  })

  it('binds confirmation to the preview digest and preserves the prior cache on update', async () => {
    const first = fixture('1.0.0')
    const service = new PluginApplicationService({
      emperorHome: first.emperorHome,
    })
    const preview = await service.inspect({
      kind: 'local',
      path: first.pluginRoot,
    })
    await expect(
      service.install({
        previewId: preview.previewId,
        digest: 'b'.repeat(64),
        scope: 'user',
      }),
    ).rejects.toThrow(/digest/i)
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    const oldCache = service.store.get(
      'official/agent-reach',
      'user',
    )!.installPath

    const second = fixture('2.0.0')
    const next = await service.inspect({
      kind: 'local',
      path: second.pluginRoot,
    })
    await service.install({
      previewId: next.previewId,
      digest: next.digest,
      scope: 'user',
    })

    expect(service.store.get('official/agent-reach', 'user')?.version).toBe(
      '2.0.0',
    )
    expect(existsSync(oldCache)).toBe(true)
  })

  it('rejects manifest paths that escape the Plugin root', async () => {
    const { emperorHome, pluginRoot } = fixture()
    const manifestPath = join(pluginRoot, '.emperor-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.skills = ['../outside']
    writeFileSync(manifestPath, JSON.stringify(manifest))

    await expect(
      new PluginApplicationService({ emperorHome }).inspect({
        kind: 'local',
        path: pluginRoot,
      }),
    ).rejects.toMatchObject({ code: 'plugin_preview_path_unsafe' })
  })

  it('keeps enabled intent distinct from missing materialization', () => {
    const { emperorHome } = fixture()
    const service = new PluginApplicationService({ emperorHome })
    const result = service.setEnabled({
      pluginId: 'official/missing',
      scope: 'user',
      enabled: true,
    })
    expect(result.plugin).toMatchObject({
      enabled: true,
      materialization: 'missing',
      activation: 'missing',
    })
  })

  it('reports a missing immutable cache without breaking Plugin inventory', async () => {
    const { emperorHome, pluginRoot } = fixture()
    const service = new PluginApplicationService({ emperorHome })
    const preview = await service.inspect({ kind: 'local', path: pluginRoot })
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    const cachePath = service.store.get(
      'official/agent-reach',
      'user',
    )!.installPath
    rmSync(cachePath, { recursive: true, force: true })

    expect(service.list()).toEqual([
      expect.objectContaining({
        pluginId: 'official/agent-reach',
        enabled: true,
        materialization: 'missing',
        activation: 'missing',
      }),
    ])
    expect(service.enabledSkillRoots()).toEqual([])
  })

  it('treats corrupt settings as no enablement intent during bootstrap', () => {
    const { emperorHome } = fixture()
    writeFileSync(join(emperorHome, 'settings.json'), '{not valid json', 'utf8')

    const service = new PluginApplicationService({ emperorHome })

    expect(service.list()).toEqual([])
    expect(readFileSync(join(emperorHome, 'settings.json'), 'utf8')).toBe(
      '{not valid json',
    )
  })

  it('uses the trusted host WebFetch client for remote Plugin archives', async () => {
    const { emperorHome } = fixture()
    const archive = zip([
      {
        name: 'agent-reach/.emperor-plugin/plugin.json',
        data: JSON.stringify({
          schemaVersion: 1,
          id: 'official/agent-reach',
          name: 'Agent Reach',
          version: '3.0.0',
          skills: ['skills'],
        }),
      },
      {
        name: 'agent-reach/skills/agent-reach/SKILL.md',
        data: '---\nname: agent-reach\ndescription: remote\n---\nRemote.\n',
      },
    ])
    const get = vi.fn(async () => ({
      kind: 'response' as const,
      status: 200,
      url: 'https://downloads.example/plugin.zip',
      headers: {},
      body: archive,
    }))
    const service = new PluginApplicationService({
      emperorHome,
      webFetchClient: { get },
    })

    const preview = await service.inspect({
      kind: 'url',
      url: 'https://downloads.example/plugin.zip',
    })

    expect(preview).toMatchObject({
      version: '3.0.0',
      signature: { status: 'unverified' },
    })
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ redirectMode: 'follow_validated' }),
    )
    const installed = await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(installed.plugin).toMatchObject({
      enabled: true,
      materialization: 'installed',
      activation: 'blocked_unverified',
      signature: { status: 'unverified' },
    })
    expect(service.enabledSkillRoots()).toEqual([])
  })

  it('installs a local .zip archive as a local user source', async () => {
    const { emperorHome } = fixture()
    const archivePath = join(emperorHome, 'agent-reach.zip')
    writeFileSync(
      archivePath,
      zip([
        {
          name: 'agent-reach/.emperor-plugin/plugin.json',
          data: JSON.stringify({
            schemaVersion: 1,
            id: 'official/agent-reach',
            name: 'Agent Reach',
            version: '4.0.0',
            skills: ['skills'],
          }),
        },
        {
          name: 'agent-reach/skills/agent-reach/SKILL.md',
          data: '---\nname: agent-reach\ndescription: zipped\n---\nZipped.\n',
        },
      ]),
    )
    const service = new PluginApplicationService({ emperorHome })

    const preview = await service.inspect({ kind: 'local', path: archivePath })

    expect(preview).toMatchObject({
      version: '4.0.0',
      source: { kind: 'local', label: 'agent-reach.zip' },
      signature: { status: 'local_user_source' },
    })
    const installed = await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(installed.plugin).toMatchObject({ enabled: true })
    expect(service.enabledSkillRoots()).toHaveLength(1)
  })
})

describe('PluginApplicationService package formats', () => {
  function portableSource(
    home: string,
    extra: PackageFiles = {},
    manifest: Record<string, unknown> = {},
  ): string {
    return writePackage(
      join(home, 'src-portable'),
      portablePackage(
        'hello-kit',
        {
          'skills/hello/SKILL.md': skillMarkdown('hello', 'Say hello'),
          ...extra,
        },
        manifest,
      ),
    )
  }

  function stagingEntries(home: string): string[] {
    return readdirSync(join(home, 'plugins', 'staging'))
  }

  it('previews and installs a portable package without a version', async () => {
    const home = tempDirectory()
    const source = portableSource(home)
    const service = new PluginApplicationService({ emperorHome: home })

    const preview = await service.inspect({ kind: 'local', path: source })
    expect(preview).toMatchObject({
      pluginId: 'hello-kit',
      format: 'portable',
      name: 'hello-kit',
      version: null,
      capabilities: { skills: ['hello'], mcpServers: [], apps: [] },
    })
    const installed = await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(installed.plugin).toMatchObject({
      version: null,
      activation: 'active',
      capabilities: { skills: 1, mcpServers: 0, apps: 0 },
    })
    const entry = service.store.get('hello-kit', 'user')!
    expect(entry.version).toBeNull()
    expect(entry.installPath).toBe(
      join(
        home,
        'plugins',
        'cache',
        'hello-kit',
        'unversioned',
        preview.digest,
      ),
    )
    expect(service.enabledSkillRoots()).toEqual([
      join(entry.installPath, 'skills'),
    ])
  })

  it('computes one digest for the preview, a second preview and the installed copy', async () => {
    const home = tempDirectory()
    const source = portableSource(home)
    const service = new PluginApplicationService({ emperorHome: home })
    const first = await service.inspect({ kind: 'local', path: source })
    const second = await service.inspect({ kind: 'local', path: source })
    expect(second.digest).toBe(first.digest)
    await service.install({
      previewId: first.previewId,
      digest: first.digest,
      scope: 'user',
    })
    const again = await service.inspect({
      kind: 'local',
      path: service.store.get('hello-kit', 'user')!.installPath,
    })
    expect(again.digest).toBe(first.digest)
  })

  it('keeps build metadata in the version and a safe cache segment', async () => {
    const home = tempDirectory()
    const source = portableSource(home, {}, { version: '1.0.0+build.5' })
    const service = new PluginApplicationService({ emperorHome: home })
    const preview = await service.inspect({ kind: 'local', path: source })
    expect(preview.version).toBe('1.0.0+build.5')
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(service.store.get('hello-kit', 'user')!.installPath).toBe(
      join(
        home,
        'plugins',
        'cache',
        'hello-kit',
        '1.0.0_build.5',
        preview.digest,
      ),
    )
  })

  it('finds a single package root inside a ZIP and rejects two', async () => {
    const home = tempDirectory()
    const nested = join(home, 'nested.zip')
    writeFileSync(
      nested,
      zip([
        {
          name: 'bundle/hello-kit/plugin.json',
          data: JSON.stringify({
            $schema: PLUGIN_SCHEMA_URL,
            name: 'hello-kit',
          }),
        },
        {
          name: 'bundle/hello-kit/skills/hello/SKILL.md',
          data: skillMarkdown('hello', 'Zipped'),
        },
      ]),
    )
    const twoRoots = join(home, 'two.zip')
    writeFileSync(
      twoRoots,
      zip([
        {
          name: 'one/plugin.json',
          data: JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'one' }),
        },
        {
          name: 'two/.codex-plugin/plugin.json',
          data: JSON.stringify({ name: 'two' }),
        },
      ]),
    )
    const service = new PluginApplicationService({ emperorHome: home })

    await expect(
      service.inspect({ kind: 'local', path: nested }),
    ).resolves.toMatchObject({
      pluginId: 'hello-kit',
      capabilities: { skills: ['hello'] },
    })
    await expect(
      service.inspect({ kind: 'local', path: twoRoots }),
    ).rejects.toMatchObject({
      code: 'plugin_preview_multiple_roots',
    })
  })

  it.each<[string, (home: string) => string, string]>([
    [
      'a symlink',
      (home) => {
        const source = portableSource(home)
        symlinkSync('/etc/hosts', join(source, 'hosts'))
        return source
      },
      'plugin_preview_path_unsafe',
    ],
    [
      'an unparseable MCP file',
      (home) => portableSource(home, { 'mcp.json': '{nope' }),
      'plugin_preview_member_invalid',
    ],
    [
      'a duplicate Skill',
      (home) =>
        writePackage(join(home, 'dup'), {
          '.codex-plugin/plugin.json': {
            name: 'dup-kit',
            skills: ['./a', './b'],
          },
          'a/same/SKILL.md': skillMarkdown('same', 'One'),
          'b/same/SKILL.md': skillMarkdown('same', 'Two'),
        }),
      'plugin_preview_duplicate_member',
    ],
  ])(
    'fails the preview for %s and leaves nothing behind',
    async (_name, make, code) => {
      const home = tempDirectory()
      const service = new PluginApplicationService({ emperorHome: home })
      await expect(
        service.inspect({ kind: 'local', path: make(home) }),
      ).rejects.toMatchObject({
        code,
      })
      expect(stagingEntries(home)).toEqual([])
      expect(service.list()).toEqual([])
      expect(service.enabledSkillRoots()).toEqual([])
    },
  )

  it('keeps execute bits of a ZIP package so its scripts can run', async () => {
    const home = tempDirectory()
    const archive = join(home, 'exec.zip')
    writeFileSync(
      archive,
      zip([
        {
          name: 'exec-kit/plugin.json',
          data: JSON.stringify({
            $schema: PLUGIN_SCHEMA_URL,
            name: 'exec-kit',
          }),
        },
        { name: 'exec-kit/bin/run', data: '#!/bin/sh\n', mode: 0o100755 },
      ]),
    )
    const service = new PluginApplicationService({ emperorHome: home })
    const preview = await service.inspect({ kind: 'local', path: archive })
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    const installed = service.store.get('exec-kit', 'user')!.installPath
    expect(statSync(join(installed, 'bin', 'run')).mode & 0o777).toBe(0o700)
    expect(statSync(join(installed, 'plugin.json')).mode & 0o777).toBe(0o600)
  })

  it('checks the install scope before writing anything', async () => {
    const home = tempDirectory()
    const source = portableSource(home)
    const service = new PluginApplicationService({ emperorHome: home })
    const preview = await service.inspect({ kind: 'local', path: source })

    await expect(
      service.install({
        previewId: preview.previewId,
        digest: preview.digest,
        scope: 'project',
      }),
    ).rejects.toThrow(/active workspace/)
    expect(service.store.list()).toEqual([])
    expect(service.list()).toEqual([])
    // The preview survives, so the user can pick another scope.
    await expect(
      service.install({
        previewId: preview.previewId,
        digest: preview.digest,
        scope: 'user',
      }),
    ).resolves.toMatchObject({
      plugin: { pluginId: 'hello-kit', scope: 'user' },
    })
  })

  it('removes abandoned previews older than a day at startup', () => {
    const home = tempDirectory()
    const staging = join(home, 'plugins', 'staging')
    const stale = join(staging, `plugin_preview_${'a'.repeat(24)}`)
    const fresh = join(staging, `plugin_preview_${'b'.repeat(24)}`)
    const other = join(staging, 'keep-me')
    for (const dir of [stale, fresh, other])
      mkdirSync(join(dir, 'payload'), { recursive: true })
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(stale, old, old)
    utimesSync(other, old, old)

    new PluginApplicationService({ emperorHome: home })

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })

  it('still installs and reads an emperor-v1 package unchanged', async () => {
    const { emperorHome, pluginRoot } = fixture()
    const manifestPath = join(pluginRoot, '.emperor-plugin', 'plugin.json')
    const before = readFileSync(manifestPath, 'utf8')
    const service = new PluginApplicationService({ emperorHome })
    const preview = await service.inspect({ kind: 'local', path: pluginRoot })
    expect(preview).toMatchObject({ format: 'emperor-v1', name: 'Agent Reach' })
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(service.list()).toEqual([
      expect.objectContaining({
        pluginId: 'official/agent-reach',
        name: 'Agent Reach',
        version: '1.0.0',
        activation: 'active',
      }),
    ])
    expect(readFileSync(manifestPath, 'utf8')).toBe(before)
  })
})

describe('PluginApplicationService list and detail', () => {
  const DESCRIBED = portablePackage(
    'hello-kit',
    {
      'skills/hello/SKILL.md': skillMarkdown('hello', 'Say hello'),
      'skills/wave/SKILL.md': skillMarkdown('wave', 'Wave'),
      'mcp.json': {
        $schema: MCP_SCHEMA_URL,
        mcpServers: {
          search: {
            type: 'streamable-http',
            url: 'https://search.example/mcp',
            headers: { authorization: 'Bearer secret-token' },
          },
        },
      },
      'hooks/hooks.json': {
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'check.sh' }] }],
        },
      },
    },
    {
      version: '1.0.0',
      description: 'Greets people',
      author: { name: 'Acme' },
      extensions: {
        'com.openai': {
          interface: {
            displayName: 'Hello Kit',
            shortDescription: 'Say hello',
            defaultPrompt: ['Greet the team'],
          },
        },
      },
    },
  )

  async function installed(
    files: PackageFiles = DESCRIBED,
    scope: 'user' | 'project' = 'user',
    options: { home?: string; workspace?: string | null } = {},
  ) {
    const home = options.home ?? tempDirectory()
    let workspace = options.workspace ?? null
    const service = new PluginApplicationService({
      emperorHome: home,
      activeWorkspaceRoot: () => workspace,
    })
    const source = writePackage(join(tempDirectory(), 'source'), files)
    const preview = await service.inspect({ kind: 'local', path: source })
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope,
    })
    return {
      home,
      service,
      setWorkspace: (next: string | null) => {
        workspace = next
      },
    }
  }

  it('lists display fields, flags and real member counts', async () => {
    const { service } = await installed()
    expect(service.list()).toEqual([
      expect.objectContaining({
        pluginId: 'hello-kit',
        name: 'Hello Kit',
        displayName: 'Hello Kit',
        description: 'Say hello',
        developerName: 'Acme',
        format: 'portable',
        logo: null,
        version: '1.0.0',
        activation: 'active',
        effective: true,
        toggleable: true,
        uninstallable: true,
        capabilities: {
          skills: 2,
          agents: 0,
          hooks: 1,
          mcpServers: 1,
          lspServers: 0,
          commands: 0,
          apps: 0,
        },
      }),
    ])
  })

  it('returns a detail with members, permissions and no path or secret', async () => {
    const { home, service } = await installed()
    const detail = service.detail({ pluginId: 'hello-kit', scope: 'user' })
    expect(detail).toMatchObject({
      pluginId: 'hello-kit',
      scope: 'user',
      format: 'portable',
      version: '1.0.0',
      displayName: 'Hello Kit',
      description: 'Say hello',
      developerName: 'Acme',
      prompts: ['Greet the team'],
      enabled: true,
      effective: true,
      activation: 'active',
      materialization: 'installed',
      source: { kind: 'local', label: 'source' },
      permissions: { runsCommands: true, network: true },
      installedAt: expect.any(String),
    })
    expect(
      detail.components.map(({ kind, id, state }) => [kind, id, state]),
    ).toEqual([
      ['skill', 'hello', 'available'],
      ['skill', 'wave', 'available'],
      ['mcp', 'search', 'starting'],
      ['hook', 'PreToolUse#1', 'available'],
    ])
    const text = JSON.stringify(detail)
    expect(text).not.toContain(home)
    expect(text).not.toContain('secret-token')
    expect(detail).not.toHaveProperty('rootPath')
  })

  it('reports disabled, missing and unknown packages', async () => {
    const { service } = await installed()
    service.setEnabled({ pluginId: 'hello-kit', scope: 'user', enabled: false })
    expect(
      service.detail({ pluginId: 'hello-kit', scope: 'user' }),
    ).toMatchObject({
      activation: 'disabled',
      components: expect.arrayContaining([
        expect.objectContaining({
          id: 'hello',
          state: 'disabled',
          reason: '插件已停用',
        }),
      ]),
    })
    rmSync(service.store.get('hello-kit', 'user')!.installPath, {
      recursive: true,
      force: true,
    })
    // Missing content outranks the disabled intent.
    expect(
      service.detail({ pluginId: 'hello-kit', scope: 'user' }),
    ).toMatchObject({
      activation: 'missing',
      materialization: 'missing',
      format: null,
      components: [],
    })
    expect(() => service.detail({ pluginId: 'nobody', scope: 'user' })).toThrow(
      expect.objectContaining({ code: 'plugin_not_found' }),
    )
  })

  it('uninstalls without leaving a ghost row', async () => {
    const { home, service } = await installed()
    service.uninstall({ pluginId: 'hello-kit', scope: 'user' })
    expect(service.list()).toEqual([])
    const settings = JSON.parse(
      readFileSync(join(home, 'settings.json'), 'utf8'),
    )
    expect(settings.enabledPlugins).toEqual({})
  })

  it('lets the closest scope win when one plugin is active in two', async () => {
    const workspace = tempDirectory()
    const { home, service } = await installed(DESCRIBED, 'user', { workspace })
    const second = await installed(DESCRIBED, 'project', { home, workspace })
    const list = second.service.list()
    expect(
      list.map(({ scope, activation, effective }) => [
        scope,
        activation,
        effective,
      ]),
    ).toEqual([
      ['project', 'active', true],
      ['user', 'active', false],
    ])
    expect(
      service.detail({ pluginId: 'hello-kit', scope: 'user' }).components[0],
    ).toMatchObject({
      state: 'disabled',
      reason: '已由项目范围的同一插件提供',
    })
    const projectEntry = service.store.get('hello-kit', 'project')!
    expect(service.enabledSkillRoots(workspace)).toEqual([
      join(projectEntry.installPath, 'skills'),
    ])
  })

  it('computes Skill roots per project so project plugins stay in their project', async () => {
    const projectA = tempDirectory()
    const projectB = tempDirectory()
    const { service, setWorkspace } = await installed(DESCRIBED, 'project', {
      workspace: projectA,
    })
    const entry = service.store.get('hello-kit', 'project')!
    setWorkspace(projectB)
    expect(service.enabledSkillRoots(projectA)).toEqual([
      join(entry.installPath, 'skills'),
    ])
    expect(service.enabledSkillRoots(projectB)).toEqual([])
    expect(service.enabledSkillRoots(null)).toEqual([])
  })

  it('layers live runtime facts onto the members', async () => {
    const home = tempDirectory()
    const service = new PluginApplicationService({
      emperorHome: home,
      runtime: {
        mcpServer: () => ({ state: 'ready', toolCount: 2 }),
        effectiveSkills: () =>
          new Map([
            [
              'hello',
              {
                source: 'user' as const,
                skillFile: join(home, 'skills', 'hello', 'SKILL.md'),
              },
            ],
          ]),
      },
    })
    const source = writePackage(join(tempDirectory(), 'source'), DESCRIBED)
    const preview = await service.inspect({ kind: 'local', path: source })
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(
      service
        .detail({ pluginId: 'hello-kit', scope: 'user' })
        .components.map(({ id, state }) => [id, state]),
    ).toEqual([
      ['hello', 'failed'],
      ['wave', 'available'],
      ['search', 'running'],
      ['PreToolUse#1', 'available'],
    ])
  })

  it('lists an MCP member’s tools only while its server runs, and says why not', async () => {
    let state: PluginMcpRuntimeState['state'] = 'connecting'
    let root = ''
    const asked: string[] = []
    const service = new PluginApplicationService({
      emperorHome: tempDirectory(),
      runtime: {
        mcpServer: () => ({ state }),
        mcpTools: (pluginId, scope, server) => {
          asked.push(`${pluginId}:${scope}:${server}`)
          return [
            {
              name: 'mcp_hello-kit-search_find',
              description: `[MCP:hello-kit-search] Find in ${root}/docs`,
              parameters: { type: 'object' },
              readOnly: true,
            },
          ]
        },
        effectiveSkills: () => new Map(),
      },
    })
    const source = writePackage(join(tempDirectory(), 'source'), DESCRIBED)
    const preview = await service.inspect({ kind: 'local', path: source })
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    root = service.store.get('hello-kit', 'user')!.installPath
    const group = () =>
      service.detail({ pluginId: 'hello-kit', scope: 'user' }).tools.groups[0]!

    expect(group()).toEqual({
      id: 'search',
      kind: 'mcp',
      title: 'search',
      note: '正在连接服务器，连上后列出它的工具',
      tools: [],
    })
    state = 'ready'
    expect(group()).toMatchObject({
      note: null,
      tools: [
        {
          name: 'mcp_hello-kit-search_find',
          // Never a path on this machine (contract §6.2).
          description: '[MCP:hello-kit-search] Find in docs',
          readOnly: true,
        },
      ],
    })
    expect(asked).toEqual(['hello-kit:user:search'])
    state = 'failed'
    expect(group()).toMatchObject({ note: '服务器没有运行', tools: [] })
    state = 'ready'
    service.setEnabled({ pluginId: 'hello-kit', scope: 'user', enabled: false })
    expect(group()).toMatchObject({ note: '服务器没有运行', tools: [] })
  })
})

describe('PluginApplicationService logos', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24),
  ])

  async function withLogo(logo: string, files: PackageFiles) {
    const home = tempDirectory()
    const service = new PluginApplicationService({ emperorHome: home })
    const source = writePackage(
      join(tempDirectory(), 'kit'),
      portablePackage('logo-kit', files, {
        extensions: { 'com.openai': { interface: { logo } } },
      }),
    )
    const preview = await service.inspect({ kind: 'local', path: source })
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    return { service, digest: preview.digest, home }
  }

  it('gives a valid logo a host address and serves its bytes to the host', async () => {
    const { service, digest, home } = await withLogo('./assets/logo.png', {
      'assets/logo.png': PNG,
    })
    const url = `app://plugin-assets/user/logo-kit/logo?v=${digest.slice(0, 8)}`
    expect(service.list()[0]).toMatchObject({ logo: url })
    expect(
      service.detail({ pluginId: 'logo-kit', scope: 'user' }),
    ).toMatchObject({
      logo: url,
      logoIssue: null,
    })
    expect(
      JSON.stringify(service.detail({ pluginId: 'logo-kit', scope: 'user' })),
    ).not.toContain(home)
    expect(service.logo({ pluginId: 'logo-kit', scope: 'user' })).toEqual({
      mime: 'image/png',
      bytes: PNG,
    })
    expect(service.logo({ pluginId: 'nobody', scope: 'user' })).toBeNull()
  })

  it.each<[string, string, PackageFiles, string]>([
    [
      'a broken image',
      './assets/logo.png',
      { 'assets/logo.png': 'not an image' },
      'Logo 不是 PNG、JPEG 或 WebP 图片',
    ],
    [
      'a path outside assets/',
      '../logo.png',
      {},
      'Logo 必须是包内 ./assets/ 下的文件',
    ],
    [
      'an external URL',
      'https://cdn.example/logo.png',
      {},
      'Logo 必须是包内 ./assets/ 下的文件',
    ],
    [
      'a missing file',
      './assets/gone.png',
      {},
      '找不到 Logo：./assets/gone.png',
    ],
  ])('falls back for %s and says why', async (_name, logo, files, issue) => {
    const { service } = await withLogo(logo, files)
    expect(service.list()[0]).toMatchObject({ logo: null })
    expect(
      service.detail({ pluginId: 'logo-kit', scope: 'user' }),
    ).toMatchObject({
      logo: null,
      logoIssue: issue,
    })
    expect(service.logo({ pluginId: 'logo-kit', scope: 'user' })).toBeNull()
  })
})

describe('PluginApplicationService managed packages', () => {
  function bundled(version = '1.0.0'): string {
    const root = tempDirectory()
    writePackage(
      join(root, 'github'),
      portablePackage(
        'github',
        {},
        {
          version,
          extensions: {
            'com.openai': {
              interface: {
                displayName: 'GitHub',
                developerName: 'Emperor Agent',
              },
            },
          },
        },
      ),
    )
    writePackage(
      join(root, 'computer-use'),
      portablePackage(
        'computer-use',
        {},
        {
          version: '1.0.0',
          extensions: {
            'com.openai': { interface: { displayName: 'Computer Use' } },
          },
        },
      ),
    )
    return root
  }

  function computerUse(enabled: boolean | null) {
    const state = { enabled, calls: [] as boolean[] }
    return {
      state,
      port: {
        enabled: () => state.enabled,
        setEnabled: (value: boolean) => {
          state.calls.push(value)
          state.enabled = value
        },
      },
    }
  }

  function managedService(
    home: string,
    roots: string[],
    cu = computerUse(false),
    workspace: string | null = null,
  ) {
    return new PluginApplicationService({
      emperorHome: home,
      bundledPluginRoots: roots,
      computerUse: cu.port,
      activeWorkspaceRoot: () => workspace,
    })
  }

  it('lists the bundled packages as managed, enabled by default, not uninstallable', () => {
    const home = tempDirectory()
    const root = bundled()
    const service = managedService(
      home,
      [join(home, 'missing'), root],
      computerUse(true),
    )
    expect(service.list()).toEqual([
      expect.objectContaining({
        pluginId: 'computer-use',
        scope: 'managed',
        displayName: 'Computer Use',
        enabled: true,
        activation: 'active',
        toggleable: true,
        uninstallable: false,
        source: { kind: 'managed' },
        signature: { status: 'verified', publisher: 'Emperor' },
      }),
      expect.objectContaining({
        pluginId: 'github',
        scope: 'managed',
        displayName: 'GitHub',
        version: '1.0.0',
        enabled: true,
        activation: 'active',
        effective: true,
        toggleable: true,
        uninstallable: false,
        format: 'portable',
      }),
    ])
    expect(
      service.detail({ pluginId: 'github', scope: 'managed' }),
    ).toMatchObject({
      source: { kind: 'managed' },
      installedAt: null,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it('lists Computer Use’s tools by driver and says when they cannot be used', () => {
    const cu = computerUse(null)
    const tool = (name: string) => ({
      name,
      description: `${name} does one thing.`,
      parameters: { type: 'object' },
      readOnly: false,
    })
    const service = new PluginApplicationService({
      emperorHome: tempDirectory(),
      bundledPluginRoots: [bundled()],
      computerUse: cu.port,
      runtime: {
        mcpServer: () => null,
        effectiveSkills: () => new Map(),
        computerUseTools: () => [
          { family: 'desktop', tools: [tool('desktop_click')] },
          { family: 'ui', tools: [tool('ui_list_targets')] },
        ],
      },
    })
    const tools = () =>
      service.detail({ pluginId: 'computer-use', scope: 'managed' }).tools

    // In driver order; a driver without tools is left out.
    expect(tools()).toEqual({
      note: '这台电脑不能使用电脑操作',
      groups: [
        {
          id: 'ui',
          kind: 'computer-use',
          title: '通用',
          note: null,
          tools: [tool('ui_list_targets')],
        },
        {
          id: 'desktop',
          kind: 'computer-use',
          title: 'Mac 应用',
          note: null,
          tools: [tool('desktop_click')],
        },
      ],
    })
    cu.state.enabled = false
    expect(tools().note).toBe('打开电脑操作后可用')
    cu.state.enabled = true
    expect(tools().note).toBeNull()
    // Other plugins without MCP members bring no tools.
    expect(
      service.detail({ pluginId: 'github', scope: 'managed' }).tools,
    ).toEqual({ note: null, groups: [] })
  })

  it('keeps the toggle in its own file across restarts and upgrades', () => {
    const home = tempDirectory()
    const root = bundled('1.0.0')
    managedService(home, [root]).setEnabled({
      pluginId: 'github',
      scope: 'managed',
      enabled: false,
    })
    expect(
      JSON.parse(readFileSync(join(home, 'plugins', 'managed.json'), 'utf8')),
    ).toEqual({
      schemaVersion: 1,
      enabled: { github: false },
    })
    expect(existsSync(join(home, 'settings.json'))).toBe(false)
    // Restart after an upgrade: new metadata, same intent.
    writePackage(
      join(root, 'github'),
      portablePackage('github', {}, { version: '1.1.0' }),
    )
    const restarted = managedService(home, [root])
    expect(
      restarted.list().find((item) => item.pluginId === 'github'),
    ).toMatchObject({
      version: '1.1.0',
      enabled: false,
      activation: 'disabled',
    })
  })

  it('makes the Computer Use package the master switch, with no second state', () => {
    const home = tempDirectory()
    const cu = computerUse(false)
    const service = managedService(home, [bundled()], cu)
    expect(service.list()[0]).toMatchObject({
      pluginId: 'computer-use',
      enabled: false,
    })
    service.setEnabled({
      pluginId: 'computer-use',
      scope: 'managed',
      enabled: true,
    })
    expect(cu.state.calls).toEqual([true])
    expect(service.list()[0]).toMatchObject({
      enabled: true,
      activation: 'active',
    })
    // The switch changed elsewhere (the settings page): the package follows.
    cu.state.enabled = false
    expect(service.list()[0]).toMatchObject({ enabled: false })
    expect(existsSync(join(home, 'plugins', 'managed.json'))).toBe(false)
  })

  it('cannot toggle Computer Use where it is not supported', () => {
    const home = tempDirectory()
    const service = managedService(home, [bundled()], computerUse(null))
    expect(service.list()[0]).toMatchObject({
      pluginId: 'computer-use',
      enabled: false,
      toggleable: false,
    })
    expect(() =>
      service.setEnabled({
        pluginId: 'computer-use',
        scope: 'managed',
        enabled: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'plugin_toggle_unavailable' }))
  })

  it('refuses to uninstall a managed package but still uninstalls ordinary ones', async () => {
    const home = tempDirectory()
    const service = managedService(home, [bundled()])
    expect(() =>
      service.uninstall({ pluginId: 'github', scope: 'managed' }),
    ).toThrow(
      expect.objectContaining({ code: 'plugin_managed_uninstall_denied' }),
    )
    expect(() =>
      service.setEnabled({
        pluginId: 'nobody',
        scope: 'managed',
        enabled: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'plugin_not_found' }))
    const source = writePackage(
      join(tempDirectory(), 'kit'),
      portablePackage('hello-kit', {
        'skills/hello/SKILL.md': skillMarkdown('hello', 'Hi'),
      }),
    )
    const preview = await service.inspect({ kind: 'local', path: source })
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(
      service.uninstall({ pluginId: 'hello-kit', scope: 'user' }).changed,
    ).toBe(true)
  })

  it('lets a package the user installs override the managed one of the same name', async () => {
    const home = tempDirectory()
    const service = managedService(home, [bundled()])
    const source = writePackage(
      join(tempDirectory(), 'mine'),
      portablePackage('github'),
    )
    const preview = await service.inspect({ kind: 'local', path: source })
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    const rows = service.list().filter((item) => item.pluginId === 'github')
    expect(rows.map(({ scope, effective }) => [scope, effective])).toEqual([
      ['managed', false],
      ['user', true],
    ])
  })
})

function zip(
  entries: Array<{ name: string; data: string | Buffer; mode?: number }>,
): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.byteLength, 18)
    local.writeUInt32LE(data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    localParts.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.byteLength, 20)
    central.writeUInt32LE(data.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.byteLength + name.byteLength + data.byteLength
  }
  const centralSize = centralParts.reduce(
    (total, part) => total + part.byteLength,
    0,
  )
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
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
