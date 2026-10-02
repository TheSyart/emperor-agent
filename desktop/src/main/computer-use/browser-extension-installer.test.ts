import * as fsp from 'node:fs/promises'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionDetection } from './browser-extension-detect'
import {
  BrowserExtensionFolder,
  BrowserExtensionService,
  EXTENSION_STAMP,
  bundledExtensionSource,
  createBrowserExtensionService,
  displayPath,
  newerVersion,
  shippedEntry,
  type ExtensionBridge,
  type ExtensionFolderFs,
} from './browser-extension-installer'
import type { NmBridgeEvent } from './nm-bridge'

const cleanup: string[] = []
afterEach(async () => {
  for (const directory of cleanup.splice(0))
    await rm(directory, { recursive: true, force: true })
})

/** A fake shipped extension and an empty state root. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ext-folder-')))
  cleanup.push(root)
  const source = join(root, 'app', 'extension')
  await mkdir(join(source, 'icons'), { recursive: true })
  await mkdir(join(source, 'tests'), { recursive: true })
  await writeFile(
    join(source, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, version: '0.2.0', key: 'k' }),
  )
  await writeFile(join(source, 'service-worker.js'), 'export {}\n')
  await writeFile(join(source, 'welcome.html'), '<!doctype html>\n')
  await writeFile(join(source, 'icons', 'icon-128.png'), 'png')
  await writeFile(join(source, 'tests', 'worker.test.js'), 'test\n')
  await writeFile(join(source, 'README.md'), '# docs\n')
  await writeFile(join(source, '.DS_Store'), 'finder\n')
  const stateRoot = join(root, 'emperor')
  await mkdir(stateRoot)
  const target = join(stateRoot, 'browser-extension')
  return {
    root,
    source,
    stateRoot,
    target,
    folder: (fs?: ExtensionFolderFs) =>
      new BrowserExtensionFolder({ source, target, ...(fs ? { fs } : {}) }),
  }
}

async function tree(directory: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory())
      out.push(...(await tree(join(directory, entry.name), path)))
    else out.push(path)
  }
  return out.sort()
}

describe('the extension folder', () => {
  it('ships everything but the tests, the README and dot files', () => {
    expect(shippedEntry('manifest.json')).toBe(true)
    expect(shippedEntry('icons/icon-16.png')).toBe(true)
    expect(shippedEntry('tests/worker.test.js')).toBe(false)
    expect(shippedEntry('tests')).toBe(false)
    expect(shippedEntry('README.md')).toBe(false)
    expect(shippedEntry('.DS_Store')).toBe(false)
    expect(shippedEntry('icons/.DS_Store')).toBe(false)
    expect(shippedEntry(EXTENSION_STAMP)).toBe(false)
  })

  it('reads the extension this app really ships', async () => {
    const source = resolve(__dirname, '..', '..', '..', 'extension')
    const bundle = await new BrowserExtensionFolder({
      source,
      target: join(tmpdir(), 'never-written'),
    }).bundle()
    const manifest = JSON.parse(
      await readFile(join(source, 'manifest.json'), 'utf8'),
    ) as { version: string }
    expect(bundle.version).toBe(manifest.version)
    expect(bundle.files).toContain('manifest.json')
    expect(bundle.files).toContain('welcome.html')
    expect(bundle.files).toContain('icons/icon-128.png')
    expect(bundle.files.some((file) => file.startsWith('tests/'))).toBe(false)
    expect(bundle.files).not.toContain('README.md')
  })

  it('installs a real folder with a stamp, through a staging copy', async () => {
    const f = await fixture()
    const folder = f.folder()
    expect(await folder.installed()).toBeNull()
    const stamp = await folder.install()
    expect(stamp.version).toBe('0.2.0')
    expect(stamp.digest).toMatch(/^[0-9a-f]{64}$/)
    expect((await lstat(f.target)).isDirectory()).toBe(true)
    expect((await lstat(f.target)).isSymbolicLink()).toBe(false)
    expect(await tree(f.target)).toEqual([
      EXTENSION_STAMP,
      'icons/icon-128.png',
      'manifest.json',
      'service-worker.js',
      'welcome.html',
    ])
    expect(await folder.installed()).toEqual(stamp)
    // Nothing left beside it.
    expect(await readdir(f.stateRoot)).toEqual(['browser-extension'])
  })

  it('replaces the folder in place and keeps nothing of the old one', async () => {
    const f = await fixture()
    const folder = f.folder()
    const first = await folder.install()
    await writeFile(join(f.target, 'stale.js'), 'old\n')
    await writeFile(join(f.source, 'service-worker.js'), 'export const v = 2\n')
    const second = await folder.install()
    expect(second.digest).not.toBe(first.digest)
    expect(await tree(f.target)).not.toContain('stale.js')
    expect(await readFile(join(f.target, 'service-worker.js'), 'utf8')).toBe(
      'export const v = 2\n',
    )
    expect(await readdir(f.stateRoot)).toEqual(['browser-extension'])
  })

  it('puts the old folder back after a crash between the two renames', async () => {
    const f = await fixture()
    const first = await f.folder().install()
    await writeFile(join(f.source, 'welcome.html'), '<p>new</p>\n')
    let renames = 0
    const crashing: ExtensionFolderFs = {
      ...fsp,
      rename: async (from, to) => {
        // The second rename (staging → folder) never happens.
        if (++renames === 2)
          throw Object.assign(new Error('crash'), { code: 'EIO' })
        return fsp.rename(from, to)
      },
    }
    await expect(f.folder(crashing).install()).rejects.toThrow('crash')
    expect(await readdir(f.stateRoot)).toEqual(
      expect.arrayContaining([
        '.browser-extension.new',
        '.browser-extension.old',
      ]),
    )
    // Next start: the last good folder is back, the copy is gone.
    const folder = f.folder()
    await folder.recover()
    expect(await readdir(f.stateRoot)).toEqual(['browser-extension'])
    expect(await folder.installed()).toEqual(first)
    // An upgrade then finishes the job.
    expect(await folder.upgrade()).toBe(true)
    expect(await readFile(join(f.target, 'welcome.html'), 'utf8')).toBe(
      '<p>new</p>\n',
    )
  })

  it('drops what a crash after the second rename left behind', async () => {
    const f = await fixture()
    const folder = f.folder()
    await folder.install()
    await mkdir(join(f.stateRoot, '.browser-extension.old'))
    await mkdir(join(f.stateRoot, '.browser-extension.new'))
    await folder.recover()
    expect(await readdir(f.stateRoot)).toEqual(['browser-extension'])
    expect(await folder.installed()).not.toBeNull()
  })

  it('upgrades only a folder that exists and differs', async () => {
    const f = await fixture()
    const folder = f.folder()
    expect(await folder.upgrade()).toBe(false)
    expect(await readdir(f.stateRoot)).toEqual([])
    await folder.install()
    expect(await folder.upgrade()).toBe(false)
    await writeFile(
      join(f.source, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, version: '0.3.0', key: 'k' }),
    )
    expect(await folder.upgrade()).toBe(true)
    expect((await folder.installed())?.version).toBe('0.3.0')
  })

  it('refuses a bundle without a valid manifest', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'manifest.json'), '{"manifest_version":2}')
    await expect(f.folder().install()).rejects.toThrow(/manifest/)
    expect(await readdir(f.stateRoot)).toEqual([])
  })

  it('removes the folder and any leftovers', async () => {
    const f = await fixture()
    const folder = f.folder()
    await folder.install()
    await mkdir(join(f.stateRoot, '.browser-extension.new'))
    await folder.remove()
    expect(await readdir(f.stateRoot)).toEqual([])
    expect(await folder.installed()).toBeNull()
  })
})

describe('versions and paths', () => {
  it('compares dotted versions', () => {
    expect(newerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(newerVersion('0.2.0', undefined)).toBe(true)
    expect(newerVersion('0.2.0', '0.2.0')).toBe(false)
    expect(newerVersion('0.2.0', '0.10.0')).toBe(false)
    expect(newerVersion('1.0', '0.9.9')).toBe(true)
    expect(newerVersion('0.2.0', 'x')).toBe(false)
  })

  it('shows paths in the home folder with a tilde', () => {
    expect(displayPath('/Users/a/.emperor/browser-extension', '/Users/a')).toBe(
      '~/.emperor/browser-extension',
    )
    expect(displayPath('/tmp/emperor/browser-extension', '/Users/a')).toBe(
      '/tmp/emperor/browser-extension',
    )
  })
})

function detection(
  overrides: Partial<ExtensionDetection> & Pick<ExtensionDetection, 'browser'>,
): ExtensionDetection {
  return {
    name: overrides.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome',
    present: true,
    extension: 'none',
    elsewhere: null,
    developerMode: false,
    ...overrides,
  }
}

function fakeBridge(options: { ready?: string[]; stored?: string[] } = {}) {
  let listener: ((event: NmBridgeEvent) => void) | null = null
  const calls: unknown[][] = []
  const bridge: ExtensionBridge = {
    readyPairings: () => [...(options.ready ?? [])],
    storedPairings: async () =>
      (options.stored ?? []).map((pairingId) => ({ pairingId })),
    request: vi.fn(async (pairingId: string, method: string) => {
      calls.push(['request', pairingId, method])
      return {}
    }),
    revokePairing: vi.fn(async (pairingId: string) => {
      calls.push(['revoke', pairingId])
    }),
    connectBrowsers: vi.fn(async () => ({ browsers: ['chrome'] })),
    removeHostManifests: vi.fn(async () => {
      calls.push(['remove-manifests'])
    }),
    hostRegistrations: async () => ['chrome'],
    subscribe: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
  }
  return {
    bridge,
    calls,
    emit: (event: NmBridgeEvent) => listener?.(event),
    get subscribed() {
      return listener !== null
    },
  }
}

describe('the extension service', () => {
  it('reports the folder, each browser and whether it can reach Emperor', async () => {
    const f = await fixture()
    const { bridge } = fakeBridge()
    const service = new BrowserExtensionService({
      folder: f.folder(),
      bridge,
      homeDir: f.root,
      detect: async () => [
        detection({
          browser: 'chrome',
          extension: 'loaded',
          developerMode: true,
        }),
        detection({ browser: 'edge', present: false }),
      ],
    })
    expect(await service.status()).toEqual({
      folder: {
        path: f.target,
        displayPath: '~/emperor/browser-extension',
        ready: false,
        version: null,
      },
      bundledVersion: '0.2.0',
      browsers: [
        {
          browser: 'chrome',
          name: 'Google Chrome',
          present: true,
          extension: 'loaded',
          developerMode: true,
          hostRegistered: true,
        },
        {
          browser: 'edge',
          name: 'Microsoft Edge',
          present: false,
          extension: 'none',
          developerMode: false,
          hostRegistered: false,
        },
      ],
    })
  })

  it('names the other folder a browser loaded the extension from', async () => {
    const f = await fixture()
    const service = new BrowserExtensionService({
      folder: f.folder(),
      bridge: null,
      homeDir: f.root,
      detect: async () => [
        detection({
          browser: 'chrome',
          elsewhere: join(f.root, 'src', 'desktop', 'extension'),
        }),
      ],
    })
    const [chrome] = (await service.status()).browsers
    expect(chrome).toMatchObject({
      loadedFrom: '~/src/desktop/extension',
      hostRegistered: false,
    })
  })

  it('installs the folder and registers the browser host', async () => {
    const f = await fixture()
    const { bridge } = fakeBridge()
    const service = new BrowserExtensionService({
      folder: f.folder(),
      bridge,
      homeDir: f.root,
      detect: async () => [],
    })
    const result = await service.install()
    expect(result).toMatchObject({ ok: true, registered: ['chrome'] })
    expect(result.status.folder).toMatchObject({
      ready: true,
      version: '0.2.0',
    })
    expect(bridge.connectBrowsers).toHaveBeenCalledOnce()
  })

  it('says why no browser could be registered', async () => {
    const f = await fixture()
    const fake = fakeBridge()
    const service = new BrowserExtensionService({
      folder: f.folder(),
      bridge: fake.bridge,
      homeDir: f.root,
      detect: async () => [],
    })
    vi.mocked(fake.bridge.connectBrowsers).mockResolvedValueOnce({
      browsers: [],
      reason: 'no-host',
    })
    expect(await service.install()).toMatchObject({
      ok: true,
      registered: [],
      reason: 'no-host',
    })
    vi.mocked(fake.bridge.connectBrowsers).mockResolvedValueOnce({
      browsers: [],
    })
    expect(await service.install()).toMatchObject({ reason: 'no-browser' })
    // Without a bridge the folder still installs.
    const alone = new BrowserExtensionService({
      folder: f.folder(),
      bridge: null,
      homeDir: f.root,
      detect: async () => [],
    })
    expect(await alone.install()).toMatchObject({
      ok: true,
      reason: 'unavailable',
    })
  })

  it('reports a missing bundle instead of throwing', async () => {
    const f = await fixture()
    await rm(f.source, { recursive: true })
    const service = new BrowserExtensionService({
      folder: f.folder(),
      bridge: null,
      homeDir: f.root,
      detect: async () => [],
    })
    expect(await service.install()).toMatchObject({
      ok: false,
      reason: 'no-source',
    })
  })

  it('removes: connected extensions uninstall, pairings, hosts and folder go', async () => {
    const f = await fixture()
    const fake = fakeBridge({
      ready: ['ready-1'],
      stored: ['ready-1', 'closed-2'],
    })
    const service = new BrowserExtensionService({
      folder: f.folder(),
      bridge: fake.bridge,
      homeDir: f.root,
      detect: async () => [],
    })
    await service.install()
    const result = await service.remove()
    expect(result).toMatchObject({ ok: true, uninstalled: 1 })
    expect(fake.calls).toEqual([
      ['request', 'ready-1', 'extension.uninstall'],
      ['revoke', 'ready-1'],
      ['revoke', 'closed-2'],
      ['remove-manifests'],
    ])
    expect(await readdir(f.stateRoot)).toEqual([])
    expect(result.status.folder.ready).toBe(false)
  })

  it('keeps removing when a browser does not answer', async () => {
    const f = await fixture()
    const fake = fakeBridge({ ready: ['ready-1'] })
    vi.mocked(fake.bridge.request).mockRejectedValueOnce(
      new Error('DRIVER_UNAVAILABLE'),
    )
    const service = new BrowserExtensionService({
      folder: f.folder(),
      bridge: fake.bridge,
      homeDir: f.root,
      detect: async () => [],
    })
    await service.install()
    expect(await service.remove()).toMatchObject({ ok: true, uninstalled: 0 })
    expect(await readdir(f.stateRoot)).toEqual([])
  })

  it('upgrades at start and reloads an older extension once', async () => {
    const f = await fixture()
    await f.folder().install()
    await writeFile(
      join(f.source, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, version: '0.3.0', key: 'k' }),
    )
    const fake = fakeBridge()
    const service = new BrowserExtensionService({
      folder: f.folder(),
      bridge: fake.bridge,
      homeDir: f.root,
      detect: async () => [],
    })
    await service.start()
    expect((await f.folder().installed())?.version).toBe('0.3.0')
    const ready = (pairingId: string, version?: string): NmBridgeEvent => ({
      type: 'ready',
      pairingId,
      extensionId: 'oobcokoopgkhlhpohfdpelkafiidojjn',
      workerEpoch: 1,
      ...(version ? { version } : {}),
    })
    fake.emit(ready('p-1', '0.2.0'))
    fake.emit(ready('p-2', '0.3.0'))
    await vi.waitFor(() =>
      expect(fake.calls).toEqual([['request', 'p-1', 'extension.reload']]),
    )
    // The reloaded worker connects again, still old: no reload loop.
    fake.emit(ready('p-1', '0.2.0'))
    // An extension that predates versions is reloaded too.
    fake.emit(ready('p-3'))
    await vi.waitFor(() =>
      expect(fake.calls).toEqual([
        ['request', 'p-1', 'extension.reload'],
        ['request', 'p-3', 'extension.reload'],
      ]),
    )
    service.dispose()
    expect(fake.subscribed).toBe(false)
  })

  it('reveals the folder only once Emperor put it there', async () => {
    const f = await fixture()
    const service = new BrowserExtensionService({
      folder: f.folder(),
      bridge: null,
      homeDir: f.root,
      detect: async () => [],
    })
    expect(await service.revealPath()).toBeNull()
    await service.install()
    expect(await service.revealPath()).toBe(f.target)
  })

  it('takes the extension from the app, or from desktop/extension in development', () => {
    expect(
      bundledExtensionSource({
        packaged: true,
        resourcesPath: '/Applications/Emperor Agent.app/Contents/Resources',
        desktopRoot: '/src/desktop',
      }),
    ).toBe(
      '/Applications/Emperor Agent.app/Contents/Resources/browser-extension',
    )
    expect(
      bundledExtensionSource({
        packaged: false,
        resourcesPath: '/unused',
        desktopRoot: '/src/desktop',
      }),
    ).toBe('/src/desktop/extension')
  })

  it('builds the service for a state root and a home it is given', async () => {
    const f = await fixture()
    const service = createBrowserExtensionService({
      packaged: false,
      resourcesPath: '',
      desktopRoot: resolve(__dirname, '..', '..', '..'),
      stateRoot: f.stateRoot,
      // A home without Chrome or Edge: nothing real is read.
      homeDir: f.root,
      bridge: null,
    })
    const status = await service.status()
    expect(status.folder).toMatchObject({
      path: f.target,
      displayPath: '~/emperor/browser-extension',
      ready: false,
    })
    expect(status.bundledVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(status.browsers.map((item) => [item.browser, item.present])).toEqual(
      [
        ['chrome', false],
        ['edge', false],
      ],
    )
  })

  it('reloads nothing while the folder is not installed', async () => {
    const f = await fixture()
    const fake = fakeBridge()
    const service = new BrowserExtensionService({
      folder: f.folder(),
      bridge: fake.bridge,
      homeDir: f.root,
      detect: async () => [],
    })
    await service.start()
    fake.emit({
      type: 'ready',
      pairingId: 'p-1',
      extensionId: 'oobcokoopgkhlhpohfdpelkafiidojjn',
      workerEpoch: 1,
      version: '0.1.0',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.calls).toEqual([])
    expect(await readdir(f.stateRoot)).toEqual([])
  })
})
