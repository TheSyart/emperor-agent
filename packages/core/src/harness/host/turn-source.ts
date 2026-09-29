/**
 * Facts about the turn an agent is currently running, read from its log:
 * which prompt opened it (`host/user-meta.source`, e.g. `scheduler`), the
 * scheduler job behind it, and whether it is a goal round.
 */

import type { SessionEvent } from '../../session-log/types'
import { GOAL_ROUND_PRODUCER } from '../goal/round-driver'

export interface TurnInfo {
  /** Latest `turn/start` number, if any turn started. */
  readonly turn?: number
  /** `host/user-meta.source` of the prompt that opened the turn. */
  readonly source?: string
  /** Scheduler job id when the turn came from the scheduler. */
  readonly schedulerJobId?: string
  /** The turn was opened by a `<goal_round>` continuation prompt. */
  readonly goalRound: boolean
}

/** Facts about the latest turn in a session log. */
export function currentTurnInfo(events: readonly SessionEvent[]): TurnInfo {
  let lastTurnStart = -1
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type === 'turn/start') {
      lastTurnStart = index
      break
    }
  }
  if (lastTurnStart < 0) return { goalRound: false }
  const start = events[lastTurnStart]!
  const turn = start.type === 'turn/start' ? start.data.turn : undefined
  const metas = new Map<string, { source?: string; jobId?: string }>()
  for (const event of events) {
    if (event.type !== 'host/user-meta') continue
    const jobId = event.data.scheduler?.jobId
    metas.set(event.data.messageId, {
      ...(event.data.source === undefined ? {} : { source: event.data.source }),
      ...(typeof jobId === 'string' ? { jobId } : {}),
    })
  }
  for (let index = lastTurnStart + 1; index < events.length; index++) {
    const event = events[index]
    if (event?.type === 'turn/end') break
    if (event?.type !== 'user/message') continue
    const message = event.data
    if (
      message.source.kind === 'context' &&
      message.source.producer === GOAL_ROUND_PRODUCER
    )
      return { ...(turn === undefined ? {} : { turn }), goalRound: true }
    const meta = metas.get(message.id)
    if (meta?.source !== undefined)
      return {
        ...(turn === undefined ? {} : { turn }),
        source: meta.source,
        ...(meta.jobId === undefined ? {} : { schedulerJobId: meta.jobId }),
        goalRound: false,
      }
  }
  return { ...(turn === undefined ? {} : { turn }), goalRound: false }
}

/** `host/user-meta` source of the prompt that opened the latest turn. */
export function currentTurnSource(
  events: readonly SessionEvent[],
): string | undefined {
  return currentTurnInfo(events).source
}
