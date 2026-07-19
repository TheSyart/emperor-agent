import { describe, expect, it } from 'vitest'
import {
  decideHybridMemoryGate,
  evaluateHybridMemory,
  type MemoryEvaluationCase,
  type MemoryEvaluationRetriever,
} from './hybrid-eval'

describe('hybrid memory offline evaluation gate', () => {
  it('requires factual lift, stale improvement, zero project pollution, and FTS fallback', async () => {
    const cases: MemoryEvaluationCase[] = [
      {
        id: 'fact-1',
        kind: 'factual',
        query: 'database endpoint',
        expectedIds: ['fresh-db'],
      },
      {
        id: 'stale-1',
        kind: 'stale',
        query: 'release channel',
        expectedIds: ['fresh-release'],
        staleIds: ['old-release'],
      },
      {
        id: 'scope-1',
        kind: 'project_scope',
        query: 'deployment region',
        expectedIds: ['alpha-region'],
        forbiddenIds: ['beta-region'],
      },
    ]
    const baseline = fixtureRetriever({
      'fact-1': ['irrelevant'],
      'stale-1': ['old-release', 'fresh-release'],
      'scope-1': ['beta-region', 'alpha-region'],
    })
    const candidate = fixtureRetriever(
      {
        'fact-1': ['fresh-db'],
        'stale-1': ['fresh-release', 'old-release'],
        'scope-1': ['alpha-region'],
      },
      { fallbackVerified: true, derivedDiskBytes: 4096 },
    )

    const report = await evaluateHybridMemory({
      datasetId: 'emperor-hybrid-memory-eval-v1',
      cases,
      baseline,
      candidate,
      maxResults: 3,
    })
    const decision = decideHybridMemoryGate(report)

    expect(report.baseline).toMatchObject({
      factualHitRate: 0,
      staleViolationRate: 1,
      crossProjectPollutionRate: 1,
    })
    expect(report.candidate).toMatchObject({
      factualHitRate: 1,
      staleViolationRate: 0,
      crossProjectPollutionRate: 0,
      fallbackVerified: true,
      derivedDiskBytes: 4096,
    })
    expect(report.datasetSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(decision).toEqual({ passed: true, reasons: [] })
  })

  it('keeps the capability disabled when any safety or quality threshold regresses', async () => {
    const cases: MemoryEvaluationCase[] = [
      {
        id: 'scope',
        kind: 'project_scope',
        query: 'secret',
        expectedIds: ['alpha'],
        forbiddenIds: ['beta'],
      },
    ]
    const baseline = fixtureRetriever({ scope: ['alpha'] })
    const candidate = fixtureRetriever(
      { scope: ['beta'] },
      { fallbackVerified: false },
    )

    const decision = decideHybridMemoryGate(
      await evaluateHybridMemory({
        datasetId: 'unsafe-fixture',
        cases,
        baseline,
        candidate,
      }),
    )

    expect(decision.passed).toBe(false)
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        'factual_hit_rate_not_improved',
        'cross_project_pollution_regressed',
        'embedding_fallback_not_verified',
      ]),
    )
  })
})

function fixtureRetriever(
  byCase: Record<string, string[]>,
  metadata: {
    fallbackVerified?: boolean
    derivedDiskBytes?: number
  } = {},
): MemoryEvaluationRetriever {
  return {
    id: 'fixture',
    fallbackVerified: metadata.fallbackVerified ?? false,
    derivedDiskBytes: metadata.derivedDiskBytes ?? 0,
    async retrieve(input) {
      return byCase[input.caseId] ?? []
    },
  }
}
