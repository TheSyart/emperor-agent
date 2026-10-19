import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LocalSecretError,
  LocalSecretStore,
  openWithKey,
  sealWithKey,
} from './local-secret-store'

/**
 * Lets a test publish a rival key just before this process links its own,
 * and records what each fsync was for (a file or a directory) in order with
 * the link calls.
 */
const race = vi.hoisted(() => ({
  beforeLink: null as null | ((target: string) => void),
  trace: [] as string[],
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    linkSync(existing: string, target: string): void {
      race.beforeLink?.(target)
      actual.linkSync(existing, target)
      race.trace.push('link')
    },
    fsyncSync(fd: number): void {
      actual.fsyncSync(fd)
      race.trace.push(
        actual.fstatSync(fd).isDirectory() ? 'fsync-dir' : 'fsync-file',
      )
    },
  }
})

afterEach(() => {
  race.beforeLink = null
  race.trace = []
})

function keyPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), 'emperor-local-secret-')),
    'computer-use',
    'secrets',
    'local.key',
  )
}

function reason(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(LocalSecretError)
    return (error as LocalSecretError).reason
  }
  throw new Error('expected a local secret error')
}

/** A valid key file someone else wrote: 32 bytes, 0600, in a 0700 dir. */
function plantKey(path: string, key = randomBytes(32)): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  chmodSync(dirname(path), 0o700)
  writeFileSync(path, key, { mode: 0o600 })
  chmodSync(path, 0o600)
  return key
}

describe('LocalSecretStore', () => {
  it('seals with a versioned AES-256-GCM envelope under a new private key', () => {
    const path = keyPath()
    const store = new LocalSecretStore({ keyPath: path })
    expect(store.getSelectedStorageBackend()).toBe('emperor-local')
    expect(store.isEncryptionAvailable()).toBe(true)
    expect(store.problem()).toBeNull()
    // Nothing is made until a secret is sealed.
    expect(existsSync(path)).toBe(false)
    const sealed = store.encryptString('not-in-cleartext-31')
    expect(sealed.subarray(0, 3).toString('ascii')).toBe('el1')
    expect(sealed.length).toBe(3 + 12 + 'not-in-cleartext-31'.length + 16)
    expect(sealed.includes(Buffer.from('not-in-cleartext-31'))).toBe(false)
    expect(store.decryptString(sealed)).toBe('not-in-cleartext-31')
    // Fresh nonce every time.
    expect(store.encryptString('x').equals(store.encryptString('x'))).toBe(
      false,
    )
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(path).size).toBe(32)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    // No staging file is left beside the key.
    expect(readdirSync(dirname(path))).toEqual(['local.key'])
    // Another process (another store) reads the same key back.
    expect(new LocalSecretStore({ keyPath: path }).decryptString(sealed)).toBe(
      'not-in-cleartext-31',
    )
  })

  it('binds a value to its context as associated data (SEC-06)', () => {
    const store = new LocalSecretStore({ keyPath: keyPath() })
    const sealed = store.encryptString('api-key', 'model_config.json#a')
    expect(store.decryptString(sealed, 'model_config.json#a')).toBe('api-key')
    expect(
      reason(() => store.decryptString(sealed, 'model_config.json#b')),
    ).toBe('ciphertext-invalid')
    expect(reason(() => store.decryptString(sealed))).toBe('ciphertext-invalid')
    // Without a context the envelope is exactly what it always was.
    const plain = store.encryptString('vault-field')
    expect(reason(() => store.decryptString(plain, 'ctx'))).toBe(
      'ciphertext-invalid',
    )
    expect(store.decryptString(plain)).toBe('vault-field')
  })

  it('never replaces a key another process published first (O_EXCL + link)', () => {
    const path = keyPath()
    const rival = randomBytes(32)
    race.beforeLink = (target) => {
      race.beforeLink = null
      plantKey(target, rival)
    }
    const store = new LocalSecretStore({ keyPath: path })
    const sealed = store.encryptString('after the race')
    expect(readFileSync(path).equals(rival)).toBe(true)
    expect(readdirSync(dirname(path))).toEqual(['local.key'])
    expect(new LocalSecretStore({ keyPath: path }).decryptString(sealed)).toBe(
      'after the race',
    )
    // A later store keeps using it as well.
    expect(
      new LocalSecretStore({ keyPath: path }).decryptString(
        new LocalSecretStore({ keyPath: path }).encryptString('again'),
      ),
    ).toBe('again')
    expect(readFileSync(path).equals(rival)).toBe(true)
  })

  it('refuses a missing key while data sealed under it remains, and makes none', () => {
    const path = keyPath()
    const sealed = new LocalSecretStore({ keyPath: path }).encryptString('kept')
    // The key goes away; the data that needs it stays.
    rmSync(path)
    const store = new LocalSecretStore({
      keyPath: path,
      sealedDataExists: () => true,
    })
    expect(store.isEncryptionAvailable()).toBe(false)
    expect(store.problem()).toBe('key-missing')
    expect(reason(() => store.encryptString('new'))).toBe('key-missing')
    expect(reason(() => store.decryptString(sealed))).toBe('key-missing')
    expect(existsSync(path)).toBe(false)
    // Without such data a missing key is simply not made yet.
    const fresh = new LocalSecretStore({
      keyPath: path,
      sealedDataExists: () => false,
    })
    expect(fresh.problem()).toBeNull()
    expect(fresh.isEncryptionAvailable()).toBe(true)
    expect(reason(() => fresh.decryptString(sealed))).toBe('key-missing')
    expect(existsSync(path)).toBe(false)
    // A guard that cannot answer counts as data present.
    const unsure = new LocalSecretStore({
      keyPath: path,
      sealedDataExists: () => {
        throw new Error('vault unreadable')
      },
    })
    expect(unsure.problem()).toBe('key-missing')
    expect(reason(() => unsure.encryptString('new'))).toBe('key-missing')
    expect(existsSync(path)).toBe(false)
  })

  it('checks the key like the pairing store: no symlink, owner, private modes, 32 bytes', () => {
    const cases: Array<[string, (path: string) => void]> = [
      [
        'symlinked key',
        (path) => {
          const real = join(dirname(dirname(path)), 'elsewhere.key')
          plantKey(real)
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
          chmodSync(dirname(path), 0o700)
          symlinkSync(real, path)
        },
      ],
      [
        'short key',
        (path) => {
          plantKey(path, randomBytes(16))
        },
      ],
      [
        'symlinked directory',
        (path) => {
          const real = join(dirname(dirname(path)), 'real-secrets')
          plantKey(join(real, 'local.key'))
          symlinkSync(real, dirname(path))
        },
      ],
      [
        'a directory where the key belongs',
        (path) => {
          mkdirSync(path, { recursive: true, mode: 0o700 })
          chmodSync(dirname(path), 0o700)
        },
      ],
    ]
    for (const [name, plant] of cases) {
      const path = keyPath()
      plant(path)
      const before = existsSync(path) ? statSync(path).mtimeMs : null
      const store = new LocalSecretStore({ keyPath: path })
      expect(store.problem(), name).toBe('key-invalid')
      expect(store.isEncryptionAvailable(), name).toBe(false)
      expect(
        reason(() => store.encryptString('x')),
        name,
      ).toBe('key-invalid')
      expect(
        reason(() => store.decryptString(Buffer.from('el1'))),
        name,
      ).toBe('key-invalid')
      // Never repaired or replaced on its own.
      expect(existsSync(path) ? statSync(path).mtimeMs : null, name).toBe(
        before,
      )
    }
    // Owned by someone else (simulated: this store expects another uid).
    const path = keyPath()
    plantKey(path)
    expect(
      new LocalSecretStore({ keyPath: path, uid: 4_000_000 }).problem(),
    ).toBe('key-invalid')
  })

  it('rejects envelopes it did not seal, without echoing them', () => {
    const path = keyPath()
    const store = new LocalSecretStore({ keyPath: path })
    const sealed = store.encryptString('private-value-58')
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1]! ^= 1
    const reprefixed = Buffer.concat([Buffer.from('el2'), sealed.subarray(3)])
    const other = new LocalSecretStore({ keyPath: keyPath() }).encryptString(
      'private-value-58',
    )
    for (const data of [
      tampered,
      reprefixed,
      other,
      Buffer.from('el1'),
      Buffer.alloc(0),
    ]) {
      let message = ''
      try {
        store.decryptString(data)
      } catch (error) {
        expect(error).toBeInstanceOf(LocalSecretError)
        expect((error as LocalSecretError).reason).toBe('ciphertext-invalid')
        message = (error as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('private-value-58')
    }
  })

  it('discards an unusable key only when told, so a new one can be made', () => {
    const path = keyPath()
    plantKey(path, randomBytes(16))
    const store = new LocalSecretStore({ keyPath: path })
    expect(store.problem()).toBe('key-invalid')
    store.discardKey()
    expect(existsSync(dirname(path))).toBe(false)
    expect(store.problem()).toBeNull()
    expect(store.decryptString(store.encryptString('fresh'))).toBe('fresh')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // A symlinked secrets directory is unlinked, never followed.
    const linked = keyPath()
    const target = join(dirname(dirname(linked)), 'outside')
    plantKey(join(target, 'local.key'))
    symlinkSync(target, dirname(linked))
    new LocalSecretStore({ keyPath: linked }).discardKey()
    expect(existsSync(dirname(linked))).toBe(false)
    expect(existsSync(join(target, 'local.key'))).toBe(true)
  })

  // SEC-09 test 3: a user who tightens the modes (chmod -R 700) keeps a
  // working key; a key opened up to group or others is reported as such and
  // repaired on request, never on its own.
  it('accepts any owner-only mode and repairs a key opened to others on request (SEC-09 #3)', () => {
    const path = keyPath()
    const store = new LocalSecretStore({ keyPath: path })
    const sealed = store.encryptString('kept-31')
    chmodSync(path, 0o700)
    chmodSync(dirname(path), 0o700)
    expect(store.problem()).toBeNull()
    expect(store.decryptString(sealed)).toBe('kept-31')
    chmodSync(path, 0o400)
    expect(store.problem()).toBeNull()
    expect(store.decryptString(sealed)).toBe('kept-31')

    for (const [name, loosen] of [
      ['file 0644', () => chmodSync(path, 0o644)],
      ['directory 0755', () => chmodSync(dirname(path), 0o755)],
      ['file 0640', () => chmodSync(path, 0o640)],
    ] as const) {
      chmodSync(path, 0o600)
      chmodSync(dirname(path), 0o700)
      loosen()
      expect(store.problem(), name).toBe('key-permissions')
      expect(store.isEncryptionAvailable(), name).toBe(false)
      expect(
        reason(() => store.decryptString(sealed)),
        name,
      ).toBe('key-permissions')
      expect(
        reason(() => store.encryptString('x')),
        name,
      ).toBe('key-permissions')
      // Not repaired behind the user's back.
      expect(store.problem(), name).toBe('key-permissions')
      expect(store.repairPermissions(), name).toBe(true)
      expect(statSync(path).mode & 0o777, name).toBe(0o600)
      expect(statSync(dirname(path)).mode & 0o777, name).toBe(0o700)
      expect(store.problem(), name).toBeNull()
      expect(store.decryptString(sealed), name).toBe('kept-31')
    }

    // Repair fixes modes only: a short, symlinked or foreign key stays invalid.
    const short = keyPath()
    plantKey(short, randomBytes(16))
    chmodSync(short, 0o644)
    const shortStore = new LocalSecretStore({ keyPath: short })
    expect(shortStore.problem()).toBe('key-invalid')
    expect(shortStore.repairPermissions()).toBe(false)
    expect(statSync(short).mode & 0o777).toBe(0o644)
    const foreign = keyPath()
    plantKey(foreign)
    chmodSync(foreign, 0o644)
    const foreignStore = new LocalSecretStore({
      keyPath: foreign,
      uid: 4_000_000,
    })
    expect(foreignStore.problem()).toBe('key-invalid')
    expect(foreignStore.repairPermissions()).toBe(false)
    expect(statSync(foreign).mode & 0o777).toBe(0o644)
  })

  it('syncs the directory after publishing a new key with link(2) (SEC-09 #3)', () => {
    const path = keyPath()
    new LocalSecretStore({ keyPath: path }).encryptString('first')
    const link = race.trace.indexOf('link')
    expect(link).toBeGreaterThan(0)
    expect(race.trace.slice(0, link)).toContain('fsync-file')
    expect(race.trace.slice(link)).toContain('fsync-dir')
  })

  it('installs a restored key only where none exists, and reads its own key back', () => {
    const path = keyPath()
    const restored = randomBytes(32)
    const store = new LocalSecretStore({ keyPath: path })
    expect(store.installKey(restored)).toBe(true)
    expect(readFileSync(path).equals(restored)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(store.exportKey().equals(restored)).toBe(true)
    // A key already in place is never replaced.
    expect(store.installKey(randomBytes(32))).toBe(false)
    expect(readFileSync(path).equals(restored)).toBe(true)
    // Sealing with a key in memory matches the store's own envelope.
    const sealed = sealWithKey(restored, 'value-44', 'ctx')
    expect(store.decryptString(sealed, 'ctx')).toBe('value-44')
    expect(openWithKey(restored, store.encryptString('v', 'c'), 'c')).toBe('v')
    expect(() => openWithKey(randomBytes(32), sealed, 'ctx')).toThrow(
      LocalSecretError,
    )
  })
})
