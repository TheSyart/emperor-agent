import type { ToolCallRequest } from '../providers/base'
import type { ToolResultObj } from '../tools/base'
import { redactSensitiveOutput } from '../util/redaction'

export interface TurnProgressSnapshot {
  readonly meaningfulProgress: number
  readonly successfulChanges: string[]
  readonly successfulEvidence: string[]
  readonly recentErrors: string[]
  readonly repeatedReadCount: number
  readonly noProgressIterations: number
  readonly lastIterationHadError: boolean
}

interface ReadCoverage {
  intervals: Array<readonly [start: number, end: number]>
  signatures: Map<string, string>
}

export class TurnProgressLedger {
  private readonly evidenceFingerprints = new Set<string>()
  private readonly changeFingerprints = new Set<string>()
  private readonly readCoverage = new Map<string, ReadCoverage>()
  private readonly successfulChanges: string[] = []
  private readonly successfulEvidence: string[] = []
  private readonly recentErrors: string[] = []
  private segmentProgress = 0
  private iterationProgress = false
  private repeatedReadCount = 0
  private noProgressIterations = 0
  private iterationHadError = false
  private lastIterationHadError = false

  recordToolResult(
    call: ToolCallRequest,
    result: ToolResultObj,
    opts: {
      readonly executed: boolean
      readonly readOnly: boolean
      readonly planPhase?: string | null
      readonly verificationEvidence?: boolean
    },
  ): void {
    if (!opts.executed || result.isError) {
      this.iterationHadError = true
      this.pushError(`${call.name}:${errorKind(result.summary)}`)
      return
    }
    const argumentsFingerprint = digest(stableJson(call.arguments))
    if (opts.planPhase === 'verifying') {
      if (!opts.verificationEvidence) return
      const evidenceFingerprint = digest(
        `verification:${call.name}:${argumentsFingerprint}:${result.summary}`,
      )
      if (this.evidenceFingerprints.has(evidenceFingerprint)) return
      this.evidenceFingerprints.add(evidenceFingerprint)
      this.pushUnique(
        this.successfulEvidence,
        toolProgressLabel(call, evidenceFingerprint),
      )
      this.markProgress()
      return
    }
    if (!opts.readOnly) {
      const changeFingerprint = digest(
        `${call.name}:${argumentsFingerprint}:${result.summary}`,
      )
      if (this.changeFingerprints.has(changeFingerprint)) return
      this.changeFingerprints.add(changeFingerprint)
      // A successful mutation may change any previously-read file version. The
      // next read therefore establishes fresh evidence instead of inheriting
      // stale line coverage from before the mutation.
      this.readCoverage.clear()
      this.pushUnique(
        this.successfulChanges,
        toolProgressLabel(call, changeFingerprint),
      )
      this.markProgress()
      return
    }
    if (call.name === 'read_file' && this.recordReadRange(call, result)) return
    const evidenceFingerprint = digest(
      `${call.name}:${argumentsFingerprint}:${result.summary}`,
    )
    if (this.evidenceFingerprints.has(evidenceFingerprint)) {
      this.repeatedReadCount += 1
      return
    }
    this.evidenceFingerprints.add(evidenceFingerprint)
    this.pushUnique(
      this.successfulEvidence,
      toolProgressLabel(call, evidenceFingerprint),
    )
    this.markProgress()
  }

  finishIteration(): void {
    if (this.iterationProgress) this.noProgressIterations = 0
    else this.noProgressIterations += 1
    this.iterationProgress = false
    this.lastIterationHadError = this.iterationHadError
    this.iterationHadError = false
  }

  snapshot(): TurnProgressSnapshot {
    return {
      meaningfulProgress: this.segmentProgress,
      successfulChanges: [...this.successfulChanges],
      successfulEvidence: [...this.successfulEvidence],
      recentErrors: [...this.recentErrors],
      repeatedReadCount: this.repeatedReadCount,
      noProgressIterations: this.noProgressIterations,
      lastIterationHadError: this.lastIterationHadError,
    }
  }

  private markProgress(): void {
    this.segmentProgress += 1
    this.iterationProgress = true
  }

  private recordReadRange(
    call: ToolCallRequest,
    result: ToolResultObj,
  ): boolean {
    const path = String(call.arguments.path ?? '').trim()
    if (!path) return false
    const offset = positiveInteger(call.arguments.offset, 1)
    const limit = positiveInteger(call.arguments.limit, 2_000)
    const end = offset + limit - 1
    const rangeKey = `${offset}:${end}`
    const signature = digest(result.rawContent || result.modelContent)
    let coverage = this.readCoverage.get(path)
    if (!coverage) {
      coverage = { intervals: [], signatures: new Map() }
      this.readCoverage.set(path, coverage)
    }

    const previousSignature = coverage.signatures.get(rangeKey)
    if (previousSignature && previousSignature !== signature) {
      // The same requested range now has different content, so the file
      // version changed outside a tracked mutation. Reset only this file.
      coverage.intervals = []
      coverage.signatures.clear()
    }
    coverage.signatures.set(rangeKey, signature)

    if (
      coverage.intervals.some(
        ([coveredStart, coveredEnd]) =>
          coveredStart <= offset && coveredEnd >= end,
      )
    ) {
      this.repeatedReadCount += 1
      return true
    }

    coverage.intervals = mergeIntervals(coverage.intervals, [offset, end])
    const evidenceFingerprint = digest(
      `${call.name}:${path}:${offset}:${end}:${signature}`,
    )
    this.evidenceFingerprints.add(evidenceFingerprint)
    this.pushUnique(
      this.successfulEvidence,
      toolProgressLabel(call, evidenceFingerprint),
    )
    this.markProgress()
    return true
  }

  private pushError(value: string): void {
    this.recentErrors.push(redactSensitiveOutput(value).slice(0, 240))
    if (this.recentErrors.length > 10) this.recentErrors.shift()
  }

  private pushUnique(target: string[], value: string): void {
    if (!target.includes(value)) target.push(value)
    if (target.length > 32) target.shift()
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function mergeIntervals(
  intervals: Array<readonly [number, number]>,
  next: readonly [number, number],
): Array<readonly [number, number]> {
  const ordered = [...intervals, next].sort((a, b) => a[0] - b[0])
  const merged: Array<readonly [number, number]> = []
  for (const current of ordered) {
    const previous = merged.at(-1)
    if (!previous || current[0] > previous[1] + 1) {
      merged.push(current)
      continue
    }
    merged[merged.length - 1] = [previous[0], Math.max(previous[1], current[1])]
  }
  return merged
}

function errorKind(value: string): string {
  const text = redactSensitiveOutput(String(value ?? 'error'))
    .split(/\r?\n/, 1)[0]
    ?.trim()
    .toLowerCase()
  if (!text) return 'error'
  if (text.includes('plan_todo_binding_rejected'))
    return 'plan_todo_binding_rejected'
  if (text.includes('schema')) return 'schema'
  if (text.includes('permission')) return 'permission'
  if (text.includes('timeout')) return 'timeout'
  if (text.includes('non-zero')) return 'non_zero'
  return digest(text)
}

function toolProgressLabel(call: ToolCallRequest, fingerprint: string): string {
  const targets = [
    'path',
    'file_path',
    'old_path',
    'new_path',
    'target',
    'destination',
    'command',
  ]
    .map((key) => call.arguments[key])
    .filter((value): value is string => typeof value === 'string' && !!value)
    .map((value) => redactSensitiveOutput(value).slice(0, 240))
  return targets.length
    ? `${call.name}:${targets.join(' -> ')}`
    : `${call.name}:${fingerprint}`
}

function digest(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}
