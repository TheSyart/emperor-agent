import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RouteSpec } from '../llm/route'
import type { GenerateOptions } from '../llm/types'
import type { WebFetchClient } from '../network/web-fetch-client'
import { replyChunks, type ScriptedReply } from '../harness/testing'
import { eventOf, makeApi, type ApiFixture } from './test-helpers'

// 设置 › 高级 › 网络工具 (KRN-08): web_fetch is on by default wherever the
// host has a public HTTP client; web_search exists only on DeepSeek's
// official API; each switch takes its tool out of 能力 › 工具 and out of
// what the model is offered.

const DEEPSEEK: Partial<RouteSpec> = {
  catalogProvider: 'deepseek',
  adapter: 'deepseek',
  displayName: 'DeepSeek V4',
  modelId: 'deepseek-chat',
  baseURL: 'https://api.deepseek.com',
  apiKey: 'sk-deepseek-test',
}

const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

/** A public page client that never touches the network. */
const pageClient: WebFetchClient = {
  async get(request) {
    return {
      url: request.url,
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Buffer.from('<title>Fixture</title><p>fixture page</p>'),
    }
  },
}

interface SearchCall {
  url: string
  method: string | undefined
  headers: Record<string, string>
  body: unknown
}

function searchFetch(calls: SearchCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    })
    return new Response(
      JSON.stringify({
        results: [
          {
            url: 'https://news.example/deepseek-v4',
            title: 'DeepSeek V4 released',
            snippet: 'The model ships today.',
            date: '2026-10-01',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
}

async function api(
  options: {
    route?: Partial<RouteSpec>
    replies?: ScriptedReply[]
    stateRoot?: string
    calls?: SearchCall[]
  } = {},
): Promise<ApiFixture> {
  const fixture = await makeApi({
    ...(options.route ? { route: options.route } : {}),
    ...(options.replies ? { replies: options.replies } : {}),
    ...(options.stateRoot
      ? { root: join(options.stateRoot, '..'), stateRoot: options.stateRoot }
      : {}),
    extra: {
      webFetchClient: pageClient,
      webSearchFetch: searchFetch(options.calls ?? []),
    },
  })
  fixtures.push(fixture)
  return fixture
}

function toolNames(fixture: ApiFixture): string[] {
  return fixture.api.skills.tools().map((tool) => tool.name)
}

function offered(request: GenerateOptions | undefined): string[] {
  return (request?.tools ?? []).map((tool) => tool.name)
}

/** Capture the request the model sees, then end the turn. */
function capture(into: GenerateOptions[]): ScriptedReply {
  return (request) => {
    into.push(request)
    return replyChunks({ text: 'ok' })
  }
}

describe('network tools', () => {
  it('offers web_search on DeepSeek’s official API and runs it through DeepSeek search', async () => {
    const calls: SearchCall[] = []
    const seen: GenerateOptions[] = []
    const fixture = await api({
      route: DEEPSEEK,
      calls,
      replies: [
        (request) => {
          seen.push(request)
          return replyChunks({
            tools: [{ name: 'web_search', args: { queries: ['deepseek v4'] } }],
          })
        },
        capture(seen),
      ],
    })

    expect(toolNames(fixture)).toEqual(
      expect.arrayContaining(['web_fetch', 'web_search']),
    )
    expect(fixture.api.tools.networkSettings()).toMatchObject({
      webFetch: { enabled: true, available: true },
      webSearch: { enabled: true, available: true, provider: 'deepseek' },
    })

    const sessionId = String(fixture.api.sessions.create({ title: 's' }).id)
    await fixture.api.chat.submit({ content: 'news?', sessionId })

    expect(offered(seen[0])).toEqual(
      expect.arrayContaining(['web_fetch', 'web_search']),
    )
    expect(seen[0]?.system).toContain(
      'Use web_fetch to read a specific page when needed',
    )
    expect(calls).toEqual([
      {
        url: 'https://api.deepseek.com/v1/tools/search',
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer sk-deepseek-test',
          'content-type': 'application/json',
        }),
        body: { query: 'deepseek v4', count: 8, need_content: false },
      },
    ])
    const result = JSON.stringify(seen[1]?.messages)
    expect(result).toContain('https://news.example/deepseek-v4')
    expect(result).toContain('source_kind: web_search')
    expect(result).toContain('trust: untrusted_external')
  })

  it.each<[string, Partial<RouteSpec> | undefined]>([
    ['another provider', undefined],
    [
      'a DeepSeek-compatible gateway',
      { ...DEEPSEEK, baseURL: 'https://gateway.example.com/v1' },
    ],
    [
      'a look-alike host',
      { ...DEEPSEEK, baseURL: 'https://api.deepseek.com.evil.example' },
    ],
    ['DeepSeek without an API key', { ...DEEPSEEK, apiKey: null }],
  ])('does not offer web_search on %s', async (_name, route) => {
    const seen: GenerateOptions[] = []
    const fixture = await api({
      ...(route ? { route } : {}),
      replies: [capture(seen)],
    })

    expect(toolNames(fixture)).toContain('web_fetch')
    expect(toolNames(fixture)).not.toContain('web_search')
    expect(fixture.api.tools.networkSettings().webSearch).toMatchObject({
      enabled: true,
      available: false,
    })

    const sessionId = String(fixture.api.sessions.create({ title: 's' }).id)
    await fixture.api.chat.submit({ content: 'hi', sessionId })
    expect(offered(seen[0])).toContain('web_fetch')
    expect(offered(seen[0])).not.toContain('web_search')
    // The prompt names no tool the model does not have.
    expect(seen[0]?.system).not.toContain('web_search')
    expect(seen[0]?.system).toContain('web_fetch')
  })

  it('takes a switched-off tool out of the tool list and the model’s tools', async () => {
    const seen: GenerateOptions[] = []
    const fixture = await api({
      route: DEEPSEEK,
      replies: [
        capture(seen),
        (request) => {
          seen.push(request)
          return replyChunks({
            tools: [
              { name: 'web_fetch', args: { url: 'https://docs.example/' } },
            ],
          })
        },
        capture(seen),
        capture(seen),
      ],
    })
    const { api: core, events, stateRoot } = fixture
    const sessionId = String(core.sessions.create({ title: 's' }).id)

    await core.chat.submit({ content: 'one', sessionId })
    expect(offered(seen[0])).toEqual(
      expect.arrayContaining(['web_fetch', 'web_search']),
    )

    const status = await core.tools.setNetworkSettings({ webFetch: false })
    expect(status.webFetch.enabled).toBe(false)
    expect(eventOf(events, 'web_tools_changed')).toBeDefined()
    expect(toolNames(fixture)).not.toContain('web_fetch')
    expect(toolNames(fixture)).toContain('web_search')

    // A model that still asks for it gets an error, not a fetch.
    await core.chat.submit({ content: 'two', sessionId })
    expect(offered(seen[1])).not.toContain('web_fetch')
    expect(seen[1]?.system).not.toContain('web_fetch')
    expect(JSON.stringify(seen[2]?.messages)).toContain(
      'unknown tool \\"web_fetch\\"',
    )

    await core.tools.setNetworkSettings({ webSearch: false })
    expect(toolNames(fixture)).not.toContain('web_search')
    await core.chat.submit({ content: 'three', sessionId })
    expect(offered(seen[3])).not.toContain('web_search')
    expect(seen[3]?.system).not.toContain('web_search')

    const saved = JSON.parse(
      readFileSync(join(stateRoot, 'settings.json'), 'utf8'),
    ) as { webTools?: unknown }
    expect(saved.webTools).toEqual({ webFetch: false, webSearch: false })

    // The switches survive a restart.
    await core.close()
    fixtures.splice(fixtures.indexOf(fixture), 1)
    const restarted = await api({ route: DEEPSEEK, stateRoot })
    expect(toolNames(restarted)).not.toContain('web_fetch')
    expect(toolNames(restarted)).not.toContain('web_search')
    await restarted.api.tools.setNetworkSettings({
      webFetch: true,
      webSearch: true,
    })
    expect(toolNames(restarted)).toEqual(
      expect.arrayContaining(['web_fetch', 'web_search']),
    )
  })

  it('has no web_fetch without a public HTTP client', async () => {
    const fixture = await makeApi({ route: DEEPSEEK })
    fixtures.push(fixture)
    expect(toolNames(fixture)).not.toContain('web_fetch')
    expect(fixture.api.tools.networkSettings().webFetch).toEqual({
      enabled: true,
      available: false,
    })
  })
})
