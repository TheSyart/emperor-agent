/**
 * SEC-09: a damaged or newer vault no longer stops Emperor, the local key
 * survives tightened modes, backups, master password changes that need the
 * current one, entries bound to their bindings, async scrypt with backoff,
 * and the v2 → v3 migration.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { LocalSecretStore } from '../local-secret-store'
import {
  CredentialVault,
  CredentialVaultError,
  type MasterKdf,
} from './credential-vault'

/** In-memory stand-in for the local key store (one fixed AES key). */
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'emperor-local',
  encryptString(value: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv)
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
const MASTER = 'correct horse battery'

function vaultPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), 'emperor-vault-sec09-')),
    'computer-use',
    'vault.json',
  )
}

function keyFile(path: string): string {
  return join(dirname(path), 'secrets', 'local.key')
}

/** The real local key store beside `path`, as main wires it. */
function localKey(
  path: string,
  sealedDataExists?: () => boolean,
): LocalSecretStore {
  return new LocalSecretStore({
    keyPath: keyFile(path),
    ...(sealedDataExists ? { sealedDataExists } : {}),
  })
}

async function reasonOf(action: () => unknown): Promise<string> {
  try {
    await action()
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialVaultError)
    return (error as CredentialVaultError).reason
  }
  throw new Error('expected a vault error')
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function backups(path: string, marker: string): string[] {
  return readdirSync(dirname(path)).filter((name) =>
    name.startsWith(`vault.json.${marker}`),
  )
}

const SITE = {
  label: 'Site',
  bindings: [{ kind: 'origin' as const, origin: 'https://site.test' }],
  username: 'alice',
  password: 'site-password-61',
}
const OTHER = {
  label: 'Other',
  bindings: [{ kind: 'origin' as const, origin: 'https://other.test' }],
  password: 'other-password-62',
}

describe('SEC-09 #1 an unreadable vault.json', () => {
  it('starts degraded, keeps the original, and starts over only after a backup', async () => {
    const path = vaultPath()
    const damaged = '{"version":2,"entries":[{"handleId":'
    write(path, damaged)
    const vault = new CredentialVault({ path, storage: localKey(path) })
    expect(vault.problem).toBe('vault-unreadable')
    expect(vault.available).toBe(false)
    expect(vault.list()).toEqual([])
    // A key that is gone must not be replaced while the file may hold data.
    expect(vault.hasSealedData).toBe(true)
    expect(await reasonOf(() => vault.save(SITE))).toBe('vault-unreadable')
    expect(await reasonOf(() => vault.unlock(MASTER))).toBe('vault-unreadable')
    expect(readFileSync(path, 'utf8')).toBe(damaged)

    const { backup } = vault.startOver()
    expect(backup).toMatch(/^vault\.json\.unreadable-\d+/)
    expect(readFileSync(join(dirname(path), backup!), 'utf8')).toBe(damaged)
    expect(statSync(join(dirname(path), backup!)).mode & 0o777).toBe(0o600)
    expect(vault.problem).toBeNull()
    expect(vault.available).toBe(true)
    const saved = vault.save(SITE)
    expect(vault.secret(saved.handleId, 'password')).toBe(SITE.password)
  })

  it('treats a file it cannot interpret the same way instead of throwing', () => {
    for (const text of [
      '[]',
      'null',
      '{"version":2}',
      '{"version":2,"entries":{}}',
      '{"version":2,"entries":[],"master":{"kind":"bcrypt"}}',
      '{"version":"3","entries":[]}',
      '{"version":3,"entries":[{"label":5}]}',
    ]) {
      const path = vaultPath()
      write(path, text)
      const vault = new CredentialVault({ path, storage })
      expect(vault.problem, text).toBe('vault-unreadable')
      expect(readFileSync(path, 'utf8'), text).toBe(text)
    }
  })
})

describe('SEC-09 #2 a vault written by a newer Emperor', () => {
  it('is read-only: names listed, nothing decrypted or written', async () => {
    const path = vaultPath()
    const newer = JSON.stringify({
      version: 99,
      entries: [
        {
          handleId: 'cred_aaaaaaaaaaaaaaaaaaaaaaaa',
          label: 'Future',
          bindings: [{ kind: 'origin', origin: 'https://future.test' }],
          revealUsername: true,
          fillMode: 'confirm',
          fields: { password: 'x9:opaque', username: 'x9:opaque' },
          futureField: { anything: true },
        },
      ],
      somethingNew: 1,
    })
    write(path, newer)
    const before = statSync(path).mtimeMs
    const vault = new CredentialVault({
      path,
      storage: localKey(path),
      kdf: CHEAP_KDF,
    })
    expect(vault.problem).toBe('vault-newer')
    expect(vault.available).toBe(false)
    expect(vault.list().map((entry) => entry.label)).toEqual(['Future'])
    expect(vault.list()[0]).not.toHaveProperty('username')
    expect(
      await reasonOf(() =>
        vault.secret('cred_aaaaaaaaaaaaaaaaaaaaaaaa', 'password'),
      ),
    ).toBe('vault-newer')
    expect(await reasonOf(() => vault.save(SITE))).toBe('vault-newer')
    expect(
      await reasonOf(() => vault.remove('cred_aaaaaaaaaaaaaaaaaaaaaaaa')),
    ).toBe('vault-newer')
    expect(await reasonOf(() => vault.setMasterPassword(MASTER, MASTER))).toBe(
      'vault-newer',
    )
    expect(await reasonOf(() => vault.exportBackup(MASTER, MASTER))).toBe(
      'vault-newer',
    )
    vault.lock()
    expect(readFileSync(path, 'utf8')).toBe(newer)
    expect(statSync(path).mtimeMs).toBe(before)
    // Reopening by this build changes nothing either.
    new CredentialVault({ path, storage: localKey(path) })
    expect(readFileSync(path, 'utf8')).toBe(newer)

    const { backup } = vault.startOver()
    expect(backup).toMatch(/^vault\.json\.newer-\d+/)
    expect(readFileSync(join(dirname(path), backup!), 'utf8')).toBe(newer)
    expect(vault.problem).toBeNull()
  })
})

describe('SEC-09 #3 the local key under tightened and loosened modes', () => {
  it('works at 0700, asks to repair at 0644, and works again after repair', async () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage: localKey(path) })
    const saved = vault.save(SITE)
    chmodSync(keyFile(path), 0o700)
    chmodSync(dirname(keyFile(path)), 0o700)
    const tightened = new CredentialVault({ path, storage: localKey(path) })
    expect(tightened.problem).toBeNull()
    expect(tightened.secret(saved.handleId, 'password')).toBe(SITE.password)

    chmodSync(keyFile(path), 0o644)
    const loose = new CredentialVault({ path, storage: localKey(path) })
    expect(loose.problem).toBe('key-permissions')
    expect(loose.available).toBe(false)
    expect(await reasonOf(() => loose.secret(saved.handleId, 'password'))).toBe(
      'vault-key-permissions',
    )
    expect(loose.repairKeyPermissions()).toBe(true)
    expect(statSync(keyFile(path)).mode & 0o777).toBe(0o600)
    expect(loose.problem).toBeNull()
    expect(loose.secret(saved.handleId, 'password')).toBe(SITE.password)
    // Nothing to repair: false, and nothing changes.
    expect(loose.repairKeyPermissions()).toBe(false)
  })
})

describe('SEC-09 #4 password-protected backup', () => {
  it('exports the vault and local key, and imports them back identical', async () => {
    let now = 1_700_000_000_000
    const pathA = vaultPath()
    const a = new CredentialVault({
      path: pathA,
      storage: localKey(pathA),
      kdf: CHEAP_KDF,
      now: () => now,
    })
    const site = a.save({
      ...SITE,
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      revealUsername: true,
      fillMode: 'confirm',
    })
    const app = a.save({
      label: 'Writer',
      bindings: [
        { kind: 'app', bundleId: 'com.example.Writer', teamId: 'EXAMPLE123' },
      ],
      password: 'writer-password-63',
      revealUsername: false,
    })
    a.secret(site.handleId, 'password', 'https://site.test')
    await a.setMasterPassword(MASTER, MASTER)

    expect(
      await reasonOf(() =>
        a.exportBackup('backup passphrase 1', 'backup passphrase 2'),
      ),
    ).toBe('passphrase-mismatch')
    expect(await reasonOf(() => a.exportBackup('short', 'short'))).toBe(
      'passphrase-too-short',
    )
    a.lock()
    expect(
      await reasonOf(() =>
        a.exportBackup('backup passphrase 1', 'backup passphrase 1'),
      ),
    ).toBe('vault-locked')
    expect(await a.unlock(MASTER)).toBe(true)
    const file = await a.exportBackup(
      'backup passphrase 1',
      'backup passphrase 1',
    )
    const text = file.toString('utf8')
    expect(JSON.parse(text)).toMatchObject({
      format: 'emperor-vault-backup',
      version: 1,
    })
    for (const leak of [
      'Site',
      'Writer',
      SITE.password,
      'writer-password-63',
      'site.test',
      readFileSync(keyFile(pathA)).toString('hex'),
      readFileSync(keyFile(pathA)).toString('base64'),
    ])
      expect(text).not.toContain(leak)

    // A new Mac: no key yet. The backup's key becomes the local key.
    const pathB = vaultPath()
    const b = new CredentialVault({
      path: pathB,
      storage: localKey(pathB),
      kdf: CHEAP_KDF,
      now: () => now,
    })
    expect(
      await reasonOf(() => b.importBackup(file, 'wrong passphrase 1')),
    ).toBe('backup-passphrase-wrong')
    expect(
      await reasonOf(() =>
        b.importBackup(Buffer.from('not a backup'), 'backup passphrase 1'),
      ),
    ).toBe('backup-invalid')
    expect(await b.importBackup(file, 'backup passphrase 1')).toEqual({
      imported: 2,
    })
    expect(
      readFileSync(keyFile(pathB)).equals(readFileSync(keyFile(pathA))),
    ).toBe(true)
    expect(b.entries()).toEqual(a.entries())
    for (const [handle, field] of [
      [site.handleId, 'username'],
      [site.handleId, 'password'],
      [site.handleId, 'totp'],
      [app.handleId, 'password'],
    ] as const)
      expect(b.secret(handle, field)).toBe(a.secret(handle, field))
    now += 1

    // A Mac with its own key and entry: entries merge, its key stays.
    const pathC = vaultPath()
    const c = new CredentialVault({
      path: pathC,
      storage: localKey(pathC),
      kdf: CHEAP_KDF,
    })
    const own = c.save(OTHER)
    const keyC = readFileSync(keyFile(pathC))
    expect(await c.importBackup(file, 'backup passphrase 1')).toEqual({
      imported: 2,
    })
    expect(readFileSync(keyFile(pathC)).equals(keyC)).toBe(true)
    expect(c.list().map((entry) => entry.label)).toEqual([
      'Other',
      'Site',
      'Writer',
    ])
    expect(c.secret(own.handleId, 'password')).toBe(OTHER.password)
    expect(c.secret(app.handleId, 'password')).toBe('writer-password-63')
    // The vault before the import is kept beside it.
    expect(backups(pathC, 'before-import-')).toHaveLength(1)
  })

  it('restores an unreadable vault from a backup, keeping the damaged file', async () => {
    const pathA = vaultPath()
    const a = new CredentialVault({
      path: pathA,
      storage: localKey(pathA),
      kdf: CHEAP_KDF,
    })
    const saved = a.save(SITE)
    const file = await a.exportBackup(
      'backup passphrase 1',
      'backup passphrase 1',
    )
    write(pathA, 'not json')
    const damaged = new CredentialVault({
      path: pathA,
      storage: localKey(pathA),
      kdf: CHEAP_KDF,
    })
    expect(damaged.problem).toBe('vault-unreadable')
    expect(await damaged.importBackup(file, 'backup passphrase 1')).toEqual({
      imported: 1,
    })
    expect(damaged.problem).toBeNull()
    expect(damaged.secret(saved.handleId, 'password')).toBe(SITE.password)
    const kept = backups(pathA, 'unreadable-')
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dirname(pathA), kept[0]!), 'utf8')).toBe(
      'not json',
    )
  })
})

describe('SEC-09 #4 import into a vault that cannot take it', () => {
  it('names the key problem and moves nothing while the key is open to others', async () => {
    const pathA = vaultPath()
    const a = new CredentialVault({
      path: pathA,
      storage: localKey(pathA),
      kdf: CHEAP_KDF,
    })
    a.save(SITE)
    const file = await a.exportBackup(
      'backup passphrase 1',
      'backup passphrase 1',
    )
    const pathB = vaultPath()
    new CredentialVault({ path: pathB, storage: localKey(pathB) }).save(OTHER)
    write(pathB, 'damaged')
    chmodSync(keyFile(pathB), 0o644)
    const b = new CredentialVault({
      path: pathB,
      storage: localKey(pathB),
      kdf: CHEAP_KDF,
    })
    expect(b.problem).toBe('vault-unreadable')
    expect(
      await reasonOf(() => b.importBackup(file, 'backup passphrase 1')),
    ).toBe('vault-key-permissions')
    expect(readFileSync(pathB, 'utf8')).toBe('damaged')
    expect(backups(pathB, 'unreadable-')).toEqual([])
    expect(statSync(keyFile(pathB)).mode & 0o777).toBe(0o644)
  })
})

describe('SEC-09 #5 #6 master password changes', () => {
  it('cannot remove or change the master password without the current one', async () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage, kdf: CHEAP_KDF })
    const saved = vault.save(SITE)
    await vault.setMasterPassword(MASTER, MASTER)
    expect(vault.locked).toBe(false)
    for (const current of ['', 'wrong password!'])
      expect(await reasonOf(() => vault.removeMasterPassword(current))).toBe(
        'master-password-wrong',
      )
    expect(vault.hasMasterPassword).toBe(true)
    expect(
      await reasonOf(() =>
        vault.changeMasterPassword(
          'wrong password!',
          'another passphrase',
          'another passphrase',
        ),
      ),
    ).toBe('master-password-wrong')
    expect(
      (JSON.parse(readFileSync(path, 'utf8')) as { master?: unknown }).master,
    ).toBeDefined()
    // Setting over an existing one is a change, which needs the current one.
    expect(
      await reasonOf(() =>
        vault.setMasterPassword('another passphrase', 'another passphrase'),
      ),
    ).toBe('master-password-wrong')
    await vault.changeMasterPassword(
      MASTER,
      'another passphrase',
      'another passphrase',
    )
    vault.lock()
    expect(await vault.unlock(MASTER)).toBe(false)
    expect(await vault.unlock('another passphrase')).toBe(true)
    await vault.removeMasterPassword('another passphrase')
    expect(vault.hasMasterPassword).toBe(false)
    expect(vault.secret(saved.handleId, 'password')).toBe(SITE.password)
  })

  it('refuses a new master password typed differently twice', async () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage, kdf: CHEAP_KDF })
    vault.save(SITE)
    expect(
      await reasonOf(() =>
        vault.setMasterPassword(MASTER, 'correct horse batterY'),
      ),
    ).toBe('master-password-mismatch')
    expect(vault.hasMasterPassword).toBe(false)
    expect(
      (JSON.parse(readFileSync(path, 'utf8')) as { master?: unknown }).master,
    ).toBeUndefined()
    await vault.setMasterPassword(MASTER, MASTER)
    expect(
      await reasonOf(() =>
        vault.changeMasterPassword(
          MASTER,
          'new passphrase 1',
          'new passphrase 2',
        ),
      ),
    ).toBe('master-password-mismatch')
    vault.lock()
    expect(await vault.unlock(MASTER)).toBe(true)
  })
})

describe('SEC-09 #7 entries bound to their bindings', () => {
  it('fails only the entry whose bindings were changed on disk', async () => {
    for (const master of [false, true]) {
      const path = vaultPath()
      const vault = new CredentialVault({
        path,
        storage: localKey(path),
        kdf: CHEAP_KDF,
      })
      const site = vault.save(SITE)
      const other = vault.save(OTHER)
      if (master) await vault.setMasterPassword(MASTER, MASTER)
      const data = JSON.parse(readFileSync(path, 'utf8')) as {
        version: number
        entries: Array<{
          bindings: Array<{ origin: string }>
          fillMode: string
        }>
      }
      expect(data.version).toBe(3)
      data.entries[0]!.bindings[0]!.origin = 'https://evil.test'
      writeFileSync(path, JSON.stringify(data))
      const reopened = new CredentialVault({
        path,
        storage: localKey(path),
        kdf: CHEAP_KDF,
      })
      if (master) expect(await reopened.unlock(MASTER)).toBe(true)
      expect(
        await reasonOf(() =>
          reopened.secret(site.handleId, 'password', 'https://evil.test'),
        ),
        `master ${master}`,
      ).toBe('credential-unreadable')
      expect(reopened.list()[0]).not.toHaveProperty('username')
      expect(reopened.secret(other.handleId, 'password')).toBe(OTHER.password)

      // A changed fill mode is tampering too.
      data.entries[0]!.bindings[0]!.origin = 'https://site.test'
      expect(data.entries[1]!.fillMode).toBe('auto')
      data.entries[1]!.fillMode = 'confirm'
      writeFileSync(path, JSON.stringify(data))
      const again = new CredentialVault({
        path,
        storage: localKey(path),
        kdf: CHEAP_KDF,
      })
      if (master) expect(await again.unlock(MASTER)).toBe(true)
      expect(again.secret(site.handleId, 'password')).toBe(SITE.password)
      expect(
        await reasonOf(() => again.secret(other.handleId, 'password')),
      ).toBe('credential-unreadable')
    }
  })

  it('re-seals kept fields when an edit changes the bindings or fill mode', () => {
    const path = vaultPath()
    const vault = new CredentialVault({ path, storage: localKey(path) })
    const saved = vault.save(SITE)
    vault.save({
      handleId: saved.handleId,
      label: 'Site',
      bindings: [
        { kind: 'origin', origin: 'https://site.test' },
        { kind: 'origin', origin: 'https://login.site.test' },
      ],
      fillMode: 'auto',
    })
    const reopened = new CredentialVault({ path, storage: localKey(path) })
    expect(
      reopened.secret(saved.handleId, 'password', 'https://login.site.test'),
    ).toBe(SITE.password)
    expect(reopened.list()[0]!.username).toBe('alice')
  })
})

describe('SEC-09 #9 scrypt off the main thread, with backoff', () => {
  it('keeps the event loop responsive while deriving the master key', async () => {
    const path = vaultPath()
    // The production cost: 128 MiB scrypt.
    const vault = new CredentialVault({ path, storage })
    vault.save(SITE)
    const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 40))
    const histogram = monitorEventLoopDelay({ resolution: 10 })
    histogram.enable()
    // Ticks before and after let the sampling timer see any blocked span.
    await tick()
    const started = performance.now()
    await vault.setMasterPassword(MASTER, MASTER)
    vault.lock()
    const unlocked = await vault.unlock(MASTER)
    const derived = performance.now() - started
    await tick()
    histogram.disable()
    expect(unlocked).toBe(true)
    // Two real derivations took a while, but never held the loop. On the
    // main thread one derivation would hold it for half of `derived`; the
    // spikes a busy machine adds while it schedules other work stay far
    // below that, but past a fixed 50 ms (FIX-17: 52–56 ms under load, with
    // the derivations taking 9 s instead of 0.3 s).
    expect(derived).toBeGreaterThan(50)
    expect(histogram.max / 1e6).toBeLessThan(Math.max(50, derived / 4))
  }, 30_000)

  it('backs off exponentially after five wrong passwords, up to five minutes', async () => {
    let now = 1_000_000
    const path = vaultPath()
    const vault = new CredentialVault({
      path,
      storage,
      kdf: CHEAP_KDF,
      now: () => now,
    })
    vault.save(SITE)
    await vault.setMasterPassword(MASTER, MASTER)
    vault.lock()
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(await vault.unlock(`wrong password ${attempt}`)).toBe(false)
    // Even the right password waits.
    expect(await reasonOf(() => vault.unlock(MASTER))).toBe('vault-backoff')
    expect(vault.retryAfterMs).toBeGreaterThan(0)
    const waits: number[] = []
    for (let attempt = 0; attempt < 8; attempt += 1) {
      waits.push(vault.retryAfterMs)
      now += vault.retryAfterMs
      expect(await vault.unlock('still wrong')).toBe(false)
    }
    for (let index = 1; index < waits.length; index += 1)
      expect(waits[index]).toBeGreaterThanOrEqual(waits[index - 1]!)
    expect(waits[1]).toBe(waits[0]! * 2)
    expect(Math.max(...waits, vault.retryAfterMs)).toBe(5 * 60_000)
    // Checking the current password counts too.
    expect(await reasonOf(() => vault.removeMasterPassword(MASTER))).toBe(
      'vault-backoff',
    )
    now += vault.retryAfterMs
    expect(await vault.unlock(MASTER)).toBe(true)
    expect(vault.retryAfterMs).toBe(0)
  })
})

/** A version 2 field: the local envelope with no context, maybe master-sealed. */
function v2Field(store: LocalSecretStore, value: string, master?: Buffer) {
  const local = store.encryptString(value)
  if (!master) return `l:${local.toString('base64')}`
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', master, nonce)
  return `m:${Buffer.concat([nonce, cipher.update(local), cipher.final(), cipher.getAuthTag()]).toString('base64')}`
}

function writeV2(path: string, master?: string): string {
  const store = localKey(path)
  const salt = randomBytes(16)
  const key = master
    ? scryptSync(master, salt, 32, {
        cost: 1024,
        blockSize: 8,
        parallelization: 1,
      })
    : undefined
  const verifier = () => {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key!, nonce)
    return Buffer.concat([
      nonce,
      cipher.update('emperor-vault-master-v1'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64')
  }
  const text = JSON.stringify({
    version: 2,
    ...(key
      ? {
          master: {
            kind: 'scrypt',
            salt: salt.toString('base64'),
            verifier: verifier(),
            params: CHEAP_KDF.params,
          },
        }
      : {}),
    entries: [
      {
        handleId: 'cred_aaaaaaaaaaaaaaaaaaaaaaaa',
        label: 'Site',
        bindings: [{ kind: 'origin', origin: 'https://site.test' }],
        revealUsername: true,
        fillMode: 'confirm',
        fields: {
          username: v2Field(store, 'alice', key),
          password: v2Field(store, SITE.password, key),
        },
        lastUsedAt: 1_700_000_000_000,
      },
      {
        handleId: 'cred_bbbbbbbbbbbbbbbbbbbbbbbb',
        label: 'Writer',
        bindings: [
          { kind: 'app', bundleId: 'com.example.Writer', teamId: 'EXAMPLE123' },
        ],
        revealUsername: false,
        fillMode: 'auto',
        fields: { password: v2Field(store, 'writer-password-63', key) },
      },
    ],
  })
  write(path, text)
  return text
}

describe('SEC-09 #10 the v2 → v3 migration', () => {
  it('re-seals every entry with its bindings and keeps a backup', () => {
    const path = vaultPath()
    const original = writeV2(path)
    const vault = new CredentialVault({ path, storage: localKey(path) })
    const disk = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      entries: Array<{ fields: Record<string, string>; lastUsedAt?: number }>
    }
    expect(disk.version).toBe(3)
    const kept = backups(path, 'v2-backup-')
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dirname(path), kept[0]!), 'utf8')).toBe(original)
    expect(statSync(join(dirname(path), kept[0]!)).mode & 0o777).toBe(0o600)
    expect(disk.entries[0]!.lastUsedAt).toBe(1_700_000_000_000)
    expect(vault.list()[0]!.username).toBe('alice')
    expect(vault.secret('cred_aaaaaaaaaaaaaaaaaaaaaaaa', 'password')).toBe(
      SITE.password,
    )
    expect(vault.secret('cred_bbbbbbbbbbbbbbbbbbbbbbbb', 'password')).toBe(
      'writer-password-63',
    )
    // The new envelopes open only with their entry's context.
    const store = localKey(path)
    expect(() =>
      store.decryptString(
        Buffer.from(disk.entries[0]!.fields.password!.slice(2), 'base64'),
      ),
    ).toThrow()
    // Reopening migrates nothing twice.
    new CredentialVault({ path, storage: localKey(path) })
    expect(backups(path, 'v2-backup-')).toHaveLength(1)
  })

  it('migrates a master-password vault at its first unlock', async () => {
    const path = vaultPath()
    const original = writeV2(path, MASTER)
    const vault = new CredentialVault({
      path,
      storage: localKey(path),
      kdf: CHEAP_KDF,
    })
    expect(vault.locked).toBe(true)
    // Locked: nothing can be re-sealed yet, so nothing is touched.
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(vault.list().map((entry) => entry.label)).toEqual(['Site', 'Writer'])
    expect(await vault.unlock(MASTER)).toBe(true)
    expect(
      (JSON.parse(readFileSync(path, 'utf8')) as { version: number }).version,
    ).toBe(3)
    expect(backups(path, 'v2-backup-')).toHaveLength(1)
    expect(vault.secret('cred_aaaaaaaaaaaaaaaaaaaaaaaa', 'username')).toBe(
      'alice',
    )
    vault.lock()
    const reopened = new CredentialVault({
      path,
      storage: localKey(path),
      kdf: CHEAP_KDF,
    })
    expect(await reopened.unlock(MASTER)).toBe(true)
    expect(reopened.secret('cred_bbbbbbbbbbbbbbbbbbbbbbbb', 'password')).toBe(
      'writer-password-63',
    )
    expect(existsSync(path)).toBe(true)
  })
})
