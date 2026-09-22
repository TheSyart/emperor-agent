import { describe, expect, it } from 'vitest'
import type { MemoryPayload } from '../../../types'
import {
  contextGroups,
  contextSummary,
  episodeDate,
  formatBytes,
  isBuildContext,
  longTermContent,
  longTermPath,
  onboardingLabel,
  sortedEpisodes,
  versionDescription,
  versionTargetLabel,
  watchlistFacts,
} from './memoryModel'

const chatMemory: MemoryPayload = {
  long_term: '全局偏好',
  episodes: ['memory/episodes/2026-06-24.md', 'memory/episodes/2026-06-26.md'],
  context: {
    mode: 'chat',
    sources: ['MEMORY.local.md'],
    projectIndexSummary: 'README',
    projectMemory: '项目记忆',
  },
  history: {
    active_bytes: 2048,
    active_lines: 4,
    latest_seq: 12,
    archive_files: 1,
    archive_bytes: 8192,
    needs_rotation: true,
  },
  versions: { versions: [] },
}

describe('memory model', () => {
  it('formats sizes and episode dates', () => {
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3 MB')
    expect(episodeDate('memory/episodes/2026-06-26.md')).toBe('2026-06-26')
    expect(episodeDate('2026-06-26')).toBe('2026-06-26')
    expect(sortedEpisodes(chatMemory)).toEqual([
      'memory/episodes/2026-06-26.md',
      'memory/episodes/2026-06-24.md',
    ])
    expect(sortedEpisodes(null)).toEqual([])
  })

  it('edits MEMORY.local.md in Chat and shows project memory in Build', () => {
    expect(isBuildContext(chatMemory)).toBe(false)
    expect(longTermContent(chatMemory)).toBe('全局偏好')
    expect(longTermPath(chatMemory)).toContain('MEMORY.local.md')
    const build = {
      ...chatMemory,
      context: { ...chatMemory.context, mode: 'build' },
    }
    expect(isBuildContext(build)).toBe(true)
    expect(longTermContent(build)).toBe('项目记忆')
    expect(longTermPath(build)).toContain('AGENTS.local.md')
  })

  it('groups context facts and flags attention', () => {
    const groups = contextGroups({
      ...chatMemory,
      compaction: {
        cursor: { compactedUntilSeq: 9, status: 'active' },
        archive: { archivedUntilSeq: 3, archiveBlockedUntilCompacted: true },
        latest: null,
      },
      runtime: { bytes: 10, events: 2, latestSeq: 5, activeTurns: 1 },
      schedulerMaintenance: { jobs: 1, enabled: 1, lastError: 'boom' },
    })
    expect(groups.map((group) => group.key)).toEqual([
      'context',
      'history',
      'compaction',
      'runtime',
      'maintenance',
    ])
    expect(groups.map((group) => group.warn)).toEqual([
      false,
      true,
      true,
      false,
      true,
    ])
    const context = groups[0]!.items.map((item) => [item.term, item.value])
    expect(context).toEqual([
      ['模式', 'Chat · 全局记忆'],
      ['项目索引', '已注入短摘要 · Chat 不读取项目 AGENTS.md 细节'],
      ['来源', '1 个 · MEMORY.local.md'],
    ])
    expect(groups[1]!.items[0]!.value).toBe('2 KB · 4 行 · seq 12')
    expect(groups[2]!.items[0]!.value).toBe(
      'seq 9 · active · 暂无 compaction id',
    )
    expect(groups[4]!.items[1]!.value).toBe('暂无 · Scheduler 未安排')
    expect(contextGroups(null)).toEqual([])
  })

  it('describes Build projects in the context group', () => {
    const [context] = contextGroups({
      context: {
        mode: 'build',
        project: {
          project_id: 'p',
          project_path: '/src/app',
          project_name: 'App',
          state_path: '/state',
          memory_path: '/state/memory.md',
        },
      },
    })
    expect(context!.items.map((item) => item.value)).toEqual([
      'Build · 项目记忆',
      'App',
      '/src/app',
      '已隔离 · /state/memory.md',
      '0 个',
    ])
  })

  it('summarizes the overview in one line', () => {
    expect(contextSummary(chatMemory)).toBe(
      'Chat · 全局记忆 · 热日志 2 KB · 1 个来源 · 0 个版本',
    )
    expect(contextSummary(null)).toBe('暂无记忆数据')
    expect(contextSummary({})).toBe('暂无统计')
  })

  it('labels versions, onboarding and watchlist decisions', () => {
    expect(versionTargetLabel('user')).toBe('用户档案')
    expect(versionTargetLabel('custom')).toBe('custom')
    expect(
      versionDescription({
        id: 'v1',
        target: 'memory',
        relPath: 'memory/MEMORY.local.md',
        label: '',
        reason: 'save',
        createdAt: 0,
        contentHash: 'x',
        bytes: 1,
      }),
    ).toMatch(/^长期记忆 · save · /)
    expect(onboardingLabel('completed')).toBe('已完成')
    expect(onboardingLabel(undefined)).toBe('待补充')
    expect(watchlistFacts(null)).toEqual([])
    expect(
      watchlistFacts({ action: 'run', reason: 'due', provider: 'p' }).map(
        (item) => item.value,
      ),
    ).toEqual(['run', 'due', 'p'])
    expect(watchlistFacts({ action: 'skip' })[2]!.value).toBe('未记录')
  })
})
