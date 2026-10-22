import { describe, expect, it, vi } from 'vitest'
import {
  ModelDiscovery,
  resolveParser,
  type DiscoveredModel,
  type DiscoveryConnection,
  type DiscoveryResult,
  type DiscoverySuccess,
  type ModelDiscoveryOptions,
} from './index'
import type { DiscoveryFetch } from './http'
import {
  jsonResponse,
  loadFixture,
  replayFetch,
  scriptedFetch,
} from './testing'

const KEY = 'sk-test-key-0123456789'

function conn(over: Partial<DiscoveryConnection> = {}): DiscoveryConnection {
  return {
    provider: 'custom',
    protocol: 'openai',
    apiBase: 'https://gateway.example.com/v1',
    apiKey: KEY,
    ...over,
  }
}

function discovery(
  fetch: DiscoveryFetch,
  options: Partial<ModelDiscoveryOptions> = {},
): ModelDiscovery {
  return new ModelDiscovery({ fetch, sleep: async () => {}, ...options })
}

function success(result: DiscoveryResult): DiscoverySuccess {
  if (!result.ok)
    throw new Error(`expected success, got ${result.code}: ${result.message}`)
  return result
}

function model(result: DiscoverySuccess, id: string): DiscoveredModel {
  const found = result.models.find((item) => item.id === id)
  if (!found) throw new Error(`model ${id} not listed`)
  return found
}

const ANTHROPIC = conn({
  provider: 'anthropic',
  protocol: 'anthropic',
  apiBase: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test-0000',
})

describe('vendor model lists (MOD-02 card)', () => {
  it('1. merges all three Anthropic pages and reads max_tokens and capabilities', async () => {
    const { fetch, requests } = replayFetch(loadFixture('anthropic'))
    const result = success(await discovery(fetch).discover(ANTHROPIC))

    expect(result).toMatchObject({ parser: 'anthropic', source: 'vendor_api' })
    expect(result.models.map((item) => item.id)).toEqual([
      'claude-fable-5-1',
      'claude-haiku-4-5-20251001',
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ])
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5',
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-haiku-5-5',
    ])
    for (const request of requests) {
      expect(request.headers['x-api-key']).toBe('sk-ant-test-0000')
      expect(request.headers['anthropic-version']).toBe('2023-06-01')
      expect(request.headers.authorization).toBeUndefined()
    }

    expect(model(result, 'claude-opus-5-5')).toMatchObject({
      name: 'Claude Opus 5.5',
      contextWindowTokens: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: { vision: true, reasoning: true },
      reasoning: {
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        control: 'always',
      },
      source: 'vendor_api',
      fieldSources: { maxOutputTokens: 'vendor_api', vision: 'vendor_api' },
    })
    expect(model(result, 'claude-sonnet-5-5').reasoning).toMatchObject({
      efforts: ['low', 'medium', 'high', 'max'],
      control: 'effort',
    })
    expect(model(result, 'claude-haiku-4-5-20251001')).toMatchObject({
      maxOutputTokens: 64_000,
      reasoning: { efforts: [], control: 'budget' },
      lifecycle: { status: 'deprecated', retiresAt: '2027-03-22' },
    })
    // capabilities: null → the limits are the vendor's, the rest the catalog's.
    const haiku = model(result, 'claude-haiku-5-5')
    expect(haiku.maxOutputTokens).toBe(128_000)
    expect(haiku.fieldSources.maxOutputTokens).toBe('vendor_api')
    expect(haiku.capabilities.toolCall).toBe(true)
    expect(haiku.fieldSources.toolCall).toBe('catalog')
  })

  it('2. reads Gemini native limits, strips models/ and keys by header only', async () => {
    const { fetch, requests } = replayFetch(loadFixture('gemini'))
    const result = success(
      await discovery(fetch).discover(
        conn({
          provider: 'gemini',
          apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
          apiKey: 'AIzaTestOnlyKey',
        }),
      ),
    )

    expect(result.parser).toBe('gemini-native')
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.headers['x-goog-api-key']).toBe('AIzaTestOnlyKey')
      expect(request.url).not.toContain('AIza')
      expect(request.headers.authorization).toBeUndefined()
    }
    expect(result.models.some((item) => item.id.startsWith('models/'))).toBe(
      false,
    )
    expect(model(result, 'gemini-4-argon')).toMatchObject({
      name: 'Gemini 4 Argon',
      kind: 'chat',
      contextWindowTokens: 1_048_576,
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536,
      capabilities: { reasoning: true },
      fieldSources: { contextWindowTokens: 'vendor_api' },
    })
    expect(model(result, 'gemini-embedding-001').kind).toBe('embedding')
    expect(model(result, 'imagen-4.0-generate-001').kind).toBe('image')
  })

  it('3. reads Kimi context_length, think_efforts and the undocumented tool flag', async () => {
    const { fetch, requests } = replayFetch(loadFixture('kimi'))
    const result = success(
      await discovery(fetch).discover(
        conn({ provider: 'moonshot', apiBase: 'https://api.moonshot.cn/v1' }),
      ),
    )

    expect(result.parser).toBe('kimi')
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(model(result, 'kimi-k3')).toMatchObject({
      name: 'Kimi K3',
      contextWindowTokens: 1_048_576,
      capabilities: { toolCall: true, vision: true, reasoning: true },
      reasoning: {
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
        control: 'always',
      },
      fieldSources: {
        contextWindowTokens: 'vendor_api',
        toolCall: 'vendor_api',
      },
    })
    expect(model(result, 'kimi-k3').modalities).toEqual(
      expect.arrayContaining(['text', 'image', 'video']),
    )
    expect(
      model(result, 'kimi-k2.7-code-highspeed').capabilities.toolCall,
    ).toBe(false)
  })

  it('4. takes the Ollama context from num_ctx in /api/show', async () => {
    const { fetch, requests } = replayFetch(loadFixture('ollama'))
    const result = success(
      await discovery(fetch).discover(
        conn({
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          apiKey: '',
        }),
      ),
    )

    expect(result.parser).toBe('ollama')
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET http://localhost:11434/api/tags',
      'POST http://localhost:11434/api/show',
      'POST http://localhost:11434/api/show',
    ])
    expect(requests.every((r) => r.headers.authorization === undefined)).toBe(
      true,
    )
    expect(model(result, 'qwen3:32b')).toMatchObject({
      kind: 'chat',
      contextWindowTokens: 16_384,
      capabilities: { toolCall: true, vision: false, reasoning: true },
      fieldSources: { contextWindowTokens: 'vendor_api' },
    })
    const embed = model(result, 'nomic-embed-text:latest')
    expect(embed.kind).toBe('embedding')
    // No num_ctx: the trained length (model_info) is not what Ollama runs with.
    expect(embed.contextWindowTokens).toBeUndefined()
  })

  it('5. parses the Together bare-array response', async () => {
    const { fetch } = replayFetch(loadFixture('together'))
    const result = success(
      await discovery(fetch).discover(
        conn({ apiBase: 'https://api.together.xyz/v1' }),
      ),
    )

    expect(result.parser).toBe('together')
    expect(result.models).toHaveLength(3)
    expect(
      model(result, 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8'),
    ).toMatchObject({
      name: 'Llama 4 Maverick Instruct (17Bx128E)',
      ownedBy: 'Meta',
      kind: 'chat',
      contextWindowTokens: 1_048_576,
    })
    expect(model(result, 'BAAI/bge-large-en-v1.5').kind).toBe('embedding')
    expect(model(result, 'black-forest-labs/FLUX.1-schnell').kind).toBe('image')
  })

  it('6. fails as a whole when page 2 fails, with no half list', async () => {
    const [page1] = loadFixture('anthropic').exchanges
    const { fetch, requests } = scriptedFetch((request) =>
      request.url.includes('after_id')
        ? jsonResponse({ error: { message: 'overloaded' } }, 500)
        : jsonResponse(page1!.response.body),
    )
    const service = discovery(fetch)
    const result = await service.discover(ANTHROPIC)

    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('models')
    expect(result).toMatchObject({ code: 'UNKNOWN', status: 500 })
    expect(!result.ok && result.message).toContain('第 2 页')
    // A failure is not cached.
    await service.discover(ANTHROPIC)
    expect(requests).toHaveLength(4)
  })

  it('7. stops with an error when a cursor repeats', async () => {
    const { fetch, requests } = scriptedFetch(() =>
      jsonResponse({
        models: [{ name: 'models/gemini-x', supportedGenerationMethods: [] }],
        nextPageToken: 'same-token',
      }),
    )
    const result = await discovery(fetch).discover(
      conn({
        provider: 'gemini',
        apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
      }),
    )

    expect(result).toMatchObject({ ok: false, code: 'PAGING_FAILED' })
    expect(!result.ok && result.message).toContain('游标重复')
    expect(requests).toHaveLength(2)
  })

  it('8. retries /v1/models after a 404 and returns the fixed apiBase', async () => {
    const { fetch, requests } = scriptedFetch((request) =>
      request.url === 'https://gateway.example.com/v1/models'
        ? jsonResponse({ object: 'list', data: [{ id: 'gpt-5.4-mini' }] })
        : new Response('404 page not found', { status: 404 }),
    )
    const service = discovery(fetch)
    const base = conn({ apiBase: 'https://gateway.example.com' })

    const result = success(await service.discover(base))
    expect(result.models.map((item) => item.id)).toEqual(['gpt-5.4-mini'])
    expect(result.fix).toEqual({ apiBase: 'https://gateway.example.com/v1' })
    expect(requests.map((r) => r.url)).toEqual([
      'https://gateway.example.com/models',
      'https://gateway.example.com/v1/models',
    ])

    const probe = await service.probe(base)
    expect(probe).toMatchObject({
      ok: false,
      code: 'WRONG_BASE',
      fix: { apiBase: 'https://gateway.example.com/v1' },
    })
  })

  it('9. reports REGION_KEY_MISMATCH when a .cn Kimi key is used on .ai', async () => {
    const { fetch, requests } = scriptedFetch((request) =>
      request.url.startsWith('https://api.moonshot.cn/')
        ? jsonResponse({ object: 'list', data: [{ id: 'kimi-k3' }] })
        : jsonResponse(
            {
              error: {
                message: 'Invalid Authentication',
                type: 'invalid_authentication_error',
              },
            },
            401,
          ),
    )
    const service = discovery(fetch)
    const ai = conn({
      provider: 'moonshot',
      apiBase: 'https://api.moonshot.ai/v1',
    })

    expect(await service.probe(ai)).toMatchObject({
      ok: false,
      code: 'REGION_KEY_MISMATCH',
      fix: { apiBase: 'https://api.moonshot.cn/v1' },
    })
    expect(await service.discover(ai)).toMatchObject({
      ok: false,
      code: 'REGION_KEY_MISMATCH',
      fix: { apiBase: 'https://api.moonshot.cn/v1' },
    })
    expect(requests.map((r) => new URL(r.url).host)).toContain(
      'api.moonshot.cn',
    )

    const bothFail = scriptedFetch(() =>
      jsonResponse({ error: { message: 'Invalid Authentication' } }, 401),
    )
    expect(await discovery(bothFail.fetch).probe(ai)).toMatchObject({
      ok: false,
      code: 'AUTH',
      status: 401,
    })
  })

  it('10. answers Volcengine Ark from the catalog without a request', async () => {
    const { fetch, requests } = scriptedFetch(() => {
      throw new TypeError('fetch failed')
    })
    const result = success(
      await discovery(fetch).discover(
        conn({
          provider: 'volcengine',
          apiBase: 'https://ark.cn-beijing.volces.com/api/v3',
        }),
      ),
    )

    expect(result).toMatchObject({ source: 'catalog', parser: 'catalog-only' })
    expect(result.models.length).toBeGreaterThan(5)
    expect(result.models.map((item) => item.id)).toContain(
      'doubao-seed-2-1-pro-260628',
    )
    expect(result.models.every((item) => item.source === 'catalog')).toBe(true)
    expect(
      result.models.some((item) => item.lifecycle?.status === 'retired'),
    ).toBe(false)
    expect(requests).toHaveLength(0)
  })

  it('12. serves a second request within 15 minutes from the cache', async () => {
    let now = Date.parse('2026-10-19T08:00:00Z')
    const { fetch, requests } = replayFetch(loadFixture('deepseek'))
    const service = discovery(fetch, { now: () => now })
    const deepseek = conn({
      provider: 'deepseek',
      apiBase: 'https://api.deepseek.com',
    })

    const first = success(await service.discover(deepseek))
    expect(first.cached).toBe(false)
    now += 14 * 60_000
    const second = success(await service.discover(deepseek))
    expect(second.cached).toBe(true)
    expect(second.models).toEqual(first.models)
    expect(requests).toHaveLength(1)

    // Another key is another connection.
    await service.discover({ ...deepseek, apiKey: 'sk-other-key-99999999' })
    expect(requests).toHaveLength(2)
    // refresh bypasses the cache; past 15 minutes the entry is stale.
    await service.discover(deepseek, { refresh: true })
    expect(requests).toHaveLength(3)
    now += 16 * 60_000
    expect(success(await service.discover(deepseek)).cached).toBe(false)
    expect(requests).toHaveLength(4)
  })
})

describe('parser registry', () => {
  it.each([
    ['anthropic', 'anthropic', 'https://api.anthropic.com', 'anthropic'],
    [
      'gemini',
      'openai',
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'gemini-native',
    ],
    ['deepseek', 'openai', 'https://api.deepseek.com', 'deepseek'],
    ['deepseek', 'anthropic', 'https://api.deepseek.com/anthropic', 'deepseek'],
    ['moonshot', 'openai', 'https://api.moonshot.ai/v1', 'kimi'],
    ['moonshot', 'anthropic', 'https://api.moonshot.cn/anthropic', 'kimi'],
    ['xai', 'openai', 'https://api.x.ai/v1', 'xai'],
    ['mistral', 'openai', 'https://api.mistral.ai/v1', 'mistral'],
    ['openrouter', 'openai', 'https://openrouter.ai/api/v1', 'openrouter'],
    ['groq', 'openai', 'https://api.groq.com/openai/v1', 'groq'],
    ['custom', 'openai', 'https://api.together.xyz/v1', 'together'],
    ['siliconflow', 'openai', 'https://api.siliconflow.cn/v1', 'siliconflow'],
    ['ollama', 'openai', 'http://localhost:11434/v1', 'ollama'],
    ['custom', 'openai', 'http://127.0.0.1:11434', 'ollama'],
    ['lm_studio', 'openai', 'http://localhost:1234/v1', 'lmstudio'],
    ['vllm', 'openai', 'http://10.0.0.5:8000/v1', 'vllm'],
    [
      'volcengine',
      'openai',
      'https://ark.cn-beijing.volces.com/api/v3',
      'catalog-only',
    ],
    [
      'volcengine_coding_plan',
      'anthropic',
      'https://ark.cn-beijing.volces.com/api/coding',
      'catalog-only',
    ],
    [
      'byteplus',
      'openai',
      'https://ark.ap-southeast.bytepluses.com/api/v3',
      'catalog-only',
    ],
    [
      'dashscope',
      'openai',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'openai-compatible',
    ],
    ['custom', 'anthropic', 'https://llm.example.com/anthropic', 'anthropic'],
    ['custom', 'openai', 'https://gateway.example.com/v1', 'openai-compatible'],
  ] as const)('%s %s %s → %s', (provider, protocol, apiBase, expected) => {
    expect(resolveParser({ provider, protocol, apiBase }).id).toBe(expected)
  })

  it('uses the Bailian workspace catalog only when a workspace ID is given', () => {
    expect(
      resolveParser({
        provider: 'dashscope',
        protocol: 'openai',
        apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        workspaceId: 'llm-ws01',
      }).id,
    ).toBe('bailian-catalog')
  })
})

describe('general list rules', () => {
  it('stops after 100 pages', async () => {
    let page = 0
    const { fetch, requests } = scriptedFetch(() =>
      jsonResponse({ models: [], nextPageToken: `token-${++page}` }),
    )
    const result = await discovery(fetch).discover(
      conn({
        provider: 'gemini',
        apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
      }),
    )
    expect(result).toMatchObject({ ok: false, code: 'PAGING_FAILED' })
    expect(requests).toHaveLength(100)
  })

  it('keeps at most 2000 models and marks the list truncated', async () => {
    const data = Array.from({ length: 2500 }, (_, i) => ({
      id: `model-${String(i).padStart(4, '0')}`,
    }))
    const { fetch } = scriptedFetch(() => jsonResponse({ data }))
    const result = success(await discovery(fetch).discover(conn()))
    expect(result.models).toHaveLength(2000)
    expect(result).toMatchObject({ truncated: true, totalCount: 2500 })
  })

  it('drops ids that look like secrets and never returns the key', async () => {
    const { fetch } = scriptedFetch(() =>
      jsonResponse({
        data: [
          { id: 'gpt-5.4-mini' },
          { id: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234' },
          { id: `acct-${KEY}` },
          { id: 'tenant/Zx81Qp0RtYu7KlMn3BvCx92LkJhGfDsA' },
          { id: 'ep-20260101123456-abcde' },
        ],
      }),
    )
    const result = success(await discovery(fetch).discover(conn()))
    expect(result.models.map((item) => item.id)).toEqual([
      'ep-20260101123456-abcde',
      'gpt-5.4-mini',
    ])
    expect(result.droppedSecretLikeIds).toBe(3)
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('scrubs a key the vendor echoes back in an error', async () => {
    const { fetch } = scriptedFetch(() =>
      jsonResponse(
        { error: { message: `Incorrect API key provided: ${KEY}.` } },
        401,
      ),
    )
    const service = discovery(fetch)
    const listed = await service.discover(conn())
    const probed = await service.probe(conn())
    expect(listed).toMatchObject({ ok: false, code: 'AUTH' })
    expect(probed).toMatchObject({ ok: false, code: 'AUTH' })
    expect(JSON.stringify([listed, probed])).not.toContain(KEY)
    expect(JSON.stringify(listed)).toContain('Incorrect API key provided')
  })

  it('backs off once on 429 as Retry-After says', async () => {
    let calls = 0
    const sleep = vi.fn(async () => {})
    const { fetch } = scriptedFetch(() =>
      ++calls === 1
        ? jsonResponse({ error: { message: 'slow down' } }, 429, {
            'retry-after': '2',
          })
        : jsonResponse({ data: [{ id: 'gpt-5.4-mini' }] }),
    )
    success(await discovery(fetch, { sleep }).discover(conn()))
    expect(sleep).toHaveBeenCalledWith(2000)
    expect(calls).toBe(2)

    const always = scriptedFetch(() => jsonResponse({}, 429))
    expect(await discovery(always.fetch).discover(conn())).toMatchObject({
      ok: false,
      code: 'RATE_LIMITED',
    })
    expect(always.requests).toHaveLength(2)

    const longWait = scriptedFetch(() =>
      jsonResponse({}, 429, { 'retry-after': '120' }),
    )
    expect(await discovery(longWait.fetch).probe(conn())).toMatchObject({
      ok: false,
      code: 'RATE_LIMITED',
    })
    expect(longWait.requests).toHaveLength(1)
  })

  it('times out a request as a network failure', async () => {
    const fetch: DiscoveryFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    const result = await discovery(fetch, { timeoutMs: 20 }).probe(conn())
    expect(result).toMatchObject({ ok: false, code: 'NETWORK' })
    expect(!result.ok && result.message).toContain('超时')
  })

  it('reports a refused connection as NETWORK', async () => {
    const { fetch } = scriptedFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      })
    })
    const result = await discovery(fetch).discover(
      conn({ provider: 'ollama', apiBase: 'http://localhost:11434/v1' }),
    )
    expect(result).toMatchObject({ ok: false, code: 'NETWORK' })
    expect(!result.ok && result.message).toContain('ECONNREFUSED')
  })

  it('treats an HTML page as the wrong address', async () => {
    const { fetch } = scriptedFetch(
      () =>
        new Response('<!doctype html><html><body>Console</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    expect(await discovery(fetch).probe(conn())).toMatchObject({
      ok: false,
      code: 'WRONG_BASE',
    })
  })

  it('reports a JSON body without a model list as NOT_COMPATIBLE', async () => {
    const { fetch } = scriptedFetch(() => jsonResponse({ hello: 'world' }))
    expect(await discovery(fetch).discover(conn())).toMatchObject({
      ok: false,
      code: 'NOT_COMPATIBLE',
    })
  })

  it('never follows a redirect to another host with the key', async () => {
    const { fetch, requests } = scriptedFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/models' },
        }),
    )
    const result = await discovery(fetch).discover(conn())
    expect(result).toMatchObject({ ok: false, code: 'WRONG_BASE' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://gateway.example.com/v1/models')
  })

  it('follows a redirect on the same host', async () => {
    const { fetch, requests } = scriptedFetch((request) =>
      request.url.endsWith('/v1/models')
        ? new Response(null, {
            status: 308,
            headers: { location: '/v1/models/' },
          })
        : jsonResponse({ data: [{ id: 'gpt-5.4-mini' }] }),
    )
    success(await discovery(fetch).discover(conn()))
    expect(requests.map((r) => r.url)).toEqual([
      'https://gateway.example.com/v1/models',
      'https://gateway.example.com/v1/models/',
    ])
    expect(requests[1]?.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('suggests the provider a key prefix belongs to when auth fails', async () => {
    const { fetch } = scriptedFetch(() => jsonResponse({}, 401))
    expect(
      await discovery(fetch).probe(conn({ apiKey: 'sk-ant-api03-xyz-test' })),
    ).toMatchObject({ ok: false, code: 'AUTH', fix: { provider: 'anthropic' } })
  })

  it('falls back to the catalog when a preset base has no list endpoint', async () => {
    const notFound = () => new Response('not found', { status: 404 })
    const preset = scriptedFetch(notFound)
    const listed = success(
      await discovery(preset.fetch).discover(
        conn({ provider: 'stepfun', apiBase: 'https://api.stepfun.com/v1' }),
      ),
    )
    expect(listed.source).toBe('catalog')
    expect(listed.models.map((item) => item.id)).toContain('step-3.7-flash')
    expect(listed.message).toBeTruthy()

    // An address the user typed is more likely wrong than list-less.
    const edited = scriptedFetch(notFound)
    expect(
      await discovery(edited.fetch).discover(
        conn({ provider: 'stepfun', apiBase: 'https://proxy.example.com/v1' }),
      ),
    ).toMatchObject({ ok: false, code: 'WRONG_BASE' })
  })

  it('falls back to the catalog when a third-party Anthropic endpoint has no /v1/models', async () => {
    const { fetch, requests } = scriptedFetch(
      () => new Response('not found', { status: 404 }),
    )
    const result = success(
      await discovery(fetch).discover(
        conn({
          provider: 'xiaomi_mimo',
          protocol: 'anthropic',
          apiBase: 'https://api.xiaomimimo.com/anthropic',
        }),
      ),
    )
    expect(requests[0]?.url).toBe(
      'https://api.xiaomimimo.com/anthropic/v1/models?limit=1000',
    )
    expect(result.source).toBe('catalog')
    expect(result.models.map((item) => item.id)).toContain('mimo-v2.6-pro')
  })
})

describe('probeConnection', () => {
  it('checks the key with one list request and counts the models', async () => {
    const { fetch, requests } = replayFetch(loadFixture('deepseek'))
    const result = await discovery(fetch).probe(
      conn({ provider: 'deepseek', apiBase: 'https://api.deepseek.com' }),
    )
    expect(result).toMatchObject({ ok: true, modelCount: 2, method: 'list' })
    expect(result.ok && result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(requests).toHaveLength(1)
  })

  it('checks an Ark key with an empty request that cannot run a model', async () => {
    const { fetch, requests } = scriptedFetch((request) =>
      request.headers.authorization === `Bearer ${KEY}`
        ? jsonResponse(
            {
              error: {
                code: 'MissingParameter',
                message: 'The request failed because it is missing `model`.',
              },
            },
            400,
          )
        : jsonResponse({ error: { code: 'AuthenticationError' } }, 401),
    )
    const service = discovery(fetch)
    const ark = conn({
      provider: 'volcengine',
      apiBase: 'https://ark.cn-beijing.volces.com/api/v3',
    })
    expect(await service.probe(ark)).toMatchObject({
      ok: true,
      method: 'auth_check',
    })
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      body: { model: '', messages: [], max_tokens: 1 },
    })
    expect(
      await service.probe({ ...ark, apiKey: 'wrong-key-000000' }),
    ).toMatchObject({ ok: false, code: 'AUTH' })
  })

  it('uses OpenRouter GET /key, since the model list is public', async () => {
    const { fetch, requests } = replayFetch(loadFixture('openrouter'))
    const result = await discovery(fetch).probe(
      conn({ provider: 'openrouter', apiBase: 'https://openrouter.ai/api/v1' }),
    )
    expect(result).toMatchObject({ ok: true, method: 'auth_check' })
    expect(requests.map((r) => r.url)).toEqual([
      'https://openrouter.ai/api/v1/key',
    ])
  })

  it('suggests dropping /v1 from an Anthropic base', async () => {
    const { fetch } = replayFetch(loadFixture('anthropic'))
    expect(
      await discovery(fetch).probe({
        ...ANTHROPIC,
        apiBase: 'https://api.anthropic.com/v1',
      }),
    ).toMatchObject({
      ok: false,
      code: 'WRONG_BASE',
      fix: { apiBase: 'https://api.anthropic.com' },
    })
  })
})

describe('vendor parsers', () => {
  it('DeepSeek: vendor limits and efforts, catalog for the rest, sources honest', async () => {
    const { fetch } = replayFetch(loadFixture('deepseek'))
    const result = success(
      await discovery(fetch).discover(
        conn({ provider: 'deepseek', apiBase: 'https://api.deepseek.com' }),
      ),
    )
    const flash = model(result, 'deepseek-flash')
    expect(flash).toMatchObject({
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 393_216,
      capabilities: { vision: true, reasoning: true, toolCall: true },
      reasoning: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      source: 'vendor_api',
      catalogKey: 'models.dev:deepseek/deepseek-flash',
      family: 'deepseek-flash',
    })
    expect(flash.fieldSources).toMatchObject({
      contextWindowTokens: 'vendor_api',
      vision: 'vendor_api',
      toolCall: 'catalog',
      pricing: 'catalog',
    })
    expect(model(result, 'deepseek-v4-pro').capabilities.vision).toBe(false)
  })

  it('a bare id is described by the catalog, an unknown one by nothing', async () => {
    const { fetch } = scriptedFetch(() =>
      jsonResponse({ data: [{ id: 'gpt-5.4-mini' }, { id: 'acme-zeta-1' }] }),
    )
    const result = success(await discovery(fetch).discover(conn()))
    const known = model(result, 'gpt-5.4-mini')
    expect(known.source).toBe('catalog')
    expect(known.contextWindowTokens).toBeGreaterThan(0)
    expect(known.fieldSources.contextWindowTokens).toBe('catalog')
    const unknown = model(result, 'acme-zeta-1')
    expect(unknown.source).toBe('fallback')
    expect(unknown.capabilities).toEqual({
      toolCall: undefined,
      vision: undefined,
      reasoning: undefined,
    })
    expect(unknown.contextWindowTokens).toBeUndefined()
  })

  it('OpenRouter: follows links.next, converts USD per token, reads reasoning', async () => {
    const { fetch, requests } = replayFetch(loadFixture('openrouter'))
    const result = success(
      await discovery(fetch).discover(
        conn({
          provider: 'openrouter',
          apiBase: 'https://openrouter.ai/api/v1',
        }),
      ),
    )
    expect(requests).toHaveLength(2)
    expect(result.models).toHaveLength(3)
    expect(model(result, 'moonshotai/kimi-k3')).toMatchObject({
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 943_718,
      capabilities: { toolCall: true, vision: true, reasoning: true },
      reasoning: {
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
        control: 'always',
      },
      acceptsTemperature: false,
      pricingUsdPerMTok: { input: 0.6, output: 2.5, cacheRead: 0.15 },
      fieldSources: { pricing: 'vendor_api' },
    })
    expect(model(result, 'meta-llama/llama-4-maverick')).toMatchObject({
      acceptsTemperature: true,
      lifecycle: { status: 'deprecated', retiresAt: '2026-12-31' },
    })
    const auto = model(result, 'openrouter/auto')
    expect(auto.contextWindowTokens).toBe(2_000_000)
    expect(auto.fieldSources.pricing).not.toBe('vendor_api')
  })

  it('xAI: context and reasoning efforts', async () => {
    const { fetch } = replayFetch(loadFixture('xai'))
    const result = success(
      await discovery(fetch).discover(
        conn({ provider: 'xai', apiBase: 'https://api.x.ai/v1' }),
      ),
    )
    expect(model(result, 'grok-4.7')).toMatchObject({
      contextWindowTokens: 500_000,
      capabilities: { reasoning: true },
      reasoning: {
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
      },
    })
  })

  it('Mistral: capabilities, deprecation, archived models skipped', async () => {
    const { fetch } = replayFetch(loadFixture('mistral'))
    const result = success(
      await discovery(fetch).discover(
        conn({ provider: 'mistral', apiBase: 'https://api.mistral.ai/v1' }),
      ),
    )
    expect(result.models.map((item) => item.id)).toEqual([
      'magistral-medium-2509',
      'mistral-embed',
      'mistral-large-4-0',
    ])
    expect(model(result, 'mistral-large-4-0')).toMatchObject({
      contextWindowTokens: 1_048_576,
      capabilities: { toolCall: true, vision: true, reasoning: false },
      acceptsTemperature: true,
    })
    expect(model(result, 'mistral-embed').kind).toBe('embedding')
    expect(model(result, 'magistral-medium-2509').lifecycle).toEqual({
      status: 'deprecated',
      retiresAt: '2026-07-31',
      replacement: 'mistral-medium-latest',
    })
  })

  it('Groq: context window, inactive models skipped', async () => {
    const { fetch } = replayFetch(loadFixture('groq'))
    const result = success(
      await discovery(fetch).discover(
        conn({ provider: 'groq', apiBase: 'https://api.groq.com/openai/v1' }),
      ),
    )
    expect(result.models.map((item) => item.id)).toEqual([
      'openai/gpt-oss-120b',
      'whisper-large-v3',
    ])
    expect(model(result, 'openai/gpt-oss-120b')).toMatchObject({
      contextWindowTokens: 131_072,
      maxOutputTokens: 65_536,
    })
    expect(model(result, 'whisper-large-v3').kind).toBe('audio')
  })

  it('SiliconFlow: asks for text chat models only', async () => {
    const { fetch, requests } = replayFetch(loadFixture('siliconflow'))
    const result = success(
      await discovery(fetch).discover(
        conn({
          provider: 'siliconflow',
          apiBase: 'https://api.siliconflow.cn/v1',
        }),
      ),
    )
    expect(requests[0]?.url).toBe(
      'https://api.siliconflow.cn/v1/models?type=text&sub_type=chat',
    )
    expect(result.models.every((item) => item.kind === 'chat')).toBe(true)
    expect(result.models.every((item) => item.fieldSources.kind)).toBe(true)
  })

  it('LM Studio: the loaded context, tool and vision flags', async () => {
    const { fetch } = replayFetch(loadFixture('lmstudio'))
    const result = success(
      await discovery(fetch).discover(
        conn({
          provider: 'lm_studio',
          apiBase: 'http://localhost:1234/v1',
          apiKey: '',
        }),
      ),
    )
    expect(model(result, 'qwen/qwen3-coder-30b')).toMatchObject({
      name: 'Qwen3 Coder 30B',
      contextWindowTokens: 32_768,
      capabilities: { toolCall: true, vision: false, reasoning: true },
      reasoning: { efforts: [], control: 'toggle' },
    })
    const gemma = model(result, 'google/gemma-3-27b')
    expect(gemma.contextWindowTokens).toBeUndefined()
    expect(gemma.capabilities).toMatchObject({ vision: true, toolCall: false })
    expect(model(result, 'text-embedding-nomic-embed-text-v1.5').kind).toBe(
      'embedding',
    )
  })

  it('vLLM: max_model_len, and the catalog looked up by root', async () => {
    const { fetch } = replayFetch(loadFixture('vllm'))
    const result = success(
      await discovery(fetch).discover(
        conn({
          provider: 'vllm',
          apiBase: 'http://10.0.0.5:8000/v1',
          apiKey: '',
        }),
      ),
    )
    expect(model(result, 'team-coder')).toMatchObject({
      contextWindowTokens: 131_072,
      fieldSources: { contextWindowTokens: 'vendor_api' },
      catalogKey: 'models.dev:alibaba/qwen3-coder-480b-a35b-instruct',
    })
  })

  it('Bailian: the workspace catalog with limits, capabilities and features', async () => {
    const { fetch, requests } = replayFetch(loadFixture('bailian'))
    const result = success(
      await discovery(fetch).discover(
        conn({
          provider: 'dashscope',
          apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          workspaceId: 'llm-ws01',
        }),
      ),
    )
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(model(result, 'qwen3.8-max')).toMatchObject({
      name: '通义千问3.8-Max',
      contextWindowTokens: 1_000_000,
      maxInputTokens: 991_808,
      maxOutputTokens: 131_072,
      capabilities: { toolCall: true, vision: true, reasoning: true },
    })
    expect(model(result, 'qwen3.8-max').fieldSources.pricing).not.toBe(
      'vendor_api',
    )
    expect(model(result, 'text-embedding-v4').kind).toBe('embedding')
    expect(model(result, 'qwen3-asr-flash').kind).toBe('audio')
  })

  it('rejects a workspace ID that is not a DNS label', async () => {
    const { fetch, requests } = scriptedFetch(() => jsonResponse({}))
    const result = await discovery(fetch).discover(
      conn({
        provider: 'dashscope',
        apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        workspaceId: 'evil.example/x',
      }),
    )
    expect(result).toMatchObject({ ok: false, code: 'WRONG_BASE' })
    expect(requests).toHaveLength(0)
  })
})
