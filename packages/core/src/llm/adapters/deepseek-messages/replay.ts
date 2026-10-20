/**
 * Replay metadata of the DeepSeek Messages adapter (KRN-07). Harness
 * content stays the durable record of text, reasoning and tool calls; the
 * envelope only keeps what Messages needs to send a turn back exactly:
 * each thinking block's signature, aligned with the content blocks.
 *
 * A signature is replayed only to the model that produced it. Reasoning
 * without one (chat-completions history, or a signature lost to a
 * mismatched envelope) replays as an unsigned thinking block to the same
 * model; any other model's reasoning is dropped.
 */

import type { Message } from '../../message'
import type { ReplayEnvelope } from '../../types'

export const REPLAY_KIND = 'deepseek-messages'
export const REPLAY_VERSION = 1

/** Response-level half of the envelope. */
export interface MessagesReplayResponse {
  kind: typeof REPLAY_KIND
  version: typeof REPLAY_VERSION
  /** Wire model id the request named. */
  model: string
  /** The model the response reported, when it differs. */
  responseModel?: string
  responseId?: string
  stopReason?: string
}

/** Per-block half, one entry per emitted content block. */
export type MessagesReplayBlock =
  | { type: 'reasoning'; signature?: string }
  | { type: 'text' }
  | { type: 'tool-call' }

export function messagesEnvelope(
  response: MessagesReplayResponse,
  blocks: MessagesReplayBlock[],
): ReplayEnvelope {
  return { response, blocks }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The signature each content block may replay with, index-aligned with
 * `message.content`; undefined when the message carries no usable envelope.
 * Reads this adapter's envelope and the pi-ai one (an Anthropic-protocol
 * DeepSeek entry used pi-ai before KRN-07). An envelope whose blocks no
 * longer line up with the content is ignored rather than trusted.
 */
export function thinkingSignatures(
  message: Message,
): Array<string | undefined> | undefined {
  if (message.source.kind !== 'model') return undefined
  const envelope = record(message.source.replayState)
  const response = record(envelope?.['response'])
  const blocks = envelope?.['blocks']
  if (response === undefined || !Array.isArray(blocks)) return undefined
  const field =
    response['kind'] === REPLAY_KIND && response['version'] === REPLAY_VERSION
      ? 'signature'
      : response['kind'] === 'pi-ai' &&
          response['version'] === 2 &&
          response['api'] === 'anthropic-messages'
        ? 'thinkingSignature'
        : undefined
  if (field === undefined) return undefined
  if (blocks.length !== message.content.length) return undefined
  const signatures: Array<string | undefined> = []
  for (const [index, block] of message.content.entries()) {
    const replay = record(blocks[index])
    if (replay?.['type'] !== block.type) return undefined
    const signature = replay[field]
    signatures.push(
      block.type === 'reasoning' &&
        typeof signature === 'string' &&
        signature.length > 0
        ? signature
        : undefined,
    )
  }
  return signatures
}
