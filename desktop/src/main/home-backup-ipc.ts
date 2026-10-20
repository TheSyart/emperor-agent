/**
 * 备份与恢复 over IPC (REL-03), trusted main window only. Main alone picks
 * paths (its save and open dialogs); the renderer names an opened backup
 * by id. `backups()` loads the backup code on first use. After a restore
 * is scheduled, main restarts (the reply goes out first).
 */
import * as path from 'node:path'
import {
  HOME_BACKUP_DISCARD_CHANNEL,
  HOME_BACKUP_EXPORT_CHANNEL,
  HOME_BACKUP_OPEN_CHANNEL,
  HOME_BACKUP_PLAN_CHANNEL,
  HOME_BACKUP_RESTORE_CHANNEL,
  HOME_BACKUP_REVEAL_CHANNEL,
  type HomeBackupExportInput,
} from '../shared/ipc-contract'
import type { HomeBackups } from './home-backup'

export type HomeBackupStore = Pick<
  HomeBackups,
  'plan' | 'export' | 'open' | 'restore' | 'discard'
>

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload?: unknown) => unknown,
  ): void
}

const INVALID = { ok: false as const, error: '无效的请求' }
const ID = /^r_[0-9a-f]{12}$/

function record(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null
}

function secret(value: unknown): value is string | undefined {
  return (
    value === undefined || (typeof value === 'string' && value.length <= 1024)
  )
}

/** A vault failure keeps its reason for the renderer's text. */
function errorText(error: unknown): string {
  const reason = (error as { reason?: unknown } | null)?.reason
  const message = error instanceof Error ? error.message : String(error)
  return (error as { name?: unknown } | null)?.name ===
    'CredentialVaultError' && typeof reason === 'string'
    ? `[credential-vault:${reason}] ${message}`
    : message
}

export function registerHomeBackupIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  backups(): Promise<HomeBackupStore>
  /** The save dialog; null when cancelled. */
  chooseTarget(defaultName: string): Promise<string | null>
  /** The open dialog; null when cancelled. */
  chooseBackup(): Promise<string | null>
  /** `shell.showItemInFolder`. */
  reveal(target: string): void
  relaunch(): void
  homeDir: string
}): void {
  let name: string | null = null
  let exported: string | null = null
  const handle = (
    channel: string,
    run: (payload: unknown) => Promise<unknown>,
  ): void =>
    input.ipcMain.handle(channel, async (event, payload) => {
      input.authorize(event)
      try {
        return await run(payload)
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    })

  handle(HOME_BACKUP_PLAN_CHANNEL, async () => {
    const plan = await (await input.backups()).plan()
    name = plan.name
    return { ok: true, plan }
  })
  handle(HOME_BACKUP_EXPORT_CHANNEL, async (payload) => {
    const raw = record(payload)
    if (
      !raw ||
      typeof raw.includeSessions !== 'boolean' ||
      !secret(raw.passphrase) ||
      !secret(raw.confirmation)
    )
      return INVALID
    const request: HomeBackupExportInput = {
      includeSessions: raw.includeSessions,
      ...(raw.passphrase === undefined ? {} : { passphrase: raw.passphrase }),
      ...(raw.confirmation === undefined
        ? {}
        : { confirmation: raw.confirmation }),
    }
    const backups = await input.backups()
    name ??= (await backups.plan()).name
    const target = await input.chooseTarget(`${name}.emperor-backup.zip`)
    if (!target) return { ok: false, canceled: true }
    const result = await backups.export(request, target)
    exported = result.path
    const folder = path.dirname(result.path)
    return {
      ok: true,
      name: result.name,
      location:
        folder === input.homeDir || folder.startsWith(`${input.homeDir}/`)
          ? `~${folder.slice(input.homeDir.length)}`
          : folder,
      credentials: result.credentials,
    }
  })
  handle(HOME_BACKUP_REVEAL_CHANNEL, async () => {
    if (!exported) return { ok: false, error: '还没有导出备份' }
    input.reveal(exported)
    return { ok: true }
  })
  handle(HOME_BACKUP_OPEN_CHANNEL, async () => {
    const chosen = await input.chooseBackup()
    if (!chosen) return { ok: false, canceled: true }
    return { ok: true, backup: await (await input.backups()).open(chosen) }
  })
  handle(HOME_BACKUP_RESTORE_CHANNEL, async (payload) => {
    const raw = record(payload)
    if (!raw || typeof raw.id !== 'string' || !ID.test(raw.id)) return INVALID
    if (!secret(raw.passphrase)) return INVALID
    await (await input.backups()).restore(raw.id, raw.passphrase || undefined)
    // Restart once this reply is on its way; the next start restores.
    setTimeout(() => input.relaunch(), 400)
    return { ok: true }
  })
  handle(HOME_BACKUP_DISCARD_CHANNEL, async (payload) => {
    const id = record(payload)?.id
    if (typeof id !== 'string' || !ID.test(id)) return INVALID
    ;(await input.backups()).discard(id)
    return { ok: true }
  })
}
