/**
 * Raw session-log history for the UI (ported from the dsh api-proxy
 * `paginate`): message-boundary pages over one session's events, plus the
 * wire sanitizer applied before events cross IPC.
 *
 * Pure module: no Node APIs, so the page/wire types stay browser-safe for
 * `import type` from the renderer.
 */

import { isAppendSurfaceEvent } from './surface'
import type { SessionEvent, SessionHeader } from './types'

/** Page size when history is requested without `maxMessages`. */
export const DEFAULT_HISTORY_MAX_MESSAGES = 50

/** Settled `tool/result` text above this many UTF-8 bytes is truncated on the wire. */
export const WIRE_TOOL_RESULT_MAX_BYTES = 256 * 1024
/** `tool/call.arguments` above this many UTF-8 bytes is truncated on the wire. */
export const WIRE_TOOL_ARGUMENTS_MAX_BYTES = 64 * 1024
/** Bytes of the original payload kept as the truncated head. */
export const WIRE_TOOL_RESULT_HEAD_BYTES = 32 * 1024
export const WIRE_TOOL_ARGUMENTS_HEAD_BYTES = 16 * 1024

/** Conversation message event types: the pagination counting unit. */
const MESSAGE_TYPES = new Set<string>(['user/message', 'assistant/message'])

/** One history page of raw session events. */
export interface SessionHistoryPage {
  header: SessionHeader
  /** Contiguous raw events (seq ascending), sanitized for the wire by CoreApi. */
  events: SessionEvent[]
  /** Whether older (visible) events exist before this page. */
  hasMore: boolean
  /** Seq of the log's last event when the page was cut; -1 for an empty log. */
  lastSeq: number
}

export interface HistoryPageOptions {
  /** Only events with `seq < beforeSeq`; omitted for the tail page. */
  beforeSeq?: number
  /** Messages per page (default {@link DEFAULT_HISTORY_MAX_MESSAGES}). */
  maxMessages?: number
}

/**
 * First visible seq of a session: a fork child hides its copied seed and the
 * `session/end-seed` marker that closes it.
 */
export function historyFloor(
  header: SessionHeader,
  events: readonly SessionEvent[],
): number {
  const seedLength = header.seedLength ?? 0
  if (seedLength <= 0) return 0
  return events[seedLength]?.type === 'session/end-seed'
    ? seedLength + 1
    : seedLength
}

/**
 * Message-boundary pagination: count `maxMessages` append-origin messages
 * backwards from the window tail. Replacement copies restate a shadowed
 * range for the model alone and consume no quota, so a compaction's summary
 * stays on the same page as its replacement. The cut is the starting seq of
 * the oldest counted message group (its `sourceEventSeqs` pull in the chunks
 * that built it — never cut mid-message). The tail page naturally includes
 * the in-flight partial chunks.
 */
export function paginate(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
  floor = 0,
): { events: SessionEvent[]; hasMore: boolean } {
  const window = events.filter(
    (event) =>
      event.seq >= floor && (beforeSeq === undefined || event.seq < beforeSeq),
  )
  const limit = Math.max(1, Math.floor(maxMessages))
  let count = 0
  let cut = floor
  for (let index = window.length - 1; index >= 0; index--) {
    const event = window[index] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    let groupStart = event.seq
    for (const source of event.sourceEventSeqs ?? []) {
      if (source < groupStart) groupStart = source
    }
    if (count >= limit) {
      cut = Math.max(floor, groupStart)
      break
    }
  }
  return {
    events: window.filter((event) => event.seq >= cut),
    hasMore: cut > floor,
  }
}

/** One page of a session's visible history. */
export function historyPage(
  header: SessionHeader,
  events: readonly SessionEvent[],
  options: HistoryPageOptions = {},
): SessionHistoryPage {
  const page = paginate(
    events,
    options.beforeSeq,
    options.maxMessages ?? DEFAULT_HISTORY_MAX_MESSAGES,
    historyFloor(header, events),
  )
  return {
    header,
    events: page.events,
    hasMore: page.hasMore,
    lastSeq: events.at(-1)?.seq ?? -1,
  }
}

// ── wire sanitizer ────────────────────────────────────────────────────

/** Marker a sanitized event carries when one of its payloads was cut. */
export interface WireTruncation {
  truncated: true
  /** Which payload was cut: `tool/call.arguments` or the `tool/result` text. */
  field: 'arguments' | 'result'
  /** Original UTF-8 byte length of the cut payload. */
  bytes: number
  /** UTF-8 byte length of the head left in place of the original payload. */
  headBytes: number
}

/** A session event as sent to the renderer: possibly carrying a truncation marker. */
export type WireSessionEvent = SessionEvent & { wire?: WireTruncation }

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

function headOf(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= maxBytes) return text
  // Drop a trailing partial code point the byte cut may leave.
  return decoder.decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD$/, '')
}

function truncateToolCall(
  event: SessionEvent<'tool/call'>,
): WireSessionEvent | undefined {
  const args = event.data.arguments
  // Every UTF-16 unit is at most 3 UTF-8 bytes: skip encoding short payloads.
  if (args.length * 3 <= WIRE_TOOL_ARGUMENTS_MAX_BYTES) return undefined
  const bytes = encoder.encode(args).byteLength
  if (bytes <= WIRE_TOOL_ARGUMENTS_MAX_BYTES) return undefined
  const head = headOf(args, WIRE_TOOL_ARGUMENTS_HEAD_BYTES)
  return {
    ...event,
    data: { ...event.data, arguments: head },
    wire: {
      truncated: true,
      field: 'arguments',
      bytes,
      headBytes: encoder.encode(head).byteLength,
    },
  }
}

function truncateToolResult(
  event: SessionEvent<'tool/result'>,
): WireSessionEvent | undefined {
  const block = event.data.message.content[0]
  const texts = block.content.filter(
    (inner): inner is { type: 'text'; text: string } => inner.type === 'text',
  )
  const text = texts.map((inner) => inner.text).join('\n')
  if (text.length * 3 <= WIRE_TOOL_RESULT_MAX_BYTES) return undefined
  const bytes = encoder.encode(text).byteLength
  if (bytes <= WIRE_TOOL_RESULT_MAX_BYTES) return undefined
  const head = headOf(text, WIRE_TOOL_RESULT_HEAD_BYTES)
  const others = block.content.filter((inner) => inner.type !== 'text')
  const content = [{ type: 'text' as const, text: head }, ...others]
  return {
    ...event,
    data: {
      ...event.data,
      message: {
        ...event.data.message,
        content: [{ ...block, content }],
      },
    },
    wire: {
      truncated: true,
      field: 'result',
      bytes,
      headBytes: encoder.encode(head).byteLength,
    },
  } as WireSessionEvent
}

/**
 * Prepare one event for the renderer wire. Only settled large payloads are
 * cut (`tool/result` text over 256KB, `tool/call.arguments` over 64KB);
 * streamed `assistant/chunk` deltas are never touched. Images are already
 * durable attachment references in the log, so no inline bytes cross the
 * wire. Unchanged events are returned as-is (no copy).
 */
export function sanitizeForWire(event: SessionEvent): WireSessionEvent {
  if (event.type === 'tool/call')
    return truncateToolCall(event as SessionEvent<'tool/call'>) ?? event
  if (event.type === 'tool/result')
    return truncateToolResult(event as SessionEvent<'tool/result'>) ?? event
  return event
}
