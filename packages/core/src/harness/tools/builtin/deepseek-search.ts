/**
 * `web_search` backend for DeepSeek's official API (KRN-08, DSH-15): the
 * Search API at `https://api.deepseek.com/v1/tools/search`, one direct
 * request per query with the conversation's own API key, no auxiliary
 * model request. Results keep the service's order; `snippet` and the
 * nullable `date` map onto the shared hit shape. The request goes through
 * the same `fetch` as the model requests, so proxies behave alike.
 *
 * Only a route whose base URL is `https://api.deepseek.com` (any path)
 * and that carries a key counts as DeepSeek's official API: gateways and
 * compatible hosts may not serve `/v1/tools`, and the key must not be sent
 * anywhere else.
 */

import type { RouteSpec } from '../../../llm/route'
import { ToolError } from '../definition'
import {
  WEB_SEARCH_MAX_RESULTS,
  type WebSearchBackend,
  type WebSearchHit,
} from './web-search'

export const DEEPSEEK_OFFICIAL_HOST = 'api.deepseek.com'
export const DEEPSEEK_SEARCH_ENDPOINT = `https://${DEEPSEEK_OFFICIAL_HOST}/v1/tools/search`

/** Whether a model route talks to DeepSeek's official API with a key. */
export function isDeepSeekOfficialRoute(
  route: Pick<RouteSpec, 'baseURL' | 'apiKey'>,
): boolean {
  if (typeof route.apiKey !== 'string' || route.apiKey.trim() === '')
    return false
  try {
    const url = new URL(route.baseURL)
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === DEEPSEEK_OFFICIAL_HOST &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

export interface DeepSeekSearchOptions {
  apiKey: string
  /** Results asked for per query (1–50; the tool shows at most 8). */
  count?: number
  /** Test hook: the transport (defaults to the process `fetch`). */
  fetch?: typeof fetch
  endpoint?: string
}

export function createDeepSeekSearchBackend(
  options: DeepSeekSearchOptions,
): WebSearchBackend {
  const send = options.fetch ?? fetch
  const endpoint = options.endpoint ?? DEEPSEEK_SEARCH_ENDPOINT
  const count = options.count ?? WEB_SEARCH_MAX_RESULTS
  return {
    async search(query, signal) {
      const response = await send(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ query, count, need_content: false }),
        signal,
      })
      if (!response.ok) throw await providerError(response)
      let payload: unknown
      try {
        payload = await response.json()
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason ?? error
        throw invalidResponse()
      }
      return hits(payload)
    },
  }
}

function hits(payload: unknown): WebSearchHit[] {
  if (!isRecord(payload) || !Array.isArray(payload.results))
    throw invalidResponse()
  return payload.results.map((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item.url !== 'string' ||
      item.url.length === 0 ||
      typeof item.title !== 'string' ||
      typeof item.snippet !== 'string' ||
      (item.date !== undefined &&
        item.date !== null &&
        typeof item.date !== 'string')
    )
      throw invalidResponse()
    return {
      url: item.url,
      title: item.title,
      snippet: item.snippet,
      ...(typeof item.date === 'string' && item.date.length > 0
        ? { publishedAt: item.date }
        : {}),
    }
  })
}

async function providerError(response: Response): Promise<ToolError> {
  let detail = ''
  try {
    const parsed: unknown = JSON.parse(await response.text())
    if (isRecord(parsed)) {
      const error = parsed.error
      const message = isRecord(error)
        ? error.message
        : typeof error === 'string'
          ? error
          : parsed.message
      if (typeof message === 'string') detail = message.slice(0, 300)
    }
  } catch {
    // Gateways answer 5xx and 429 with HTML or nothing: the status says enough.
  }
  const hint =
    response.status === 401 || response.status === 403
      ? ' Check the DeepSeek API key in Settings › 模型.'
      : response.status === 402
        ? ' The DeepSeek account has insufficient balance.'
        : response.status === 429
          ? ' DeepSeek is rate limiting searches; wait before searching again.'
          : ''
  return new ToolError(
    `DeepSeek search failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}.${hint}`,
    'WEB_SEARCH_PROVIDER_ERROR',
  )
}

function invalidResponse(): ToolError {
  return new ToolError(
    'DeepSeek search returned an invalid response.',
    'WEB_SEARCH_PROVIDER_ERROR',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
