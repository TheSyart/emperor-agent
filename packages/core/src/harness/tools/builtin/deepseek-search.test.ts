import { describe, expect, it } from 'vitest'
import {
  createDeepSeekSearchBackend,
  DEEPSEEK_SEARCH_ENDPOINT,
  isDeepSeekOfficialRoute,
} from './deepseek-search'

function reply(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('DeepSeek search', () => {
  it('recognizes only DeepSeek’s official API with a key', () => {
    const official = (baseURL: string, apiKey: string | null = 'sk') =>
      isDeepSeekOfficialRoute({ baseURL, apiKey })
    expect(official('https://api.deepseek.com')).toBe(true)
    expect(official('https://api.deepseek.com/v1')).toBe(true)
    expect(official('https://api.deepseek.com/anthropic')).toBe(true)
    expect(official('https://API.DeepSeek.com/')).toBe(true)
    expect(official('http://api.deepseek.com')).toBe(false)
    expect(official('https://api.deepseek.com:8443')).toBe(false)
    expect(official('https://api.deepseek.com.evil.example')).toBe(false)
    expect(official('https://deepseek.example.com/v1')).toBe(false)
    expect(official('https://openrouter.ai/api/v1')).toBe(false)
    expect(official('not a url')).toBe(false)
    expect(official('https://api.deepseek.com', null)).toBe(false)
    expect(official('https://api.deepseek.com', '  ')).toBe(false)
  })

  it('maps results in service order and keeps nullable dates out', async () => {
    const backend = createDeepSeekSearchBackend({
      apiKey: 'sk',
      fetch: reply(200, {
        results: [
          { url: 'https://a.example/', title: 'A', snippet: 'a', date: null },
          {
            url: 'https://b.example/',
            title: '',
            snippet: '',
            date: '2026-10-01',
          },
        ],
      }),
    })
    expect(await backend.search('q', new AbortController().signal)).toEqual([
      { url: 'https://a.example/', title: 'A', snippet: 'a' },
      {
        url: 'https://b.example/',
        title: '',
        snippet: '',
        publishedAt: '2026-10-01',
      },
    ])
    expect(DEEPSEEK_SEARCH_ENDPOINT).toBe(
      'https://api.deepseek.com/v1/tools/search',
    )
  })

  it('turns provider failures into readable tool errors', async () => {
    const search = (status: number, body: unknown) =>
      createDeepSeekSearchBackend({
        apiKey: 'sk',
        fetch: reply(status, body),
      }).search('q', new AbortController().signal)
    await expect(
      search(401, { error: { message: 'Authentication Fails' } }),
    ).rejects.toThrow(/HTTP 401.*Authentication Fails.*API key/s)
    await expect(search(402, {})).rejects.toThrow(/HTTP 402.*balance/s)
    await expect(search(429, 'busy')).rejects.toThrow(/HTTP 429/)
    await expect(search(200, { results: 'no' })).rejects.toThrow(
      /invalid response/,
    )
    await expect(
      search(200, { results: [{ url: 7, title: 'x', snippet: '' }] }),
    ).rejects.toThrow(/invalid response/)
  })

  it('passes cancellation to the request', async () => {
    const controller = new AbortController()
    let signal: AbortSignal | null | undefined
    const backend = createDeepSeekSearchBackend({
      apiKey: 'sk',
      fetch: (async (_url: unknown, init?: RequestInit) => {
        signal = init?.signal
        controller.abort(new Error('stopped'))
        throw init?.signal?.reason
      }) as unknown as typeof fetch,
    })
    await expect(backend.search('q', controller.signal)).rejects.toThrow(
      'stopped',
    )
    expect(signal).toBe(controller.signal)
  })
})
