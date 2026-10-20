import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNotNewerSync, durableReplaceSync } from '../../store/persistence'
import type { SecretSealer } from '../../security/secret-sealer'
import type { LoginShellEnvironment } from './login-shell'
import type { ExecutorAuthState } from './types'

/**
 * Claude Code sign-in (AGT-02). The sources, in order; the first one that
 * holds a credential supplies all of it, so a key never rides along from
 * another source:
 *  ① a token pasted into Emperor (设置 › 子智能体 › 设置令牌), sealed with
 *     Emperor's local key ({@link ClaudeTokenStore});
 *  ② `env` in ~/.claude/settings.json;
 *  ③ `.credentials.json`: its access token only (the refresh token stays
 *     with the user's own CLI); an expired one is skipped and reported,
 *     one that expires within ten minutes is used with a warning;
 *  ④ the environment Emperor started with, then the login shell (read
 *     once, whitelisted names only: a Dock launch never sees ~/.zshrc).
 * The macOS Keychain is never read. The module loads with a Claude
 * run's first prepare or a 设置令牌, not at startup.
 */
const CREDENTIAL_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const
const KIND = {
  ANTHROPIC_AUTH_TOKEN: 'auth-token',
  ANTHROPIC_API_KEY: 'api-key',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
} as const
/** All the login shell may contribute. */
export const CLAUDE_SHELL_KEYS: readonly string[] = [
  ...CREDENTIAL_KEYS,
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
]
export const isClaudeCredentialKey = (key: string) =>
  (CREDENTIAL_KEYS as readonly string[]).includes(key)
const EXPIRY_WARNING_MS = 10 * 60_000
export type ClaudeTokenKind = 'oauth-token' | 'api-key'
interface StoredToken {
  kind: ClaudeTokenKind
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
  for (const key of CREDENTIAL_KEYS)
    if (typeof env[key] === 'string' && env[key]) variables[key] = env[key]
  const first = CREDENTIAL_KEYS.find((key) => variables[key])
  return first ? { variables, auth: { source, kind: KIND[first] } } : undefined
}

export async function resolveClaudeCredential(input: {
  stored: () => StoredToken | null
  settingsEnv: Record<string, unknown>
  /** Where `.credentials.json` lives: CLAUDE_CONFIG_DIR or ~/.claude. */
  configDirectory: string
  ambient: NodeJS.ProcessEnv
  loginShell?: LoginShellEnvironment
  now?: number
}): Promise<ClaudeResolved> {
  const now = input.now ?? Date.now()
  let problem: ExecutorAuthState['problem'] = 'missing',
    expiresAt: number | undefined
  try {
    const stored = input.stored()
    if (stored)
      return {
        variables: {
          [stored.kind === 'api-key'
            ? 'ANTHROPIC_API_KEY'
            : 'CLAUDE_CODE_OAUTH_TOKEN']: stored.token,
        },
        auth: { source: 'emperor', kind: stored.kind, last4: stored.last4 },
      }
  } catch {
    // Sealed under a key that is gone or changed: the user sets it again.
    problem = 'unreadable'
  }
  const settings = found(input.settingsEnv, 'settings')
  if (settings) return settings
  try {
    const oauth = (
      JSON.parse(
        readFileSync(join(input.configDirectory, '.credentials.json'), 'utf8'),
      ) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }
    ).claudeAiOauth
    const at =
      typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined
    if (typeof oauth?.accessToken === 'string' && oauth.accessToken) {
      if (at !== undefined && at <= now) {
        problem = 'expired'
        expiresAt = at
      } else
        return {
          variables: { CLAUDE_CODE_OAUTH_TOKEN: oauth.accessToken },
          auth: {
            source: 'credentials-file',
            kind: 'oauth-token',
            ...(at === undefined
              ? {}
              : { expiresAt: at, expiresSoon: at - now <= EXPIRY_WARNING_MS }),
          },
        }
    }
  } catch {
    /* No file, or not one this build reads: the next source. */
  }
  const ambient = found(input.ambient, 'environment')
  if (ambient) return ambient
  if (input.loginShell) {
    const shell = await input.loginShell.read(CLAUDE_SHELL_KEYS)
    const login = found(shell, 'login-shell')
    if (login) return { ...login, variables: { ...shell } }
  }
  return {
    variables: {},
    auth: { source: null, problem, ...(expiresAt ? { expiresAt } : {}) },
  }
}

/** What the parent model is told when Claude Code has no sign-in. */
export function signInMissing(auth: ExecutorAuthState): string {
  return (
    (auth.problem === 'expired'
      ? 'the Claude Code token in .credentials.json has expired'
      : auth.problem === 'unreadable'
        ? 'the token saved in Emperor can no longer be read'
        : 'Claude Code has no usable sign-in') +
    '; ask the user to run `claude setup-token` in a terminal and paste the token (or an ANTHROPIC_API_KEY) under Settings › 子智能体 › Claude Code › 设置令牌'
  )
}

/**
 * Tokens pasted into 设置 › 子智能体, one per Claude profile, in
 * `<delegations>/credentials.json` (0600). Each value is an `el1:`
 * envelope of the local key Emperor uses for model keys and the
 * credential vault (LocalSecretStore, SEC-06/SEC-09), bound to the
 * profile and kind; only the last four characters stay in the clear.
 */
export class ClaudeTokenStore {
  readonly file: string
  constructor(
    private readonly options: { root: string; sealer: SecretSealer },
  ) {
    this.file = join(options.root, 'credentials.json')
  }
  private rows(): Record<
    string,
    { kind: ClaudeTokenKind; value: string; last4: string }
  > {
    if (!existsSync(this.file)) return {}
    return (
      (JSON.parse(readFileSync(this.file, 'utf8')) as { tokens?: never })
        .tokens ?? {}
    )
  }
  private context(profileId: string, kind: ClaudeTokenKind) {
    return `delegations/credentials.json#${profileId}.${kind}`
  }
  /** Throws when the value cannot be opened (the local key changed). */
  read(profileId: string): StoredToken | null {
    const rows = this.rows()
    const row = Object.hasOwn(rows, profileId) ? rows[profileId] : undefined
    if (!row) return null
    const token = this.options.sealer.open(
      row.value,
      this.context(profileId, row.kind),
    )
    return { kind: row.kind, token, last4: row.last4 }
  }
  clear(profileId: string): void {
    this.set(profileId)
  }
  set(profileId: string, kind?: ClaudeTokenKind, token = ''): void {
    // A newer Emperor's file is read-only here (REL-03): refuse, never replace.
    assertNotNewerSync(this.file, 'schemaVersion', 1)
    let rows
    try {
      rows = this.rows()
    } catch {
      rows = {} // A damaged file holds nothing usable.
    }
    delete rows[profileId]
    if (kind)
      rows[profileId] = {
        kind,
        value: this.options.sealer.seal(token, this.context(profileId, kind)),
        last4: token.slice(-4),
      }
    durableReplaceSync(
      this.file,
      JSON.stringify({ schemaVersion: 1, tokens: rows }, null, 2) + '\n',
    )
  }
}
