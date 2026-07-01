import type { SessionInfo, SidebarSortMode, SidebarState } from '../types'

export interface SidebarProjectGroup {
  id: string
  name: string
  path: string
  updated_at: string
  created_at: string
  sessions: SessionInfo[]
}

export interface SidebarGroups {
  projects: SidebarProjectGroup[]
  chats: SessionInfo[]
}

export interface SidebarSearchResult {
  id: string
  title: string
  subtitle: string
  mode: 'chat' | 'build'
  projectName?: string | null
}

export interface SessionControlPendingTag {
  label: string
  tone: 'blue' | 'green'
}

export const defaultSidebarState: SidebarState = {
  section_order: ['projects', 'chats'],
  project_sort: 'updated_at',
  chat_sort: 'updated_at',
  project_order: [],
  chat_order: [],
  project_session_order: {},
  collapsed_project_ids: [],
}

export function normalizeSidebarState(value: Partial<SidebarState> | null | undefined): SidebarState {
  return {
    section_order: normalizeSectionOrder(value?.section_order),
    project_sort: normalizeSort(value?.project_sort),
    chat_sort: normalizeSort(value?.chat_sort),
    project_order: arrayOfStrings(value?.project_order),
    chat_order: arrayOfStrings(value?.chat_order),
    project_session_order: normalizeProjectSessionOrder(value?.project_session_order),
    collapsed_project_ids: arrayOfStrings(value?.collapsed_project_ids),
  }
}

export function buildSidebarGroups(sessions: SessionInfo[], stateInput: Partial<SidebarState> | null | undefined): SidebarGroups {
  const state = normalizeSidebarState(stateInput)
  const visible = sessions.filter((session) => !session.archived_at)
  const chats = sortSessions(
    visible.filter((session) => session.mode !== 'build'),
    state.chat_sort,
    state.chat_order,
  )
  const projectMap = new Map<string, SidebarProjectGroup>()
  for (const session of visible) {
    if (session.mode !== 'build') continue
    const id = session.project_id || session.project_path || 'missing-project'
    const existing = projectMap.get(id)
    if (existing) {
      existing.sessions.push(session)
      existing.updated_at = maxIso(existing.updated_at, session.updated_at)
      existing.created_at = minIso(existing.created_at, session.created_at)
      continue
    }
    projectMap.set(id, {
      id,
      name: session.project_name || '未绑定项目',
      path: session.project_path || '项目路径不可用',
      updated_at: session.updated_at,
      created_at: session.created_at,
      sessions: [session],
    })
  }
  const projects = [...projectMap.values()].map((project) => ({
    ...project,
    sessions: sortSessions(
      project.sessions,
      state.project_sort,
      state.project_session_order[project.id] || [],
    ),
  }))
  return {
    projects: sortProjects(projects, state.project_sort, state.project_order),
    chats,
  }
}

export function searchSidebarSessions(sessions: SessionInfo[], query: string): SidebarSearchResult[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return sessions
    .filter((session) => !session.archived_at)
    .filter((session) => searchableText(session).includes(needle))
    .slice(0, 12)
    .map((session) => ({
      id: session.id,
      title: session.title || '新会话',
      subtitle: session.mode === 'build'
        ? [session.project_name, session.project_path].filter(Boolean).join(' · ')
        : (session.updated_at || '').slice(0, 10),
      mode: session.mode === 'build' ? 'build' : 'chat',
      projectName: session.project_name,
    }))
}

export function sessionControlPendingTag(session: SessionInfo): SessionControlPendingTag | null {
  const pending = session.control_pending
  if (!pending?.interaction_id) return null
  if (pending.kind === 'plan') {
    return { label: pending.label || '计划需要用户确认', tone: 'green' }
  }
  if (pending.kind === 'ask') {
    return { label: pending.label || '需要用户输入', tone: 'blue' }
  }
  return null
}

function sortSessions(items: SessionInfo[], mode: SidebarSortMode, manualOrder: string[]): SessionInfo[] {
  return [...items].sort((a, b) => {
    const manual = compareManual(a.id, b.id, manualOrder)
    if (mode === 'manual' && manual !== 0) return manual
    if (mode === 'created_at') return compareDate(a.created_at, b.created_at)
    return compareDate(a.updated_at, b.updated_at)
  })
}

function sortProjects(items: SidebarProjectGroup[], mode: SidebarSortMode, manualOrder: string[]): SidebarProjectGroup[] {
  return [...items].sort((a, b) => {
    const manual = compareManual(a.id, b.id, manualOrder)
    if (mode === 'manual' && manual !== 0) return manual
    if (mode === 'created_at') return compareDate(a.created_at, b.created_at)
    return compareDate(a.updated_at, b.updated_at)
  })
}

function compareManual(a: string, b: string, order: string[]): number {
  const ai = order.indexOf(a)
  const bi = order.indexOf(b)
  if (ai === -1 && bi === -1) return 0
  if (ai === -1) return 1
  if (bi === -1) return -1
  return ai - bi
}

function compareDate(a = '', b = ''): number {
  return b.localeCompare(a)
}

function maxIso(a: string, b: string): string {
  return a.localeCompare(b) >= 0 ? a : b
}

function minIso(a: string, b: string): string {
  return a.localeCompare(b) <= 0 ? a : b
}

function searchableText(session: SessionInfo): string {
  return [
    session.title,
    session.mode === 'build' ? session.project_name : '',
    session.mode === 'build' ? session.project_path : '',
  ].filter(Boolean).join('\n').toLowerCase()
}

function normalizeSort(value: unknown): SidebarSortMode {
  return value === 'manual' || value === 'created_at' || value === 'updated_at' ? value : 'updated_at'
}

function normalizeSectionOrder(value: unknown): Array<'projects' | 'chats'> {
  const out = arrayOfStrings(value).filter((item): item is 'projects' | 'chats' => item === 'projects' || item === 'chats')
  for (const item of defaultSidebarState.section_order) {
    if (!out.includes(item)) out.push(item)
  }
  return out.slice(0, 2)
}

function normalizeProjectSessionOrder(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [key, sessionIds] of Object.entries(value)) {
    out[key] = arrayOfStrings(sessionIds)
  }
  return out
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item)).filter(Boolean)
}
