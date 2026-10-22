/**
 * What opened a root turn (UI-S15), read from the messages of its first
 * step. A message the user (or a scheduler) sent opens a task; a turn that
 * a result woke — a subagent's (local, Claude Code or Codex), a background
 * job's — a goal round, or anything else continues the task that runs.
 * A message the user inserts into a running turn (运行中插入, through the
 * next-step inbox) opens nothing, even when it lands in a first step.
 *
 * The turn file recorder ends a task with this rule; the renderer marks
 * woken turns with it (「子智能体完成后继续」). Pure and browser-safe: only
 * type imports, the producers named here (a test keeps them equal to the
 * harness's own constants).
 */

import type { MessageSource } from '../../llm/types'

export type TurnOpener = 'user' | 'subagent' | 'job' | 'goal' | 'other'

/** Context producers whose messages open a turn of their own. */
export const TURN_OPENER_PRODUCERS = {
  /** A local subagent settled or reported. */
  subagent: 'subagent',
  /** A Claude Code or Codex run settled. */
  delegation: 'delegation',
  /** A background job finished. */
  job: 'jobs',
  /** The goal's next round. */
  goal: 'goal',
} as const

/** The part of a message source this rule reads. */
export type TurnOpenerSource =
  | {
      readonly kind: 'user'
      /** Inserted into the running turn (the next-step inbox). */
      readonly steering?: boolean
    }
  | { readonly kind: 'context'; readonly producer: string }
  | { readonly kind: Exclude<MessageSource['kind'], 'user' | 'context'> }

/** What opened a turn whose first step carries these messages. */
export function turnOpener(
  sources: Iterable<TurnOpenerSource | undefined>,
): TurnOpener {
  let subagent = false
  let job = false
  let goal = false
  for (const source of sources) {
    if (source === undefined) continue
    if (source.kind === 'user') {
      if (source.steering !== true) return 'user'
      continue
    }
    if (source.kind !== 'context') continue
    switch (source.producer) {
      case TURN_OPENER_PRODUCERS.subagent:
      case TURN_OPENER_PRODUCERS.delegation:
        subagent = true
        break
      case TURN_OPENER_PRODUCERS.job:
        job = true
        break
      case TURN_OPENER_PRODUCERS.goal:
        goal = true
        break
      default:
        break
    }
  }
  return subagent ? 'subagent' : job ? 'job' : goal ? 'goal' : 'other'
}
