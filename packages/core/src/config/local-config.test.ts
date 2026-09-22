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
      'desktopPet',
      'prompt',
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
      'desktopPet',
      'prompt',
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
    ).toEqual(['desktopPet', 'prompt', 'webui'])
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
