import {
  ExecutorConfigStore,
  parseExecutorConfig,
} from '../../harness/delegation/config'
import type { ExecutorRegistry } from '../../harness/delegation/registry'
import type { ExecutorFactsStore } from '../../harness/delegation/facts'
import { executorSpecialties } from '../../harness/delegation/specialties'
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
      assertConfigure: () => void
      refresh: () => Promise<void>
      checkAuth?: (profile: ExecutorProfile) => Promise<void>
    },
  ) {}
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
  async configure(input: { expectedRevision: number; config: unknown }) {
    this.options.assertConfigure()
    const parsed = parseExecutorConfig(input.config),
      config = this.options.store.update(input.expectedRevision, parsed)
    await this.options.refresh()
    return config
  }
}
