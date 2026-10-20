/**
 * Test doubles for the DeepSeek Messages adapter: replay a hand-written
 * exchange file (`llm/fixtures/deepseek-messages/<name>.jsonl`) as a
 * `fetch`. Each line is one record: a `request` (method + URL the next call
 * must match), its `response` (status, headers, a JSON or text body), and
 * for a stream the `sse` events and `comment` lines that follow. No test
 * reaches the network; a request the file does not expect fails like a
 * refused connection, so the assertion after it names the call.
 *
 * The fixtures are written from the documented protocol (DeepSeek
 * Anthropic API and Files API guides, Anthropic Messages streaming), not
 * recorded from the live API.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type FixtureLine =
  | { kind: 'note'; text: string }
  | { kind: 'request'; method: string; url: string }
  | {
      kind: 'response'
      status: number
      headers?: Record<string, string>
      json?: unknown
      text?: string
    }
  | { kind: 'sse'; event: string; data: unknown }
  | { kind: 'comment'; text: string }

export type SseRecord = { event: string; data: unknown } | { comment: string }

export interface FixtureExchange {
  request: { method: string; url: string }
  response: {
    status: number
    headers: Record<string, string>
    json?: unknown
    text?: string
    sse?: SseRecord[]
  }
}

/** One request the fake transport received. */
export interface RecordedCall {
  method: string
  url: string
  headers: Record<string, string>
  /** A JSON request body, parsed. */
  body?: unknown
  /** A multipart request body: text fields, and files by name, type and size. */
  form?: Record<
    string,
    string | { filename: string; type: string; size: number }
  >
}

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'deepseek-messages',
)

/** Parse one exchange file into request/response pairs. */
export function loadExchanges(name: string): FixtureExchange[] {
  const lines = readFileSync(join(FIXTURE_DIR, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureLine)
  const exchanges: FixtureExchange[] = []
  let current: FixtureExchange | undefined
  for (const line of lines) {
    switch (line.kind) {
      case 'note':
        break
      case 'request':
        current = {
          request: { method: line.method, url: line.url },
          response: { status: 0, headers: {} },
        }
        exchanges.push(current)
        break
      case 'response':
        if (current === undefined)
          throw new Error(`${name}: response before any request`)
        current.response = {
          status: line.status,
          headers: { ...(line.headers ?? {}) },
          ...(line.json === undefined ? {} : { json: line.json }),
          ...(line.text === undefined ? {} : { text: line.text }),
        }
        break
      case 'sse':
        if (current === undefined)
          throw new Error(`${name}: sse before any request`)
        ;(current.response.sse ??= []).push({
          event: line.event,
          data: line.data,
        })
        break
      case 'comment':
        if (current === undefined)
          throw new Error(`${name}: comment before any request`)
        ;(current.response.sse ??= []).push({ comment: line.text })
        break
    }
  }
  return exchanges
}

/** Encode SSE records as the wire text a server would send. */
export function sseText(records: readonly SseRecord[]): string {
  return records
    .map((record) =>
      'comment' in record
        ? `: ${record.comment}\n\n`
        : `event: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`,
    )
    .join('')
}

/** A byte stream that delivers `text` in small, unaligned pieces. */
function chunkedStream(
  text: string,
  chunkSize: number,
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize))
      offset += chunkSize
    },
  })
}

/** Build the Response one exchange describes. */
export function fixtureResponse(
  response: FixtureExchange['response'],
  chunkSize = 23,
): Response {
  if (response.sse !== undefined) {
    return new Response(chunkedStream(sseText(response.sse), chunkSize), {
      status: response.status,
      headers: { 'content-type': 'text/event-stream', ...response.headers },
    })
  }
  if (response.json !== undefined) {
    return new Response(JSON.stringify(response.json), {
      status: response.status,
      headers: { 'content-type': 'application/json', ...response.headers },
    })
  }
  return new Response(response.text ?? '', {
    status: response.status,
    headers: response.headers,
  })
}

async function recordCall(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<RecordedCall> {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  const headers: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value
  })
  const call: RecordedCall = {
    method: (init?.method ?? 'GET').toUpperCase(),
    url,
    headers,
  }
  const body = init?.body
  if (typeof body === 'string') call.body = JSON.parse(body)
  else if (body instanceof FormData) {
    const form: NonNullable<RecordedCall['form']> = {}
    for (const [key, value] of body.entries()) {
      form[key] =
        typeof value === 'string'
          ? value
          : { filename: value.name, type: value.type, size: value.size }
    }
    call.form = form
  }
  return call
}

/**
 * A `fetch` that answers each call from the next exchange, in order. A call
 * whose method or URL differs from the next exchange (or a call after the
 * last one) rejects like a failed connection.
 */
export function replayTransport(
  exchanges: readonly FixtureExchange[],
  options: { chunkSize?: number } = {},
): { fetch: typeof fetch; calls: RecordedCall[]; pending: () => number } {
  const queue = [...exchanges]
  const calls: RecordedCall[] = []
  const fake = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const call = await recordCall(input, init)
    calls.push(call)
    if (init?.signal?.aborted)
      throw init.signal.reason ?? new DOMException('aborted', 'AbortError')
    const next = queue.shift()
    if (
      next === undefined ||
      next.request.method !== call.method ||
      next.request.url !== call.url
    ) {
      throw new TypeError(
        `fetch failed: unexpected ${call.method} ${call.url}` +
          (next === undefined
            ? ' (no exchange left)'
            : ` (expected ${next.request.method} ${next.request.url})`),
      )
    }
    return fixtureResponse(next.response, options.chunkSize)
  }
  return {
    fetch: fake as typeof fetch,
    calls,
    pending: () => queue.length,
  }
}

/** A 1×1 opaque PNG (67 bytes): small enough to pass through unchanged. */
export const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)
