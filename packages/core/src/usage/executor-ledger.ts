/**
 * A settled Claude Code or Codex run in the token ledger (SET-01): one row
 * under the root session, filed by backend, so 用量与费用 counts external
 * spend next to Emperor's own. The run's counts already follow the ledger
 * (input without cache reads, output with reasoning), so reasoning is not
 * added again. A subscription run is recorded at no cost.
 */
import type {
  DelegationOwner,
  ExecutorRunUsage,
  ExternalBackend,
} from '../harness/delegation/types'
import type { TokenTracker } from '../memory/token-tracker'

export interface ExecutorSpend {
  owner: DelegationOwner
  backend: ExternalBackend
  usage: ExecutorRunUsage
  model?: string
}

export function recordExecutorSpend(
  tracker: TokenTracker,
  spend: ExecutorSpend,
): void {
  const usage = spend.usage
  tracker.record(
    spend.model || spend.backend,
    {
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cache_read: usage.cacheReadTokens ?? 0,
      cache_create: 0,
    },
    {
      provider: spend.backend,
      usageType: 'executor',
      modelEntryId: spend.backend,
      sessionId: spend.owner.rootSessionId,
      source: spend.backend,
      ...(usage.billing === 'subscription'
        ? { subscription: true }
        : { costUsd: usage.estimatedUsd ?? null }),
    },
  )
}
