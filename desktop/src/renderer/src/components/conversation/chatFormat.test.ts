/**
 * BUG-08: a web source's 发布时间 reads as a local date, not the provider's
 * ISO string. Inputs are built from local dates so the cases hold in any
 * time zone.
 */
import { describe, expect, it } from 'vitest'
import { formatPublishedDate } from './chatFormat'

const NOW = new Date(2026, 9, 25, 10, 0).getTime()
const iso = (...parts: [number, number, number, number, number]) =>
  new Date(...parts).toISOString()

describe('formatPublishedDate (BUG-08)', () => {
  it('drops a midnight time: 10月16日', () => {
    expect(formatPublishedDate(iso(2026, 9, 16, 0, 0), NOW)).toBe('10月16日')
  })
  it('keeps a real time of day in local time', () => {
    expect(formatPublishedDate(iso(2026, 9, 15, 17, 30), NOW)).toBe(
      '10月15日 17:30',
    )
  })
  it('keeps a plain date as that date, with no time zone shift', () => {
    expect(formatPublishedDate('2026-10-15', NOW)).toBe('10月15日')
  })
  it('names the year for another year', () => {
    expect(formatPublishedDate(iso(2025, 2, 2, 0, 0), NOW)).toBe('2025年3月2日')
    expect(formatPublishedDate('2024-12-31', NOW)).toBe('2024年12月31日')
  })
  it('reads an offset timestamp as the instant it names', () => {
    const raw = '2026-10-15T16:00:00+00:00'
    const local = new Date(Date.parse(raw))
    const midnight = local.getHours() === 0 && local.getMinutes() === 0
    const day = `${local.getMonth() + 1}月${local.getDate()}日`
    expect(formatPublishedDate(raw, NOW)).toBe(
      midnight
        ? day
        : `${day} ${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`,
    )
  })
  it('leaves text it cannot read as it is', () => {
    expect(formatPublishedDate('3 days ago', NOW)).toBe('3 days ago')
    expect(formatPublishedDate('昨天', NOW)).toBe('昨天')
    expect(formatPublishedDate('2026-13-45T99:00:00Z', NOW)).toBe(
      '2026-13-45T99:00:00Z',
    )
  })
  it('returns nothing for an empty value', () => {
    expect(formatPublishedDate('  ', NOW)).toBe('')
  })
})
