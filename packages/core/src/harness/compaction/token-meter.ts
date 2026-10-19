/**
 * Token meter (ported from dsh-token-meter; KRN-05 pricing and calibration).
 *
 * Heuristic: text by character class (CJK ideographs and kana ≈ 1 token,
 * ASCII ≈ 4 characters, anything else ≈ 2), images by the pricing of the
 * route that sees them, + 4 per block, + 4 per role; header cost = system
 * prompt + JSON of the tools. Every heuristic figure is scaled by the
 * session's calibration: an exponential moving average (α = 0.3) of
 * provider usage ÷ heuristic price over its calls, seeded by the first
 * believable one. When the latest successful call's provider usage belongs
 * to an unchanged request header, that usage is the baseline and only
 * surface nodes added (or replaced) since are estimated; otherwise the
 * whole request is estimated.
 */

import { offloadMessageImages } from '../../llm/content'
import type { ContentBlock, Message, TokenUsage } from '../../llm/types'
import {
  estimateImageTokens,
  estimateTextTokens,
  type ImagePricing,
} from '../../llm/token-estimate'
import { headerEquals } from '../../session-log/request-header'
import type { Session } from '../../session-log/session'
import { deriveEventMessage, isSurfaceEvent } from '../../session-log/surface'
import type { EpochHeader, SessionEvent } from '../../session-log/types'

const BLOCK_OVERHEAD = 4
export const ROLE_OVERHEAD = 4
/** Weight of the newest usage sample in the session's calibration. */
export const CALIBRATION_ALPHA = 0.3
/** Usage ÷ heuristic outside this band cannot belong to the request: ignored. */
const CALIBRATION_MIN_RATIO = 0.25
const CALIBRATION_MAX_RATIO = 4
/** Image pricing when the route is unknown (Emperor's default provider). */
export const DEFAULT_IMAGE_PRICING: ImagePricing = 'deepseek'

export function estimateContent(
  blocks: readonly ContentBlock[],
  pricing: ImagePricing = DEFAULT_IMAGE_PRICING,
): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateTextTokens(block.text) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens +=
          estimateTextTokens(block.name) +
          estimateTextTokens(block.arguments) +
          BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContent(block.content, pricing) + BLOCK_OVERHEAD
        break
      case 'image':
        tokens +=
          estimateImageTokens(block.attachment, pricing) + BLOCK_OVERHEAD
        break
      default:
        tokens += BLOCK_OVERHEAD + estimateTextTokens(JSON.stringify(block))
    }
  }
  return tokens
}

export function estimateMessage(
  message: Pick<Message, 'content'>,
  pricing: ImagePricing = DEFAULT_IMAGE_PRICING,
): number {
  return estimateContent(message.content, pricing) + ROLE_OVERHEAD
}

export function estimateHeader(header: EpochHeader | undefined): number {
  if (header === undefined) return 0
  const system =
    header.system === undefined
      ? 0
      : estimateTextTokens(header.system) + ROLE_OVERHEAD
  const tools =
    header.tools === undefined || header.tools.length === 0
      ? 0
      : estimateTextTokens(JSON.stringify(header.tools)) + BLOCK_OVERHEAD
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
  /** Calibrated heuristic surface total (≈ sum of nodes). */
  surfaceTokens: number
  /** Calibrated per-node prices. */
  nodes: TokenSurfaceNode[]
  /** Provider tokens per heuristic token for this session (1 before any usage). */
  calibration: number
}

interface Anchor {
  header: EpochHeader | undefined
  /** Raw surface price at the anchor. */
  surfaceTokens: number
  usage?: TokenUsage
}

interface FoldState {
  consumed: number
  pricing: ImagePricing
  header: EpochHeader | undefined
  /** Raw (uncalibrated) node prices. */
  nodes: TokenSurfaceNode[]
  surfaceTokens: number
  anchor: Anchor | undefined
  offloaded: Set<number>
  calibration: number
  samples: number
}

export interface TokenMeterOptions {
  /** Image pricing of the route the session's next request goes to. */
  imagePricing?: (session: Session) => ImagePricing
}

export class TokenMeter {
  private readonly states = new WeakMap<Session, FoldState>()

  constructor(private readonly options: TokenMeterOptions = {}) {}

  measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement {
    const state = this.sync(session)
    const scale = state.calibration
    const header = requestHeader ?? state.header
    const anchor = state.anchor
    let baseline: TokenBaseline
    let surfaceDeltaTokens: number
    const sameHeader =
      anchor !== undefined &&
      (anchor.header === undefined || header === undefined
        ? anchor.header === header
        : headerEquals(anchor.header, header))
    if (anchor?.usage !== undefined && sameHeader) {
      baseline = {
        kind: 'usage',
        tokens: usageTokens(anchor.usage),
        usage: anchor.usage,
      }
      surfaceDeltaTokens = Math.round(
        scale * (state.surfaceTokens - anchor.surfaceTokens),
      )
    } else if (header === undefined && state.surfaceTokens === 0) {
      baseline = { kind: 'none', tokens: 0 }
      surfaceDeltaTokens = 0
    } else {
      baseline = {
        kind: 'estimated',
        tokens: Math.round(
          scale * (estimateHeader(header) + state.surfaceTokens),
        ),
      }
      surfaceDeltaTokens = 0
    }
    return {
      logRevision: state.consumed,
      baseline,
      surfaceDeltaTokens,
      totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
      surfaceTokens: Math.round(scale * state.surfaceTokens),
      nodes: state.nodes.map((node) => ({
        seq: node.seq,
        tokens: Math.round(scale * node.tokens),
      })),
      calibration: scale,
    }
  }

  /** Price of a message not (yet) in the log; calibrated for `session` when given. */
  estimateMessage(
    message: Pick<Message, 'content'>,
    session?: Session,
  ): number {
    if (session === undefined) return estimateMessage(message)
    const state = this.sync(session)
    return Math.round(
      state.calibration * estimateMessage(message, state.pricing),
    )
  }

  private sync(session: Session): FoldState {
    const pricing =
      this.options.imagePricing?.(session) ?? DEFAULT_IMAGE_PRICING
    let state = this.states.get(session)
    // Another route prices images differently: re-price the whole log.
    if (state === undefined || state.pricing !== pricing) {
      state = {
        consumed: 0,
        pricing,
        header: undefined,
        nodes: [],
        surfaceTokens: 0,
        anchor: undefined,
        offloaded: new Set(),
        calibration: 1,
        samples: 0,
      }
      this.states.set(session, state)
    }
    const events = session.events
    while (state.consumed < events.length) {
      this.fold(state, events[state.consumed]!, events)
      state.consumed += 1
    }
    return state
  }

  private nodeTokens(state: FoldState, event: SessionEvent): number {
    const message = deriveEventMessage(event)
    if (message === null) return 0
    return estimateMessage(
      state.offloaded.has(event.seq) ? offloadMessageImages(message) : message,
      state.pricing,
    )
  }

  private fold(
    state: FoldState,
    event: SessionEvent,
    events: readonly SessionEvent[],
  ): void {
    if (event.type === 'request/header') state.header = event.data.header
    if (event.type === 'image/offload') {
      const seq = event.data.seq
      state.offloaded.add(seq)
      const node = state.nodes.find((candidate) => candidate.seq === seq)
      const source = events[seq]
      if (node !== undefined && source !== undefined) {
        const tokens = this.nodeTokens(state, source)
        state.surfaceTokens += tokens - node.tokens
        node.tokens = tokens
      }
      return
    }
    if (!isSurfaceEvent(event)) return
    const tokens = this.nodeTokens(state, event)
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
      const ratio =
        usage === undefined || estimated <= 0
          ? undefined
          : usageTokens(usage) / estimated
      const believable =
        ratio !== undefined &&
        state.header !== undefined &&
        ratio >= CALIBRATION_MIN_RATIO &&
        ratio <= CALIBRATION_MAX_RATIO
      if (believable) {
        state.calibration =
          state.samples === 0
            ? ratio
            : CALIBRATION_ALPHA * ratio +
              (1 - CALIBRATION_ALPHA) * state.calibration
        state.samples += 1
      }
      state.anchor = {
        header: state.header,
        surfaceTokens: state.surfaceTokens,
        ...(believable && usage !== undefined ? { usage } : {}),
      }
    }
  }
}
