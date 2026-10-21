import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ViewScope } from '../../harness/host/scope'
import {
  ExecutorConfigStore,
  parseExecutorConfig,
} from '../../harness/delegation/config'
import {
  checkSignIn,
  type ExecutorRegistry,
} from '../../harness/delegation/registry'
import type { ExecutorFactsStore } from '../../harness/delegation/facts'
import { executorSpecialties } from '../../harness/delegation/specialties'
import type { ExecutorModelCatalogService } from '../../harness/delegation/models'
import type { ExecutorConsentStore } from '../../harness/delegation/consent'
import type { SecretSealer } from '../../security/secret-sealer'
import {
  DelegationError,
  type ExecutorAuthState,
  type ExecutorProfile,
} from '../../harness/delegation/types'
export class CoreExecutorService {
  constructor(
    private readonly options: {
      store: ExecutorConfigStore
      registry: ExecutorRegistry
      facts: ExecutorFactsStore
      modelCatalog: ExecutorModelCatalogService
      /** The mutation guard of the session the caller shows (KRN-01). */
      refresh: () => Promise<void>
      checkAuth?: (
        profile: ExecutorProfile,
      ) => Promise<ExecutorAuthState | undefined>
      /** "以后都允许" per profile (AGT-05). */
      consent?: ExecutorConsentStore
      /** Where 使用 API Key keeps the user's own key (AGT-12). */
      claudeKeys?: { root: string; sealer: SecretSealer }
      /**
       * Claude Code's own sign-in (AGT-12): 登录 Claude Code opens macOS
       * Terminal on `claude auth login`; 退出登录 runs `claude auth logout`,
       * both in the run's environment.
       */
      claudeSignIn?: {
        signIn(profile: ExecutorProfile, console: boolean): Promise<void>
        signOut(profile: ExecutorProfile): Promise<void>
      }
    },
  ) {}
  close() {
    return this.options.modelCatalog.close()
  }
  async models(input: { profileId: string; refresh?: boolean }) {
    const profile = this.profile(input.profileId)
    return this.options.modelCatalog.list(profile, input.refresh)
  }
  list() {
    try {
      const config = this.options.store.read()
      return {
        config,
        diagnostic: null,
        /** Once after the upgrade that deleted a saved Claude token (AGT-12). */
        signInNotice: this.signInNotice(),
        profiles: config.profiles.map((profile) => ({
          profile,
          probe: this.options.facts.probe(profile),
          specialties: executorSpecialties(profile),
          runtime: this.options.facts.view(profile),
          /** The user chose 以后都允许 for this executor. */
          consent: this.options.consent?.granted(profile.id)
            ? ('always' as const)
            : null,
        })),
      }
    } catch {
      return {
        config: null,
        diagnostic: 'EXECUTOR_CONFIG_INVALID: original configuration retained',
        signInNotice: false,
        profiles: [],
      }
    }
  }
  private profile(profileId: string): ExecutorProfile {
    const profile = this.options.store
      .read()
      .profiles.find((p) => p.id === profileId)
    if (!profile)
      throw new DelegationError(
        'EXECUTOR_NOT_FOUND',
        'unknown executor profile',
      )
    return profile
  }
  async probe(input: { profileId: string }) {
    const profile = this.profile(input.profileId)
    let value = await this.options.registry.probe(profile)
    const check = this.options.checkAuth
    if (check) value = (await checkSignIn(value, () => check(profile))).probe
    this.options.facts.setProbe(profile, value)
    return value
  }
  private claudeProfile(profileId: string): ExecutorProfile {
    const profile = this.profile(profileId)
    if (profile.backend !== 'claude-code')
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'only Claude Code signs in or takes an API key here',
      )
    return profile
  }
  private keyStore() {
    const keys = this.options.claudeKeys
    if (!keys)
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'this Emperor keeps no Claude Code API key',
      )
    return import('../../harness/delegation/claude-sign-in').then(
      (m) => new m.ClaudeKeyStore(keys),
    )
  }
  private signInNotice(): boolean {
    const keys = this.options.claudeKeys
    if (!keys) return false
    try {
      const raw = JSON.parse(
        readFileSync(join(keys.root, 'credentials.json'), 'utf8'),
      ) as { notice?: unknown }
      return raw.notice === 'claude-sign-in'
    } catch {
      return false
    }
  }
  // 使用 API Key / 移除 (AGT-12): the user's own Console key, sealed; the
  // reply is the new probe, whose `auth` shows 末 4 位, never the key.
  async setCredential(
    input: { profileId: string; kind: 'api-key'; token: string },
    _view: ViewScope,
  ) {
    const profile = this.claudeProfile(input.profileId)
    const { isClaudeAiToken } =
      await import('../../harness/delegation/claude-sign-in')
    // A Claude.ai token is claude's own sign-in: 登录 Claude Code instead.
    if (input.kind !== 'api-key' || isClaudeAiToken(input.token))
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'only an API key is saved in Emperor; sign in to Claude Code with its own login',
      )
    const store = await this.keyStore()
    try {
      store.set(profile.id, input.token)
    } catch {
      throw new DelegationError(
        'CREDENTIAL_UNAVAILABLE',
        "Emperor's local key cannot seal the API key",
      )
    }
    return { probe: await this.probe(input) }
  }
  async clearCredential(input: { profileId: string }, _view: ViewScope) {
    const profile = this.claudeProfile(input.profileId)
    const store = await this.keyStore()
    try {
      store.clear(profile.id)
    } catch {
      throw new DelegationError(
        'CREDENTIAL_UNAVAILABLE',
        "Emperor's local key file cannot be changed",
      )
    }
    return { probe: await this.probe(input) }
  }
  /** 登录 Claude Code: macOS Terminal on the installed claude's own login. */
  async signIn(
    input: { profileId: string; method: 'claude-ai' | 'console' },
    _view: ViewScope,
  ) {
    const profile = this.claudeProfile(input.profileId)
    const signIn = this.options.claudeSignIn
    if (!signIn)
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'this Emperor cannot open a sign-in',
      )
    await signIn.signIn(profile, input.method === 'console')
    return { opened: true as const }
  }
  /** 退出登录: `claude auth logout` in the run's environment. */
  async signOut(input: { profileId: string }, _view: ViewScope) {
    const profile = this.claudeProfile(input.profileId)
    const signIn = this.options.claudeSignIn
    if (!signIn)
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'this Emperor cannot sign out',
      )
    await signIn.signOut(profile)
    return { probe: await this.probe(input) }
  }
  /** 知道了 on the upgrade notice (AGT-12). */
  async dismissNotice(_input: { notice: 'claude-sign-in' }, _view: ViewScope) {
    if (this.options.claudeKeys) (await this.keyStore()).dismissNotice()
    return {}
  }
  async configure(
    input: { expectedRevision: number; config: unknown },
    _view: ViewScope,
  ) {
    const before = this.options.store.read()
    const parsed = parseExecutorConfig(input.config),
      config = this.options.store.update(input.expectedRevision, parsed)
    // Turning an executor off forgets 以后都允许: turning it back on asks
    // again before the first dispatch.
    for (const profile of config.profiles)
      if (
        !profile.enabled &&
        before.profiles.find((p) => p.id === profile.id)?.enabled
      )
        this.options.consent?.revoke(profile.id)
    await this.options.refresh()
    return config
  }
}
