/**
 * Outbound HTTP for model discovery.
 *
 * Discovery talks to the same hosts, with the same key, as model calls, so
 * it uses the transport model calls use: the process `fetch` (resolved at
 * call time, so a host or a test that replaces it is followed), with the
 * same reach — local servers and private gateways included, which the
 * public web-fetch client deliberately refuses — and the same proxy
 * behaviour. On top of it every request gets:
 *
 * - a 30-second timeout covering the body as well as the headers;
 * - a response cap (16 MiB) read incrementally;
 * - redirects followed by hand, and only on the same origin (or the same
 *   host upgraded to https): a credential header never travels to another
 *   host, whatever the server says;
 * - one backoff on 429 as `Retry-After` says (≤ 10 s; longer waits are
 *   reported, not slept);
 * - vendor error text scrubbed of the connection's secrets.
 */
import { DiscoveryError } from './types'
import { scrubSecrets } from './secrets'

export type DiscoveryFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>

export interface DiscoveryHttpOptions {
  fetch?: DiscoveryFetch
  timeoutMs?: number
  maxBytes?: number
  maxRetryAfterMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Values scrubbed from every message (key, extra header values). */
  secrets?: readonly string[]
}

export interface HttpRequest {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Sent as JSON. */
  body?: unknown
}

export interface HttpExchange {
  /** The URL that answered (after same-origin redirects). */
  url: string
  method: 'GET' | 'POST'
  status: number
  headers: Headers
  text: string
  /** Parsed body when it is JSON, else `undefined`. */
  json: unknown
  html: boolean
}

export const DISCOVERY_TIMEOUT_MS = 30_000
const MAX_BYTES = 16 * 1024 * 1024
const MAX_RETRY_AFTER_MS = 10_000
const DEFAULT_RETRY_AFTER_MS = 1_000
const MAX_REDIRECTS = 3

const defaultFetch: DiscoveryFetch = (input, init) =>
  globalThis.fetch(input, init)

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export class DiscoveryHttp {
  private readonly fetchImpl: DiscoveryFetch
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly maxRetryAfterMs: number
  private readonly sleep: (ms: number) => Promise<void>
  readonly secrets: readonly string[]

  constructor(options: DiscoveryHttpOptions = {}) {
    this.fetchImpl = options.fetch ?? defaultFetch
    this.timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS
    this.maxBytes = options.maxBytes ?? MAX_BYTES
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS
    this.sleep = options.sleep ?? defaultSleep
    this.secrets = options.secrets ?? []
  }

  /**
   * One logical request. HTTP statuses come back as an exchange; transport
   * failures (refused, DNS, TLS, timeout) throw `NETWORK`.
   */
  async send(url: string, request: HttpRequest = {}): Promise<HttpExchange> {
    const first = await this.follow(url, request)
    if (first.status !== 429) return first
    const waitMs = retryAfterMs(first.headers.get('retry-after'))
    if (waitMs > this.maxRetryAfterMs) return first
    await this.sleep(waitMs)
    return this.follow(url, request)
  }

  /** `send`, then a 2xx JSON body or a classified `DiscoveryError`. */
  async json(url: string, request: HttpRequest = {}): Promise<unknown> {
    const exchange = await this.send(url, request)
    if (exchange.status >= 200 && exchange.status < 300) {
      if (exchange.html)
        throw new DiscoveryError(
          'WRONG_BASE',
          `${describe(exchange)} 返回的是网页而不是接口数据，API 地址可能不对`,
          { status: exchange.status },
        )
      if (exchange.json === undefined)
        throw new DiscoveryError(
          'NOT_COMPATIBLE',
          `${describe(exchange)} 返回的不是 JSON`,
          { status: exchange.status },
        )
      return exchange.json
    }
    throw this.failure(exchange)
  }

  /** A non-2xx exchange as a coded error with a scrubbed vendor message. */
  failure(exchange: HttpExchange): DiscoveryError {
    const status = exchange.status
    const vendor = vendorMessage(exchange, this.secrets)
    const suffix = vendor ? `：${vendor}` : ''
    const where = describe(exchange)
    if (status === 401 || status === 403)
      return new DiscoveryError('AUTH', `认证失败（HTTP ${status}）${suffix}`, {
        status,
      })
    if (status === 400 && looksLikeAuthMessage(vendor))
      return new DiscoveryError('AUTH', `认证失败（HTTP 400）${suffix}`, {
        status,
      })
    if (status === 404 || status === 405 || status === 410 || exchange.html)
      return new DiscoveryError(
        'WRONG_BASE',
        `${where} 返回 HTTP ${status}，API 地址可能不对${suffix}`,
        { status },
      )
    if (status === 429) {
      const retry = retryAfterMs(exchange.headers.get('retry-after'))
      return new DiscoveryError('RATE_LIMITED', `被限流（HTTP 429）${suffix}`, {
        status,
        retryAfterMs: retry,
      })
    }
    if (status === 408 || status === 502 || status === 503 || status === 504)
      return new DiscoveryError(
        'NETWORK',
        `${new URL(exchange.url).host} 暂时不可用（HTTP ${status}）${suffix}`,
        { status },
      )
    return new DiscoveryError(
      'UNKNOWN',
      `${where} 返回 HTTP ${status}${suffix}`,
      { status },
    )
  }

  private async follow(
    url: string,
    request: HttpRequest,
  ): Promise<HttpExchange> {
    let current = url
    let method: 'GET' | 'POST' = request.method ?? 'GET'
    let body = request.body
    for (let hop = 0; ; hop += 1) {
      const exchange = await this.once(current, method, request.headers, body)
      const location = exchange.headers.get('location')
      if (![301, 302, 303, 307, 308].includes(exchange.status) || !location)
        return exchange
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return exchange
      }
      if (!sameOrigin(new URL(current), next))
        throw new DiscoveryError(
          'WRONG_BASE',
          `${new URL(current).host} 把请求重定向到 ${next.host}；Emperor 不会把凭据发往其他主机，请确认 API 地址`,
          { status: exchange.status },
        )
      if (hop >= MAX_REDIRECTS)
        throw new DiscoveryError(
          'WRONG_BASE',
          `${new URL(current).host} 重定向次数过多`,
          { status: exchange.status },
        )
      if (exchange.status === 303) {
        method = 'GET'
        body = undefined
      }
      current = next.toString()
    }
  }

  private async once(
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string> | undefined,
    body: unknown,
  ): Promise<HttpExchange> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    const host = safeHost(url)
    try {
      const init: RequestInit = {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        redirect: 'manual',
        signal: controller.signal,
      }
      if (body !== undefined) init.body = JSON.stringify(body)
      const response = await this.fetchImpl(url, init)
      const text = await readCapped(response, this.maxBytes)
      const contentType = response.headers.get('content-type') ?? ''
      const html =
        /text\/html/i.test(contentType) ||
        /^\s*<(?:!doctype|html|head|body)\b/i.test(text)
      return {
        url,
        method,
        status: response.status,
        headers: response.headers,
        text,
        json: html ? undefined : parseJson(text),
        html,
      }
    } catch (error) {
      if (error instanceof DiscoveryError) throw error
      if (timedOut)
        throw new DiscoveryError(
          'NETWORK',
          `连接 ${host} 超时（${Math.round(this.timeoutMs / 1000)} 秒）`,
        )
      throw new DiscoveryError(
        'NETWORK',
        `连不上 ${host}${transportDetail(error, this.secrets)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge(maxBytes)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge(maxBytes)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function tooLarge(maxBytes: number): DiscoveryError {
  return new DiscoveryError(
    'NOT_COMPATIBLE',
    `响应超过 ${Math.round(maxBytes / 1024 / 1024)} MiB，不像模型列表`,
  )
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

function sameOrigin(from: URL, to: URL): boolean {
  if (from.origin === to.origin) return true
  // http → https on the same host and default ports is an upgrade, not a move.
  return (
    from.protocol === 'http:' &&
    to.protocol === 'https:' &&
    from.hostname === to.hostname &&
    from.port === '' &&
    to.port === ''
  )
}

/** Milliseconds from a `Retry-After` value (seconds or an HTTP date). */
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000)
  const date = Date.parse(trimmed)
  return Number.isFinite(date)
    ? Math.max(0, date - now)
    : DEFAULT_RETRY_AFTER_MS
}

function describe(exchange: HttpExchange): string {
  const url = new URL(exchange.url)
  return `${exchange.method} ${url.host}${url.pathname}`
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '目标地址'
  }
}

function transportDetail(error: unknown, secrets: readonly string[]): string {
  const codes: string[] = []
  let cursor: unknown = error
  for (let depth = 0; cursor && depth < 4; depth += 1) {
    const code = (cursor as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z_]+$/.test(code)) codes.push(code)
    cursor = (cursor as { cause?: unknown }).cause
  }
  if (codes.length) return `（${codes[0]}）`
  const message = error instanceof Error ? error.message : String(error)
  return message ? `（${scrubSecrets(message, secrets).slice(0, 160)}）` : ''
}

/** The vendor's own error text, scrubbed and bounded. */
function vendorMessage(
  exchange: HttpExchange,
  secrets: readonly string[],
): string {
  const body = exchange.json
  let message = ''
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    const error = record.error
    if (typeof error === 'string') message = error
    else if (error && typeof error === 'object') {
      const inner = error as Record<string, unknown>
      message =
        stringOf(inner.message) || stringOf(inner.code) || stringOf(inner.type)
    }
    message ||=
      stringOf(record.message) ||
      stringOf(record.detail) ||
      stringOf(record.msg)
  } else if (!exchange.html) {
    message = exchange.text.trim()
  }
  return scrubSecrets(message.replace(/\s+/g, ' '), secrets).slice(0, 300)
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function looksLikeAuthMessage(message: string): boolean {
  return /api[ _-]?key|unauthori[sz]ed|authenticat|invalid[ _-]?(?:token|credential)|permission/i.test(
    message,
  )
}
