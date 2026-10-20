/**
 * Runs the data migrations an Emperor Home is behind on (REL-03), from its
 * `installation.json` › `dataVersion` along the chain in `./index.ts`.
 * Before a step: the files it names are copied to
 * `<home>/migrations/backup-<ts>/` (same relative paths, same modes).
 * After it: `dataVersion` advances and `migrations/log.jsonl` gets a line.
 * When it throws: every named file is put back from the copy (or removed,
 * if it did not exist before), the line says `rolled_back`, the data
 * version stays, and the next start tries again. The copy stays.
 * Loaded on demand (`runPendingDataMigrations`), never at startup otherwise.
 */
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { readInstalledDataVersion } from '../runtime/data-version'
import { DATA_MIGRATIONS } from './index'
import type { DataMigration } from './types'

export interface DataMigrationRun {
  from: number
  to: number
  applied: string[]
  failed: { migration: string; error: string; rolledBack: boolean } | null
}

export interface MigrationLogEntry {
  at: string
  kind: 'migration' | 'restore'
  status: 'applied' | 'rolled_back' | 'rollback_failed'
  [field: string]: unknown
}

/** One JSON line in `<home>/migrations/log.jsonl` (0600). */
export function appendMigrationLog(
  home: string,
  entry: MigrationLogEntry,
): void {
  const folder = join(home, 'migrations')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = join(folder, 'log.jsonl')
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** A new, empty `migrations/backup-<ts>` folder; its path relative to the home. */
export function createBackupFolder(home: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  for (let index = 0; ; index += 1) {
    const name = `backup-${stamp}${index ? `-${index}` : ''}`
    const relative = `migrations/${name}`
    const path = join(home, relative)
    if (existsSync(path)) continue
    mkdirSync(path, { recursive: true, mode: 0o700 })
    return relative
  }
}

function copyKeepingMode(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
  copyFileSync(from, to)
  chmodSync(to, statSync(from).mode & 0o777)
}

/** `installation.json` › `dataVersion`, when the file is this build's. */
export function setDataVersion(home: string, version: number): void {
  const file = join(home, 'installation.json')
  if (!existsSync(file)) return
  const value = JSON.parse(readFileSync(file, 'utf8')) as Record<
    string,
    unknown
  >
  if (Number(value.schemaVersion) > 1) return
  const temp = `${file}.tmp-${process.pid}-data-version`
  writeFileSync(
    temp,
    `${JSON.stringify({ ...value, dataVersion: version }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  )
  renameSync(temp, file)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function runDataMigrations(opts: {
  home: string
  steps?: readonly DataMigration[]
  now?: () => Date
  appVersion?: string
}): DataMigrationRun {
  const { home } = opts
  const steps = opts.steps ?? DATA_MIGRATIONS
  const now = opts.now ?? (() => new Date())
  const from = readInstalledDataVersion(home)
  const run: DataMigrationRun = { from, to: from, applied: [], failed: null }
  for (;;) {
    const step = steps.find((item) => item.from === run.to)
    if (!step) return run
    const files = step.files(home)
    const at = now()
    const backup = files.some((file) => existsSync(join(home, file)))
      ? createBackupFolder(home, at)
      : null
    const existed = files.filter((file) => existsSync(join(home, file)))
    for (const file of existed)
      copyKeepingMode(join(home, file), join(home, backup!, file))
    const entry = {
      at: at.toISOString(),
      kind: 'migration' as const,
      migration: step.id,
      from: step.from,
      to: step.to,
      files,
      backup,
      ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
    }
    try {
      step.run(home)
      setDataVersion(home, step.to)
    } catch (error) {
      let rolledBack = true
      for (const file of files)
        try {
          if (existed.includes(file))
            copyKeepingMode(join(home, backup!, file), join(home, file))
          else rmSync(join(home, file), { force: true })
        } catch {
          rolledBack = false
        }
      run.failed = { migration: step.id, error: messageOf(error), rolledBack }
      appendMigrationLog(home, {
        ...entry,
        status: rolledBack ? 'rolled_back' : 'rollback_failed',
        error: run.failed.error,
      })
      return run
    }
    appendMigrationLog(home, { ...entry, status: 'applied' })
    run.applied.push(step.id)
    run.to = step.to
  }
}
