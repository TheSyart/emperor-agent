import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import {
  DelegationError,
  type ExecutorAuthState,
  type ExecutorBilling,
  type ExecutorProfile,
} from './types'
import { locateExecutable } from './executable'
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
import {
  DEFAULT_DEVELOPMENT_ENVIRONMENT,
  developmentEnvironment,
  type DevelopmentEnvironmentSettings,
} from './dev-environment'
import type { SecretSealer } from '../../security/secret-sealer'
/** The one long-lived private directory every login probe of a profile reuses. */
export const PROBE_RUNTIME_ID = 'probe'
export interface PreparedRuntime {
  runtimeRoot: string
  tempRoot: string
  /**
   * What the run may write besides its workspace and temp folder: its own
   * folder, and for Claude Code its dedicated config and home (AGT-12).
   */
  stateRoots: string[]
  environment: Record<string, string>
  secretValues: string[]
  authenticationAvailable: boolean
  /** Codex ChatGPT login: the isolated auth.json links to the user's file. */
  codexAuth?: CodexAuthLink
  /**
   * How the run's spend is paid (AGT-07): Claude Code's own sign-in or a
   * ChatGPT login is a subscription; any API key or credential route is
   * API billing. (CoreApi turns a Claude Code subscription into API billing
   * when the last `claude auth status` said `api_key`, a Console sign-in.)
   */
  billing: ExecutorBilling
  /** Claude Code: the API credential Emperor passes, if any (AGT-12). */
  auth?: ExecutorAuthState
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
      /** The API key saved in 设置 › 子智能体 › 使用 API Key, read first. */
      claudeKeys?: { root: string; sealer: SecretSealer }
      /** What a task's environment passes through (设置 › 子智能体 › 高级, AGT-08). */
      developmentEnvironment?: () => DevelopmentEnvironmentSettings
      /** Test hooks: the git identity and gh token readers. */
      readGitIdentity?: (
        home: string,
      ) => Promise<{ name?: string; email?: string }>
      readGhToken?: (home: string) => Promise<string | null>
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
      codexAuth: CodexAuthLink | undefined,
      auth: ExecutorAuthState | undefined
    safeDelegationKey(profile.stateDirectoryId)
    safeDelegationKey(id)
    const runtimeRoot = join(
        this.options.root,
        'runtime',
        profile.stateDirectoryId,
        id,
      ),
      tempRoot = join(runtimeRoot, 'tmp')
    const claude = profile.backend === 'claude-code'
    for (const path of [
      runtimeRoot,
      tempRoot,
      ...(claude
        ? []
        : [join(runtimeRoot, 'home'), join(runtimeRoot, 'codex')]),
    ])
      mkdirSync(path, { recursive: true, mode: 0o700 })
    const ambient = executorEnvironment(
      this.options.environment,
      this.options.home,
    )
    const credentialSecrets: string[] = []
    const stateRoots = [runtimeRoot]
    const environment: Record<string, string> = Object.fromEntries(
      baseKeys.flatMap((key) => (ambient[key] ? [[key, ambient[key]!]] : [])),
    )
    // Claude Code: one config folder and home for every run, status check
    // and sign-in, so the login claude saves is the one it finds (AGT-12).
    const sign = claude ? await import('./claude-sign-in') : undefined
    const claudeDirs = sign?.prepareClaudeDirectories(this.options.root)
    if (sign && claudeDirs) {
      Object.assign(environment, sign.claudeProcessEnvironment(claudeDirs))
      stateRoots.push(claudeDirs.config, claudeDirs.home)
      sign.adoptLegacyClaudeSessions(runtimeRoot, claudeDirs)
    } else
      Object.assign(environment, {
        HOME: join(runtimeRoot, 'home'),
        USERPROFILE: join(runtimeRoot, 'home'),
        XDG_CONFIG_HOME: join(runtimeRoot, 'home', '.config'),
        XDG_CACHE_HOME: join(runtimeRoot, 'home', '.cache'),
        CODEX_HOME: join(runtimeRoot, 'codex'),
      })
    Object.assign(environment, {
      ...(claude ? { CLAUDE_CODE_TMPDIR: tempRoot } : {}),
      TMPDIR: tempRoot,
      TMP: tempRoot,
      TEMP: tempRoot,
    })
    // Codex's per-child file: never retain a prior provider after a change.
    if (!claude) {
      const codexConfig = join(environment.CODEX_HOME!, 'config.toml')
      if (existsSync(codexConfig)) unlinkSync(codexConfig)
    }
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
        auth = { source: 'model-route', kind: 'api-key' }
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
    } else if (sign && claudeDirs) {
      const home = this.options.home ?? homedir(),
        sourceDirectory = ambient.CLAUDE_CONFIG_DIR || join(home, '.claude'),
        settings = join(sourceDirectory, 'settings.json')
      // The user's own Claude Code settings lend their model choices and
      // `env` (a third-party endpoint with its API credential); never their
      // login: .credentials.json and the Keychain are claude's alone.
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
      const keys = this.options.claudeKeys
      const resolved = await sign.resolveClaudeCredential({
        stored: () =>
          keys ? new sign.ClaudeKeyStore(keys).read(profile.id) : null,
        settingsEnv: configured,
        ambient,
        ...(this.options.loginShell
          ? { loginShell: this.options.loginShell }
          : {}),
      })
      auth = resolved.auth
      const names = new Set([
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_MODEL',
        'ANTHROPIC_CUSTOM_MODEL_OPTION',
        ...[...Object.keys(configured), ...Object.keys(ambient)].filter((k) =>
          /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL(?:_NAME)?$/.test(k),
        ),
      ])
      for (const key of names) {
        const value = ambient[key] ?? configured[key]
        if (typeof value === 'string' && value) environment[key] = value
      }
      for (const [key, value] of Object.entries(resolved.variables))
        if (sign.isClaudeCredentialKey(key) || !environment[key])
          environment[key] = value
      const endpoint = anthropicEndpoint(environment.ANTHROPIC_BASE_URL)
      if (auth.source && endpoint) auth = { ...auth, endpoint }
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
      // Emperor's settings.json in the dedicated folder holds the model
      // choices only. Every run writes the same bytes; a change replaces it
      // atomically, so runs sharing the folder never see half a file.
      const ours = join(claudeDirs.config, 'settings.json')
      const body = Object.keys(modelSettings).length
        ? JSON.stringify(modelSettings)
        : null
      let current: string | null = null
      try {
        current = readFileSync(ours, 'utf8')
      } catch {
        current = null
      }
      if (body !== null && body !== current) durableReplaceSync(ours, body)
      else if (body === null && current !== null) rmSync(ours, { force: true })
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
    if (claude) {
      // The installed claude (AGT-12): a folder only the login shell knows
      // goes on PATH, so the run, the status check and the model list find it.
      const executable = await locateExecutable(profile.executablePath, {
        path: environment.PATH,
        ...(this.options.loginShell
          ? { loginShell: this.options.loginShell }
          : {}),
      })
      if (
        executable &&
        !(environment.PATH ?? '').split(delimiter).includes(dirname(executable))
      )
        environment.PATH = [environment.PATH, dirname(executable)]
          .filter(Boolean)
          .join(delimiter)
    }
    const billing: ExecutorBilling =
      profile.backend === 'claude-code'
        ? environment.ANTHROPIC_API_KEY || environment.ANTHROPIC_AUTH_TOKEN
          ? 'api'
          : 'subscription'
        : codexAuth
          ? 'subscription'
          : 'api'
    // The task's development environment (AGT-08): not for the login probe,
    // which only lists models.
    if (id !== PROBE_RUNTIME_ID) {
      const dev = await developmentEnvironment({
        settings:
          this.options.developmentEnvironment?.() ??
          DEFAULT_DEVELOPMENT_ENVIRONMENT,
        ambient,
        home: this.options.home ?? homedir(),
        ...(this.options.loginShell
          ? { loginShell: this.options.loginShell }
          : {}),
        ...(this.options.readGitIdentity
          ? { readGitIdentity: this.options.readGitIdentity }
          : {}),
        ...(this.options.readGhToken
          ? { readGhToken: this.options.readGhToken }
          : {}),
      })
      for (const key of dev.remove) delete environment[key]
      Object.assign(environment, dev.env)
      if (dev.pathPrefix.length)
        environment.PATH = [...dev.pathPrefix, environment.PATH]
          .filter(Boolean)
          .join(delimiter)
      credentialSecrets.push(...dev.secrets)
      // Claude Code scrubs *_TOKEN from its Bash (AGT-02), so gh also gets
      // a private hosts.yml in the task's own config folder; it goes away
      // with the switch. Claude Code's home is shared by its runs (AGT-12):
      // the same bytes are written only when they change, and removal
      // tolerates a race.
      const ghHosts = join(environment.XDG_CONFIG_HOME!, 'gh', 'hosts.yml')
      if (dev.env.GH_TOKEN) {
        const body = `github.com:\n    oauth_token: ${dev.env.GH_TOKEN}\n    git_protocol: https\n`
        let current: string | null = null
        try {
          current = readFileSync(ghHosts, 'utf8')
        } catch {
          current = null
        }
        if (current !== body) {
          mkdirSync(join(environment.XDG_CONFIG_HOME!, 'gh'), {
            recursive: true,
            mode: 0o700,
          })
          durableReplaceSync(ghHosts, body)
          chmodSync(ghHosts, 0o600)
        }
      } else rmSync(ghHosts, { force: true })
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
      stateRoots,
      environment,
      secretValues,
      authenticationAvailable,
      ...(codexAuth ? { codexAuth } : {}),
      billing,
      ...(auth ? { auth } : {}),
    }
  }
}

/** A non-Anthropic endpoint's host, for 设置 › 子智能体 (AGT-12). */
function anthropicEndpoint(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    const host = new URL(baseUrl).hostname
    return host && host !== 'api.anthropic.com' ? host : undefined
  } catch {
    return undefined
  }
}
