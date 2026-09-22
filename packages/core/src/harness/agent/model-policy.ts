/**
 * Enforcement of the saved `model_config.json` execution policy
 * (`ModelExecutionPolicy`) inside the agent loop.
 *
 * - Fallback: a request-error handler installed AFTER the retry middleware.
 *   When retries gave up on a failure whose kind is listed in
 *   `policy.fallback.triggerOn` (`rate_limit` → `RATE_LIMIT`; `transient` →
 *   server/timeout/transport/empty-response codes), it logs `llm/fallback`
 *   and re-requests. A request-config handler then routes every remaining
 *   request of that turn to the fallback entry; the next turn starts on the
 *   primary route again (the old per-turn semantics).
 * - Cost cap: a pre-step handler sums the priced usage of the current turn's
 *   assistant messages and rejects the next step once the sum reached
 *   `policy.cost.maxUsdPerAgentTurn` (logged as `llm/cost-cap`).
 */

import { randomUUID } from 'node:crypto'
import type {
  ModelExecutionPolicy,
  ModelFallbackTrigger,
  ModelPricing,
} from '../../config/model-config'
import type { LlmClient } from '../../llm/client'
import { EMPTY_RESPONSE_CODE } from '../../llm/error'
import type { LlmFailure } from '../../llm/types'
import { calculateUsageCost, usdToNanos } from '../../model/execution-policy'
import type { Session } from '../../session-log/session'
import type {
  PreStepMiddleware,
  RequestConfigMiddleware,
  RequestErrorMiddleware,
} from './middleware'

declare module '../../session-log/types' {
  interface SessionEventMap {
    /** The rest of this turn's requests go to the policy fallback route. */
    'llm/fallback': {
      fallbackId: string
      turn: number
      step: number
      from: string
      to: string
      trigger: ModelFallbackTrigger
      failure: LlmFailure
    }
    /** The turn's priced usage reached the per-turn cost cap; the turn stops. */
    'llm/cost-cap': {
      turn: number
      step: number
      capUsdNanos: number
      spentUsdNanos: number
      /** Usage from routes without pricing could not be counted. */
      unpricedRoutes?: string[]
    }
  }
}

export interface ModelPolicySource {
  /** The current saved policy (re-read on every decision). */
  policy(): ModelExecutionPolicy | undefined
  /** Pricing of one route (model entry id), when configured. */
  pricing(routeId: string): ModelPricing | undefined
}

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  EMPTY_RESPONSE_CODE,
])

/** The policy trigger a failure falls under, if any. */
export function fallbackTriggerOf(
  failure: LlmFailure,
): ModelFallbackTrigger | undefined {
  if (failure.code === 'RATE_LIMIT' || failure.status === 429)
    return 'rate_limit'
  if (TRANSIENT_CODES.has(failure.code)) return 'transient'
  return undefined
}

/** The `llm/fallback` event of one turn, scanning back to its `turn/start`. */
export function turnFallback(
  session: Session,
  turn: number,
): { to: string } | undefined {
  const events = session.events
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'turn/start' && event.data.turn === turn) break
    if (event.type === 'llm/fallback' && event.data.turn === turn)
      return { to: event.data.to }
  }
  return undefined
}

/** Priced cost (nano-USD) of one turn's assistant messages so far. */
export function turnCostUsdNanos(
  session: Session,
  turn: number,
  pricing: (routeId: string) => ModelPricing | undefined,
): { spentUsdNanos: number; unpricedRoutes: string[] } {
  let spentUsdNanos = 0
  const unpriced = new Set<string>()
  const events = session.events
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'turn/start' && event.data.turn === turn) break
    if (event.type !== 'assistant/message' || event.data.turn !== turn) continue
    const usage = event.data.usage
    if (usage === undefined) continue
    const route = event.data.message.source.provider
    const cost = calculateUsageCost(
      {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cache_read: usage.cacheReadTokens ?? 0,
        cache_create: usage.cacheWriteTokens ?? 0,
      },
      pricing(route),
    )
    if (cost.costUsdNanos === null) unpriced.add(route)
    else spentUsdNanos += cost.costUsdNanos
  }
  return { spentUsdNanos, unpricedRoutes: [...unpriced] }
}

export function fallbackErrorMiddleware(
  source: ModelPolicySource,
  llm: LlmClient,
): RequestErrorMiddleware {
  return ({ agent, turn, step, provider, failure, signal }) => {
    if (signal.aborted) return undefined
    const fallback = source.policy()?.fallback
    if (fallback?.enabled !== true || !fallback.entryId) return undefined
    const to = fallback.entryId
    if (to === provider || turnFallback(agent.session, turn) !== undefined)
      return undefined
    const trigger = fallbackTriggerOf(failure)
    if (trigger === undefined || !fallback.triggerOn.includes(trigger))
      return undefined
    try {
      llm.route(to)
    } catch {
      return undefined
    }
    agent.session.append('llm/fallback', {
      fallbackId: randomUUID(),
      turn,
      step,
      from: provider,
      to,
      trigger,
      failure,
    })
    return 'retry'
  }
}

export function fallbackConfigMiddleware(
  llm: LlmClient,
): RequestConfigMiddleware {
  return ({ agent, turn, config }) => {
    const fallback = turnFallback(agent.session, turn)
    if (fallback === undefined || config.provider === fallback.to)
      return undefined
    try {
      // The fallback route's own defaults: efforts/limits of the primary may not apply.
      return llm.defaultCallConfig(fallback.to)
    } catch {
      return undefined
    }
  }
}

export function costCapMiddleware(
  source: ModelPolicySource,
): PreStepMiddleware {
  return ({ agent, turn, step }) => {
    const cap = source.policy()?.cost.maxUsdPerAgentTurn
    if (cap === null || cap === undefined) return undefined
    const capUsdNanos = usdToNanos(cap)
    const { spentUsdNanos, unpricedRoutes } = turnCostUsdNanos(
      agent.session,
      turn,
      (routeId) => source.pricing(routeId),
    )
    if (spentUsdNanos < capUsdNanos && unpricedRoutes.length === 0)
      return undefined
    agent.session.append('llm/cost-cap', {
      turn,
      step,
      capUsdNanos,
      spentUsdNanos,
      ...(unpricedRoutes.length === 0 ? {} : { unpricedRoutes }),
    })
    return { kind: 'reject' }
  }
}
