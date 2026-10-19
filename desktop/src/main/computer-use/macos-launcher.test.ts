import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  FrameDecoder,
  encodeJsonFrame,
} from '../../../../packages/core/src/harness/computer-use/protocol/framing'
import {
  LSREGISTER,
  MACOS_TOOLS,
  installPackagedMacosHelper,
  launchMacosHelper,
  macosHelperAppPath,
  macosNativeArch,
  macosSocketLocation,
  signedIdentity,
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
// SEC-04: system tools by absolute path, never through PATH.
const CODESIGN = '/usr/bin/codesign'
const DITTO = '/usr/bin/ditto'
const PLUTIL = '/usr/bin/plutil'
const PS = '/bin/ps'

interface FakeSignature {
  readonly identifier: string
  readonly team: string | null
  readonly cdHash: string
  readonly adHoc: boolean
  readonly runtime?: boolean
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
  /** LaunchServices refuses to unregister (RV-07). */
  lsregisterFails = false
  /** Signature applied by `codesign --force --sign -` (Preview re-seal). */
  resealed: FakeSignature | null = null
  /** A codesign that drops `--options runtime` (SEC-04 negative case). */
  resealDropsRuntime = false
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
    if (file === PS) {
      if (this.psFails) throw new Error('ps failed')
      return { stdout: `${this.processes.join('\n')}\n`, stderr: '' }
    }
    if (file === PLUTIL) return { stdout: '', stderr: '' }
    if (file === LSREGISTER) {
      if (this.lsregisterFails) throw new Error('lsregister failed')
      return { stdout: '', stderr: '' }
    }
    if (file === DITTO) {
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
    if (file !== CODESIGN) throw new Error(`unexpected command ${file}`)
    if (args[0] === '--force') {
      const target = this.entry(args[args.length - 1]!)
      if (!this.resealed) throw new Error('no reseal identity')
      const runtime =
        !this.resealDropsRuntime &&
        args.some(
          (arg, index) => arg === '--options' && args[index + 1] === 'runtime',
        )
      target.signature = { ...this.resealed, runtime }
      return { stdout: '', stderr: '' }
    }
    const path = args[args.length - 1]!
    const signature = this.entry(path).signature
    if (!signature || this.entry(path).invalid)
      throw new Error('codesign failed')
    if (args[0] === '--verify') return { stdout: '', stderr: '' }
    const flags = signature.adHoc
      ? signature.runtime
        ? '0x10002(adhoc,runtime)'
        : '0x2(adhoc)'
      : '0x10000(runtime)'
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
      this.calls.push(['rm', path])
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

  it('puts the socket under a custom data directory (MAIN-25)', () => {
    expect(
      macosSocketLocation({
        home: '/Users/a',
        stateRoot: '/tmp/e2e-home',
        uid: 501,
      }),
    ).toEqual({
      directory: '/tmp/e2e-home/run',
      path: '/tmp/e2e-home/run/cu-501.sock',
      temporary: false,
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

  it('listens before LaunchServices starts the Helper and hands it the secret on stdin, never argv', async () => {
    const home = mkdtempSync('/tmp/cu-launch-')
    const uid = process.getuid!()
    const installPackagedHelper = vi.fn(
      async () => '/tmp/Emperor Computer Helper.app',
    )
    let launchArgs: readonly string[] = []
    let helper: SimulatedHelper | null = null
    try {
      const client = await launchMacosHelper({
        packaged: true,
        resourcesPath: '/Applications/Emperor Agent.app/Contents/Resources',
        installPackagedHelper,
        home,
        uid,
        connectTimeoutMs: 5_000,
        openApp: async (args) => {
          launchArgs = args
          // The socket is already listening when LaunchServices runs.
          const socketPath = args[args.indexOf('--socket') + 1]!
          expect(existsSync(socketPath)).toBe(true)
          helper = await simulatedHelper(args)
        },
      })
      expect(installPackagedHelper).toHaveBeenCalledWith(
        '/Applications/Emperor Agent.app/Contents/Library/Helpers/Emperor Computer Helper.app',
      )
      const fifo = launchArgs[5]!
      expect(launchArgs).toEqual([
        '-g',
        '-n',
        '-a',
        '/tmp/Emperor Computer Helper.app',
        '--stdin',
        fifo,
        '--args',
        '--parent-pid',
        String(process.pid),
        '--socket',
        expect.stringMatching(
          new RegExp(`^${home}/\\.emperor/run/cu-${uid}-[0-9a-f]{8}\\.sock$`),
        ),
      ])
      expect(fifo.startsWith(`${home}/.emperor/run/`)).toBe(true)
      const secret = helper!.secret
      expect(secret).toMatch(/^[0-9a-f]{64}$/)
      expect(launchArgs.join(' ')).not.toContain(secret)
      expect(launchArgs).not.toContain('--nonce')
      expect(helper!.welcomeVerified).toBe(true)
      expect(await client.request('permissions.status', {})).toEqual({
        permissions: { accessibility: 'granted' },
      })
      // Nothing is left to connect to, and the secret is gone from disk.
      expect(existsSync(launchArgs.at(-1)!)).toBe(false)
      expect(existsSync(fifo)).toBe(false)
      await client.close()
    } finally {
      ;(helper as SimulatedHelper | null)?.socket.destroy()
      await rm(home, { recursive: true, force: true })
    }
  })

  // SEC-09 test 8: a process of the same user that connects first cannot
  // answer the challenge; main keeps waiting for the Helper it launched.
  it('refuses a rival that races the Helper to the socket (SEC-09 #8)', async () => {
    const home = mkdtempSync('/tmp/cu-race-')
    const uid = process.getuid!()
    const rivals: RivalConnection[] = []
    let helper: SimulatedHelper | null = null
    try {
      const client = await launchMacosHelper({
        packaged: false,
        appPath: '/tmp/Emperor Computer Helper.app',
        home,
        uid,
        connectTimeoutMs: 5_000,
        openApp: async (args) => {
          const socketPath = args[args.indexOf('--socket') + 1]!
          // One rival guesses a proof, one stays silent, one replays the
          // greeting a real Helper would send without the secret.
          rivals.push(await rivalConnection(socketPath, 'guess'))
          rivals.push(await rivalConnection(socketPath, 'silent'))
          rivals.push(await rivalConnection(socketPath, 'no-proof'))
          await Promise.all(
            rivals
              .filter((rival) => rival.mode !== 'silent')
              .map((rival) => rival.closed),
          )
          helper = await simulatedHelper(args)
        },
      })
      for (const rival of rivals.filter((item) => item.mode !== 'silent')) {
        expect(rival.challenged).toBe(true)
        expect(rival.received.map((message) => message.type)).toEqual([
          'challenge',
        ])
      }
      // The silent one is dropped once the Helper is in.
      await rivals.find((rival) => rival.mode === 'silent')!.closed
      expect(helper!.welcomeVerified).toBe(true)
      expect(await client.request('permissions.status', {})).toEqual({
        permissions: { accessibility: 'granted' },
      })
      await client.close()
    } finally {
      for (const rival of rivals) rival.socket.destroy()
      ;(helper as SimulatedHelper | null)?.socket.destroy()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('gives up when no peer proves itself before the deadline', async () => {
    const home = mkdtempSync('/tmp/cu-timeout-')
    const rivals: RivalConnection[] = []
    let socketPath = ''
    let fifo = ''
    try {
      await expect(
        launchMacosHelper({
          packaged: false,
          appPath: '/tmp/Emperor Computer Helper.app',
          home,
          uid: process.getuid!(),
          connectTimeoutMs: 400,
          openApp: async (args) => {
            socketPath = args[args.indexOf('--socket') + 1]!
            fifo = args[args.indexOf('--stdin') + 1]!
            rivals.push(await rivalConnection(socketPath, 'guess'))
          },
        }),
      ).rejects.toThrow('Computer Use helper did not connect')
      expect(existsSync(socketPath)).toBe(false)
      expect(existsSync(fifo)).toBe(false)
    } finally {
      for (const rival of rivals) rival.socket.destroy()
      await rm(home, { recursive: true, force: true })
    }
  })
})

const HELLO = {
  type: 'hello',
  protocol: 1,
  helperVersion: 'test',
  platform: 'macos',
  arch: 'arm64',
  capabilities: [],
  permissions: {},
}

function proof(secret: string, label: string, server: string, client: string) {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${label}\0${server}\0${client}`)
    .digest('hex')
}

interface SimulatedHelper {
  readonly secret: string
  readonly socket: Socket
  welcomeVerified: boolean
}

/** What the Swift Helper does: read the secret from stdin, connect, prove it. */
async function simulatedHelper(
  args: readonly string[],
): Promise<SimulatedHelper> {
  const fifo = args[args.indexOf('--stdin') + 1]!
  const socketPath = args[args.indexOf('--socket') + 1]!
  const stdin = await open(fifo, constants.O_RDONLY | constants.O_NONBLOCK)
  const { bytesRead, buffer } = await stdin.read(Buffer.alloc(256), 0, 256)
  await stdin.close()
  const line = buffer.subarray(0, bytesRead).toString('utf8')
  expect(line.endsWith('\n')).toBe(true)
  const secret = line.trim()
  const socket = createConnection(socketPath)
  socket.on('error', () => undefined)
  const state: SimulatedHelper = { secret, socket, welcomeVerified: false }
  const clientNonce = randomBytes(32).toString('hex')
  let serverNonce = ''
  const decoder = new FrameDecoder()
  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.kind !== 'json') continue
      const message = frame.value as Record<string, unknown>
      if (message.type === 'challenge') {
        serverNonce = message.nonce as string
        socket.write(
          Buffer.from(
            encodeJsonFrame({
              ...HELLO,
              nonce: clientNonce,
              proof: proof(
                secret,
                'emperor-helper-hello',
                serverNonce,
                clientNonce,
              ),
            }),
          ),
        )
      } else if (message.type === 'welcome') {
        state.welcomeVerified =
          message.proof ===
          proof(secret, 'emperor-main-welcome', serverNonce, clientNonce)
      } else if (message.type === 'request') {
        socket.write(
          Buffer.from(
            encodeJsonFrame({
              type: 'response',
              id: message.id,
              ok: true,
              result:
                message.method === 'permissions.status'
                  ? { permissions: { accessibility: 'granted' } }
                  : {},
            }),
          ),
        )
      }
    }
  })
  await new Promise<void>((resolveConnect) =>
    socket.once('connect', resolveConnect),
  )
  return state
}

interface RivalConnection {
  readonly mode: 'guess' | 'silent' | 'no-proof'
  readonly socket: Socket
  readonly received: Record<string, unknown>[]
  readonly closed: Promise<void>
  challenged: boolean
}

async function rivalConnection(
  socketPath: string,
  mode: RivalConnection['mode'],
): Promise<RivalConnection> {
  const socket = createConnection(socketPath)
  socket.on('error', () => undefined)
  const received: Record<string, unknown>[] = []
  const rival: RivalConnection = {
    mode,
    socket,
    received,
    challenged: false,
    closed: new Promise<void>((resolveClosed) =>
      socket.once('close', () => resolveClosed()),
    ),
  }
  const decoder = new FrameDecoder()
  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.kind !== 'json') continue
      const message = frame.value as Record<string, unknown>
      received.push(message)
      if (message.type !== 'challenge' || mode === 'silent') continue
      rival.challenged = true
      socket.write(
        Buffer.from(
          encodeJsonFrame(
            mode === 'guess'
              ? {
                  ...HELLO,
                  nonce: randomBytes(32).toString('hex'),
                  proof: randomBytes(32).toString('hex'),
                }
              : HELLO,
          ),
        ),
      )
    }
  })
  await new Promise<void>((resolveConnect) =>
    socket.once('connect', resolveConnect),
  )
  return rival
}

describe('system tools (SEC-04)', () => {
  it('runs codesign, ditto, plutil, ps, open and mkfifo from their absolute paths', () => {
    expect(MACOS_TOOLS).toEqual({
      codesign: '/usr/bin/codesign',
      ditto: '/usr/bin/ditto',
      plutil: '/usr/bin/plutil',
      ps: '/bin/ps',
      open: '/usr/bin/open',
      mkfifo: '/usr/bin/mkfifo',
    })
  })

  it.runIf(process.platform === 'darwin')(
    '8. checks a signature with /usr/bin/codesign when PATH starts with another codesign',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'emperor-codesign-path-'))
      const saved = process.env.PATH
      try {
        const probe = join(root, 'probe')
        copyFileSync('/usr/bin/true', probe)
        execFileSync('/usr/bin/codesign', [
          '--force',
          '--sign',
          '-',
          '--options',
          'runtime',
          probe,
        ])
        const bin = join(root, 'bin')
        const marker = join(root, 'fake-codesign-ran')
        mkdirSync(bin)
        writeFileSync(
          join(bin, 'codesign'),
          `#!/bin/sh\ntouch '${marker}'\necho 'Identifier=com.emperor.agent.desktop.computer-helper' >&2\necho 'CDHash=${'f'.repeat(40)}' >&2\necho 'TeamIdentifier=EVILTEAM00' >&2\nexit 0\n`,
        )
        chmodSync(join(bin, 'codesign'), 0o755)
        process.env.PATH = `${bin}:${saved ?? ''}`
        const identity = await signedIdentity(probe)
        expect(existsSync(marker)).toBe(false)
        expect(identity.adHoc).toBe(true)
        expect(identity.team).toBeNull()
        expect(identity.runtime).toBe(true)
        expect(identity.cdHash).not.toBe('f'.repeat(40))
      } finally {
        process.env.PATH = saved
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})

describe('packaged macOS helper installation', () => {
  it('installs the bundled helper under its CDHash in a private directory', async () => {
    const system = new FakeInstallSystem({
      app: signedApp,
      helper: signedHelper,
    })
    await expect(install(system)).resolves.toBe(installed(CDHASH))
    expect(system.calls.filter(([command]) => command === DITTO)).toEqual([
      [
        DITTO,
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
    expect(system.calls.some(([command]) => command === PS)).toBe(false)
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
      CODESIGN,
      '--verify',
      '--strict',
      '--',
      installed(CDHASH),
    ])
    expect(system.calls.some(([command]) => command === DITTO)).toBe(false)

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
    expect(system.calls.some(([command]) => command === DITTO)).toBe(false)
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
      expect(system.calls.some(([command]) => command === DITTO)).toBe(false)
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
    expect(system.calls.filter(([command]) => command === DITTO)).toEqual([
      [
        DITTO,
        '--noqtn',
        SOURCE,
        `${INSTALLED_ROOT}/.pending-1/Emperor Computer Helper.app`,
      ],
    ])
    const plist = `${INSTALLED_ROOT}/.pending-1/Emperor Computer Helper.app/Contents/Info.plist`
    expect(system.calls).toContainEqual([
      PLUTIL,
      '-replace',
      'EmperorExpectedMainCDHash',
      '-string',
      previewApp.cdHash,
      plist,
    ])
    expect(system.calls).toContainEqual([
      PLUTIL,
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

  it('reseals the Preview helper copy with the hardened runtime (SEC-04)', async () => {
    const previewApp = { ...signedApp, team: null, adHoc: true }
    const resealed = '2'.repeat(40)
    const preview = () => {
      const system = new FakeInstallSystem({
        app: previewApp,
        helper: {
          ...signedHelper,
          team: null,
          adHoc: true,
          cdHash: OLD_CDHASH,
        },
      })
      system.resealed = {
        identifier: HELPER_ID,
        team: null,
        adHoc: true,
        cdHash: resealed,
      }
      return system
    }
    const system = preview()
    await expect(install(system)).resolves.toBe(installed(resealed))
    expect(system.calls).toContainEqual([
      CODESIGN,
      '--force',
      '--sign',
      '-',
      '--options',
      'runtime',
      `${INSTALLED_ROOT}/.pending-1/Emperor Computer Helper.app`,
    ])
    expect(system.entries.get(installed(resealed))?.signature?.runtime).toBe(
      true,
    )
    // A copy that came out without the runtime flag is never installed.
    const dropped = preview()
    dropped.resealDropsRuntime = true
    await expect(install(dropped)).rejects.toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
      message: 'Invalid Preview helper identity',
    })
    expect(dropped.children(INSTALLED_ROOT)).toEqual([])
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

  it('unregisters a removed copy from LaunchServices first (RV-07)', async () => {
    const system = new FakeInstallSystem({
      app: signedApp,
      helper: signedHelper,
    })
    const executable =
      'Emperor Computer Helper.app/Contents/MacOS/emperor-computer-helper'
    const running = '1'.repeat(40)
    for (const name of [OLD_CDHASH, running])
      system.add(`${INSTALLED_ROOT}/${name}/${executable}`, 'file')
    system.processes.push(`${INSTALLED_ROOT}/${running}/${executable}`)

    await expect(install(system)).resolves.toBe(installed(CDHASH))
    const stale = `${INSTALLED_ROOT}/${OLD_CDHASH}`
    const steps = system.calls.filter(
      ([command]) => command === LSREGISTER || command === 'rm',
    )
    // Only the copy that goes is forgotten, and before its files are gone.
    expect(steps.filter(([command]) => command === LSREGISTER)).toEqual([
      [LSREGISTER, '-u', `${stale}/Emperor Computer Helper.app`],
    ])
    expect(steps.findIndex(([command]) => command === LSREGISTER)).toBeLessThan(
      steps.findIndex(([command, path]) => command === 'rm' && path === stale),
    )
    expect(system.has(stale)).toBe(false)
    expect(system.has(`${INSTALLED_ROOT}/${running}`)).toBe(true)
  })

  it('removes a stale copy even when LaunchServices will not unregister it', async () => {
    const system = new FakeInstallSystem({
      app: signedApp,
      helper: signedHelper,
    })
    system.add(
      `${INSTALLED_ROOT}/${OLD_CDHASH}/Emperor Computer Helper.app/Contents/Info.plist`,
      'file',
    )
    system.lsregisterFails = true
    await expect(install(system)).resolves.toBe(installed(CDHASH))
    expect(system.children(INSTALLED_ROOT)).toEqual([CDHASH])
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
