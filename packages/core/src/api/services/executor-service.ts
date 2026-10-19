import type { ViewScope } from '../../harness/host/scope'
import {
  ExecutorConfigStore,
  parseExecutorConfig,
} from '../../harness/delegation/config'
import type { ExecutorRegistry } from '../../harness/delegation/registry'
import type { ExecutorFactsStore } from '../../harness/delegation/facts'
import { executorSpecialties } from '../../harness/delegation/specialties'
import type { ExecutorModelCatalogService } from '../../harness/delegation/models'
import type { ExecutorConsentStore } from '../../harness/delegation/consent'
import {
  DelegationError,
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
      checkAuth?: (profile: ExecutorProfile) => Promise<void>
      /** "以后都允许" per profile (AGT-05). */
      consent?: ExecutorConsentStore
    },
  ) {}
  close() {
    return this.options.modelCatalog.close()
  }
  async models(input: { profileId: string; refresh?: boolean }) {
    const profile = this.options.store
      .read()
      .profiles.find((p) => p.id === input.profileId)
    if (!profile)
      throw new DelegationError(
        'EXECUTOR_NOT_FOUND',
        'unknown executor profile',
      )
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
  async probe(input: { profileId: string }) {
    const profile = this.options.store
      .read()
      .profiles.find((p) => p.id === input.profileId)
    if (!profile)
      throw new DelegationError(
        'EXECUTOR_NOT_FOUND',
        'unknown executor profile',
      )
    const value = await this.options.registry.probe(profile)
    if (value.status === 'available' && this.options.checkAuth) {
      try {
        await this.options.checkAuth(profile)
        value.localAuthChecked = true
      } catch (error) {
        value.localAuthChecked = false
        value.status =
          error instanceof DelegationError && error.code === 'AUTH_REQUIRED'
            ? 'needs_auth'
            : 'incompatible'
        value.diagnostic =
          error instanceof DelegationError
            ? error.code
            : 'AUTH_ROUTE_UNAVAILABLE'
      }
    }
    this.options.facts.setProbe(profile, value)
    return value
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
