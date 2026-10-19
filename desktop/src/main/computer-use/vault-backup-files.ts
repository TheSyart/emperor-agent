/**
 * File access for `.emperor-vault` backups (SEC-09). The paths come only
 * from main's own save and open dialogs; the renderer never names one.
 */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  BACKUP_EXTENSION,
  BACKUP_MAX_BYTES,
  CredentialVaultError,
} from './credential-vault'

/** The save dialog's choice, with the extension added when it was left off. */
export function backupFilePath(chosen: string): string {
  return chosen.endsWith(`.${BACKUP_EXTENSION}`)
    ? chosen
    : `${chosen}.${BACKUP_EXTENSION}`
}

/** `Emperor 凭据备份 2026-10-19.emperor-vault` */
export function defaultBackupName(now: Date): string {
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  return `Emperor 凭据备份 ${day}.${BACKUP_EXTENSION}`
}

/** A regular file no larger than any backup this build writes. */
export async function readBackupFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > BACKUP_MAX_BYTES)
      throw new CredentialVaultError(
        'backup-invalid',
        'the file is not an Emperor credential backup',
      )
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/**
 * Written private (0600) and whole: a staging file beside the target,
 * fsynced, then renamed over it.
 */
export async function writeBackupFile(
  path: string,
  data: Buffer,
): Promise<void> {
  const existing = await stat(path).catch(() => null)
  if (existing && !existing.isFile())
    throw new CredentialVaultError(
      'backup-invalid',
      'a backup can only replace a file',
    )
  const staging = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`,
  )
  const handle = await open(
    staging,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  )
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(staging, path)
  } catch (error) {
    await unlink(staging).catch(() => undefined)
    throw error
  }
}
