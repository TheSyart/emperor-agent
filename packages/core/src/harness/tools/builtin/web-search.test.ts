import { describe, expect, it } from 'vitest'
import { SystemPromptAssembler } from '../../prompt/assembler'
import { ToolRegistry } from '../registry'
import { textOf } from '../definition'
import {
  createWebSearchTool,
  formatSearchOutput,
  installWebSearchPromptSection,
  webSearchBackendFromAdapter,
  type WebSearchAdapter,
  type WebSearchBackend,
  type WebSearchHit,
} from './web-search'

function fakeBackend(
  table: Record<
    string,
    WebSearchHit[] | { summary?: string; results: WebSearchHit[] }
  >,
  seen: string[] = [],
): WebSearchBackend {
  return {
    async search(query) {
      seen.push(query)
      const hit = table[query]
      if (hit === undefined) throw new Error(`no fixture for ${query}`)
      return hit
    },
  }
}

async function call(backend: WebSearchBackend, args: unknown) {
  const tools = new ToolRegistry()
  tools.register(createWebSearchTool(backend))
  const result = await tools.execute({
    callId: 'c',
    name: 'web_search',
    arguments: args,
    signal: new AbortController().signal,
  })
  return { ...result, text: textOf(result.content) }
}

const hit = (n: number): WebSearchHit => ({
  title: `T${n}`,
  url: `https://e.com/${n}`,
  snippet: `s${n}`,
})

describe('web_search', () => {
  it('renders summary, sources with snippet/date, and the cite instruction', async () => {
    const backend = fakeBackend({
      q: {
        summary: 'The answer.',
        results: [
          {
            title: '',
            url: 'https://example.org/a',
            snippet: 'snip',
            publishedAt: '2026-01-01',
          },
          hit(1),
        ],
      },
    })
    const result = await call(backend, { queries: ['q'] })
    expect(result.isError).toBe(false)
    expect(result.text).toBe(
      [
        'The answer.',
        'Sources:\n- [example.org](https://example.org/a) — snip (2026-01-01)\n- [T1](https://e.com/1) — s1',
        'Cite the relevant URLs above as markdown links in your answer.',
      ].join('\n\n'),
    )
    expect(result.meta).toMatchObject({
      truncated: false,
      answer: 'The answer.',
    })
  })

  it('reports no results and truncation', async () => {
    expect((await call(fakeBackend({ q: [] }), { queries: ['q'] })).text).toBe(
      'No results found.\n\nCite the relevant URLs above as markdown links in your answer.',
    )
    const many = Array.from({ length: 10 }, (_, i) => hit(i))
    const result = await call(fakeBackend({ q: many }), { queries: ['q'] })
    expect(result.text).toContain(
      '(Showing the first 8 sources. Refine the query for more.)',
    )
  })

  it('merges multiple queries round-robin with dedup and per-query summaries', async () => {
    const seen: string[] = []
    const backend = fakeBackend(
      { a: { summary: 'A!', results: [hit(1), hit(2)] }, b: [hit(1), hit(3)] },
      seen,
    )
    const result = await call(backend, { queries: ['a', 'b', 'a'] })
    expect(seen.sort()).toEqual(['a', 'b'])
    expect(result.text.startsWith('### a\n\nA!')).toBe(true)
    expect(result.meta).toMatchObject({
      sources: [
        { url: 'https://e.com/1' },
        { url: 'https://e.com/2' },
        { url: 'https://e.com/3' },
      ],
    })
  })

  it('enforces the 1..4 query bound and non-blank queries', async () => {
    const backend = fakeBackend({})
    expect((await call(backend, { queries: [] })).text).toBe(
      'Error: queries must contain at least one query',
    )
    expect(
      (await call(backend, { queries: ['1', '2', '3', '4', '5'] })).text,
    ).toBe('Error: queries must contain at most 4 queries')
    expect((await call(backend, { queries: [' '] })).text).toBe(
      'Error: each query must be a non-empty string',
    )
  })

  it('carries a 60s timeout, is parallel-safe, and installs the order-110 prompt section', () => {
    const tool = createWebSearchTool(fakeBackend({}))
    expect(tool.timeoutMs).toBe(60_000)
    expect(tool.isConcurrencySafe?.({ queries: ['x'] })).toBe(true)
    const prompt = new SystemPromptAssembler()
    installWebSearchPromptSection(prompt)
    const section = prompt.assemble().sections[0]!
    expect(section.name).toBe('tool:web_search')
    expect(section.text).toContain(
      'Use the returned source snippets when available',
    )
    expect(section.text).not.toContain('web_fetch')
  })

  it('bridges the Emperor WebSearchAdapter', async () => {
    const calls: unknown[] = []
    const adapter: WebSearchAdapter = {
      name: 'fake',
      async search(query, opts) {
        calls.push({ query, maxResults: opts.maxResults })
        return [
          {
            title: 'Ok',
            url: 'https://ok.dev/x',
            snippet: 'fine',
            timestamp: '2026-02-02',
          },
          { title: 'Bad', url: 'javascript:alert(1)', snippet: '' },
        ]
      },
    }
    const hits = await webSearchBackendFromAdapter(adapter).search(
      'q',
      new AbortController().signal,
    )
    expect(calls).toEqual([{ query: 'q', maxResults: 8 }])
    expect(hits).toEqual([
      {
        title: 'Ok',
        url: 'https://ok.dev/x',
        snippet: 'fine',
        publishedAt: '2026-02-02',
      },
    ])
    expect(
      formatSearchOutput({ sources: [{ url: 'not a url' }], truncated: false }),
    ).toContain('- [not a url](not a url)')
  })
})
