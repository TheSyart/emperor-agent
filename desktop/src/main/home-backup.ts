/**
 * 备份与恢复 in main (REL-03). Loaded on demand (`home-backup-ipc.ts`).
 *
 * - `plan()`: what a backup would hold now, by category, and whether the
 *   密码管理器 can go in (it needs entries and an unlocked vault).
 * - `export(input, target)`: the vault only with a passphrase — SEC-09's
 *   `exportBackup` (entries and the local key under AES-256-GCM, scrypt
 *   from the passphrase) — then Core copies the backup scope into a
 *   private temp folder (plain model and MCP secrets sealed with the local
 *   key in the copy) and `ditto` zips it to `target` (`.partial`, 0600,
 *   rename). The temp folder is removed.
 * - `open(zip)`: `ditto` unzips it into `<home>/migrations/.restore-<id>`
 *   (the same disk as the home, so scheduling is a rename) and Core checks
 *   every path; anything else is removed and named.
 * - `restore(id, passphrase?)`: with a passphrase the vault is imported
 *   first (SEC-09: every field opens before anything changes; a wrong
 *   passphrase changes nothing), then Core schedules the restore. Main
 *   restarts; the next start applies it before the home is opened.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
// Core's backup code comes through loadHomeBackupModule(): a chunk of its
// own, never part of the main bundle.
import {
  compareAppVersions,
  loadHomeBackupModule,
  type HomeBackupManifest,
  type SecretSealer,
} from '@emperor/core/host-capabilities'
import type {
  HomeBackupExportInput,
  HomeBackupPlan,
  HomeBackupView,
} from '../shared/ipc-contract'

/** The part of the credential vault a backup uses. */
export interface BackupVault {
  readonly problem: string | null
  readonly locked: boolean
  list(): unknown[]
  exportBackup(passphrase: string, confirmation: string): Promise<Buffer>
  importBackup(data: Buffer, passphrase: string): Promise<unknown>
}

export const RESTORE_ID = /^r_[0-9a-f]{12}$/

const NOT_A_BACKUP = '这个文件不是 Emperor 备份，或已经损坏。'
const BACKUP_CREDENTIALS = 'credentials.emperor-vault'
const BACKUP_EXTENSION = '.emperor-backup.zip'
const BACKUP_MANIFEST = 'emperor-backup.json'

/** A message for the user, in the same shape as Core's. */
class HomeBackupError extends Error {
  readonly code = 'home_backup_invalid'
}

interface Opened {
  dir: string
  folder: string
  manifest: HomeBackupManifest
  timer: ReturnType<typeof setTimeout>
}

function ditto(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', args, { timeout: 10 * 60_000 }, (error) =>
      error ? reject(error) : resolve(),
    )
  })
}

function day(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

export class HomeBackups {
  private readonly opened = new Map<string, Opened>()
  private readonly now: () => Date
  private readonly zip: (folder: string, target: string) => Promise<void>
  private readonly unzip: (zip: string, into: string) => Promise<void>

  constructor(
    private readonly options: {
      home: string
      /** Private temp folder parent for staging an export. */
      tempDir: string
      appVersion: string
      vault: () => BackupVault | null
      sealer?: () => SecretSealer | null
      now?: () => Date
      zip?: (folder: string, target: string) => Promise<void>
      unzip?: (zip: string, into: string) => Promise<void>
      ttlMs?: number
    },
  ) {
    this.now = options.now ?? (() => new Date())
    this.zip =
      options.zip ??
      ((folder, target) =>
        ditto([
          '-c',
          '-k',
          '--norsrc',
          '--noextattr',
          '--noqtn',
          '--noacl',
          '--keepParent',
          folder,
          target,
        ]))
    this.unzip =
      options.unzip ??
      ((zip, into) =>
        ditto(['-x', '-k', '--norsrc', '--noextattr', '--noqtn', zip, into]))
    // Backups opened by an earlier run and never restored.
    const migrations = path.join(options.home, 'migrations')
    for (const name of fs.existsSync(migrations)
      ? fs.readdirSync(migrations)
      : [])
      if (name.startsWith('.restore-'))
        fs.rmSync(path.join(migrations, name), { recursive: true, force: true })
  }

  async plan(): Promise<HomeBackupPlan> {
    const plan = (await loadHomeBackupModule()).planHomeBackup(
      this.options.home,
    )
    return {
      name: `Emperor 备份 ${day(this.now())}`,
      categories: plan.categories,
      excluded: plan.excluded,
      vault: this.vaultState(),
    }
  }

  private vaultState(): HomeBackupPlan['vault'] {
    const vault = this.options.vault()
    if (!vault || vault.problem) return { state: 'unavailable', entries: 0 }
    const entries = vault.list().length
    if (vault.locked) return { state: 'locked', entries }
    return { state: entries === 0 ? 'empty' : 'ready', entries }
  }

  async export(
    input: HomeBackupExportInput,
    target: string,
  ): Promise<{ name: string; path: string; credentials: boolean }> {
    let credentials: Buffer | null = null
    if (input.passphrase !== undefined) {
      const vault = this.options.vault()
      if (!vault) throw new HomeBackupError('密码管理器不可用，无法放进备份。')
      credentials = await vault.exportBackup(
        input.passphrase,
        input.confirmation ?? '',
      )
    }
    const file = target.endsWith(BACKUP_EXTENSION)
      ? target
      : `${target.replace(/\.zip$/i, '')}${BACKUP_EXTENSION}`
    fs.mkdirSync(this.options.tempDir, { recursive: true })
    const root = fs.mkdtempSync(
      path.join(this.options.tempDir, 'emperor-backup-'),
    )
    fs.chmodSync(root, 0o700)
    const partial = `${file}.partial-${randomBytes(4).toString('hex')}`
    try {
      const folder = path.join(root, path.basename(file, BACKUP_EXTENSION))
      await (
        await loadHomeBackupModule()
      ).stageHomeBackup({
        home: this.options.home,
        folder,
        includeSessions: input.includeSessions,
        appVersion: this.options.appVersion,
        now: this.now,
        credentials,
        sealer: this.options.sealer?.() ?? null,
      })
      await this.zip(folder, partial)
      fs.chmodSync(partial, 0o600)
      fs.renameSync(partial, file)
    } finally {
      credentials?.fill(0)
      fs.rmSync(partial, { force: true })
      fs.rmSync(root, { recursive: true, force: true })
    }
    return {
      name: path.basename(file),
      path: file,
      credentials: credentials !== null,
    }
  }

  async open(zip: string): Promise<HomeBackupView> {
    const id = `r_${randomBytes(6).toString('hex')}`
    const dir = path.join(this.options.home, 'migrations', `.restore-${id}`)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      try {
        await this.unzip(zip, dir)
      } catch {
        throw new HomeBackupError(NOT_A_BACKUP)
      }
      const folders = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            fs.existsSync(path.join(dir, entry.name, BACKUP_MANIFEST)),
        )
      if (folders.length !== 1) throw new HomeBackupError(NOT_A_BACKUP)
      const folder = path.join(dir, folders[0]!.name)
      const { manifest } = (await loadHomeBackupModule()).readHomeBackup(folder)
      const timer = setTimeout(
        () => this.discard(id),
        this.options.ttlMs ?? 30 * 60_000,
      )
      timer.unref?.()
      this.opened.set(id, { dir, folder, manifest, timer })
      return {
        id,
        name: path.basename(zip),
        createdAt: manifest.createdAt,
        appVersion: manifest.appVersion,
        categories: [...manifest.categories],
        credentials:
          manifest.credentials &&
          fs.existsSync(path.join(folder, BACKUP_CREDENTIALS)),
        files: manifest.files,
        bytes: manifest.bytes,
        newer:
          (compareAppVersions(manifest.appVersion, this.options.appVersion) ??
            0) > 0,
      }
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }

  async restore(id: string, passphrase?: string): Promise<void> {
    const opened = RESTORE_ID.test(id) ? this.opened.get(id) : undefined
    if (!opened) throw new HomeBackupError('这个备份已经关闭，请重新选择。')
    const credentials = path.join(opened.folder, BACKUP_CREDENTIALS)
    const withCredentials =
      passphrase !== undefined && fs.existsSync(credentials)
    if (withCredentials) {
      const vault = this.options.vault()
      if (!vault) throw new HomeBackupError('密码管理器不可用，无法恢复凭据。')
      await vault.importBackup(fs.readFileSync(credentials), passphrase)
    }
    // Credential files sealed with the local key come back with the vault.
    ;(await loadHomeBackupModule()).scheduleHomeRestore({
      home: this.options.home,
      folder: opened.folder,
      withCredentials,
    })
    this.discard(id)
  }

  discard(id: string): void {
    const opened = this.opened.get(id)
    if (!opened) return
    clearTimeout(opened.timer)
    this.opened.delete(id)
    fs.rmSync(opened.dir, { recursive: true, force: true })
  }

  dispose(): void {
    for (const id of [...this.opened.keys()]) this.discard(id)
  }
}
