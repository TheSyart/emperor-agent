/**
 * TokenTracker — 每调用 JSONL 账本 + 聚合。
 * should_compact 阈值 0.7；新记录使用 model_entry_id，旧 role/fallback 字段只读兼容。
 * 实现 runner 的 TokenTrackerLike。
 *
 * 计数互不重叠（CORE-18）：input 不含缓存读写，output 不含 reasoning；
 * total = input + output + cache_read + cache_create + reasoning。旧字段名
 * （prompt_tokens 含缓存命中、prompt_cache_hit_tokens、completion_tokens、
 * cache_*_input_tokens）读写时都换算成这五项。
 *
 * 增长（KRN-12，CORE-37）：record() 只追加一行；热文件行数在内存里计数，
 * 超过 maxHotRows（5000）时把最旧的行按月归档，留下 maxHotRows − ⌊maxHotRows/5⌋
 * （4000）行，下一次轮转要再等 1000 行。统计读的是内存里的聚合，不再保留或重读
 * 每一行；最近调用只留最后 RECENT_KEEP 行。
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

const TOKEN_KEYS = [
  'input',
  'output',
  'cache_read',
  'cache_create',
  'reasoning',
] as const
type Row = Record<string, unknown>
type TokenCounts = Record<(typeof TOKEN_KEYS)[number], number>

export interface TokenStatsRow {
  input?: number
  output?: number
  cache_read?: number
  cache_create?: number
  reasoning?: number
  total?: number
  calls?: number
  provider?: string
  model?: string
  cost_usd_nanos?: number
  cost_complete_calls?: number
  cost_incomplete_calls?: number
  cost_is_partial?: boolean
  [key: string]: number | string | boolean | undefined
}

export interface TokenUsageRow {
  ts: string
  provider: string
  model: string
  model_entry_id: string
  /** 旧账本读取兼容；record() 不再写入。 */
  model_role?: string
  usage_type: string
  input: number
  output: number
  cache_read: number
  cache_create: number
  /** Present when the call reported reasoning tokens (not part of `output`). */
  reasoning?: number
  total: number
  route_reason?: string
  used_fallback?: boolean
  fallback_reason?: string
  cost_usd_nanos?: number
  cost_cap_usd_nanos?: number
  cost_complete?: boolean
  estimated_input_tokens?: number
  route_estimated_tokens?: number
  [key: string]: string | number | boolean | undefined
}

export interface RecordOptions {
  provider?: string | null
  usageType?: string
  modelEntryId?: string | null
  routeReason?: string | null
  estimatedInputTokens?: number | null
  routeEstimatedTokens?: number | null
  /** Cost of the call in USD; null: the price is unknown (recorded as incomplete). */
  costUsd?: number | null
  costUsdNanos?: number | null
  costCapUsdNanos?: number | null
  costComplete?: boolean | null
  usedFallback?: boolean
  fallbackReason?: string | null
}

/** Rows kept for recentCalls / recentCacheCalls without reading the ledger. */
const RECENT_KEEP = 200

export class TokenTracker {
  readonly logFile: string
  readonly archiveDir: string
  readonly maxHotRows: number
  /** Rows left in the hot file after a rotation (hysteresis). */
  readonly keepHotRows: number
  private lastInputTokens: number
  /** Rows in the hot file, counted once and then kept current. */
  private hotRows = 0
  // 审计 P1-4 / KRN-12：统计读内存里的聚合，账本只在构造时读一次。
  private readonly aggregate = new LedgerAggregate()

  constructor(logFile: string, opts: { maxHotRows?: number } = {}) {
    this.logFile = logFile
    this.archiveDir = join(dirname(logFile), 'tokens_archive')
    this.maxHotRows = Math.max(1, Math.trunc(opts.maxHotRows ?? 5000))
    this.keepHotRows = Math.max(
      1,
      this.maxHotRows - Math.floor(this.maxHotRows / 5),
    )
    mkdirSync(dirname(logFile), { recursive: true })
    for (const row of this.readArchiveRows()) this.aggregate.add(row)
    const hot = this.readHotRows()
    for (const row of hot) this.aggregate.add(row)
    this.hotRows = hot.length
    if (this.hotRows > this.maxHotRows) this.rotate(hot)
    this.lastInputTokens = inputTotal(this.aggregate.last ?? {})
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
    const modelEntryId = (o.modelEntryId ?? o.model_entry_id ?? null) as
      string | null
    const routeReason = (o.routeReason ?? o.route_reason ?? null) as
      string | null
    const estimatedInputTokens = (o.estimatedInputTokens ??
      o.estimated_input_tokens ??
      null) as number | null
    const routeEstimatedTokens = (o.routeEstimatedTokens ??
      o.route_estimated_tokens ??
      null) as number | null
    const costUsd = 'costUsd' in o ? o.costUsd : o.cost_usd
    const costUsdNanos =
      costUsd === null || costUsd === undefined
        ? optionalNonNegativeInt(o.costUsdNanos ?? o.cost_usd_nanos)
        : optionalNonNegativeInt(Math.round(Number(costUsd) * 1e9))
    const costCapUsdNanos = optionalNonNegativeInt(
      o.costCapUsdNanos ?? o.cost_cap_usd_nanos,
    )
    const costComplete =
      costUsd === null
        ? false
        : costUsd !== undefined && costUsdNanos !== null
          ? true
          : (o.costComplete ?? o.cost_complete)
    const usedFallback = Boolean(o.usedFallback ?? o.used_fallback ?? false)
    const fallbackReason = String(
      o.fallbackReason ?? o.fallback_reason ?? '',
    ).trim()

    const counts = tokenCounts(usage ?? {})

    const row: Row = {
      ts: localIsoSeconds(),
      provider: provider || 'unknown',
      model,
      model_entry_id: modelEntryId || 'unknown',
      usage_type: usageType,
      input: counts.input,
      output: counts.output,
      cache_read: counts.cache_read,
      cache_create: counts.cache_create,
    }
    if (counts.reasoning > 0) row.reasoning = counts.reasoning
    if (routeReason) row.route_reason = routeReason
    if (estimatedInputTokens !== null && estimatedInputTokens !== undefined)
      row.estimated_input_tokens = estimatedInputTokens
    if (routeEstimatedTokens !== null && routeEstimatedTokens !== undefined)
      row.route_estimated_tokens = routeEstimatedTokens
    if (costUsdNanos !== null) row.cost_usd_nanos = costUsdNanos
    if (costCapUsdNanos !== null) row.cost_cap_usd_nanos = costCapUsdNanos
    if (typeof costComplete === 'boolean') row.cost_complete = costComplete
    if (usedFallback) row.used_fallback = true
    if (fallbackReason) row.fallback_reason = fallbackReason

    this.lastInputTokens =
      (row.input as number) +
      (row.cache_read as number) +
      (row.cache_create as number)
    appendFileSync(this.logFile, JSON.stringify(row) + '\n', 'utf8')
    this.aggregate.add(row)
    this.hotRows += 1
    if (this.hotRows > this.maxHotRows) this.rotate()
  }

  lastInputTokensValue(): number {
    return this.lastInputTokens
  }

  shouldCompact(maxContext: number, threshold = 0.7): boolean {
    return this.lastInputTokens > maxContext * threshold
  }

  /** Every row, archive then hot (only for a recent list longer than RECENT_KEEP). */
  private readAllRows(): Row[] {
    return [...this.readArchiveRows(), ...this.readHotRows()]
  }

  private readHotRows(): Row[] {
    return existsSync(this.logFile)
      ? readRowsFromText(readFileSync(this.logFile, 'utf8'))
      : []
  }

  recentCalls(limit = 20): TokenUsageRow[] {
    if (limit <= 0) return []
    const kept = this.aggregate.recent
    const rows =
      limit <= kept.length || this.aggregate.rows <= kept.length
        ? kept
        : this.readAllRows()
    return rows.slice(-limit).map(normalizeRow).reverse()
  }

  recentCacheCalls(limit = 20): TokenUsageRow[] {
    if (limit <= 0) return []
    const kept = this.aggregate.recentCache
    const rows =
      limit <= kept.length || this.aggregate.cacheRows <= kept.length
        ? kept
        : this.readAllRows().filter(isCacheRow)
    return rows.slice(-limit).map(normalizeRow).reverse()
  }

  statsByDate(): Record<string, TokenStatsRow> {
    return cloneBuckets(this.aggregate.byDate)
  }

  statsByModel(): Record<string, TokenStatsRow> {
    return cloneBuckets(this.aggregate.byModel)
  }

  statsByProviderModel(): Record<string, TokenStatsRow> {
    return cloneBuckets(this.aggregate.byProviderModel)
  }

  statsByUsageType(): Record<string, TokenStatsRow> {
    return cloneBuckets(this.aggregate.byUsageType)
  }

  totals(): TokenStatsRow {
    return { ...this.aggregate.totals }
  }

  statsByDateModel(): Record<string, Record<string, TokenStatsRow>> {
    const out: Record<string, Record<string, TokenStatsRow>> = {}
    for (const [date, buckets] of Object.entries(this.aggregate.byDateModel))
      out[date] = cloneBuckets(buckets)
    return out
  }

  statsByHour(): Record<string, TokenStatsRow> {
    return cloneBuckets(this.aggregate.byHour)
  }

  streakMetrics(): {
    active_days: number
    current_streak: number
    longest_streak: number
  } {
    const dates = [...this.aggregate.dates].sort()
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
    const timestamps = this.aggregate.sortedTimestamps()
    if (!timestamps.length) return 0
    let sessions = 1
    const gapMs = gapMinutes * 60 * 1000
    for (let i = 1; i < timestamps.length; i += 1) {
      if (timestamps[i]! - timestamps[i - 1]! > gapMs) sessions += 1
    }
    return sessions
  }

  /**
   * Move the oldest hot rows to the monthly archive and keep `keepHotRows`.
   * Reads the hot file once per rotation (every maxHotRows − keepHotRows
   * records); the aggregate does not change, the rows only move.
   */
  private rotate(rows: Row[] = this.readHotRows()): void {
    if (rows.length <= this.maxHotRows) {
      this.hotRows = rows.length
      return
    }
    const cut = rows.length - this.keepHotRows
    this.appendArchiveRows(rows.slice(0, cut))
    this.writeHotRows(rows.slice(cut))
    this.hotRows = rows.length - cut
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

/**
 * Everything the stats read, folded one row at a time (KRN-12): the same
 * buckets the old full scans produced, plus the last RECENT_KEEP rows.
 */
class LedgerAggregate {
  rows = 0
  cacheRows = 0
  last: Row | null = null
  readonly totals = emptyStats()
  readonly byDate: Record<string, TokenStatsRow> = {}
  readonly byModel: Record<string, TokenStatsRow> = {}
  readonly byProviderModel: Record<string, TokenStatsRow> = {}
  readonly byUsageType: Record<string, TokenStatsRow> = {}
  readonly byDateModel: Record<string, Record<string, TokenStatsRow>> = {}
  readonly byHour: Record<string, TokenStatsRow> = {}
  readonly dates = new Set<string>()
  readonly recent: Row[] = []
  readonly recentCache: Row[] = []
  private readonly timestamps: number[] = []
  private timestampsSorted = true

  constructor() {
    for (let hour = 0; hour < 24; hour += 1)
      this.byHour[String(hour).padStart(2, '0')] = emptyStats()
  }

  add(r: Row): void {
    this.rows += 1
    this.last = r
    addRow(this.totals, r)
    const ts = String(r.ts ?? '')
    const date = ts.slice(0, 10)
    addRow((this.byDate[date] ??= emptyStats()), r)
    addRow((this.byModel[String(r.model ?? 'unknown')] ??= emptyStats()), r)
    const provider = String(r.provider || 'unknown')
    const model = String(r.model || 'unknown')
    const key = provider !== 'unknown' ? `${provider}/${model}` : model
    const providerModel = (this.byProviderModel[key] ??= emptyStats())
    providerModel.provider = provider
    providerModel.model = model
    addRow(providerModel, r)
    addRow(
      (this.byUsageType[String(r.usage_type ?? 'main_agent')] ??=
        emptyStats()),
      r,
    )
    if (date) {
      const dateModel = ((this.byDateModel[date] ??= {})[key] ??= emptyStats())
      dateModel.provider = provider
      dateModel.model = model
      addRow(dateModel, r)
      this.dates.add(date)
    }
    const hour = this.byHour[ts.slice(11, 13)]
    if (hour) addRow(hour, r)
    const stamp = Date.parse(ts)
    if (Number.isFinite(stamp)) {
      const previous = this.timestamps.at(-1)
      if (previous !== undefined && stamp < previous)
        this.timestampsSorted = false
      this.timestamps.push(stamp)
    }
    keepLast(this.recent, r)
    if (isCacheRow(r)) {
      this.cacheRows += 1
      keepLast(this.recentCache, r)
    }
  }

  sortedTimestamps(): readonly number[] {
    if (!this.timestampsSorted) {
      this.timestamps.sort((a, b) => a - b)
      this.timestampsSorted = true
    }
    return this.timestamps
  }
}

function keepLast(rows: Row[], row: Row): void {
  rows.push(row)
  if (rows.length > RECENT_KEEP) rows.splice(0, rows.length - RECENT_KEEP)
}

function isCacheRow(row: Row): boolean {
  const counts = tokenCounts(row)
  return counts.cache_read > 0 || counts.cache_create > 0
}

function cloneBuckets(
  buckets: Record<string, TokenStatsRow>,
): Record<string, TokenStatsRow> {
  const out: Record<string, TokenStatsRow> = {}
  for (const [key, bucket] of Object.entries(buckets)) out[key] = { ...bucket }
  return out
}

function emptyStats(): TokenStatsRow {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_create: 0,
    reasoning: 0,
    total: 0,
    cost_usd_nanos: 0,
    cost_complete_calls: 0,
    cost_incomplete_calls: 0,
    cost_is_partial: false,
  }
}

function addRow(bucket: TokenStatsRow, row: Row): void {
  bucket.calls = (Number(bucket.calls) || 0) + 1
  const counts = tokenCounts(row)
  let total = 0
  for (const key of TOKEN_KEYS) {
    const value = counts[key]
    bucket[key] = (Number(bucket[key]) || 0) + value
    total += value
  }
  bucket.total = (Number(bucket.total) || 0) + total
  if ('cost_usd_nanos' in row)
    bucket.cost_usd_nanos =
      (Number(bucket.cost_usd_nanos) || 0) + rowInt(row, 'cost_usd_nanos')
  if (row.cost_complete === true)
    bucket.cost_complete_calls = (Number(bucket.cost_complete_calls) || 0) + 1
  else if (row.cost_complete === false)
    bucket.cost_incomplete_calls =
      (Number(bucket.cost_incomplete_calls) || 0) + 1
  bucket.cost_is_partial = (Number(bucket.cost_incomplete_calls) || 0) > 0
}

function normalizeRow(row: Row): TokenUsageRow {
  const counts = tokenCounts(row)
  const normalized: TokenUsageRow = {
    ts: String(row.ts ?? ''),
    provider: String(row.provider ?? 'unknown'),
    model: String(row.model ?? 'unknown'),
    model_entry_id: String(row.model_entry_id ?? 'unknown'),
    usage_type: String(row.usage_type ?? 'main_agent'),
    input: counts.input,
    output: counts.output,
    cache_read: counts.cache_read,
    cache_create: counts.cache_create,
    ...(counts.reasoning > 0 ? { reasoning: counts.reasoning } : {}),
    total: TOKEN_KEYS.reduce((sum, key) => sum + counts[key], 0),
  }
  if (row.model_role) normalized.model_role = String(row.model_role)
  for (const key of ['route_reason', 'fallback_reason']) {
    if (row[key]) normalized[key] = String(row[key])
  }
  for (const key of ['estimated_input_tokens', 'route_estimated_tokens']) {
    if (row[key] !== null && row[key] !== undefined)
      normalized[key] = rowInt(row, key)
  }
  if (row.used_fallback) normalized.used_fallback = true
  for (const key of ['cost_usd_nanos', 'cost_cap_usd_nanos'] as const) {
    if (row[key] !== null && row[key] !== undefined)
      normalized[key] = rowInt(row, key)
  }
  if (typeof row.cost_complete === 'boolean')
    normalized.cost_complete = row.cost_complete
  return normalized
}

function optionalNonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return parsed
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
  const counts = tokenCounts(row)
  return counts.input + counts.cache_read + counts.cache_create
}

/** A non-negative integer count, 0 for anything else. */
function count(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

function firstKey(row: Row, ...keys: string[]): unknown {
  for (const key of keys) if (key in row) return row[key]
  return undefined
}

/**
 * The five disjoint counts of a usage or ledger row, under current or
 * legacy field names. A legacy `prompt_tokens` includes cache hits and a
 * legacy `completion_tokens` includes reasoning: both are split out.
 */
function tokenCounts(row: Row): TokenCounts {
  const cacheRead = count(
    firstKey(
      row,
      'cache_read',
      'cache_read_input_tokens',
      'prompt_cache_hit_tokens',
    ),
  )
  const cacheCreate = count(
    firstKey(row, 'cache_create', 'cache_creation_input_tokens'),
  )
  const reasoning = count(firstKey(row, 'reasoning', 'reasoning_tokens'))
  const input =
    'input' in row
      ? count(row.input)
      : Math.max(
          0,
          count(row.prompt_tokens) -
            ('prompt_cache_hit_tokens' in row ? cacheRead : 0),
        )
  const output =
    'output' in row
      ? count(row.output)
      : Math.max(0, count(row.completion_tokens) - reasoning)
  return {
    input,
    output,
    cache_read: cacheRead,
    cache_create: cacheCreate,
    reasoning,
  }
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

/** 本地时区 ISO（秒精度）。 */
function localIsoSeconds(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
