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
import type {
  ClaudeTokenKind,
  ClaudeTokenStore,
} from '../../harness/delegation/claude-tokens'
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
      assertConfigure: (view: ViewScope) => void
      refresh: () => Promise<void>
      checkAuth?: (
        profile: ExecutorProfile,
      ) => Promise<ExecutorAuthState | undefined>
      /** "以后都允许" per profile (AGT-05). */
      consent?: ExecutorConsentStore
      /** Tokens pasted into 设置 › 子智能体 (AGT-02). */
      claudeTokens?: Pick<ClaudeTokenStore, 'status' | 'set' | 'clear'>
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
        profiles: config.profiles.map((profile) => ({
          profile,
          probe: this.options.facts.probe(profile),
          specialties: executorSpecialties(profile),
          runtime: this.options.facts.view(profile),
          /** The user chose 以后都允许 for this executor. */
          consent: this.options.consent?.granted(profile.id)
            ? ('always' as const)
            : null,
          /** A token pasted into Emperor: its kind and last 4 only. */
          credential: this.options.claudeTokens?.status(profile.id) ?? null,
        })),
      }
    } catch {
      return {
        config: null,
        diagnostic: 'EXECUTOR_CONFIG_INVALID: original configuration retained',
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
  /**
   * 设置令牌 (AGT-02): seal a Claude token for this profile; the reply
   * carries its kind and last 4 and the new probe, never the token.
   */
  async setCredential(
    input: { profileId: string; kind: ClaudeTokenKind; token: string },
    view: ViewScope,
  ) {
    this.options.assertConfigure(view)
    const profile = this.claudeProfile(input.profileId)
    let credential
    try {
      credential = this.options.claudeTokens!.set(
        profile.id,
        input.kind,
        input.token,
      )
    } catch {
      throw new DelegationError(
        'CREDENTIAL_UNAVAILABLE',
        "Emperor's local key cannot seal the token",
      )
    }
    return { credential, probe: await this.probe(input) }
  }
  async clearCredential(input: { profileId: string }, view: ViewScope) {
    this.options.assertConfigure(view)
    this.options.claudeTokens!.clear(this.claudeProfile(input.profileId).id)
    return { credential: null, probe: await this.probe(input) }
  }
  private claudeProfile(profileId: string): ExecutorProfile {
    const profile = this.profile(profileId)
    if (profile.backend !== 'claude-code' || !this.options.claudeTokens)
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'only Claude Code takes a token pasted into Emperor',
      )
    return profile
  }
  async configure(
    input: { expectedRevision: number; config: unknown },
    view: ViewScope,
  ) {
    this.options.assertConfigure(view)
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
