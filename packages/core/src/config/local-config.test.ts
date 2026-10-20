import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createNodePersistenceAdapter } from '../store/persistence'
import {
  loadLocalConfig,
  localConfigDiagnostics,
  localConfigPath,
  mergeWebuiOverrides,
  parseLocalConfig,
  saveLocalConfig,
} from './local-config'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'emperor-local-config-'))
})

describe('local config', () => {
  it('round-trips webui and desktop pet preferences with Python-compatible field names', async () => {
    await saveLocalConfig(dir, {
      webui: { host: '127.0.0.2', port: 9999, openBrowser: true },
      desktopPet: { enabled: true, autoStartWithWebui: false },
      prompt: { profile: 'classic' },
    })

    const onDisk = JSON.parse(
      await readFile(join(dir, 'settings.json'), 'utf8'),
    )
    expect(onDisk).toEqual({
      webui: { host: '127.0.0.2', port: 9999, openBrowser: true },
      desktopPet: { enabled: true, autoStartWithWebui: false },
      prompt: { profile: 'classic' },
      browser: {
        linkTarget: 'system',
        localTarget: 'builtin',
        showFullUrl: true,
        history: true,
        downloadDirectory: null,
        askWhereToSave: false,
      },
      webTools: { webFetch: true, webSearch: true },
      sessions: { defaultPermission: 'workspace-write' },
      taskBudget: {
        maxSteps: 400,
        maxBackgroundSteps: 120,
        maxActiveAgents: 8,
        maxTotalAgents: 64,
        maxNoticeWakes: 32,
      },
    })

    const loaded = await loadLocalConfig(dir)
    const prefs = mergeWebuiOverrides(loaded, {
      host: '127.0.0.1',
      port: 8765,
      openBrowser: false,
    })

    expect(loaded.webui).toEqual({
      host: '127.0.0.2',
      port: 9999,
      openBrowser: true,
    })
    expect(loaded.desktopPet).toEqual({
      enabled: true,
      autoStartWithWebui: false,
    })
    expect(loaded.prompt).toEqual({ profile: 'classic' })
    expect(prefs).toEqual({ host: '127.0.0.1', port: 8765, openBrowser: false })
    expect((await stat(join(dir, 'settings.json'))).mode & 0o777).toBe(0o600)
    expect(
      (await readdir(dir)).filter((name) => name.includes('.tmp-')),
    ).toEqual([])
  })

  it('preserves the previous config when the durable rename fails', async () => {
    const original = parseLocalConfig({
      webui: { host: '127.0.0.7', port: 9001 },
    })
    await saveLocalConfig(dir, original)

    await expect(
      saveLocalConfig(
        dir,
        parseLocalConfig({ webui: { host: '127.0.0.8', port: 9002 } }),
        {
          persistenceAdapter: createNodePersistenceAdapter({
            beforeOperation(operation) {
              if (operation === 'rename') throw new Error('injected rename')
            },
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: 'persistence_io',
      operation: 'rename',
    })

    await expect(loadLocalConfig(dir)).resolves.toMatchObject({
      webui: { host: '127.0.0.7', port: 9001 },
    })
    expect(
      (await readdir(dir)).filter((name) => name.includes('.tmp-')),
    ).toEqual([])
  })

  it('keeps the user browser preferences and repairs bad fields one by one', async () => {
    const saved = parseLocalConfig({})
    await saveLocalConfig(dir, {
      ...saved,
      browser: {
        linkTarget: 'builtin',
        localTarget: 'system',
        showFullUrl: false,
        history: false,
        downloadDirectory: '/Users/me/Downloads/web',
        askWhereToSave: true,
      },
    })
    expect((await loadLocalConfig(dir)).browser).toEqual({
      linkTarget: 'builtin',
      localTarget: 'system',
      showFullUrl: false,
      history: false,
      downloadDirectory: '/Users/me/Downloads/web',
      askWhereToSave: true,
    })
    expect(
      parseLocalConfig({
        browser: {
          linkTarget: 'tab',
          localTarget: 'nowhere',
          showFullUrl: false,
          downloadDirectory: 'Downloads/web',
          askWhereToSave: 'yes',
        },
      }).browser,
    ).toEqual({
      linkTarget: 'system',
      localTarget: 'builtin',
      showFullUrl: false,
      history: true,
      downloadDirectory: null,
      askWhereToSave: false,
    })
  })

  it('keeps only an absolute download folder', () => {
    // null means the system Downloads folder; anything else goes back to it.
    for (const bad of ['', 'relative/dir', './here', 42, {}, '/tmp/a\0b'])
      expect(
        parseLocalConfig({ browser: { downloadDirectory: bad } }).browser
          .downloadDirectory,
        JSON.stringify(bad),
      ).toBeNull()
    expect(
      parseLocalConfig({ browser: { downloadDirectory: '/Volumes/Data/dl' } })
        .browser.downloadDirectory,
    ).toBe('/Volumes/Data/dl')
  })

  it('drops the retired browser switch', () => {
    // 设置 › 浏览器 no longer turns the built-in browser off (2026-09-30).
    expect(
      parseLocalConfig({ browser: { enabled: false, linkTarget: 'builtin' } })
        .browser,
    ).toEqual({
      linkTarget: 'builtin',
      localTarget: 'builtin',
      showFullUrl: true,
      history: true,
      downloadDirectory: null,
      askWhereToSave: false,
    })
  })

  it('keeps the settings.json keys other services own', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        webui: { host: '127.0.0.1', port: 8765 },
        enabledPlugins: { 'acme/github': true },
      }),
    )
    const loaded = await loadLocalConfig(dir)
    await saveLocalConfig(dir, {
      ...loaded,
      browser: { ...loaded.browser, linkTarget: 'builtin' },
    })
    const raw = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    expect(raw.enabledPlugins).toEqual({ 'acme/github': true })
    expect(raw.browser.linkTarget).toBe('builtin')
  })

  it('parses legacy snake_case desktop pet and open_browser keys', () => {
    const parsed = parseLocalConfig({
      webui: { host: '0.0.0.0', port: '70000', open_browser: true },
      desktop_pet: { enabled: 1, auto_start_with_webui: false },
      permissions: {
        rules: [
          {
            id: 'deny-secrets',
            action: 'deny',
            tool: 'write_file',
            path_glob: 'secrets/**',
          },
          { id: '', action: 'allow', tool: 'read_file' },
        ],
      },
    })

    expect(parsed.webui).toEqual({
      host: '0.0.0.0',
      port: 8765,
      openBrowser: true,
    })
    expect(parsed.desktopPet).toEqual({
      enabled: true,
      autoStartWithWebui: false,
    })
    expect(parsed.prompt).toEqual({ profile: 'technical' })
    expect(Object.keys(parsed).sort()).toEqual([
      'browser',
      'desktopPet',
      'prompt',
      'sessions',
      'taskBudget',
      'webTools',
      'webui',
    ])
  })

  it('tolerates retired settings keys and drops them on save', async () => {
    const path = localConfigPath(dir)
    await writeFile(
      path,
      JSON.stringify({
        webui: { port: 9100 },
        memory: { hybridMemory: 'on' },
        codeIntelligence: { mode: 'on' },
        workspace: {
          fileCheckpoints: { enabled: true },
          git_rewind: { mode: 'on' },
        },
        permissions: { rules: [{ id: 'x', action: 'deny', tool: 'bash' }] },
        someFutureKey: { nested: true },
      }),
      'utf8',
    )

    const loaded = await loadLocalConfig(dir)
    expect(loaded.webui.port).toBe(9100)
    expect(Object.keys(loaded).sort()).toEqual([
      'browser',
      'desktopPet',
      'prompt',
      'sessions',
      'taskBudget',
      'webTools',
      'webui',
    ])
    expect(existsSync(path)).toBe(true)
    expect(await localConfigDiagnostics(dir)).toMatchObject({
      status: 'ok',
      exists: true,
    })

    await saveLocalConfig(dir, loaded)
    expect(
      Object.keys(JSON.parse(await readFile(path, 'utf8'))).sort(),
    ).toEqual([
      'browser',
      'desktopPet',
      'prompt',
      'sessions',
      'taskBudget',
      'webTools',
      'webui',
    ])
  })

  it('keeps the network tool switches, defaulting both on', async () => {
    const path = localConfigPath(dir)
    expect((await loadLocalConfig(dir)).webTools).toEqual({
      webFetch: true,
      webSearch: true,
    })
    await writeFile(
      path,
      JSON.stringify({ webTools: { webFetch: false, webSearch: 'yes' } }),
      'utf8',
    )
    const loaded = await loadLocalConfig(dir)
    expect(loaded.webTools).toEqual({ webFetch: false, webSearch: true })
    await saveLocalConfig(dir, {
      ...loaded,
      webTools: { webFetch: true, webSearch: false },
    })
    expect(JSON.parse(await readFile(path, 'utf8')).webTools).toEqual({
      webFetch: true,
      webSearch: false,
    })
    // Like `browser`, a save that leaves the switches out writes the defaults.
    const { webTools: _dropped, ...withoutSwitches } = loaded
    await saveLocalConfig(dir, withoutSwitches)
    expect(JSON.parse(await readFile(path, 'utf8')).webTools).toEqual({
      webFetch: true,
      webSearch: true,
    })
  })

  it('keeps the task budget, each value falling back to its default (KRN-03)', async () => {
    const path = localConfigPath(dir)
    const defaults = {
      maxSteps: 400,
      maxBackgroundSteps: 120,
      maxActiveAgents: 8,
      maxTotalAgents: 64,
      maxNoticeWakes: 32,
    }
    expect((await loadLocalConfig(dir)).taskBudget).toEqual(defaults)
    await writeFile(
      path,
      JSON.stringify({
        taskBudget: {
          maxSteps: 50,
          maxBackgroundSteps: 2.5,
          maxActiveAgents: 0,
          maxTotalAgents: '9',
          maxNoticeWakes: 0,
        },
      }),
      'utf8',
    )
    const loaded = await loadLocalConfig(dir)
    expect(loaded.taskBudget).toEqual({
      ...defaults,
      maxSteps: 50,
      maxNoticeWakes: 0,
    })
    const { taskBudget: _dropped, ...withoutBudget } = loaded
    await saveLocalConfig(dir, withoutBudget)
    expect(JSON.parse(await readFile(path, 'utf8')).taskBudget).toEqual(
      defaults,
    )
  })

  it('keeps the new-session permission, defaulting to workspace-write', async () => {
    const path = localConfigPath(dir)
    expect((await loadLocalConfig(dir)).sessions).toEqual({
      defaultPermission: 'workspace-write',
    })
    await writeFile(
      path,
      JSON.stringify({ sessions: { defaultPermission: 'root' } }),
      'utf8',
    )
    expect((await loadLocalConfig(dir)).sessions).toEqual({
      defaultPermission: 'workspace-write',
    })
    const loaded = await loadLocalConfig(dir)
    await saveLocalConfig(dir, {
      ...loaded,
      sessions: { defaultPermission: 'read-only' },
    })
    expect(JSON.parse(await readFile(path, 'utf8')).sessions).toEqual({
      defaultPermission: 'read-only',
    })
    expect((await loadLocalConfig(dir)).sessions.defaultPermission).toBe(
      'read-only',
    )
  })

  it('preserves corrupt config files and reports backups in diagnostics', async () => {
    const path = localConfigPath(dir)
    await writeFile(path, '{bad json', 'utf8')

    const loaded = await loadLocalConfig(dir)

    expect(loaded.webui.port).toBe(8765)
    expect(existsSync(path)).toBe(false)
    const diagnostics = await localConfigDiagnostics(dir)
    expect(diagnostics.status).toBe('missing')
    expect(diagnostics.exists).toBe(false)
    expect(diagnostics.corruptBackups).toHaveLength(1)
    expect(diagnostics.corruptBackups[0]!.path).toContain(
      'settings.json.corrupt-',
    )
    expect(diagnostics.corruptBackups[0]!.bytes).toBe('{bad json'.length)
  })
})
