import { createCipheriv, createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveKey } from './chrome-crypto'
import { readBrowserData } from './read-browser-data'
import { userDataDir } from './browser-discovery'

// See read-browser-data.ts: reach node:sqlite without a bundler-resolved import.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite')

const KEY = deriveKey('fixt-pass')
const NOW_MS = Date.UTC(2026, 0, 1)
const NOW_SEC = Math.floor(NOW_MS / 1000)
const CHROME_EPOCH_OFFSET = 11644473600n

function toChromeMicros(unixSeconds: number): bigint {
  return (BigInt(unixSeconds) + CHROME_EPOCH_OFFSET) * 1_000_000n
}

function encryptV10(plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, ' '))
  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(plaintext),
    cipher.final(),
  ])
}

/** A cookie's plaintext is SHA-256(host_key) + value in schema ≥ 24. */
function encryptCookie(hostKey: string, value: string): Buffer {
  const hash = createHash('sha256').update(hostKey).digest()
  return encryptV10(Buffer.concat([hash, Buffer.from(value, 'utf8')]))
}

const roots: string[] = []
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'bi-read-home-'))
  roots.push(home)
  return home
}
function makeTmpParent(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bi-read-tmp-'))
  roots.push(dir)
  return dir
}

function writeLoginData(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true })
  const path = join(profileDir, 'Login Data')
  const db = new DatabaseSync(path)
  db.exec(
    `CREATE TABLE logins (
      origin_url TEXT NOT NULL,
      username_value TEXT,
      password_value BLOB,
      signon_realm TEXT NOT NULL,
      date_created INTEGER NOT NULL DEFAULT 0,
      blacklisted_by_user INTEGER NOT NULL DEFAULT 0
    )`,
  )
  const insert = db.prepare(
    `INSERT INTO logins
       (origin_url, username_value, password_value, signon_realm,
        date_created, blacklisted_by_user)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  // 1) plain valid login, dated
  insert.run(
    'https://mail.test/login',
    'alice',
    encryptV10(Buffer.from('pw-alice', 'utf8')),
    'https://mail.test/',
    toChromeMicros(1700000000),
    0,
  )
  // 2) origin only in signon_realm
  insert.run(
    '',
    'bob',
    encryptV10(Buffer.from('pw-bob', 'utf8')),
    'https://shop.test/',
    0,
    0,
  )
  // 3) blacklisted → skipped
  insert.run(
    'https://never.test/',
    '',
    Buffer.alloc(0),
    'https://never.test/',
    0,
    1,
  )
  // 4) empty password → skipped
  insert.run(
    'https://empty.test/login',
    'carol',
    Buffer.alloc(0),
    'https://empty.test/',
    0,
    0,
  )
  db.close()
  // WAL / journal siblings must be copied too.
  writeFileSync(`${path}-wal`, Buffer.alloc(0))
  writeFileSync(`${path}-journal`, Buffer.alloc(0))
}

function writeCookies(profileDir: string): void {
  const dir = join(profileDir, 'Network')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'Cookies'))
  db.exec(
    `CREATE TABLE cookies (
      host_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      encrypted_value BLOB DEFAULT x'',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL DEFAULT 0,
      is_secure INTEGER NOT NULL DEFAULT 0,
      is_httponly INTEGER NOT NULL DEFAULT 0,
      samesite INTEGER NOT NULL DEFAULT -1
    )`,
  )
  db.exec(`CREATE TABLE meta (key TEXT NOT NULL UNIQUE, value TEXT)`)
  db.prepare(`INSERT INTO meta (key, value) VALUES ('version', '24')`).run()
  const insert = db.prepare(
    `INSERT INTO cookies
       (host_key, name, value, encrypted_value, path, expires_utc,
        is_secure, is_httponly, samesite)
     VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)`,
  )
  // 1) future, secure, httpOnly, lax
  insert.run(
    '.mail.test',
    'SID',
    encryptCookie('.mail.test', 'tok-1'),
    '/',
    toChromeMicros(NOW_SEC + 86400),
    1,
    1,
    1,
  )
  // 2) session cookie (no expiry), same-site none
  insert.run(
    'shop.test',
    'cart',
    encryptCookie('shop.test', 'c1'),
    '/',
    0,
    0,
    0,
    0,
  )
  // 3) expired → skipped
  insert.run(
    '.old.test',
    'OLD',
    encryptCookie('.old.test', 'x'),
    '/',
    toChromeMicros(NOW_SEC - 86400),
    0,
    0,
    -1,
  )
  // 4) future, strict
  insert.run(
    'app.test',
    's',
    encryptCookie('app.test', 'v4'),
    '/a',
    toChromeMicros(NOW_SEC + 10),
    1,
    0,
    2,
  )
  db.close()
}

function chromeProfile(home: string, profile = 'Default'): string {
  return join(userDataDir('chrome', home), profile)
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('readBrowserData', () => {
  it('reads, decrypts and normalizes passwords and cookies', async () => {
    const home = makeHome()
    const profile = chromeProfile(home)
    writeLoginData(profile)
    writeCookies(profile)
    const tmpParent = makeTmpParent()
    const readSafeStoragePassword = vi.fn(() => 'fixt-pass')

    const data = await readBrowserData(
      {
        browser: 'chrome',
        profileDir: 'Default',
        want: { passwords: true, cookies: true },
      },
      { homeDir: home, now: () => NOW_MS, tmpParent, readSafeStoragePassword },
    )

    expect(readSafeStoragePassword).toHaveBeenCalledWith('chrome')

    expect(data.passwords).toEqual([
      {
        origin: 'https://mail.test',
        username: 'alice',
        password: 'pw-alice',
        createdAt: 1700000000,
      },
      { origin: 'https://shop.test', username: 'bob', password: 'pw-bob' },
    ])

    expect(data.cookies).toEqual([
      {
        hostKey: '.mail.test',
        name: 'SID',
        value: 'tok-1',
        path: '/',
        expiresAt: NOW_SEC + 86400,
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      },
      {
        hostKey: 'shop.test',
        name: 'cart',
        value: 'c1',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'no_restriction',
      },
      {
        hostKey: 'app.test',
        name: 's',
        value: 'v4',
        path: '/a',
        expiresAt: NOW_SEC + 10,
        secure: true,
        httpOnly: false,
        sameSite: 'strict',
      },
    ])

    expect(data.counts).toEqual({ passwords: 2, cookies: 3 })
  })

  it('copies the DB (with -wal/-journal) to a temp dir and cleans up', async () => {
    const home = makeHome()
    const profile = chromeProfile(home)
    writeLoginData(profile)
    const tmpParent = makeTmpParent()
    const copied: string[][] = []

    await readBrowserData(
      { browser: 'chrome', profileDir: 'Default', want: { passwords: true } },
      {
        homeDir: home,
        now: () => NOW_MS,
        tmpParent,
        readSafeStoragePassword: () => 'fixt-pass',
        onCopied: (names) => copied.push([...names]),
      },
    )

    expect(copied).toEqual([
      ['Login Data', 'Login Data-journal', 'Login Data-wal'],
    ])
    // Nothing left behind under the temp parent.
    expect(readdirSync(tmpParent)).toEqual([])
  })

  it('honors the want flags', async () => {
    const home = makeHome()
    const profile = chromeProfile(home)
    writeLoginData(profile)
    writeCookies(profile)

    const data = await readBrowserData(
      { browser: 'chrome', profileDir: 'Default', want: { cookies: true } },
      {
        homeDir: home,
        now: () => NOW_MS,
        tmpParent: makeTmpParent(),
        readSafeStoragePassword: () => 'fixt-pass',
      },
    )
    expect(data.passwords).toEqual([])
    expect(data.counts.passwords).toBe(0)
    expect(data.cookies.length).toBe(3)
  })

  it('returns empty lists when the profile has no data files', async () => {
    const home = makeHome()
    mkdirSync(chromeProfile(home), { recursive: true })

    const data = await readBrowserData(
      {
        browser: 'chrome',
        profileDir: 'Default',
        want: { passwords: true, cookies: true },
      },
      {
        homeDir: home,
        now: () => NOW_MS,
        tmpParent: makeTmpParent(),
        readSafeStoragePassword: () => 'fixt-pass',
      },
    )
    expect(data).toEqual({
      passwords: [],
      cookies: [],
      counts: { passwords: 0, cookies: 0 },
    })
  })
})
