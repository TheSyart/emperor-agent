import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalSecretStore } from '../local-secret-store'
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

/** In-memory stand-in for the local key store (one fixed AES key). */
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'emperor-local',
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
/**
 * Room for tests that derive at the production cost on purpose: a 128 MiB
 * scrypt takes 0.17 s on an idle Mac and up to 8 s on loaded, throttled
 * cores, where the three-derivation test below took 25 s (FIX-17).
 */
const PRODUCTION_KDF_MS = 60_000
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

async function caughtAsync(
  action: () => Promise<unknown>,
): Promise<CredentialVaultError> {
  try {
    await action()
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

/** The real local key store beside `path`, as main wires it. */
function localKey(
  path: string,
  sealedDataExists?: () => boolean,
): LocalSecretStore {
  return new LocalSecretStore({
    keyPath: join(dirname(path), 'secrets', 'local.key'),
    ...(sealedDataExists ? { sealedDataExists } : {}),
  })
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

  it('saves many entries in one write, or none of them (MAIN-7)', () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage })
    const handles = vault.saveMany(
      Array.from({ length: 3 }, (_v, index) => ({
        label: `Site ${index}`,
        bindings: [
          { kind: 'origin' as const, origin: `https://s${index}.test` },
        ],
        username: `user${index}`,
        password: `pw-${index}`,
      })),
    )
    expect(handles).toHaveLength(3)
    const reloaded = new CredentialVault({ path, storage })
    expect(reloaded.secret(handles[2]!.handleId, 'password')).toBe('pw-2')
    const before = readFileSync(path, 'utf8')
    caught(() =>
      vault.saveMany([
        {
          label: 'ok',
          bindings: [{ kind: 'origin', origin: 'https://fine.test' }],
          password: 'x',
        },
        {
          label: '',
          bindings: [{ kind: 'origin', origin: 'https://bad.test' }],
          password: 'y',
        },
      ]),
    )
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(vault.entries()).toHaveLength(3)
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

  it(
    'uses a scrypt master password, locks on restart and after inactivity',
    async () => {
      const path = vaultPath()
      let now = 10_000
      const vault = new CredentialVault({ path, storage, now: () => now })
      const handle = vault.save({
        label: 'site',
        bindings: [{ kind: 'origin', origin: 'https://x.test' }],
        password: 'private',
      })
      await vault.setMasterPassword(
        'correct horse battery',
        'correct horse battery',
      )
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
      expect(await vault.unlock('incorrect')).toBe(false)
      expect(await vault.unlock('correct horse battery')).toBe(true)
      expect(vault.secret(handle.handleId, 'password')).toBe('private')
      now += 30 * 60_000 + 1
      expect(vault.locked).toBe(true)
      expect(new CredentialVault({ path, storage }).locked).toBe(true)
      // Three derivations at the production cost (128 MiB scrypt): 0.5 s on an
      // idle Mac, past 10 s on a loaded runner (FIX-17).
    },
    PRODUCTION_KDF_MS,
  )

  it('refuses to create entries without local encryption', () => {
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
      'l:' + Buffer.from('corrupted').toString('base64')
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

  it('gives every failure a stable reason and code without echoing values', async () => {
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
    expect(
      (await caughtAsync(() => vault.setMasterPassword('short', 'short')))
        .reason,
    ).toBe('master-password-too-short')
    await vault.setMasterPassword(
      'correct horse battery',
      'correct horse battery',
    )
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
      'l:' + Buffer.from('corrupted').toString('base64')
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

  it('drops the master key on an idle timer and extends it on use', async () => {
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
    await vault.setMasterPassword(
      'correct horse battery',
      'correct horse battery',
    )
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
    expect(await vault.unlock('correct horse battery')).toBe(true)
    expect(clock.pending()).toBe(1)
    vault.lock()
    expect(clock.pending()).toBe(0)
    expect(await vault.unlock('correct horse battery')).toBe(true)
    await vault.removeMasterPassword('correct horse battery')
    expect(clock.pending()).toBe(0)
    expect(vault.locked).toBe(false)
  })

  it('stores the KDF cost with the salt and reads it back on unlock', async () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage, kdf: CHEAP_KDF })
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private',
    })
    await vault.setMasterPassword(
      'correct horse battery',
      'correct horse battery',
    )
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      master: { kind: string; params: unknown }
    }
    expect(stored.master.kind).toBe('scrypt')
    expect(stored.master.params).toEqual(CHEAP_KDF.params)
    // A later build with other defaults still opens this vault.
    const reopened = new CredentialVault({ path, storage })
    expect(await reopened.unlock('correct horse battery')).toBe(true)
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
      (
        await caughtAsync(() =>
          new CredentialVault({ path: tampered, storage }).unlock(
            'correct horse battery',
          ),
        )
      ).reason,
    ).toBe('vault-file-invalid')
  })

  it('opens Argon2id vaults written before KDF parameters were stored', async () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage, kdf: LEGACY_ARGON2_KDF })
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private',
    })
    await vault.setMasterPassword(
      'correct horse battery',
      'correct horse battery',
    )
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
    expect(await legacy.unlock('wrong password here')).toBe(false)
    expect(await legacy.unlock('correct horse battery')).toBe(true)
    expect(legacy.secret(handle.handleId, 'password')).toBe('private')
  })

  it(
    'sets a master password where the runtime has no Argon2',
    async () => {
      runtime.argon2 = false
      try {
        const path = vaultPath()
        const vault = new CredentialVault({ path, storage })
        const handle = vault.save({
          label: 'site',
          bindings: [{ kind: 'origin', origin: 'https://x.test' }],
          password: 'private',
        })
        await vault.setMasterPassword(
          'correct horse battery',
          'correct horse battery',
        )
        vault.lock()
        expect(await vault.unlock('correct horse battery')).toBe(true)
        expect(vault.secret(handle.handleId, 'password')).toBe('private')

        // An Argon2id vault written where Argon2 existed cannot open here.
        const older = vaultPath()
        runtime.argon2 = true
        await new CredentialVault({
          path: older,
          storage,
          kdf: LEGACY_ARGON2_KDF,
        }).setMasterPassword('correct horse battery', 'correct horse battery')
        runtime.argon2 = false
        const failure = await caughtAsync(() =>
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
      // The default KDF where Argon2 is missing is the production scrypt.
    },
    PRODUCTION_KDF_MS,
  )

  it('names the local key as its backend on every platform, never the Keychain', () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage: localKey(path) })
    expect(vault.backend).toBe('emperor-local')
    expect(vault.available).toBe(true)
    expect(vault.problem).toBeNull()
    expect(
      new CredentialVault({
        path: vaultPath(),
        storage: { ...storage, getSelectedStorageBackend: undefined },
      }).backend,
    ).toBe('unknown')
  })

  it('writes version 3: l: envelopes under the local key, m: around them with a master password', async () => {
    const path = vaultPath()
    const vault = new CredentialVault({
      path,
      storage: localKey(path),
      kdf: CHEAP_KDF,
    })
    expect(vault.hasSealedData).toBe(false)
    const handle = vault.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      username: 'alice',
      password: 'private-value-26',
    })
    expect(vault.hasSealedData).toBe(true)
    const plain = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      entries: Array<{ fields: Record<string, string> }>
    }
    expect(plain.version).toBe(3)
    for (const value of Object.values(plain.entries[0]!.fields)) {
      expect(value).toMatch(/^l:/)
      // The local store's own versioned envelope sits inside.
      expect(
        Buffer.from(value.slice(2), 'base64').subarray(0, 3).toString(),
      ).toBe('el1')
    }
    expect(existsSync(join(dirname(path), 'secrets', 'local.key'))).toBe(true)
    await vault.setMasterPassword(
      'correct horse battery',
      'correct horse battery',
    )
    const sealed = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      master: Record<string, unknown>
      entries: Array<{ fields: Record<string, string> }>
    }
    expect(sealed.version).toBe(3)
    expect(sealed.master).not.toHaveProperty('biometricKey')
    for (const value of Object.values(sealed.entries[0]!.fields))
      expect(value).toMatch(/^m:/)
    expect(JSON.stringify(sealed)).not.toContain('private-value-26')
    const reopened = new CredentialVault({ path, storage: localKey(path) })
    expect(await reopened.unlock('correct horse battery')).toBe(true)
    expect(reopened.secret(handle.handleId, 'password')).toBe(
      'private-value-26',
    )
  })

  it('clears a version 1 vault sealed by the Keychain and starts over', () => {
    const path = vaultPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        master: {
          kind: 'scrypt',
          salt: 'c2FsdA==',
          verifier: 'dmVyaWZpZXI=',
          params: CHEAP_KDF.params,
          biometricKey: 's:a2V5',
        },
        entries: [
          {
            handleId: 'cred_aaaaaaaaaaaaaaaaaaaaaaaa',
            label: 'Old',
            bindings: [{ kind: 'origin', origin: 'https://old.test' }],
            revealUsername: true,
            fillMode: 'auto',
            fields: { password: 's:b2xk' },
          },
        ],
      }),
    )
    const vault = new CredentialVault({ path, storage: localKey(path) })
    expect(existsSync(path)).toBe(false)
    expect(vault.list()).toEqual([])
    expect(vault.hasMasterPassword).toBe(false)
    expect(vault.locked).toBe(false)
    vault.save({
      label: 'New',
      bindings: [{ kind: 'origin', origin: 'https://new.test' }],
      password: 'fresh',
    })
    expect(
      (JSON.parse(readFileSync(path, 'utf8')) as { version: number }).version,
    ).toBe(3)
    // A format it does not know is kept and left alone (SEC-09).
    const future = vaultPath()
    mkdirSync(dirname(future), { recursive: true })
    writeFileSync(future, JSON.stringify({ version: 4, entries: [] }))
    expect(new CredentialVault({ path: future, storage }).problem).toBe(
      'vault-newer',
    )
    expect(existsSync(future)).toBe(true)
  })

  it('refuses a lost local key and starts over only when reset', () => {
    const path = vaultPath()
    const first = new CredentialVault({ path, storage: localKey(path) })
    const handle = first.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private',
    })
    const key = join(dirname(path), 'secrets', 'local.key')
    rmSync(key)
    let vault: CredentialVault | null = null
    vault = new CredentialVault({
      path,
      storage: localKey(path, () => vault?.hasSealedData ?? true),
    })
    expect(vault.available).toBe(false)
    expect(vault.problem).toBe('key-missing')
    // Entries stay listed (names only) so the user sees what clearing drops.
    expect(vault.list().map((item) => item.label)).toEqual(['site'])
    const missing = caught(() => vault!.secret(handle.handleId, 'password'))
    expect([missing.reason, missing.code]).toEqual([
      'vault-key-missing',
      'CAPABILITY_DISABLED',
    ])
    expect(
      caught(() =>
        vault!.save({
          label: 'new',
          bindings: [{ kind: 'origin', origin: 'https://y.test' }],
          password: 'new',
        }),
      ).reason,
    ).toBe('vault-key-missing')
    // No new key appears behind the user's back.
    expect(existsSync(key)).toBe(false)
    vault.reset()
    expect(existsSync(path)).toBe(false)
    expect(vault.list()).toEqual([])
    expect(vault.problem).toBeNull()
    expect(vault.available).toBe(true)
    const fresh = vault.save({
      label: 'again',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'again',
    })
    expect(existsSync(key)).toBe(true)
    expect(vault.secret(fresh.handleId, 'password')).toBe('again')
  })

  it('resets past a key file that fails its checks, with a new key', async () => {
    const path = vaultPath()
    const first = new CredentialVault({
      path,
      storage: localKey(path),
      kdf: CHEAP_KDF,
    })
    first.save({
      label: 'site',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'private',
    })
    await first.setMasterPassword(
      'correct horse battery',
      'correct horse battery',
    )
    const key = join(dirname(path), 'secrets', 'local.key')
    writeFileSync(key, randomBytes(16))
    const vault = new CredentialVault({ path, storage: localKey(path) })
    expect(vault.problem).toBe('key-invalid')
    expect(vault.available).toBe(false)
    expect(
      (await caughtAsync(() => vault.unlock('correct horse battery'))).reason,
    ).toBe('vault-key-invalid')
    vault.reset()
    expect(vault.hasMasterPassword).toBe(false)
    expect(vault.problem).toBeNull()
    expect(existsSync(key)).toBe(false)
    vault.save({
      label: 'again',
      bindings: [{ kind: 'origin', origin: 'https://x.test' }],
      password: 'again',
    })
    expect(statSync(key).mode & 0o777).toBe(0o600)
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
})
