import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../types'
import { shownSessionTarget } from './appMode'
import {
  arrangeSearchResults,
  searchContentResults,
  searchSidebarSessions,
  type SidebarSearchResult,
} from './sidebarModel'

// MOD-04 (docs/design/modes.md § 侧栏): the search finds sessions of every
// mode, tags each with Chat / Build / Group, puts the current mode first,
// shows a group member's session as its group and never a trial session.

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: overrides.id || 's',
    title: overrides.id || 's',
    created_at: '2026-10-20T00:00:00.000Z',
    updated_at: '2026-10-20T00:00:00.000Z',
    preview: '',
    mode: 'chat',
    version: 1,
    ...overrides,
  }
}

const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}T08:00:00.000Z`

const sessions: SessionInfo[] = [
  session({ id: 'chat-1', title: '方案 一', updated_at: day(20) }),
  session({
    id: 'build-1',
    title: '方案 二',
    updated_at: day(26),
    mode: 'build',
    project_id: 'p1',
    project_name: 'Alpha',
    project_path: '/work/alpha',
  }),
  // A Chat session bound to a project mid-way is Build (D2).
  session({
    id: 'bound-1',
    title: '方案 三',
    updated_at: day(22),
    project_id: 'p2',
    project_name: 'Beta',
    project_path: '/work/beta',
  }),
  session({
    id: 'group-1',
    title: '设置页评审',
    updated_at: day(24),
    surface: 'group',
    group_id: 'g1',
  }),
  session({
    id: 'member-1',
    title: '方案 审稿人',
    updated_at: day(25),
    surface: 'group_member',
    group_id: 'g1',
  }),
  session({
    id: 'member-orphan',
    title: '方案 无群',
    surface: 'group_member',
    group_id: 'gone',
  }),
  session({ id: 'trial-1', title: '方案 试用', surface: 'trial' }),
  session({
    id: 'contact-1',
    title: '方案 单聊',
    updated_at: day(21),
    surface: 'contact',
  }),
]

describe('shownSessionTarget (MOD-04 5–6)', () => {
  it('shows a listed session as itself, with its mode', () => {
    expect(shownSessionTarget('build-1', sessions)).toEqual({
      id: 'build-1',
      mode: 'build',
    })
    expect(shownSessionTarget('bound-1', sessions)).toEqual({
      id: 'bound-1',
      mode: 'build',
    })
  })

  it('shows a group member’s session as its group', () => {
    expect(shownSessionTarget('member-1', sessions)).toEqual({
      id: 'group-1',
      mode: 'group',
    })
  })

  it('shows nothing for a trial session or a member without a listed group', () => {
    expect(shownSessionTarget('trial-1', sessions)).toBeNull()
    expect(shownSessionTarget('member-orphan', sessions)).toBeNull()
  })

  it('leaves a session the list does not know alone (a subagent’s page)', () => {
    expect(shownSessionTarget('child-9', sessions)).toEqual({
      id: 'child-9',
      mode: null,
    })
  })
})

describe('searchSidebarSessions across modes (MOD-04 1, 3, 5, 6)', () => {
  it('finds sessions of every mode and tags each', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const results = searchSidebarSessions(sessions, '方案')
    expect(results.map((result) => [result.id, result.mode])).toEqual([
      ['chat-1', 'chat'],
      ['build-1', 'build'],
      ['bound-1', 'build'],
      // member-1 matched: its group shows instead.
      ['group-1', 'group'],
      ['contact-1', 'group'],
    ])
    expect(results.find((result) => result.id === 'bound-1')).toMatchObject({
      projectName: 'Beta',
      subtitle: expect.stringContaining('Beta'),
      updatedAt: day(22),
    })
    warn.mockRestore()
  })

  it('shows a group once when it and its member both match', () => {
    const results = searchSidebarSessions(
      [
        session({ id: 'g', title: '评审', surface: 'group', group_id: 'x' }),
        session({
          id: 'm',
          title: '评审 记录',
          surface: 'group_member',
          group_id: 'x',
        }),
      ],
      '评审',
    )
    expect(results.map((result) => result.id)).toEqual(['g'])
  })
})

describe('searchContentResults (MOD-04 5–6)', () => {
  it('folds a member hit into its group, drops a trial and keeps an unknown one untagged', () => {
    const results = searchContentResults(
      [
        {
          sessionId: 'member-1',
          title: '审稿人',
          role: 'assistant',
          snippet: '…方案…',
        },
        {
          sessionId: 'trial-1',
          title: '试用',
          role: 'user',
          snippet: '…方案…',
        },
        {
          sessionId: 'old-1',
          title: '归档的',
          role: 'user',
          snippet: '…方案…',
        },
        {
          sessionId: 'chat-1',
          title: '方案 一',
          role: 'user',
          snippet: '…方案…',
        },
      ],
      sessions,
    )
    expect(results.map((result) => [result.id, result.mode])).toEqual([
      ['group-1', 'group'],
      ['old-1', null],
      ['chat-1', 'chat'],
    ])
    expect(results[0]).toMatchObject({
      title: '设置页评审',
      subtitle: '助手：…方案…',
      group: 'content',
    })
  })
})

describe('arrangeSearchResults (MOD-04 2)', () => {
  const result = (
    id: string,
    mode: SidebarSearchResult['mode'],
    updatedAt: string,
    group: 'title' | 'content' = 'title',
  ): SidebarSearchResult => ({
    id,
    title: id,
    subtitle: '',
    mode,
    updatedAt,
    group,
  })

  it('puts the current mode first, the rest by time', () => {
    const sections = arrangeSearchResults(
      [
        result('chat-old', 'chat', day(10)),
        result('build-a', 'build', day(12)),
        result('group-new', 'group', day(26)),
        result('chat-new', 'chat', day(25)),
        result('build-b', 'build', day(20)),
        result('unknown', null, day(27), 'content'),
        result('build-c', 'build', day(23), 'content'),
      ],
      'build',
    )
    expect(sections.map((section) => section.key)).toEqual(['current', 'other'])
    expect(sections[0]!.mode).toBe('build')
    // Titles first, then what was said in a session; each by time.
    expect(sections[0]!.results.map((item) => item.id)).toEqual([
      'build-b',
      'build-a',
      'build-c',
    ])
    expect(sections[1]!.results.map((item) => item.id)).toEqual([
      'group-new',
      'chat-new',
      'chat-old',
      'unknown',
    ])
  })

  it('drops a content hit already found by its title, and empty sections', () => {
    const sections = arrangeSearchResults(
      [
        result('chat-1', 'chat', day(20)),
        result('chat-1', 'chat', day(20), 'content'),
      ],
      'build',
    )
    expect(sections.map((section) => section.key)).toEqual(['other'])
    expect(sections[0]!.results).toHaveLength(1)
    expect(sections[0]!.results[0]!.group).toBe('title')
    expect(arrangeSearchResults([], 'chat')).toEqual([])
  })
})
