/**
 * Paths no Agent tool may reach (plan rev 5 §3, SEC-06), one table in three
 * classes:
 *
 * - `state`: `<stateRoot>/computer-use` (GUI grants, the credential vault,
 *   its local key, browser pairings) and `<stateRoot>/browser` (profiles
 *   with cookies, the download inbox, remembered tabs, site permissions).
 *   Never read, never written.
 * - `config`: files directly in Emperor Home named `model_config*`,
 *   `mcp_config*`, `settings.json*`, `hooks.json*` (the files and their
 *   backups, temp and quarantined copies). Never read, never written: the
 *   Agent changes its configuration through its tools and the Core API
 *   (`mcp_config`, `skill_manage`), which never go through the file tools.
 * - `credential`: `~/.ssh`, `~/.aws`, `~/.config/gcloud`,
 *   `~/.docker/config.json`, `~/.netrc`, `~/.codex/auth.json`,
 *   `~/.claude/.credentials.json`. Read only under danger-full-access (a
 *   standing session or one approved escalation); never written.
 *
 * One judgment for every way in: Seatbelt (backend.ts) writes the same
 * table into the Shell profile; `read` / `edit` / `write` and `grep` /
 * `glob` classify with {@link classifyProtectedPath}. No escalation unlocks
 * `state` or `config`. Paths are compared as real paths (symlinks
 * resolved), with letter case folded where the file system usually ignores
 * it, and then by file identity, which also sees aliases realpath keeps
 * (macOS `/System/Volumes/Data/...`) and hard links.
 */

import { realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { canonicalPath } from './policy'

export const PROTECTED_STATE_DIRS = ['computer-use', 'browser'] as const

/** File-name prefixes directly in Emperor Home that are its own configuration. */
export const PROTECTED_CONFIG_NAMES = [
  'model_config',
  'mcp_config',
  'settings.json',
  'hooks.json',
] as const

/** The user's credential locations, relative to the home folder. */
export const PROTECTED_CREDENTIAL_PATHS = [
  { path: '.ssh', kind: 'dir' },
  { path: '.aws', kind: 'dir' },
  { path: '.config/gcloud', kind: 'dir' },
  { path: '.docker/config.json', kind: 'file' },
  { path: '.netrc', kind: 'file' },
  { path: '.codex/auth.json', kind: 'file' },
  { path: '.claude/.credentials.json', kind: 'file' },
] as const

export type ProtectedPathClass = 'state' | 'config' | 'credential'

/** Where the table is anchored: Emperor Home and the user's home folder. */
export interface ProtectedPathScope {
  stateRoot: string
  home: string
}

/**
 * One row, canonical: `subtree` = the path and everything in it; `exact` =
 * that file; `prefix` = files directly in `path` whose name starts with one
 * of `names`.
 */
export type ProtectedEntry =
  | {
      readonly class: ProtectedPathClass
      readonly match: 'subtree' | 'exact'
      readonly path: string
    }
  | {
      readonly class: ProtectedPathClass
      readonly match: 'prefix'
      readonly path: string
      readonly names: readonly string[]
    }

/** Model-facing reasons; they name no value. */
export const PROTECTED_CONFIG_REASON =
  "it is one of Emperor's own settings files (models, MCP servers, settings, hooks), which the Agent reads and changes only through its tools (mcp_config, skill_manage) and the settings page, never as a file"
export const PROTECTED_CREDENTIAL_WRITE_REASON =
  "it holds the user's credentials (SSH, cloud, Docker, netrc, Codex or Claude logins), which no Agent tool may change in any mode"
export const PROTECTED_CREDENTIAL_READ_REASON =
  'it holds the user\'s credentials (SSH, cloud, Docker, netrc, Codex or Claude logins); reading it needs the user\'s approval: retry this exact call once with sandbox_permissions="danger-full-access" and a one-sentence justification, and the approval prompt names the file'

/** Model-facing reason; names no file and no value. */
export const PROTECTED_STATE_REASON =
  "it is in Emperor's private Computer Use or browser data (credentials, keys, cookies), which no Agent tool may read or change"

const CASE_INSENSITIVE =
  process.platform === 'darwin' || process.platform === 'win32'

/** Real path of `path`, or of its nearest existing ancestor plus the rest. */
function canonicalNearest(path: string): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing)
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.unshift(basename(current))
      current = parent
    }
  }
}

/** The whole table for one Emperor Home and home folder, canonical. */
export function protectedEntries(scope: ProtectedPathScope): ProtectedEntry[] {
  const root = canonicalPath(scope.stateRoot)
  const home = canonicalNearest(scope.home)
  return [
    ...PROTECTED_STATE_DIRS.map((name) => ({
      class: 'state' as const,
      match: 'subtree' as const,
      path: canonicalNearest(join(root, name)),
    })),
    {
      class: 'config' as const,
      match: 'prefix' as const,
      path: root,
      names: PROTECTED_CONFIG_NAMES,
    },
    ...PROTECTED_CREDENTIAL_PATHS.map((entry) => ({
      class: 'credential' as const,
      match: entry.kind === 'dir' ? ('subtree' as const) : ('exact' as const),
      path: canonicalNearest(join(home, entry.path)),
    })),
  ]
}

function fold(path: string): string {
  return CASE_INSENSITIVE ? path.toLowerCase() : path
}

/** Whether `entry` covers absolute `path`, comparing the spelling only. */
export function entryCovers(entry: ProtectedEntry, path: string): boolean {
  switch (entry.match) {
    case 'subtree':
      return isLexicallyInside(path, entry.path)
    case 'exact':
      return fold(path) === fold(entry.path)
    case 'prefix': {
      if (fold(dirname(path)) !== fold(entry.path)) return false
      const name = fold(basename(path))
      return entry.names.some((prefix) => name.startsWith(fold(prefix)))
    }
  }
}

/**
 * Which class of the table absolute `path` falls in, or null: by real path,
 * then by file identity (aliases realpath keeps, hard links).
 */
export async function classifyProtectedPath(
  path: string,
  scope: ProtectedPathScope,
): Promise<ProtectedPathClass | null> {
  const entries = protectedEntries(scope)
  const real = await realOrNearest(path)
  const lexical = entries.find((entry) => entryCovers(entry, real))
  if (lexical) return lexical.class
  const ownId = await identity(real)
  const parentId = await identity(dirname(real))
  const name = fold(basename(real))
  for (const entry of entries) {
    if (entry.match === 'prefix') {
      if (
        parentId !== null &&
        parentId === (await identity(entry.path)) &&
        entry.names.some((prefix) => name.startsWith(fold(prefix)))
      )
        return entry.class
      continue
    }
    if (entry.match === 'exact') {
      const id = await identity(entry.path)
      if (id !== null && id === ownId) return entry.class
      if (
        parentId !== null &&
        parentId === (await identity(dirname(entry.path))) &&
        name === fold(basename(entry.path))
      )
        return entry.class
      continue
    }
    const id = await identity(entry.path)
    if (id === null) continue
    for (let current = real; ; current = dirname(current)) {
      if ((await identity(current)) === id) return entry.class
      if (dirname(current) === current) break
    }
  }
  return null
}

/**
 * The entries of `classes` that lie inside the search root `root` (absolute,
 * as the search names it), re-spelled under `root`, so results found there
 * can be dropped with {@link entryCovers}. Empty when none does.
 */
export async function protectedEntriesUnder(
  root: string,
  scope: ProtectedPathScope,
  classes: readonly ProtectedPathClass[],
): Promise<ProtectedEntry[]> {
  const rootId = await identity(root)
  if (rootId === null) return []
  const under: ProtectedEntry[] = []
  for (const entry of protectedEntries(scope)) {
    if (!classes.includes(entry.class)) continue
    for (let ancestor = entry.path; ; ancestor = dirname(ancestor)) {
      if ((await identity(ancestor)) === rootId) {
        under.push({
          ...entry,
          path: join(root, relative(ancestor, entry.path)),
        })
        break
      }
      if (dirname(ancestor) === ancestor) break
    }
  }
  return under
}

/**
 * Directories whose own rename or mode change would carry protected paths
 * somewhere the rules no longer name: Emperor Home, the parents of the
 * credential paths, and each of their ancestors up to (not including) `/`.
 * Files can still be created inside them.
 */
export function protectedAncestors(scope: ProtectedPathScope): string[] {
  const out = new Set<string>()
  for (const entry of protectedEntries(scope)) {
    let current = entry.match === 'prefix' ? entry.path : dirname(entry.path)
    while (dirname(current) !== current) {
      out.add(current)
      current = dirname(current)
    }
  }
  return [...out]
}

/**
 * Lowercase spellings of the table's paths as error messages show them: the
 * real paths and the paths as the scope names them (Emperor Home and the
 * home folder before symlinks are resolved).
 */
export function protectedPathSpellings(scope: ProtectedPathScope): string[] {
  const spelled: string[] = [
    ...PROTECTED_STATE_DIRS.map((name) => join(scope.stateRoot, name)),
    `${scope.stateRoot}${sep}`,
    ...PROTECTED_CREDENTIAL_PATHS.map((entry) => join(scope.home, entry.path)),
  ]
  for (const entry of protectedEntries(scope))
    spelled.push(entry.match === 'prefix' ? `${entry.path}${sep}` : entry.path)
  return [...new Set(spelled.map((path) => path.toLowerCase()))]
}

/** `~/…` form of a path under `home`. */
export function homeDisplayPath(path: string, home: string): string {
  for (const base of new Set([home, canonicalNearest(home)]))
    if (path === base || path.startsWith(`${base}${sep}`))
      return `~${path.slice(base.length)}`
  return path
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Credential paths a Shell command names (`~/…`, `$HOME/…`, `${HOME}/…`, or
 * the home folder spelled out), in `~` form, for the approval prompt of an
 * escalation. Best effort: a command can reach them in ways its text does
 * not show; Seatbelt is what enforces.
 */
export function credentialPathMentions(
  command: string,
  home: string,
): string[] {
  const homes = [
    '~',
    '\\$HOME',
    '\\$\\{HOME\\}',
    ...new Set([home, canonicalNearest(home)].map(escapeRegex)),
  ]
  const credentials = PROTECTED_CREDENTIAL_PATHS.map((entry) =>
    escapeRegex(entry.path),
  )
  const end = '\\s\'"`;|&<>()'
  const pattern = new RegExp(
    `(?:${homes.join('|')})/(${credentials.join('|')})((?:/[^${end}$]*)?)(?=$|[${end}])`,
    'g',
  )
  const found: string[] = []
  for (const match of command.matchAll(pattern)) {
    const shown = `~/${match[1]}${match[2] ?? ''}`
    if (!found.includes(shown)) found.push(shown)
    if (found.length === 8) break
  }
  return found
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
