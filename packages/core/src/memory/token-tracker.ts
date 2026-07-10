/**
 * TokenTracker — 每调用 JSONL 账本 + 聚合 (MIG-MEM-004)。对齐 Python `agent/telemetry.py`。
 * should_compact 阈值 0.7；记 route_reason/model_role/fallback；token 估算口径见 README（记风险）。
 * 实现 runner 的 TokenTrackerLike。
 */
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { basename, dirname, join } from 'node:path'

const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_create'] as const
type Row = Record<string, unknown>

export interface RecordOptions {
  provider?: string | null
  usageType?: string
  modelRole?: string | null
  routeReason?: string | null
  usedFallback?: boolean
  fallbackReason?: string | null
  estimatedInputTokens?: number | null
  routeEstimatedTokens?: number | null
}

export class TokenTracker {
  readonly logFile: string
  readonly archiveDir: string
  readonly maxHotRows: number
  private lastInputTokens: number
  // 审计 P1-4：stats 类方法（totals/statsByDate/...）此前每次调用都重新读盘+解析
  // 全量日志。同一进程内缓存已解析的行，只有 record() 写入新行时才增量追加，
  // 避免仪表盘/诊断面板连续几次查询各自触发一遍全文件 IO。
  private cachedRows: Row[] | null = null

  constructor(logFile: string, opts: { maxHotRows?: number } = {}) {
    this.logFile = logFile
    this.archiveDir = join(dirname(logFile), 'tokens_archive')
    this.maxHotRows = Math.max(1, Math.trunc(opts.maxHotRows ?? 5000))
    mkdirSync(dirname(logFile), { recursive: true })
    this.rotateHotIfNeeded()
    this.lastInputTokens = this.loadLastInputTokens()
  }

  /** 兼容 runner 的 `record(model, usage, opts)`（snake/camel 选项均接受）。 */
  record(
    model: string,
    usage: Record<string, number> | null,
    opts: RecordOptions | Record<string, unknown> = {},
  ): void {
    const o = opts as Record<string, unknown>
    const usageType = String(o.usageType ?? o.usage_type ?? 'main_agent')
    const provider = (o.provider ?? null) as string | null
    const modelRole = (o.modelRole ?? o.model_role ?? null) as string | null
    const routeReason = (o.routeReason ?? o.route_reason ?? null) as
      string | null
    const usedFallback = Boolean(o.usedFallback ?? o.used_fallback ?? false)
    const fallbackReason = (o.fallbackReason ?? o.fallback_reason ?? null) as
      string | null
    const estimatedInputTokens = (o.estimatedInputTokens ??
      o.estimated_input_tokens ??
      null) as number | null
    const routeEstimatedTokens = (o.routeEstimatedTokens ??
      o.route_estimated_tokens ??
      null) as number | null

    const u = usage ?? {}
    const inputTokens = Number(u.input ?? u.prompt_tokens ?? 0) || 0
    const outputTokens = Number(u.output ?? u.completion_tokens ?? 0) || 0
    const cacheRead =
      Number(u.cache_read ?? u.cache_read_input_tokens ?? 0) || 0
    const cacheCreate =
      Number(u.cache_create ?? u.cache_creation_input_tokens ?? 0) || 0

    const row: Row = {
      ts: localIsoSeconds(),
      provider: provider || 'unknown',
      model,
      model_role: modelRole || 'unknown',
      usage_type: usageType,
      input: inputTokens,
      output: outputTokens,
      cache_read: cacheRead,
      cache_create: cacheCreate,
    }
    if (routeReason) row.route_reason = routeReason
    if (usedFallback) row.used_fallback = true
    if (fallbackReason) row.fallback_reason = fallbackReason
    if (estimatedInputTokens !== null && estimatedInputTokens !== undefined)
      row.estimated_input_tokens = estimatedInputTokens
    if (routeEstimatedTokens !== null && routeEstimatedTokens !== undefined)
      row.route_estimated_tokens = routeEstimatedTokens

    this.lastInputTokens =
      (row.input as number) +
      (row.cache_read as number) +
      (row.cache_create as number)
    appendFileSync(this.logFile, JSON.stringify(row) + '\n', 'utf8')
    if (this.cachedRows) this.cachedRows.push(row)
    this.rotateHotIfNeeded()
  }

  lastInputTokensValue(): number {
    return this.lastInputTokens
  }

  shouldCompact(maxContext: number, threshold = 0.7): boolean {
    return this.lastInputTokens > maxContext * threshold
  }

  private *iterRows(): Generator<Row> {
    yield* this.loadRows()
  }

  private loadRows(): Row[] {
    if (this.cachedRows) return this.cachedRows
    const rows: Row[] = []
    rows.push(...this.readArchiveRows())
    if (existsSync(this.logFile)) {
      rows.push(...readRowsFromText(readFileSync(this.logFile, 'utf8')))
    }
    this.cachedRows = rows
    return rows
  }

  private loadLastInputTokens(): number {
    let last: Row | null = null
    for (const row of this.iterRows()) last = row
    return inputTotal(last ?? {})
  }

  recentCalls(limit = 20): Row[] {
    if (limit <= 0) return []
    const rows = [...this.iterRows()].map(normalizeRow)
    return rows.slice(-limit).reverse()
  }

  recentCacheCalls(limit = 20): Row[] {
    if (limit <= 0) return []
    const rows = [...this.iterRows()]
      .map(normalizeRow)
      .filter(
        (row) =>
          (Number(row.cache_read) || 0) > 0 ||
          (Number(row.cache_create) || 0) > 0,
      )
    return rows.slice(-limit).reverse()
  }

  statsByDate(): Record<string, Row> {
    const out: Record<string, Row> = {}
    for (const r of this.iterRows()) {
      const date = String(r.ts ?? '').slice(0, 10)
      addRow((out[date] ??= emptyStats()), r)
    }
    return out
  }

  statsByModel(): Record<string, Row> {
    const out: Record<string, Row> = {}
    for (const r of this.iterRows()) {
      const m = String(r.model ?? 'unknown')
      addRow((out[m] ??= emptyStats()), r)
    }
    return out
  }

  statsByProviderModel(): Record<string, Row> {
    const out: Record<string, Row> = {}
    for (const r of this.iterRows()) {
      const provider = String(r.provider || 'unknown')
      const model = String(r.model || 'unknown')
      const key = provider !== 'unknown' ? `${provider}/${model}` : model
      const bucket = (out[key] ??= emptyStats())
      bucket.provider = provider
      bucket.model = model
      addRow(bucket, r)
    }
    return out
  }

  statsByUsageType(): Record<string, Row> {
    const out: Record<string, Row> = {}
    for (const r of this.iterRows()) {
      const usageType = String(r.usage_type ?? 'main_agent')
      addRow((out[usageType] ??= emptyStats()), r)
    }
    return out
  }

  totals(): Row {
    const out = emptyStats()
    for (const r of this.iterRows()) addRow(out, r)
    return out
  }

  statsByDateModel(): Record<string, Record<string, Row>> {
    const out: Record<string, Record<string, Row>> = {}
    for (const r of this.iterRows()) {
      const date = String(r.ts ?? '').slice(0, 10)
      if (!date) continue
      const provider = String(r.provider || 'unknown')
      const model = String(r.model || 'unknown')
      const key = provider !== 'unknown' ? `${provider}/${model}` : model
      const dateBucket = (out[date] ??= {})
      const bucket = (dateBucket[key] ??= emptyStats())
      bucket.provider = provider
      bucket.model = model
      addRow(bucket, r)
    }
    return out
  }

  statsByHour(): Record<string, Row> {
    const out: Record<string, Row> = {}
    for (let hour = 0; hour < 24; hour += 1)
      out[String(hour).padStart(2, '0')] = emptyStats()
    for (const r of this.iterRows()) {
      const hour = String(r.ts ?? '').slice(11, 13)
      const bucket = out[hour]
      if (!bucket) continue
      addRow(bucket, r)
    }
    return out
  }

  streakMetrics(): {
    active_days: number
    current_streak: number
    longest_streak: number
  } {
    const dates = [
      ...new Set(
        [...this.iterRows()]
          .map((r) => String(r.ts ?? '').slice(0, 10))
          .filter(Boolean),
      ),
    ].sort()
    if (!dates.length)
      return { active_days: 0, current_streak: 0, longest_streak: 0 }

    let longest = 1
    let current = 1
    for (let i = 1; i < dates.length; i += 1) {
      const gap = dateGapDays(dates[i - 1]!, dates[i]!)
      if (gap === 1) {
        current += 1
        longest = Math.max(longest, current)
      } else {
        current = 1
      }
    }

    const today = localDateString()
    let currentStreak = 0
    if (dates.at(-1) === today) {
      currentStreak = 1
      for (let i = dates.length - 1; i > 0; i -= 1) {
        if (dateGapDays(dates[i - 1]!, dates[i]!) !== 1) break
        currentStreak += 1
      }
    }
    return {
      active_days: dates.length,
      current_streak: currentStreak,
      longest_streak: longest,
    }
  }

  sessionCount(gapMinutes = 30): number {
    const timestamps = [...this.iterRows()]
      .map((row) => Date.parse(String(row.ts ?? '')))
      .filter((stamp) => Number.isFinite(stamp))
      .sort((a, b) => a - b)
    if (!timestamps.length) return 0
    let sessions = 1
    const gapMs = gapMinutes * 60 * 1000
    for (let i = 1; i < timestamps.length; i += 1) {
      if (timestamps[i]! - timestamps[i - 1]! > gapMs) sessions += 1
    }
    return sessions
  }

  private rotateHotIfNeeded(): void {
    const hotRows = existsSync(this.logFile)
      ? readRowsFromText(readFileSync(this.logFile, 'utf8'))
      : []
    if (hotRows.length <= this.maxHotRows) return
    const archiveRows = hotRows.slice(0, hotRows.length - this.maxHotRows)
    const keptRows = hotRows.slice(hotRows.length - this.maxHotRows)
    this.appendArchiveRows(archiveRows)
    this.writeHotRows(keptRows)
    this.cachedRows = null
  }

  private appendArchiveRows(rows: Row[]): void {
    if (!rows.length) return
    mkdirSync(this.archiveDir, { recursive: true })
    const grouped = new Map<string, Row[]>()
    for (const row of rows) {
      const month = archiveMonth(row)
      if (!grouped.has(month)) grouped.set(month, [])
      grouped.get(month)!.push(row)
    }
    for (const [month, items] of grouped) {
      const path = join(this.archiveDir, `${month}.jsonl.gz`)
      const body = items.map((row) => JSON.stringify(row) + '\n').join('')
      const chunk = gzipSync(Buffer.from(body, 'utf8'))
      if (existsSync(path)) appendFileSync(path, chunk)
      else writeFileSync(path, chunk)
    }
  }

  private writeHotRows(rows: Row[]): void {
    mkdirSync(dirname(this.logFile), { recursive: true })
    const tmp = join(
      dirname(this.logFile),
      `.${basename(this.logFile)}.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    writeFileSync(
      tmp,
      rows.map((row) => JSON.stringify(row) + '\n').join(''),
      'utf8',
    )
    renameSync(tmp, this.logFile)
  }

  private readArchiveRows(): Row[] {
    if (!existsSync(this.archiveDir)) return []
    const rows: Row[] = []
    for (const name of readdirSync(this.archiveDir)
      .filter((item) => item.endsWith('.jsonl.gz'))
      .sort()) {
      try {
        rows.push(
          ...readRowsFromText(
            gunzipSync(readFileSync(join(this.archiveDir, name))).toString(
              'utf8',
            ),
          ),
        )
      } catch {
        continue
      }
    }
    return rows
  }
}

function readRowsFromText(text: string): Row[] {
  const rows: Row[] = []
  for (let line of text.split('\n')) {
    line = line.trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        rows.push(parsed as Row)
    } catch {
      continue
    }
  }
  return rows
}

function emptyStats(): Row {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_create: 0,
    total: 0,
  }
}

function addRow(bucket: Row, row: Row): void {
  bucket.calls = (Number(bucket.calls) || 0) + 1
  let total = 0
  for (const key of TOKEN_KEYS) {
    const value = Number(row[key]) || 0
    bucket[key] = (Number(bucket[key]) || 0) + value
    total += value
  }
  bucket.total = (Number(bucket.total) || 0) + total
}

function normalizeRow(row: Row): Row {
  const inputTokens = rowInt(row, 'input', 'prompt_tokens')
  const outputTokens = rowInt(row, 'output', 'completion_tokens')
  const cacheRead = rowInt(row, 'cache_read', 'cache_read_input_tokens')
  const cacheCreate = rowInt(row, 'cache_create', 'cache_creation_input_tokens')
  const normalized: Row = {
    ts: String(row.ts ?? ''),
    provider: String(row.provider ?? 'unknown'),
    model: String(row.model ?? 'unknown'),
    model_role: String(row.model_role ?? 'unknown'),
    usage_type: String(row.usage_type ?? 'main_agent'),
    input: inputTokens,
    output: outputTokens,
    cache_read: cacheRead,
    cache_create: cacheCreate,
    total: inputTokens + outputTokens + cacheRead + cacheCreate,
  }
  for (const key of ['route_reason', 'fallback_reason']) {
    if (row[key]) normalized[key] = String(row[key])
  }
  for (const key of ['estimated_input_tokens', 'route_estimated_tokens']) {
    if (row[key] !== null && row[key] !== undefined)
      normalized[key] = rowInt(row, key)
  }
  if (row.used_fallback) normalized.used_fallback = true
  return normalized
}

function rowInt(row: Row, ...keys: string[]): number {
  for (const key of keys) {
    if (key in row) {
      const n = Number(row[key])
      return Number.isFinite(n) ? Math.trunc(n) : 0
    }
  }
  return 0
}

function inputTotal(row: Row): number {
  return (
    rowInt(row, 'input', 'prompt_tokens') +
    rowInt(row, 'cache_read', 'cache_read_input_tokens') +
    rowInt(row, 'cache_create', 'cache_creation_input_tokens')
  )
}

function archiveMonth(row: Row): string {
  const ts = String(row.ts ?? '')
  if (/^\d{4}-\d{2}/.test(ts)) return ts.slice(0, 7)
  return localDateString().slice(0, 7)
}

function dateGapDays(prev: string, curr: string): number {
  const a = Date.parse(`${prev}T00:00:00`)
  const b = Date.parse(`${curr}T00:00:00`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 99
  return Math.trunc((b - a) / 86_400_000)
}

function localDateString(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 本地时区 ISO（秒）。对齐 Python datetime.now().isoformat(timespec="seconds")。 */
function localIsoSeconds(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
