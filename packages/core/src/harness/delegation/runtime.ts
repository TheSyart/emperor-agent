import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DelegationError, type ExecutorProfile } from './types'
import { safeDelegationKey } from './fold'
import { durableReplaceSync } from '../../store/persistence'
import { executorEnvironment } from './environment'
import { inheritCodexModels, claudeModelSettings } from './local-model-config'
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
    const ambient = executorEnvironment(
      this.options.environment,
      this.options.home,
    )
    const credentialSecrets: string[] = []
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
    // These are host-generated, per-child files; never retain a prior provider after configuration changes.
    for (const path of [
      join(environment.CODEX_HOME!, 'config.toml'),
      join(environment.CLAUDE_CONFIG_DIR!, 'settings.json'),
    ])
      if (existsSync(path)) unlinkSync(path)
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
        {
          environment.OPENAI_BASE_URL =
            credential.baseUrl ?? 'https://api.openai.com/v1'
          durableReplaceSync(
            join(environment.CODEX_HOME!, 'config.toml'),
            'model_provider = "emperor-route"\n[model_providers.emperor-route]\nname = "Emperor route"\nwire_api = "responses"\nrequires_openai_auth = false\nenv_key = "OPENAI_API_KEY"\nbase_url = ' +
              JSON.stringify(environment.OPENAI_BASE_URL) +
              '\n',
          )
        }
      }
    } else if (profile.backend === 'claude-code') {
      const home = this.options.home ?? homedir(),
        sourceDirectory = ambient.CLAUDE_CONFIG_DIR || join(home, '.claude'),
        settings = join(sourceDirectory, 'settings.json')
      let configured: Record<string, unknown> = {},
        modelSettings: Record<string, unknown> = {}
      if (existsSync(settings)) {
        try {
          const source = JSON.parse(readFileSync(settings, 'utf8')) as Record<
            string,
            unknown
          >
          configured = (source.env as Record<string, unknown>) ?? {}
          modelSettings = claudeModelSettings(source)
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
        'ANTHROPIC_DEFAULT_MODEL',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_CUSTOM_MODEL_OPTION',
        ...[...Object.keys(configured), ...Object.keys(ambient)].filter((k) =>
          /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL(?:_NAME)?$/.test(k),
        ),
      ])
      for (const key of keys) {
        const value = ambient[key] ?? configured[key]
        if (typeof value === 'string' && value) environment[key] = value
      }
      const model =
        profile.defaultModel ??
        environment.ANTHROPIC_MODEL ??
        (modelSettings.model as string | undefined) ??
        environment.ANTHROPIC_DEFAULT_MODEL
      if (model) environment.ANTHROPIC_MODEL = model
      environment.EMPEROR_EXECUTOR_CONFIG_FINGERPRINT = createHash('sha256')
        .update(
          JSON.stringify({
            modelSettings,
            model,
            mapping: Object.fromEntries(
              Object.entries(environment).filter(([key]) =>
                key.startsWith('ANTHROPIC_DEFAULT_'),
              ),
            ),
          }),
        )
        .digest('hex')
      if (Object.keys(modelSettings).length)
        durableReplaceSync(
          join(environment.CLAUDE_CONFIG_DIR!, 'settings.json'),
          JSON.stringify(modelSettings),
        )
      if (
        !environment.ANTHROPIC_API_KEY &&
        !environment.ANTHROPIC_AUTH_TOKEN &&
        !environment.CLAUDE_CODE_OAUTH_TOKEN
      ) {
        const path = join(sourceDirectory, '.credentials.json')
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
    } else {
      const sourceDirectory =
        ambient.CODEX_HOME || join(this.options.home ?? homedir(), '.codex')
      const customProvider = inheritCodexModels(
        sourceDirectory,
        environment.CODEX_HOME!,
        ambient,
        environment,
        credentialSecrets,
      )
      if (ambient.OPENAI_API_KEY)
        environment.OPENAI_API_KEY = ambient.OPENAI_API_KEY
      const local = join(environment.CODEX_HOME!, 'auth.json')
      const path = existsSync(local)
        ? local
        : join(
            ambient.CODEX_HOME ||
              join(this.options.home ?? homedir(), '.codex'),
            'auth.json',
          )
      if (!existsSync(path) && !customProvider && !environment.OPENAI_API_KEY)
        throw new DelegationError(
          'AUTH_REQUIRED',
          'managed Codex login file is missing',
        )
      let auth: Record<string, unknown>
      try {
        auth = existsSync(path)
          ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
          : {}
      } catch {
        throw new DelegationError(
          'AUTH_REQUIRED',
          'managed Codex authentication file is invalid',
        )
      }
      if (
        !environment.OPENAI_API_KEY &&
        typeof auth.OPENAI_API_KEY === 'string' &&
        auth.OPENAI_API_KEY
      ) {
        environment.OPENAI_API_KEY = auth.OPENAI_API_KEY
      } else if (!customProvider && !environment.OPENAI_API_KEY) {
        const source = auth.tokens as Record<string, unknown> | undefined
        if (
          auth.auth_mode !== 'chatgpt' ||
          !source ||
          typeof source.access_token !== 'string' ||
          typeof source.refresh_token !== 'string'
        )
          throw new DelegationError(
            'AUTH_REQUIRED',
            'managed Codex ChatGPT tokens are unavailable',
          )
        const tokens = Object.fromEntries(
          ['access_token', 'refresh_token', 'id_token', 'account_id'].flatMap(
            (key) =>
              typeof source[key] === 'string' ? [[key, source[key]]] : [],
          ),
        )
        credentialSecrets.push(...(Object.values(tokens) as string[]))
        durableReplaceSync(
          join(environment.CODEX_HOME!, 'auth.json'),
          JSON.stringify({
            auth_mode: 'chatgpt',
            OPENAI_API_KEY: null,
            tokens,
            ...(typeof auth.last_refresh === 'string'
              ? { last_refresh: auth.last_refresh }
              : {}),
          }) + '\n',
        )
      }
    }
    const secretValues = [
      ...credentialSecrets,
      ...Object.entries(environment)
        .filter(([key, value]) => value && /KEY|TOKEN|SECRET/i.test(key))
        .map(([, value]) => value),
    ]
    return { runtimeRoot, tempRoot, environment, secretValues }
  }
}
