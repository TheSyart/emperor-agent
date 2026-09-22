import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../types'
import {
  groupSessionsByDay,
  sidebarDayKey,
  sidebarRelativeTime,
} from './sidebarModel'

const NOW = new Date('2026-09-22T15:00:00').getTime()

function session(id: string, updated: string): SessionInfo {
  return {
    id,
    title: id,
    created_at: updated,
    updated_at: updated,
    preview: '',
    version: 1,
  }
}

describe('sidebar day groups', () => {
  it('buckets timestamps by local calendar day', () => {
    expect(sidebarDayKey('2026-09-22T01:00:00', NOW)).toBe('today')
    expect(sidebarDayKey('2026-09-21T23:00:00', NOW)).toBe('yesterday')
    expect(sidebarDayKey('2026-09-17T12:00:00', NOW)).toBe('week')
    expect(sidebarDayKey('2026-09-01T12:00:00', NOW)).toBe('month')
    expect(sidebarDayKey('2025-01-01T12:00:00', NOW)).toBe('older')
    expect(sidebarDayKey(undefined, NOW)).toBe('older')
  })

  it('keeps input order and only breaks groups where the bucket changes', () => {
    const groups = groupSessionsByDay(
      [
        session('a', '2026-09-22T10:00:00'),
        session('b', '2026-09-22T09:00:00'),
        session('c', '2026-09-21T09:00:00'),
        session('d', '2024-01-01T09:00:00'),
      ],
      NOW,
    )
    expect(groups.map((group) => group.label)).toEqual(['今天', '昨天', '更早'])
    expect(groups[0]!.sessions.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('formats compact relative times', () => {
    expect(sidebarRelativeTime('2026-09-22T14:59:40', NOW)).toBe('刚刚')
    expect(sidebarRelativeTime('2026-09-22T14:30:00', NOW)).toBe('30 分钟')
    expect(sidebarRelativeTime('2026-09-22T12:00:00', NOW)).toBe('3 小时')
    expect(sidebarRelativeTime('2026-09-20T15:00:00', NOW)).toBe('2 天')
    expect(sidebarRelativeTime('2025-01-02T15:00:00', NOW)).toBe('2025-01-02')
  })
})
