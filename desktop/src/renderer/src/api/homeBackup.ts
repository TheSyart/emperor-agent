/**
 * 设置 › 高级 › 存储 › 备份与恢复 (REL-03): main counts the backup, asks
 * where to save it, opens a backup the user picks and restarts after a
 * restore. No path crosses IPC; an opened backup is an id. Loaded with the
 * 存储 page, not at start-up.
 */
import type {
  HomeBackupExportInput,
  HomeBackupExportResult,
  HomeBackupOpenResult,
  HomeBackupPlan,
  HomeBackupPlanResult,
  HomeBackupResult,
  HomeBackupView,
} from '../../../shared/ipc-contract'

export type { HomeBackupPlan, HomeBackupView }

interface BackupBridge {
  planHomeBackup?: () => Promise<HomeBackupPlanResult>
  exportHomeBackup?: (
    input: HomeBackupExportInput,
  ) => Promise<HomeBackupExportResult>
  revealHomeBackup?: () => Promise<HomeBackupResult>
  openHomeBackup?: () => Promise<HomeBackupOpenResult>
  restoreHomeBackup?: (
    id: string,
    passphrase?: string,
  ) => Promise<HomeBackupResult>
  discardHomeBackup?: (id: string) => Promise<unknown>
}

const UNAVAILABLE = '备份与恢复需要在 Emperor 桌面窗口中使用'

function bridge(): BackupBridge {
  return (
    (globalThis as unknown as { window?: { emperor?: BackupBridge } }).window
      ?.emperor ?? {}
  )
}

function need<K extends keyof BackupBridge>(
  key: K,
): NonNullable<BackupBridge[K]> {
  const method = bridge()[key]
  if (!method) throw new Error(UNAVAILABLE)
  return method as NonNullable<BackupBridge[K]>
}

export async function planHomeBackup(): Promise<HomeBackupPlan> {
  const result = await need('planHomeBackup')()
  if (!result.ok) throw new Error(result.error)
  return result.plan
}

/** `{ ok: false, canceled: true }` when the save dialog was cancelled. */
export async function exportHomeBackup(
  input: HomeBackupExportInput,
): Promise<
  | { ok: true; name: string; location: string; credentials: boolean }
  | { ok: false; canceled: true }
> {
  const result = await need('exportHomeBackup')(input)
  if (result.ok || 'canceled' in result) return result
  throw new Error(result.error)
}

export async function revealHomeBackup(): Promise<void> {
  const result = await need('revealHomeBackup')()
  if (!result.ok) throw new Error(result.error)
}

/** The backup the user picked, checked by main; null when cancelled. */
export async function openHomeBackup(): Promise<HomeBackupView | null> {
  const result = await need('openHomeBackup')()
  if (result.ok) return result.backup
  if ('canceled' in result) return null
  throw new Error(result.error)
}

export async function restoreHomeBackup(
  id: string,
  passphrase?: string,
): Promise<void> {
  const result = await need('restoreHomeBackup')(id, passphrase)
  if (!result.ok) throw new Error(result.error)
}

/** Drop a backup that was opened but not restored (failures do not matter). */
export async function discardHomeBackup(id: string): Promise<void> {
  await bridge()
    .discardHomeBackup?.(id)
    ?.catch(() => undefined)
}
