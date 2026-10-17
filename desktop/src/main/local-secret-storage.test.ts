import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { LocalSecretStorage } from './local-secret-storage'
import { vaultEncryption } from '../renderer/src/components/settings/computer/credentialVaultModel'
import { CredentialVault } from './computer-use/credential-vault'
import {
  EncryptedFilePairingStore,
  electronPairingCipher,
} from './computer-use/nm-bridge-store'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-local-secrets-'))
  roots.push(root)
  const keyPath = join(root, 'secret-storage', 'key')
  return { root, keyPath, storage: new LocalSecretStorage(keyPath) }
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('local secret storage without OS key services', () => {
  it('describes local encryption accurately in Settings', () => {
    const status = {
      available: true,
      backend: 'local-file',
      locked: false,
      hasMasterPassword: false,
      handles: [],
    }
    expect(vaultEncryption(status)?.badge).toBe('本地加密')
    expect(vaultEncryption({ ...status, hasMasterPassword: true })?.badge).toBe(
      '本地加密 + 主密码',
    )
  })

  it('persists a private key and decrypts across process instances with randomized ciphertext', () => {
    const { keyPath, storage } = fixture()
    expect(storage.isEncryptionAvailable()).toBe(true)
    const cipher = storage.encryptString('private-value')
    expect(cipher.includes(Buffer.from('private-value'))).toBe(false)
    expect(cipher.equals(storage.encryptString('private-value'))).toBe(false)
    expect(new LocalSecretStorage(keyPath).decryptString(cipher)).toBe(
      'private-value',
    )
    expect(readFileSync(keyPath)).toHaveLength(32)
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(keyPath)).mode & 0o777).toBe(0o700)
  })
  it('rejects tampering and foreign or old system ciphertext without overwriting the key', () => {
    const { keyPath, storage } = fixture()
    const cipher = storage.encryptString('secret')
    const key = readFileSync(keyPath)
    cipher[cipher.length - 1] ^= 1
    expect(() => storage.decryptString(cipher)).toThrow()
    expect(() =>
      storage.decryptString(Buffer.from('old-safe-storage-cipher')),
    ).toThrow('unsupported')
    expect(readFileSync(keyPath).equals(key)).toBe(true)
  })
  it('fails closed for a corrupt existing key and preserves it', () => {
    const { keyPath, storage } = fixture()
    expect(storage.isEncryptionAvailable()).toBe(true)
    writeFileSync(keyPath, 'corrupt', { mode: 0o600 })
    expect(storage.isEncryptionAvailable()).toBe(false)
    expect(() => storage.encryptString('secret')).toThrow()
    expect(readFileSync(keyPath, 'utf8')).toBe('corrupt')
  })
  it.skipIf(process.platform === 'win32')(
    'rejects a symlink key and loose permissions',
    () => {
      const { root, keyPath, storage } = fixture()
      expect(storage.isEncryptionAvailable()).toBe(true)
      chmodSync(keyPath, 0o644)
      expect(storage.isEncryptionAvailable()).toBe(false)
      chmodSync(keyPath, 0o600)
      const other = join(root, 'other-key')
      writeFileSync(other, readFileSync(keyPath), { mode: 0o600 })
      rmSync(keyPath)
      symlinkSync(other, keyPath)
      expect(storage.isEncryptionAvailable()).toBe(false)
      expect(() => storage.decryptString(Buffer.from('cipher'))).toThrow()
    },
  )
  it('serves the actual credential vault including a master password without Keychain', () => {
    const { root, keyPath, storage } = fixture()
    const path = join(root, 'computer-use', 'vault.json')
    const vault = new CredentialVault({ path, storage })
    expect(vault.backend).toBe('local-file')
    const handle = vault.save({
      label: 'local',
      bindings: [{ kind: 'origin', origin: 'https://example.test' }],
      password: 'local-secret',
    })
    vault.setMasterPassword('owned-test-master')
    vault.lock()
    const reloaded = new CredentialVault({
      path,
      storage: new LocalSecretStorage(keyPath),
    })
    expect(reloaded.unlock('wrong-master')).toBe(false)
    expect(reloaded.unlock('owned-test-master')).toBe(true)
    expect(reloaded.secret(handle.handleId, 'password')).toBe('local-secret')
    expect(readFileSync(path, 'utf8')).not.toContain('local-secret')
    reloaded.lock()
  })
  it.skipIf(process.platform !== 'darwin')(
    'serves actual browser pairing persistence without Keychain',
    async () => {
      const { root, keyPath, storage } = fixture()
      const path = join(root, 'pairings.json')
      const pairing = {
        pairingId: randomBytes(16).toString('base64url'),
        extensionId: 'a'.repeat(32),
        secret: randomBytes(32).toString('base64url'),
        createdAt: '2026-10-17T00:00:00.000Z',
      }
      await new EncryptedFilePairingStore(
        path,
        electronPairingCipher(storage),
      ).put(pairing)
      expect(
        await new EncryptedFilePairingStore(
          path,
          electronPairingCipher(new LocalSecretStorage(keyPath)),
        ).get(pairing.pairingId),
      ).toEqual(pairing)
      expect(readFileSync(path, 'utf8')).not.toContain(pairing.secret)
    },
  )
})
