import { describe, expect, it } from 'vitest'
import type { ProjectInfo, SessionInfo, SidebarState } from '../types'

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: overrides.id || 's',
    title: overrides.title || 'Untitled',
    created_at: overrides.created_at || '2026-01-01T00:00:00+0800',
    updated_at: overrides.updated_at || '2026-01-01T00:00:00+0800',
    preview: overrides.preview || '',
    mode: overrides.mode || 'chat',
    version: 1,
    ...overrides,
  }
}

function state(overrides: Partial<SidebarState> = {}): SidebarState {
  return {
    section_order: ['projects', 'chats'],
    project_sort: 'updated_at',
    chat_sort: 'updated_at',
    project_order: [],
    chat_order: [],
    project_session_order: {},
    collapsed_project_ids: [],
    pinned_session_ids: [],
    right_workspace: {
      version: 3,
      workbenchOpen: false,
      width: 840,
      filesTreeWidth: 280,
      pane: 'launcher',
    },
    ...overrides,
  }
}

function project(overrides: Partial<ProjectInfo>): ProjectInfo {
  return {
    project_id: overrides.project_id || 'p',
    project_path: overrides.project_path || '/tmp/project',
    project_name: overrides.project_name || 'Project',
    created_at: overrides.created_at || '2026-01-01T00:00:00+0800',
    updated_at: overrides.updated_at || '2026-01-01T00:00:00+0800',
    ...overrides,
  }
}

describe('sidebar model', () => {
  it('groups build sessions by project and excludes archived sessions', async () => {
    const { buildSidebarGroups } = await import('./sidebarModel')
    const grouped = buildSidebarGroups(
      [
        session({ id: 'chat-1', title: 'Chat A', mode: 'chat' }),
        session({
          id: 'archived',
          title: 'Old',
          archived_at: '2026-01-02T00:00:00+0800',
        }),
        session({
          id: 'build-1',
          title: 'Build A',
          mode: 'build',
          project_id: 'p1',
          project_name: 'Alpha',
          project_path: '/tmp/alpha',
        }),
        session({
          id: 'build-2',
          title: 'Build B',
          mode: 'build',
          project_id: 'p1',
          project_name: 'Alpha',
          project_path: '/tmp/alpha',
        }),
      ],
      state(),
    )

    expect(grouped.chats.map((item) => item.id)).toEqual(['chat-1'])
    expect(grouped.projects).toHaveLength(1)
    expect(grouped.projects[0].id).toBe('p1')
    expect(grouped.projects[0].sessions.map((item) => item.id)).toEqual([
      'build-1',
      'build-2',
    ])
  })

  it('uses manual order before falling back to updated time', async () => {
    const { buildSidebarGroups } = await import('./sidebarModel')
    const grouped = buildSidebarGroups(
      [
        session({ id: 'chat-old', updated_at: '2026-01-01T00:00:00+0800' }),
        session({ id: 'chat-new', updated_at: '2026-01-03T00:00:00+0800' }),
        session({
          id: 'build-a',
          mode: 'build',
          project_id: 'project-a',
          project_name: 'A',
          updated_at: '2026-01-04T00:00:00+0800',
        }),
        session({
          id: 'build-b',
          mode: 'build',
          project_id: 'project-b',
          project_name: 'B',
          updated_at: '2026-01-05T00:00:00+0800',
        }),
      ],
      state({
        chat_sort: 'manual',
        project_sort: 'manual',
        chat_order: ['chat-old'],
        project_order: ['project-a'],
      }),
    )

    expect(grouped.chats.map((item) => item.id)).toEqual([
      'chat-old',
      'chat-new',
    ])
    expect(grouped.projects.map((item) => item.id)).toEqual([
      'project-a',
      'project-b',
    ])
  })

  it('searches only session and project identity fields', async () => {
    const { searchSidebarSessions } = await import('./sidebarModel')
    const results = searchSidebarSessions(
      [
        session({
          id: 'chat-1',
          title: '分析文件夹内容',
          preview: 'mentions scheduler but should not match',
        }),
        session({
          id: 'build-1',
          title: '启动',
          mode: 'build',
          project_id: 'p1',
          project_name: 'emperor-agent',
          project_path: '/Users/me/emperor-agent',
        }),
      ],
      'emperor',
    )

    expect(results.map((item) => item.id)).toEqual(['build-1'])
    expect(
      searchSidebarSessions(
        [
          session({
            id: 'chat-1',
            title: '普通对话',
            preview: 'emperor only in preview',
          }),
        ],
        'emperor',
      ),
    ).toEqual([])
  })

  it('projects ask and plan pending tags for session rows', async () => {
    const { sessionControlPendingTag } = await import('./sidebarModel')

    expect(
      sessionControlPendingTag(
        session({
          control_pending: {
            kind: 'ask',
            label: '需要用户输入',
            tone: 'blue',
            interaction_id: 'ask_1',
            updated_at: 1,
          },
        }),
      ),
    ).toEqual({ label: '需要用户输入', tone: 'blue' })
    expect(
      sessionControlPendingTag(
        session({
          control_pending: {
            kind: 'plan',
            label: '计划需要用户确认',
            tone: 'green',
            interaction_id: 'plan_1',
            updated_at: 1,
          },
        }),
      ),
    ).toEqual({ label: '计划需要用户确认', tone: 'green' })
    expect(
      sessionControlPendingTag(session({ control_pending: null })),
    ).toBeNull()
  })
})

describe('sessionRuntimeIndicator (P1-7)', () => {
  it('prioritizes running spinner over pending tag over attention dot', async () => {
    const { sessionRuntimeIndicator } = await import('./sidebarModel')
    const pendingTag = { label: '需要用户输入', tone: 'blue' as const }
    expect(
      sessionRuntimeIndicator({ running: true, attention: true }, pendingTag),
    ).toBe('running')
    expect(
      sessionRuntimeIndicator({ running: false, attention: true }, pendingTag),
    ).toBe('pending')
    expect(
      sessionRuntimeIndicator({ running: false, attention: true }, null),
    ).toBe('attention')
    expect(
      sessionRuntimeIndicator({ running: false, attention: false }, null),
    ).toBeNull()
    expect(sessionRuntimeIndicator(undefined, null)).toBeNull()
    expect(sessionRuntimeIndicator(undefined, pendingTag)).toBe('pending')
  })
})

describe('sidebar hides draft sessions (P1-6)', () => {
  it('excludes drafts from groups and search until first message promotes them', async () => {
    const { buildSidebarGroups, searchSidebarSessions } =
      await import('./sidebarModel')
    const items = [
      session({ id: 'real-1', title: '正式会话' }),
      { ...session({ id: 'draft:x', title: '新会话' }), draft: true },
      {
        ...session({
          id: 'draft:y',
          title: '新会话',
          mode: 'build',
          project_id: 'p1',
          project_path: '/tmp/p',
          project_name: 'P',
        }),
        draft: true,
      },
    ]

    const grouped = buildSidebarGroups(items, null)

    expect(grouped.chats.map((item) => item.id)).toEqual(['real-1'])
    expect(grouped.projects).toEqual([])
    expect(searchSidebarSessions(items, '新会话')).toEqual([])
  })
})

describe('sidebar project registry projection (P1-8)', () => {
  it('shows a resolved project even before the first build session is created', async () => {
    const { buildSidebarGroups } = await import('./sidebarModel')
    const grouped = buildSidebarGroups([], state(), [
      project({
        project_id: 'p1',
        project_name: 'Alpha',
        project_path: '/tmp/alpha',
      }),
    ])

    expect(grouped.projects).toHaveLength(1)
    expect(grouped.projects[0]).toMatchObject({
      id: 'p1',
      name: 'Alpha',
      path: '/tmp/alpha',
      sessions: [],
    })
  })

  it('keeps draft build sessions hidden while preserving the empty project row', async () => {
    const { buildSidebarGroups } = await import('./sidebarModel')
    const grouped = buildSidebarGroups(
      [
        {
          ...session({
            id: 'draft:y',
            title: '新会话',
            mode: 'build',
            project_id: 'p1',
            project_path: '/tmp/alpha',
            project_name: 'Alpha',
          }),
          draft: true,
        },
      ],
      state(),
      [
        project({
          project_id: 'p1',
          project_name: 'Alpha',
          project_path: '/tmp/alpha',
        }),
      ],
    )

    expect(grouped.projects.map((item) => item.id)).toEqual(['p1'])
    expect(grouped.projects[0].sessions).toEqual([])
  })

  it('attaches promoted build sessions under the already-visible project row', async () => {
    const { buildSidebarGroups } = await import('./sidebarModel')
    const grouped = buildSidebarGroups(
      [
        session({
          id: 'build-1',
          title: '正式会话',
          mode: 'build',
          project_id: 'p1',
          project_path: '/tmp/alpha',
          project_name: 'Alpha',
        }),
      ],
      state(),
      [
        project({
          project_id: 'p1',
          project_name: 'Alpha',
          project_path: '/tmp/alpha',
        }),
      ],
    )

    expect(grouped.projects).toHaveLength(1)
    expect(grouped.projects[0].sessions.map((item) => item.id)).toEqual([
      'build-1',
    ])
  })

  it('orders empty projects with normal manual project ordering', async () => {
    const { buildSidebarGroups } = await import('./sidebarModel')
    const grouped = buildSidebarGroups(
      [
        session({
          id: 'build-b',
          mode: 'build',
          project_id: 'project-b',
          project_name: 'B',
          updated_at: '2026-01-05T00:00:00+0800',
        }),
      ],
      state({
        project_sort: 'manual',
        project_order: ['project-a'],
      }),
      [
        project({
          project_id: 'project-a',
          project_name: 'A',
          updated_at: '2026-01-04T00:00:00+0800',
        }),
        project({
          project_id: 'project-b',
          project_name: 'B',
          updated_at: '2026-01-05T00:00:00+0800',
        }),
      ],
    )

    expect(grouped.projects.map((item) => item.id)).toEqual([
      'project-a',
      'project-b',
    ])
    expect(grouped.projects[0].sessions).toEqual([])
    expect(grouped.projects[1].sessions.map((item) => item.id)).toEqual([
      'build-b',
    ])
  })
})

describe('manual ordering helpers (W6: moved out of SessionSidebar.vue)', () => {
  it('completes the manual order with unseen ids and moves items within bounds', async () => {
    const { completeManualOrder, moveId } = await import('./sidebarModel')
    expect(completeManualOrder(['b', 'ghost'], ['a', 'b', 'c'])).toEqual([
      'b',
      'a',
      'c',
    ])
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(moveId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
    expect(moveId(['a', 'b', 'c'], 'missing', 1)).toEqual(['a', 'b', 'c'])
  })
})

describe('pinned sessions', () => {
  it('normalizes pinned ids like Core: strings, trimmed, deduped, capped at 50', async () => {
    const { normalizeSidebarState, MAX_PINNED_SESSIONS } =
      await import('./sidebarModel')
    expect(normalizeSidebarState(undefined).pinned_session_ids).toEqual([])
    expect(
      normalizeSidebarState({
        pinned_session_ids: [' s-1 ', 's-1', '', 7, null, 's-2'] as never,
      }).pinned_session_ids,
    ).toEqual(['s-1', 's-2'])
    expect(
      normalizeSidebarState({
        pinned_session_ids: 'nope' as never,
      }).pinned_session_ids,
    ).toEqual([])
    const many = Array.from({ length: 60 }, (_, index) => `s-${index}`)
    const capped = normalizeSidebarState({ pinned_session_ids: many })
    expect(capped.pinned_session_ids).toHaveLength(MAX_PINNED_SESSIONS)
    expect(capped.pinned_session_ids[0]).toBe('s-0')
  })

  it('keeps the pins through a partial patch merged onto the full state', async () => {
    const { normalizeSidebarState } = await import('./sidebarModel')
    const current = normalizeSidebarState(
      state({ pinned_session_ids: ['a', 'b'] }),
    )
    const merged = normalizeSidebarState({ ...current, chat_sort: 'manual' })
    expect(merged.pinned_session_ids).toEqual(['a', 'b'])
    expect(merged.chat_sort).toBe('manual')
  })

  it('lists pinned sessions in pin order and removes them from projects and chats', async () => {
    const { buildSidebarGroups } = await import('./sidebarModel')
    const grouped = buildSidebarGroups(
      [
        session({ id: 'chat-1', mode: 'chat' }),
        session({ id: 'chat-2', mode: 'chat' }),
        session({
          id: 'build-1',
          mode: 'build',
          project_id: 'p1',
          project_name: 'Alpha',
          project_path: '/tmp/alpha',
        }),
        session({
          id: 'build-2',
          mode: 'build',
          project_id: 'p1',
          project_name: 'Alpha',
          project_path: '/tmp/alpha',
        }),
        session({
          id: 'archived',
          archived_at: '2026-01-02T00:00:00+0800',
        }),
        session({ id: 'draft:x', draft: true }),
      ],
      state({
        pinned_session_ids: [
          'build-1',
          'gone',
          'chat-2',
          'archived',
          'draft:x',
        ],
      }),
    )
    expect(grouped.pinned.map((item) => item.id)).toEqual(['build-1', 'chat-2'])
    expect(grouped.chats.map((item) => item.id)).toEqual(['chat-1'])
    expect(grouped.projects[0]?.sessions.map((item) => item.id)).toEqual([
      'build-2',
    ])
  })

  it('pins at the top, refuses past the cap and unpins', async () => {
    const { pinSessionId, unpinSessionId, MAX_PINNED_SESSIONS } =
      await import('./sidebarModel')
    expect(pinSessionId(['a'], 'b')).toEqual(['b', 'a'])
    const same = ['a', 'b']
    expect(pinSessionId(same, 'b')).toBe(same)
    const full = Array.from({ length: MAX_PINNED_SESSIONS }, (_, i) => `s${i}`)
    expect(pinSessionId(full, 'new')).toBeNull()
    expect(unpinSessionId(['a', 'b'], 'a')).toEqual(['b'])
    const untouched = ['a']
    expect(unpinSessionId(untouched, 'z')).toBe(untouched)
  })
})
