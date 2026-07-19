import { describe, expect, it } from 'vitest'
import {
  decideHybridMemoryGate,
  evaluateHybridMemory,
  type MemoryEvaluationCase,
  type MemoryEvaluationRetriever,
} from './hybrid-eval'
import {
  HybridMemoryRetriever,
  type HybridMemoryChunkInput,
  type HybridMemorySearchScope,
  type MemoryEmbeddingProvider,
} from './hybrid-retrieval'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 19)
const PROVIDER_ID = 'emperor-eval-fixture-v1'

describe('Emperor hybrid memory bundled offline evaluation', () => {
  it('beats the lexical baseline without weakening project isolation and verifies fallback', async () => {
    const fixture = evaluationFixture()
    const candidateEngine = new HybridMemoryRetriever({
      embeddingProvider: fixture.provider,
      now: () => NOW,
      config: { temporalHalfLifeDays: 14 },
    })
    await candidateEngine.replace(fixture.chunks)
    const fallbackVerified = await verifyRealFtsFallback()
    const candidate: MemoryEvaluationRetriever = {
      id: 'hybrid-v1',
      fallbackVerified,
      derivedDiskBytes: Buffer.byteLength(JSON.stringify(fixture.chunks)),
      async retrieve(input) {
        const result = await candidateEngine.search({
          query: input.query,
          scope: fixture.scopes[input.caseId]!,
          maxResults: input.maxResults,
        })
        return result.results.map((item) => item.id)
      },
    }
    const baseline = naiveLexicalBaseline(fixture.chunks)

    const report = await evaluateHybridMemory({
      datasetId: 'emperor-hybrid-memory-eval-v1',
      cases: fixture.cases,
      baseline,
      candidate,
      maxResults: 4,
    })
    const decision = decideHybridMemoryGate(report)

    expect(report.caseCount).toBe(9)
    expect(report.baseline).toMatchObject({
      staleViolationRate: 1,
      crossProjectPollutionRate: 1,
      fallbackVerified: true,
    })
    expect(report.candidate).toMatchObject({
      factualHitRate: 1,
      staleViolationRate: 0,
      crossProjectPollutionRate: 0,
      fallbackVerified: true,
    })
    expect(report.candidate.factualHitRate).toBeGreaterThan(
      report.baseline.factualHitRate,
    )
    expect(report.candidate.p95LatencyMs).toBeLessThan(100)
    expect(report.candidate.derivedDiskBytes).toBeLessThan(64 * 1024)
    expect(report.datasetSha256).toBe(
      '15ba13ed75c42f7d0cb3966db279beff63d8505c7f0aec290af3ecfd0a51dd7a',
    )
    expect(decision).toEqual({ passed: true, reasons: [] })
  })
})

function evaluationFixture(): {
  chunks: HybridMemoryChunkInput[]
  cases: MemoryEvaluationCase[]
  scopes: Record<string, HybridMemorySearchScope>
  provider: MemoryEmbeddingProvider
} {
  const chunks: HybridMemoryChunkInput[] = [
    chunk('fact-db', 'PostgreSQL endpoint is db.internal:6543', 'global'),
    chunk('fact-cache', 'Redis host cache.internal uses port 6379', 'global'),
    chunk('fact-owner', 'Payments escalation contact is Lin Qiao', 'global'),
    chunk('stale-release', 'release channel is canary', 'session', {
      projectId: 'alpha',
      sessionId: 'session-a',
      createdAt: NOW - 180 * DAY,
    }),
    chunk('fresh-release', 'release channel is canary', 'session', {
      projectId: 'alpha',
      sessionId: 'session-a',
      createdAt: NOW - DAY,
    }),
    chunk('stale-runtime', 'runtime version is 18', 'session', {
      projectId: 'alpha',
      sessionId: 'session-a',
      createdAt: NOW - 120 * DAY,
    }),
    chunk('fresh-runtime', 'runtime version is 22', 'session', {
      projectId: 'alpha',
      sessionId: 'session-a',
      createdAt: NOW - DAY,
    }),
    chunk('stale-flag', 'feature omega is disabled', 'session', {
      projectId: 'alpha',
      sessionId: 'session-a',
      createdAt: NOW - 90 * DAY,
    }),
    chunk('fresh-flag', 'feature omega is enabled', 'session', {
      projectId: 'alpha',
      sessionId: 'session-a',
      createdAt: NOW - DAY,
    }),
    chunk('beta-region', 'deployment region eu-west-1', 'project', {
      projectId: 'beta',
    }),
    chunk('alpha-region', 'deployment region ap-southeast-1', 'project', {
      projectId: 'alpha',
    }),
    chunk('beta-secret', 'service token owner beta-vault', 'project', {
      projectId: 'beta',
    }),
    chunk('alpha-secret', 'service token owner alpha-vault', 'project', {
      projectId: 'alpha',
    }),
    chunk('beta-port', 'gateway port 9443', 'project', { projectId: 'beta' }),
    chunk('alpha-port', 'gateway port 8443', 'project', {
      projectId: 'alpha',
    }),
  ]
  const cases: MemoryEvaluationCase[] = [
    factual('fact-db-case', 'primary database location', 'fact-db'),
    factual('fact-cache-case', 'cache address', 'fact-cache'),
    factual('fact-owner-case', 'who owns payment incidents', 'fact-owner'),
    stale(
      'stale-release-case',
      'release channel canary',
      'fresh-release',
      'stale-release',
    ),
    stale(
      'stale-runtime-case',
      'runtime version',
      'fresh-runtime',
      'stale-runtime',
    ),
    stale('stale-flag-case', 'feature omega', 'fresh-flag', 'stale-flag'),
    scope(
      'scope-region-case',
      'deployment region',
      'alpha-region',
      'beta-region',
    ),
    scope(
      'scope-secret-case',
      'service token owner',
      'alpha-secret',
      'beta-secret',
    ),
    scope('scope-port-case', 'gateway port', 'alpha-port', 'beta-port'),
  ]
  const buildScope: HybridMemorySearchScope = {
    mode: 'build',
    projectId: 'alpha',
    sessionId: 'session-a',
  }
  const scopes = Object.fromEntries(
    cases.map((item) => [
      item.id,
      item.kind === 'factual'
        ? ({ mode: 'chat', sessionId: 'chat-a' } as const)
        : buildScope,
    ]),
  )
  const vectors = new Map<string, number[]>([
    ['primary database location', oneHot(0)],
    [chunks[0]!.text, oneHot(0)],
    ['cache address', oneHot(1)],
    [chunks[1]!.text, oneHot(1)],
    ['who owns payment incidents', oneHot(2)],
    [chunks[2]!.text, oneHot(2)],
  ])
  return {
    chunks,
    cases,
    scopes,
    provider: {
      id: PROVIDER_ID,
      dimensions: 8,
      async embed(texts) {
        return texts.map((text) => vectors.get(text)?.slice() ?? oneHot(7))
      },
    },
  }
}

function naiveLexicalBaseline(
  chunks: readonly HybridMemoryChunkInput[],
): MemoryEvaluationRetriever {
  return {
    id: 'naive-unscoped-fts',
    fallbackVerified: true,
    derivedDiskBytes: 0,
    async retrieve(input) {
      const query = new Set(tokens(input.query))
      return chunks
        .map((chunk, index) => ({
          id: chunk.id,
          index,
          score: tokens(chunk.text).filter((token) => query.has(token)).length,
        }))
        .filter((item) => item.score > 0)
        .sort(
          (left, right) => right.score - left.score || left.index - right.index,
        )
        .slice(0, input.maxResults)
        .map((item) => item.id)
    },
  }
}

async function verifyRealFtsFallback(): Promise<boolean> {
  const retriever = new HybridMemoryRetriever({
    embeddingProvider: {
      id: 'offline-failure-fixture',
      dimensions: 2,
      async embed() {
        throw new Error('offline embedding failure')
      },
    },
    now: () => NOW,
  })
  await retriever.replace([
    chunk('fallback-fact', 'fallback token FALLBACK-4417', 'global'),
  ])
  const result = await retriever.search({
    query: 'FALLBACK-4417',
    scope: { mode: 'chat', sessionId: 'fallback-session' },
  })
  return (
    result.strategy === 'fts_fallback' &&
    result.results[0]?.id === 'fallback-fact'
  )
}

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

function factual(
  id: string,
  query: string,
  expectedId: string,
): MemoryEvaluationCase {
  return { id, kind: 'factual', query, expectedIds: [expectedId] }
}

function stale(
  id: string,
  query: string,
  expectedId: string,
  staleId: string,
): MemoryEvaluationCase {
  return {
    id,
    kind: 'stale',
    query,
    expectedIds: [expectedId],
    staleIds: [staleId],
  }
}

function scope(
  id: string,
  query: string,
  expectedId: string,
  forbiddenId: string,
): MemoryEvaluationCase {
  return {
    id,
    kind: 'project_scope',
    query,
    expectedIds: [expectedId],
    forbiddenIds: [forbiddenId],
  }
}

function tokens(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}_]+/gu) ?? []
  )
}

function oneHot(index: number): number[] {
  return Array.from({ length: 8 }, (_, current) => (current === index ? 1 : 0))
}
