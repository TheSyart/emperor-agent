import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findExecutable } from './executable'
import type { ExecutorInstallKind, ExternalBackend } from './types'

/**
 * How the user installed Claude Code or Codex (AGT-13), read from where the
 * executable really lives (symlinks resolved), so 升级 uses the same
 * channel and the binary stays the official, unmodified one:
 *
 * - Homebrew: `<prefix>/Cellar/<formula>/…` or `<prefix>/Caskroom/<cask>/…`
 *   (checked first: a formula keeps its npm package inside the keg);
 * - npm global: `<prefix>/lib/node_modules/<the CLI's package>/…`, upgraded
 *   with that prefix's own npm (or the one on PATH, told the prefix);
 * - Claude's native installer: `…/share/claude/versions/<version>`, behind
 *   `~/.local/bin/claude`;
 * - a desktop app's own copy (`….app/Contents/…`): it updates with the app;
 * - anything else is unknown: a command to copy, never one click.
 */

/** The npm package each CLI is published as. */
export const EXECUTOR_PACKAGES = {
  'claude-code': '@anthropic-ai/claude-code',
  codex: '@openai/codex',
} as const satisfies Record<ExternalBackend, string>

export interface ExecutorInstallSource {
  kind: ExecutorInstallKind
  /** The executable Emperor runs. */
  executable: string
  /** Where it really is. */
  realPath: string
  npm?: {
    prefix: string
    packageName: string
    packageDir: string
    /** The npm to run; null when there is none. */
    executable: string | null
    /** It is the prefix's own npm (so the prefix is its default). */
    ownNpm: boolean
  }
  homebrew?: {
    name: string
    cask: boolean
    prefix: string
    /** `<prefix>/bin/brew`, or null when it is gone. */
    brew: string | null
    /** The formula's or cask's folder, for 安装方式. */
    location: string
  }
  /** desktop: the app bundle. */
  app?: string
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function detectInstallSource(
  executable: string,
  backend: ExternalBackend,
  options: { home: string; path?: string },
): ExecutorInstallSource {
  let realPath: string
  try {
    realPath = realpathSync(executable)
  } catch {
    return { kind: 'unknown', executable, realPath: executable }
  }
  const base = { executable, realPath }
  const app = /^(.*?\.app)\/Contents\//.exec(realPath)
  if (app) return { ...base, kind: 'desktop', app: app[1]! }
  const brew = /^(.*)\/(Cellar|Caskroom)\/([^/]+)\//.exec(realPath)
  if (brew) {
    const prefix = brew[1]!
    const brewPath = join(prefix, 'bin', 'brew')
    return {
      ...base,
      kind: 'homebrew',
      homebrew: {
        name: brew[3]!,
        cask: brew[2] === 'Caskroom',
        prefix,
        brew: executableFile(brewPath) ? brewPath : null,
        location: join(prefix, brew[2]!, brew[3]!),
      },
    }
  }
  const packageName = EXECUTOR_PACKAGES[backend]
  const npm = /^(.*)\/lib\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(realPath)
  if (npm && npm[2] === packageName) {
    const prefix = npm[1]!
    const own = join(prefix, 'bin', 'npm')
    const ownNpm = executableFile(own)
    return {
      ...base,
      kind: 'npm',
      npm: {
        prefix,
        packageName,
        packageDir: join(prefix, 'lib', 'node_modules', packageName),
        executable: ownNpm
          ? own
          : (findExecutable('npm', options.path) ?? null),
        ownNpm,
      },
    }
  }
  if (
    backend === 'claude-code' &&
    /\/share\/claude\/versions\/[^/]+$/.test(realPath)
  )
    return { ...base, kind: 'claude-native' }
  return { ...base, kind: 'unknown' }
}

/** Where 安装方式 points: the package, keg, app or file. */
export function installLocation(source: ExecutorInstallSource): string | null {
  return (
    source.npm?.packageDir ??
    source.homebrew?.location ??
    source.app ??
    (source.kind === 'unknown' && !existsSync(source.realPath)
      ? null
      : source.realPath)
  )
}

/** How to run (and show) one upgrade. */
export interface UpgradeCommand {
  oneClick: boolean
  /** Shown in the confirmation and copied; null: nothing to run. */
  command: string | null
  /** Why there is no one click. */
  manual?: 'desktop' | 'unknown' | 'homebrew'
  argv?: string[]
  /** Added to the environment of the command. */
  env?: Record<string, string>
  /** Put first on PATH (npm's `#!/usr/bin/env node` finds that node). */
  path?: string
  /** Folders it must be able to write; checked before it runs. */
  writes?: string[]
}

const shellQuote = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`

export function upgradeCommand(
  source: ExecutorInstallSource,
  backend: ExternalBackend,
  target: string,
  options: {
    /** What `brew upgrade` would install (`brew info`), if known. */
    homebrewVersion?: string | null
  } = {},
): UpgradeCommand {
  const spec = `${EXECUTOR_PACKAGES[backend]}@${target}`
  if (source.npm) {
    const { prefix, executable, ownNpm, packageDir } = source.npm
    const prefixArgs = ownNpm ? [] : ['--prefix', prefix]
    const command = [
      'npm',
      'install',
      '-g',
      ...prefixArgs.map(shellQuote),
      spec,
    ].join(' ')
    if (!executable) return { oneClick: false, manual: 'unknown', command }
    return {
      oneClick: true,
      argv: [executable, 'install', '-g', ...prefixArgs, spec],
      env: { npm_config_prefix: prefix },
      path: join(prefix, 'bin'),
      command,
      writes: [
        join(prefix, 'lib', 'node_modules'),
        packageDir,
        join(prefix, 'bin'),
      ],
    }
  }
  if (source.homebrew) {
    const { name, cask, brew } = source.homebrew
    const args = ['upgrade', ...(cask ? ['--cask'] : []), name]
    const command = ['brew', ...args].join(' ')
    if (!brew || options.homebrewVersion !== target)
      return { oneClick: false, manual: 'homebrew', command }
    return {
      oneClick: true,
      argv: [brew, ...args],
      // The version `brew info` reported is the one it installs.
      env: { HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' },
      path: dirname(brew),
      command,
    }
  }
  if (source.kind === 'claude-native')
    return {
      oneClick: true,
      argv: [source.executable, 'install', target],
      command: `claude install ${target}`,
      writes: [dirname(dirname(source.realPath)), dirname(source.executable)],
    }
  if (source.kind === 'desktop')
    return { oneClick: false, manual: 'desktop', command: null }
  return {
    oneClick: false,
    manual: 'unknown',
    command:
      backend === 'claude-code' ? 'claude update' : `npm install -g ${spec}`,
  }
}

/**
 * 退回 to `target` (VER-03), through the channel 升级 uses where it can
 * install any version: npm and Claude's own installer. Homebrew only
 * upgrades to its current version, so it gets the npm command to copy (a
 * second install; PATH order decides which one runs); a desktop app's copy
 * goes back with the app; an unknown install, or one that could not be
 * read, gets the npm command — never `claude update`, which goes forward.
 */
export function rollbackCommand(
  source: ExecutorInstallSource | undefined,
  backend: ExternalBackend,
  target: string,
): UpgradeCommand {
  if (source?.npm || source?.kind === 'claude-native')
    return upgradeCommand(source, backend, target)
  if (source?.kind === 'desktop')
    return { oneClick: false, manual: 'desktop', command: null }
  return {
    oneClick: false,
    manual: source?.kind === 'homebrew' ? 'homebrew' : 'unknown',
    command: `npm install -g ${EXECUTOR_PACKAGES[backend]}@${target}`,
  }
}
