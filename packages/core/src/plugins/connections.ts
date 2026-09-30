/**
 * The app connection registry (plan §4.3): which app members Emperor can
 * actually connect, and whether each one is connected right now. An app
 * member without an adapter stays "unsupported". Adapters belong to one app
 * member of one package ({@link appConnectionKey}), so another package's app
 * of the same name never borrows a connection. States are cached briefly
 * because checking can mean a network call (for GitHub, `gh api user`).
 */

/** Registry key of an app member: the package that declares it, and its name there. */
export function appConnectionKey(member: {
  readonly scope: string
  readonly pluginId: string
  readonly appId: string
}): string {
  return `${member.scope}:${member.pluginId}:${member.appId}`
}

export interface AppConnectionState {
  readonly state: 'connected' | 'needs_connection' | 'failed'
  readonly reason: string | null
}

export interface AppConnectionAdapter {
  check(): Promise<AppConnectionState>
}

export class AppConnectionRegistry {
  private readonly states = new Map<
    string,
    { at: number; value: AppConnectionState }
  >()

  constructor(
    private readonly adapters: Readonly<Record<string, AppConnectionAdapter>>,
    private readonly options: { ttlMs?: number; now?: () => number } = {},
  ) {}

  has(key: string): boolean {
    return Object.hasOwn(this.adapters, key)
  }

  /** The last known state; `null` when there is no adapter or no check yet. */
  state(key: string): AppConnectionState | null {
    return this.states.get(key)?.value ?? null
  }

  /** Re-check the named app members whose state is older than the cache window. */
  async refresh(keys: readonly string[]): Promise<void> {
    const now = (this.options.now ?? Date.now)()
    const ttl = this.options.ttlMs ?? 30_000
    await Promise.all(
      [...new Set(keys)]
        .filter((id) => this.has(id))
        .filter((id) => {
          const cached = this.states.get(id)
          return !cached || now - cached.at >= ttl
        })
        .map(async (id) => {
          let value: AppConnectionState
          try {
            value = await this.adapters[id]!.check()
          } catch (error) {
            value = {
              state: 'failed',
              reason: error instanceof Error ? error.message : String(error),
            }
          }
          this.states.set(id, { at: now, value })
        }),
    )
  }
}
