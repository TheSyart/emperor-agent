/** LaunchServices bootstrap for the macOS native Computer Use helper. */
import { execFile as nodeExecFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  lstat,
  mkdir,
  chmod,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { promisify } from 'node:util'
import { UiError } from '../../../../packages/core/src/harness/computer-use/errors'
import { HelperClient } from './helper-client'

const execFile = promisify(nodeExecFile)
const SOCKET_PATH_LIMIT = 103 // sockaddr_un.sun_path includes a NUL; macOS allows 104 bytes.
const HELPER_IDENTIFIER = 'com.emperor.agent.desktop.computer-helper'
/** Installed helper copies live in directories named by their lowercase CDHash. */
const CDHASH_DIRECTORY = /^[0-9a-f]{40}$/

/** The filesystem calls the packaged helper installer needs. Injected by tests. */
export interface MacosHelperInstallFs {
  lstat(path: string): Promise<{
    isDirectory(): boolean
    isSymbolicLink(): boolean
    readonly uid: number
    readonly mode: number
  }>
  mkdir(
    path: string,
    options: { recursive: true; mode: number },
  ): Promise<unknown>
  chmod(path: string, mode: number): Promise<void>
  mkdtemp(prefix: string): Promise<string>
  readdir(path: string): Promise<string[]>
  realpath(path: string): Promise<string>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { recursive: true; force: true }): Promise<void>
}

/** Process and filesystem access for helper installation. Injected by tests. */
export interface MacosHelperInstallSystem {
  execFile(
    file: string,
    args: readonly string[],
    options?: { readonly timeout?: number },
  ): Promise<{ readonly stdout: string; readonly stderr: string }>
  readonly fs: MacosHelperInstallFs
}

const nodeInstallSystem: MacosHelperInstallSystem = {
  execFile: async (file, args, options = {}) => {
    const { stdout, stderr } = await execFile(file, [...args], {
      ...options,
      encoding: 'utf8',
    })
    return { stdout, stderr }
  },
  fs: {
    lstat: (path) => lstat(path),
    mkdir: (path, options) => mkdir(path, options),
    chmod: (path, mode) => chmod(path, mode),
    mkdtemp: (prefix) => mkdtemp(prefix),
    readdir: (path) => readdir(path),
    realpath: (path) => realpath(path),
    rename: (from, to) => rename(from, to),
    rm: (path, options) => rm(path, options),
  },
}

export interface MacosLauncherOptions {
  readonly packaged: boolean
  readonly resourcesPath?: string
  readonly desktopRoot?: string
  readonly arch?: string
  readonly home?: string
  readonly temp?: string
  readonly uid?: number
  readonly pid?: number
  readonly appPath?: string
  readonly connectTimeoutMs?: number
  /** Dependency injection for the LaunchServices invocation in tests. */
  readonly openApp?: (args: readonly string[]) => Promise<void>
  /** Dependency injection for local socket connection in tests. */
  readonly connectSocket?: (path: string) => Promise<Socket>
  /** Dependency injection for signed helper installation in launcher tests. */
  readonly installPackagedHelper?: (source: string) => Promise<string>
}

export interface MacosSocketLocation {
  readonly directory: string
  readonly path: string
  readonly temporary: boolean
}

export function macosSocketLocation(
  options: Pick<MacosLauncherOptions, 'home' | 'temp' | 'uid'> = {},
): MacosSocketLocation {
  const uid = options.uid ?? process.getuid?.()
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    throw new UiError('DRIVER_UNAVAILABLE', 'Cannot determine local user ID')
  const primaryDirectory = join(options.home ?? homedir(), '.emperor', 'run')
  const primary = join(primaryDirectory, `cu-${uid}.sock`)
  if (Buffer.byteLength(primary) <= SOCKET_PATH_LIMIT)
    return { directory: primaryDirectory, path: primary, temporary: false }
  const temporaryDirectory = join(options.temp ?? tmpdir(), `emperor-${uid}`)
  const fallback = join(temporaryDirectory, 'cu.sock')
  if (Buffer.byteLength(fallback) > SOCKET_PATH_LIMIT)
    throw new UiError(
      'DRIVER_UNAVAILABLE',
      'Temporary socket path exceeds macOS limit',
    )
  return { directory: temporaryDirectory, path: fallback, temporary: true }
}

/**
 * Mach-O architecture name of a Node/Electron architecture. Native build
 * directories (desktop/native/{macos,browser-host}/build/<arch>) use these
 * names, as do the Swift build scripts and `uname -m`; Intel is `x86_64`, not
 * Node's `x64`. Keep in sync with desktop/scripts/build-native-mac.mjs.
 */
export function macosNativeArch(arch: string): 'arm64' | 'x86_64' {
  if (arch === 'arm64') return 'arm64'
  if (arch === 'x64' || arch === 'x86_64') return 'x86_64'
  throw new UiError(
    'DRIVER_UNAVAILABLE',
    'Unsupported macOS Computer Use helper architecture',
  )
}

export function macosHelperAppPath(
  options: Pick<
    MacosLauncherOptions,
    'packaged' | 'resourcesPath' | 'desktopRoot' | 'arch' | 'appPath'
  >,
): string {
  if (options.appPath) return resolve(options.appPath)
  if (options.packaged) {
    if (!options.resourcesPath)
      throw new UiError('DRIVER_UNAVAILABLE', 'Missing packaged resources path')
    return resolve(
      options.resourcesPath,
      '..',
      'Library',
      'Helpers',
      'Emperor Computer Helper.app',
    )
  }
  if (!options.desktopRoot)
    throw new UiError('DRIVER_UNAVAILABLE', 'Missing desktop source root')
  return resolve(
    options.desktopRoot,
    'native',
    'macos',
    'build',
    macosNativeArch(options.arch ?? process.arch),
    'Emperor Computer Helper.app',
  )
}

async function secureDirectory(
  path: string,
  uid: number,
  fs: MacosHelperInstallFs = nodeInstallSystem.fs,
): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 })
  const info = await fs.lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid)
    throw new UiError('DRIVER_UNAVAILABLE', 'Unsafe helper socket directory')
  if ((info.mode & 0o077) !== 0) await fs.chmod(path, 0o700)
}

interface CodeIdentity {
  readonly identifier: string
  readonly team: string | null
  readonly cdHash: string
  readonly adHoc: boolean
}

async function signedIdentity(
  path: string,
  system: MacosHelperInstallSystem = nodeInstallSystem,
): Promise<CodeIdentity> {
  try {
    await system.execFile('codesign', ['--verify', '--strict', '--', path], {
      timeout: 10_000,
    })
    const { stderr } = await system.execFile(
      'codesign',
      ['--display', '--verbose=4', '--', path],
      { timeout: 10_000 },
    )
    const identifier = /^Identifier=(.+)$/m.exec(stderr)?.[1]
    const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(stderr)?.[1] ?? null
    const cdHash = /^CDHash=([a-fA-F0-9]{40})$/m.exec(stderr)?.[1]
    const adHoc =
      /^CodeDirectory\b[^\n]*flags=0x[0-9a-f]+\([^\n]*\badhoc\b/m.test(stderr)
    if (!identifier || !cdHash || (adHoc ? team !== null : team === null))
      throw new Error('Incomplete code signature')
    return { identifier, team, cdHash: cdHash.toLowerCase(), adHoc }
  } catch {
    throw new UiError(
      'DRIVER_UNAVAILABLE',
      'Computer Use app or helper has no valid code signature',
    )
  }
}

/** Settings warning for a packaged Preview whose TCC identity changes on rebuild. */
export async function packagedMacosAppIsAdHoc(): Promise<boolean> {
  const executable = await realpath(process.execPath)
  const appPath = resolve(executable, '..', '..', '..')
  const identity = await signedIdentity(appPath)
  if (identity.identifier !== 'com.emperor.agent.desktop')
    throw new UiError(
      'DRIVER_UNAVAILABLE',
      'Unexpected Computer Use app identity',
    )
  return identity.adHoc
}

async function assertInstalledHelper(
  path: string,
  expected: CodeIdentity,
  uid: number,
  system: MacosHelperInstallSystem,
): Promise<void> {
  const parent = await system.fs.lstat(dirname(path))
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== uid ||
    (parent.mode & 0o077) !== 0
  )
    throw new UiError(
      'DRIVER_UNAVAILABLE',
      'Unsafe Computer Use helper installation directory',
    )
  const info = await system.fs.lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid)
    throw new UiError(
      'DRIVER_UNAVAILABLE',
      'Unsafe installed Computer Use helper',
    )
  const identity = await signedIdentity(path, system)
  if (
    identity.identifier !== expected.identifier ||
    identity.team !== expected.team ||
    identity.adHoc !== expected.adHoc ||
    identity.cdHash !== expected.cdHash
  )
    throw new UiError(
      'DRIVER_UNAVAILABLE',
      'Installed Computer Use helper signature changed',
    )
}

/**
 * Removes helper copies that earlier app versions installed beside the current
 * one. Only lowercase-CDHash-named, user-owned real directories directly
 * inside `installedRoot` are candidates; symlinks are never followed, and a
 * copy stays while any running process was started from it. Best effort: a
 * failure here never blocks launching the verified current helper.
 */
async function removeStaleHelperCopies(
  installedRoot: string,
  current: string,
  uid: number,
  system: MacosHelperInstallSystem,
): Promise<void> {
  try {
    const stale: string[] = []
    for (const name of await system.fs.readdir(installedRoot)) {
      if (name === current || !CDHASH_DIRECTORY.test(name)) continue
      const path = join(installedRoot, name)
      try {
        const info = await system.fs.lstat(path)
        if (info.isDirectory() && !info.isSymbolicLink() && info.uid === uid)
          stale.push(path)
      } catch {
        /* Removed concurrently, or unreadable: leave it alone. */
      }
    }
    if (stale.length === 0) return
    // `comm` is each process's absolute executable path (LaunchServices
    // starts the helper by path), without arguments such as a launch nonce.
    // An unreadable process list means "in use" for every copy.
    const { stdout } = await system.execFile('ps', ['-axww', '-o', 'comm='], {
      timeout: 5_000,
    })
    const commands = stdout.split('\n').filter((line) => line.trim() !== '')
    if (commands.length === 0) return
    for (const path of stale) {
      try {
        const prefixes = [`${path}/`, `${await system.fs.realpath(path)}/`]
        if (
          commands.some((command) =>
            prefixes.some((prefix) => command.includes(prefix)),
          )
        )
          continue
        await system.fs.rm(path, { recursive: true, force: true })
      } catch {
        /* Keep this copy; the next launch tries again. */
      }
    }
  } catch {
    /* Old copies are harmless; keep them when their state is unclear. */
  }
}

/**
 * A nested Helper runs under the outer App's Screen Recording identity on
 * current macOS. Install the sealed, signed bundle outside that App before
 * LaunchServices starts it, so TCC can grant the Helper's own bundle ID.
 */
export async function installPackagedMacosHelper(
  source: string,
  options: Pick<MacosLauncherOptions, 'home' | 'uid'> & {
    /** Integration fixture only; production binds to process.execPath. */
    readonly runningExecutable?: string
    /** Tests only: codesign/ditto/plutil/ps and filesystem access. */
    readonly system?: MacosHelperInstallSystem
  } = {},
): Promise<string> {
  const system = options.system ?? nodeInstallSystem
  const { fs } = system
  const uid = options.uid ?? process.getuid?.()
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    throw new UiError('DRIVER_UNAVAILABLE', 'Cannot determine local user ID')
  const parentApp = resolve(source, '..', '..', '..', '..')
  const expectedExecutable = join(
    parentApp,
    'Contents',
    'MacOS',
    'Emperor Agent',
  )
  if (
    (await fs.realpath(options.runningExecutable ?? process.execPath)) !==
      (await fs.realpath(expectedExecutable)) ||
    (await fs.realpath(source)) !==
      (await fs.realpath(
        join(
          parentApp,
          'Contents',
          'Library',
          'Helpers',
          'Emperor Computer Helper.app',
        ),
      ))
  )
    throw new UiError('DRIVER_UNAVAILABLE', 'Unexpected Computer Use app path')
  const parent = await signedIdentity(parentApp, system)
  if (parent.identifier !== 'com.emperor.agent.desktop')
    throw new UiError(
      'DRIVER_UNAVAILABLE',
      'Unexpected Computer Use parent identity',
    )
  const helper = await signedIdentity(source, system)
  if (
    helper.identifier !== HELPER_IDENTIFIER ||
    helper.team !== parent.team ||
    helper.adHoc !== parent.adHoc
  )
    throw new UiError(
      'DRIVER_UNAVAILABLE',
      'Computer Use helper signer does not match the app',
    )

  const root = join(options.home ?? homedir(), '.emperor')
  await secureDirectory(root, uid, fs)
  const installedRoot = join(root, 'native-helpers')
  await secureDirectory(installedRoot, uid, fs)
  const verified = async (cdHash: string, installed: string) => {
    await removeStaleHelperCopies(installedRoot, cdHash, uid, system)
    return installed
  }
  if (parent.adHoc) {
    // Preview has no developer Team ID. Bind a freshly sealed copy to this
    // exact main executable path and CodeDirectory hash. The helper checks
    // both against its socket peer before it accepts any request.
    const temporary = await fs.mkdtemp(join(installedRoot, '.pending-'))
    try {
      const staged = join(temporary, 'Emperor Computer Helper.app')
      // A downloaded Preview carries quarantine into every file; the user
      // has already let this app open, and this copy is resealed and checked
      // below. Kept, it would make Gatekeeper block the unnotarized helper.
      await system.execFile('ditto', ['--noqtn', source, staged], {
        timeout: 30_000,
      })
      const plist = join(staged, 'Contents', 'Info.plist')
      await system.execFile('plutil', [
        '-replace',
        'EmperorExpectedMainExecutable',
        '-string',
        await fs.realpath(expectedExecutable),
        plist,
      ])
      await system.execFile('plutil', [
        '-replace',
        'EmperorExpectedMainCDHash',
        '-string',
        parent.cdHash,
        plist,
      ])
      await system.execFile('codesign', ['--force', '--sign', '-', staged], {
        timeout: 10_000,
      })
      const expected = await signedIdentity(staged, system)
      if (expected.identifier !== HELPER_IDENTIFIER || !expected.adHoc)
        throw new UiError(
          'DRIVER_UNAVAILABLE',
          'Invalid Preview helper identity',
        )
      const version = join(installedRoot, expected.cdHash)
      const installed = join(version, 'Emperor Computer Helper.app')
      try {
        await assertInstalledHelper(installed, expected, uid, system)
        return await verified(expected.cdHash, installed)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      try {
        await fs.rename(temporary, version)
      } catch (error) {
        if (
          !['EEXIST', 'ENOTEMPTY'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error
      }
      await assertInstalledHelper(installed, expected, uid, system)
      return await verified(expected.cdHash, installed)
    } finally {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }
  // The code hash makes an update atomic and lets a running old version exit
  // before its files are touched. Every launch verifies the installed copy.
  const version = join(installedRoot, helper.cdHash)
  const installed = join(version, 'Emperor Computer Helper.app')
  try {
    await assertInstalledHelper(installed, helper, uid, system)
    return await verified(helper.cdHash, installed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporary = await fs.mkdtemp(join(installedRoot, '.pending-'))
  try {
    await system.execFile(
      'ditto',
      [source, join(temporary, 'Emperor Computer Helper.app')],
      {
        timeout: 30_000,
      },
    )
    await assertInstalledHelper(
      join(temporary, 'Emperor Computer Helper.app'),
      helper,
      uid,
      system,
    )
    try {
      await fs.rename(temporary, version)
    } catch (error) {
      // Another app instance may have installed this exact version first.
      if (
        !['EEXIST', 'ENOTEMPTY'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
    }
    await assertInstalledHelper(installed, helper, uid, system)
    return await verified(helper.cdHash, installed)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolveSocket, reject) => {
    const socket = createConnection(path)
    socket.once('connect', () => {
      socket.removeListener('error', onError)
      resolveSocket(socket)
    })
    const onError = (error: Error) => {
      socket.destroy()
      reject(error)
    }
    socket.once('error', onError)
  })
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

/** Starts the helper and returns only after a validated hello/welcome handshake. */
export async function launchMacosHelper(
  options: MacosLauncherOptions,
): Promise<HelperClient> {
  const uid = options.uid ?? process.getuid?.()
  const pid = options.pid ?? process.pid
  if (
    uid === undefined ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !Number.isSafeInteger(pid) ||
    pid < 2
  )
    throw new UiError('DRIVER_UNAVAILABLE', 'Invalid helper process identity')
  const location = macosSocketLocation(options)
  await secureDirectory(location.directory, uid)
  const sourceAppPath = macosHelperAppPath(options)
  const appPath =
    options.packaged && !options.appPath
      ? await (
          options.installPackagedHelper ??
          ((source) => installPackagedMacosHelper(source, options))
        )(sourceAppPath)
      : sourceAppPath
  const nonce = randomBytes(32).toString('hex')
  const args = [
    '-g',
    '-n',
    '-a',
    appPath,
    '--args',
    '--parent-pid',
    String(pid),
    '--nonce',
    nonce,
    '--socket',
    location.path,
  ]
  try {
    if (options.openApp) await options.openApp(args)
    else await execFile('open', args, { timeout: 10_000 })
  } catch {
    throw new UiError(
      'DRIVER_UNAVAILABLE',
      'LaunchServices could not start the Computer Use helper',
    )
  }
  const deadline = Date.now() + (options.connectTimeoutMs ?? 8_000)
  let delay = 50
  for (;;) {
    let socket: Socket
    try {
      socket = await (options.connectSocket ?? connectSocket)(location.path)
    } catch {
      if (Date.now() >= deadline)
        throw new UiError(
          'DRIVER_UNAVAILABLE',
          'Computer Use helper did not open its socket',
        )
      await sleep(Math.min(delay, Math.max(1, deadline - Date.now())))
      delay = Math.min(delay * 2, 500)
      continue
    }
    const client = new HelperClient(socket, { platform: 'macos', nonce })
    try {
      await client.ready
      return client
    } catch (error) {
      socket.destroy()
      // A connected peer with a bad greeting or version is not a startup race.
      throw error
    }
  }
}
