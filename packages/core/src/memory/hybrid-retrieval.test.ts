import { describe, expect, it } from 'vitest'
import {
  HybridMemoryRetriever,
  type HybridMemoryChunkInput,
  type MemoryEmbeddingProvider,
} from './hybrid-retrieval'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 19)

describe('HybridMemoryRetriever', () => {
  it('combines vector and FTS candidates without crossing the active project boundary', async () => {
    const retriever = new HybridMemoryRetriever({
      embeddingProvider: embeddingProvider({
        'where is the primary database': [1, 0, 0],
        'PostgreSQL endpoint is db-alpha.internal:6543': [1, 0, 0],
        'Deployment region is ap-southeast-1': [0, 1, 0],
        'Primary database is db-beta.internal:5432': [1, 0, 0],
      }),
      now: () => NOW,
    })
    await retriever.replace([
      chunk(
        'alpha-db',
        'PostgreSQL endpoint is db-alpha.internal:6543',
        'project',
        { projectId: 'alpha' },
      ),
      chunk('alpha-region', 'Deployment region is ap-southeast-1', 'project', {
        projectId: 'alpha',
      }),
      chunk('beta-db', 'Primary database is db-beta.internal:5432', 'project', {
        projectId: 'beta',
      }),
    ])

    const result = await retriever.search({
      query: 'where is the primary database',
      scope: { mode: 'build', projectId: 'alpha', sessionId: 'session-a' },
      maxResults: 3,
    })

    expect(result.strategy).toBe('hybrid')
    expect(result.results[0]).toMatchObject({
      id: 'alpha-db',
      projectId: 'alpha',
    })
    expect(result.results.map((item) => item.id)).not.toContain('beta-db')
  })

  it('penalizes stale session facts while keeping curated project facts evergreen', async () => {
    const retriever = new HybridMemoryRetriever({
      now: () => NOW,
      config: { temporalHalfLifeDays: 14 },
    })
    await retriever.replace([
      chunk('stale', 'release channel is canary', 'session', {
        projectId: 'alpha',
        sessionId: 'session-a',
        createdAt: NOW - 120 * DAY,
      }),
      chunk('fresh', 'release channel is canary', 'session', {
        projectId: 'alpha',
        sessionId: 'session-a',
        createdAt: NOW - DAY,
      }),
      chunk('curated', 'release channel is canary', 'project', {
        projectId: 'alpha',
        createdAt: NOW - 365 * DAY,
      }),
    ])

    const result = await retriever.search({
      query: 'release channel canary',
      scope: { mode: 'build', projectId: 'alpha', sessionId: 'session-a' },
      maxResults: 3,
    })

    expect(result.results.map((item) => item.id)).toEqual([
      'curated',
      'fresh',
      'stale',
    ])
    expect(result.results[1]!.score).toBeGreaterThan(result.results[2]!.score)
  })

  it('uses MMR to keep a diverse fact ahead of a near-duplicate', async () => {
    const retriever = new HybridMemoryRetriever({
      now: () => NOW,
      config: { mmr: { enabled: true, lambda: 0.55 } },
    })
    await retriever.replace([
      chunk('primary', 'Redis cache host cache.internal port 6379', 'global'),
      chunk(
        'duplicate',
        'Redis cache host cache.internal uses port 6379',
        'global',
      ),
      chunk(
        'diverse',
        'Redis eviction policy is allkeys-lru for production',
        'global',
      ),
    ])

    const result = await retriever.search({
      query: 'redis cache host production',
      scope: { mode: 'chat', sessionId: 'session-a' },
      maxResults: 3,
    })

    expect(result.results[0]!.id).toBe('primary')
    expect(result.results[1]!.id).toBe('diverse')
    expect(result.results[2]!.id).toBe('duplicate')
  })

  it('falls back to FTS when query embedding fails and never drops a keyword hit', async () => {
    const provider: MemoryEmbeddingProvider = {
      id: 'throwing-fixture',
      dimensions: 3,
      async embed() {
        throw new Error('fixture embedding outage with private query bytes')
      },
    }
    const retriever = new HybridMemoryRetriever({
      embeddingProvider: provider,
      now: () => NOW,
    })
    await retriever.replace([
      chunk('fallback', 'incident runbook token ZXQ-4417', 'global'),
    ])

    const result = await retriever.search({
      query: 'ZXQ-4417',
      scope: { mode: 'chat', sessionId: 'session-a' },
    })

    expect(result.strategy).toBe('fts_fallback')
    expect(result.fallbackReason).toBe('embedding_failed')
    expect(result.results[0]!.id).toBe('fallback')
    expect(JSON.stringify(result)).not.toContain('private query bytes')
  })
})

function chunk(
  id: string,
  text: string,
  source: HybridMemoryChunkInput['source'],
  overrides: Partial<HybridMemoryChunkInput> = {},
): HybridMemoryChunkInput {
  return {
    id,
    text,
    source,
    path: `${id}.md`,
    createdAt: NOW,
    ...overrides,
  }
}

function embeddingProvider(
  values: Record<string, number[]>,
): MemoryEmbeddingProvider {
  return {
    id: 'fixture-embeddings',
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => values[text] ?? [0, 0, 1])
    },
  }
}
