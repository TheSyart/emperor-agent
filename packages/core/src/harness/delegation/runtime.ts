import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DelegationError, type ExecutorProfile } from './types'
import { safeDelegationKey } from './fold'
import { durableReplaceSync } from '../../store/persistence'
import { executorEnvironment } from './environment'
import {
  inheritCodexModels,
  claudeModelSettings,
  codexProviderVariables,
} from './local-model-config'
import {
  linkCodexAuth,
  removeCodexAuth,
  type CodexAuthLink,
} from './codex-auth'
import type { LoginShellEnvironment } from './login-shell'
/** The one long-lived private directory every login probe of a profile reuses. */
export const PROBE_RUNTIME_ID = 'probe'
export interface PreparedRuntime {
  runtimeRoot: string
  tempRoot: string
  environment: Record<string, string>
  secretValues: string[]
  authenticationAvailable: boolean
  /** Codex ChatGPT login: the isolated auth.json links to the user's file. */
  codexAuth?: CodexAuthLink
}
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
  private readonly swept = new Set<string>()
  constructor(
    private readonly options: {
      root: string
      home?: string
      environment?: NodeJS.ProcessEnv
      resolveRoute?: (
        id: string,
        backend: string,
      ) => Promise<ExecutorCredential>
      /** Provider keys exported in ~/.zshrc (absent from a Dock launch). */
      loginShell?: LoginShellEnvironment
    },
  ) {}
  /**
   * Login check for settings: prepares the profile's one long-lived probe
   * directory. Older builds made a new `dlg-probe-<uuid>` directory with a
   * token copy on every check; those are removed once.
   */
  async probe(profile: ExecutorProfile): Promise<PreparedRuntime> {
    safeDelegationKey(profile.stateDirectoryId)
    if (!this.swept.has(profile.stateDirectoryId)) {
      this.swept.add(profile.stateDirectoryId)
      const directory = join(
        this.options.root,
        'runtime',
        profile.stateDirectoryId,
      )
      try {
        for (const name of readdirSync(directory))
          if (name.startsWith('dlg-probe-'))
            rmSync(join(directory, name), { recursive: true, force: true })
      } catch {
        /* Nothing to sweep yet. */
      }
    }
    return this.prepare(profile, PROBE_RUNTIME_ID)
  }
  async prepare(
    profile: ExecutorProfile,
    id: string,
    options: { allowUnauthenticatedConfig?: boolean } = {},
  ): Promise<PreparedRuntime> {
    let authenticationAvailable = true,
      codexAuth: CodexAuthLink | undefined
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
        removeCodexAuth(join(environment.CODEX_HOME!, 'auth.json'))
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
      ) {
        if (!options.allowUnauthenticatedConfig)
          throw new DelegationError(
            'AUTH_REQUIRED',
            'managed Claude login has no resolvable credential',
          )
        authenticationAvailable = false
      }
    } else {
      const sourceDirectory =
        ambient.CODEX_HOME || join(this.options.home ?? homedir(), '.codex')
      // A provider key exported in ~/.zshrc wins; the process env is the
      // fallback (a terminal launch already has it).
      const names = codexProviderVariables(sourceDirectory)
      const shell =
        names.length && this.options.loginShell
          ? await this.options.loginShell.read(names)
          : {}
      const customProvider = inheritCodexModels(
        sourceDirectory,
        environment.CODEX_HOME!,
        { ...ambient, ...shell },
        environment,
        credentialSecrets,
      )
      if (ambient.OPENAI_API_KEY)
        environment.OPENAI_API_KEY = ambient.OPENAI_API_KEY
      // The user's own file, never a copy left in the isolated home.
      const path = join(sourceDirectory, 'auth.json'),
        isolated = join(environment.CODEX_HOME!, 'auth.json')
      if (
        !existsSync(path) &&
        !customProvider &&
        !environment.OPENAI_API_KEY &&
        !options.allowUnauthenticatedConfig
      )
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
        // API key mode: only the variable crosses into the isolated home.
        environment.OPENAI_API_KEY = auth.OPENAI_API_KEY
      } else if (!customProvider && !environment.OPENAI_API_KEY) {
        const source = auth.tokens as Record<string, unknown> | undefined
        if (
          auth.auth_mode !== 'chatgpt' ||
          !source ||
          typeof source.access_token !== 'string' ||
          typeof source.refresh_token !== 'string'
        ) {
          if (!options.allowUnauthenticatedConfig)
            throw new DelegationError(
              'AUTH_REQUIRED',
              'managed Codex ChatGPT tokens are unavailable',
            )
          authenticationAvailable = false
        }
        // Read only to redact them from executor output.
        for (const key of [
          'access_token',
          'refresh_token',
          'id_token',
          'account_id',
        ])
          if (typeof source?.[key] === 'string')
            credentialSecrets.push(source[key] as string)
        if (authenticationAvailable) {
          codexAuth = { source: path, isolated }
          // A copy forked by an older build is settled under the lock
          // before the next Codex process starts (codex-auth.ts).
          linkCodexAuth(codexAuth)
        }
      }
      if (!codexAuth) removeCodexAuth(isolated)
    }
    const secretValues = [
      ...credentialSecrets,
      ...Object.entries(environment)
        .filter(([key, value]) => value && /KEY|TOKEN|SECRET/i.test(key))
        .map(([, value]) => value),
    ]
    return {
      runtimeRoot,
      tempRoot,
      environment,
      secretValues,
      authenticationAvailable,
      ...(codexAuth ? { codexAuth } : {}),
    }
  }
}
