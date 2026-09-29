import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CredentialVault,
  CredentialVaultError,
  type MasterKdf,
  type VaultTimers,
} from './credential-vault'

/** `argon2: false` behaves like Electron, whose BoringSSL has no Argon2. */
const runtime = vi.hoisted(() => ({ argon2: true }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  const argon2Sync = (
    actual as unknown as { argon2Sync: (...args: unknown[]) => Buffer }
  ).argon2Sync
  return {
    ...actual,
    argon2Sync(...args: unknown[]): Buffer {
      if (!runtime.argon2)
        throw Object.assign(new Error('Argon2 algorithm not supported'), {
          code: 'ERR_CRYPTO_ARGON2_NOT_SUPPORTED',
        })
      return argon2Sync(...args)
    },
  }
})

const storage = {
  isEncryptionAvailable: () => true,
  encryptString(value: string): Buffer {
    const key = Buffer.alloc(32, 7)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    return Buffer.concat([
      iv,
      cipher.update(value, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ])
  },
  decryptString(data: Buffer): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.alloc(32, 7),
      data.subarray(0, 12),
    )
    decipher.setAuthTag(data.subarray(-16))
    return Buffer.concat([
      decipher.update(data.subarray(12, -16)),
      decipher.final(),
    ]).toString('utf8')
  },
}

const CHEAP_KDF: MasterKdf = {
  kind: 'scrypt',
  params: { cost: 1024, blockSize: 8, parallelization: 1, keyLength: 32 },
}
const LEGACY_ARGON2_KDF: MasterKdf = {
  kind: 'argon2id',
  params: { memory: 65536, passes: 3, parallelism: 4, tagLength: 32 },
}

/** Manual clock and timers: `advance` fires due callbacks in order. */
function manualClock(start: number) {
  let now = start
  let next = 1
  const pending = new Map<number, { at: number; callback: () => void }>()
  const timers: VaultTimers = {
    setTimeout(callback, ms) {
      const id = next++
      pending.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout(handle) {
      pending.delete(handle as number)
    },
  }
  return {
    timers,
    now: () => now,
    pending: () => pending.size,
    set(value: number) {
      now = value
    },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        now = due[1].at
        due[1].callback()
      }
      now = target
    },
  }
}

function caught(action: () => unknown): CredentialVaultError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialVaultError)
    return error as CredentialVaultError
  }
  throw new Error('expected a vault error')
}

function vaultPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), 'emperor-vault-')),
    'computer-use',
    'vault.json',
  )
}

describe('CredentialVault', () => {
  it('persists only encrypted secrets and exposes handles without private fields', () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage })
    const handle = vault.save({
      label: 'Example',
      bindings: [{ kind: 'origin', origin: 'https://example.test' }],
      username: 'alice',
      password: 'not-in-cleartext-74',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      revealUsername: false,
      fillMode: 'auto',
    })
    expect(handle.username).toBeUndefined()
    expect(handle.fields).toEqual(['username', 'password', 'totp'])
    expect(vault.secret(handle.handleId, 'password')).toBe(
      'not-in-cleartext-74',
    )
    expect(vault.secret(handle.handleId, 'username')).toBe('alice')
    const disk = readFileSync(path, 'utf8')
    expect(disk).not.toContain('not-in-cleartext-74')
    expect(disk).not.toContain('JBSWY3DPEHPK3PXP')
    expect(disk).not.toContain('alice')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    expect(
      new CredentialVault({ path, storage }).secret(
        handle.handleId,
        'password',
      ),
    ).toBe('not-in-cleartext-74')
  })

  it('requires exact origin bindings and drops deleted entries', () => {
    const vault = new CredentialVault({ path: vaultPath(), storage })
    expect(() =>
      vault.save({
        label: 'bad',
        bindings: [{ kind: 'origin', origin: 'https://x.test/path' }],
        password: 'x',
      }),
    ).toThrow()
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'x',
    })
    expect(() =>
      vault.secret(handle.handleId, 'password', 'https://sub.x.test'),
    ).toThrow()
    expect(vault.secret(handle.handleId, 'password', 'https://x.test')).toBe(
      'x',
    )
    vault.remove(handle.handleId)
    expect(vault.list()).toEqual([])
  })

  it('requires a signed Team ID or an exact path for desktop app bindings', () => {
    const vault = new CredentialVault({ path: vaultPath(), storage })
    expect(() =>
      vault.save({
        label: 'unsafe',
        bindings: [{ kind: 'app', bundleId: 'com.example.Writer' }],
        password: 'x',
      }),
    ).toThrow()
    const handle = vault.save({
      label: 'Writer',
      bindings: [
        { kind: 'app', bundleId: 'com.example.Writer', teamId: 'EXAMPLE123' },
      ],
      password: 'private',
    })
    expect(handle.bindings).toEqual([
      { kind: 'app', bundleId: 'com.example.Writer', teamId: 'EXAMPLE123' },
    ])
  })

  it('uses a scrypt master password, locks on restart and after inactivity', () => {
    const path = vaultPath()
    let now = 10_000
    const vault = new CredentialVault({ path, storage, now: () => now })
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private',
    })
    vault.setMasterPassword('correct horse battery')
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      master: { kind: string; params: unknown }
    }
    expect(stored.master).toMatchObject({
      kind: 'scrypt',
      params: {
        cost: 131_072,
        blockSize: 8,
        parallelization: 1,
        keyLength: 32,
      },
    })
    vault.lock()
    expect(vault.locked).toBe(true)
    expect(() => vault.secret(handle.handleId, 'password')).toThrow()
    expect(vault.unlock('incorrect')).toBe(false)
    expect(vault.unlock('correct horse battery')).toBe(true)
    expect(vault.secret(handle.handleId, 'password')).toBe('private')
    now += 30 * 60_000 + 1
    expect(vault.locked).toBe(true)
    expect(new CredentialVault({ path, storage }).locked).toBe(true)
  })

  it('refuses to create entries without system encryption', () => {
    const vault = new CredentialVault({
      path: vaultPath(),
      storage: { ...storage, isEncryptionAvailable: () => false },
    })
    expect(() =>
      vault.save({
        label: 'site',
        bindings: [{ kind: 'origin', origin: 'https://x.test' }],
        password: 'x',
      }),
    ).toThrow()
  })

  it('generates a TOTP only at use time and rejects tampered ciphertext', () => {
    const path = vaultPath()
    let now = 59_000
    const vault = new CredentialVault({ path, storage, now: () => now })
    const handle = vault.save({
      label: 'OTP',
      bindings: [{ kind: 'origin', origin: 'https://otp.test' }],
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    })
    expect(vault.secret(handle.handleId, 'totp')).toBe('287082')
    now = 60_000
    expect(vault.secret(handle.handleId, 'totp')).not.toBe('287082')
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      entries: Array<{ fields: { totp: string } }>
    }
    data.entries[0]!.fields.totp =
      's:' + Buffer.from('corrupted').toString('base64')
    const corruptPath = vaultPath()
    mkdirSync(join(corruptPath, '..'), { recursive: true })
    writeFileSync(corruptPath, JSON.stringify(data))
    expect(() =>
      new CredentialVault({ path: corruptPath, storage }).secret(
        handle.handleId,
        'totp',
      ),
    ).toThrow()
  })

  it('gives every failure a stable reason and code without echoing values', () => {
    const path = vaultPath()
    const clock = manualClock(10_000)
    const vault = new CredentialVault({
      path,
      storage,
      now: clock.now,
      timers: clock.timers,
      kdf: CHEAP_KDF,
    })
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private-value-81',
    })
    const missing = caught(() =>
      vault.secret('cred_000000000000000000000000', 'password'),
    )
    expect([missing.reason, missing.code]).toEqual([
      'credential-not-found',
      'INVALID_REQUEST',
    ])
    const field = caught(() => vault.secret(handle.handleId, 'totp'))
    expect(field.reason).toBe('credential-field-missing')
    const mismatch = caught(() =>
      vault.secret(handle.handleId, 'password', 'https://evil.test'),
    )
    expect([mismatch.reason, mismatch.code]).toEqual([
      'credential-binding-mismatch',
      'PERMISSION_DENIED',
    ])
    // A live origin that is not http(s) is a mismatch, not a bad request.
    expect(
      caught(() => vault.secret(handle.handleId, 'password', 'file://')).reason,
    ).toBe('credential-binding-mismatch')
    expect(
      caught(() =>
        vault.save({
          label: 'bad',
          bindings: [{ kind: 'origin', origin: 'https://x.test' }],
          totpSecret: 'not-base32!',
        }),
      ).reason,
    ).toBe('invalid-totp')
    expect(caught(() => vault.setMasterPassword('short')).reason).toBe(
      'master-password-too-short',
    )
    vault.setMasterPassword('correct horse battery')
    vault.lock()
    const locked = caught(() => vault.secret(handle.handleId, 'password'))
    expect([locked.reason, locked.code]).toEqual([
      'vault-locked',
      'PERMISSION_REQUIRED',
    ])
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      entries: Array<{ fields: { password: string } }>
    }
    data.entries[0]!.fields.password =
      's:' + Buffer.from('corrupted').toString('base64')
    const corruptPath = vaultPath()
    mkdirSync(join(corruptPath, '..'), { recursive: true })
    writeFileSync(corruptPath, JSON.stringify({ ...data, master: undefined }))
    const unreadable = caught(() =>
      new CredentialVault({ path: corruptPath, storage }).secret(
        handle.handleId,
        'password',
      ),
    )
    expect(unreadable.reason).toBe('credential-unreadable')
    const unavailable = caught(() =>
      new CredentialVault({
        path: vaultPath(),
        storage: { ...storage, isEncryptionAvailable: () => false },
      }).secret(handle.handleId, 'password'),
    )
    expect([unavailable.reason, unavailable.code]).toEqual([
      'vault-unavailable',
      'CAPABILITY_DISABLED',
    ])
    for (const error of [missing, field, mismatch, locked, unreadable])
      expect(`${error.message} ${String(error.cause)}`).not.toContain(
        'private-value-81',
      )
  })

  it('drops the master key on an idle timer and extends it on use', () => {
    const clock = manualClock(10_000)
    const vault = new CredentialVault({
      path: vaultPath(),
      storage,
      now: clock.now,
      timers: clock.timers,
      kdf: CHEAP_KDF,
    })
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private',
    })
    expect(clock.pending()).toBe(0)
    vault.setMasterPassword('correct horse battery')
    expect(clock.pending()).toBe(1)
    clock.advance(20 * 60_000)
    expect(vault.secret(handle.handleId, 'password')).toBe('private')
    // The first deadline finds recent use and re-arms for the remainder.
    clock.advance(10 * 60_000)
    expect(clock.pending()).toBe(1)
    expect(vault.locked).toBe(false)
    clock.advance(20 * 60_000)
    expect(clock.pending()).toBe(0)
    // Rewind the clock: only the timer, not a lazy check, can have locked it.
    clock.set(10_000)
    expect(vault.locked).toBe(true)
    expect(vault.list()[0]!.username).toBeUndefined()
    expect(vault.unlock('correct horse battery')).toBe(true)
    expect(clock.pending()).toBe(1)
    vault.lock()
    expect(clock.pending()).toBe(0)
    expect(vault.unlock('correct horse battery')).toBe(true)
    vault.setMasterPassword(null)
    expect(clock.pending()).toBe(0)
    expect(vault.locked).toBe(false)
  })

  it('stores the KDF cost with the salt and reads it back on unlock', () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage, kdf: CHEAP_KDF })
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private',
    })
    vault.setMasterPassword('correct horse battery')
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      master: { kind: string; params: unknown }
    }
    expect(stored.master.kind).toBe('scrypt')
    expect(stored.master.params).toEqual(CHEAP_KDF.params)
    // A later build with other defaults still opens this vault.
    const reopened = new CredentialVault({ path, storage })
    expect(reopened.unlock('correct horse battery')).toBe(true)
    expect(reopened.secret(handle.handleId, 'password')).toBe('private')

    const tampered = vaultPath()
    mkdirSync(join(tampered, '..'), { recursive: true })
    writeFileSync(
      tampered,
      JSON.stringify({
        ...stored,
        master: {
          ...stored.master,
          params: { ...CHEAP_KDF.params, cost: 1 << 24 },
        },
      }),
    )
    expect(
      caught(() =>
        new CredentialVault({ path: tampered, storage }).unlock(
          'correct horse battery',
        ),
      ).reason,
    ).toBe('vault-file-invalid')
  })

  it('opens Argon2id vaults written before KDF parameters were stored', () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage, kdf: LEGACY_ARGON2_KDF })
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private',
    })
    vault.setMasterPassword('correct horse battery')
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      master: { params?: unknown }
    }
    expect(data.master.params).toEqual({
      memory: 65536,
      passes: 3,
      parallelism: 4,
      tagLength: 32,
    })
    delete data.master.params
    writeFileSync(path, JSON.stringify(data))
    const legacy = new CredentialVault({ path, storage, kdf: CHEAP_KDF })
    expect(legacy.unlock('wrong password here')).toBe(false)
    expect(legacy.unlock('correct horse battery')).toBe(true)
    expect(legacy.secret(handle.handleId, 'password')).toBe('private')
  })

  it('sets a master password with biometric unlock where the runtime has no Argon2', () => {
    runtime.argon2 = false
    try {
      const path = vaultPath()
      const vault = new CredentialVault({ path, storage })
      const handle = vault.save({
        label: 'site',
        bindings: [{ kind: 'origin', origin: 'https://x.test' }],
        password: 'private',
      })
      vault.setMasterPassword('correct horse battery', { biometric: true })
      vault.lock()
      vault.unlockWithBiometrics()
      expect(vault.secret(handle.handleId, 'password')).toBe('private')
      vault.lock()
      expect(vault.unlock('correct horse battery')).toBe(true)

      // An Argon2id vault written where Argon2 existed cannot open here.
      const older = vaultPath()
      runtime.argon2 = true
      new CredentialVault({
        path: older,
        storage,
        kdf: LEGACY_ARGON2_KDF,
      }).setMasterPassword('correct horse battery')
      runtime.argon2 = false
      const failure = caught(() =>
        new CredentialVault({ path: older, storage }).unlock(
          'correct horse battery',
        ),
      )
      expect([failure.reason, failure.code]).toEqual([
        'vault-kdf-unavailable',
        'CAPABILITY_DISABLED',
      ])
    } finally {
      runtime.argon2 = true
    }
  })

  it('reports the storage backend and disables basic_text on Linux', () => {
    const linux = (backend: string) =>
      new CredentialVault({
        path: vaultPath(),
        storage: { ...storage, getSelectedStorageBackend: () => backend },
        platform: 'linux',
      })
    expect(linux('gnome_libsecret').backend).toBe('gnome_libsecret')
    expect(linux('gnome_libsecret').available).toBe(true)
    expect(linux('basic_text').backend).toBe('basic_text')
    expect(linux('basic_text').available).toBe(false)
    expect(
      new CredentialVault({ path: vaultPath(), storage, platform: 'darwin' })
        .backend,
    ).toBe('keychain')
    expect(
      new CredentialVault({ path: vaultPath(), storage, platform: 'win32' })
        .backend,
    ).toBe('dpapi')
  })

  it('records the last fill, not a Settings reveal, and keeps older files readable', () => {
    const path = vaultPath()
    let now = 1_700_000_000_000
    const vault = new CredentialVault({ path, storage, now: () => now })
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      username: 'alice',
      password: 'private',
      revealUsername: false,
    })
    expect(vault.entries()).toEqual([
      expect.objectContaining({
        handleId: handle.handleId,
        revealUsername: false,
      }),
    ])
    expect(vault.entries()[0]).not.toHaveProperty('lastUsedAt')
    expect(vault.entries()[0]).not.toHaveProperty('username')
    now += 1_000
    expect(vault.revealPassword(handle.handleId)).toBe('private')
    expect(vault.entries()[0]).not.toHaveProperty('lastUsedAt')
    now += 1_000
    vault.secret(handle.handleId, 'password', 'https://x.test')
    expect(vault.entries()[0]!.lastUsedAt).toBe(now)
    expect(
      new CredentialVault({ path, storage }).entries()[0]!.lastUsedAt,
    ).toBe(now)
    // The model-facing handle never carries Settings-only fields.
    expect(vault.list()[0]).not.toHaveProperty('lastUsedAt')
    expect(vault.list()[0]).not.toHaveProperty('revealUsername')
    // Clearing a field removes it rather than leaving an empty key.
    vault.save({
      handleId: handle.handleId,
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      username: '',
    })
    expect(vault.list()[0]!.fields).toEqual(['password'])
    expect(vault.entries()[0]!.lastUsedAt).toBe(now)
  })

  it('records the target of each fill beside its time, never a value', () => {
    const path = vaultPath()
    let now = 1_700_000_000_000
    const vault = new CredentialVault({ path, storage, now: () => now })
    const writer = {
      kind: 'app',
      bundleId: 'com.example.Writer',
      teamId: 'EXAMPLE123',
    } as const
    const unsigned = {
      kind: 'app',
      bundleId: 'com.example.Unsigned',
      path: '/Applications/Unsigned.app',
    } as const
    const handle = vault.save({
      label: 'site',
      bindings: [
        { kind: 'origin', origin: 'https://x.test' },
        writer,
        unsigned,
      ],
      password: 'private-value-93',
    })
    vault.secret(handle.handleId, 'password', 'https://x.test')
    expect(vault.entries()[0]).toMatchObject({
      lastUsedAt: now,
      lastUsedTarget: 'https://x.test',
    })
    now += 1_000
    expect(vault.secret(handle.handleId, 'password', writer)).toBe(
      'private-value-93',
    )
    expect(vault.entries()[0]).toMatchObject({
      lastUsedAt: now,
      lastUsedTarget: 'com.example.Writer',
    })
    vault.secret(handle.handleId, 'password', unsigned)
    expect(vault.entries()[0]!.lastUsedTarget).toBe('com.example.Unsigned')
    // An app must match bundle ID, Team ID and path together, as bound.
    for (const target of [
      { ...writer, teamId: 'OTHERTEAM1' },
      { ...unsigned, path: '/tmp/Unsigned.app' },
      { kind: 'app', bundleId: 'com.example.Writer' } as const,
      { ...writer, bundleId: 'com.example.Other' },
    ])
      expect(
        caught(() => vault.secret(handle.handleId, 'password', target)).reason,
      ).toBe('credential-binding-mismatch')
    expect(vault.entries()[0]!.lastUsedTarget).toBe('com.example.Unsigned')
    // Kept across reopen and edits; the record never holds the value.
    const disk = readFileSync(path, 'utf8')
    expect(disk).toContain('"lastUsedTarget":"com.example.Unsigned"')
    expect(disk).not.toContain('private-value-93')
    vault.save({
      handleId: handle.handleId,
      label: 'renamed',
      bindings: [
        { kind: 'origin', origin: 'https://x.test' },
        writer,
        unsigned,
      ],
    })
    expect(
      new CredentialVault({ path, storage }).entries()[0]!.lastUsedTarget,
    ).toBe('com.example.Unsigned')
    // A caller that names no target leaves no stale one beside the new time.
    now += 1_000
    vault.secret(handle.handleId, 'password')
    expect(vault.entries()[0]!.lastUsedAt).toBe(now)
    expect(vault.entries()[0]).not.toHaveProperty('lastUsedTarget')
    expect(vault.list()[0]).not.toHaveProperty('lastUsedTarget')
  })

  it('unlocks by biometrics only after opting in with the right password', () => {
    const path = vaultPath()
    const clock = manualClock(10_000)
    const vault = new CredentialVault({
      path,
      storage,
      now: clock.now,
      timers: clock.timers,
      kdf: CHEAP_KDF,
    })
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private',
    })
    vault.setMasterPassword('correct horse battery')
    expect(vault.biometricUnlock).toBe(false)
    vault.lock()
    expect(caught(() => vault.unlockWithBiometrics()).reason).toBe(
      'biometric-unavailable',
    )
    expect(vault.unlock('wrong password here', { biometric: true })).toBe(false)
    expect(vault.biometricUnlock).toBe(false)
    expect(vault.locked).toBe(true)
    expect(vault.unlock('correct horse battery', { biometric: true })).toBe(
      true,
    )
    expect(vault.biometricUnlock).toBe(true)

    // Only a safeStorage envelope of the key reaches disk.
    const disk = readFileSync(path, 'utf8')
    const stored = JSON.parse(disk) as { master: { biometricKey: string } }
    expect(stored.master.biometricKey).toMatch(/^s:/)
    const key = storage.decryptString(
      Buffer.from(stored.master.biometricKey.slice(2), 'base64'),
    )
    expect(Buffer.from(key, 'base64')).toHaveLength(32)
    expect(disk).not.toContain(key)

    // After a restart the vault is locked until the system check passes.
    const restarted = new CredentialVault({
      path,
      storage,
      now: clock.now,
      timers: clock.timers,
    })
    expect(restarted.locked).toBe(true)
    expect(restarted.biometricUnlock).toBe(true)
    restarted.unlockWithBiometrics()
    expect(restarted.locked).toBe(false)
    expect(restarted.secret(handle.handleId, 'password')).toBe('private')
    // The idle relock still applies to a biometric unlock.
    clock.advance(30 * 60_000)
    expect(restarted.locked).toBe(true)
    expect(() => restarted.secret(handle.handleId, 'password')).toThrow()
  })

  it('drops the biometric key on a new or removed master password, opt-out and a failed unwrap', () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage, kdf: CHEAP_KDF })
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private',
    })
    const onDisk = () =>
      (
        JSON.parse(readFileSync(path, 'utf8')) as {
          master?: { biometricKey?: string }
        }
      ).master
    vault.setMasterPassword('correct horse battery', { biometric: true })
    expect(vault.biometricUnlock).toBe(true)
    // A new password alone does not carry the old key over.
    vault.setMasterPassword('another long passphrase')
    expect(vault.biometricUnlock).toBe(false)
    expect(onDisk()).not.toHaveProperty('biometricKey')
    vault.setMasterPassword('another long passphrase', { biometric: true })
    expect(onDisk()).toHaveProperty('biometricKey')
    vault.lock()
    // Turning it off needs no unlock.
    vault.disableBiometricUnlock()
    expect(vault.biometricUnlock).toBe(false)
    expect(onDisk()).not.toHaveProperty('biometricKey')
    expect(caught(() => vault.unlockWithBiometrics()).reason).toBe(
      'biometric-unavailable',
    )
    expect(vault.unlock('another long passphrase', { biometric: true })).toBe(
      true,
    )
    vault.setMasterPassword(null)
    expect(vault.biometricUnlock).toBe(false)
    expect(onDisk()).toBeUndefined()

    // A key that no longer unwraps to the master key is removed for good.
    vault.setMasterPassword('correct horse battery', { biometric: true })
    vault.lock()
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      master: { biometricKey: string }
    }
    data.master.biometricKey = `s:${storage
      .encryptString(randomBytes(32).toString('base64'))
      .toString('base64')}`
    writeFileSync(path, JSON.stringify(data))
    const stale = new CredentialVault({ path, storage })
    const invalid = caught(() => stale.unlockWithBiometrics())
    expect([invalid.reason, invalid.code]).toEqual([
      'biometric-key-invalid',
      'PERMISSION_REQUIRED',
    ])
    expect(stale.locked).toBe(true)
    expect(stale.biometricUnlock).toBe(false)
    expect(onDisk()).not.toHaveProperty('biometricKey')
    expect(stale.unlock('correct horse battery')).toBe(true)
    expect(stale.secret(handle.handleId, 'password')).toBe('private')

    // So is one safeStorage can no longer decrypt (e.g. a reset keychain).
    stale.unlock('correct horse battery', { biometric: true })
    stale.lock()
    const reset = new CredentialVault({
      path,
      storage: {
        ...storage,
        decryptString: () => {
          throw new Error('keychain reset')
        },
      },
    })
    expect(caught(() => reset.unlockWithBiometrics()).reason).toBe(
      'biometric-key-invalid',
    )
    expect(onDisk()).not.toHaveProperty('biometricKey')
  })

  it('opens vaults without a biometric key and ignores a malformed one', () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage, kdf: CHEAP_KDF })
    vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private',
    })
    vault.setMasterPassword('correct horse battery')
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      master: Record<string, unknown>
    }
    data.master.biometricKey = 42
    writeFileSync(path, JSON.stringify(data))
    const reopened = new CredentialVault({ path, storage })
    expect(reopened.biometricUnlock).toBe(false)
    expect(caught(() => reopened.unlockWithBiometrics()).reason).toBe(
      'biometric-unavailable',
    )
    expect(reopened.unlock('correct horse battery')).toBe(true)
  })
})
