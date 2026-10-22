/**
 * Data migrations of an Emperor Home (REL-03). Each step is one file,
 * `migrations/<from>-<to>.ts`, taking the home from data version `from`
 * to `to` (`installation.json` › `dataVersion`). The runner
 * (`./runner.ts`) copies the files a step names to
 * `<home>/migrations/backup-<ts>/` first, writes every run to
 * `<home>/migrations/log.jsonl`, and puts the copies back when a step
 * throws. Steps must be safe to run again: a home an older Emperor wrote
 * over (it drops `dataVersion`) runs them once more.
 */
import { stampVersions } from './0-1'
import type { DataMigration } from './types'

export type { DataMigration } from './types'

/** The chain from data version 0 to CURRENT_DATA_VERSION, in order. */
export const DATA_MIGRATIONS: readonly DataMigration[] = [stampVersions]
