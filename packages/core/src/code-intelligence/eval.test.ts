import { describe, expect, it } from 'vitest'
import {
  decideCodeIntelligenceGate,
  normalizeCodeIntelligenceEvaluationReport,
  type CodeIntelligenceEvaluationReport,
} from './eval'

describe('code intelligence benchmark gate', () => {
  it('exposes a fail-closed assertion for the executable evaluation gate', async () => {
    const module = await import('./eval')
    const assertPassed = (
      module as typeof module & {
        assertCodeIntelligenceGatePassed?: (
          decision: ReturnType<typeof decideCodeIntelligenceGate>,
        ) => void
      }
    ).assertCodeIntelligenceGatePassed

    expect(typeof assertPassed).toBe('function')
    expect(() =>
      assertPassed?.(
        decideCodeIntelligenceGate(fixtureReport({ indexedFiles: 99 })),
      ),
    ).toThrowError(
      'code intelligence evaluation gate failed: dataset_too_small',
    )
  })

  it('passes only when incremental/query speed, resource, snapshot, size and fallback gates all pass', () => {
    const report = fixtureReport()

    expect(decideCodeIntelligenceGate(report)).toEqual({
      passed: true,
      reasons: [],
    })
    expect(normalizeCodeIntelligenceEvaluationReport(report)).toEqual(report)
  })

  it('reports every failed gate in deterministic order', () => {
    const report = fixtureReport({
      indexedFiles: 99,
      incrementalP95Ms: 30,
      fullRebuildP95Ms: 100,
      indexedQueryP95Ms: 12,
      diskScanQueryP95Ms: 50,
      rssDeltaBytes: 257 * 1024 * 1024,
      incrementalRssGrowthBytes: 33 * 1024 * 1024,
      cacheBytes: 20_001,
      sourceBytes: 20_000,
      oversizedFileGateVerified: false,
      snapshotIsolationVerified: false,
      fallbackVerified: false,
    })

    expect(decideCodeIntelligenceGate(report)).toEqual({
      passed: false,
      reasons: [
        'dataset_too_small',
        'incremental_speedup_insufficient',
        'query_speedup_insufficient',
        'rss_budget_exceeded',
        'incremental_rss_budget_exceeded',
        'cache_larger_than_sources',
        'oversized_file_gate_not_verified',
        'snapshot_isolation_not_verified',
        'fallback_not_verified',
      ],
    })
  })

  it('fails closed for non-finite metrics and invalid identity fields', () => {
    const report = fixtureReport({
      datasetSha256: 'not-a-sha',
      parserRevision: '',
      coldBuildMs: Number.NaN,
      incrementalP95Ms: Number.POSITIVE_INFINITY,
    })
    const normalized = normalizeCodeIntelligenceEvaluationReport(report)

    expect(normalized.datasetSha256).toBe('')
    expect(normalized.parserRevision).toBe('')
    expect(normalized.coldBuildMs).toBe(-1)
    expect(normalized.incrementalP95Ms).toBe(-1)
    expect(decideCodeIntelligenceGate(report)).toEqual({
      passed: false,
      reasons: ['report_invalid'],
    })
  })
})

function fixtureReport(
  overrides: Partial<CodeIntelligenceEvaluationReport> = {},
): CodeIntelligenceEvaluationReport {
  return {
    schemaVersion: 1,
    datasetId: 'emperor-code-intelligence-eval-v1',
    datasetSha256: 'a'.repeat(64),
    parserRevision: 'typescript-5.9-code-graph-v1',
    indexedFiles: 1000,
    skippedOversized: 1,
    sourceBytes: 20_000,
    cacheBytes: 10_000,
    coldBuildMs: 500,
    incrementalP95Ms: 10,
    fullRebuildP95Ms: 100,
    indexedQueryP95Ms: 2,
    diskScanQueryP95Ms: 20,
    rssDeltaBytes: 64 * 1024 * 1024,
    incrementalRssGrowthBytes: 8 * 1024 * 1024,
    oversizedFileGateVerified: true,
    snapshotIsolationVerified: true,
    fallbackVerified: true,
    ...overrides,
  }
}
