import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'

export class StateDirectoryLockError extends Error {
  constructor(
    readonly code: 'state_root_in_use' | 'state_root_lock_failed',
    readonly root: string,
    options?: ErrorOptions,
  ) {
    super(
      code === 'state_root_in_use'
        ? 'The data directory is already in use by another App.'
        : 'Unable to establish exclusive data directory ownership.',
      options,
    )
    this.name = 'StateDirectoryLockError'
  }
}

export class StateDirectoryLock {
  constructor(
    readonly root: string,
    readonly path: string,
    // Strongly retain the connection. There is deliberately no release API:
    // even other process exit hooks must run before the OS releases ownership.
    private readonly connections: readonly Database[],
  ) {}
}

/** Resolve existing aliases without creating the root before legacy migration. */
function canonicalDirectory(input: string, links = 0): string {
  if (links >= 40) throw new Error('Too many data directory symlinks')
  let current = resolve(input)
  const suffix: string[] = []
  for (;;) {
    try {
      // lstat also sees dangling symlinks: their prospective target must be
      // reserved before another App creates it and bootstrap migrates it.
      if (lstatSync(current).isSymbolicLink())
        return resolve(
          canonicalDirectory(
            resolve(dirname(current), readlinkSync(current)),
            links + 1,
          ),
          ...suffix,
        )
      return resolve(realpathSync.native(current), ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      suffix.unshift(basename(current))
      const parent = dirname(current)
      if (parent === current)
        throw new Error('No existing data directory ancestor')
      current = parent
    }
  }
}

/**
 * SQLite holds an OS file lock, not a lease based on PID, age or heartbeat.
 * Keep its exclusive transaction alive until the App process actually exits.
 * Never unlink the file: replacing its inode could admit two owners.
 */
export function acquireStateDirectoryLock(
  input: string,
  legacyRoot?: string | null,
): StateDirectoryLock {
  const databases: Database[] = []
  let root = resolve(input)
  try {
    const snapshot = () => {
      const current = canonicalDirectory(input)
      const targets = new Set([current])
      if (!existsSync(input) && legacyRoot)
        targets.add(canonicalDirectory(legacyRoot))
      return { current, targets }
    }
    let observed = snapshot()
    const { DatabaseSync } = createRequire(import.meta.url)(
      'node:sqlite',
    ) as typeof import('node:sqlite')
    const held = new Set<string>()
    let primaryPath = ''
    for (let attempt = 0; attempt < 4; attempt++) {
      for (const target of observed.targets) {
        if (held.has(target)) continue
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        const path = join(
          dirname(target),
          `.${basename(target)}.emperor-writer.sqlite`,
        )
        primaryPath ||= path
        try {
          closeSync(openSync(path, 'wx', 0o600))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        const database = new DatabaseSync(path)
        databases.push(database)
        database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
        held.add(target)
      }
      // Another cooperating process can finish migration between canonical
      // discovery and acquisition. Claim its resulting identity as well.
      observed = snapshot()
      root = observed.current
      if ([...observed.targets].every((target) => held.has(target)))
        return new StateDirectoryLock(root, primaryPath, databases)
    }
    throw new Error(
      'Data directory identity changed repeatedly during acquisition',
    )
  } catch (cause) {
    // No state writer was started, so a failed multi-directory claim must
    // release every partial reservation before showing the recovery page.
    for (const database of databases) database.close()
    const busy =
      typeof cause === 'object' &&
      cause !== null &&
      'errcode' in cause &&
      Number(cause.errcode) === 5
    throw new StateDirectoryLockError(
      busy ? 'state_root_in_use' : 'state_root_lock_failed',
      root,
      { cause },
    )
  }
}
