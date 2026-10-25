import { spawn } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { assertNotNewerSync, durableReplaceSync } from '../../store/persistence'
import type { SecretSealer } from '../../security/secret-sealer'
import { installClaudeSecurity } from './claude-keychain'
import type { LoginShellEnvironment } from './login-shell'
import type { ManagedAgentProcess } from './process'
import {
  DelegationError,
  ExecutorAuthError,
  type ExecutorAuthState,
} from './types'

/**
 * Claude Code signs in with its own, unmodified login (AGT-12). Anthropic's
 * terms let a product run the user's installed claude, which the user signs
 * in to through Anthropic's own flow; a product may not collect, store or
 * pass on Claude.ai credentials. So:
 *
 * - every Claude Code process Emperor starts — a run, `claude auth status`,
 *   `claude auth login` (FIX-11: started by Core, finished in the browser),
 *   `claude auth logout` — uses one
 *   dedicated CLAUDE_CONFIG_DIR and HOME under Emperor Home
 *   ({@link claudeDirectories}); claude keeps its login there, in
 *   `.credentials.json` (macOS has no login keychain under that HOME, and
 *   the `security` first on PATH answers claude's keychain calls as
 *   unavailable instead of raising the system dialog: claude-keychain.ts,
 *   FIX-19), and Emperor never reads it;
 * - Emperor asks claude whether it is signed in (`claude auth status`,
 *   JSON) and reports the method and account, nothing token-like;
 * - besides that sign-in Emperor passes only the user's own API
 *   credentials: an API key saved in 设置 › 子智能体 › 使用 API Key
 *   ({@link ClaudeKeyStore}), and ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 *   (with ANTHROPIC_BASE_URL, e.g. a third-party Anthropic-compatible
 *   endpoint) from ~/.claude/settings.json `env`, the environment Emperor
 *   started with or the login shell. Never CLAUDE_CODE_OAUTH_TOKEN, never a
 *   Claude.ai token under any name, never ~/.claude/.credentials.json.
 *
 * Loaded with a Claude run's first prepare or a settings check, not at start.
 */

export const CLAUDE_CODE_STATE = 'claude-code'

export interface ClaudeDirectories {
  /** `<delegations>/claude-code` */
  root: string
  /** CLAUDE_CONFIG_DIR: claude's settings, sessions and login. */
  config: string
  /** HOME (and XDG folders) for every Claude Code process. */
  home: string
  /** First on PATH: the `security` that keeps claude off the keychain. */
  bin: string
}

export function claudeDirectories(root: string): ClaudeDirectories {
  const base = join(root, CLAUDE_CODE_STATE)
  return {
    root: base,
    config: join(base, 'config'),
    home: join(base, 'home'),
    bin: join(base, 'bin'),
  }
}

/**
 * The folders, private to the user (0700), and the `security` in `bin`
 * (FIX-19); safe to call from every run.
 */
export function prepareClaudeDirectories(root: string): ClaudeDirectories {
  const dirs = claudeDirectories(root)
  for (const dir of [dirs.root, dirs.config, dirs.home, dirs.bin]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  installClaudeSecurity(dirs.bin)
  return dirs
}

/**
 * What every Claude Code process gets, so its login is found again; and
 * none of them updates the user's claude behind their back (VER-03).
 */
export function claudeProcessEnvironment(
  dirs: ClaudeDirectories,
): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: dirs.config,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: join(dirs.home, '.config'),
    XDG_CACHE_HOME: join(dirs.home, '.cache'),
    DISABLE_AUTOUPDATER: '1',
  }
}

/**
 * Sessions an earlier build kept in a run's own `claude` folder move into
 * the dedicated one, where `claude --resume` and the history reader look.
 * Existing files are never overwritten; a failure only costs the resume.
 */
export function adoptLegacyClaudeSessions(
  runtimeRoot: string,
  dirs: ClaudeDirectories,
): void {
  const legacy = join(runtimeRoot, 'claude')
  if (!existsSync(legacy)) return
  try {
    const projects = join(legacy, 'projects')
    if (existsSync(projects))
      cpSync(projects, join(dirs.config, 'projects'), {
        recursive: true,
        force: false,
        errorOnExist: false,
      })
    rmSync(legacy, { recursive: true, force: true })
  } catch {
    /* The run starts a new session when resume cannot find the old one. */
  }
}

// ── The user's own API credentials ─────────────────────────────────────

/** In claude's order: a bearer token outranks an API key. */
const CREDENTIAL_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const
const KIND = {
  ANTHROPIC_AUTH_TOKEN: 'auth-token',
  ANTHROPIC_API_KEY: 'api-key',
} as const
/** All the login shell is asked for. */
export const CLAUDE_SHELL_KEYS: readonly string[] = [
  ...CREDENTIAL_KEYS,
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
]
export const isClaudeCredentialKey = (key: string): boolean =>
  (CREDENTIAL_KEYS as readonly string[]).includes(key)
/**
 * A Claude.ai OAuth access or refresh token (`sk-ant-oat…`, `sk-ant-ort…`):
 * claude's own sign-in, never Emperor's to pass on, whatever it is called.
 */
export const isClaudeAiToken = (value: string): boolean =>
  /^\s*sk-ant-o[ar]t/i.test(value)

export interface StoredKey {
  token: string
  last4: string
}

interface ClaudeResolved {
  variables: Record<string, string>
  auth: ExecutorAuthState
}

function found(
  env: Record<string, unknown>,
  source: ExecutorAuthState['source'],
): ClaudeResolved | undefined {
  const variables: Record<string, string> = {}
  for (const key of CREDENTIAL_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value && !isClaudeAiToken(value))
      variables[key] = value
  }
  const first = CREDENTIAL_KEYS.find((key) => variables[key])
  return first ? { variables, auth: { source, kind: KIND[first] } } : undefined
}

/**
 * The API credential Emperor passes, from the first source that has one:
 * ① the key saved in Emperor, ② ~/.claude/settings.json `env`, ③ the
 * environment Emperor started with, ④ the login shell. One source supplies
 * all of it; none of them: claude uses its own sign-in.
 */
export async function resolveClaudeCredential(input: {
  stored: () => StoredKey | null
  settingsEnv: Record<string, unknown>
  ambient: NodeJS.ProcessEnv
  loginShell?: LoginShellEnvironment
}): Promise<ClaudeResolved> {
  let problem: 'unreadable' | undefined
  try {
    const stored = input.stored()
    if (stored)
      return {
        variables: { ANTHROPIC_API_KEY: stored.token },
        auth: { source: 'emperor', kind: 'api-key', last4: stored.last4 },
      }
  } catch {
    // Sealed under a key that is gone or changed: the user sets it again.
    problem = 'unreadable'
  }
  const settings = found(input.settingsEnv, 'settings')
  if (settings) return settings
  const ambient = found(input.ambient, 'environment')
  if (ambient) return ambient
  if (input.loginShell) {
    const shell = await input.loginShell.read(CLAUDE_SHELL_KEYS)
    const login = found(shell, 'login-shell')
    if (login)
      return {
        ...login,
        variables: {
          ...Object.fromEntries(
            Object.entries(shell).filter(
              ([key, value]) =>
                !isClaudeCredentialKey(key) && !isClaudeAiToken(value),
            ),
          ),
          ...login.variables,
        },
      }
  }
  return { variables: {}, auth: { source: null, ...(problem && { problem }) } }
}

// ── claude auth status / logout ────────────────────────────────────────

export type ClaudeAuthMethod = NonNullable<ExecutorAuthState['method']>

export interface ClaudeAuthStatus {
  loggedIn: boolean
  method: ClaudeAuthMethod
  provider?: string
  email?: string
  organization?: string
  subscription?: string
  apiKeySource?: string
  configDirectory?: string
}

const METHODS: ReadonlySet<string> = new Set([
  'claude.ai',
  'oauth_token',
  'api_key',
  'api_key_helper',
  'third_party',
  'none',
])

const statusFailed = (detail: string) =>
  new DelegationError('AUTH_STATUS_FAILED', detail)

/**
 * `claude auth status` (2.1.41+): JSON, exit 0 signed in and 1 not. Only
 * the method, provider, account names and folder are kept — never an
 * identifier or anything that looks like a credential.
 */
export function parseClaudeAuthStatus(
  stdout: string,
  exitCode: number | null,
): ClaudeAuthStatus {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw statusFailed('claude auth status did not print JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw statusFailed('claude auth status printed an unexpected value')
  const raw = value as Record<string, unknown>
  if (typeof raw.loggedIn !== 'boolean' || typeof raw.authMethod !== 'string')
    throw statusFailed('claude auth status has no loggedIn or authMethod')
  const text = (key: string): string | undefined => {
    const field = raw[key]
    // Names and folders only: nothing that reads like a key or token.
    return typeof field === 'string' &&
      field.trim() &&
      !/sk-ant-/i.test(field) &&
      !/^[\w.~+=-]{64,}$/.test(field.trim())
      ? field.trim().slice(0, 256)
      : undefined
  }
  const fields: Array<[keyof ClaudeAuthStatus, string]> = [
    ['provider', 'apiProvider'],
    ['configDirectory', 'configDirectory'],
    ['email', 'email'],
    ['organization', 'orgName'],
    ['subscription', 'subscriptionType'],
    ['apiKeySource', 'apiKeySource'],
  ]
  const status: ClaudeAuthStatus = {
    loggedIn: raw.loggedIn && exitCode === 0,
    method: (METHODS.has(raw.authMethod)
      ? raw.authMethod
      : 'other') as ClaudeAuthMethod,
  }
  for (const [name, key] of fields) {
    const field = text(key)
    if (field) (status as unknown as Record<string, string>)[name] = field
  }
  return status
}

/** What a Claude Code process needs from a prepared runtime. */
export interface ClaudeRuntime {
  environment: Record<string, string>
  runtimeRoot: string
  tempRoot: string
  stateRoots: string[]
  secretValues?: readonly string[]
  auth?: ExecutorAuthState
}

/**
 * claude's own login file in its folder (written when the Keychain refuses
 * it): closed to every other process by the protected-path table, opened
 * again for Claude Code itself.
 */
export function claudeLoginFile(runtime: Pick<ClaudeRuntime, 'environment'>) {
  const config = runtime.environment.CLAUDE_CONFIG_DIR
  return config ? join(config, '.credentials.json') : undefined
}

/** One short claude command in the run's environment and sandbox. */
async function runClaude(input: {
  executable: string
  args: string[]
  runtime: ClaudeRuntime
  processes: ManagedAgentProcess
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<{ stdout: string; exitCode: number | null }> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) controller.abort()
  const timer = setTimeout(abort, input.timeoutMs ?? 20_000)
  timer.unref?.()
  try {
    const login = claudeLoginFile(input.runtime)
    const handle = input.processes.spawn({
      executable: input.executable,
      args: input.args,
      cwd: input.runtime.runtimeRoot,
      env: { ...input.runtime.environment },
      policy: {
        mode: 'read-only',
        workspaceRoot: input.runtime.runtimeRoot,
        runtimeStateRoots: input.runtime.stateRoots,
        privateTempRoot: input.runtime.tempRoot,
        ...(login ? { writableFiles: [login] } : {}),
      },
      signal: controller.signal,
      secretValues: input.runtime.secretValues ?? [],
      maxFrameBytes: 256 * 1024,
    })
    handle.started.catch(() => undefined)
    handle.stdin.end()
    const chunks: Buffer[] = []
    let size = 0
    handle.stdout.on('data', (chunk: Buffer) => {
      if (size >= 64 * 1024) return
      chunks.push(chunk)
      size += chunk.length
    })
    const ended = new Promise<void>((resolve) => {
      handle.stdout.once('end', resolve)
      handle.stdout.once('close', resolve)
      handle.stdout.once('error', () => resolve())
    })
    const receipt = await handle.closed
    await Promise.race([ended, new Promise((r) => setTimeout(r, 1000))])
    if (receipt.failureCode === 'SPAWN_ERROR')
      throw statusFailed('claude could not be started')
    return {
      stdout: Buffer.concat(chunks).toString('utf8'),
      exitCode: receipt.exitCode,
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abort)
  }
}

/** What the parent model is told when Claude Code is not signed in. */
export function signInMissing(_auth: ExecutorAuthState): string {
  return 'Claude Code is not signed in; ask the user to open Settings › 子智能体 › Claude Code and choose 登录 Claude Code (or 使用 API Key)'
}

/**
 * `claude auth status` in the run's own environment: the method and
 * account claude reports, on top of the credential Emperor passes. Throws
 * ExecutorAuthError: AUTH_REQUIRED when claude is not signed in,
 * AUTH_STATUS_FAILED when it did not answer.
 */
export async function checkClaudeSignIn(input: {
  executable: string
  runtime: ClaudeRuntime
  processes: ManagedAgentProcess
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<ExecutorAuthState> {
  const base: ExecutorAuthState = input.runtime.auth ?? { source: null }
  let status: ClaudeAuthStatus
  try {
    const result = await runClaude({ ...input, args: ['auth', 'status'] })
    status = parseClaudeAuthStatus(result.stdout, result.exitCode)
  } catch (error) {
    throw new ExecutorAuthError(
      { ...base, problem: 'status-failed' },
      error instanceof DelegationError
        ? error.message.replace(/^[A-Z_]+: /, '')
        : 'claude auth status did not answer',
      'AUTH_STATUS_FAILED',
    )
  }
  const auth: ExecutorAuthState = {
    ...base,
    method: status.method,
    ...(status.email && { email: status.email }),
    ...(status.organization && { organization: status.organization }),
    ...(status.subscription && { subscription: status.subscription }),
  }
  if (!status.loggedIn)
    throw new ExecutorAuthError(
      { ...auth, problem: base.problem ?? 'missing' },
      signInMissing(auth),
    )
  return auth
}

/** 退出登录: `claude auth logout` in the same environment. */
export async function signOutClaude(input: {
  executable: string
  runtime: ClaudeRuntime
  processes: ManagedAgentProcess
  signal?: AbortSignal
}): Promise<void> {
  let exitCode: number | null
  try {
    exitCode = (await runClaude({ ...input, args: ['auth', 'logout'] }))
      .exitCode
  } catch {
    exitCode = null
  }
  if (exitCode !== 0)
    throw new DelegationError(
      'AUTH_SIGN_OUT_FAILED',
      'claude auth logout did not finish',
    )
}

// ── 登录 Claude Code: claude's own `auth login`, started by Core ────────

/**
 * How long a sign-in may wait for the browser before Emperor stops it
 * (claude waits for the browser's callback, or for a code it never gets).
 */
export const CLAUDE_SIGN_IN_TIMEOUT_MS = 10 * 60_000
/** After SIGTERM to the sign-in's process group, how long until SIGKILL. */
const SIGN_IN_GRACE_MS = 3_000

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
/** What a shell may export that claude would sign in with instead. */
const SIGN_IN_UNSET = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const
/**
 * The folders that make the login the one every run finds again, and the
 * PATH that puts Emperor's `security` first (FIX-19).
 */
const SIGN_IN_ENVIRONMENT = [
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'PATH',
] as const

const signInArgs = (console: boolean) =>
  console ? ['auth', 'login', '--console'] : ['auth', 'login']

/**
 * The run's environment for `claude auth login`: the same folders (and
 * PATH, locale, proxy), without any credential claude would sign in with
 * instead, and without the run's endpoint and model — signing in is with
 * Anthropic, whatever a run talks to.
 */
export function claudeSignInEnvironment(
  environment: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !key.startsWith('ANTHROPIC_') &&
        !key.startsWith('CLAUDE_CODE_OAUTH_') &&
        !key.startsWith('EMPEROR_'),
    ),
  )
}

/**
 * 备用 for a sign-in that did not finish: the same login as one line the
 * user pastes into their own Terminal — the dedicated folders, no
 * credential variables, the installed claude's `auth login`.
 */
export function claudeSignInCommand(input: {
  executable: string
  environment: Record<string, string>
  console: boolean
}): string {
  return [
    'env',
    ...SIGN_IN_UNSET.flatMap((key) => ['-u', key]),
    ...SIGN_IN_ENVIRONMENT.filter((key) => input.environment[key]).map(
      (key) => `${key}=${shellQuote(input.environment[key]!)}`,
    ),
    shellQuote(input.executable),
    ...signInArgs(input.console),
  ].join(' ')
}

/** How a `claude auth login` ended. */
export interface ClaudeLoginOutcome {
  /**
   * `exit`: claude ended by itself (`exitCode` says how); `timeout` and
   * `cancelled`: Emperor stopped it; `start`: it could not be started.
   */
  ended: 'exit' | 'timeout' | 'cancelled' | 'start'
  exitCode: number | null
}

/** A running `claude auth login`. */
export interface ClaudeLogin {
  /** False when claude could not be started (`done` has already settled). */
  readonly started: boolean
  readonly done: Promise<ClaudeLoginOutcome>
  /** Stops claude and everything it started (its process group). */
  cancel(): Promise<ClaudeLoginOutcome>
}

/**
 * 登录 Claude Code (FIX-11): the installed claude's own `auth login`
 * (`--console` for API billing), started by Core instead of in macOS
 * Terminal — a shell's startup (oh-my-zsh asking to update) could swallow
 * what Terminal typed. claude opens the browser and the sign-in calls back
 * to claude itself on localhost: Emperor never sees a link, a code or a
 * token. So:
 *
 * - the run's folders, no credential variables ({@link claudeSignInEnvironment});
 * - not in the sandbox (as in Terminal): it opens the browser and listens
 *   on localhost;
 * - its own process group, so 取消 and the time limit stop all of it;
 * - stdin is a pipe that is never written or closed while it runs (claude
 *   waits on it for a code only if the browser did not open);
 * - stdout and stderr are drained and dropped, never read, logged or shown.
 *
 * Resolves once claude is running, or could not start.
 */
export async function startClaudeLogin(input: {
  executable: string
  /** The run's environment (a profile probe's). */
  environment: Record<string, string>
  cwd: string
  console: boolean
  timeoutMs?: number
  graceMs?: number
  /** Test hook. */
  spawn?: typeof spawn
}): Promise<ClaudeLogin> {
  const child = (input.spawn ?? spawn)(
    input.executable,
    signInArgs(input.console),
    {
      cwd: input.cwd,
      env: claudeSignInEnvironment(input.environment),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
      windowsHide: true,
    },
  )
  const ignore = () => undefined
  child.stdin?.on('error', ignore)
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('error', ignore)
    stream?.resume()
  }
  const grace = input.graceMs ?? SIGN_IN_GRACE_MS
  let stopping: 'timeout' | 'cancelled' | undefined,
    finished = false,
    killTimer: ReturnType<typeof setTimeout> | undefined
  let settle!: (outcome: ClaudeLoginOutcome) => void
  const done = new Promise<ClaudeLoginOutcome>((resolve) => {
    settle = resolve
  })
  const live = () =>
    !finished && child.exitCode === null && child.signalCode === null
  /** While claude is unreaped its pid, and so its group id, is ours. */
  const signalGroup = (kind: NodeJS.Signals) => {
    if (!child.pid) return
    try {
      process.kill(-child.pid, kind)
    } catch {
      /* The group is gone. */
    }
  }
  const stop = (why: 'timeout' | 'cancelled') => {
    if (stopping || !live()) return
    stopping = why
    signalGroup('SIGTERM')
    killTimer = setTimeout(() => {
      if (live()) signalGroup('SIGKILL')
    }, grace)
    killTimer.unref?.()
  }
  const timer = setTimeout(
    () => stop('timeout'),
    input.timeoutMs ?? CLAUDE_SIGN_IN_TIMEOUT_MS,
  )
  timer.unref?.()
  const finish = (outcome: ClaudeLoginOutcome) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    // Stopped: whatever claude started goes with it. The group id stays
    // reserved while any member lives, so this reaches only its own.
    if (stopping) signalGroup('SIGKILL')
    child.stdin?.destroy()
    child.stdout?.destroy()
    child.stderr?.destroy()
    settle(outcome)
  }
  let spawned = false,
    began!: (value: boolean) => void
  const started = new Promise<boolean>((resolve) => {
    began = resolve
  })
  child.once('spawn', () => {
    spawned = true
    began(true)
  })
  const notStarted = () => {
    finish({ ended: 'start', exitCode: null })
    began(false)
  }
  child.on('error', () => {
    // Only a failure to start ends it here; claude's own exit says the rest.
    if (!spawned) notStarted()
  })
  child.once('exit', (code) => {
    if (!spawned) return notStarted()
    finish({ ended: stopping ?? 'exit', exitCode: code })
  })
  return {
    started: await started,
    done,
    cancel: () => {
      stop('cancelled')
      return done
    },
  }
}

/**
 * Earlier 0.2 builds wrote 登录 Claude Code scripts for Terminal into
 * `<delegations>/claude-code/sign-in/`; ones a shell never ran stayed
 * there. Removed at start, then the folder (FIX-11).
 */
export function removeSignInScripts(root: string): void {
  const folder = join(claudeDirectories(root).root, 'sign-in')
  try {
    for (const name of readdirSync(folder))
      if (name.endsWith('.command')) rmSync(join(folder, name), { force: true })
    rmSync(folder, { recursive: true, force: true })
  } catch {
    /* Nothing left behind. */
  }
}

// ── 使用 API Key: the one credential Emperor keeps ─────────────────────

interface KeyRow {
  kind: string
  value: string
  last4: string
}
interface KeyFile {
  schemaVersion: 1
  tokens: Record<string, KeyRow>
  /** An upgrade removed a Claude token: 设置 › 子智能体 says so once. */
  notice?: 'claude-sign-in'
}

/**
 * API keys the user gives Emperor for Claude Code (使用 API Key), one per
 * profile, in `<delegations>/credentials.json` (0600): each an `el1:`
 * envelope of Emperor's local key (LocalSecretStore, SEC-06/SEC-09), bound
 * to the profile; only the last four characters stay in the clear. Earlier
 * builds also kept Claude.ai tokens here; {@link migrate} deletes them.
 */
export class ClaudeKeyStore {
  readonly file: string
  constructor(
    private readonly options: { root: string; sealer: SecretSealer },
  ) {
    this.file = join(options.root, 'credentials.json')
  }
  private load(): KeyFile {
    if (!existsSync(this.file)) return { schemaVersion: 1, tokens: {} }
    const value = JSON.parse(
      readFileSync(this.file, 'utf8'),
    ) as Partial<KeyFile>
    return {
      ...value,
      schemaVersion: 1,
      tokens:
        value.tokens && typeof value.tokens === 'object' ? value.tokens : {},
    }
  }
  private write(file: KeyFile): void {
    durableReplaceSync(this.file, JSON.stringify(file, null, 2) + '\n')
  }
  private context(profileId: string) {
    return `delegations/credentials.json#${profileId}.api-key`
  }
  /** Throws when the value cannot be opened (the local key changed). */
  read(profileId: string): StoredKey | null {
    const rows = this.load().tokens
    const row = Object.hasOwn(rows, profileId) ? rows[profileId] : undefined
    if (!row || row.kind !== 'api-key') return null
    const token = this.options.sealer.open(row.value, this.context(profileId))
    return isClaudeAiToken(token) ? null : { token, last4: row.last4 }
  }
  clear(profileId: string): void {
    this.set(profileId)
  }
  set(profileId: string, token?: string): void {
    // A newer Emperor's file is read-only here (REL-03): refuse, never replace.
    assertNotNewerSync(this.file, 'schemaVersion', 1)
    let file: KeyFile
    try {
      file = this.load()
    } catch {
      file = { schemaVersion: 1, tokens: {} } // A damaged file holds nothing usable.
    }
    delete file.tokens[profileId]
    if (token)
      file.tokens[profileId] = {
        kind: 'api-key',
        value: this.options.sealer.seal(token, this.context(profileId)),
        last4: token.slice(-4),
      }
    this.write(file)
  }
  /**
   * Upgrade (AGT-12): delete every Claude.ai token an earlier build saved
   * (pasted into its settings) and leave the notice. True when something
   * was deleted.
   */
  migrate(): boolean {
    let file: KeyFile
    try {
      assertNotNewerSync(this.file, 'schemaVersion', 1)
      if (!existsSync(this.file)) return false
      file = this.load()
    } catch {
      return false
    }
    const stale = Object.keys(file.tokens).filter(
      (id) => file.tokens[id]?.kind !== 'api-key',
    )
    if (!stale.length) return false
    for (const id of stale) delete file.tokens[id]
    file.notice = 'claude-sign-in'
    this.write(file)
    return true
  }
  noticePending(): boolean {
    try {
      return this.load().notice === 'claude-sign-in'
    } catch {
      return false
    }
  }
  dismissNotice(): void {
    assertNotNewerSync(this.file, 'schemaVersion', 1)
    const file = this.load()
    if (!file.notice) return
    delete file.notice
    this.write(file)
  }
}
