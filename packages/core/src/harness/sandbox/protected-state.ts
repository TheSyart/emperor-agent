/**
 * Emperor state that no Agent tool may read or change (plan rev 5 §3):
 * `<stateRoot>/computer-use` (GUI grants, the credential vault, its local
 * key, browser pairings) and `<stateRoot>/browser` (profiles and their
 * cookies, the download inbox, remembered tabs, site permissions).
 *
 * One judgment for every path in: Seatbelt denies Shell reads of exactly
 * {@link protectedStateDirs}; `read` / `edit` / `write` and `grep` / `glob`
 * refuse paths for which {@link isProtectedStatePath} holds, in every
 * sandbox mode. Paths are compared as real paths (symlinks resolved), with
 * letter case folded where the file system usually ignores it, and then by
 * file identity, which also sees aliases realpath keeps (macOS
 * `/System/Volumes/Data/...`).
 */

import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { canonicalPath } from './policy'

export const PROTECTED_STATE_DIRS = ['computer-use', 'browser'] as const

/** Model-facing reason; names no file and no value. */
export const PROTECTED_STATE_REASON =
  "it is in Emperor's private Computer Use or browser data (credentials, keys, cookies), which no Agent tool may read or change"

const CASE_INSENSITIVE =
  process.platform === 'darwin' || process.platform === 'win32'

/** The protected directories under `stateRoot`, symlinks resolved. */
export function protectedStateDirs(stateRoot: string): string[] {
  const root = canonicalPath(stateRoot)
  return PROTECTED_STATE_DIRS.map((name) => canonicalPath(join(root, name)))
}

/** `path` is `dir` or lies inside it, comparing the spelling only. */
export function isLexicallyInside(path: string, dir: string): boolean {
  const target = CASE_INSENSITIVE ? path.toLowerCase() : path
  const base = CASE_INSENSITIVE ? dir.toLowerCase() : dir
  return (
    target === base ||
    target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
  )
}

/** Real path of `path`, or of its nearest existing ancestor plus the rest. */
async function realOrNearest(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(await realpath(current), ...missing)
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.unshift(basename(current))
      current = parent
    }
  }
}

async function identity(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    return `${info.dev}:${info.ino}`
  } catch {
    return null
  }
}

/** Whether absolute `path` is a protected directory or lies inside one. */
export async function isProtectedStatePath(
  path: string,
  stateRoot: string,
): Promise<boolean> {
  const dirs = protectedStateDirs(stateRoot)
  const real = await realOrNearest(path)
  if (dirs.some((dir) => isLexicallyInside(real, dir))) return true
  const ids = new Set(
    (await Promise.all(dirs.map(identity))).filter(
      (id): id is string => id !== null,
    ),
  )
  if (ids.size === 0) return false
  for (let current = real; ; current = dirname(current)) {
    const id = await identity(current)
    if (id !== null && ids.has(id)) return true
    if (dirname(current) === current) return false
  }
}

/**
 * The protected directories that lie inside the search root `root`
 * (absolute, as the search names it), spelled under `root`, so results found
 * there can be dropped. Empty when none does.
 */
export async function protectedStateDirsUnder(
  root: string,
  stateRoot: string,
): Promise<string[]> {
  const rootId = await identity(root)
  if (rootId === null) return []
  const under: string[] = []
  for (const dir of protectedStateDirs(stateRoot)) {
    for (let ancestor = dir; ; ancestor = dirname(ancestor)) {
      if ((await identity(ancestor)) === rootId) {
        under.push(join(root, relative(ancestor, dir)))
        break
      }
      if (dirname(ancestor) === ancestor) break
    }
  }
  return under
}
