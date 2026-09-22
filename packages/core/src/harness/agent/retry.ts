/**
 * Request-retry middleware (ported from dsh-llm-retry).
 *
 * On a failed request it applies the route's retry policy: before waiting
 * it logs `llm/retry` (retry number, planned delay, failure), then
 * `llm/retry-started` right before re-requesting. The retry count for the
 * current step is derived from the log, so it survives nothing but is also
 * never double-counted.
 */

import { randomUUID } from 'node:crypto'
import {
  retryDelayMs,
  retryPolicyKey,
  shouldRetry,
} from '../../llm/retry-policy'
import type { LlmFailure } from '../../llm/types'
import type { Session } from '../../session-log/session'
import { abortableSleep } from '../../util/timeout'
import type { RequestErrorMiddleware } from './middleware'

declare module '../../session-log/types' {
  interface SessionEventMap {
    'llm/retry': {
      retryId: string
      turn: number
      step: number
      provider: string
      mode: 'normal' | 'always'
      policyKey: string
      retry: number
      maxRetries?: number
      delayMs: number
      failure: LlmFailure
    }
    'llm/retry-started': { retryId: string; turn: number; step: number }
  }
}

/** Retries already logged in the current step for one provider + policy. */
function retriesInStep(
  session: Session,
  turn: number,
  step: number,
  provider: string,
  policyKey: string,
): number {
  let count = 0
  const events = session.events
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (
      event.type === 'step/start' &&
      event.data.turn === turn &&
      event.data.step === step
    )
      break
    if (
      event.type === 'llm/retry' &&
      event.data.provider === provider &&
      event.data.policyKey === policyKey
    )
      count += 1
  }
  return count
}

export function retryMiddleware(
  random: () => number = Math.random,
): RequestErrorMiddleware {
  return async ({
    agent,
    turn,
    step,
    provider,
    failure,
    retryPolicy,
    signal,
  }) => {
    if (retryPolicy === undefined || signal.aborted) return undefined
    const policyKey = retryPolicyKey(retryPolicy)
    const retry =
      retriesInStep(agent.session, turn, step, provider, policyKey) + 1
    if (!shouldRetry(retryPolicy, failure, retry)) return undefined
    const delayMs = retryDelayMs(retryPolicy, retry, failure, random)
    const retryId = randomUUID()
    agent.session.append('llm/retry', {
      retryId,
      turn,
      step,
      provider,
      mode: retryPolicy.mode,
      policyKey,
      retry,
      ...(retryPolicy.mode === 'normal'
        ? { maxRetries: retryPolicy.maxRetries }
        : {}),
      delayMs,
      failure,
    })
    await abortableSleep(delayMs, signal)
    agent.session.append('llm/retry-started', { retryId, turn, step })
    return 'retry'
  }
}
