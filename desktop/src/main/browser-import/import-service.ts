/**
 * Orchestrates "从浏览器导入" (ST-06). `listImportSources` gives the dialog its
 * source dropdown and per-browser running state; `importBrowserData` reads the
 * chosen profile, saves passwords into the vault (skipping duplicates and
 * non-web realms) and hands cookies to the selected persistent profile's
 * sink: in main that is `ImportedCookieStore`, which sets them into the
 * profile's session in memory and seals them in its imported-cookies.el1,
 * never in Chromium's `Cookies` (SEC-10). Everything runs in the main
 * process; the caller (IPC) only learns counts. Logs carry counts only —
 * never a password or a cookie value.
 */
import { homedir } from 'node:os'
import { isExactHttpOrigin } from '../computer-use/web-origin'
import {
  detectRunning,
  discoverBrowsers,
  userDataDir,
} from './browser-discovery'
import { readBrowserData } from './read-browser-data'
import type {
  BrowserId,
  CookieRecord,
  ReadBrowserDataDeps,
  RunningReason,
  RunningStatus,
} from './types'

export interface ImportSourceProfile {
  readonly dir: string
  readonly name: string
}

export interface ImportSource {
  readonly browser: BrowserId
  readonly name: string
  readonly installed: boolean
  readonly running: boolean
  readonly reason: RunningReason
  readonly profiles: readonly ImportSourceProfile[]
}

export interface ImportSources {
  readonly browsers: readonly ImportSource[]
}

export interface ImportRunRequest {
  readonly browser: BrowserId
  readonly profileDir: string
  readonly passwords: boolean
  readonly cookies: boolean
  /** Persistent profile id (`p_…`) for cookies; the renderer resolves it. */
  readonly targetProfileId?: string
}

export interface ImportResult {
  readonly ok: true
  readonly passwords: number
  /** Distinct cookie hosts written (the "M 个网站的登录" figure). */
  readonly sites: number
}

export type ImportErrorReason =
  | 'nothing-selected'
  | 'browser-running'
  | 'vault-locked'
  | 'vault-unavailable'
  | 'no-target-profile'
  | 'read-failed'
  | 'internal'

/** Secret-free failure; the IPC layer forwards only `reason` and fixed text. */
export class ImportError extends Error {
  constructor(
    readonly reason: ImportErrorReason,
    message: string,
  ) {
    super(message)
  }
}

/** The vault surface the importer needs (see CredentialVault). */
interface VaultLike {
  readonly available: boolean
  readonly locked: boolean
  entries(): ReadonlyArray<{
    readonly bindings: ReadonlyArray<{
      readonly kind: string
      readonly origin?: string
    }>
    readonly username?: string
  }>
  save(draft: {
    label: string
    bindings: Array<{ kind: 'origin'; origin: string }>
    username?: string
    password: string
  }): unknown
  /** Save several in one write (preferred; one fsync for the whole import). */
  saveMany?(
    drafts: Array<{
      label: string
      bindings: Array<{ kind: 'origin'; origin: string }>
      username?: string
      password: string
    }>,
  ): unknown
}

/** What `session.cookies.set` takes (the fields we fill). */
export interface CookieToSet {
  url: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite: CookieRecord['sameSite']
  domain?: string
}

/**
 * Takes the cookies for one persistent profile; `flush` once all are in
 * (main: `ImportedCookieStore.sinkFor`, memory plus a sealed file).
 */
export interface CookieSink {
  set(cookie: CookieToSet): Promise<void>
  flush(): Promise<void>
}

export interface ImportDeps extends ReadBrowserDataDeps {
  read?: typeof readBrowserData
  discover?: typeof discoverBrowsers
  detect?: (userDataDir: string) => RunningStatus
  vault?: VaultLike
  /** Resolves the cookie sink for a persistent profile id. */
  cookieSink?: (profileId: string) => Promise<CookieSink> | CookieSink
  /** Whether a persistent profile with this id exists; checked before any read or write. */
  profileExists?: (profileId: string) => boolean
  /** Counts-only log sink. */
  log?: (message: string, counts: Record<string, number>) => void
}

/** Chrome/Edge on this machine, each with running-state and profiles. */
export function listImportSources(deps: ImportDeps = {}): ImportSources {
  const discover = deps.discover ?? discoverBrowsers
  const detect =
    deps.detect ?? ((dir: string) => detectRunning({ userDataDir: dir }))
  const browsers = discover({ homeDir: deps.homeDir }).map((browser) => {
    const status = detect(browser.userDataDir)
    return {
      browser: browser.browser,
      name: browser.name,
      installed: browser.installed,
      running: status.running,
      reason: status.reason,
      profiles: browser.profiles.map((profile) => ({
        dir: profile.dir,
        name: profile.name,
      })),
    }
  })
  return { browsers }
}

/** A short, stable vault label from an origin (its host). */
function labelFor(origin: string): string {
  try {
    return new URL(origin).hostname.slice(0, 120) || origin.slice(0, 120)
  } catch {
    return origin.slice(0, 120)
  }
}

/** Maps a normalized cookie onto `session.cookies.set` details. */
function toCookieSet(cookie: CookieRecord): CookieToSet {
  const host = cookie.hostKey.replace(/^\./, '')
  const path = cookie.path || '/'
  return {
    url: `${cookie.secure ? 'https' : 'http'}://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expiresAt === undefined
      ? {}
      : { expirationDate: cookie.expiresAt }),
    // A host_key with a leading dot is a domain cookie; keep it as `domain`.
    ...(cookie.hostKey.startsWith('.') ? { domain: cookie.hostKey } : {}),
  }
}

/** Runs one import; returns the counts the dialog reports back to the user. */
export async function importBrowserData(
  request: ImportRunRequest,
  deps: ImportDeps = {},
): Promise<ImportResult> {
  if (!request.passwords && !request.cookies)
    throw new ImportError('nothing-selected', '请至少选择一项要导入的数据')

  const detect =
    deps.detect ?? ((dir: string) => detectRunning({ userDataDir: dir }))
  const dir = userDataDir(request.browser, deps.homeDir ?? homedir())
  if (detect(dir).running)
    throw new ImportError('browser-running', '导入前请完全关闭该浏览器')

  if (request.passwords) {
    if (!deps.vault?.available)
      throw new ImportError('vault-unavailable', '密码管理器当前不可用')
    if (deps.vault.locked)
      throw new ImportError('vault-locked', '请先解锁密码管理器再导入密码')
  }
  if (request.cookies && !request.targetProfileId)
    throw new ImportError('no-target-profile', '请选择要写入的登录状态 profile')
  if (
    request.cookies &&
    request.targetProfileId &&
    deps.profileExists &&
    !deps.profileExists(request.targetProfileId)
  )
    throw new ImportError('no-target-profile', '选定的登录状态 profile 不存在')

  const read = deps.read ?? readBrowserData
  let data
  try {
    data = await read(
      {
        browser: request.browser,
        profileDir: request.profileDir,
        want: { passwords: request.passwords, cookies: request.cookies },
      },
      deps,
    )
  } catch {
    throw new ImportError('read-failed', '读取浏览器数据失败')
  }

  let passwords = 0
  if (request.passwords && deps.vault) {
    const existing = new Set<string>()
    for (const entry of deps.vault.entries())
      for (const binding of entry.bindings)
        if (
          binding.kind === 'origin' &&
          binding.origin &&
          entry.username !== undefined
        )
          existing.add(`${binding.origin}\n${entry.username}`)
    const drafts: Array<{
      label: string
      bindings: Array<{ kind: 'origin'; origin: string }>
      username?: string
      password: string
    }> = []
    for (const record of data.passwords) {
      if (!isExactHttpOrigin(record.origin)) continue
      const key = `${record.origin}\n${record.username}`
      if (existing.has(key)) continue
      drafts.push({
        label: labelFor(record.origin),
        bindings: [{ kind: 'origin', origin: record.origin }],
        ...(record.username ? { username: record.username } : {}),
        password: record.password,
      })
      existing.add(key)
    }
    // One write for the whole import: per-entry fsync froze the app (MAIN-7).
    if (drafts.length && deps.vault.saveMany) deps.vault.saveMany(drafts)
    else for (const draft of drafts) deps.vault.save(draft)
    passwords = drafts.length
  }

  let sites = 0
  if (request.cookies && request.targetProfileId && deps.cookieSink) {
    const sink = await deps.cookieSink(request.targetProfileId)
    const hosts = new Set<string>()
    for (const cookie of data.cookies) {
      try {
        await sink.set(toCookieSet(cookie))
        hosts.add(cookie.hostKey.replace(/^\./, ''))
      } catch {
        // A cookie Electron refuses is skipped; the rest still import.
      }
    }
    await sink.flush()
    sites = hosts.size
  }

  deps.log?.('browser-import complete', { passwords, sites })
  return { ok: true, passwords, sites }
}
