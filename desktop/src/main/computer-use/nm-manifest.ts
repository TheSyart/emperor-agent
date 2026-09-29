/**
 * macOS Chrome/Edge Native Messaging host manifest upkeep (spec 01 §11,
 * 00 §7.6). Writes the same `com.emperor.agent.browser.json` that
 * `emperor-nm-host --install` writes, but only into browsers the user has
 * connected, and only over manifests whose host is an Emperor host.
 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as syncFs from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import { userInfo } from 'node:os'
import { posix } from 'node:path'

export const NM_HOST_NAME = 'com.emperor.agent.browser'
/**
 * The Emperor extension's ID, fixed by the public `key` in
 * `desktop/extension/manifest.json` (a test re-derives it), so 连接
 * Chrome/Edge can register the host before the first pairing (01 §11).
 */
export const EMPEROR_EXTENSION_ID = 'oobcokoopgkhlhpohfdpelkafiidojjn'
export const NM_HOST_BINARY = 'emperor-nm-host'
const MANIFEST_FILE = `${NM_HOST_NAME}.json`
const DESCRIPTION = 'Emperor Agent browser connection'
const EXTENSION_ID = /^[a-p]{32}$/
/** A real manifest is a few hundred bytes; never read an unbounded file. */
const MANIFEST_MAX_BYTES = 64 * 1024

/** Same browser keys and user-level directories as `emperor-nm-host --install`. */
export const NM_BROWSERS = {
  chrome: 'Google/Chrome',
  'chrome-beta': 'Google/Chrome Beta',
  'chrome-dev': 'Google/Chrome Dev',
  'chrome-canary': 'Google/Chrome Canary',
  'chrome-for-testing': 'Google/ChromeForTesting',
  chromium: 'Chromium',
  edge: 'Microsoft Edge',
} as const

export type NmBrowser = keyof typeof NM_BROWSERS

const BROWSER_KEYS = Object.keys(NM_BROWSERS) as NmBrowser[]

/** Every browser Emperor can connect (the registrar skips ones never run). */
export const NM_BROWSER_KEYS: readonly NmBrowser[] = BROWSER_KEYS

// ---------------------------------------------------------------------------
// Host binary location

export interface NmHostLocationOptions {
  readonly packaged: boolean
  /** `process.resourcesPath` (`<App>.app/Contents/Resources`) when packaged. */
  readonly resourcesPath?: string
  /** The `desktop/` source root in a development build. */
  readonly desktopRoot?: string
  readonly arch?: string
}

/** `build.sh` names Intel `x86_64` while Node reports `x64`; accept both. */
export function nmHostArchDirectories(arch: string): string[] {
  return arch === 'x64' || arch === 'x86_64' ? ['x86_64', 'x64'] : [arch]
}

/** Candidate host binaries in preference order (not checked for existence). */
export function nmHostCandidates(options: NmHostLocationOptions): string[] {
  if (options.packaged) {
    // electron-builder `extraFiles`: Contents/Library/Helpers/emperor-nm-host.
    return options.resourcesPath
      ? [
          posix.resolve(
            options.resourcesPath,
            '..',
            'Library',
            'Helpers',
            NM_HOST_BINARY,
          ),
        ]
      : []
  }
  const desktopRoot = options.desktopRoot
  if (!desktopRoot) return []
  return nmHostArchDirectories(options.arch ?? process.arch).map((directory) =>
    posix.resolve(
      desktopRoot,
      'native',
      'browser-host',
      'build',
      directory,
      'release',
      NM_HOST_BINARY,
    ),
  )
}

type HostFs = Pick<typeof syncFs, 'accessSync' | 'realpathSync' | 'statSync'>

/** The canonical path of this build's executable host, or null. */
export function resolveNmHostPath(
  options: NmHostLocationOptions,
  fs: HostFs = syncFs,
): string | null {
  for (const candidate of nmHostCandidates(options)) {
    try {
      fs.accessSync(candidate, constants.X_OK)
      const canonical = fs.realpathSync(candidate)
      if (fs.statSync(canonical).isFile()) return canonical
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/**
 * Whether a manifest `path` names an Emperor host: the packaged
 * `<App>.app/Contents/Library/Helpers/emperor-nm-host`, a `build.sh` output,
 * or `build-native-mac.mjs`'s staging copy. Anything else belongs to someone
 * else and is never rewritten or removed.
 */
export function isEmperorHostPath(
  path: string,
  current: string | null = null,
): boolean {
  if (!posix.isAbsolute(path) || path.includes('\0')) return false
  if (current !== null && path === current) return true
  const parts = posix.normalize(path).split('/')
  const at = (offset: number) => parts[parts.length - 1 - offset] ?? ''
  if (at(0) !== NM_HOST_BINARY) return false
  if (
    at(1) === 'Helpers' &&
    at(2) === 'Library' &&
    at(3) === 'Contents' &&
    at(4).endsWith('.app')
  )
    return true
  if (
    (at(1) === 'release' || at(1) === 'fixture') &&
    at(3) === 'build' &&
    at(4) === 'browser-host' &&
    at(5) === 'native'
  )
    return true
  return at(1) === 'native' && at(2) === 'out'
}

// ---------------------------------------------------------------------------
// Manifest text

/** Foundation `JSONSerialization` escapes `/`; match it byte for byte. */
function foundationString(value: string): string {
  return JSON.stringify(value).replace(/\//g, '\\/')
}

function uniqueIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].filter((id) => EXTENSION_ID.test(id)).sort()
}

/**
 * The manifest main.swift writes (`.prettyPrinted, .sortedKeys`, no trailing
 * newline), with one `allowed_origins` entry per extension ID.
 */
export function nmManifestText(
  hostPath: string,
  extensionIds: readonly string[],
): string {
  if (
    extensionIds.length === 0 ||
    !extensionIds.every((id) => EXTENSION_ID.test(id)) ||
    !posix.isAbsolute(hostPath) ||
    hostPath.includes('\0')
  )
    throw new Error('invalid Native Messaging manifest input')
  const ids = uniqueIds(extensionIds)
  const origins = ids
    .map((id) => `    ${foundationString(`chrome-extension://${id}/`)}`)
    .join(',\n')
  return [
    '{',
    `  "allowed_origins" : [\n${origins}\n  ],`,
    `  "description" : ${foundationString(DESCRIPTION)},`,
    `  "name" : ${foundationString(NM_HOST_NAME)},`,
    `  "path" : ${foundationString(hostPath)},`,
    `  "type" : "stdio"`,
    '}',
  ].join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function originId(origin: unknown): string | null {
  if (typeof origin !== 'string') return null
  const match = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin)
  return match ? match[1]! : null
}

// ---------------------------------------------------------------------------
// Registrar

export type NmManifestFs = Pick<
  typeof asyncFs,
  'lstat' | 'stat' | 'readFile' | 'open' | 'rename' | 'unlink' | 'mkdir'
>

export interface NmManifestRegistrarOptions {
  /**
   * This app's canonical host binary (`resolveNmHostPath`). Null when this
   * build has no host that can verify main: manifests are then never
   * created or repointed, only narrowed or removed on revoke.
   */
  readonly hostPath: string | null
  /** Account home from getpwuid, like emperor-nm-host (not `$HOME`). */
  readonly home?: string
  readonly uid?: number
  readonly fs?: NmManifestFs
}

export type NmManifestAction =
  'created' | 'updated' | 'removed' | 'unchanged' | 'skipped' | 'failed'

export interface NmManifestChange {
  readonly browser: NmBrowser
  readonly file: string
  readonly action: NmManifestAction
  /** For `skipped`/`failed`: why the file was left alone. */
  readonly reason?: 'foreign' | 'unsafe' | 'no-host' | 'no-browser' | 'io'
}

export type NmManifestState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'unsafe' }
  | {
      readonly kind: 'emperor'
      readonly path: string
      readonly extensionIds: readonly string[]
      readonly text: string
    }

export interface NmManifestEntry {
  readonly browser: NmBrowser
  readonly directory: string
  readonly file: string
  readonly state: NmManifestState
}

interface Plan {
  /** New origins for an Emperor manifest; an empty list removes it. */
  readonly origins: (existing: readonly string[]) => string[]
  /** Browsers where an absent manifest should be created. */
  readonly create?: readonly NmBrowser[]
  readonly createIds?: readonly string[]
}

function errnoCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | null)?.code
}

export class NmManifestRegistrar {
  readonly hostPath: string | null
  private readonly home: string
  private readonly uid: number | undefined
  private readonly fs: NmManifestFs
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: NmManifestRegistrarOptions) {
    this.hostPath = options.hostPath
    this.home = options.home ?? userInfo().homedir
    this.uid = options.uid ?? process.getuid?.()
    this.fs = options.fs ?? asyncFs
  }

  private browserRoot(browser: NmBrowser): string {
    return posix.join(
      this.home,
      'Library',
      'Application Support',
      NM_BROWSERS[browser],
    )
  }

  manifestFile(browser: NmBrowser): string {
    return posix.join(
      this.browserRoot(browser),
      'NativeMessagingHosts',
      MANIFEST_FILE,
    )
  }

  private owned(info: { uid: number }): boolean {
    return this.uid === undefined || info.uid === this.uid
  }

  private async read(browser: NmBrowser): Promise<NmManifestEntry> {
    const file = this.manifestFile(browser)
    const directory = posix.dirname(file)
    const entry = (state: NmManifestState): NmManifestEntry => ({
      browser,
      directory,
      file,
      state,
    })
    try {
      const folder = await this.fs.lstat(directory)
      if (!folder.isDirectory() || !this.owned(folder))
        return entry({ kind: 'unsafe' })
    } catch (cause) {
      if (errnoCode(cause) === 'ENOENT') return entry({ kind: 'absent' })
      throw cause
    }
    let text: string
    try {
      const info = await this.fs.lstat(file)
      // Never follow a symlink or touch another account's file.
      if (!info.isFile() || !this.owned(info) || info.size > MANIFEST_MAX_BYTES)
        return entry({ kind: 'foreign' })
      text = await this.fs.readFile(file, 'utf8')
    } catch (cause) {
      if (errnoCode(cause) === 'ENOENT') return entry({ kind: 'absent' })
      throw cause
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return entry({ kind: 'foreign' })
    }
    if (
      !isRecord(parsed) ||
      parsed.name !== NM_HOST_NAME ||
      typeof parsed.path !== 'string' ||
      !isEmperorHostPath(parsed.path, this.hostPath)
    )
      return entry({ kind: 'foreign' })
    const origins = Array.isArray(parsed.allowed_origins)
      ? parsed.allowed_origins
      : []
    return entry({
      kind: 'emperor',
      path: parsed.path,
      extensionIds: uniqueIds(
        origins.map(originId).filter((id): id is string => id !== null),
      ),
      text,
    })
  }

  /** Current manifest state for every supported browser (read-only). */
  inspect(): Promise<NmManifestEntry[]> {
    return Promise.all(BROWSER_KEYS.map((browser) => this.read(browser)))
  }

  private async write(
    directory: string,
    file: string,
    text: string,
  ): Promise<void> {
    const temporary = posix.join(
      directory,
      `.${NM_HOST_NAME}.${randomUUID()}.tmp`,
    )
    const handle = await this.fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    try {
      try {
        await handle.writeFile(text)
        await handle.chmod(0o600)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.fs.rename(temporary, file)
    } catch (cause) {
      await this.fs.unlink(temporary).catch(() => undefined)
      throw cause
    }
  }

  private async create(
    entry: NmManifestEntry,
    ids: readonly string[],
  ): Promise<NmManifestChange> {
    const base = { browser: entry.browser, file: entry.file }
    if (this.hostPath === null)
      return { ...base, action: 'skipped', reason: 'no-host' }
    try {
      // Only for a browser that has run; never invent its data directory.
      if (!(await this.fs.stat(this.browserRoot(entry.browser))).isDirectory())
        return { ...base, action: 'skipped', reason: 'no-browser' }
    } catch (cause) {
      if (errnoCode(cause) === 'ENOENT')
        return { ...base, action: 'skipped', reason: 'no-browser' }
      throw cause
    }
    try {
      // Mode 0700 applies only when this call creates the directory.
      await this.fs.mkdir(entry.directory, { mode: 0o700 })
    } catch (cause) {
      if (errnoCode(cause) !== 'EEXIST') throw cause
    }
    const folder = await this.fs.lstat(entry.directory)
    if (!folder.isDirectory() || !this.owned(folder))
      return { ...base, action: 'skipped', reason: 'unsafe' }
    await this.write(
      entry.directory,
      entry.file,
      nmManifestText(this.hostPath, ids),
    )
    return { ...base, action: 'created' }
  }

  private async applyOne(
    browser: NmBrowser,
    plan: Plan,
  ): Promise<NmManifestChange | null> {
    const entry = await this.read(browser)
    const base = { browser, file: entry.file }
    const state = entry.state
    if (state.kind === 'absent')
      return plan.create?.includes(browser)
        ? this.create(entry, plan.createIds ?? [])
        : null
    if (state.kind === 'foreign' || state.kind === 'unsafe')
      return { ...base, action: 'skipped', reason: state.kind }
    const ids = uniqueIds(plan.origins(state.extensionIds))
    if (ids.length === 0) {
      await this.fs.unlink(entry.file)
      return { ...base, action: 'removed' }
    }
    const text = nmManifestText(this.hostPath ?? state.path, ids)
    if (text === state.text) return { ...base, action: 'unchanged' }
    await this.write(entry.directory, entry.file, text)
    return { ...base, action: 'updated' }
  }

  private apply(plan: Plan): Promise<NmManifestChange[]> {
    const task = this.queue.then(async () => {
      const changes: NmManifestChange[] = []
      for (const browser of BROWSER_KEYS) {
        try {
          const change = await this.applyOne(browser, plan)
          if (change) changes.push(change)
        } catch {
          changes.push({
            browser,
            file: this.manifestFile(browser),
            action: 'failed',
            reason: 'io',
          })
        }
      }
      return changes
    })
    this.queue = task.catch(() => undefined)
    return task
  }

  /**
   * Startup (01 §11): with at least one pairing, repoint each Emperor
   * manifest at this app's host and make sure it still admits every paired
   * extension. Never creates a manifest; without pairings, changes nothing.
   */
  reconcile(
    pairedExtensionIds: readonly string[],
  ): Promise<NmManifestChange[]> {
    const paired = uniqueIds(pairedExtensionIds)
    if (paired.length === 0) return Promise.resolve([])
    return this.apply({ origins: (existing) => [...existing, ...paired] })
  }

  /**
   * Connect/approve: every Emperor manifest admits `extensionId` and points
   * at this host. `browsers` additionally creates the manifest for browsers
   * the user explicitly chose to connect; nothing else is created.
   */
  register(
    extensionId: string,
    pairedExtensionIds: readonly string[] = [],
    browsers: readonly NmBrowser[] = [],
  ): Promise<NmManifestChange[]> {
    if (!EXTENSION_ID.test(extensionId))
      return Promise.reject(new Error('invalid extension ID'))
    const ids = uniqueIds([...pairedExtensionIds, extensionId])
    return this.apply({
      origins: (existing) => [...existing, ...ids],
      create: browsers,
      createIds: ids,
    })
  }

  /**
   * Emperor-side revoke. With no pairing left, remove every manifest
   * Emperor wrote ("断开连接时删除 manifest"); otherwise drop only the revoked
   * extension unless another pairing still uses it.
   */
  unregister(
    extensionId: string,
    remainingExtensionIds: readonly string[],
  ): Promise<NmManifestChange[]> {
    const remaining = uniqueIds(remainingExtensionIds)
    if (remaining.length === 0) return this.apply({ origins: () => [] })
    return this.apply({
      origins: (existing) =>
        [...existing, ...remaining].filter(
          (id) => id !== extensionId || remaining.includes(id),
        ),
    })
  }
}
