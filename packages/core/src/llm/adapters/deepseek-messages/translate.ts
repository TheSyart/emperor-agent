/**
 * Translate Messages stream events into the harness `StreamChunk` protocol.
 * One harness block per wire content block: `thinking` → reasoning,
 * `text` → text, `tool_use` → tool-call; other block types are skipped.
 * Thinking and tool-use blocks open as soon as they start (a tool call
 * shows its name before its arguments stream); a text block opens with its
 * first non-empty text. Blocks end at `content_block_stop`; usage and the
 * finish (with the replay envelope carrying each thinking signature) come
 * at `message_stop`. A stream that ends before `message_stop` is a
 * transport failure.
 */

import { EMPTY_RESPONSE_CODE, LlmError } from '../../error'
import type {
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
} from '../../types'
import {
  messagesEnvelope,
  REPLAY_KIND,
  REPLAY_VERSION,
  type MessagesReplayBlock,
} from './replay'
import type { SseEvent } from './sse'
import type { WireEvent, WireUsage } from './types'

interface OpenBlock {
  kind: 'text' | 'reasoning' | 'tool-call' | 'skipped'
  /** Harness index once the block has opened. */
  index?: number
  text: string
  id?: string
  name?: string
  signature?: string
  closed: boolean
}

/** Map a Messages `stop_reason` onto the harness finish vocabulary. */
export function mapStopReason(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return { kind: 'stop' }
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: {
          message: `model stopped: ${reason}`,
          code: reason.toUpperCase(),
        },
      }
  }
}

function count(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

/**
 * Map Messages usage. `input_tokens` already excludes cache reads and
 * writes (the harness keeps disjoint counts); cache reads are reported
 * whenever the wire carries the field, cache writes only when non-zero.
 */
export function mapMessagesUsage(usage: WireUsage): TokenUsage {
  const cacheRead = count(usage.cache_read_input_tokens)
  const cacheWrite = count(usage.cache_creation_input_tokens)
  return {
    inputTokens: count(usage.input_tokens) ?? 0,
    outputTokens: count(usage.output_tokens) ?? 0,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined || cacheWrite === 0
      ? {}
      : { cacheWriteTokens: cacheWrite }),
  }
}

/** The harness failure code of an error event in the stream. */
export function streamErrorCode(type: string | undefined): string {
  switch (type) {
    case 'rate_limit_error':
      return 'RATE_LIMIT'
    case 'authentication_error':
    case 'permission_error':
      return 'AUTH'
    case 'invalid_request_error':
    case 'not_found_error':
    case 'request_too_large':
      return 'INVALID_REQUEST'
    default:
      // overloaded_error, api_error and anything new: the server's side.
      return 'SERVER'
  }
}

function mergeUsage(into: WireUsage, from: WireUsage | undefined): void {
  if (from === undefined) return
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ] as const) {
    const value = from[key]
    if (typeof value === 'number') into[key] = value
  }
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: block.id ?? '',
        name: block.name ?? '',
        arguments: block.text,
      }
    default:
      return { type: 'text', text: block.text }
  }
}

function replayBlock(block: OpenBlock): MessagesReplayBlock {
  if (block.kind === 'reasoning')
    return block.signature === undefined || block.signature === ''
      ? { type: 'reasoning' }
      : { type: 'reasoning', signature: block.signature }
  return block.kind === 'tool-call' ? { type: 'tool-call' } : { type: 'text' }
}

export async function* translateEvents(
  events: AsyncIterable<SseEvent>,
  context: { model: string },
): AsyncGenerator<StreamChunk> {
  const wire = new Map<number, OpenBlock>()
  const opened: OpenBlock[] = []
  const usage: WireUsage = {}
  let sawUsage = false
  let stopReason: string | undefined
  let responseId: string | undefined
  let responseModel: string | undefined

  function* open(block: OpenBlock): Generator<StreamChunk> {
    if (block.index !== undefined || block.kind === 'skipped') return
    block.index = opened.length
    opened.push(block)
    yield {
      type: 'block-start',
      index: block.index,
      blockType: block.kind,
    }
    if (block.kind === 'tool-call')
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: block.id ?? '',
        ...(block.name === undefined ? {} : { name: block.name }),
        argumentsDelta: '',
      }
  }

  function* appendText(block: OpenBlock, text: string): Generator<StreamChunk> {
    if (text.length === 0) return
    yield* open(block)
    block.text += text
    yield { type: 'text-delta', index: block.index!, text }
  }

  for await (const { data } of events) {
    let event: WireEvent
    try {
      event = JSON.parse(data) as WireEvent
    } catch {
      throw new LlmError(
        `malformed SSE payload: ${data.slice(0, 120)}`,
        'MALFORMED_RESPONSE',
      )
    }
    switch (event.type) {
      case 'message_start':
        responseId = event.message?.id
        responseModel = event.message?.model
        if (event.message?.usage !== undefined) {
          mergeUsage(usage, event.message.usage)
          sawUsage = true
        }
        break
      case 'content_block_start': {
        const start = event.content_block
        const block: OpenBlock = {
          kind:
            start.type === 'text'
              ? 'text'
              : start.type === 'thinking'
                ? 'reasoning'
                : start.type === 'tool_use'
                  ? 'tool-call'
                  : 'skipped',
          text: '',
          closed: false,
        }
        wire.set(event.index, block)
        if (block.kind === 'tool-call') {
          const id = (start as { id?: unknown }).id
          const name = (start as { name?: unknown }).name
          if (typeof id === 'string' && id.length > 0) block.id = id
          if (typeof name === 'string' && name.length > 0) block.name = name
          yield* open(block)
        } else if (block.kind === 'reasoning') {
          yield* open(block)
          const thinking = (start as { thinking?: unknown }).thinking
          const signature = (start as { signature?: unknown }).signature
          if (typeof signature === 'string' && signature.length > 0)
            block.signature = signature
          if (typeof thinking === 'string' && thinking.length > 0) {
            block.text += thinking
            yield {
              type: 'reasoning-delta',
              index: block.index!,
              text: thinking,
            }
          }
        } else if (block.kind === 'text') {
          const text = (start as { text?: unknown }).text
          if (typeof text === 'string') yield* appendText(block, text)
        }
        break
      }
      case 'content_block_delta': {
        const block = wire.get(event.index)
        if (block === undefined || block.closed) break
        const delta = event.delta as Record<string, unknown>
        if (delta['type'] === 'text_delta' && block.kind === 'text') {
          const text = delta['text']
          if (typeof text === 'string') yield* appendText(block, text)
        } else if (
          delta['type'] === 'thinking_delta' &&
          block.kind === 'reasoning'
        ) {
          const thinking = delta['thinking']
          if (typeof thinking === 'string' && thinking.length > 0) {
            block.text += thinking
            yield {
              type: 'reasoning-delta',
              index: block.index!,
              text: thinking,
            }
          }
        } else if (
          delta['type'] === 'signature_delta' &&
          block.kind === 'reasoning'
        ) {
          const signature = delta['signature']
          if (typeof signature === 'string')
            block.signature = (block.signature ?? '') + signature
        } else if (
          delta['type'] === 'input_json_delta' &&
          block.kind === 'tool-call'
        ) {
          const fragment = delta['partial_json']
          if (typeof fragment === 'string' && fragment.length > 0) {
            block.text += fragment
            yield {
              type: 'tool-call-delta',
              index: block.index!,
              id: block.id ?? '',
              ...(block.name === undefined ? {} : { name: block.name }),
              argumentsDelta: fragment,
            }
          }
        }
        break
      }
      case 'content_block_stop': {
        const block = wire.get(event.index)
        if (block === undefined || block.closed) break
        block.closed = true
        if (block.index !== undefined)
          yield {
            type: 'block-end',
            index: block.index,
            block: closeBlock(block),
          }
        break
      }
      case 'message_delta':
        if (typeof event.delta?.stop_reason === 'string')
          stopReason = event.delta.stop_reason
        if (event.usage !== undefined) {
          mergeUsage(usage, event.usage)
          sawUsage = true
        }
        break
      case 'message_stop': {
        for (const block of opened) {
          if (block.closed) continue
          block.closed = true
          yield {
            type: 'block-end',
            index: block.index!,
            block: closeBlock(block),
          }
        }
        if (sawUsage) yield { type: 'usage', usage: mapMessagesUsage(usage) }
        const reason = mapStopReason(stopReason ?? 'end_turn')
        if (reason.kind === 'stop' && opened.length === 0) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: 'model returned a completed response with no content',
                code: EMPTY_RESPONSE_CODE,
              },
            },
          }
          return
        }
        if (reason.kind === 'error') {
          yield { type: 'finish', reason }
          return
        }
        yield {
          type: 'finish',
          reason,
          replayState: messagesEnvelope(
            {
              kind: REPLAY_KIND,
              version: REPLAY_VERSION,
              model: context.model,
              ...(responseModel !== undefined && responseModel !== context.model
                ? { responseModel }
                : {}),
              ...(responseId === undefined ? {} : { responseId }),
              ...(stopReason === undefined ? {} : { stopReason }),
            },
            opened.map(replayBlock),
          ),
        }
        return
      }
      case 'error':
        throw new LlmError(
          event.error?.message || 'DeepSeek stream reported an error',
          streamErrorCode(event.error?.type),
        )
      default:
        // ping and future event types carry nothing to translate.
        break
    }
  }
  throw new LlmError(
    'DeepSeek Messages stream ended before message_stop',
    'TRANSPORT',
  )
}
