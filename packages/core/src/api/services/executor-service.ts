import {
  ExecutorConfigStore,
  parseExecutorConfig,
} from '../../harness/delegation/config'
import type { ExecutorRegistry } from '../../harness/delegation/registry'
import {
  DelegationError,
  type ExecutorProbe,
  type ExecutorProfile,
} from '../../harness/delegation/types'
export class CoreExecutorService {
  private readonly probes = new Map<
    string,
    { key: string; value: ExecutorProbe }
  >()
  constructor(
    private readonly options: {
      store: ExecutorConfigStore
      registry: ExecutorRegistry
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
          probe:
            this.probes.get(profile.id)?.key === JSON.stringify(profile)
              ? this.probes.get(profile.id)!.value
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
      } catch (error) {
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
    this.probes.set(profile.id, { key: JSON.stringify(profile), value })
    return value
  }
  async configure(input: { expectedRevision: number; config: unknown }) {
    this.options.assertConfigure()
    const parsed = parseExecutorConfig(input.config),
      config = this.options.store.update(input.expectedRevision, parsed)
    this.probes.clear()
    await this.options.refresh()
    return config
  }
}
