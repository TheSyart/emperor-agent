/**
 * The development environment of a delegated task (AGT-08, finding SUB-12).
 * A task runs under an isolated HOME, so by itself it sees no git identity,
 * SSH agent, nvm/volta/cargo/pyenv or gh login. Each is passed through on
 * its own switch (设置 › 子智能体 › 高级 › 开发环境): the git identity and
 * the proxies by default, SSH, toolchains and GitHub only when turned on.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LoginShellEnvironment } from './login-shell'

export interface DevelopmentEnvironmentSettings {
  /** GIT_AUTHOR_* / GIT_COMMITTER_* from the user's git config. */
  readonly gitIdentity: boolean
  /** HTTP(S)_PROXY, ALL_PROXY and NO_PROXY (the runtime always passed them). */
  readonly proxy: boolean
  /** SSH_AUTH_SOCK, so git over SSH reaches the user's agent. */
  readonly sshAgent: boolean
  /** NVM_DIR, VOLTA_HOME, RUSTUP_HOME, CARGO_HOME, PYENV_ROOT and their bins on PATH. */
  readonly toolchains: boolean
  /** GH_TOKEN from `gh auth token` ("允许子智能体使用 GitHub 登录"). */
  readonly github: boolean
}

export const DEFAULT_DEVELOPMENT_ENVIRONMENT: DevelopmentEnvironmentSettings =
  Object.freeze({
    gitIdentity: true,
    proxy: true,
    sshAgent: false,
    toolchains: false,
    github: false,
  })

/** Proxy variables the runtime passes while the proxy switch is on. */
export const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const

const GIT_IDENTITY_KEYS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const
const TOOLCHAIN_KEYS = [
  'NVM_DIR',
  'VOLTA_HOME',
  'RUSTUP_HOME',
  'CARGO_HOME',
  'PYENV_ROOT',
] as const
const GITHUB_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

/** Every variable this module may set: the Codex shell is given exactly these. */
export const DEVELOPMENT_ENVIRONMENT_KEYS: readonly string[] = [
  ...GIT_IDENTITY_KEYS,
  ...PROXY_KEYS,
  'SSH_AUTH_SOCK',
  ...TOOLCHAIN_KEYS,
  'GH_TOKEN',
]

export interface DevelopmentEnvironment {
  /** Variables to set in the task's environment. */
  readonly env: Record<string, string>
  /** Variables to drop from it (a switch that is off). */
  readonly remove: readonly string[]
  /** Folders to put in front of PATH (toolchain bins). */
  readonly pathPrefix: readonly string[]
  /** Values to redact from the task's logs and transcript. */
  readonly secrets: readonly string[]
}

export async function developmentEnvironment(input: {
  settings: DevelopmentEnvironmentSettings
  /** Emperor's own environment (a Dock launch lacks ~/.zshrc exports). */
  ambient: NodeJS.ProcessEnv
  /** The user's real home (the task's HOME is isolated). */
  home: string
  loginShell?: LoginShellEnvironment
  readGitIdentity?: (home: string) => Promise<{ name?: string; email?: string }>
  readGhToken?: (home: string) => Promise<string | null>
}): Promise<DevelopmentEnvironment> {
  const { settings, ambient, home } = input
  const env: Record<string, string> = {}
  const remove: string[] = []
  const pathPrefix: string[] = []
  const secrets: string[] = []
  const fromShell = async (names: readonly string[]) => {
    const found: Record<string, string> = {}
    const missing = names.filter((name) => {
      const value = ambient[name]
      if (value) found[name] = value
      return !value
    })
    if (missing.length && input.loginShell)
      Object.assign(found, await input.loginShell.read(missing))
    return found
  }

  if (settings.gitIdentity) {
    const identity = await (input.readGitIdentity ?? gitIdentity)(home)
    if (identity.name) {
      env.GIT_AUTHOR_NAME = identity.name
      env.GIT_COMMITTER_NAME = identity.name
    }
    if (identity.email) {
      env.GIT_AUTHOR_EMAIL = identity.email
      env.GIT_COMMITTER_EMAIL = identity.email
    }
  }
  // On: the runtime already passes Emperor's own proxy variables (no login
  // shell for them: that would run on every task). Off: they are dropped.
  if (!settings.proxy) remove.push(...PROXY_KEYS)
  if (settings.sshAgent) {
    const { SSH_AUTH_SOCK: socket } = await fromShell(['SSH_AUTH_SOCK'])
    if (socket && isSocket(socket)) env.SSH_AUTH_SOCK = socket
  }
  if (settings.toolchains) {
    const known = await fromShell(TOOLCHAIN_KEYS)
    const dir = (key: (typeof TOOLCHAIN_KEYS)[number], fallback: string) => {
      const path = known[key] || join(home, fallback)
      if (isDirectory(path)) env[key] = path
      return env[key]
    }
    const nvm = dir('NVM_DIR', '.nvm')
    const node = nvm ? nvmDefaultBin(nvm) : null
    if (node) pathPrefix.push(node)
    const volta = dir('VOLTA_HOME', '.volta')
    if (volta && isDirectory(join(volta, 'bin')))
      pathPrefix.push(join(volta, 'bin'))
    dir('RUSTUP_HOME', '.rustup')
    const cargo = dir('CARGO_HOME', '.cargo')
    if (cargo && isDirectory(join(cargo, 'bin')))
      pathPrefix.push(join(cargo, 'bin'))
    const pyenv = dir('PYENV_ROOT', '.pyenv')
    if (pyenv && isDirectory(join(pyenv, 'shims')))
      pathPrefix.push(join(pyenv, 'shims'))
  }
  if (settings.github) {
    const token = await (input.readGhToken ?? ghToken)(home)
    if (token) {
      env.GH_TOKEN = token
      secrets.push(token)
    }
  } else remove.push(...GITHUB_KEYS)
  return { env, remove, pathPrefix, secrets }
}

/**
 * The project's own instructions for an executor that does not load them
 * itself (Claude without project settings; Codex's brief), bounded per file.
 */
export function projectInstructions(
  root: string,
  files: readonly string[],
  maxBytesPerFile = 16_384,
): string | null {
  const parts: string[] = []
  for (const name of files) {
    const path = join(root, name)
    let text: string
    try {
      if (!statSync(path).isFile()) continue
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const cut = Buffer.byteLength(text) > maxBytesPerFile
    const body = cut
      ? `${Buffer.from(text).subarray(0, maxBytesPerFile).toString('utf8')}\n…（已截断 / truncated）`
      : text.trimEnd()
    parts.push(`## ${name}\n\n${body}`)
  }
  if (!parts.length) return null
  return [
    '# Project instructions',
    'The repository you work in documents its conventions; follow them.',
    ...parts,
  ].join('\n\n')
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket()
  } catch {
    return false
  }
}

/** The bin folder of nvm's default node: its alias, else the newest installed. */
function nvmDefaultBin(nvmDir: string): string | null {
  const versionsDir = join(nvmDir, 'versions', 'node')
  let versions: string[]
  try {
    versions = readdirSync(versionsDir).filter((name) => /^v\d/.test(name))
  } catch {
    return null
  }
  const byNewest = versions.sort(compareVersionsDescending)
  let alias = ''
  try {
    alias = readFileSync(join(nvmDir, 'alias', 'default'), 'utf8').trim()
  } catch {
    // No default alias: the newest version.
  }
  const wanted = alias.replace(/^v/, '')
  const chosen =
    (wanted &&
      byNewest.find(
        (version) =>
          version.slice(1) === wanted ||
          version.slice(1).startsWith(`${wanted}.`),
      )) ||
    byNewest[0]
  if (!chosen) return null
  const bin = join(versionsDir, chosen, 'bin')
  return existsSync(join(bin, 'node')) ? bin : null
}

function compareVersionsDescending(left: string, right: string): number {
  const parse = (value: string) => value.slice(1).split('.').map(Number)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

function run(
  command: string,
  args: string[],
  home: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
        timeout: 3_000,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    )
  })
}

async function gitIdentity(
  home: string,
): Promise<{ name?: string; email?: string }> {
  const [name, email] = await Promise.all([
    run('git', ['config', '--global', '--get', 'user.name'], home),
    run('git', ['config', '--global', '--get', 'user.email'], home),
  ])
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) }
}

async function ghToken(home: string): Promise<string | null> {
  return await run('gh', ['auth', 'token'], home)
}
