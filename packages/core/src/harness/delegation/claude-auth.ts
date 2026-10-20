import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeTokenKind } from './claude-tokens'
import type { LoginShellEnvironment } from './login-shell'
import type { ExecutorAuthState } from './types'

/**
 * Claude Code sign-in (AGT-02). The sources, in order; the first one that
 * holds a credential supplies all of it, so a key never rides along from
 * another source:
 *  ① a token pasted into Emperor (设置 › 子智能体 › 设置令牌), sealed with
 *     Emperor's local key (claude-tokens.ts);
 *  ② `env` in ~/.claude/settings.json;
 *  ③ `.credentials.json`: its access token only (the refresh token stays
 *     with the user's own CLI); an expired one is skipped and reported,
 *     one that expires within ten minutes is used with a warning;
 *  ④ the environment Emperor started with, then the login shell (read
 *     once, whitelisted names only: a Dock launch never sees ~/.zshrc).
 * The macOS Keychain is never read. Loaded on a Claude run's first
 * prepare, not at startup.
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
  stored: () => { kind: ClaudeTokenKind; token: string } | null
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
        auth: { source: 'emperor', kind: stored.kind },
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
