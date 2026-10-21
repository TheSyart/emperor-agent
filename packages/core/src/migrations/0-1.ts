/**
 * 0 → 1: every persistent file carries its version (REL-03). Emperor's own
 * `settings.json`, written by an older Emperor without one, gets the version
 * this build writes (`{"version": 1}`, first key; the rest unchanged). The
 * other files of the inventory had a version already (`schemaVersion`, or
 * `version` on each session entry). The user's own `mcp_config.json` and
 * `hooks.json` are not Emperor's to stamp (PL-10, FIX-08): no step names,
 * backs up or writes them. A file that is not a JSON object is left for
 * its store to deal with.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { DataMigration } from './types'

const STAMPED = ['settings.json'] as const

function unversioned(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  return value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !('version' in value)
    ? (value as Record<string, unknown>)
    : null
}

export const stampVersions: DataMigration = {
  id: '0-1',
  from: 0,
  to: 1,
  files: (home) =>
    STAMPED.filter((name) => unversioned(join(home, name)) !== null).sort(),
  run(home) {
    for (const name of this.files(home)) {
      const path = join(home, name)
      const value = unversioned(path)!
      const mode = statSync(path).mode & 0o777
      const temp = `${path}.tmp-${process.pid}-migration`
      const fd = openSync(temp, 'w', mode)
      try {
        writeFileSync(
          fd,
          `${JSON.stringify({ version: 1, ...value }, null, 2)}\n`,
        )
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      chmodSync(temp, mode)
      renameSync(temp, path)
    }
  },
}
