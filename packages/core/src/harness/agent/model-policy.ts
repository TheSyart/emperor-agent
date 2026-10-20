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
 * - Cost cap: `policy.cost.maxUsdPerAgentTurn` is now one task's cap over
 *   the root and every subagent, failed attempts included, kept by the
 *   host's task tree (KRN-03, `host/task-tree.ts`). `llm/cost-cap` stays
 *   declared for logs written before it.
 */

import { randomUUID } from 'node:crypto'
import type {
  ModelExecutionPolicy,
  ModelFallbackTrigger,
} from '../../config/model-config'
import type { LlmClient } from '../../llm/client'
import { EMPTY_RESPONSE_CODE } from '../../llm/error'
import type { LlmFailure } from '../../llm/types'
import type { Session } from '../../session-log/session'
import type { Agent } from './agent'
import type {
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
    /** Logs before KRN-03: the turn's priced usage reached the per-turn cost cap. */
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

/**
 * The model an agent is on right now: inside a turn that fell back, the
 * fallback route's (it carries the rest of the turn); otherwise the route
 * its next request proposes. Throws when no route is configured.
 */
export function currentModel(agent: Agent, llm: LlmClient): string {
  const fallback =
    agent.status === 'running'
      ? turnFallback(agent.session, agent.position.turn)
      : undefined
  return fallback === undefined
    ? agent.proposedCallConfig().model
    : llm.route(fallback.to).modelId
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
