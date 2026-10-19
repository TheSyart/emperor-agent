/**
 * Building blocks of the deny-by-default policies (SEC-08): which toolchain
 * folders a contained process may read so `npx`, `uvx`, `node` and `python`
 * start, and one builder for the MCP, plugin-hook and installer policies.
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from 'node:path'
import { emperorSocketDirectories, type ContainmentPolicy } from './policy'

/** Package-manager prefixes of a macOS machine. */
export const TOOLCHAIN_PREFIXES: readonly string[] = [
  '/opt/homebrew',
  '/usr/local',
  '/opt/local',
]

/** Interpreters and launchers whose install folder a server may need. */
export const TOOLCHAIN_COMMANDS: readonly string[] = [
  'node',
  'npm',
  'npx',
  'python3',
  'python',
  'uv',
  'uvx',
  'bun',
  'deno',
  'pnpm',
  'yarn',
]

/**
 * The user's toolchain settings and data (registry mirrors, uv's Pythons),
 * relative to the home folder. Read-only.
 */
export const TOOLCHAIN_HOME_PATHS: readonly string[] = [
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.config/uv',
  '.local/share/uv',
  '.config/pip',
  '.pip',
  'Library/Application Support/pip',
]

/** Home folders that hold more than one toolchain: only their `bin` is opened. */
const MIXED_HOME_FOLDERS = new Set([
  '.local',
  '.cargo',
  '.config',
  'bin',
  '.bin',
  'Library',
  'Documents',
  'Desktop',
  'Downloads',
])

function real(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/** A folder that is the home folder, one of its ancestors or `/`. */
function tooWide(path: string, home: string): boolean {
  return path === sep || path === home || home.startsWith(`${path}${sep}`)
}

/**
 * The install folder of an executable's real file: `<prefix>/bin/node` →
 * `<prefix>`; never the home folder or above, and only `bin` of a mixed
 * home folder such as `~/.local` or `~/.cargo`.
 */
export function toolchainPrefix(realExecutable: string, home: string): string {
  const folder = dirname(realExecutable)
  const prefix = ['bin', 'sbin', 'shims'].includes(basename(folder))
    ? dirname(folder)
    : folder
  if (tooWide(prefix, home)) return folder
  if (dirname(prefix) === home && MIXED_HOME_FOLDERS.has(basename(prefix)))
    return folder
  return prefix
}

function which(name: string, path: string): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null
  if (name.includes('/')) return null
  for (const folder of path.split(delimiter)) {
    if (!isAbsolute(folder)) continue
    const candidate = join(folder, name)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}

/**
 * Toolchain folders a deny-by-default process reads: the package-manager
 * prefixes, every absolute PATH folder (a lookup in an unreadable folder
 * fails with EPERM, not ENOENT, and stops the search), the install folder of
 * the command and of the usual interpreters, and the user's toolchain
 * settings that exist.
 */
export function toolchainRoots(input: {
  executables?: readonly string[]
  env?: Readonly<Record<string, string | undefined>>
  home?: string
}): string[] {
  const home = real(input.home ?? homedir()) ?? input.home ?? homedir()
  const path = input.env?.PATH ?? process.env.PATH ?? ''
  const roots: string[] = [...TOOLCHAIN_PREFIXES]
  for (const folder of path.split(delimiter)) {
    if (!isAbsolute(folder)) continue
    const resolved = real(folder)
    if (!resolved || tooWide(resolved, home)) continue
    roots.push(resolved)
    // The spelling too: a lookup walks it (and its symlinks) first.
    if (resolve(folder) !== resolved && !tooWide(resolve(folder), home))
      roots.push(resolve(folder))
  }
  for (const name of [...(input.executables ?? []), ...TOOLCHAIN_COMMANDS]) {
    const found = which(name, path)
    const resolved = found ? real(found) : null
    if (resolved) roots.push(toolchainPrefix(resolved, home))
  }
  for (const relative of TOOLCHAIN_HOME_PATHS) {
    const candidate = join(home, relative)
    if (existsSync(candidate)) roots.push(candidate)
  }
  return [...new Set(roots)]
}

export interface ProcessPolicyOptions {
  /** The workspace the process works in, and whether it may change it. */
  workspace: { root: string; access: 'read' | 'write' } | null
  /** Emperor Home: hidden from the process except the folders granted below. */
  stateRoot: string | null
  /** Further readable folders (a plugin's package, a server's own folder). */
  read?: readonly string[]
  /** Further writable folders (a plugin's data, a cache, an install target). */
  write?: readonly string[]
  tempDir: string
  network: 'allow' | 'deny'
  fallback: 'refuse' | 'ask-user'
  /** Commands whose toolchain must be readable. */
  executables?: readonly string[]
  /** The environment the process starts with (its PATH). */
  env?: Readonly<Record<string, string | undefined>>
  /** The home folder the credential table and toolchain settings hang off. */
  home?: string
  /** Apple Events and the window server; default denied. */
  desktop?: 'allow' | 'deny'
}

/** A deny-by-default policy over the shared protected-path table. */
export function processContainmentPolicy(
  options: ProcessPolicyOptions,
): ContainmentPolicy {
  const home = options.home ?? homedir()
  const stateRoot = options.stateRoot ? resolve(options.stateRoot) : null
  const workspace = options.workspace
    ? { ...options.workspace, root: resolve(options.workspace.root) }
    : null
  return {
    read: {
      allow: [
        ...(workspace ? [workspace.root] : []),
        ...(options.read ?? []).map((path) => resolve(path)),
      ],
      deny: stateRoot ? [stateRoot] : [],
    },
    write: {
      allow: [
        ...(workspace?.access === 'write' ? [workspace.root] : []),
        resolve(options.tempDir),
        ...(options.write ?? []).map((path) => resolve(path)),
      ],
      deny: stateRoot ? [stateRoot] : [],
    },
    network: options.network,
    tempDir: resolve(options.tempDir),
    toolchainReadOnly: toolchainRoots({
      executables: options.executables ?? [],
      ...(options.env ? { env: options.env } : {}),
      home,
    }),
    ancestorsMetadata: true,
    fallback: options.fallback,
    protectedPaths: stateRoot
      ? { stateRoot, home, credentialReads: 'deny' }
      : null,
    desktop: options.desktop ?? 'deny',
    deniedSocketDirs: emperorSocketDirectories(stateRoot),
  }
}
