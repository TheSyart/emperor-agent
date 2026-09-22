/**
 * Request-reconstruction invariant (ported from dsh-agent-loop invariant.ts):
 * a loop-built model request must be exactly what the session log derives
 * at dispatch time — its messages equal `session.deriveMessages()` and its
 * system prompt, tools, and call config equal the folded `request/header`.
 * Model-visible ⟺ logged. Test harnesses install it on the LLM client.
 */

import type { GenerateOptions } from '../../llm/types'
import type { Session } from '../../session-log/session'
import { foldRequestHeader } from '../../session-log/request-header'

export class RequestInvariantError extends Error {
  constructor(message: string) {
    super(`request invariant violated: ${message}`)
    this.name = 'RequestInvariantError'
  }
}

/** Loop requests carry a session id and no auxiliary `purpose`. */
export function isLoopRequest(options: GenerateOptions): boolean {
  return options.sessionId !== undefined && options.purpose === undefined
}

/**
 * Throw when a loop-built request diverges from its session's durable
 * derivation. Non-loop requests (titles, compaction summaries) pass.
 */
export function assertRequestInvariant(
  options: GenerateOptions,
  lookup: (sessionId: string) => Session | undefined,
): void {
  if (!isLoopRequest(options)) return
  const sessionId = options.sessionId!
  const session = lookup(sessionId)
  if (session === undefined)
    throw new RequestInvariantError(
      `a loop-built request must carry a live session id, got "${sessionId}"`,
    )
  const events = session.events
  if (!events.some((event) => event.type === 'step/start'))
    throw new RequestInvariantError(
      `session "${sessionId}" has no step/start before its request`,
    )
  const header = foldRequestHeader(events)
  if (header === undefined)
    throw new RequestInvariantError(
      `session "${sessionId}" has no request/header before its request`,
    )
  if (
    JSON.stringify(options.messages) !==
    JSON.stringify(session.deriveMessages())
  )
    throw new RequestInvariantError(
      `messages for session "${sessionId}" diverge from the durable derivation`,
    )
  const headerMatches =
    options.model === header.config.model &&
    options.system === header.system &&
    options.temperature === header.config.temperature &&
    options.maxTokens === header.config.maxTokens &&
    JSON.stringify(options.stop) === JSON.stringify(header.config.stop) &&
    JSON.stringify(options.tools ?? []) === JSON.stringify(header.tools ?? [])
  if (!headerMatches)
    throw new RequestInvariantError(
      `request for session "${sessionId}" diverges from the folded request header`,
    )
}
