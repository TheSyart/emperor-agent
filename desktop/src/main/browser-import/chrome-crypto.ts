/**
 * Chromium's macOS "v10" secret encryption, in reverse. A per-browser Safe
 * Storage password (from the Keychain) becomes an AES-128 key via PBKDF2
 * (salt `saltysalt`, 1003 rounds, SHA-1); each stored value is `v10` + AES-CBC
 * ciphertext with a 16-space IV. Newer cookies (schema ≥ 24) carry a 32-byte
 * SHA-256(host_key) domain hash ahead of the plaintext, which we drop.
 *
 * The Keychain read is injectable and is the only path to the real
 * `security` command; tests always pass a stand-in so no authorization prompt
 * is ever raised.
 */
import { execFileSync } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import type { BrowserId, SecurityRunner } from './types'

const SALT = 'saltysalt'
const ITERATIONS = 1003
const KEY_LENGTH = 16
const IV = Buffer.alloc(16, ' ')
const V10 = Buffer.from('v10')
/** The domain-hash prefix on decrypted cookies at schema version ≥ 24. */
const DOMAIN_HASH_LENGTH = 32

/** PBKDF2(password, saltysalt, 1003, 16, sha1) — Chromium's fixed parameters. */
export function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, SALT, ITERATIONS, KEY_LENGTH, 'sha1')
}

/**
 * Decrypts a `v10` blob. Returns the UTF-8 plaintext, or `null` when the blob
 * is not `v10` or the key does not fit (bad PKCS#7 padding) — a caller then
 * skips that entry rather than throwing. `stripDomainHash` drops the leading
 * 32-byte SHA-256(host_key) that new cookies carry.
 */
export function decryptValue(
  blob: Buffer,
  key: Buffer,
  opts: { stripDomainHash?: boolean } = {},
): string | null {
  if (blob.length <= V10.length || !blob.subarray(0, V10.length).equals(V10))
    return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, IV)
    let plaintext = Buffer.concat([
      decipher.update(blob.subarray(V10.length)),
      decipher.final(),
    ])
    if (opts.stripDomainHash) {
      if (plaintext.length < DOMAIN_HASH_LENGTH) return null
      plaintext = plaintext.subarray(DOMAIN_HASH_LENGTH)
    }
    return plaintext.toString('utf8')
  } catch {
    return null
  }
}

/** The Keychain generic-password service and account for each browser. */
export function safeStorageService(browser: BrowserId): {
  service: string
  account: string
} {
  return browser === 'edge'
    ? { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' }
    : { service: 'Chrome Safe Storage', account: 'Chrome' }
}

/** The default runner — the only place the real Keychain prompt can appear.
 *  Never called under test: every caller there injects a stand-in. */
function runSecurity(service: string, account: string): string {
  return execFileSync(
    'security',
    ['find-generic-password', '-w', '-s', service, '-a', account],
    { encoding: 'utf8' },
  )
}

/**
 * Reads a browser's Safe Storage password. The default asks the macOS
 * Keychain, which raises an authorization prompt — so tests always pass a
 * stand-in `run`, and automation never reaches the real `security` command.
 */
export function readSafeStoragePassword(
  browser: BrowserId,
  run: SecurityRunner = runSecurity,
): string {
  const { service, account } = safeStorageService(browser)
  return run(service, account).trim()
}
