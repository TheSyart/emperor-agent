import { describe, expect, it } from 'vitest'
import {
  capOptions,
  capValue,
  formatUsd,
  overviewTiles,
  parseCap,
  sessionRows,
  sourceRows,
  timeoutOptions,
  type UsageSummary,
} from './usageCostModel'

const bucket = (usd: number, tokens: number, calls = 1, partial = false) => ({
  usd,
  tokens,
  calls,
  partial,
})
function summary(patch: Partial<UsageSummary> = {}): UsageSummary {
  return {
    range: 'today',
    totalUsd: 10.42,
    tokens: 12_600_000,
    subscriptionTokens: 0,
    cacheHitRate: 0.71,
    partial: false,
    bySource: {
      chat: bucket(1.55, 1000),
      build: bucket(6.92, 5000),
      group: bucket(0, 0, 0),
      scheduler: bucket(0.1, 50),
      'claude-code': bucket(1.85, 3000),
      codex: bucket(0, 2000),
      other: bucket(0, 0, 0),
    },
    topSessions: [],
    ...patch,
  }
}

describe('formatUsd', () => {
  it('shows cents, a floor for tiny amounts and whole dollars when large', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(18.424)).toBe('$18.42')
    expect(formatUsd(1234.6)).toBe('$1,235')
  })
})

describe('overviewTiles', () => {
  it('spend, tokens with the cache hit rate, group and external spend', () => {
    const tiles = overviewTiles(summary())
    expect(tiles.map((t) => [t.label, t.value, t.hint])).toEqual([
      ['花费（估算）', '$10.42', '按 API 单价估算'],
      ['Token', '12.6M', '缓存命中 71%'],
      ['群聊', '$0', '还没有群聊花费'],
      ['Claude Code、Codex', '$1.85', '订阅额度不计费用'],
    ])
  })

  it('says when some spend has no price, and what subscriptions used', () => {
    const tiles = overviewTiles(
      summary({
        partial: true,
        subscriptionTokens: 2000,
        cacheHitRate: null,
        bySource: { ...summary().bySource, group: bucket(2, 10, 12) },
      }),
    )
    expect(tiles[0]!.hint).toBe('部分调用缺少单价，实际更多')
    expect(tiles[1]!.hint).toBe('暂无缓存数据')
    expect(tiles[2]!.hint).toBe('12 次模型调用')
    expect(tiles[3]!.hint).toBe('订阅额度用了 2K Token，不计费用')
  })
})

describe('sourceRows', () => {
  it('lists sources that spent anything, most first, scaled to the largest', () => {
    const rows = sourceRows(summary())
    expect(rows.map((r) => r.key)).toEqual([
      'build',
      'claude-code',
      'chat',
      'scheduler',
      'codex',
    ])
    expect(rows[0]).toMatchObject({
      label: 'Build',
      value: '$6.92',
      width: 100,
    })
    expect(rows[3]!.width).toBeGreaterThanOrEqual(1)
  })

  it('shows tokens for a source that only used a subscription', () => {
    const row = sourceRows(summary()).find((r) => r.key === 'codex')!
    expect(row.value).toBe('2K Token')
    expect(row.width).toBe(1)
  })

  it('is empty when nothing was spent', () => {
    const empty = summary({
      bySource: Object.fromEntries(
        Object.keys(summary().bySource).map((k) => [k, bucket(0, 0, 0)]),
      ) as UsageSummary['bySource'],
    })
    expect(sourceRows(empty)).toEqual([])
  })
})

describe('sessionRows', () => {
  it('names each session, or says it was deleted', () => {
    const rows = sessionRows(
      summary({
        topSessions: [
          { sessionId: 's1', source: 'build', usd: 3.2, tokens: 9000 },
          { sessionId: 's2', source: 'chat', usd: 0, tokens: 10 },
        ],
      }),
      (id) => (id === 's1' ? '修登录页' : undefined),
    )
    expect(rows).toEqual([
      {
        id: 's1',
        title: '修登录页',
        source: 'Build',
        value: '$3.20',
        tokens: '9K',
        deleted: false,
      },
      {
        id: 's2',
        title: '已删除的会话',
        source: 'Chat',
        value: '$0',
        tokens: '10',
        deleted: true,
      },
    ])
  })
})

describe('cap options', () => {
  it('offers 不限制 first and keeps a custom value', () => {
    expect(capOptions([1, 5], null).map((o) => o.value)).toEqual([
      'none',
      '1',
      '5',
    ])
    expect(capOptions([1, 5], 3).map((o) => o.label)).toEqual([
      '不限制（默认）',
      '$1',
      '$3',
      '$5',
    ])
  })

  it('maps between the select value and the stored cap', () => {
    expect(capValue(null)).toBe('none')
    expect(capValue(2.5)).toBe('2.5')
    expect(parseCap('none')).toBeNull()
    expect(parseCap('20')).toBe(20)
    expect(parseCap('-1')).toBeUndefined()
    expect(parseCap('abc')).toBeUndefined()
    expect(parseCap(null)).toBeUndefined()
  })

  it('offers run timeouts in minutes and keeps the current one', () => {
    expect(timeoutOptions(45 * 60_000).map((o) => o.value)).toEqual([
      '10',
      '30',
      '45',
      '60',
      '120',
    ])
  })
})
