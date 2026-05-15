import type { TokenStatsRow, TokensPayload, TokensRange } from '../types'

export interface DateBucket {
  date: string
  total: number
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cacheTotal: number
  cacheMiss: number
}

export interface HeatmapCell {
  date: string | null
  total: number
  calls: number
  level: 0 | 1 | 2 | 3 | 4
}

export interface HeatmapMonthLabel {
  weekIndex: number
  label: string
}

export interface HeatmapData {
  weeks: HeatmapCell[][]
  months: HeatmapMonthLabel[]
}

export interface BarSegment {
  model: string
  total: number
  color: string
}

export interface BarColumn {
  date: string
  total: number
  segments: BarSegment[]
}

export interface ModelRow {
  key: string
  model: string
  provider: string
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cacheTotal: number
  cacheMiss: number
  total: number
  color: string
}

export interface TokenCompositionPart {
  key: 'cache_hit' | 'cache_miss' | 'output'
  label: string
  value: number
  color: string
}

export interface TokenComposition {
  cacheHit: number
  cacheMiss: number
  output: number
  cacheCreate: number
  total: number
  inputTotal: number
  hitRate: number
  parts: TokenCompositionPart[]
}

const DAY = 24 * 60 * 60 * 1000

const PALETTE = [
  'rgb(var(--seal))',
  'rgb(var(--amber))',
  'rgb(var(--jade))',
  'rgb(var(--ink) / 0.78)',
  'rgb(var(--muted))',
  'rgb(var(--seal) / 0.55)',
]

const MONTH_LABELS_CN = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

function tokenTotal(row?: TokenStatsRow | null): number {
  return (row?.input ?? 0) + (row?.cache_read ?? 0) + (row?.cache_create ?? 0) + (row?.output ?? 0)
}

function hashKey(input: string): number {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = (h * 33) ^ input.charCodeAt(i)
  }
  return Math.abs(h)
}

export function pickColor(key: string): string {
  return PALETTE[hashKey(key) % PALETTE.length]
}

function startOfDay(value: Date): Date {
  const d = new Date(value)
  d.setHours(0, 0, 0, 0)
  return d
}

function isoDate(value: Date): string {
  const y = value.getFullYear()
  const m = String(value.getMonth() + 1).padStart(2, '0')
  const d = String(value.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function rangeDays(range: TokensRange): number | null {
  if (range === '7d') return 7
  if (range === '30d') return 30
  return null
}

export function filterByRange(byDate: Record<string, TokenStatsRow>, range: TokensRange): DateBucket[] {
  const today = startOfDay(new Date())
  const days = rangeDays(range)
  let startDate: Date
  if (days != null) {
    startDate = new Date(today)
    startDate.setDate(today.getDate() - (days - 1))
  } else {
    const dates = Object.keys(byDate).filter(Boolean).sort()
    if (!dates.length) {
      startDate = today
    } else {
      startDate = new Date(dates[0])
      if (Number.isNaN(startDate.getTime())) startDate = today
    }
    startDate = startOfDay(startDate)
  }
  const buckets: DateBucket[] = []
  for (let cursor = new Date(startDate); cursor.getTime() <= today.getTime(); cursor = new Date(cursor.getTime() + DAY)) {
    const date = isoDate(cursor)
    const row = byDate[date]
    const input = row?.input ?? 0
    const output = row?.output ?? 0
    const cacheRead = row?.cache_read ?? 0
    const cacheCreate = row?.cache_create ?? 0
    buckets.push({
      date,
      total: input + cacheRead + cacheCreate + output,
      calls: row?.calls ?? 0,
      input,
      output,
      cacheRead,
      cacheCreate,
      cacheTotal: cacheRead + cacheCreate,
      cacheMiss: input + cacheCreate,
    })
  }
  return buckets
}

function quantileLevel(value: number, sorted: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || !sorted.length) return 0
  const idx = sorted.findIndex((v) => v >= value)
  const ratio = idx === -1 ? 1 : idx / sorted.length
  if (ratio < 0.25) return 1
  if (ratio < 0.5) return 2
  if (ratio < 0.75) return 3
  return 4
}

export function buildHeatmap(byDate: Record<string, TokenStatsRow>, weeks = 53): HeatmapData {
  const today = startOfDay(new Date())
  const dayOfWeek = today.getDay() // 0=Sun..6=Sat
  const lastSunday = new Date(today)
  lastSunday.setDate(today.getDate() - dayOfWeek)
  // grid right-most column = current week (Sun..today)
  const startSunday = new Date(lastSunday)
  startSunday.setDate(lastSunday.getDate() - (weeks - 1) * 7)

  const sortedTotals = Object.values(byDate)
    .map((row) => tokenTotal(row))
    .filter((v) => v > 0)
    .sort((a, b) => a - b)

  const weeksGrid: HeatmapCell[][] = []
  const months: HeatmapMonthLabel[] = []
  let lastMonth = -1
  for (let w = 0; w < weeks; w++) {
    const column: HeatmapCell[] = []
    for (let d = 0; d < 7; d++) {
      const cursor = new Date(startSunday)
      cursor.setDate(startSunday.getDate() + w * 7 + d)
      if (cursor.getTime() > today.getTime()) {
        column.push({ date: null, total: 0, calls: 0, level: 0 })
        continue
      }
      const date = isoDate(cursor)
      const row = byDate[date]
      const total = tokenTotal(row)
      const calls = row?.calls ?? 0
      column.push({ date, total, calls, level: quantileLevel(total, sortedTotals) })
    }
    const sundayCursor = new Date(startSunday)
    sundayCursor.setDate(startSunday.getDate() + w * 7)
    if (sundayCursor.getTime() <= today.getTime()) {
      const month = sundayCursor.getMonth()
      if (month !== lastMonth && sundayCursor.getDate() <= 7) {
        months.push({ weekIndex: w, label: MONTH_LABELS_CN[month] })
        lastMonth = month
      }
    }
    weeksGrid.push(column)
  }
  return { weeks: weeksGrid, months }
}

function modelLabel(key: string, info?: TokenStatsRow): string {
  const fromInfo = typeof info?.model === 'string' ? info.model : ''
  if (fromInfo) return fromInfo
  if (key.includes('/')) return key.split('/').slice(1).join('/')
  return key
}

function providerLabel(key: string, info?: TokenStatsRow): string {
  const fromInfo = typeof info?.provider === 'string' ? info.provider : ''
  if (fromInfo) return fromInfo
  if (key.includes('/')) return key.split('/')[0]
  return ''
}

function modelTotalsAcrossDates(byDateModel: TokensPayload['byDateModel']): Map<string, number> {
  const totals = new Map<string, number>()
  for (const dateMap of Object.values(byDateModel)) {
    for (const [key, row] of Object.entries(dateMap)) {
      totals.set(key, (totals.get(key) ?? 0) + tokenTotal(row))
    }
  }
  return totals
}

export function topModels(byDateModel: TokensPayload['byDateModel'], topN = 5): string[] {
  const totals = modelTotalsAcrossDates(byDateModel)
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key]) => key)
}

export function buildStackedBars(
  byDateModel: TokensPayload['byDateModel'],
  byDate: Record<string, TokenStatsRow>,
  range: TokensRange,
  topN = 5,
): { columns: BarColumn[]; topModelKeys: string[]; otherKey: string | null } {
  const dateRange = filterByRange(byDate, range).map((b) => b.date)
  const top = topModels(byDateModel, topN)
  const topSet = new Set(top)
  const otherKey = '__other__'
  const columns: BarColumn[] = []
  let otherSeen = false

  for (const date of dateRange) {
    const dateRows = byDateModel[date] ?? {}
    const segments: BarSegment[] = []
    let otherTotal = 0

    for (const key of top) {
      const row = dateRows[key]
      const total = tokenTotal(row)
      if (total > 0) {
        segments.push({ model: key, total, color: pickColor(key) })
      }
    }
    for (const [key, row] of Object.entries(dateRows)) {
      if (topSet.has(key)) continue
      const total = tokenTotal(row)
      if (total > 0) otherTotal += total
    }
    if (otherTotal > 0) {
      otherSeen = true
      segments.push({ model: otherKey, total: otherTotal, color: 'rgb(var(--muted) / 0.65)' })
    }
    const total = segments.reduce((acc, s) => acc + s.total, 0)
    columns.push({ date, total, segments })
  }
  return { columns, topModelKeys: top, otherKey: otherSeen ? otherKey : null }
}

export function buildModelRows(
  byModel: Record<string, TokenStatsRow>,
): ModelRow[] {
  const rows = Object.entries(byModel).map(([key, row]) => {
    const input = row.input ?? 0
    const output = row.output ?? 0
    const cacheRead = row.cache_read ?? 0
    const cacheCreate = row.cache_create ?? 0
    return {
      key,
      model: modelLabel(key, row),
      provider: providerLabel(key, row),
      calls: row.calls ?? 0,
      input,
      output,
      cacheRead,
      cacheCreate,
      cacheTotal: cacheRead + cacheCreate,
      cacheMiss: input + cacheCreate,
      total: input + cacheRead + cacheCreate + output,
      color: pickColor(key),
    }
  })
  rows.sort((a, b) => b.total - a.total)
  return rows
}

export function topModelDisplay(byModel: Record<string, TokenStatsRow>): string {
  const sorted = Object.entries(byModel).sort((a, b) => tokenTotal(b[1]) - tokenTotal(a[1]))
  if (!sorted.length) return '—'
  const [key, info] = sorted[0]
  return modelLabel(key, info)
}

export function peakHourLabel(byHour: Record<string, TokenStatsRow>): string {
  let best: [string, number] | null = null
  for (const [hour, row] of Object.entries(byHour)) {
    const total = tokenTotal(row)
    if (best == null || total > best[1]) {
      best = [hour, total]
    }
  }
  if (!best || best[1] === 0) return '—'
  return `${best[0]}:00`
}

export function formatPercent(part: number, total: number): string {
  if (!total) return '0%'
  const v = (part / total) * 100
  if (v >= 10) return `${v.toFixed(0)}%`
  return `${v.toFixed(1)}%`
}

export function cacheTotal(row?: TokenStatsRow | null): number {
  return (row?.cache_read ?? 0) + (row?.cache_create ?? 0)
}

export function buildTokenComposition(row?: TokenStatsRow | null): TokenComposition {
  const cacheHit = row?.cache_read ?? 0
  const cacheCreate = row?.cache_create ?? 0
  const cacheMiss = (row?.input ?? 0) + cacheCreate
  const output = row?.output ?? 0
  const total = cacheHit + cacheMiss + output
  const inputTotal = cacheHit + cacheMiss
  return {
    cacheHit,
    cacheMiss,
    output,
    cacheCreate,
    total,
    inputTotal,
    hitRate: inputTotal ? cacheHit / inputTotal : 0,
    parts: [
      { key: 'cache_hit', label: '输入缓存命中', value: cacheHit, color: 'rgb(var(--jade) / 0.9)' },
      { key: 'cache_miss', label: '输入缓存未命中', value: cacheMiss, color: 'rgb(var(--seal) / 0.42)' },
      { key: 'output', label: '输出', value: output, color: 'rgb(var(--amber) / 0.9)' },
    ].filter((part) => part.value > 0) as TokenCompositionPart[],
  }
}

export function modelDisplayName(key: string, info?: TokenStatsRow): string {
  return modelLabel(key, info)
}
