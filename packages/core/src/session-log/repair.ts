/**
 * Pending tool-result recovery, shared by crash repair of an interrupted
 * session log and by a live step that fails: both supply the missing tool
 * results (and, for crash repair, the step and turn boundaries) needed to
 * resume with a provider-valid transcript, and preserve every fully written
 * event.
 * @module @deepseek-ai/dsh-session/repair
 */

import { freezeMessage } from '../llm/message'
import type { ToolResultMessage } from '../llm/message'
import type { SessionEvent } from './types'

/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/**
 * Return deterministic synthetic events that close an open tail turn. Unmatched
 * calls receive error results first, followed by an open `step/end` and an
 * interrupted `turn/end`; sequences continue the log and timestamps reuse the
 * last real event. A balanced or empty log returns no events.
 *
 * @param events - the loaded durable log to scan (a valid committed prefix, possibly with a crash tail).
 * @returns the synthetic closer events to append after `events`, in order; empty when the log is already balanced.
 */
export function interruptedTurnClosers(
  events: readonly SessionEvent[],
): SessionEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  // Reset at each turn and step boundary so earlier calls cannot leak into tail repair.
  const recovery = new ToolCallRecovery()
  for (const event of events) {
    recovery.observe(event)
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        openStep = null
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = event.data.step
        break
      case 'step/end':
        openStep = null
        break
      // Other event types do not move the turn/step boundary cursor.
      default:
        break
    }
  }

  // Balanced log (no crash mid-turn): nothing to close. An open turn implies
  // `events` is non-empty (its turn/start was logged), so `last` exists.
  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []

  // The last real event supplies the seq base and the timestamp for the
  // synthetic closers (reusing the last timestamp keeps them deterministic and
  // never invents a "future" time).
  const time = last.time
  // Close calls before their step: providers reject dangling assistant calls.
  const closers: SessionEvent[] = recovery.results(last.seq + 1, time)
  let seq = last.seq + 1 + closers.length

  // Close an open step next — a turn/end while a step is open is an invariant
  // violation, so the step's boundary must be synthesized before the turn's.
  if (openStep !== null) {
    closers.push({
      type: 'step/end',
      seq: seq++,
      time,
      data: { turn: openTurn, step: openStep },
    })
  }
  closers.push({
    type: 'turn/end',
    seq: seq++,
    time,
    data: { turn: openTurn, reason: { kind: 'interrupted' } },
  })
  return closers
}

/**
 * Tracks the assistant tool requests of one session that have no
 * `tool/result` yet. Feed it the events of the open step (or the whole log)
 * in order; turn and step boundaries discard what earlier steps left open.
 */
export class ToolCallRecovery {
  // Assistant blocks register calls; a later `tool/call` adds its seq for `sourceEventSeqs`.
  private readonly pending = new Map<
    string,
    { turn: number; step: number; callSeq?: number }
  >()

  observe(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
      case 'step/end':
        this.pending.clear()
        break
      case 'assistant/message':
        // Each tool-call block is pending until a tool/result with its callId.
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call')
            this.pending.set(block.id, {
              turn: event.data.turn,
              step: event.data.step,
            })
        }
        break
      case 'tool/call': {
        const entry = this.pending.get(event.data.callId)
        if (entry) entry.callSeq = event.seq
        break
      }
      case 'tool/result':
        this.pending.delete(event.data.message.source.callId)
        break
      // Other event types do not answer or open tool requests.
      default:
        break
    }
  }

  /**
   * Conservative error results for every unanswered request, in transcript
   * order. Sequences start at `seq`, timestamps are `time`; callers append
   * them in this order so the seq inside each message id stays exact.
   */
  results(seq: number, time: number): SessionEvent<'tool/result'>[] {
    const results: SessionEvent<'tool/result'>[] = []
    // Map insertion order preserves the calls' transcript order.
    for (const [callId, { turn, step, callSeq }] of this.pending) {
      const started = callSeq !== undefined
      const message: ToolResultMessage = freezeMessage({
        id: `interrupted-tool-result-${callId}-${seq}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [
          {
            type: 'tool-result',
            toolCallId: callId,
            isError: true,
            content: [
              {
                type: 'text',
                text: started
                  ? 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'
                  : 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
              },
            ],
          },
        ],
      })
      results.push({
        type: 'tool/result',
        seq: seq++,
        time,
        data: {
          turn,
          step,
          message,
          error: started
            ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
            : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
        },
        surfaceOp: 'append',
        ...(started ? { sourceEventSeqs: [callSeq] } : {}),
      })
    }
    return results
  }
}
