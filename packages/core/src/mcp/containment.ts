/**
 * The containment of one MCP stdio server (SEC-08, CORE-11 / CORE-33).
 *
 * Reads are deny-by-default: the OS, the toolchain (PATH folders, the
 * install folders of node / python / uv, the user's npm / pip / uv
 * settings), the workspace, the server's own folders and its cache. Writes:
 * the workspace, the cache, and the folders the server was given. Each
 * server has its own cache, `<stateRoot>/mcp/cache/<name>`, which is its
 * npm_config_cache, UV_CACHE_DIR and TMPDIR, so `npx -y` and `uvx` work
 * without ~/.npm or ~/.cache. A plugin's server is refused when no sandbox
 * can run; a user's server asks the user once (remembered per server).
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import {
  canonicalContainmentPath,
  type ContainmentPolicy,
} from '../sandbox/policy'
import { processContainmentPolicy } from '../sandbox/presets'

export type McpServerSource = 'user' | 'plugin'

export interface McpServerContainmentInput {
  name: string
  source: McpServerSource
  stateRoot: string
  workspaceRoot: string
  cwd?: string | null
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  /** Folders inside Emperor Home a plugin's server may use (its package and data). */
  grants?: { read: string[]; write: string[] } | null
  home?: string
}

export interface McpServerContainment {
  policy: ContainmentPolicy
  /** npm_config_cache, UV_CACHE_DIR, UV_TOOL_DIR (TMPDIR comes from the policy). */
  env: Record<string, string>
  cacheDir: string
}

/** Files that mark a server's own project folder. */
const PROJECT_MARKERS = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'uv.lock',
  'Cargo.toml',
  'go.mod',
  'node_modules',
  '.venv',
  '.git',
]

function real(path: string): string {
  return canonicalContainmentPath(path)
}

/** A cache folder name for any server name (no separators, no dot names). */
export function mcpCacheSegment(name: string): string {
  if (/^[A-Za-z0-9._-]{1,64}$/.test(name) && name !== '.' && name !== '..')
    return name
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'server'
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${safe}-${digest}`
}

export function mcpCacheDirectory(stateRoot: string, name: string): string {
  return join(real(resolve(stateRoot)), 'mcp', 'cache', mcpCacheSegment(name))
}

function tooWide(path: string, home: string): boolean {
  return path === sep || path === home || home.startsWith(`${path}${sep}`)
}

/** The project folder of a script a user's server runs (`node <file>`). */
function projectFolderOf(file: string, home: string): string {
  let current = dirname(file)
  while (!tooWide(current, home)) {
    if (PROJECT_MARKERS.some((marker) => existsSync(join(current, marker))))
      return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirname(file)
}

/**
 * The folders a user's server was pointed at: an existing absolute folder
 * argument is the server's to read and write (the filesystem server's
 * roots); an existing file argument opens its project folder for reading
 * (`node /path/build/index.js`, `python /path/server.py`).
 */
function argumentFolders(
  args: readonly string[],
  home: string,
): { read: string[]; write: string[] } {
  const read: string[] = []
  const write: string[] = []
  for (const arg of args) {
    if (!isAbsolute(arg)) continue
    let stat
    try {
      stat = statSync(arg)
    } catch {
      continue
    }
    const path = real(arg)
    if (tooWide(path, home)) continue
    if (stat.isDirectory()) write.push(path)
    else if (stat.isFile()) read.push(projectFolderOf(path, home))
  }
  return { read, write }
}

/** Grants strictly inside Emperor Home; anything else is dropped. */
function stateGrants(
  grants: readonly string[] | undefined,
  stateRoot: string,
): string[] {
  return (grants ?? [])
    .map((path) => real(resolve(path)))
    .filter(
      (path) => path !== stateRoot && path.startsWith(`${stateRoot}${sep}`),
    )
}

export function mcpServerContainment(
  input: McpServerContainmentInput,
): McpServerContainment {
  const home = real(input.home ?? homedir())
  const stateRoot = real(resolve(input.stateRoot))
  const workspace = real(resolve(input.workspaceRoot))
  const cacheDir = mcpCacheDirectory(stateRoot, input.name)
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  const cwd = input.cwd ? real(resolve(input.cwd)) : null
  const read: string[] = []
  const write: string[] = [cacheDir]
  if (input.source === 'plugin') {
    read.push(...stateGrants(input.grants?.read, stateRoot))
    write.push(...stateGrants(input.grants?.write, stateRoot))
    // A plugin's server runs in its package (or data) folder.
    if (cwd && !tooWide(cwd, home)) read.push(cwd)
  } else {
    const folders = argumentFolders(input.args, home)
    read.push(...folders.read)
    write.push(...folders.write)
    if (cwd && !tooWide(cwd, home)) write.push(cwd)
  }
  const policy = processContainmentPolicy({
    workspace: { root: workspace, access: 'write' },
    stateRoot,
    read,
    write,
    tempDir: cacheDir,
    network: 'allow',
    fallback: input.source === 'plugin' ? 'refuse' : 'ask-user',
    executables: [input.command],
    env: input.env,
    home,
    // Servers drive apps for the user (AppleScript, browsers); Shell does not.
    desktop: 'allow',
  })
  return {
    policy,
    cacheDir,
    env: {
      npm_config_cache: cacheDir,
      UV_CACHE_DIR: cacheDir,
      // uvx keeps a lock file in the tool folder even for one-off runs.
      UV_TOOL_DIR: join(cacheDir, 'uv-tools'),
    },
  }
}
