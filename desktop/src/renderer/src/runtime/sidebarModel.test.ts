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
    const grouped = buildSidebarGroups([
      session({ id: 'chat-1', title: 'Chat A', mode: 'chat' }),
      session({ id: 'archived', title: 'Old', archived_at: '2026-01-02T00:00:00+0800' }),
      session({ id: 'build-1', title: 'Build A', mode: 'build', project_id: 'p1', project_name: 'Alpha', project_path: '/tmp/alpha' }),
      session({ id: 'build-2', title: 'Build B', mode: 'build', project_id: 'p1', project_name: 'Alpha', project_path: '/tmp/alpha' }),
    ], state())

    expect(grouped.chats.map((item) => item.id)).toEqual(['chat-1'])
    expect(grouped.projects).toHaveLength(1)
    expect(grouped.projects[0].id).toBe('p1')
    expect(grouped.projects[0].sessions.map((item) => item.id)).toEqual(['build-1', 'build-2'])
  })

  it('uses manual order before falling back to updated time', async () => {
    const { buildSidebarGroups } = await import('./sidebarModel')
    const grouped = buildSidebarGroups([
      session({ id: 'chat-old', updated_at: '2026-01-01T00:00:00+0800' }),
      session({ id: 'chat-new', updated_at: '2026-01-03T00:00:00+0800' }),
      session({ id: 'build-a', mode: 'build', project_id: 'project-a', project_name: 'A', updated_at: '2026-01-04T00:00:00+0800' }),
      session({ id: 'build-b', mode: 'build', project_id: 'project-b', project_name: 'B', updated_at: '2026-01-05T00:00:00+0800' }),
    ], state({
      chat_sort: 'manual',
      project_sort: 'manual',
      chat_order: ['chat-old'],
      project_order: ['project-a'],
    }))

    expect(grouped.chats.map((item) => item.id)).toEqual(['chat-old', 'chat-new'])
    expect(grouped.projects.map((item) => item.id)).toEqual(['project-a', 'project-b'])
  })

  it('searches only session and project identity fields', async () => {
    const { searchSidebarSessions } = await import('./sidebarModel')
    const results = searchSidebarSessions([
      session({ id: 'chat-1', title: '分析文件夹内容', preview: 'mentions scheduler but should not match' }),
      session({ id: 'build-1', title: '启动', mode: 'build', project_id: 'p1', project_name: 'emperor-agent', project_path: '/Users/me/emperor-agent' }),
    ], 'emperor')

    expect(results.map((item) => item.id)).toEqual(['build-1'])
    expect(searchSidebarSessions([
      session({ id: 'chat-1', title: '普通对话', preview: 'emperor only in preview' }),
    ], 'emperor')).toEqual([])
  })

  it('projects ask and plan pending tags for session rows', async () => {
    const { sessionControlPendingTag } = await import('./sidebarModel')

    expect(sessionControlPendingTag(session({
      control_pending: {
        kind: 'ask',
        label: '需要用户输入',
        tone: 'blue',
        interaction_id: 'ask_1',
        updated_at: 1,
      },
    }))).toEqual({ label: '需要用户输入', tone: 'blue' })
    expect(sessionControlPendingTag(session({
      control_pending: {
        kind: 'plan',
        label: '计划需要用户确认',
        tone: 'green',
        interaction_id: 'plan_1',
        updated_at: 1,
      },
    }))).toEqual({ label: '计划需要用户确认', tone: 'green' })
    expect(sessionControlPendingTag(session({ control_pending: null }))).toBeNull()
  })
})

describe('sessionRuntimeIndicator (P1-7)', () => {
  it('prioritizes running spinner over pending tag over attention dot', async () => {
    const { sessionRuntimeIndicator } = await import('./sidebarModel')
    const pendingTag = { label: '需要用户输入', tone: 'blue' as const }
    expect(sessionRuntimeIndicator({ running: true, attention: true }, pendingTag)).toBe('running')
    expect(sessionRuntimeIndicator({ running: false, attention: true }, pendingTag)).toBe('pending')
    expect(sessionRuntimeIndicator({ running: false, attention: true }, null)).toBe('attention')
    expect(sessionRuntimeIndicator({ running: false, attention: false }, null)).toBeNull()
    expect(sessionRuntimeIndicator(undefined, null)).toBeNull()
    expect(sessionRuntimeIndicator(undefined, pendingTag)).toBe('pending')
  })
})

describe('sidebar hides draft sessions (P1-6)', () => {
  it('excludes drafts from groups and search until first message promotes them', async () => {
    const { buildSidebarGroups, searchSidebarSessions } = await import('./sidebarModel')
    const items = [
      session({ id: 'real-1', title: '正式会话' }),
      { ...session({ id: 'draft:x', title: '新会话' }), draft: true },
      { ...session({ id: 'draft:y', title: '新会话', mode: 'build', project_id: 'p1', project_path: '/tmp/p', project_name: 'P' }), draft: true },
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
      project({ project_id: 'p1', project_name: 'Alpha', project_path: '/tmp/alpha' }),
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
    const grouped = buildSidebarGroups([
      { ...session({ id: 'draft:y', title: '新会话', mode: 'build', project_id: 'p1', project_path: '/tmp/alpha', project_name: 'Alpha' }), draft: true },
    ], state(), [
      project({ project_id: 'p1', project_name: 'Alpha', project_path: '/tmp/alpha' }),
    ])

    expect(grouped.projects.map((item) => item.id)).toEqual(['p1'])
    expect(grouped.projects[0].sessions).toEqual([])
  })

  it('attaches promoted build sessions under the already-visible project row', async () => {
    const { buildSidebarGroups } = await import('./sidebarModel')
    const grouped = buildSidebarGroups([
      session({ id: 'build-1', title: '正式会话', mode: 'build', project_id: 'p1', project_path: '/tmp/alpha', project_name: 'Alpha' }),
    ], state(), [
      project({ project_id: 'p1', project_name: 'Alpha', project_path: '/tmp/alpha' }),
    ])

    expect(grouped.projects).toHaveLength(1)
    expect(grouped.projects[0].sessions.map((item) => item.id)).toEqual(['build-1'])
  })

  it('orders empty projects with normal manual project ordering', async () => {
    const { buildSidebarGroups } = await import('./sidebarModel')
    const grouped = buildSidebarGroups([
      session({ id: 'build-b', mode: 'build', project_id: 'project-b', project_name: 'B', updated_at: '2026-01-05T00:00:00+0800' }),
    ], state({
      project_sort: 'manual',
      project_order: ['project-a'],
    }), [
      project({ project_id: 'project-a', project_name: 'A', updated_at: '2026-01-04T00:00:00+0800' }),
      project({ project_id: 'project-b', project_name: 'B', updated_at: '2026-01-05T00:00:00+0800' }),
    ])

    expect(grouped.projects.map((item) => item.id)).toEqual(['project-a', 'project-b'])
    expect(grouped.projects[0].sessions).toEqual([])
    expect(grouped.projects[1].sessions.map((item) => item.id)).toEqual(['build-b'])
  })
})

describe('manual ordering helpers (W6: moved out of SessionSidebar.vue)', () => {
  it('completes the manual order with unseen ids and moves items within bounds', async () => {
    const { completeManualOrder, moveId } = await import('./sidebarModel')
    expect(completeManualOrder(['b', 'ghost'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(moveId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
    expect(moveId(['a', 'b', 'c'], 'missing', 1)).toEqual(['a', 'b', 'c'])
  })
})
