import { createCipheriv, createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  decryptValue,
  deriveKey,
  readSafeStoragePassword,
  safeStorageService,
} from './chrome-crypto'

/** Chromium's v10 layout: `v10` + AES-128-CBC(plaintext) with a 16-space IV. */
function encryptV10(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(plaintext),
    cipher.final(),
  ])
}

describe('deriveKey', () => {
  it('is a deterministic 16-byte AES key (PBKDF2/saltysalt/1003/sha1)', () => {
    const a = deriveKey('safe-storage-secret')
    const b = deriveKey('safe-storage-secret')
    expect(a).toHaveLength(16)
    expect(a.equals(b)).toBe(true)
    expect(a.equals(deriveKey('other'))).toBe(false)
  })
})

describe('decryptValue', () => {
  const key = deriveKey('safe-storage-secret')

  it('round-trips a v10 password', () => {
    const blob = encryptV10(Buffer.from('hunter2', 'utf8'), key)
    expect(decryptValue(blob, key)).toBe('hunter2')
  })

  it('returns null when the blob lacks the v10 prefix', () => {
    const plain = Buffer.from('not-encrypted', 'utf8')
    expect(decryptValue(plain, key)).toBeNull()
  })

  it('returns null when the key does not match (bad padding)', () => {
    const blob = encryptV10(Buffer.from('secret', 'utf8'), key)
    expect(decryptValue(blob, deriveKey('wrong'))).toBeNull()
  })

  it('drops the 32-byte SHA-256(host_key) domain hash for new cookies', () => {
    const hostKey = '.shop.test'
    const hash = createHash('sha256').update(hostKey).digest()
    const blob = encryptV10(
      Buffer.concat([hash, Buffer.from('session-token', 'utf8')]),
      key,
    )
    expect(decryptValue(blob, key, { stripDomainHash: true })).toBe(
      'session-token',
    )
    // Without stripping, the 32 raw bytes bleed into the value.
    expect(decryptValue(blob, key)).not.toBe('session-token')
  })
})

describe('safeStorageService', () => {
  it('names Chrome and Edge Safe Storage', () => {
    expect(safeStorageService('chrome')).toEqual({
      service: 'Chrome Safe Storage',
      account: 'Chrome',
    })
    expect(safeStorageService('edge')).toEqual({
      service: 'Microsoft Edge Safe Storage',
      account: 'Microsoft Edge',
    })
  })
})

describe('readSafeStoragePassword', () => {
  it('reaches the Keychain only through the injected runner', () => {
    const run = vi.fn((service: string, account: string) => {
      expect(service).toBe('Microsoft Edge Safe Storage')
      expect(account).toBe('Microsoft Edge')
      return 'edge-secret\n'
    })
    // Trailing newline from `security -w` is trimmed.
    expect(readSafeStoragePassword('edge', run)).toBe('edge-secret')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
