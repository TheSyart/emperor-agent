/**
 * Decode an SSE byte stream into event `data` payloads (ported from
 * dsh-llm-deepseek sse.ts). Framing is `eventsource-parser`'s; the literal
 * `[DONE]` is yielded so the caller owns final flushing, and EOF before it
 * raises STREAM_CLOSED. Comments only reach the transport-activity callback.
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '../../error'

/** The terminal payload OpenAI-compatible endpoints send after the last chunk. */
export const DONE = '[DONE]'

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(
      new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
    )
    .pipeThrough(
      new EventSourceParserStream({
        ...(onComment === undefined ? {} : { onComment }),
      }),
    )
  for await (const { data } of events as unknown as AsyncIterable<{
    data: string
  }>) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
