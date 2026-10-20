import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../util/log'
import { CURRENT_DATA_VERSION, readInstalledDataVersion } from './data-version'

// REL-03 startup hooks: their code loads only when there is work.

/** Run the data migrations a home is behind on. Never throws. */
export async function runPendingDataMigrations(
  emperorHome: string,
  opts: { appVersion?: string } = {},
): Promise<import('../migrations/runner').DataMigrationRun | null> {
  if (readInstalledDataVersion(emperorHome) >= CURRENT_DATA_VERSION) return null
  try {
    const { runDataMigrations } = await import('../migrations/runner')
    return runDataMigrations({ home: emperorHome, ...opts })
  } catch (error) {
    // The stores read unmigrated files too; the next start tries again.
    logger.warn('Data migrations failed', { error: String(error) })
    return null
  }
}

/** Apply a restore 设置 › 存储 scheduled, before anything opens the home. */
export async function applyPendingHomeRestore(
  emperorHome: string,
): Promise<import('../storage/backup').RestoreResult | null> {
  if (!existsSync(join(emperorHome, 'migrations', 'restore-pending')))
    return null
  const { applyPendingRestore } = await import('../storage/backup')
  return applyPendingRestore({ home: emperorHome })
}
