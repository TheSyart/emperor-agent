/**
 * Model-free tool-result pruner (ported from dsh-compaction-tool-result-pruner).
 *
 * Every current `tool/result` whose text exceeds `thresholdChars` keeps its
 * first `headChars` and last `tailChars` code points around a marker. Each
 * replacement is a surface `replace` of exactly that node, preceded by a
 * `compaction/prune` shadow-price event.
 */

import { freezeMessage, type ToolResultMessage } from '../../llm/message'
import type { ContentBlock } from '../../llm/types'
import type { Session } from '../../session-log/session'
import { estimateMessage } from './token-meter'
import './events'

export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

export interface ToolResultPruneConfig {
  thresholdChars: number
  headChars: number
  tailChars: number
}

export const DEFAULT_PRUNE_CONFIG: ToolResultPruneConfig = Object.freeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
})

function codePointLength(text: string): number {
  let length = 0
  for (const _ of text) length += 1
  return length
}

export interface PruneResult {
  pruned: Array<{
    originalSeq: number
    replacementSeq: number
    callId: string
    charsBefore: number
    charsAfter: number
  }>
  charsRemoved: number
}

export class ToolResultPruner {
  readonly config: ToolResultPruneConfig

  constructor(config: Partial<ToolResultPruneConfig> = {}) {
    this.config = { ...DEFAULT_PRUNE_CONFIG, ...config }
    const { thresholdChars, headChars, tailChars } = this.config
    if (
      headChars + tailChars + codePointLength(PRUNE_MARKER) >=
      thresholdChars
    ) {
      throw new Error(
        'tool-result pruner: headChars + tailChars + marker must be below thresholdChars',
      )
    }
  }

  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks)
      if (block.type === 'text') chars += codePointLength(block.text)
    return chars
  }

  /** Replace an over-budget text middle; `null` when within budget. */
  pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null
    const removedStart = this.config.headChars
    const removedEnd = totalChars - this.config.tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false
    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }
      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(
        points.length,
        Math.max(0, removedStart - blockStart),
      )
      const tailStart = Math.min(
        points.length,
        Math.max(0, removedEnd - blockStart),
      )
      const intersects = blockStart < removedEnd && blockEnd > removedStart
      const marker = intersects && !markerInserted ? PRUNE_MARKER : ''
      if (marker.length > 0) markerInserted = true
      const text =
        points.slice(0, headEnd).join('') +
        marker +
        points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }
    if (!markerInserted)
      throw new Error(
        'tool-result prune: failed to locate the removed text span',
      )
    return pruned
  }

  /** Prune every over-budget tool result on the current surface. */
  pruneSession(session: Session): PruneResult {
    const candidates: number[] = []
    for (const seq of [...session.surface.nodes]) {
      if (session.events[seq]?.type === 'tool/result') candidates.push(seq)
    }
    const result: PruneResult = { pruned: [], charsRemoved: 0 }
    for (const seq of candidates) {
      const event = session.events[seq]
      if (event?.type !== 'tool/result') continue
      const block = event.data.message.content[0]
      const content = this.pruneContent(block.content)
      if (content === null) continue
      const charsBefore = this.measureContent(block.content)
      const charsAfter = this.measureContent(content)
      const message = freezeMessage<ToolResultMessage>({
        ...event.data.message,
        content: [{ ...block, content }] as [typeof block],
      })
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: estimateMessage(event.data.message),
      })
      const replacement = session.append(
        'tool/result',
        { ...event.data, message },
        {
          surfaceOp: { op: 'replace', start: seq, end: seq },
          sourceEventSeqs: [seq],
        },
      )
      result.pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
      })
      result.charsRemoved += charsBefore - charsAfter
    }
    return result
  }
}
