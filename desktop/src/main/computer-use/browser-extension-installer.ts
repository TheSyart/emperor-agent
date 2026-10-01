/**
 * 设置 › 电脑操作 › Chrome 和 Edge: the extension folder Chrome and Edge
 * load (`<stateRoot>/browser-extension`, `~/.emperor/browser-extension` by
 * default), and what Emperor does with it.
 *
 * - install: copy the extension this app ships into a staging folder, then
 *   two renames (old folder aside, new folder in place). No symlink: Chrome
 *   remembers the real path of an unpacked extension. A stamp file records
 *   the version and a digest of the files.
 * - recover: a crash between the renames leaves the old folder aside; put
 *   it back, and drop unfinished copies.
 * - upgrade (startup): replace the folder when this app ships different
 *   files; extensions that connect with an older version are told to
 *   `extension.reload` (once per pairing per run).
 * - remove: connected extensions uninstall themselves
 *   (`extension.uninstall`), every pairing is revoked, the Native Messaging
 *   manifests go, then the folder.
 *
 * The file system, browser detection and bridge are injected; tests use
 * temporary folders and never touch a real browser profile.
 */
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type {
  BrowserExtensionInstallResult,
  BrowserExtensionRemoveResult,
  BrowserExtensionStatus,
} from '../../shared/ipc-contract'
import type { ExtensionDetection } from './browser-extension-detect'
import type { NmBridgeEvent } from './nm-bridge'

export const EXTENSION_FOLDER = 'browser-extension'
/** Written last into a staged copy: `{ version, digest }`. */
export const EXTENSION_STAMP = 'emperor-bundle.json'

export interface ExtensionStamp {
  readonly version: string
  readonly digest: string
}

export interface ExtensionBundle extends ExtensionStamp {
  /** Shipped files, relative, `/`-separated, sorted. */
  readonly files: readonly string[]
}

export type ExtensionFolderFs = Pick<
  typeof nodeFs,
  | 'copyFile'
  | 'lstat'
  | 'mkdir'
  | 'readFile'
  | 'readdir'
  | 'rename'
  | 'rm'
  | 'writeFile'
>

/**
 * Whether a source file ships in the folder: not the tests, the README or
 * any dot file (`.DS_Store`). electron-builder applies the same filter.
 */
export function shippedEntry(path: string): boolean {
  const parts = path.split('/')
  return (
    parts.every((part) => part !== '' && !part.startsWith('.')) &&
    parts[0] !== 'tests' &&
    path !== 'README.md' &&
    path !== EXTENSION_STAMP
  )
}

function errno(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | null)?.code
}

export class BrowserExtensionFolder {
  /** The folder Chrome and Edge load. */
  readonly target: string
  private readonly source: string
  private readonly staging: string
  private readonly previous: string
  private readonly fs: ExtensionFolderFs
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: {
    /** The extension this app ships (Resources/browser-extension, or desktop/extension). */
    source: string
    /** `<stateRoot>/browser-extension`. */
    target: string
    fs?: ExtensionFolderFs
  }) {
    this.source = options.source
    this.target = options.target
    this.staging = join(dirname(options.target), `.${EXTENSION_FOLDER}.new`)
    this.previous = join(dirname(options.target), `.${EXTENSION_FOLDER}.old`)
    this.fs = options.fs ?? nodeFs
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.fs.lstat(path)
      return true
    } catch (cause) {
      if (errno(cause) === 'ENOENT') return false
      throw cause
    }
  }

  private async list(directory: string, prefix = ''): Promise<string[]> {
    const files: string[] = []
    for (const entry of await this.fs.readdir(directory, {
      withFileTypes: true,
    })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!shippedEntry(path)) continue
      if (entry.isDirectory())
        files.push(...(await this.list(join(directory, entry.name), path)))
      else if (entry.isFile()) files.push(path)
      // Symlinks and other entries never ship.
    }
    return files
  }

  /** Version and digest of the extension this app ships. */
  async bundle(): Promise<ExtensionBundle> {
    const files = (await this.list(this.source)).sort()
    const manifest = JSON.parse(
      await this.fs.readFile(join(this.source, 'manifest.json'), 'utf8'),
    ) as { version?: unknown; manifest_version?: unknown }
    if (
      manifest.manifest_version !== 3 ||
      typeof manifest.version !== 'string' ||
      !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)
    )
      throw new Error('the bundled extension manifest is invalid')
    const digest = createHash('sha256')
    for (const file of files) {
      const content = await this.fs.readFile(
        join(this.source, ...file.split('/')),
      )
      digest.update(file).update('\0')
      digest.update(createHash('sha256').update(content).digest('hex'))
      digest.update('\n')
    }
    return { version: manifest.version, digest: digest.digest('hex'), files }
  }

  /** The stamp of the folder, or null when it is absent or not Emperor's. */
  async installed(): Promise<ExtensionStamp | null> {
    let text: string
    try {
      text = await this.fs.readFile(join(this.target, EXTENSION_STAMP), 'utf8')
    } catch (cause) {
      if (errno(cause) === 'ENOENT' || errno(cause) === 'ENOTDIR') return null
      throw cause
    }
    try {
      const stamp = JSON.parse(text) as Partial<ExtensionStamp>
      return typeof stamp.version === 'string' &&
        typeof stamp.digest === 'string'
        ? { version: stamp.version, digest: stamp.digest }
        : null
    } catch {
      return null
    }
  }

  private async recoverNow(): Promise<void> {
    if (await this.exists(this.previous)) {
      // Crashed between the renames: the old folder is the last good one.
      if (!(await this.exists(this.target)))
        await this.fs.rename(this.previous, this.target)
      else await this.fs.rm(this.previous, { recursive: true, force: true })
    }
    await this.fs.rm(this.staging, { recursive: true, force: true })
  }

  /** Startup: finish or undo a replacement that a crash interrupted. */
  recover(): Promise<void> {
    return this.serial(() => this.recoverNow())
  }

  /** Put the shipped extension in the folder (staging copy, two renames). */
  install(): Promise<ExtensionStamp> {
    return this.serial(async () => {
      await this.recoverNow()
      const bundle = await this.bundle()
      await this.fs.mkdir(this.staging, { recursive: true, mode: 0o755 })
      for (const file of bundle.files) {
        const to = join(this.staging, ...file.split('/'))
        await this.fs.mkdir(dirname(to), { recursive: true, mode: 0o755 })
        await this.fs.copyFile(join(this.source, ...file.split('/')), to)
      }
      const stamp = { version: bundle.version, digest: bundle.digest }
      await this.fs.writeFile(
        join(this.staging, EXTENSION_STAMP),
        `${JSON.stringify(stamp)}\n`,
      )
      try {
        await this.fs.rename(this.target, this.previous)
      } catch (cause) {
        if (errno(cause) !== 'ENOENT') throw cause
      }
      await this.fs.rename(this.staging, this.target)
      await this.fs.rm(this.previous, { recursive: true, force: true })
      return stamp
    })
  }

  /**
   * Startup: when the folder exists and holds other files than this app
   * ships, replace it. False when absent (never installed) or current.
   */
  async upgrade(): Promise<boolean> {
    const current = await this.installed()
    if (current === null) return false
    const bundle = await this.bundle()
    if (bundle.digest === current.digest) return false
    await this.install()
    return true
  }

  /** Delete the folder and anything a replacement left behind. */
  remove(): Promise<void> {
    return this.serial(async () => {
      for (const path of [this.target, this.staging, this.previous])
        await this.fs.rm(path, { recursive: true, force: true })
    })
  }
}

/** `a` is a later version than `b` (dot-separated numbers). */
export function newerVersion(a: string, b: string | undefined): boolean {
  if (b === undefined) return true
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (Number.isNaN(difference)) return false
    if (difference !== 0) return difference > 0
  }
  return false
}

/** `~/…` for a path in the home folder. */
export function displayPath(path: string, home: string): string {
  const inside = relative(home, path)
  return inside && !inside.startsWith('..') && !inside.startsWith(sep)
    ? `~/${inside.split(sep).join('/')}`
    : path
}

/** The part of NmBridgeServer the extension service drives. */
export interface ExtensionBridge {
  readyPairings(): string[]
  storedPairings(): Promise<readonly { readonly pairingId: string }[]>
  request(
    pairingId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>
  revokePairing(pairingId: string): Promise<void>
  connectBrowsers(): Promise<{
    browsers: string[]
    reason?: 'no-host' | 'unavailable'
  }>
  removeHostManifests(): Promise<void>
  /** Browsers whose Native Messaging manifest admits the Emperor extension. */
  hostRegistrations(): Promise<readonly string[]>
  subscribe(listener: (event: NmBridgeEvent) => void): () => void
}

/** How long a connected extension gets to answer uninstall or reload. */
const EXTENSION_REQUEST_MS = 5_000

export class BrowserExtensionService {
  private readonly folder: BrowserExtensionFolder
  private readonly bridge: ExtensionBridge | null
  private readonly detect: () => Promise<readonly ExtensionDetection[]>
  private readonly homeDir: string
  private ready: Promise<unknown> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  /** Pairings already told to reload in this run (no reload loop). */
  private readonly reloaded = new Set<string>()

  constructor(options: {
    folder: BrowserExtensionFolder
    bridge: ExtensionBridge | null
    detect: () => Promise<readonly ExtensionDetection[]>
    homeDir: string
  }) {
    this.folder = options.folder
    this.bridge = options.bridge
    this.detect = options.detect
    this.homeDir = options.homeDir
  }

  async status(): Promise<BrowserExtensionStatus> {
    const [stamp, bundle, browsers, hosts] = await Promise.all([
      this.folder.installed().catch(() => null),
      this.folder.bundle().catch(() => null),
      this.detect().catch(() => []),
      this.bridge?.hostRegistrations().catch((): string[] => []) ??
        ([] as string[]),
    ])
    return {
      folder: {
        path: this.folder.target,
        displayPath: displayPath(this.folder.target, this.homeDir),
        ready: stamp !== null,
        version: stamp?.version ?? null,
      },
      bundledVersion: bundle?.version ?? null,
      browsers: browsers.map((item) => ({
        browser: item.browser,
        name: item.name,
        present: item.present,
        extension: item.extension,
        ...(item.elsewhere
          ? { loadedFrom: displayPath(item.elsewhere, this.homeDir) }
          : {}),
        developerMode: item.developerMode,
        hostRegistered: hosts.includes(item.browser),
      })),
    }
  }

  /** 安装扩展程序 / 重新安装扩展程序: the folder, then the browser host. */
  async install(): Promise<BrowserExtensionInstallResult> {
    try {
      await this.folder.install()
    } catch (cause) {
      return {
        ok: false,
        registered: [],
        reason: errno(cause) === 'ENOENT' ? 'no-source' : 'io',
        status: await this.status(),
      }
    }
    const registration = this.bridge
      ? await this.bridge
          .connectBrowsers()
          .catch(() => ({ browsers: [], reason: 'unavailable' as const }))
      : { browsers: [], reason: 'unavailable' as const }
    const registered = registration.browsers
    return {
      ok: true,
      registered,
      ...(registered.length === 0
        ? { reason: registration.reason ?? 'no-browser' }
        : {}),
      status: await this.status(),
    }
  }

  /**
   * 移除扩展程序: connected extensions uninstall themselves; then every
   * pairing, the Native Messaging manifests and the folder go. A browser
   * that is not running keeps the extension until the user removes it in
   * its extensions page.
   */
  async remove(): Promise<BrowserExtensionRemoveResult> {
    const bridge = this.bridge
    let uninstalled = 0
    if (bridge) {
      const ready = bridge.readyPairings()
      await Promise.all(
        ready.map(async (pairingId) => {
          try {
            await bridge.request(
              pairingId,
              'extension.uninstall',
              {},
              EXTENSION_REQUEST_MS,
            )
            uninstalled++
          } catch {
            /* that browser keeps it; the user removes it there */
          }
        }),
      )
      const stored = await bridge.storedPairings().catch(() => [])
      for (const pairingId of new Set([
        ...ready,
        ...stored.map((item) => item.pairingId),
      ]))
        await bridge.revokePairing(pairingId).catch(() => undefined)
      await bridge.removeHostManifests().catch(() => undefined)
    }
    await this.folder.remove()
    return { ok: true, uninstalled, status: await this.status() }
  }

  /**
   * App start: finish an interrupted replacement, upgrade the folder when
   * this app ships other files, and reload extensions that connect with an
   * older version. Resolves once the folder is settled.
   */
  start(): Promise<unknown> {
    this.ready = this.folder
      .recover()
      .then(() => this.folder.upgrade())
      .catch((cause: unknown) => {
        console.warn(
          `Browser extension folder upkeep failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      })
    this.unsubscribe ??=
      this.bridge?.subscribe((event) => {
        if (event.type === 'ready') void this.reloadIfOlder(event)
      }) ?? null
    return this.ready
  }

  private async reloadIfOlder(
    event: Extract<NmBridgeEvent, { type: 'ready' }>,
  ): Promise<void> {
    await this.ready
    const stamp = await this.folder.installed().catch(() => null)
    if (
      !stamp ||
      !newerVersion(stamp.version, event.version) ||
      this.reloaded.has(event.pairingId)
    )
      return
    this.reloaded.add(event.pairingId)
    await this.bridge
      ?.request(event.pairingId, 'extension.reload', {}, EXTENSION_REQUEST_MS)
      .catch(() => undefined)
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
