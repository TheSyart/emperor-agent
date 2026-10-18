/** Compaction session events (log-only; the replacement itself is a surface `user/message`). */

import type { ContentBlock, TokenUsage } from '../../llm/types'
import type { RepairContributor, RepairStep } from '../../session-log/store'

declare module '../../session-log/types' {
  interface SessionEventMap {
    /** Opens one compaction; `turn` is null for manual (idle) compaction. */
    'compaction/start': {
      compactionId: string
      turn: number | null
      sourceCommandId?: string
    }
    'compaction/summary': {
      compactionId: string
      sourceCommandId?: string
      summary: ContentBlock[]
      shadowedRange: { start: number; end: number }
      shadowedSeqs: number[]
      shadowedTokenCount: number
      provider: string
      model: string
      maxTokens?: number
      usage?: TokenUsage
    }
    /** Closes one compaction; `error` when it failed after starting. */
    'compaction/end': {
      compactionId: string
      turn: number | null
      sourceCommandId?: string
      error?: string
      /** Written by crash repair, not by the compaction itself. */
      repaired?: true
    }
    /** Shadow price of one pruned tool result (precedes its replacement). */
    'compaction/prune': {
      shadowedRange: { start: number; end: number }
      shadowedSeqs: number[]
      shadowedTokenCount: number
    }
  }
}

/**
 * Crash repair: a compaction the process died inside is closed. When its
 * summary already landed (summary, replacement and end are appended in one
 * synchronous run, so this is rare) the replacement stands and the end
 * carries no error; otherwise it ends with `interrupted`.
 */
export const compactionRepair: RepairContributor = {
  id: 'compaction',
  pairs: [['compaction/start', 'compaction/end']],
  repair(events) {
    const open = new Map<
      string,
      { openedAt: number; turn: number | null; sourceCommandId?: string }
    >()
    const summarized = new Set<string>()
    for (const event of events) {
      if (event.type === 'compaction/start')
        open.set(event.data.compactionId, {
          openedAt: event.seq,
          turn: event.data.turn,
          ...(event.data.sourceCommandId === undefined
            ? {}
            : { sourceCommandId: event.data.sourceCommandId }),
        })
      else if (event.type === 'compaction/summary')
        summarized.add(event.data.compactionId)
      else if (event.type === 'compaction/end')
        open.delete(event.data.compactionId)
    }
    return [...open].map(
      ([compactionId, { openedAt, turn, sourceCommandId }]) =>
        ({
          type: 'compaction/end',
          data: {
            compactionId,
            turn,
            ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
            ...(summarized.has(compactionId) ? {} : { error: 'interrupted' }),
            repaired: true,
          },
          openedAt,
        }) as RepairStep,
    )
  },
}
