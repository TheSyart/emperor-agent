import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NmBridgeServer } from './nm-bridge'
import type { PairingStore } from './nm-bridge-store'
import {
  EMPEROR_EXTENSION_ID,
  NM_BROWSERS,
  NmManifestRegistrar,
  isEmperorHostPath,
  nmHostArchDirectories,
  nmHostCandidates,
  nmManifestText,
  resolveNmHostPath,
  type NmBrowser,
  type NmManifestFs,
} from './nm-manifest'

const A = 'aofcidkmgjlbaidneiodhljmoleejnpe'
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)
const OLD_HOST =
  '/Users/someone/emperor-agent/desktop/dist/mac-arm64/Emperor Agent.app/Contents/Library/Helpers/emperor-nm-host'

const cleanup: string[] = []

afterEach(async () => {
  for (const directory of cleanup.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function tempDir(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanup.push(directory)
  return directory
}

/** An isolated fake home plus a packaged app holding an executable host. */
async function fixture() {
  const root = await tempDir('nm-manifest-')
  const home = join(root, 'home')
  await mkdir(home)
  const app = join(root, 'Applications', 'Emperor Agent.app')
  const helpers = join(app, 'Contents', 'Library', 'Helpers')
  await mkdir(helpers, { recursive: true })
  await mkdir(join(app, 'Contents', 'Resources'))
  await writeFile(join(helpers, 'emperor-nm-host'), '#!/bin/sh\n')
  await chmod(join(helpers, 'emperor-nm-host'), 0o755)
  const hostPath = resolveNmHostPath({
    packaged: true,
    resourcesPath: join(app, 'Contents', 'Resources'),
  })
  expect(hostPath).toBe(join(helpers, 'emperor-nm-host'))
  const support = join(home, 'Library', 'Application Support')
  const browserRoot = (browser: NmBrowser) =>
    join(support, NM_BROWSERS[browser])
  const manifest = (browser: NmBrowser) =>
    join(
      browserRoot(browser),
      'NativeMessagingHosts',
      'com.emperor.agent.browser.json',
    )
  const install = async (
    browser: NmBrowser,
    text: string,
    directoryMode = 0o700,
  ) => {
    const directory = join(browserRoot(browser), 'NativeMessagingHosts')
    await mkdir(directory, { recursive: true })
    await chmod(directory, directoryMode)
    await writeFile(manifest(browser), text, { mode: 0o600 })
  }
  const read = async (browser: NmBrowser) =>
    JSON.parse(await readFile(manifest(browser), 'utf8')) as {
      path: string
      allowed_origins: string[]
    }
  return {
    root,
    home,
    hostPath: hostPath!,
    browserRoot,
    manifest,
    install,
    read,
    registrar: (
      overrides: { hostPath?: string | null; fs?: NmManifestFs } = {},
    ) =>
      new NmManifestRegistrar({
        home,
        hostPath: hostPath!,
        ...overrides,
      }),
  }
}

describe('Native Messaging host location', () => {
  it('finds the packaged helper and the development build under either Intel arch name', async () => {
    expect(
      nmHostCandidates({
        packaged: true,
        resourcesPath: '/Applications/Emperor Agent.app/Contents/Resources',
      }),
    ).toEqual([
      '/Applications/Emperor Agent.app/Contents/Library/Helpers/emperor-nm-host',
    ])
    expect(nmHostArchDirectories('arm64')).toEqual(['arm64'])
    expect(nmHostArchDirectories('x64')).toEqual(['x86_64', 'x64'])
    expect(nmHostArchDirectories('x86_64')).toEqual(['x86_64', 'x64'])
    expect(
      nmHostCandidates({
        packaged: false,
        desktopRoot: '/repo/desktop',
        arch: 'x64',
      }),
    ).toEqual([
      '/repo/desktop/native/browser-host/build/x86_64/release/emperor-nm-host',
      '/repo/desktop/native/browser-host/build/x64/release/emperor-nm-host',
    ])
    expect(nmHostCandidates({ packaged: true })).toEqual([])

    const desktopRoot = await tempDir('nm-host-dev-')
    expect(
      resolveNmHostPath({ packaged: false, desktopRoot, arch: 'x64' }),
    ).toBeNull()
    const legacy = join(desktopRoot, 'native/browser-host/build/x64/release')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'emperor-nm-host'), '')
    // Present but not executable: not a usable host.
    expect(
      resolveNmHostPath({ packaged: false, desktopRoot, arch: 'x64' }),
    ).toBeNull()
    await chmod(join(legacy, 'emperor-nm-host'), 0o755)
    expect(
      resolveNmHostPath({ packaged: false, desktopRoot, arch: 'x64' }),
    ).toBe(join(legacy, 'emperor-nm-host'))
    const normalized = join(
      desktopRoot,
      'native/browser-host/build/x86_64/release',
    )
    await mkdir(normalized, { recursive: true })
    await writeFile(join(normalized, 'emperor-nm-host'), '', { mode: 0o755 })
    expect(
      resolveNmHostPath({ packaged: false, desktopRoot, arch: 'x64' }),
    ).toBe(join(normalized, 'emperor-nm-host'))
  })

  it('recognizes only Emperor host layouts as Emperor-owned', () => {
    expect(isEmperorHostPath(OLD_HOST)).toBe(true)
    expect(
      isEmperorHostPath(
        '/tmp/x/mac-arm64/Renamed.app/Contents/Library/Helpers/emperor-nm-host',
      ),
    ).toBe(true)
    expect(
      isEmperorHostPath(
        '/r/desktop/native/browser-host/build/arm64/release/emperor-nm-host',
      ),
    ).toBe(true)
    expect(
      isEmperorHostPath(
        '/r/desktop/native/browser-host/build/x86_64/fixture/emperor-nm-host',
      ),
    ).toBe(true)
    expect(isEmperorHostPath('/r/desktop/out/native/emperor-nm-host')).toBe(
      true,
    )
    expect(isEmperorHostPath('/opt/custom/host', '/opt/custom/host')).toBe(true)
    expect(isEmperorHostPath('/usr/local/bin/emperor-nm-host')).toBe(false)
    expect(isEmperorHostPath('/usr/local/bin/other-host')).toBe(false)
    expect(
      isEmperorHostPath('/A.app/Contents/Library/Helpers/other-host'),
    ).toBe(false)
    expect(
      isEmperorHostPath(
        'relative/A.app/Contents/Library/Helpers/emperor-nm-host',
      ),
    ).toBe(false)
  })
})

describe('Native Messaging manifest text', () => {
  it('matches the pretty-printed, sorted-key JSON that emperor-nm-host writes', () => {
    expect(nmManifestText(OLD_HOST, [A])).toBe(
      [
        '{',
        '  "allowed_origins" : [',
        `    "chrome-extension:\\/\\/${A}\\/"`,
        '  ],',
        '  "description" : "Emperor Agent browser connection",',
        '  "name" : "com.emperor.agent.browser",',
        `  "path" : "${OLD_HOST.replace(/\//g, '\\/')}",`,
        '  "type" : "stdio"',
        '}',
      ].join('\n'),
    )
    expect(JSON.parse(nmManifestText('/h/emperor-nm-host', [C, B, C]))).toEqual(
      {
        name: 'com.emperor.agent.browser',
        description: 'Emperor Agent browser connection',
        path: '/h/emperor-nm-host',
        type: 'stdio',
        allowed_origins: [
          `chrome-extension://${B}/`,
          `chrome-extension://${C}/`,
        ],
      },
    )
    expect(() => nmManifestText('/h/emperor-nm-host', [])).toThrow()
    expect(() =>
      nmManifestText('/h/emperor-nm-host', ['Z'.repeat(32)]),
    ).toThrow()
    expect(() => nmManifestText('h/emperor-nm-host', [A])).toThrow()
  })

  const builtHost = resolve(
    fileURLToPath(
      new URL('../../../native/browser-host/build', import.meta.url),
    ),
    process.arch === 'x64' ? 'x86_64' : process.arch,
    'release/emperor-nm-host',
  )
  it.skipIf(process.platform !== 'darwin' || !existsSync(builtHost))(
    'is byte-identical to the built host --manifest output',
    () => {
      // --manifest only prints; it never registers anything.
      const output = execFileSync(
        builtHost,
        ['--manifest', '--host-path', builtHost, '--extension-id', A],
        { encoding: 'utf8' },
      )
      expect(`${nmManifestText(builtHost, [A])}\n`).toBe(output)
    },
  )
})

describe('Native Messaging manifest registrar', () => {
  it('creates a 0600 manifest in a new 0700 directory only for an explicitly connected browser', async () => {
    const f = await fixture()
    await mkdir(f.browserRoot('chrome'), { recursive: true })
    await mkdir(f.browserRoot('edge'), { recursive: true })
    const changes = await f.registrar().register(A, [], ['chrome', 'chromium'])
    expect(changes).toEqual([
      { browser: 'chrome', file: f.manifest('chrome'), action: 'created' },
      {
        browser: 'chromium',
        file: f.manifest('chromium'),
        action: 'skipped',
        reason: 'no-browser',
      },
    ])
    expect(await readFile(f.manifest('chrome'), 'utf8')).toBe(
      nmManifestText(f.hostPath, [A]),
    )
    expect((await stat(f.manifest('chrome'))).mode & 0o777).toBe(0o600)
    expect(
      (await stat(join(f.browserRoot('chrome'), 'NativeMessagingHosts'))).mode &
        0o777,
    ).toBe(0o700)
    // Edge exists but was not chosen; Chromium never ran: neither is touched.
    expect(
      existsSync(join(f.browserRoot('edge'), 'NativeMessagingHosts')),
    ).toBe(false)
    expect(existsSync(f.browserRoot('chromium'))).toBe(false)
    expect(
      await readdir(join(f.browserRoot('chrome'), 'NativeMessagingHosts')),
    ).toEqual(['com.emperor.agent.browser.json'])
  })

  it('keeps an existing directory mode and needs a host to create', async () => {
    const f = await fixture()
    const directory = join(f.browserRoot('chrome'), 'NativeMessagingHosts')
    await mkdir(directory, { recursive: true })
    await chmod(directory, 0o755)
    expect(
      await f.registrar({ hostPath: null }).register(A, [], ['chrome']),
    ).toEqual([
      {
        browser: 'chrome',
        file: f.manifest('chrome'),
        action: 'skipped',
        reason: 'no-host',
      },
    ])
    expect(existsSync(f.manifest('chrome'))).toBe(false)
    await f.registrar().register(A, [], ['chrome'])
    expect((await stat(directory)).mode & 0o777).toBe(0o755)
    expect((await stat(f.manifest('chrome'))).mode & 0o777).toBe(0o600)
  })

  it('repoints a stale Emperor manifest at startup and adds missing paired extensions', async () => {
    const f = await fixture()
    await f.install('chrome', nmManifestText(OLD_HOST, [A]))
    await mkdir(f.browserRoot('edge'), { recursive: true })
    await chmod(f.manifest('chrome'), 0o644)
    const registrar = f.registrar()
    expect(await registrar.reconcile([])).toEqual([])
    expect((await f.read('chrome')).path).toBe(OLD_HOST)

    expect(await registrar.reconcile([B])).toEqual([
      { browser: 'chrome', file: f.manifest('chrome'), action: 'updated' },
    ])
    expect(await readFile(f.manifest('chrome'), 'utf8')).toBe(
      nmManifestText(f.hostPath, [A, B]),
    )
    // Rewritten files are 0600 again; startup never registers a new browser.
    expect((await stat(f.manifest('chrome'))).mode & 0o777).toBe(0o600)
    expect(
      existsSync(join(f.browserRoot('edge'), 'NativeMessagingHosts')),
    ).toBe(false)
    expect(await registrar.reconcile([A, B])).toEqual([
      { browser: 'chrome', file: f.manifest('chrome'), action: 'unchanged' },
    ])
  })

  it('leaves the host path alone when this build has no registrable host', async () => {
    const f = await fixture()
    await f.install('chrome', nmManifestText(OLD_HOST, [A]))
    const registrar = f.registrar({ hostPath: null })
    expect(await registrar.reconcile([A])).toEqual([
      { browser: 'chrome', file: f.manifest('chrome'), action: 'unchanged' },
    ])
    await registrar.register(B, [A])
    expect(await f.read('chrome')).toMatchObject({
      path: OLD_HOST,
      allowed_origins: [`chrome-extension://${A}/`, `chrome-extension://${B}/`],
    })
  })

  it('adds an approved extension to every Emperor manifest without creating others', async () => {
    const f = await fixture()
    await f.install('chrome', nmManifestText(f.hostPath, [A]))
    await f.install('edge', nmManifestText(OLD_HOST, [A]))
    await mkdir(f.browserRoot('chromium'), { recursive: true })
    const changes = await f.registrar().register(B, [A])
    expect(changes.map((item) => [item.browser, item.action])).toEqual([
      ['chrome', 'updated'],
      ['edge', 'updated'],
    ])
    for (const browser of ['chrome', 'edge'] as const)
      expect(await readFile(f.manifest(browser), 'utf8')).toBe(
        nmManifestText(f.hostPath, [A, B]),
      )
    expect(
      existsSync(join(f.browserRoot('chromium'), 'NativeMessagingHosts')),
    ).toBe(false)
    await expect(f.registrar().register('not-an-id')).rejects.toThrow(
      'extension ID',
    )
  })

  it('narrows allowed_origins on revoke and removes Emperor manifests with the last pairing', async () => {
    const f = await fixture()
    await f.install('chrome', nmManifestText(f.hostPath, [A, B]))
    await f.install('edge', nmManifestText(OLD_HOST, [B]))
    const registrar = f.registrar()

    await registrar.unregister(B, [A, B])
    expect((await f.read('chrome')).allowed_origins).toEqual([
      `chrome-extension://${A}/`,
      `chrome-extension://${B}/`,
    ])

    await registrar.unregister(B, [A])
    expect((await f.read('chrome')).allowed_origins).toEqual([
      `chrome-extension://${A}/`,
    ])
    expect(await f.read('edge')).toEqual(
      JSON.parse(nmManifestText(f.hostPath, [A])),
    )

    expect(await registrar.unregister(A, [])).toEqual([
      { browser: 'chrome', file: f.manifest('chrome'), action: 'removed' },
      { browser: 'edge', file: f.manifest('edge'), action: 'removed' },
    ])
    expect(existsSync(f.manifest('chrome'))).toBe(false)
    expect(existsSync(f.manifest('edge'))).toBe(false)
    // The browser's own directory stays.
    expect(
      existsSync(join(f.browserRoot('chrome'), 'NativeMessagingHosts')),
    ).toBe(true)
  })

  it('refuses to touch a manifest that points elsewhere, is not ours, or is a symlink', async () => {
    const f = await fixture()
    const foreign = JSON.stringify({
      name: 'com.emperor.agent.browser',
      description: 'someone else',
      path: '/usr/local/bin/other-host',
      type: 'stdio',
      allowed_origins: [`chrome-extension://${C}/`],
    })
    await f.install('chrome', foreign)
    await f.install('chromium', '{not json')
    await f.install(
      'chrome-beta',
      nmManifestText(f.hostPath, [A]).replace(
        'com.emperor.agent.browser',
        'com.other.host',
      ),
    )
    const outside = join(f.root, 'outside.json')
    await writeFile(outside, nmManifestText(OLD_HOST, [A]))
    await mkdir(join(f.browserRoot('edge'), 'NativeMessagingHosts'), {
      recursive: true,
    })
    await symlink(outside, f.manifest('edge'))
    const realCanary = join(f.root, 'elsewhere')
    await mkdir(realCanary)
    await writeFile(
      join(realCanary, 'com.emperor.agent.browser.json'),
      nmManifestText(OLD_HOST, [A]),
    )
    await mkdir(f.browserRoot('chrome-canary'), { recursive: true })
    await symlink(
      realCanary,
      join(f.browserRoot('chrome-canary'), 'NativeMessagingHosts'),
    )
    const before = await Promise.all(
      (['chrome', 'chromium', 'chrome-beta'] as const).map((browser) =>
        readFile(f.manifest(browser), 'utf8'),
      ),
    )
    const registrar = f.registrar()

    for (const run of [
      () => registrar.reconcile([A]),
      () => registrar.register(A, [], ['chrome', 'edge']),
      () => registrar.unregister(A, []),
    ]) {
      const changes = await run()
      expect(changes.every((item) => item.action === 'skipped')).toBe(true)
      expect(
        Object.fromEntries(changes.map((item) => [item.browser, item.reason])),
      ).toEqual({
        chrome: 'foreign',
        'chrome-beta': 'foreign',
        'chrome-canary': 'unsafe',
        chromium: 'foreign',
        edge: 'foreign',
      })
    }
    expect(
      await Promise.all(
        (['chrome', 'chromium', 'chrome-beta'] as const).map((browser) =>
          readFile(f.manifest(browser), 'utf8'),
        ),
      ),
    ).toEqual(before)
    expect((await lstat(f.manifest('edge'))).isSymbolicLink()).toBe(true)
    expect(await readFile(outside, 'utf8')).toBe(nmManifestText(OLD_HOST, [A]))
    expect(
      await readFile(
        join(realCanary, 'com.emperor.agent.browser.json'),
        'utf8',
      ),
    ).toBe(nmManifestText(OLD_HOST, [A]))
  })

  it('replaces atomically and leaves no temporary file when the rename fails', async () => {
    const f = await fixture()
    await f.install('chrome', nmManifestText(OLD_HOST, [A]))
    const failing: NmManifestFs = {
      ...fsp,
      rename: async () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' })
      },
    }
    expect(await f.registrar({ fs: failing }).reconcile([A])).toEqual([
      {
        browser: 'chrome',
        file: f.manifest('chrome'),
        action: 'failed',
        reason: 'io',
      },
    ])
    expect(await readFile(f.manifest('chrome'), 'utf8')).toBe(
      nmManifestText(OLD_HOST, [A]),
    )
    expect(
      await readdir(join(f.browserRoot('chrome'), 'NativeMessagingHosts')),
    ).toEqual(['com.emperor.agent.browser.json'])
  })
})

describe('connecting Chrome/Edge from Settings', () => {
  it('pins the extension ID to the public key in the extension manifest', () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../../extension/manifest.json', import.meta.url),
        ),
        'utf8',
      ),
    ) as { key: string }
    const hex = createHash('sha256')
      .update(Buffer.from(manifest.key, 'base64'))
      .digest('hex')
      .slice(0, 32)
    const id = [...hex]
      .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
      .join('')
    expect(id).toBe(EMPEROR_EXTENSION_ID)
  })

  // The Native Messaging bridge exists only on macOS.
  it.skipIf(process.platform !== 'darwin')(
    'registers the host for the Emperor extension in every browser that has run',
    async () => {
      const f = await fixture()
      await mkdir(f.browserRoot('chrome'), { recursive: true })
      await mkdir(f.browserRoot('edge'), { recursive: true })
      const pairings: PairingStore = {
        get: async () => null,
        put: async () => undefined,
        remove: async () => undefined,
        list: async () => [],
      }
      const bridge = new NmBridgeServer({
        pairings,
        manifests: f.registrar(),
        socketPath: join(f.root, 'nm.sock'),
        heartbeatMs: 0,
      })
      await bridge.start()
      try {
        await expect(bridge.connectBrowsers()).resolves.toEqual({
          browsers: ['chrome', 'edge'],
        })
        expect((await f.read('chrome')).allowed_origins).toEqual([
          `chrome-extension://${EMPEROR_EXTENSION_ID}/`,
        ])
        expect(existsSync(f.browserRoot('chromium'))).toBe(false)
        // A build without a registrable host says so instead of pretending.
        const devBridge = new NmBridgeServer({
          pairings,
          manifests: f.registrar({ hostPath: null }),
          socketPath: join(f.root, 'nm2.sock'),
          heartbeatMs: 0,
        })
        await devBridge.start()
        try {
          await rm(f.manifest('chrome'))
          await rm(f.manifest('edge'))
          await expect(devBridge.connectBrowsers()).resolves.toEqual({
            browsers: [],
            reason: 'no-host',
          })
        } finally {
          await devBridge.stop()
        }
      } finally {
        await bridge.stop()
      }
    },
  )
})
