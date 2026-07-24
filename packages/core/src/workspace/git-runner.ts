import { devNull } from 'node:os'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
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

export class HardenedGitRunner {
  constructor(private readonly options: HardenedGitRunnerOptions) {}

  async execute(
    cwd: string,
    args: string[],
    options: {
      stdin?: string
      network?: boolean
      allowedExitCodes?: number[]
    } = {},
  ): Promise<GitCommandResult> {
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
    const result = await this.options.run({
      executable: runtime.executable,
      args: [
        '--no-pager',
        '-c',
        `core.hooksPath=${devNull}`,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.external=',
        '-c',
        'diff.trustExitCode=false',
        ...args,
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
      },
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
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
