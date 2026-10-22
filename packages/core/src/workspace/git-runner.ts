import { devNull } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { WorkspaceOperationError } from './common'

export interface GitRuntime {
  executable: string
  env: Record<string, string>
}

export interface GitCommandRequest {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
  stdin?: string
  /** Overrides the host's default time limit for this command. */
  timeoutMs?: number
}

export interface GitCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

export interface HardenedGitRunnerOptions {
  resolveRuntime: (projectRoot: string) => Promise<GitRuntime>
  run: (request: GitCommandRequest) => Promise<GitCommandResult>
  privateHome?: string
}

const NETWORK_COMMANDS = new Set([
  'fetch',
  'pull',
  'push',
  'ls-remote',
  'clone',
  'submodule',
])
/**
 * Variables a caller may add for one command: a temporary index (turn
 * snapshots) and the identity of the commits they write.
 */
const COMMAND_ENV = new Set([
  'GIT_INDEX_FILE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
])
const ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
])

/**
 * Repository-local configuration keys that make git run a program. Emperor's
 * own git commands (turn snapshots, review, worktrees, delegation) never let
 * a repository decide what runs on the user's machine: each key found in the
 * effective config is overridden with a neutral value. System and global
 * config are already off (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL).
 */
const EXECUTING_CONFIG =
  '^(filter\\..+\\.(clean|smudge|process|required)' +
  '|diff\\..+\\.(textconv|command)' +
  '|merge\\..+\\.driver' +
  '|core\\.(fsmonitor|hookspath|sshcommand|askpass|gitproxy|editor|pager|alternaterefscommand|attributesfile)' +
  '|credential\\..*helper' +
  '|gpg\\.(.+\\.)?program' +
  '|(commit|tag|push)\\.gpgsign' +
  '|sequence\\.editor' +
  '|remote\\..+\\.(uploadpack|receivepack|proxy|vcs)' +
  '|ssh\\.variant)$'

/** The neutral value that disables one executing key. */
export function neutralGitConfigValue(key: string): string {
  const lower = key.toLowerCase()
  if (/^filter\..+\.required$/.test(lower)) return 'false'
  if (/\.gpgsign$/.test(lower)) return 'false'
  if (lower === 'core.fsmonitor') return 'false'
  if (lower === 'core.hookspath' || lower === 'core.attributesfile')
    return devNull
  if (lower === 'core.pager') return 'cat'
  // An empty textconv makes git try to run "", so convert by identity.
  if (/^diff\..+\.textconv$/.test(lower)) return 'cat'
  if (/^remote\..+\.uploadpack$/.test(lower)) return 'git-upload-pack'
  if (/^remote\..+\.receivepack$/.test(lower)) return 'git-receive-pack'
  if (lower === 'ssh.variant') return 'ssh'
  return ''
}

/** Keys from `git config --null --get-regexp` output (`key\nvalue\0`…). */
export function parseConfigKeys(stdout: string): string[] {
  const keys = new Set<string>()
  for (const entry of stdout.split('\0')) {
    const key = entry.split('\n', 1)[0]?.trim()
    if (key) keys.add(key)
  }
  return [...keys]
}

function insideRepository(cwd: string): boolean {
  let current = resolve(cwd)
  for (;;) {
    if (existsSync(join(current, '.git'))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

const CONFIG_SCAN_TTL_MS = 1_500

export class HardenedGitRunner {
  private readonly configScans = new Map<
    string,
    { at: number; overrides: string[] }
  >()

  constructor(private readonly options: HardenedGitRunnerOptions) {}

  /** `-c key=neutral` pairs for every executing key the repository sets. */
  private async neutralizeRepositoryConfig(
    cwd: string,
    runtime: GitRuntime,
    env: Record<string, string>,
  ): Promise<string[]> {
    if (!insideRepository(cwd)) return []
    const cached = this.configScans.get(cwd)
    if (cached && Date.now() - cached.at < CONFIG_SCAN_TTL_MS)
      return cached.overrides
    const scan = await this.options.run({
      executable: runtime.executable,
      args: [
        '--no-pager',
        'config',
        '--null',
        '--get-regexp',
        EXECUTING_CONFIG,
      ],
      cwd,
      env,
    })
    // Exit 1 means no key matched; anything else is a broken config, which
    // the real command will report on its own.
    const overrides =
      scan.exitCode === 0
        ? parseConfigKeys(scan.stdout).flatMap((key) => [
            '-c',
            `${key}=${neutralGitConfigValue(key)}`,
          ])
        : []
    this.configScans.set(cwd, { at: Date.now(), overrides })
    return overrides
  }

  async execute(
    cwd: string,
    args: string[],
    options: {
      stdin?: string
      network?: boolean
      allowedExitCodes?: number[]
      env?: Record<string, string>
      timeoutMs?: number
    } = {},
  ): Promise<GitCommandResult> {
    const extra = Object.keys(options.env ?? {}).find(
      (key) => !COMMAND_ENV.has(key),
    )
    if (extra !== undefined)
      throw new WorkspaceOperationError(
        'git_env_not_allowed',
        `Git 命令不接受环境变量 ${extra}。`,
      )
    const subcommand = gitSubcommand(args)
    if (NETWORK_COMMANDS.has(subcommand) && options.network !== true)
      throw new WorkspaceOperationError(
        'git_network_not_authorized',
        '该 Git 操作需要显式打开网络边界。',
      )
    const runtime = await this.options.resolveRuntime(cwd)
    const privateHome = this.options.privateHome
      ? resolve(this.options.privateHome)
      : null
    if (privateHome) mkdirSync(privateHome, { recursive: true, mode: 0o700 })
    const env = Object.fromEntries(
      Object.entries(runtime.env).filter(([key]) => ENV_ALLOWLIST.has(key)),
    )
    const baseEnv: Record<string, string> = {
      ...env,
      ...(privateHome
        ? {
            HOME: privateHome,
            USERPROFILE: privateHome,
            XDG_CONFIG_HOME: resolve(privateHome, '.config'),
            XDG_CACHE_HOME: resolve(privateHome, '.cache'),
          }
        : {}),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: '0',
    }
    const repositoryOverrides = await this.neutralizeRepositoryConfig(
      cwd,
      runtime,
      baseEnv,
    )
    const result = await this.options.run({
      executable: runtime.executable,
      args: [
        '--no-pager',
        '-c',
        `core.hooksPath=${devNull}`,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'protocol.ext.allow=never',
        '-c',
        'diff.external=',
        '-c',
        'diff.trustExitCode=false',
        ...repositoryOverrides,
        ...withoutExternalDiff(args),
      ],
      cwd,
      env: {
        ...env,
        ...(privateHome
          ? {
              HOME: privateHome,
              USERPROFILE: privateHome,
              XDG_CONFIG_HOME: resolve(privateHome, '.config'),
              XDG_CACHE_HOME: resolve(privateHome, '.cache'),
            }
          : {}),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: devNull,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        GIT_EXTERNAL_DIFF: '',
        GIT_OPTIONAL_LOCKS: isReadOnlyGitCommand(args) ? '0' : '1',
        ...options.env,
      },
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    })
    const allowed = options.allowedExitCodes ?? [0]
    if (!allowed.includes(result.exitCode))
      throw new WorkspaceOperationError(
        'git_command_failed',
        sanitizeGitError(result.stderr || result.stdout) || 'Git 操作失败。',
      )
    return result
  }
}

/** diff/log/show never run an attribute-selected external diff driver. */
function withoutExternalDiff(args: string[]): string[] {
  const command = gitSubcommand(args)
  if (!['diff', 'log', 'show', 'whatchanged', 'format-patch'].includes(command))
    return args
  const at = args.indexOf(command)
  return [...args.slice(0, at + 1), '--no-ext-diff', ...args.slice(at + 1)]
}

function isReadOnlyGitCommand(args: string[]): boolean {
  const command = gitSubcommand(args)
  if (command === 'worktree')
    return String(args[args.indexOf(command) + 1] ?? '') === 'list'
  return new Set([
    'status',
    'diff',
    'log',
    'show',
    'branch',
    'for-each-ref',
    'rev-parse',
    'rev-list',
    'symbolic-ref',
    'check-ignore',
  ]).has(command)
}

function gitSubcommand(args: string[]): string {
  let index = 0
  while (index < args.length) {
    const argument = args[index] ?? ''
    if (argument === '-C' || argument === '-c') {
      index += 2
      continue
    }
    if (
      argument === '--no-pager' ||
      argument === '--literal-pathspecs' ||
      argument.startsWith('--git-dir=') ||
      argument.startsWith('--work-tree=')
    ) {
      index += 1
      continue
    }
    return argument.startsWith('-') ? '' : argument
  }
  return ''
}

export function sanitizeGitError(message: string): string {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[redacted]')
    .replace(
      /([?&](?:access_?token|token|password|passwd|key)=)[^\s&]+/gi,
      '$1[redacted]',
    )
    .replace(
      /\b((?:access_?token|token|password|passwd|secret|key)=)[^\s&]+/gi,
      '$1[redacted]',
    )
    .replace(/\b(?:ghp|github_pat|glpat)-?[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .trim()
}
