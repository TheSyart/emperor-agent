import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export type MemoryEvaluationCaseKind = 'factual' | 'stale' | 'project_scope'

export interface MemoryEvaluationCase {
  id: string
  kind: MemoryEvaluationCaseKind
  query: string
  expectedIds: string[]
  staleIds?: string[]
  forbiddenIds?: string[]
}

export interface MemoryEvaluationRetriever {
  id: string
  fallbackVerified: boolean
  derivedDiskBytes: number
  retrieve(input: {
    caseId: string
    query: string
    maxResults: number
  }): Promise<string[]>
}

export interface MemoryEvaluationMetrics {
  retrieverId: string
  factualHitRate: number
  staleViolationRate: number
  crossProjectPollutionRate: number
  p95LatencyMs: number
  derivedDiskBytes: number
  fallbackVerified: boolean
}

export interface HybridMemoryEvaluationReport {
  schemaVersion: 1
  datasetId: string
  datasetSha256: string
  caseCount: number
  baseline: MemoryEvaluationMetrics
  candidate: MemoryEvaluationMetrics
}

export interface HybridMemoryGateDecision {
  passed: boolean
  reasons: string[]
}

export async function evaluateHybridMemory(input: {
  datasetId: string
  cases: readonly MemoryEvaluationCase[]
  baseline: MemoryEvaluationRetriever
  candidate: MemoryEvaluationRetriever
  maxResults?: number
}): Promise<HybridMemoryEvaluationReport> {
  const cases = input.cases.map(normalizeCase)
  const maxResults = Math.min(
    50,
    Math.max(1, Math.trunc(Number(input.maxResults) || 6)),
  )
  return {
    schemaVersion: 1,
    datasetId: String(input.datasetId),
    datasetSha256: sha256(stableJson(cases)),
    caseCount: cases.length,
    baseline: await evaluateRetriever(input.baseline, cases, maxResults),
    candidate: await evaluateRetriever(input.candidate, cases, maxResults),
  }
}

export function decideHybridMemoryGate(
  report: HybridMemoryEvaluationReport,
): HybridMemoryGateDecision {
  const reasons: string[] = []
  if (report.candidate.factualHitRate <= report.baseline.factualHitRate)
    reasons.push('factual_hit_rate_not_improved')
  if (report.candidate.staleViolationRate >= report.baseline.staleViolationRate)
    reasons.push('stale_penalty_not_improved')
  if (
    report.candidate.crossProjectPollutionRate > 0 ||
    report.candidate.crossProjectPollutionRate >
      report.baseline.crossProjectPollutionRate
  )
    reasons.push('cross_project_pollution_regressed')
  if (!report.candidate.fallbackVerified)
    reasons.push('embedding_fallback_not_verified')
  return { passed: reasons.length === 0, reasons }
}

async function evaluateRetriever(
  retriever: MemoryEvaluationRetriever,
  cases: readonly MemoryEvaluationCase[],
  maxResults: number,
): Promise<MemoryEvaluationMetrics> {
  const latencies: number[] = []
  let factualHits = 0
  let staleViolations = 0
  let pollutionCases = 0
  const factual = cases.filter((item) => item.kind === 'factual')
  const stale = cases.filter((item) => item.kind === 'stale')
  const projectScope = cases.filter((item) => item.kind === 'project_scope')

  for (const item of cases) {
    const started = performance.now()
    const ids = (
      await retriever.retrieve({
        caseId: item.id,
        query: item.query,
        maxResults,
      })
    )
      .map((id) => String(id))
      .slice(0, maxResults)
    latencies.push(Math.max(0, performance.now() - started))
    if (
      item.kind === 'factual' &&
      item.expectedIds.some((id) => ids.includes(id))
    )
      factualHits += 1
    if (item.kind === 'stale' && staleBeforeExpected(ids, item))
      staleViolations += 1
    if (
      item.kind === 'project_scope' &&
      (item.forbiddenIds ?? []).some((id) => ids.includes(id))
    )
      pollutionCases += 1
  }

  return {
    retrieverId: String(retriever.id),
    factualHitRate: rate(factualHits, factual.length),
    staleViolationRate: rate(staleViolations, stale.length),
    crossProjectPollutionRate: rate(pollutionCases, projectScope.length),
    p95LatencyMs: percentile(latencies, 0.95),
    derivedDiskBytes: Math.max(
      0,
      Math.trunc(Number(retriever.derivedDiskBytes) || 0),
    ),
    fallbackVerified: retriever.fallbackVerified === true,
  }
}

function staleBeforeExpected(
  ids: readonly string[],
  item: MemoryEvaluationCase,
): boolean {
  const freshIndex = firstIndex(ids, item.expectedIds)
  const staleIndex = firstIndex(ids, item.staleIds ?? [])
  if (staleIndex < 0) return false
  return freshIndex < 0 || staleIndex < freshIndex
}

function firstIndex(
  ids: readonly string[],
  targets: readonly string[],
): number {
  let first = Number.POSITIVE_INFINITY
  for (const target of targets) {
    const index = ids.indexOf(target)
    if (index >= 0) first = Math.min(first, index)
  }
  return Number.isFinite(first) ? first : -1
}

function normalizeCase(item: MemoryEvaluationCase): MemoryEvaluationCase {
  return {
    id: String(item.id),
    kind: item.kind,
    query: String(item.query),
    expectedIds: uniqueStrings(item.expectedIds),
    staleIds: uniqueStrings(item.staleIds ?? []),
    forbiddenIds: uniqueStrings(item.forbiddenIds ?? []),
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => String(value)).filter(Boolean)),
  ].sort()
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function percentile(values: readonly number[], quantile: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  )
  return Number(sorted[index]!.toFixed(3))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
