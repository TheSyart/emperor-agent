import type { DiscoveryHttp } from './http'
import {
  DiscoveryError,
  type ConnectionFix,
  type DiscoveryConnection,
  type ParserId,
  type VendorModel,
} from './types'

export interface ParserContext {
  connection: DiscoveryConnection
  http: DiscoveryHttp
  /** Stop paging once more raw entries than this are in (the list is cut). */
  stopAfter: number
}

export interface ParserListing {
  /** `catalog`: no list endpoint here; the caller fills in recommendations. */
  source: 'vendor_api' | 'catalog'
  models: VendorModel[]
  truncated: boolean
  fix?: ConnectionFix
  message?: string
}

export interface ProbeOutcome {
  method: 'list' | 'auth_check'
  modelCount?: number
}

/** One vendor's way of listing models and checking a key. */
export interface ModelListParser {
  readonly id: ParserId
  /** Every page, or a `DiscoveryError`. */
  list(context: ParserContext): Promise<ParserListing>
  /** One cheap authenticated request. */
  probe(context: ParserContext): Promise<ProbeOutcome>
}

export function trimBase(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

export function originOf(base: string): string {
  return new URL(trimBase(base)).origin
}

export function pathOf(base: string): string {
  return new URL(trimBase(base)).pathname.replace(/\/+$/, '')
}

/** Whether the base already ends in a version segment (`/v1`, `/v1beta`, `/v4`). */
export function hasVersionSuffix(base: string): boolean {
  return /\/v\d+[a-z0-9]*$/i.test(pathOf(base))
}

export function catalogListing(message: string): ParserListing {
  return { source: 'catalog', models: [], truncated: false, message }
}

/** Bearer auth (when there is a key) under the connection's extra headers. */
export function bearerHeaders(
  connection: DiscoveryConnection,
): Record<string, string> {
  return withExtraHeaders(
    connection,
    connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {},
  )
}

export function withExtraHeaders(
  connection: DiscoveryConnection,
  headers: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...headers }
  for (const [key, value] of Object.entries(connection.extraHeaders ?? {}))
    merged[key.toLowerCase()] = value
  return merged
}

export function anthropicHeaders(
  connection: DiscoveryConnection,
): Record<string, string> {
  return withExtraHeaders(connection, {
    ...(connection.apiKey ? { 'x-api-key': connection.apiKey } : {}),
    'anthropic-version': '2023-06-01',
  })
}

/**
 * The request an auth check sends: the chat endpoint with no model and no
 * messages. No model can run it, so nothing is billed; a server that
 * rejects the key answers 401/403, one that accepts it complains about the
 * body.
 */
export function authCheckRequest(connection: DiscoveryConnection): {
  url: string
  headers: Record<string, string>
  body: unknown
} {
  const base = trimBase(connection.apiBase)
  if (connection.protocol === 'anthropic')
    return {
      url: hasVersionSuffix(base) ? `${base}/messages` : `${base}/v1/messages`,
      headers: anthropicHeaders(connection),
      body: { model: '', max_tokens: 1, messages: [] },
    }
  return {
    url: `${base}/chat/completions`,
    headers: bearerHeaders(connection),
    body: { model: '', messages: [], max_tokens: 1 },
  }
}

export async function authCheck(context: ParserContext): Promise<ProbeOutcome> {
  const request = authCheckRequest(context.connection)
  const exchange = await context.http.send(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
  })
  const { status } = exchange
  if (status >= 200 && status < 300 && !exchange.html)
    return { method: 'auth_check' }
  if (exchange.html) throw context.http.failure(exchange)
  if ((status === 400 || status === 422) && exchange.json !== undefined) {
    const error = context.http.failure(exchange)
    if (error.code === 'AUTH') throw error
    return { method: 'auth_check' }
  }
  // Ark answers an unknown model with 404 InvalidEndpointOrModel: the key
  // was accepted. A bare 404 is the wrong address.
  if (
    status === 404 &&
    exchange.json !== undefined &&
    /model|endpoint/i.test(exchange.text)
  )
    return { method: 'auth_check' }
  throw context.http.failure(exchange)
}

export function notCompatible(what: string): DiscoveryError {
  return new DiscoveryError(
    'NOT_COMPATIBLE',
    `${what} 的响应里没有模型列表（data / models 数组），这个地址可能不是兼容接口`,
  )
}
