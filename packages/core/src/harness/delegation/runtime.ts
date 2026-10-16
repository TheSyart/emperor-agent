import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DelegationError, type ExecutorProfile } from './types'
import { safeDelegationKey } from './fold'
export interface ExecutorCredential {
  apiKey: string
  baseUrl?: string
  model?: string
}
const baseKeys = [
  'PATH',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]
export class ExecutorRuntimeService {
  constructor(
    private readonly options: {
      root: string
      home?: string
      environment?: NodeJS.ProcessEnv
      resolveRoute?: (
        id: string,
        backend: string,
      ) => Promise<ExecutorCredential>
    },
  ) {}
  async prepare(
    profile: ExecutorProfile,
    id: string,
  ): Promise<{
    runtimeRoot: string
    tempRoot: string
    environment: Record<string, string>
    secretValues: string[]
  }> {
    safeDelegationKey(profile.stateDirectoryId)
    safeDelegationKey(id)
    const runtimeRoot = join(
        this.options.root,
        'runtime',
        profile.stateDirectoryId,
        id,
      ),
      tempRoot = join(runtimeRoot, 'tmp')
    for (const path of [
      runtimeRoot,
      tempRoot,
      join(runtimeRoot, 'home'),
      join(runtimeRoot, 'claude'),
      join(runtimeRoot, 'codex'),
    ])
      mkdirSync(path, { recursive: true, mode: 0o700 })
    const ambient = this.options.environment ?? process.env
    const environment: Record<string, string> = Object.fromEntries(
      baseKeys.flatMap((key) => (ambient[key] ? [[key, ambient[key]!]] : [])),
    )
    Object.assign(environment, {
      HOME: join(runtimeRoot, 'home'),
      USERPROFILE: join(runtimeRoot, 'home'),
      XDG_CONFIG_HOME: join(runtimeRoot, 'home', '.config'),
      XDG_CACHE_HOME: join(runtimeRoot, 'home', '.cache'),
      CLAUDE_CONFIG_DIR: join(runtimeRoot, 'claude'),
      CLAUDE_CODE_TMPDIR: tempRoot,
      CODEX_HOME: join(runtimeRoot, 'codex'),
      TMPDIR: tempRoot,
      TMP: tempRoot,
      TEMP: tempRoot,
    })
    if (profile.authRef.kind === 'model-route') {
      if (!profile.authRef.routeId || !this.options.resolveRoute)
        throw new DelegationError(
          'AUTH_REQUIRED',
          'select a credential route or explicit managed CLI login',
        )
      const credential = await this.options.resolveRoute(
        profile.authRef.routeId,
        profile.backend,
      )
      if (!credential.apiKey)
        throw new DelegationError(
          'AUTH_REQUIRED',
          'selected route has no credential',
        )
      if (profile.backend === 'claude-code') {
        environment.ANTHROPIC_API_KEY = credential.apiKey
        if (credential.baseUrl)
          environment.ANTHROPIC_BASE_URL = credential.baseUrl
        if (credential.model) environment.ANTHROPIC_MODEL = credential.model
      } else {
        environment.OPENAI_API_KEY = credential.apiKey
        if (credential.baseUrl) environment.OPENAI_BASE_URL = credential.baseUrl
      }
    } else if (profile.backend === 'claude-code') {
      const home = this.options.home ?? homedir(),
        settings = join(home, '.claude', 'settings.json')
      let configured: Record<string, unknown> = {}
      if (existsSync(settings)) {
        try {
          configured =
            (
              JSON.parse(readFileSync(settings, 'utf8')) as {
                env?: Record<string, unknown>
              }
            ).env ?? {}
        } catch {
          throw new DelegationError(
            'AUTH_REQUIRED',
            'managed Claude authentication settings are invalid',
          )
        }
      }
      const keys = new Set([
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_MODEL',
        'CLAUDE_CODE_OAUTH_TOKEN',
        ...Object.keys(configured).filter((k) =>
          /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL(?:_NAME)?$/.test(k),
        ),
      ])
      for (const key of keys) {
        const value = ambient[key] ?? configured[key]
        if (typeof value === 'string' && value) environment[key] = value
      }
      if (
        !environment.ANTHROPIC_API_KEY &&
        !environment.ANTHROPIC_AUTH_TOKEN &&
        !environment.CLAUDE_CODE_OAUTH_TOKEN
      ) {
        const path = join(home, '.claude', '.credentials.json')
        if (existsSync(path)) {
          try {
            const d = JSON.parse(readFileSync(path, 'utf8')) as {
              claudeAiOauth?: { accessToken?: string }
            }
            if (d.claudeAiOauth?.accessToken)
              environment.CLAUDE_CODE_OAUTH_TOKEN = d.claudeAiOauth.accessToken
          } catch {
            throw new DelegationError(
              'AUTH_REQUIRED',
              'managed Claude credential file is invalid',
            )
          }
        }
      }
      if (
        !environment.ANTHROPIC_API_KEY &&
        !environment.ANTHROPIC_AUTH_TOKEN &&
        !environment.CLAUDE_CODE_OAUTH_TOKEN
      )
        throw new DelegationError(
          'AUTH_REQUIRED',
          'managed Claude login has no resolvable credential',
        )
    } else
      throw new DelegationError(
        'AUTH_REQUIRED',
        'managed Codex authentication has not been prepared',
      )
    const secretValues = Object.entries(environment)
      .filter(([key, value]) => value && /KEY|TOKEN|SECRET/i.test(key))
      .map(([, value]) => value)
    return { runtimeRoot, tempRoot, environment, secretValues }
  }
}
