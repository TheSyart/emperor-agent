/**
 * Decode a Messages SSE byte stream into named events. Framing is
 * `eventsource-parser`'s. Unlike chat-completions there is no `[DONE]`
 * sentinel: the stream is complete at `message_stop`, which the translator
 * checks. Comments (DeepSeek's `: keep-alive`, documented on
 * https://api-docs.deepseek.com/quick_start/rate_limit) only reach the
 * activity callback.
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'

export interface SseEvent {
  /** The `event:` name; `message` when the server sent none. */
  event: string
  data: string
}

export async function* parseEvents(
  stream: ReadableStream<Uint8Array>,
  onComment?: (comment: string) => void,
): AsyncGenerator<SseEvent> {
  const events = stream
    .pipeThrough(
      new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
    )
    .pipeThrough(
      new EventSourceParserStream({
        ...(onComment === undefined ? {} : { onComment }),
      }),
    )
  for await (const { event, data } of events as unknown as AsyncIterable<{
    event?: string
    data: string
  }>) {
    yield { event: event ?? 'message', data }
  }
}
