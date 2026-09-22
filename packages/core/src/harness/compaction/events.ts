/** Compaction session events (log-only; the replacement itself is a surface `user/message`). */

import type { ContentBlock, TokenUsage } from '../../llm/types'

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
    }
    /** Shadow price of one pruned tool result (precedes its replacement). */
    'compaction/prune': {
      shadowedRange: { start: number; end: number }
      shadowedSeqs: number[]
      shadowedTokenCount: number
    }
  }
}

export {}
