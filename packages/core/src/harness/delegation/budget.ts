import {
  DEFAULT_UNPRICED_TOKENS_PER_TASK,
  DelegationError,
  type ExecutorConfig,
  type ExecutorRunUsage,
} from './types'
/**
 * Per-task limits of external executors (AGT-07). A scope is the task the
 * delegation belongs to (KRN-03: a user message or a goal). Each run counts
 * against `maxRunsPerTask`; its usage then counts by billing:
 * - subscription: nominal cost only, nothing counted (turns and time bound it);
 * - API with a known cost: USD toward `estimatedBudgetUsd`;
 * - API with no price: its tokens toward `maxUnpricedTokensPerTask`.
 * A run is also checked while it runs (`exceeds`), and an API run hands
 * Claude what remains (`remainingUsd`) as the SDK's maxBudgetUsd.
 */
type RunUsage = Pick<
  ExecutorRunUsage,
  'estimatedUsd' | 'billing' | 'totalTokens'
>
interface ScopeUsage {
  runs: number
  knownEstimatedUsd: number
  unknownRuns: number
  unpricedTokens: number
}
function freshScope(): ScopeUsage {
  return { runs: 0, knownEstimatedUsd: 0, unknownRuns: 0, unpricedTokens: 0 }
}
function knownUsd(usage: RunUsage | undefined): number | undefined {
  const usd = usage?.estimatedUsd
  return usd === undefined || !Number.isFinite(usd) || usd < 0 ? undefined : usd
}
/** Book one run's usage into its scope. */
function account(s: ScopeUsage, usage: RunUsage | undefined): void {
  if (usage?.billing === 'subscription') return
  const usd = knownUsd(usage)
  if (usd !== undefined) {
    s.knownEstimatedUsd += usd
    return
  }
  s.unknownRuns++
  const tokens = usage?.totalTokens
  if (tokens !== undefined && Number.isFinite(tokens) && tokens > 0)
    s.unpricedTokens += tokens
}
export interface BudgetLease {
  release(usage?: RunUsage): void
}
export class DelegationBudget {
  private readonly scopes = new Map<string, ScopeUsage>()
  private readonly active = new Map<string, number>()
  private readonly waiting: {
    scope: string
    profile: string
    resolve: (lease: BudgetLease) => void
    reject: (e: unknown) => void
    signal?: AbortSignal
    abort: () => void
  }[] = []
  private lastScope: string | undefined
  private readonly scopeOrder: string[] = []
  constructor(private config: ExecutorConfig) {}
  /**
   * Count a run from history against its task's limits. It never occupies a
   * concurrency slot: a run that needs recovery is not running (AGT-04).
   */
  restore(scope: string, usage: RunUsage | undefined): void {
    const s = this.scopes.get(scope) ?? freshScope()
    s.runs++
    account(s, usage)
    this.scopes.set(scope, s)
  }
  reconfigure(config: ExecutorConfig): void {
    this.config = config
    this.drain()
  }
  usage(scope: string): ScopeUsage & { estimatedUsd?: number } {
    const s = this.scopes.get(scope) ?? freshScope()
    return {
      ...s,
      ...(s.unknownRuns === 0 ? { estimatedUsd: s.knownEstimatedUsd } : {}),
    }
  }
  /** What the scope may still spend in USD (an API run's SDK budget). */
  remainingUsd(scope: string): number {
    return Math.max(
      0,
      this.config.limits.estimatedBudgetUsd -
        this.usage(scope).knownEstimatedUsd,
    )
  }
  /** Whether a run's usage so far takes its scope past a cap. */
  exceeds(scope: string, live: RunUsage): DelegationError | undefined {
    const s = { ...(this.scopes.get(scope) ?? freshScope()) }
    account(s, live)
    return this.spent(s)
  }
  private spent(s: ScopeUsage): DelegationError | undefined {
    const limits = this.config.limits
    if (s.knownEstimatedUsd >= limits.estimatedBudgetUsd)
      return new DelegationError(
        'BUDGET_LIMIT',
        'known estimated cost reached scope limit',
      )
    if (
      s.unpricedTokens >=
      (limits.maxUnpricedTokensPerTask ?? DEFAULT_UNPRICED_TOKENS_PER_TASK)
    )
      return new DelegationError(
        'TOKEN_LIMIT',
        'unpriced API tokens reached scope limit',
      )
    return undefined
  }
  private limit(scope: string): DelegationError | undefined {
    const s = this.usage(scope)
    if (s.runs >= this.config.limits.maxRunsPerTask)
      return new DelegationError('RUN_LIMIT', 'task scope run limit reached')
    return this.spent(s)
  }
  reserve(
    scope: string,
    profile: string,
    signal?: AbortSignal,
  ): Promise<BudgetLease> {
    if (signal?.aborted)
      return Promise.reject(
        signal.reason ?? new DOMException('Aborted', 'AbortError'),
      )
    const error = this.limit(scope)
    if (error) return Promise.reject(error)
    if (!this.config.profiles.some((p) => p.id === profile))
      return Promise.reject(
        new DelegationError('PROFILE_NOT_FOUND', 'budget profile missing'),
      )
    return new Promise((resolve, reject) => {
      const request = {
        scope,
        profile,
        resolve,
        reject,
        signal,
        abort: () => {
          const i = this.waiting.indexOf(request)
          if (i >= 0) this.waiting.splice(i, 1)
          signal?.removeEventListener('abort', request.abort)
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
          this.drain()
        },
      }
      if (!this.scopeOrder.includes(scope)) this.scopeOrder.push(scope)
      this.waiting.push(request)
      signal?.addEventListener('abort', request.abort, { once: true })
      this.drain()
    })
  }
  private drain(): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const w = this.waiting[i]!,
        error = this.limit(w.scope)
      if (error) {
        this.waiting.splice(i, 1)
        w.signal?.removeEventListener('abort', w.abort)
        w.reject(error)
      }
    }
    while (
      [...this.active.values()].reduce((a, b) => a + b, 0) <
      this.config.limits.globalConcurrency
    ) {
      const eligible = this.waiting.filter(
        (w) =>
          (this.active.get(w.profile) ?? 0) <
          (this.config.profiles.find((p) => p.id === w.profile)
            ?.concurrencyLimit ?? 0),
      )
      const start = this.lastScope
        ? this.scopeOrder.indexOf(this.lastScope)
        : -1
      const rotation = [
        ...this.scopeOrder.slice(start + 1),
        ...this.scopeOrder.slice(0, start + 1),
      ]
      const scope = rotation.find((s) => eligible.some((w) => w.scope === s))
      const w = eligible.find((w) => w.scope === scope)
      if (!w) return
      const error = this.limit(w.scope)
      if (error) {
        this.waiting.splice(this.waiting.indexOf(w), 1)
        w.signal?.removeEventListener('abort', w.abort)
        w.reject(error)
        continue
      }
      this.waiting.splice(this.waiting.indexOf(w), 1)
      w.signal?.removeEventListener('abort', w.abort)
      this.lastScope = w.scope
      this.active.set(w.profile, (this.active.get(w.profile) ?? 0) + 1)
      const s = this.scopes.get(w.scope) ?? freshScope()
      s.runs++
      this.scopes.set(w.scope, s)
      let released = false
      w.resolve({
        release: (usage) => {
          if (released) return
          released = true
          this.active.set(w.profile, (this.active.get(w.profile) ?? 1) - 1)
          account(s, usage)
          this.drain()
        },
      })
    }
  }
}
