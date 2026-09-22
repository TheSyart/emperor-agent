/**
 * Token meter (ported from dsh-token-meter).
 *
 * Heuristic: ceil(chars / 4) per text, + 4 per block, + 4 per role; header
 * cost = system prompt + JSON of the tools. When the latest successful call's
 * provider usage belongs to an unchanged request header, that usage is the
 * baseline and only surface nodes added (or replaced) since are estimated;
 * otherwise the whole request is estimated.
 */

import type { ContentBlock, Message, TokenUsage } from '../../llm/types'
import { headerEquals } from '../../session-log/request-header'
import type { Session } from '../../session-log/session'
import { deriveEventMessage, isSurfaceEvent } from '../../session-log/surface'
import type { EpochHeader, SessionEvent } from '../../session-log/types'

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
export const ROLE_OVERHEAD = 4

export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens +=
          Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens +=
          Math.ceil(block.name.length / CHARS_PER_TOKEN) +
          Math.ceil(block.arguments.length / CHARS_PER_TOKEN) +
          BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD
        break
      default:
        tokens +=
          BLOCK_OVERHEAD +
          Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

export function estimateMessage(message: Pick<Message, 'content'>): number {
  return estimateContent(message.content) + ROLE_OVERHEAD
}

export function estimateHeader(header: EpochHeader | undefined): number {
  if (header === undefined) return 0
  const system =
    header.system === undefined
      ? 0
      : Math.ceil(header.system.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
  const tools =
    header.tools === undefined || header.tools.length === 0
      ? 0
      : Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) +
        BLOCK_OVERHEAD
  return system + tools
}

export function usageTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0) +
    usage.outputTokens
  )
}

export interface TokenSurfaceNode {
  seq: number
  tokens: number
}

export type TokenBaseline =
  | { kind: 'none'; tokens: 0 }
  | { kind: 'estimated'; tokens: number }
  | { kind: 'usage'; tokens: number; usage: TokenUsage }

export interface TokenMeasurement {
  /** Log length this measurement consumed. */
  logRevision: number
  baseline: TokenBaseline
  /** Signed surface change since the baseline anchor. */
  surfaceDeltaTokens: number
  /** Request + response pressure. */
  totalTokens: number
  /** Heuristic surface total (= sum of nodes). */
  surfaceTokens: number
  nodes: TokenSurfaceNode[]
}

interface Anchor {
  header: EpochHeader | undefined
  surfaceTokens: number
  baseline: Exclude<TokenBaseline, { kind: 'none' }>
}

interface FoldState {
  consumed: number
  header: EpochHeader | undefined
  nodes: TokenSurfaceNode[]
  surfaceTokens: number
  anchor: Anchor | undefined
}

function nodeTokens(event: SessionEvent): number {
  const message = deriveEventMessage(event)
  return message === null ? 0 : estimateMessage(message)
}

export class TokenMeter {
  private readonly states = new WeakMap<Session, FoldState>()

  measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement {
    const state = this.sync(session)
    const header = requestHeader ?? state.header
    const anchor = state.anchor
    let baseline: TokenBaseline
    let surfaceDeltaTokens: number
    const sameHeader =
      anchor !== undefined &&
      (anchor.header === undefined || header === undefined
        ? anchor.header === header
        : headerEquals(anchor.header, header))
    if (anchor !== undefined && sameHeader) {
      baseline = anchor.baseline
      surfaceDeltaTokens = state.surfaceTokens - anchor.surfaceTokens
    } else if (header === undefined && state.surfaceTokens === 0) {
      baseline = { kind: 'none', tokens: 0 }
      surfaceDeltaTokens = 0
    } else {
      baseline = {
        kind: 'estimated',
        tokens: estimateHeader(header) + state.surfaceTokens,
      }
      surfaceDeltaTokens = 0
    }
    return {
      logRevision: state.consumed,
      baseline,
      surfaceDeltaTokens,
      totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
      surfaceTokens: state.surfaceTokens,
      nodes: state.nodes.map((node) => ({ ...node })),
    }
  }

  estimateMessage(message: Pick<Message, 'content'>): number {
    return estimateMessage(message)
  }

  private sync(session: Session): FoldState {
    let state = this.states.get(session)
    if (state === undefined) {
      state = {
        consumed: 0,
        header: undefined,
        nodes: [],
        surfaceTokens: 0,
        anchor: undefined,
      }
      this.states.set(session, state)
    }
    const events = session.events
    while (state.consumed < events.length) {
      this.fold(state, events[state.consumed]!)
      state.consumed += 1
    }
    return state
  }

  private fold(state: FoldState, event: SessionEvent): void {
    if (event.type === 'request/header') state.header = event.data.header
    if (!isSurfaceEvent(event)) return
    const tokens = nodeTokens(event)
    if (event.surfaceOp === 'append') {
      state.nodes.push({ seq: event.seq, tokens })
      state.surfaceTokens += tokens
    } else {
      const op = event.surfaceOp as { start: number; end: number }
      const startIdx = state.nodes.findIndex((node) => node.seq === op.start)
      const endIdx = state.nodes.findIndex((node) => node.seq === op.end)
      if (startIdx >= 0 && endIdx >= startIdx) {
        const removed = state.nodes.splice(startIdx, endIdx - startIdx + 1, {
          seq: event.seq,
          tokens,
        })
        state.surfaceTokens +=
          tokens - removed.reduce((sum, node) => sum + node.tokens, 0)
      }
    }
    if (event.type === 'assistant/message') {
      const usage = event.data.usage
      const estimated = estimateHeader(state.header) + state.surfaceTokens
      state.anchor =
        usage !== undefined &&
        state.header !== undefined &&
        usageTokens(usage) >= estimated
          ? {
              header: state.header,
              surfaceTokens: state.surfaceTokens,
              baseline: { kind: 'usage', tokens: usageTokens(usage), usage },
            }
          : {
              header: state.header,
              surfaceTokens: state.surfaceTokens,
              baseline: { kind: 'estimated', tokens: estimated },
            }
    }
  }
}
