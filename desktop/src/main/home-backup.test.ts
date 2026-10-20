/**
 * REL-03 备份与恢复 in main: the zip (`ditto`), the credential vault only
 * under SEC-09's passphrase (card test 7), and a restore that checks the
 * passphrase before anything changes and then waits for the next start.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadHomeBackupModule } from '@emperor/core/host-capabilities'
import { LocalSecretStore } from './local-secret-store'
import {
  CredentialVault,
  type MasterKdf,
} from './computer-use/credential-vault'
import { HomeBackups, type BackupVault } from './home-backup'

const CHEAP_KDF: MasterKdf = {
  kind: 'scrypt',
  params: { cost: 1024, blockSize: 8, parallelization: 1, keyLength: 32 },
}
const PASSPHRASE = 'backup passphrase 42'
const { applyPendingRestore, pendingRestoreExists } =
  await loadHomeBackupModule()
const SECRET = 'vault-password-rel03-77'

const roots: string[] = []
function temp(prefix = 'emperor-home-backup-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function keyPath(home: string): string {
  return join(home, 'computer-use', 'secrets', 'local.key')
}

function vaultOf(home: string): CredentialVault {
  return new CredentialVault({
    path: join(home, 'computer-use', 'vault.json'),
    storage: new LocalSecretStore({ keyPath: keyPath(home) }),
    kdf: CHEAP_KDF,
  })
}

/** A home with settings, a session file, memory and a vault entry. */
function home(): { home: string; vault: CredentialVault } {
  const root = join(temp(), 'home')
  mkdirSync(join(root, 'memory'), { recursive: true })
  mkdirSync(join(root, 'sessions', 's1'), { recursive: true })
  writeFileSync(join(root, 'settings.json'), '{"version":1,"webui":{}}')
  writeFileSync(join(root, 'memory', 'MEMORY.md'), '# REL03 memory\n')
  writeFileSync(join(root, 'sessions', 's1', 'log.jsonl'), '{"t":"x"}\n')
  const vault = vaultOf(root)
  vault.save({
    label: 'REL03 site',
    bindings: [{ kind: 'origin', origin: 'https://rel03.test' }],
    username: 'alice',
    password: SECRET,
  })
  return { home: root, vault }
}

function backups(root: string, vault: BackupVault | null) {
  return new HomeBackups({
    home: root,
    tempDir: temp('emperor-home-backup-tmp-'),
    appVersion: '0.2.0',
    vault: () => vault,
    now: () => new Date('2026-10-20T10:00:00.000Z'),
  })
}

function zipEntries(zip: string): string[] {
  return execFileSync('/usr/bin/unzip', ['-Z1', zip], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.endsWith('/'))
    .map((line) => line.slice(line.indexOf('/') + 1))
    .sort()
}

function zipText(zip: string): string {
  const out = temp('emperor-home-backup-x-')
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, out])
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : [join(dir, entry.name)],
    )
  return files(out)
    .map((file) => `${relative(out, file)}\n${readFileSync(file, 'latin1')}`)
    .join('\n')
}

describe('HomeBackups.export', () => {
  it('leaves the vault and the local key out without a passphrase (7)', async () => {
    const { home: root, vault } = home()
    const store = backups(root, vault)
    const plan = await store.plan()
    expect(plan.vault).toEqual({ state: 'ready', entries: 1 })
    expect(plan.name).toBe('Emperor 备份 2026-10-20')

    const target = join(temp(), 'out.emperor-backup.zip')
    const done = await store.export({ includeSessions: true }, target)
    expect(done).toMatchObject({
      name: 'out.emperor-backup.zip',
      credentials: false,
    })
    const entries = zipEntries(target)
    expect(entries).toContain('emperor-backup.json')
    expect(entries).toContain('home/settings.json')
    expect(entries).toContain('home/sessions/s1/log.jsonl')
    for (const never of [
      'credentials.emperor-vault',
      'home/computer-use/vault.json',
      'home/computer-use/secrets/local.key',
    ])
      expect(entries).not.toContain(never)
    const text = zipText(target)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('REL03 site')
    expect(text).not.toContain(readFileSync(keyPath(root)).toString('base64'))
  })

  it('takes the vault only sealed under the passphrase', async () => {
    const { home: root, vault } = home()
    const target = join(temp(), 'sealed')
    const done = await backups(root, vault).export(
      {
        includeSessions: false,
        passphrase: PASSPHRASE,
        confirmation: PASSPHRASE,
      },
      target,
    )
    // The extension is added; the file lands where main's dialog said.
    expect(done.path).toBe(`${target}.emperor-backup.zip`)
    expect(done.credentials).toBe(true)
    const entries = zipEntries(done.path)
    expect(entries).toContain('credentials.emperor-vault')
    expect(entries.some((entry) => entry.startsWith('home/sessions/'))).toBe(
      false,
    )
    expect(entries).not.toContain('home/computer-use/vault.json')
    const text = zipText(done.path)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(readFileSync(keyPath(root)).toString('base64'))
    expect(text).not.toContain(readFileSync(keyPath(root)).toString('hex'))
  })

  it('refuses a passphrase typed differently twice and writes nothing', async () => {
    const { home: root, vault } = home()
    const target = join(temp(), 'refused.emperor-backup.zip')
    await expect(
      backups(root, vault).export(
        {
          includeSessions: true,
          passphrase: PASSPHRASE,
          confirmation: 'other passphrase',
        },
        target,
      ),
    ).rejects.toThrow()
    expect(existsSync(target)).toBe(false)
  })
})

describe('HomeBackups restore', () => {
  async function exported(passphrase?: string): Promise<string> {
    const { home: root, vault } = home()
    const target = join(temp(), 'b.emperor-backup.zip')
    await backups(root, vault).export(
      passphrase
        ? { includeSessions: true, passphrase, confirmation: passphrase }
        : { includeSessions: true },
      target,
    )
    return target
  }

  it('opens a zip, checks the passphrase first, then waits for the next start', async () => {
    const zip = await exported(PASSPHRASE)
    const target = join(temp(), 'home')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'settings.json'), '{"version":1,"old":true}')
    const vault = vaultOf(target)
    const store = backups(target, vault)

    const view = await store.open(zip)
    expect(view).toMatchObject({
      createdAt: '2026-10-20T10:00:00.000Z',
      appVersion: '0.2.0',
      credentials: true,
      categories: expect.arrayContaining(['config', 'memory', 'sessions']),
    })

    await expect(
      store.restore(view.id, 'not the passphrase!'),
    ).rejects.toThrow()
    expect(pendingRestoreExists(target)).toBe(false)
    expect(vault.list()).toEqual([])

    await store.restore(view.id, PASSPHRASE)
    expect(pendingRestoreExists(target)).toBe(true)
    // The vault entries come back now, sealed with this home's key.
    expect(
      vaultOf(target)
        .list()
        .map((entry) => entry.label),
    ).toEqual(['REL03 site'])

    const applied = applyPendingRestore({ home: target })
    expect(applied?.status).toBe('applied')
    expect(readFileSync(join(target, 'memory', 'MEMORY.md'), 'utf8')).toBe(
      '# REL03 memory\n',
    )
    expect(
      readFileSync(
        join(target, String(applied?.backup), 'settings.json'),
        'utf8',
      ),
    ).toBe('{"version":1,"old":true}')
  })

  it('restores without the vault when no passphrase is given', async () => {
    const zip = await exported(PASSPHRASE)
    const target = join(temp(), 'home')
    mkdirSync(target, { recursive: true })
    const vault = vaultOf(target)
    const store = backups(target, vault)
    const view = await store.open(zip)
    await store.restore(view.id)
    expect(pendingRestoreExists(target)).toBe(true)
    expect(vault.list()).toEqual([])
  })

  it('names a file that is not an Emperor backup and keeps nothing of it', async () => {
    const target = join(temp(), 'home')
    mkdirSync(target, { recursive: true })
    const notBackup = join(temp(), 'other.zip')
    const folder = join(temp(), 'other')
    mkdirSync(folder)
    writeFileSync(join(folder, 'readme.txt'), 'hello')
    execFileSync('/usr/bin/ditto', [
      '-c',
      '-k',
      '--keepParent',
      folder,
      notBackup,
    ])
    await expect(backups(target, null).open(notBackup)).rejects.toThrow(
      '不是 Emperor 备份',
    )
    const migrations = join(target, 'migrations')
    expect(existsSync(migrations) ? readdirSync(migrations) : []).toEqual([])
  })

  it('discards an opened backup that is not restored', async () => {
    const zip = await exported()
    const target = join(temp(), 'home')
    mkdirSync(target, { recursive: true })
    const store = backups(target, null)
    const view = await store.open(zip)
    expect(readdirSync(join(target, 'migrations')).length).toBe(1)
    store.discard(view.id)
    expect(readdirSync(join(target, 'migrations'))).toEqual([])
    await expect(store.restore(view.id)).rejects.toThrow()
  })
})
