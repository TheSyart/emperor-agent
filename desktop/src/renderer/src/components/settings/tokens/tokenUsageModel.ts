/**
 * Settings › 用量 — pure projections of `memory.tokens` (TokensPayload) for
 * the dsh-style dashboard: range totals and the four metric tiles, the
 * 53-week heatmap cells, trend series (by model / by type / cache), model
 * and usage-type rankings and recent cache calls. Date bucketing, the
 * heatmap quantiles and model labels come from utils/tokens.
 */
import type {
  TokenStatsRow,
  TokenUsageRecord,
  TokensPayload,
  TokensRange,
} from '../../../types'
import {
  formatNumber,
  formatTokenCompact,
  usageTypeLabel,
} from '../../../utils/format'
import {
  buildHeatmap,
  buildModelRows,
  buildTokenComposition,
  filterByRange,
  formatPercent,
  peakHourLabel,
  topModelDisplay,
  type HeatmapCell,
  type ModelRow,
} from '../../../utils/tokens'

export type UsageView = 'activity' | 'trend' | 'models' | 'cache'
export type TrendMode = 'model' | 'type'
export type RankSort =
  'total' | 'calls' | 'output' | 'cacheRead' | 'cacheMiss' | 'hitRate' | 'model'

export const RANGE_OPTIONS: Array<{ value: TokensRange; label: string }> = [
  { value: 'all', label: '全部' },
  { value: '30d', label: '30 天' },
  { value: '7d', label: '7 天' },
]

export const VIEW_OPTIONS: Array<{ value: UsageView; label: string }> = [
  { value: 'activity', label: '活跃度' },
  { value: 'trend', label: '趋势' },
  { value: 'models', label: '模型' },
  { value: 'cache', label: '缓存' },
]

export const TREND_MODE_OPTIONS: Array<{ value: TrendMode; label: string }> = [
  { value: 'model', label: '按模型' },
  { value: 'type', label: '按类型' },
]

export const SORT_OPTIONS: Array<{ value: RankSort; label: string }> = [
  { value: 'total', label: '按总 Token' },
  { value: 'calls', label: '按调用次数' },
  { value: 'output', label: '按输出' },
  { value: 'cacheRead', label: '按缓存命中' },
  { value: 'cacheMiss', label: '按缓存未命中' },
  { value: 'hitRate', label: '按命中率' },
  { value: 'model', label: '按名称' },
]

/** Series colors: theme tones only (both themes define them). */
export const SERIES_COLORS = [
  'rgb(var(--tone-cyan))',
  'rgb(var(--accent-fill))',
  'rgb(var(--tone-violet))',
  'rgb(var(--state-warn))',
  'rgb(var(--state-ok))',
  'rgb(var(--tone-blue))',
] as const
export const OTHER_COLOR = 'rgb(var(--label-tertiary))'
const SERIES_DASHES = ['', '8 4', '2 4', '11 4 2 4', '4 3', '12 3'] as const

export interface UsageTotals {
  total: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  /** Uncached input + cache writes (billed as fresh input). */
  cacheMiss: number
  calls: number
  activeDays: number
}

function statsTotal(row?: TokenStatsRow | null): number {
  return (
    (row?.input ?? 0) +
    (row?.cache_read ?? 0) +
    (row?.cache_create ?? 0) +
    (row?.output ?? 0)
  )
}

/**
 * Totals for the selected range. `all` reads the authoritative lifetime
 * totals (dates without a timestamp still count); a window sums `byDate`.
 */
export function rangeTotals(
  tokens: TokensPayload | null,
  range: TokensRange,
): UsageTotals {
  const buckets = filterByRange(tokens?.byDate ?? {}, range)
  const activeDays = buckets.filter((bucket) => bucket.total > 0).length
  if (range === 'all' && tokens?.totals) {
    const row = tokens.totals
    const input = row.input ?? 0
    const cacheRead = row.cache_read ?? 0
    const cacheCreate = row.cache_create ?? 0
    const output = row.output ?? 0
    return {
      total: statsTotal(row),
      input,
      output,
      cacheRead,
      cacheCreate,
      cacheMiss: input + cacheCreate,
      calls: row.calls ?? 0,
      activeDays,
    }
  }
  const totals: UsageTotals = {
    total: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    cacheMiss: 0,
    calls: 0,
    activeDays,
  }
  for (const bucket of buckets) {
    totals.total += bucket.total
    totals.input += bucket.input
    totals.output += bucket.output
    totals.cacheRead += bucket.cacheRead
    totals.cacheCreate += bucket.cacheCreate
    totals.cacheMiss += bucket.cacheMiss
    totals.calls += bucket.calls
  }
  return totals
}

export interface UsageMetric {
  key: 'total' | 'input' | 'output' | 'hitRate'
  label: string
  value: string
  hint: string
  /** Exact figure for the tooltip. */
  title: string
}

export function usageMetrics(totals: UsageTotals): UsageMetric[] {
  const inputTotal = totals.cacheRead + totals.cacheMiss
  return [
    {
      key: 'total',
      label: '总 Token',
      value: formatTokenCompact(totals.total),
      hint: `${formatNumber(totals.calls)} 次调用`,
      title: `${formatNumber(totals.total)} tokens`,
    },
    {
      key: 'input',
      label: '输入 Token',
      value: formatTokenCompact(inputTotal),
      hint: `未命中 ${formatTokenCompact(totals.cacheMiss)}`,
      title: `${formatNumber(inputTotal)} tokens（命中 ${formatNumber(totals.cacheRead)} · 未命中 ${formatNumber(totals.cacheMiss)}）`,
    },
    {
      key: 'output',
      label: '输出 Token',
      value: formatTokenCompact(totals.output),
      hint: '模型生成消耗',
      title: `${formatNumber(totals.output)} tokens`,
    },
    {
      key: 'hitRate',
      label: '缓存命中率',
      value: inputTotal ? formatPercent(totals.cacheRead, inputTotal) : '—',
      hint: `命中 ${formatTokenCompact(totals.cacheRead)}`,
      title: `命中 ${formatNumber(totals.cacheRead)} / 输入 ${formatNumber(inputTotal)} tokens · 缓存写入 ${formatNumber(totals.cacheCreate)}`,
    },
  ]
}

/** Hit / miss / output parts for the cache-efficiency meter. */
export function usageComposition(totals: UsageTotals) {
  const composition = buildTokenComposition({
    input: totals.input,
    output: totals.output,
    cache_read: totals.cacheRead,
    cache_create: totals.cacheCreate,
  })
  const colors: Record<string, string> = {
    cache_hit: 'rgb(var(--state-ok))',
    cache_miss: 'rgb(var(--tone-blue))',
    output: 'rgb(var(--accent-fill))',
  }
  return {
    ...composition,
    parts: composition.parts.map((part) => ({
      ...part,
      color: colors[part.key] ?? OTHER_COLOR,
    })),
  }
}

export interface HeatCell {
  key: string
  date: string | null
  level: HeatmapCell['level']
  label: string
}

export interface HeatmapView {
  cells: HeatCell[]
  months: Array<{ key: string; label: string; column: number }>
}

/** 53 week columns × 7 weekday rows, column-major (grid-auto-flow: column). */
export function heatmapView(tokens: TokensPayload | null): HeatmapView {
  const heatmap = buildHeatmap(tokens?.byDate ?? {})
  const cells: HeatCell[] = []
  heatmap.weeks.forEach((week, weekIndex) => {
    week.forEach((cell, dayIndex) => {
      cells.push({
        key: `${weekIndex}-${dayIndex}`,
        date: cell.date,
        level: cell.level,
        label: !cell.date
          ? ''
          : cell.total === 0
            ? `${cell.date} · 无记录`
            : `${cell.date} · ${formatNumber(cell.total)} tokens · ${formatNumber(cell.calls)} 次调用`,
      })
    })
  })
  return {
    cells,
    months: heatmap.months.map((month) => ({
      key: `${month.weekIndex}-${month.label}`,
      label: month.label,
      column: month.weekIndex + 1,
    })),
  }
}

export interface QuickStat {
  label: string
  value: string
  title: string
}

export function quickStats(
  tokens: TokensPayload | null,
  totals: UsageTotals,
): QuickStat[] {
  if (!tokens) return []
  return [
    {
      label: '会话',
      value: formatTokenCompact(tokens.sessions),
      title: `${formatNumber(tokens.sessions)} 个会话`,
    },
    {
      label: '消息',
      value: formatTokenCompact(tokens.messages),
      title: `${formatNumber(tokens.messages)} 条消息`,
    },
    {
      label: '活跃天数',
      value: formatTokenCompact(totals.activeDays),
      title: `所选范围内 ${formatNumber(totals.activeDays)} 天有调用`,
    },
    {
      label: '高峰时段',
      value: peakHourLabel(tokens.byHour ?? {}),
      title: '消耗最多 Token 的时段',
    },
    {
      label: '常用模型',
      value: topModelDisplay(tokens.byModel ?? {}),
      title: '总量最高的模型',
    },
  ]
}

/** One TokenRankingList row (already formatted). */
export interface RankingItem {
  key: string
  primary: string
  secondary?: string
  /** 0..1 of the listed total (bar width). */
  share: number
  value: string
  valueTitle?: string
  detail?: string
}

export interface RankRow extends ModelRow {
  /** Share of the ranked total (0..1). */
  share: number
  /** cache_read / (cache_read + input + cache_create), or null. */
  hitRate: number | null
}

function addStats(target: TokenStatsRow, row: TokenStatsRow) {
  target.input = (target.input ?? 0) + (row.input ?? 0)
  target.output = (target.output ?? 0) + (row.output ?? 0)
  target.cache_read = (target.cache_read ?? 0) + (row.cache_read ?? 0)
  target.cache_create = (target.cache_create ?? 0) + (row.cache_create ?? 0)
  target.calls = (target.calls ?? 0) + (row.calls ?? 0)
  if (typeof row.provider === 'string') target.provider = row.provider
  if (typeof row.model === 'string') target.model = row.model
}

function withShares(rows: ModelRow[]): RankRow[] {
  const sum = rows.reduce((acc, row) => acc + row.total, 0)
  return rows.map((row) => {
    const input = row.cacheRead + row.cacheMiss
    return {
      ...row,
      share: sum ? row.total / sum : 0,
      hitRate: input ? row.cacheRead / input : null,
    }
  })
}

/** Per-model rows for the range (lifetime `byModel` for `all`). */
export function rankModels(
  tokens: TokensPayload | null,
  range: TokensRange,
): RankRow[] {
  if (!tokens) return []
  if (range === 'all')
    return withShares(
      buildModelRows(tokens.byModel ?? {}).filter((row) => row.total > 0),
    )
  const dates = new Set(
    filterByRange(tokens.byDate ?? {}, range).map((bucket) => bucket.date),
  )
  const merged: Record<string, TokenStatsRow> = {}
  for (const [date, models] of Object.entries(tokens.byDateModel ?? {})) {
    if (!dates.has(date)) continue
    for (const [key, row] of Object.entries(models))
      addStats((merged[key] ??= {}), row)
  }
  return withShares(buildModelRows(merged).filter((row) => row.total > 0))
}

export function sortRanking(rows: readonly RankRow[], sort: RankSort) {
  const sorted = [...rows]
  sorted.sort((a, b) => {
    if (sort === 'model') return a.model.localeCompare(b.model)
    if (sort === 'hitRate') return (b.hitRate ?? -1) - (a.hitRate ?? -1)
    return (b[sort] ?? 0) - (a[sort] ?? 0) || b.total - a.total
  })
  return sorted
}

export function modelRankingItems(rows: readonly RankRow[]): RankingItem[] {
  return rows.map((row) => ({
    key: row.key,
    primary: row.model,
    secondary: row.provider || undefined,
    share: row.share,
    value: formatTokenCompact(row.total),
    valueTitle: `${formatNumber(row.total)} tokens`,
    detail: rankDetails(row),
  }))
}

export function cacheRankingItems(
  rows: readonly CacheRankRow[],
): RankingItem[] {
  return rows.map((row) => ({
    key: row.key,
    primary: row.label,
    secondary: row.sub,
    share: row.share,
    value: formatTokenCompact(row.cacheTotal),
    valueTitle: `${formatNumber(row.cacheTotal)} tokens`,
    detail: `读取 ${formatTokenCompact(row.cacheRead)} · 写入 ${formatTokenCompact(row.cacheCreate)} · 占缓存 ${formatPercent(row.share, 1)}`,
  }))
}

export function rankDetails(row: RankRow): string {
  return [
    `占比 ${formatPercent(row.share, 1)}`,
    `调用 ${formatTokenCompact(row.calls)}`,
    `命中 ${formatTokenCompact(row.cacheRead)}`,
    `未命中 ${formatTokenCompact(row.cacheMiss)}`,
    `输出 ${formatTokenCompact(row.output)}`,
    `命中率 ${row.hitRate === null ? '—' : row.hitRate === 0 ? '0%' : formatPercent(row.cacheRead, row.cacheRead + row.cacheMiss)}`,
  ].join(' · ')
}

export interface CacheRankRow {
  key: string
  label: string
  sub: string
  cacheRead: number
  cacheCreate: number
  cacheTotal: number
  calls: number
  share: number
}

/** Models ranked by KV cache volume (read + create) within the range. */
export function cacheModelRows(
  tokens: TokensPayload | null,
  range: TokensRange,
): CacheRankRow[] {
  const rows = rankModels(tokens, range).filter((row) => row.cacheTotal > 0)
  const sum = rows.reduce((acc, row) => acc + row.cacheTotal, 0)
  return rows
    .map((row) => ({
      key: row.key,
      label: row.model,
      sub: row.provider || 'unknown',
      cacheRead: row.cacheRead,
      cacheCreate: row.cacheCreate,
      cacheTotal: row.cacheTotal,
      calls: row.calls,
      share: sum ? row.cacheTotal / sum : 0,
    }))
    .sort((a, b) => b.cacheTotal - a.cacheTotal)
}

/** Usage types ranked by KV cache volume (lifetime: no per-date split). */
export function cacheUsageRows(tokens: TokensPayload | null): CacheRankRow[] {
  const rows = Object.entries(tokens?.byUsageType ?? {})
    .map(([key, row]) => {
      const cacheRead = row.cache_read ?? 0
      const cacheCreate = row.cache_create ?? 0
      return {
        key,
        label: usageTypeLabel(key),
        sub: `${formatNumber(row.calls ?? 0)} 次调用`,
        cacheRead,
        cacheCreate,
        cacheTotal: cacheRead + cacheCreate,
        calls: row.calls ?? 0,
        share: 0,
      }
    })
    .filter((row) => row.cacheTotal > 0)
  const sum = rows.reduce((acc, row) => acc + row.cacheTotal, 0)
  return rows
    .map((row) => ({ ...row, share: sum ? row.cacheTotal / sum : 0 }))
    .sort((a, b) => b.cacheTotal - a.cacheTotal)
}

export interface TrendSeries {
  id: string
  label: string
  sub?: string
  values: number[]
  color: string
  dash: string
}

export interface TrendData {
  dates: string[]
  series: TrendSeries[]
}

function visual(index: number) {
  return {
    color: SERIES_COLORS[index % SERIES_COLORS.length]!,
    dash: SERIES_DASHES[index % SERIES_DASHES.length]!,
  }
}

/** Top 5 models of the range as lines, the rest folded into 「其他」. */
export function modelTrend(
  tokens: TokensPayload | null,
  range: TokensRange,
): TrendData {
  const dates = filterByRange(tokens?.byDate ?? {}, range).map(
    (bucket) => bucket.date,
  )
  const top = rankModels(tokens, range).slice(0, 5)
  const index = new Map(top.map((row, at) => [row.key, at]))
  const values = top.map(() => dates.map(() => 0))
  const other = dates.map(() => 0)
  dates.forEach((date, at) => {
    for (const [key, row] of Object.entries(
      tokens?.byDateModel?.[date] ?? {},
    )) {
      const series = index.get(key)
      if (series === undefined) other[at] = (other[at] ?? 0) + statsTotal(row)
      else values[series]![at] = statsTotal(row)
    }
  })
  const series: TrendSeries[] = top.map((row, at) => ({
    id: row.key,
    label: row.model,
    sub: row.provider || undefined,
    values: values[at]!,
    ...visual(at),
  }))
  if (other.some((value) => value > 0))
    series.push({
      id: '__other__',
      label: '其他',
      values: other,
      color: OTHER_COLOR,
      dash: '1 3',
    })
  return { dates, series }
}

const TYPE_SERIES = [
  { id: 'input', label: '未缓存输入', field: 'input' },
  { id: 'cacheRead', label: '缓存读取', field: 'cacheRead' },
  { id: 'cacheCreate', label: '缓存写入', field: 'cacheCreate' },
  { id: 'output', label: '输出', field: 'output' },
] as const

/** The four token buckets per day. */
export function typeTrend(
  tokens: TokensPayload | null,
  range: TokensRange,
): TrendData {
  const buckets = filterByRange(tokens?.byDate ?? {}, range)
  return {
    dates: buckets.map((bucket) => bucket.date),
    series: TYPE_SERIES.map((item, at) => ({
      id: item.id,
      label: item.label,
      values: buckets.map((bucket) => bucket[item.field]),
      ...visual(at),
    })),
  }
}

/** Daily KV cache read / create (the cache view trend). */
export function cacheTrend(
  tokens: TokensPayload | null,
  range: TokensRange,
): TrendData {
  const buckets = filterByRange(tokens?.byDate ?? {}, range)
  return {
    dates: buckets.map((bucket) => bucket.date),
    series: [
      {
        id: 'cacheRead',
        label: '缓存读取',
        values: buckets.map((bucket) => bucket.cacheRead),
        color: 'rgb(var(--state-ok))',
        dash: '',
      },
      {
        id: 'cacheCreate',
        label: '缓存写入',
        values: buckets.map((bucket) => bucket.cacheCreate),
        color: 'rgb(var(--tone-violet))',
        dash: '8 4',
      },
    ],
  }
}

export interface RecentCacheRow {
  key: string
  time: string
  model: string
  usage: string
  total: string
  totalTitle: string
  detail: string
}

export function recentCacheRows(
  tokens: TokensPayload | null,
): RecentCacheRow[] {
  return (tokens?.recentCacheCalls ?? []).map(
    (record: TokenUsageRecord, at) => ({
      key: `${record.ts}-${record.provider}-${record.model}-${record.total}-${at}`,
      time: record.ts ? record.ts.replace('T', ' ').slice(5, 16) : '—',
      model:
        record.provider && record.provider !== 'unknown'
          ? `${record.provider}/${record.model}`
          : record.model,
      usage: usageTypeLabel(record.usage_type),
      total: formatTokenCompact(record.total),
      totalTitle: `${formatNumber(record.total)} tokens`,
      detail: `命中 ${formatTokenCompact(record.cache_read)} · 未命中 ${formatTokenCompact(
        record.input + record.cache_create,
      )} · 输出 ${formatTokenCompact(record.output)}`,
    }),
  )
}

/** `2026-09-22T19:35:04` → `19:35:04`. */
export function generatedTime(tokens: TokensPayload | null): string {
  const text = tokens?.generatedAt || ''
  const match = /T(\d{2}:\d{2}(?::\d{2})?)/.exec(text)
  return match?.[1] ?? ''
}
