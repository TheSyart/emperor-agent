import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TokensPayload } from '../../../types'
import {
  cacheModelRows,
  cacheRankingItems,
  cacheTrend,
  cacheUsageRows,
  generatedTime,
  heatmapView,
  modelRankingItems,
  modelTrend,
  quickStats,
  rangeTotals,
  rankModels,
  recentCacheRows,
  sortRanking,
  typeTrend,
  usageComposition,
  usageMetrics,
} from './tokenUsageModel'

const row = (
  input: number,
  output: number,
  cacheRead = 0,
  cacheCreate = 0,
  calls = 1,
) => ({
  input,
  output,
  cache_read: cacheRead,
  cache_create: cacheCreate,
  calls,
})

function payload(): TokensPayload {
  return {
    totals: row(1100, 540, 900, 60, 6),
    byDate: {
      '2026-09-20': row(600, 300, 400, 0, 3),
      '2026-09-22': row(300, 140, 500, 60, 2),
      '2026-08-01': row(200, 100, 0, 0, 1),
    },
    byModel: {
      'deepseek/deepseek-chat': {
        ...row(700, 340, 900, 60, 4),
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
      'visual/visual-main': {
        ...row(400, 200, 0, 0, 2),
        provider: 'visual',
        model: 'visual-main',
      },
    },
    byUsageType: {
      main_agent: row(900, 440, 900, 60, 5),
      memory_compaction: row(200, 100, 0, 0, 1),
    },
    byDateModel: {
      '2026-09-20': {
        'deepseek/deepseek-chat': {
          ...row(400, 200, 400, 0, 2),
          provider: 'deepseek',
          model: 'deepseek-chat',
        },
        'visual/visual-main': {
          ...row(200, 100, 0, 0, 1),
          provider: 'visual',
          model: 'visual-main',
        },
      },
      '2026-09-22': {
        'deepseek/deepseek-chat': {
          ...row(300, 140, 500, 60, 2),
          provider: 'deepseek',
          model: 'deepseek-chat',
        },
      },
      '2026-08-01': {
        'visual/visual-main': {
          ...row(200, 100, 0, 0, 1),
          provider: 'visual',
          model: 'visual-main',
        },
      },
    },
    byHour: { '09': row(10, 5), '14': row(900, 400) },
    streak: {} as TokensPayload['streak'],
    sessions: 4,
    messages: 12,
    recentCacheCalls: [
      {
        ts: '2026-09-22T14:05:00',
        provider: 'deepseek',
        model: 'deepseek-chat',
        usage_type: 'main_agent',
        input: 300,
        output: 140,
        cache_read: 500,
        cache_create: 60,
        total: 1000,
      },
    ],
    generatedAt: '2026-09-22T19:35:04',
  }
}

describe('token usage model', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 22, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads lifetime totals for 全部 and sums byDate for a window', () => {
    const all = rangeTotals(payload(), 'all')
    expect(all).toMatchObject({
      total: 2600,
      input: 1100,
      output: 540,
      cacheRead: 900,
      cacheCreate: 60,
      cacheMiss: 1160,
      calls: 6,
      activeDays: 3,
    })
    const week = rangeTotals(payload(), '7d')
    expect(week).toMatchObject({
      total: 1300 + 1000,
      input: 900,
      calls: 5,
      activeDays: 2,
    })
    expect(rangeTotals(null, 'all').total).toBe(0)
  })

  it('projects the four metric tiles', () => {
    const metrics = usageMetrics(rangeTotals(payload(), 'all'))
    expect(metrics.map((metric) => [metric.label, metric.value])).toEqual([
      ['总 Token', '2.6K'],
      ['输入 Token', '2.1K'],
      ['输出 Token', '540'],
      ['缓存命中率', '44%'],
    ])
    expect(metrics.map((metric) => metric.hint)).toEqual([
      '6 次调用',
      '未命中 1.2K',
      '模型生成消耗',
      '命中 900',
    ])
    expect(
      usageMetrics(rangeTotals(null, '7d')).find(
        (metric) => metric.key === 'hitRate',
      )!.value,
    ).toBe('—')
  })

  it('colors the cache composition with theme tones', () => {
    const composition = usageComposition(rangeTotals(payload(), 'all'))
    expect(composition.parts.map((part) => part.key)).toEqual([
      'cache_hit',
      'cache_miss',
      'output',
    ])
    expect(
      composition.parts.every((part) => part.color.startsWith('rgb(var(--')),
    ).toBe(true)
  })

  it('lays the heatmap out as 53 × 7 column-major cells', () => {
    const view = heatmapView(payload())
    expect(view.cells).toHaveLength(53 * 7)
    const dated = view.cells.filter((cell) => cell.date)
    expect(dated.at(-1)!.date).toBe('2026-09-22')
    expect(dated.at(-1)!.label).toBe('2026-09-22 · 1,000 tokens · 2 次调用')
    expect(view.cells.find((cell) => cell.date === '2026-09-21')!.label).toBe(
      '2026-09-21 · 无记录',
    )
    // future days of the current week stay blank
    expect(view.cells.at(-1)!.date).toBeNull()
    expect(view.months.every((month) => month.column >= 1)).toBe(true)
  })

  it('lists quick facts', () => {
    const facts = quickStats(payload(), rangeTotals(payload(), 'all'))
    expect(facts.map((fact) => [fact.label, fact.value])).toEqual([
      ['会话', '4'],
      ['消息', '12'],
      ['活跃天数', '3'],
      ['高峰时段', '14:00'],
      ['常用模型', 'deepseek-chat'],
    ])
    expect(quickStats(null, rangeTotals(null, 'all'))).toEqual([])
  })

  it('ranks models for the range with shares and hit rates', () => {
    const all = rankModels(payload(), 'all')
    expect(all.map((item) => item.model)).toEqual([
      'deepseek-chat',
      'visual-main',
    ])
    expect(all[0]!.share + all[1]!.share).toBeCloseTo(1)
    expect(all[1]!.hitRate).toBe(0)

    const week = rankModels(payload(), '7d')
    expect(week.map((item) => [item.model, item.total])).toEqual([
      ['deepseek-chat', 2000],
      ['visual-main', 300],
    ])
    expect(sortRanking(week, 'model').map((item) => item.model)).toEqual([
      'deepseek-chat',
      'visual-main',
    ])
    expect(sortRanking(week, 'calls')[0]!.model).toBe('deepseek-chat')
    const items = modelRankingItems(week)
    expect(items[0]).toMatchObject({
      primary: 'deepseek-chat',
      secondary: 'deepseek',
      value: '2K',
    })
    expect(items[0]!.detail).toContain('命中率')
  })

  it('builds model, type and cache trends over the range dates', () => {
    const trend = modelTrend(payload(), '7d')
    expect(trend.dates).toHaveLength(7)
    expect(trend.dates.at(-1)).toBe('2026-09-22')
    expect(trend.series.map((series) => series.id)).toEqual([
      'deepseek/deepseek-chat',
      'visual/visual-main',
    ])
    expect(trend.series[0]!.values.at(-1)).toBe(1000)
    expect(trend.series[0]!.values.at(-3)).toBe(1000)

    const types = typeTrend(payload(), '7d')
    expect(types.series.map((series) => series.label)).toEqual([
      '未缓存输入',
      '缓存读取',
      '缓存写入',
      '输出',
    ])
    expect(types.series[1]!.values.at(-1)).toBe(500)
    expect(cacheTrend(payload(), '7d').series[1]!.values.at(-1)).toBe(60)
  })

  it('ranks cache usage and recent calls', () => {
    const models = cacheModelRows(payload(), 'all')
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ label: 'deepseek-chat', share: 1 })
    const usage = cacheUsageRows(payload())
    expect(usage.map((item) => item.label)).toEqual(['主 Agent'])
    expect(cacheRankingItems(usage)[0]!.detail).toBe(
      '读取 900 · 写入 60 · 占缓存 100%',
    )
    expect(recentCacheRows(payload())).toEqual([
      expect.objectContaining({
        time: '09-22 14:05',
        model: 'deepseek/deepseek-chat',
        usage: '主 Agent',
        total: '1K',
        detail: '命中 500 · 未命中 360 · 输出 140',
      }),
    ])
    expect(generatedTime(payload())).toBe('19:35:04')
    expect(generatedTime(null)).toBe('')
  })
})
