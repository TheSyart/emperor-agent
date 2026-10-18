import { DelegationError, type ExecutorConfig } from './types'
export interface BudgetLease {
  release(usage?: { estimatedUsd?: number }): void
}
export class DelegationBudget {
  private readonly scopes = new Map<
    string,
    { runs: number; knownEstimatedUsd: number; unknownRuns: number }
  >()
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
  restore(
    scope: string,
    profile: string,
    usage: { estimatedUsd?: number } | undefined,
    held: boolean,
  ): BudgetLease | undefined {
    const s = this.scopes.get(scope) ?? {
      runs: 0,
      knownEstimatedUsd: 0,
      unknownRuns: 0,
    }
    s.runs++
    if (
      usage?.estimatedUsd === undefined ||
      !Number.isFinite(usage.estimatedUsd) ||
      usage.estimatedUsd < 0
    )
      s.unknownRuns++
    else s.knownEstimatedUsd += usage.estimatedUsd
    this.scopes.set(scope, s)
    if (!held) return undefined
    this.active.set(profile, (this.active.get(profile) ?? 0) + 1)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active.set(
          profile,
          Math.max(0, (this.active.get(profile) ?? 1) - 1),
        )
        this.drain()
      },
    }
  }
  reconfigure(config: ExecutorConfig): void {
    this.config = config
    this.drain()
  }
  usage(scope: string): {
    runs: number
    knownEstimatedUsd: number
    unknownRuns: number
    estimatedUsd?: number
  } {
    const s = this.scopes.get(scope) ?? {
      runs: 0,
      knownEstimatedUsd: 0,
      unknownRuns: 0,
    }
    return {
      ...s,
      ...(s.unknownRuns === 0 ? { estimatedUsd: s.knownEstimatedUsd } : {}),
    }
  }
  private limit(scope: string): DelegationError | undefined {
    const s = this.usage(scope)
    if (s.runs >= this.config.limits.maxRunsPerTask)
      return new DelegationError('RUN_LIMIT', 'task scope run limit reached')
    if (s.knownEstimatedUsd >= this.config.limits.estimatedBudgetUsd)
      return new DelegationError(
        'BUDGET_LIMIT',
        'known estimated cost reached scope limit',
      )
    return undefined
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
      const s = this.scopes.get(w.scope) ?? {
        runs: 0,
        knownEstimatedUsd: 0,
        unknownRuns: 0,
      }
      s.runs++
      this.scopes.set(w.scope, s)
      let released = false
      w.resolve({
        release: (usage) => {
          if (released) return
          released = true
          this.active.set(w.profile, (this.active.get(w.profile) ?? 1) - 1)
          if (
            usage?.estimatedUsd === undefined ||
            !Number.isFinite(usage.estimatedUsd) ||
            usage.estimatedUsd < 0
          )
            s.unknownRuns++
          else s.knownEstimatedUsd += usage.estimatedUsd
          this.drain()
        },
      })
    }
  }
}
