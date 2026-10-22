/**
 * The one entry the import flow calls: `readBrowserData` copies the profile's
 * `Login Data` / `Cookies` (with any `-wal`/`-shm`/`-journal`) into a private
 * 0700 temp dir, opens the copies read-only with `node:sqlite`, decrypts in the
 * main process, and returns normalized records plus counts. The temp dir is
 * removed before it returns, and logs carry counts only — never a value.
 */
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { userDataDir } from './browser-discovery'
import {
  decryptValue,
  deriveKey,
  readSafeStoragePassword,
} from './chrome-crypto'
import type {
  BrowserData,
  BrowserId,
  CookieRecord,
  PasswordRecord,
  ReadBrowserDataDeps,
  ReadBrowserDataOptions,
} from './types'

// `node:sqlite` is an experimental builtin that is absent from `builtinModules`,
// so Vite/vitest cannot resolve a static `import … from 'node:sqlite'` (it
// strips the prefix and hunts for a package). `process.getBuiltinModule` reaches
// it at runtime with no specifier for any bundler to resolve, and stays fully
// typed. Electron and the vitest Node both support it.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
type Db = InstanceType<typeof DatabaseSync>

/** Seconds between the Windows/Chrome epoch (1601) and the Unix epoch (1970). */
const CHROME_EPOCH_OFFSET = 11644473600n
/** New cookies (schema ≥ 24) prepend a 32-byte SHA-256(host_key) to the value. */
const DOMAIN_HASH_SCHEMA = 24
/** Journal siblings copied alongside the DB so the snapshot is consistent. */
const DB_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const

/** Chrome's microseconds-since-1601 to Unix seconds. */
function chromeMicrosToUnix(micros: bigint): number {
  return Number(micros / 1_000_000n - CHROME_EPOCH_OFFSET)
}

/** Canonical http(s) origin, falling back to the raw realm for app logins. */
function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch {
    // fall through
  }
  return value
}

function sameSiteOf(value: unknown): CookieRecord['sameSite'] {
  switch (Number(value)) {
    case 0:
      return 'no_restriction'
    case 1:
      return 'lax'
    case 2:
      return 'strict'
    default:
      return 'unspecified'
  }
}

/**
 * Copies a SQLite DB group into a fresh 0700 temp dir, opens the copy
 * read-only, hands it to `read`, then removes the temp dir. The original file
 * is never opened, so a live browser is not disturbed and locks are avoided.
 */
async function withCopiedDb<T>(
  dbPath: string,
  tmpParent: string,
  onCopied: ((names: readonly string[]) => void) | undefined,
  read: (db: Db) => T,
): Promise<T> {
  const dir = await mkdtemp(join(tmpParent, 'emperor-import-'))
  try {
    await chmod(dir, 0o700)
    const base = basename(dbPath)
    const copied: string[] = []
    for (const suffix of DB_SUFFIXES) {
      const src = dbPath + suffix
      if (!existsSync(src)) continue
      const name = base + suffix
      await copyFile(src, join(dir, name))
      copied.push(name)
    }
    onCopied?.(copied.sort())
    const db = new DatabaseSync(join(dir, base), { readOnly: true })
    try {
      return read(db)
    } finally {
      db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Reads and decrypts saved logins from a copied `Login Data`. */
function readPasswords(db: Db, key: Buffer): PasswordRecord[] {
  const rows = db
    .prepare(
      `SELECT origin_url, signon_realm, username_value, password_value,
              blacklisted_by_user, CAST(date_created AS TEXT) AS date_created
         FROM logins`,
    )
    .all() as Array<Record<string, unknown>>
  const records: PasswordRecord[] = []
  for (const row of rows) {
    if (Number(row.blacklisted_by_user)) continue
    const blob = row.password_value
    if (!(blob instanceof Uint8Array) || blob.length === 0) continue
    const password = decryptValue(Buffer.from(blob), key)
    if (!password) continue
    const origin = normalizeOrigin(
      String(row.origin_url || row.signon_realm || ''),
    )
    if (!origin) continue
    const createdMicros = BigInt(String(row.date_created ?? '0'))
    records.push({
      origin,
      username:
        typeof row.username_value === 'string' ? row.username_value : '',
      password,
      createdAt:
        createdMicros > 0n ? chromeMicrosToUnix(createdMicros) : undefined,
    })
  }
  return records
}

/** Reads and decrypts cookies from a copied `Cookies`, dropping expired ones. */
function readCookies(db: Db, key: Buffer, nowSec: number): CookieRecord[] {
  const meta = db
    .prepare(`SELECT value FROM meta WHERE key = 'version'`)
    .get() as { value?: unknown } | undefined
  const schema = Number(meta?.value ?? 0)
  const stripDomainHash = schema >= DOMAIN_HASH_SCHEMA
  const rows = db
    .prepare(
      `SELECT host_key, name, value, encrypted_value, path,
              CAST(expires_utc AS TEXT) AS expires_utc,
              is_secure, is_httponly, samesite
         FROM cookies`,
    )
    .all() as Array<Record<string, unknown>>
  const records: CookieRecord[] = []
  for (const row of rows) {
    const expiresMicros = BigInt(String(row.expires_utc ?? '0'))
    let expiresAt: number | undefined
    if (expiresMicros > 0n) {
      expiresAt = chromeMicrosToUnix(expiresMicros)
      if (expiresAt <= nowSec) continue // expired
    }
    const blob = row.encrypted_value
    let value: string | null
    if (blob instanceof Uint8Array && blob.length > 0) {
      value = decryptValue(Buffer.from(blob), key, { stripDomainHash })
    } else {
      value = typeof row.value === 'string' ? row.value : ''
    }
    if (value === null) continue
    records.push({
      hostKey: String(row.host_key ?? ''),
      name: String(row.name ?? ''),
      value,
      path: String(row.path ?? '/'),
      expiresAt,
      secure: Boolean(Number(row.is_secure)),
      httpOnly: Boolean(Number(row.is_httponly)),
      sameSite: sameSiteOf(row.samesite),
    })
  }
  return records
}

/** Reads passwords and/or cookies from one Chrome/Edge profile. */
export async function readBrowserData(
  opts: ReadBrowserDataOptions,
  deps: ReadBrowserDataDeps = {},
): Promise<BrowserData> {
  const homeDir = deps.homeDir ?? homedir()
  const tmpParent = deps.tmpParent ?? tmpdir()
  const nowSec = Math.floor((deps.now ?? Date.now)() / 1000)
  const readPassword = deps.readSafeStoragePassword ?? readSafeStoragePassword
  const profilePath = join(userDataDir(opts.browser, homeDir), opts.profileDir)

  let passwords: PasswordRecord[] = []
  let cookies: CookieRecord[] = []
  let key: Buffer | undefined
  const getKey = async (browser: BrowserId): Promise<Buffer> =>
    (key ??= deriveKey(await readPassword(browser)))

  if (opts.want.passwords) {
    const loginData = join(profilePath, 'Login Data')
    if (existsSync(loginData)) {
      const passwordKey = await getKey(opts.browser)
      passwords = await withCopiedDb(
        loginData,
        tmpParent,
        deps.onCopied,
        (db) => readPasswords(db, passwordKey),
      )
    }
  }

  if (opts.want.cookies) {
    const networkCookies = join(profilePath, 'Network', 'Cookies')
    const legacyCookies = join(profilePath, 'Cookies')
    const cookiesPath = existsSync(networkCookies)
      ? networkCookies
      : existsSync(legacyCookies)
        ? legacyCookies
        : undefined
    if (cookiesPath) {
      const cookieKey = await getKey(opts.browser)
      cookies = await withCopiedDb(
        cookiesPath,
        tmpParent,
        deps.onCopied,
        (db) => readCookies(db, cookieKey, nowSec),
      )
    }
  }

  return {
    passwords,
    cookies,
    counts: { passwords: passwords.length, cookies: cookies.length },
  }
}
