export interface CodeIntelligenceEvaluationReport {
  schemaVersion: 1
  datasetId: string
  datasetSha256: string
  parserRevision: string
  indexedFiles: number
  skippedOversized: number
  sourceBytes: number
  cacheBytes: number
  coldBuildMs: number
  incrementalP95Ms: number
  fullRebuildP95Ms: number
  indexedQueryP95Ms: number
  diskScanQueryP95Ms: number
  rssDeltaBytes: number
  incrementalRssGrowthBytes: number
  oversizedFileGateVerified: boolean
  snapshotIsolationVerified: boolean
  fallbackVerified: boolean
}

export interface CodeIntelligenceGateDecision {
  passed: boolean
  reasons: string[]
}

const MAX_RSS_DELTA_BYTES = 256 * 1024 * 1024
const MAX_INCREMENTAL_RSS_GROWTH_BYTES = 32 * 1024 * 1024
const MAX_SPEED_RATIO = 0.2

export function normalizeCodeIntelligenceEvaluationReport(
  report: CodeIntelligenceEvaluationReport,
): CodeIntelligenceEvaluationReport {
  return {
    schemaVersion: 1,
    datasetId: String(report.datasetId ?? '').trim(),
    datasetSha256: validSha256(report.datasetSha256),
    parserRevision: String(report.parserRevision ?? '').trim(),
    indexedFiles: integerMetric(report.indexedFiles),
    skippedOversized: integerMetric(report.skippedOversized),
    sourceBytes: integerMetric(report.sourceBytes),
    cacheBytes: integerMetric(report.cacheBytes),
    coldBuildMs: finiteMetric(report.coldBuildMs),
    incrementalP95Ms: finiteMetric(report.incrementalP95Ms),
    fullRebuildP95Ms: finiteMetric(report.fullRebuildP95Ms),
    indexedQueryP95Ms: finiteMetric(report.indexedQueryP95Ms),
    diskScanQueryP95Ms: finiteMetric(report.diskScanQueryP95Ms),
    rssDeltaBytes: integerMetric(report.rssDeltaBytes),
    incrementalRssGrowthBytes: integerMetric(report.incrementalRssGrowthBytes),
    oversizedFileGateVerified: report.oversizedFileGateVerified === true,
    snapshotIsolationVerified: report.snapshotIsolationVerified === true,
    fallbackVerified: report.fallbackVerified === true,
  }
}

export function decideCodeIntelligenceGate(
  input: CodeIntelligenceEvaluationReport,
): CodeIntelligenceGateDecision {
  const report = normalizeCodeIntelligenceEvaluationReport(input)
  if (!validReport(report))
    return { passed: false, reasons: ['report_invalid'] }
  const reasons: string[] = []
  if (report.indexedFiles < 100) reasons.push('dataset_too_small')
  if (report.incrementalP95Ms / report.fullRebuildP95Ms >= MAX_SPEED_RATIO)
    reasons.push('incremental_speedup_insufficient')
  if (report.indexedQueryP95Ms / report.diskScanQueryP95Ms >= MAX_SPEED_RATIO)
    reasons.push('query_speedup_insufficient')
  if (report.rssDeltaBytes > MAX_RSS_DELTA_BYTES)
    reasons.push('rss_budget_exceeded')
  if (report.incrementalRssGrowthBytes > MAX_INCREMENTAL_RSS_GROWTH_BYTES)
    reasons.push('incremental_rss_budget_exceeded')
  if (report.cacheBytes > report.sourceBytes)
    reasons.push('cache_larger_than_sources')
  if (!report.oversizedFileGateVerified)
    reasons.push('oversized_file_gate_not_verified')
  if (!report.snapshotIsolationVerified)
    reasons.push('snapshot_isolation_not_verified')
  if (!report.fallbackVerified) reasons.push('fallback_not_verified')
  return { passed: reasons.length === 0, reasons }
}

export function assertCodeIntelligenceGatePassed(
  decision: CodeIntelligenceGateDecision,
): void {
  if (decision.passed && decision.reasons.length === 0) return
  const reasons = decision.reasons.length
    ? decision.reasons.join(',')
    : 'decision_not_passed'
  throw new Error(`code intelligence evaluation gate failed: ${reasons}`)
}

function validReport(report: CodeIntelligenceEvaluationReport): boolean {
  return Boolean(
    report.datasetId &&
    report.datasetSha256 &&
    report.parserRevision &&
    report.sourceBytes > 0 &&
    report.fullRebuildP95Ms > 0 &&
    report.diskScanQueryP95Ms > 0 &&
    Object.values(report).every(
      (value) => typeof value !== 'number' || value >= 0,
    ),
  )
}

function validSha256(value: unknown): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : ''
}

function integerMetric(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : -1
}

function finiteMetric(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : -1
}
