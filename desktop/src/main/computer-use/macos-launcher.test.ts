import { randomUUID } from 'node:crypto'
import { createConnection, createServer, type Socket } from 'node:net'
import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  FrameDecoder,
  encodeJsonFrame,
} from '../../../../packages/core/src/harness/computer-use/protocol/framing'
import {
  installPackagedMacosHelper,
  launchMacosHelper,
  macosHelperAppPath,
  macosNativeArch,
  macosSocketLocation,
  type MacosHelperInstallFs,
  type MacosHelperInstallSystem,
} from './macos-launcher'

const UID = 501
const APP = '/Applications/Emperor Agent.app'
const MAIN = `${APP}/Contents/MacOS/Emperor Agent`
const SOURCE = `${APP}/Contents/Library/Helpers/Emperor Computer Helper.app`
const HOME = '/Users/tester'
const INSTALLED_ROOT = `${HOME}/.emperor/native-helpers`
const HELPER_ID = 'com.emperor.agent.desktop.computer-helper'
const TEAM = 'TEAM123456'
const CDHASH = 'a'.repeat(40)
const OLD_CDHASH = 'b'.repeat(40)

interface FakeSignature {
  readonly identifier: string
  readonly team: string | null
  readonly cdHash: string
  readonly adHoc: boolean
}
interface FakeEntry {
  kind: 'dir' | 'file' | 'symlink'
  uid: number
  mode: number
  target?: string
  signature?: FakeSignature
  invalid?: boolean
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

/** In-memory codesign/ditto/plutil/ps and filesystem for the installer. */
class FakeInstallSystem implements MacosHelperInstallSystem {
  readonly entries = new Map<string, FakeEntry>()
  readonly calls: string[][] = []
  processes: string[] = [MAIN]
  psFails = false
  /** Signature applied by `codesign --force --sign -` (Preview re-seal). */
  resealed: FakeSignature | null = null
  /** Lets a test corrupt what ditto copies. */
  onDitto: ((destination: string) => void) | null = null
  private temporaryCount = 0

  constructor(signatures: { app: FakeSignature; helper: FakeSignature }) {
    this.add(MAIN, 'file')
    this.add(`${SOURCE}/Contents/MacOS/emperor-computer-helper`, 'file')
    this.entries.get(APP)!.signature = signatures.app
    this.entries.get(SOURCE)!.signature = signatures.helper
  }

  add(path: string, kind: FakeEntry['kind'], extra: Partial<FakeEntry> = {}) {
    const parts = path.split('/').filter(Boolean)
    let current = ''
    for (const part of parts.slice(0, -1)) {
      current += `/${part}`
      if (!this.entries.has(current))
        this.entries.set(current, { kind: 'dir', uid: UID, mode: 0o755 })
    }
    this.entries.set(path, { kind, uid: UID, mode: 0o755, ...extra })
  }

  has(path: string): boolean {
    return this.entries.has(path)
  }

  children(path: string): string[] {
    return [...this.entries.keys()]
      .filter((key) => key.startsWith(`${path}/`))
      .map((key) => key.slice(path.length + 1))
      .filter((rest) => !rest.includes('/'))
      .sort()
  }

  private subtree(path: string): [string, FakeEntry][] {
    return [...this.entries].filter(
      ([key]) => key === path || key.startsWith(`${path}/`),
    )
  }

  private entry(path: string): FakeEntry {
    const entry = this.entries.get(path)
    if (!entry) throw errno('ENOENT')
    return entry
  }

  async execFile(file: string, args: readonly string[]) {
    this.calls.push([file, ...args])
    if (file === 'ps') {
      if (this.psFails) throw new Error('ps failed')
      return { stdout: `${this.processes.join('\n')}\n`, stderr: '' }
    }
    if (file === 'plutil') return { stdout: '', stderr: '' }
    if (file === 'ditto') {
      const [from, to] = args.filter((arg) => !arg.startsWith('--')) as [
        string,
        string,
      ]
      if (this.has(to)) throw new Error('ditto destination exists')
      this.add(to, 'dir')
      for (const [key, entry] of this.subtree(from))
        this.entries.set(to + key.slice(from.length), { ...entry, uid: UID })
      this.onDitto?.(to)
      return { stdout: '', stderr: '' }
    }
    if (file !== 'codesign') throw new Error(`unexpected command ${file}`)
    if (args[0] === '--force') {
      const target = this.entry(args[3]!)
      if (!this.resealed) throw new Error('no reseal identity')
      target.signature = this.resealed
      return { stdout: '', stderr: '' }
    }
    const path = args[args.length - 1]!
    const signature = this.entry(path).signature
    if (!signature || this.entry(path).invalid)
      throw new Error('codesign failed')
    if (args[0] === '--verify') return { stdout: '', stderr: '' }
    const flags = signature.adHoc ? '0x2(adhoc)' : '0x10000(runtime)'
    return {
      stdout: '',
      stderr: [
        `Executable=${path}/Contents/MacOS/x`,
        `Identifier=${signature.identifier}`,
        'Format=app bundle with Mach-O thin (arm64)',
        `CodeDirectory v=20500 size=1 flags=${flags} hashes=1+7 location=embedded`,
        `CDHash=${signature.cdHash}`,
        `TeamIdentifier=${signature.team ?? 'not set'}`,
        '',
      ].join('\n'),
    }
  }

  readonly fs: MacosHelperInstallFs = {
    lstat: async (path) => {
      const entry = this.entry(path)
      return {
        isDirectory: () => entry.kind === 'dir',
        isSymbolicLink: () => entry.kind === 'symlink',
        uid: entry.uid,
        mode: entry.mode,
      }
    },
    mkdir: async (path, options) => {
      let current = ''
      for (const part of path.split('/').filter(Boolean)) {
        current += `/${part}`
        if (!this.entries.has(current))
          this.entries.set(current, {
            kind: 'dir',
            uid: UID,
            mode: options.mode,
          })
      }
      return undefined
    },
    chmod: async (path, mode) => {
      this.entry(path).mode = mode
    },
    mkdtemp: async (prefix) => {
      const path = `${prefix}${++this.temporaryCount}`
      this.entries.set(path, { kind: 'dir', uid: UID, mode: 0o700 })
      return path
    },
    readdir: async (path) => {
      if (this.entry(path).kind !== 'dir') throw errno('ENOTDIR')
      return this.children(path)
    },
    realpath: async (path) => {
      let resolved = ''
      for (const part of path.split('/').filter(Boolean)) {
        resolved += `/${part}`
        const entry = this.entry(resolved)
        if (entry.kind === 'symlink') resolved = entry.target!
      }
      return resolved || '/'
    },
    rename: async (from, to) => {
      this.entry(from)
      if (this.has(to)) {
        if (this.children(to).length > 0) throw errno('ENOTEMPTY')
        this.entries.delete(to)
      }
      for (const [key, entry] of this.subtree(from)) {
        this.entries.delete(key)
        this.entries.set(to + key.slice(from.length), entry)
      }
    },
    rm: async (path) => {
      for (const [key] of this.subtree(path)) this.entries.delete(key)
    },
  }
}

const signedApp: FakeSignature = {
  identifier: 'com.emperor.agent.desktop',
  team: TEAM,
  cdHash: 'c'.repeat(40),
  adHoc: false,
}
const signedHelper: FakeSignature = {
  identifier: HELPER_ID,
  team: TEAM,
  cdHash: CDHASH,
  adHoc: false,
}

function install(system: FakeInstallSystem) {
  return installPackagedMacosHelper(SOURCE, {
    home: HOME,
    uid: UID,
    runningExecutable: MAIN,
    system,
  })
}

const installed = (cdHash: string) =>
  `${INSTALLED_ROOT}/${cdHash}/Emperor Computer Helper.app`

describe('macOS helper launcher paths', () => {
  it('chooses the protected home socket and falls back for long UTF-8 paths', () => {
    expect(macosSocketLocation({ home: '/Users/a', uid: 501 })).toEqual({
      directory: '/Users/a/.emperor/run',
      path: '/Users/a/.emperor/run/cu-501.sock',
      temporary: false,
    })
    expect(
      macosSocketLocation({
        home: `/Users/${'长'.repeat(40)}`,
        temp: '/tmp',
        uid: 501,
      }),
    ).toEqual({
      directory: '/tmp/emperor-501',
      path: '/tmp/emperor-501/cu.sock',
      temporary: true,
    })
  })

  it('locates packaged and development helper apps', () => {
    expect(
      macosHelperAppPath({
        packaged: true,
        resourcesPath: '/Applications/Emperor Agent.app/Contents/Resources',
      }),
    ).toBe(
      '/Applications/Emperor Agent.app/Contents/Library/Helpers/Emperor Computer Helper.app',
    )
    expect(
      macosHelperAppPath({
        packaged: false,
        desktopRoot: '/repo/desktop',
        arch: 'arm64',
      }),
    ).toBe('/repo/desktop/native/macos/build/arm64/Emperor Computer Helper.app')
    expect(
      macosHelperAppPath({
        packaged: false,
        desktopRoot: '/repo/desktop',
        arch: 'x64',
      }),
    ).toBe(
      '/repo/desktop/native/macos/build/x86_64/Emperor Computer Helper.app',
    )
  })

  it('names native build directories by Mach-O architecture', async () => {
    expect(macosNativeArch('arm64')).toBe('arm64')
    expect(macosNativeArch('x64')).toBe('x86_64')
    expect(macosNativeArch('x86_64')).toBe('x86_64')
    for (const arch of ['ia32', 'arm', 'universal', ''])
      expect(() => macosNativeArch(arch)).toThrow(
        'Unsupported macOS Computer Use helper architecture',
      )
    // The build script cannot import TypeScript; keep its table in step.
    const script = await readFile(
      resolve(__dirname, '../../../scripts/build-native-mac.mjs'),
      'utf8',
    )
    const table = /const MACOS_NATIVE_ARCH = \{([^}]*)\}/.exec(script)?.[1]
    const entries = [...(table ?? '').matchAll(/(\w+): '(\w+)'/g)].map(
      ([, node, native]) => [node, native],
    )
    expect(entries).toEqual([
      ['arm64', 'arm64'],
      ['x64', 'x86_64'],
    ])
    for (const [node, native] of entries)
      expect(macosNativeArch(node!)).toBe(native)
  })

  it('starts through LaunchServices arguments and retries the socket until handshake', async () => {
    const home = `/tmp/cu-launch-${randomUUID()}`
    const uid = process.getuid!()
    const location = macosSocketLocation({ home, uid })
    const received: Record<string, unknown>[] = []
    let peer: Socket | undefined
    const server = createServer((socket) => {
      peer = socket
      const decoder = new FrameDecoder()
      socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== 'json') continue
          const message = frame.value as Record<string, unknown>
          received.push(message)
          if (message.type === 'request')
            socket.write(
              Buffer.from(
                encodeJsonFrame({
                  type: 'response',
                  id: message.id,
                  ok: true,
                  result: {},
                }),
              ),
            )
        }
      })
      socket.write(
        Buffer.from(
          encodeJsonFrame({
            type: 'hello',
            protocol: 1,
            helperVersion: 'test',
            platform: 'macos',
            arch: 'arm64',
            capabilities: [],
            permissions: {},
          }),
        ),
      )
    })
    let attempts = 0
    let launchArgs: readonly string[] = []
    const installPackagedHelper = vi.fn(
      async () => '/tmp/Emperor Computer Helper.app',
    )
    try {
      const client = await launchMacosHelper({
        packaged: true,
        resourcesPath: '/Applications/Emperor Agent.app/Contents/Resources',
        installPackagedHelper,
        home,
        uid,
        connectTimeoutMs: 1_000,
        openApp: async (args) => {
          launchArgs = args
          await new Promise<void>((resolve, reject) =>
            server.listen(location.path, () => resolve()).once('error', reject),
          )
        },
        connectSocket: (path) => {
          attempts++
          if (attempts < 3) return Promise.reject(new Error('not ready yet'))
          return new Promise<Socket>((resolve, reject) => {
            const socket = createConnection(path)
            socket.once('connect', () => resolve(socket))
            socket.once('error', reject)
          })
        },
      })
      expect(attempts).toBe(3)
      expect(installPackagedHelper).toHaveBeenCalledOnce()
      expect(installPackagedHelper).toHaveBeenCalledWith(
        '/Applications/Emperor Agent.app/Contents/Library/Helpers/Emperor Computer Helper.app',
      )
      expect(launchArgs.slice(0, 7)).toEqual([
        '-g',
        '-n',
        '-a',
        '/tmp/Emperor Computer Helper.app',
        '--args',
        '--parent-pid',
        String(process.pid),
      ])
      expect(launchArgs.slice(7, 10)).toEqual([
        '--nonce',
        expect.stringMatching(/^[a-f0-9]{64}$/),
        '--socket',
      ])
      expect(launchArgs[10]).toBe(location.path)
      await vi.waitFor(() =>
        expect(received[0]).toEqual({
          type: 'welcome',
          protocol: 1,
          nonce: launchArgs[8],
        }),
      )
      await client.close()
    } finally {
      peer?.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('packaged macOS helper installation', () => {
  it('installs the bundled helper under its CDHash in a private directory', async () => {
    const system = new FakeInstallSystem({
      app: signedApp,
      helper: signedHelper,
    })
    await expect(install(system)).resolves.toBe(installed(CDHASH))
    expect(system.calls.filter(([command]) => command === 'ditto')).toEqual([
      [
        'ditto',
        SOURCE,
        `${INSTALLED_ROOT}/.pending-1/Emperor Computer Helper.app`,
      ],
    ])
    expect(
      system.has(`${installed(CDHASH)}/Contents/MacOS/emperor-computer-helper`),
    ).toBe(true)
    expect(system.entries.get(installed(CDHASH))?.signature).toEqual(
      signedHelper,
    )
    // The staging directory is gone and nothing else was created.
    expect(system.children(INSTALLED_ROOT)).toEqual([CDHASH])
    expect(system.entries.get(`${HOME}/.emperor`)?.mode).toBe(0o700)
    expect(system.entries.get(INSTALLED_ROOT)?.mode).toBe(0o700)
    // No stale copy, so the process list is never read.
    expect(system.calls.some(([command]) => command === 'ps')).toBe(false)
  })

  it('re-verifies the installed copy on every launch and refuses a changed one', async () => {
    const system = new FakeInstallSystem({
      app: signedApp,
      helper: signedHelper,
    })
    await install(system)
    system.calls.length = 0
    await expect(install(system)).resolves.toBe(installed(CDHASH))
    expect(system.calls).toContainEqual([
      'codesign',
      '--verify',
      '--strict',
      '--',
      installed(CDHASH),
    ])
    expect(system.calls.some(([command]) => command === 'ditto')).toBe(false)

    const copy = system.entries.get(installed(CDHASH))!
    copy.signature = { ...signedHelper, cdHash: 'd'.repeat(40) }
    await expect(install(system)).rejects.toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
      message: 'Installed Computer Use helper signature changed',
    })
    copy.signature = signedHelper
    copy.invalid = true
    await expect(install(system)).rejects.toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
      message: 'Computer Use app or helper has no valid code signature',
    })
    copy.invalid = false
    system.entries.get(`${INSTALLED_ROOT}/${CDHASH}`)!.mode = 0o770
    await expect(install(system)).rejects.toMatchObject({
      message: 'Unsafe Computer Use helper installation directory',
    })
    system.entries.get(`${INSTALLED_ROOT}/${CDHASH}`)!.mode = 0o700
    copy.kind = 'symlink'
    await expect(install(system)).rejects.toMatchObject({
      message: 'Unsafe installed Computer Use helper',
    })
    // A refused copy is never replaced or deleted behind the user's back.
    expect(system.calls.some(([command]) => command === 'ditto')).toBe(false)
    expect(system.has(installed(CDHASH))).toBe(true)
  })

  it('refuses a copied helper whose CDHash differs from the bundled one', async () => {
    const system = new FakeInstallSystem({
      app: signedApp,
      helper: signedHelper,
    })
    system.onDitto = (destination) => {
      system.entries.get(destination)!.signature = {
        ...signedHelper,
        cdHash: 'e'.repeat(40),
      }
    }
    await expect(install(system)).rejects.toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
      message: 'Installed Computer Use helper signature changed',
    })
    expect(system.children(INSTALLED_ROOT)).toEqual([])
  })

  it('refuses a helper whose Team ID or signing kind differs from the app', async () => {
    for (const helper of [
      { ...signedHelper, team: 'OTHER12345' },
      { ...signedHelper, team: null, adHoc: true },
      { ...signedHelper, identifier: 'com.example.other' },
    ]) {
      const system = new FakeInstallSystem({ app: signedApp, helper })
      await expect(install(system)).rejects.toMatchObject({
        code: 'DRIVER_UNAVAILABLE',
        message: 'Computer Use helper signer does not match the app',
      })
      expect(system.calls.some(([command]) => command === 'ditto')).toBe(false)
      expect(system.has(`${HOME}/.emperor`)).toBe(false)
    }
    const wrongApp = new FakeInstallSystem({
      app: { ...signedApp, identifier: 'com.example.app' },
      helper: signedHelper,
    })
    await expect(install(wrongApp)).rejects.toMatchObject({
      message: 'Unexpected Computer Use parent identity',
    })
  })

  it('refuses a helper that does not belong to the running app', async () => {
    const system = new FakeInstallSystem({
      app: signedApp,
      helper: signedHelper,
    })
    const other = '/Applications/Other.app/Contents/MacOS/Emperor Agent'
    system.add(other, 'file')
    await expect(
      installPackagedMacosHelper(SOURCE, {
        home: HOME,
        uid: UID,
        runningExecutable: other,
        system,
      }),
    ).rejects.toMatchObject({ message: 'Unexpected Computer Use app path' })
    expect(system.calls).toEqual([])
  })

  it('reseals a Preview helper for this app under the resealed CDHash', async () => {
    const previewApp = { ...signedApp, team: null, adHoc: true }
    const system = new FakeInstallSystem({
      app: previewApp,
      helper: { ...signedHelper, team: null, adHoc: true, cdHash: OLD_CDHASH },
    })
    const resealed = '2'.repeat(40)
    system.resealed = {
      identifier: HELPER_ID,
      team: null,
      adHoc: true,
      cdHash: resealed,
    }
    await expect(install(system)).resolves.toBe(installed(resealed))
    // A downloaded Preview's quarantine must not reach the resealed copy.
    expect(system.calls.filter(([command]) => command === 'ditto')).toEqual([
      [
        'ditto',
        '--noqtn',
        SOURCE,
        `${INSTALLED_ROOT}/.pending-1/Emperor Computer Helper.app`,
      ],
    ])
    const plist = `${INSTALLED_ROOT}/.pending-1/Emperor Computer Helper.app/Contents/Info.plist`
    expect(system.calls).toContainEqual([
      'plutil',
      '-replace',
      'EmperorExpectedMainCDHash',
      '-string',
      previewApp.cdHash,
      plist,
    ])
    expect(system.calls).toContainEqual([
      'plutil',
      '-replace',
      'EmperorExpectedMainExecutable',
      '-string',
      MAIN,
      plist,
    ])
    expect(system.children(INSTALLED_ROOT)).toEqual([resealed])
    await expect(install(system)).resolves.toBe(installed(resealed))
    expect(system.children(INSTALLED_ROOT)).toEqual([resealed])
  })

  it('removes only idle, user-owned CDHash copies beside the verified one', async () => {
    const system = new FakeInstallSystem({
      app: signedApp,
      helper: signedHelper,
    })
    const executable =
      'Emperor Computer Helper.app/Contents/MacOS/emperor-computer-helper'
    const stale = OLD_CDHASH
    const running = '1'.repeat(40)
    const foreign = '3'.repeat(40)
    const linked = '4'.repeat(40)
    const upper = 'F'.repeat(40)
    for (const name of [stale, running, foreign, upper, 'notes', '.pending-9'])
      system.add(`${INSTALLED_ROOT}/${name}/${executable}`, 'file')
    system.entries.get(`${INSTALLED_ROOT}/${foreign}`)!.uid = UID + 1
    system.add(`${HOME}/Documents/keep/file`, 'file')
    system.add(`${INSTALLED_ROOT}/${linked}`, 'symlink', {
      target: `${HOME}/Documents/keep`,
    })
    system.processes.push(`${INSTALLED_ROOT}/${running}/${executable}`)

    await expect(install(system)).resolves.toBe(installed(CDHASH))
    expect(system.children(INSTALLED_ROOT)).toEqual(
      [CDHASH, running, foreign, linked, upper, 'notes', '.pending-9'].sort(),
    )
    expect(system.has(`${HOME}/Documents/keep/file`)).toBe(true)

    // Once the old helper exits, the next verified launch removes it too.
    system.processes = [MAIN]
    await expect(install(system)).resolves.toBe(installed(CDHASH))
    expect(system.children(INSTALLED_ROOT)).not.toContain(running)
    expect(system.children(INSTALLED_ROOT)).toContain(foreign)
  })

  it('keeps old copies when running processes cannot be listed', async () => {
    const system = new FakeInstallSystem({
      app: signedApp,
      helper: signedHelper,
    })
    system.add(
      `${INSTALLED_ROOT}/${OLD_CDHASH}/Emperor Computer Helper.app/Contents/Info.plist`,
      'file',
    )
    system.psFails = true
    await expect(install(system)).resolves.toBe(installed(CDHASH))
    expect(system.children(INSTALLED_ROOT)).toEqual([CDHASH, OLD_CDHASH].sort())
    system.psFails = false
    system.processes = []
    await expect(install(system)).resolves.toBe(installed(CDHASH))
    expect(system.children(INSTALLED_ROOT)).toEqual([CDHASH, OLD_CDHASH].sort())
  })
})
