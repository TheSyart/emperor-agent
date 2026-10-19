/**
 * Test doubles for model discovery: replay a recorded vendor exchange
 * (`fixtures/model-lists/<vendor>.json`) or script responses by hand. No
 * test reaches the network; an unexpected request fails like a refused
 * connection, so the assertion that follows names it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DiscoveryFetch } from './http'

export interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
}

export interface FixtureExchange {
  request: { method: string; url: string; body?: unknown }
  response: {
    status: number
    headers?: Record<string, string>
    body?: unknown
    text?: string
  }
}

export interface ModelListFixture {
  vendor: string
  source: string
  exchanges: FixtureExchange[]
}

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'model-lists',
)

export function loadFixture(vendor: string): ModelListFixture {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, `${vendor}.json`), 'utf8'),
  ) as ModelListFixture
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function record(input: string, init: RequestInit): RecordedRequest {
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value
  })
  const request: RecordedRequest = {
    method: (init.method ?? 'GET').toUpperCase(),
    url: input,
    headers,
  }
  if (typeof init.body === 'string') request.body = JSON.parse(init.body)
  return request
}

/** Answers each request from a handler and keeps every request it saw. */
export function scriptedFetch(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
): { fetch: DiscoveryFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetch: DiscoveryFetch = async (input, init) => {
    const request = record(input, init)
    requests.push(request)
    return handler(request)
  }
  return { fetch, requests }
}

/** Replays recorded exchanges, matched by method, URL and JSON body. */
export function replayFetch(
  ...fixtures: ReadonlyArray<ModelListFixture | FixtureExchange[]>
): { fetch: DiscoveryFetch; requests: RecordedRequest[] } {
  const exchanges = fixtures.flatMap((item) =>
    Array.isArray(item) ? item : item.exchanges,
  )
  return scriptedFetch((request) => {
    const match = exchanges.find(
      (exchange) =>
        exchange.request.method === request.method &&
        exchange.request.url === request.url &&
        (exchange.request.body === undefined ||
          JSON.stringify(exchange.request.body) ===
            JSON.stringify(request.body)),
    )
    if (!match)
      throw new TypeError(
        `fetch failed: no recorded exchange for ${request.method} ${request.url}`,
      )
    const { status, headers, body, text } = match.response
    return new Response(text ?? JSON.stringify(body ?? null), {
      status,
      headers: {
        'content-type': text ? 'text/plain' : 'application/json',
        ...headers,
      },
    })
  })
}
