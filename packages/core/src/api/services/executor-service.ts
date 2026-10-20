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
import type { ClaudeTokenKind } from '../../harness/delegation/claude-auth'
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
      assertConfigure: (view: ViewScope) => void
      refresh: () => Promise<void>
      checkAuth?: (
        profile: ExecutorProfile,
      ) => Promise<ExecutorAuthState | undefined>
      /** "以后都允许" per profile (AGT-05). */
      consent?: ExecutorConsentStore
      /** Where tokens pasted into 设置 › 子智能体 live (AGT-02). */
      claudeTokens?: { root: string; sealer: SecretSealer }
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
  // 设置令牌 / 移除令牌 (AGT-02): the reply is the new probe; its `auth`
  // shows 末 4 位, never the token.
  setCredential(
    input: { profileId: string; kind?: ClaudeTokenKind; token?: string },
    view: ViewScope,
  ) {
    return this.saveToken(input, view)
  }
  clearCredential(input: { profileId: string }, view: ViewScope) {
    return this.saveToken(input, view)
  }
  private async saveToken(
    input: { profileId: string; kind?: ClaudeTokenKind; token?: string },
    view: ViewScope,
  ) {
    this.options.assertConfigure(view)
    const profile = this.profile(input.profileId),
      tokens = this.options.claudeTokens
    if (profile.backend !== 'claude-code' || !tokens)
      throw new DelegationError(
        'UNSUPPORTED_OPTION',
        'only Claude Code takes a token pasted into Emperor',
      )
    const { ClaudeTokenStore } =
      await import('../../harness/delegation/claude-auth')
    try {
      new ClaudeTokenStore(tokens).set(profile.id, input.kind, input.token)
    } catch {
      throw new DelegationError(
        'CREDENTIAL_UNAVAILABLE',
        "Emperor's local key cannot seal the token",
      )
    }
    return { probe: await this.probe(input) }
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
