import type {
  ProjectInfo,
  SessionInfo,
  SidebarSortMode,
  SidebarState,
} from '../types'

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

export interface SessionRuntimeState {
  running?: boolean
  attention?: boolean
}

export type SessionRuntimeIndicator = 'running' | 'pending' | 'attention' | null

/** P1-7：session 行左侧状态槽的展示优先级 running spinner > ask/plan pending tag > attention dot。 */
export function sessionRuntimeIndicator(
  state: SessionRuntimeState | undefined,
  pendingTag: SessionControlPendingTag | null,
): SessionRuntimeIndicator {
  if (state?.running) return 'running'
  if (pendingTag) return 'pending'
  if (state?.attention) return 'attention'
  return null
}

export const defaultSidebarState: SidebarState = {
  section_order: ['projects', 'chats'],
  project_sort: 'updated_at',
  chat_sort: 'updated_at',
  project_order: [],
  chat_order: [],
  project_session_order: {},
  collapsed_project_ids: [],
  right_workspace: {
    version: 3,
    workbenchOpen: false,
    width: 840,
    filesTreeWidth: 280,
    pane: 'launcher',
  },
}

export function normalizeSidebarState(
  value: Partial<SidebarState> | null | undefined,
): SidebarState {
  return {
    section_order: normalizeSectionOrder(value?.section_order),
    project_sort: normalizeSort(value?.project_sort),
    chat_sort: normalizeSort(value?.chat_sort),
    project_order: arrayOfStrings(value?.project_order),
    chat_order: arrayOfStrings(value?.chat_order),
    project_session_order: normalizeProjectSessionOrder(
      value?.project_session_order,
    ),
    collapsed_project_ids: arrayOfStrings(value?.collapsed_project_ids),
    right_workspace: normalizeRightWorkspace(value?.right_workspace),
  }
}

function normalizeRightWorkspace(
  value:
    | (Partial<SidebarState['right_workspace']> & {
        open?: boolean
        pane?: SidebarState['right_workspace']['pane'] | 'environment'
      })
    | undefined,
): SidebarState['right_workspace'] {
  if (value?.version === 3) {
    const width = Number(value.width)
    const filesTreeWidth = Number(value.filesTreeWidth)
    return {
      version: 3,
      workbenchOpen: value.workbenchOpen === true,
      width: Number.isFinite(width)
        ? Math.max(520, Math.min(960, Math.round(width)))
        : 840,
      filesTreeWidth: Number.isFinite(filesTreeWidth)
        ? Math.max(240, Math.min(320, Math.round(filesTreeWidth)))
        : 280,
      pane:
        value.pane === 'review' ||
        value.pane === 'terminal' ||
        value.pane === 'files' ||
        value.pane === 'browser'
          ? value.pane
          : 'launcher',
    }
  }
  if (Number(value?.version) === 2) {
    const legacyV2 = value as unknown as {
      width?: number
      filesTreeWidth?: number
      pane?: string
      workbenchOpen?: boolean
    }
    const width = Number(legacyV2.width)
    const filesTreeWidth = Number(legacyV2.filesTreeWidth)
    const pane = legacyV2.pane
    return {
      version: 3,
      workbenchOpen: legacyV2.workbenchOpen === true,
      width: Number.isFinite(width)
        ? Math.max(520, Math.min(960, Math.round(width)))
        : 840,
      filesTreeWidth: Number.isFinite(filesTreeWidth)
        ? Math.max(240, Math.min(320, Math.round(filesTreeWidth)))
        : 280,
      pane:
        pane === 'review' ||
        pane === 'terminal' ||
        pane === 'files' ||
        pane === 'browser'
          ? pane
          : 'launcher',
    }
  }
  const legacy = value as
    { open?: boolean; width?: number; pane?: string } | undefined
  const width = Number(legacy?.width)
  const pane = legacy?.pane
  const open = legacy?.open === undefined ? true : legacy.open === true
  const selected =
    pane === 'review' ||
    pane === 'terminal' ||
    pane === 'files' ||
    pane === 'browser'
      ? pane
      : 'launcher'
  return {
    version: 3,
    workbenchOpen: open && selected !== 'launcher',
    width:
      Number.isFinite(width) && width >= 520
        ? Math.max(520, Math.min(960, Math.round(width)))
        : 840,
    filesTreeWidth: 280,
    pane: selected,
  }
}

export function buildSidebarGroups(
  sessions: SessionInfo[],
  stateInput: Partial<SidebarState> | null | undefined,
  projectsInput: ProjectInfo[] = [],
): SidebarGroups {
  const state = normalizeSidebarState(stateInput)
  // P1-6：draft 会话未发首条消息前不出现在侧边栏
  const visible = sessions.filter(
    (session) => !session.archived_at && !session.draft,
  )
  const chats = sortSessions(
    visible.filter((session) => session.mode !== 'build'),
    state.chat_sort,
    state.chat_order,
  )
  const projectMap = new Map<string, SidebarProjectGroup>()
  for (const project of projectsInput) {
    const group = projectGroupFromProject(project)
    if (!group) continue
    projectMap.set(group.id, group)
  }
  for (const session of visible) {
    if (session.mode !== 'build') continue
    const id = session.project_id || session.project_path || 'missing-project'
    const existing = projectMap.get(id)
    if (existing) {
      existing.sessions.push(session)
      if (existing.name === '未绑定项目' && session.project_name)
        existing.name = session.project_name
      if (existing.path === '项目路径不可用' && session.project_path)
        existing.path = session.project_path
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

function projectGroupFromProject(
  project: ProjectInfo,
): SidebarProjectGroup | null {
  const id = String(project.project_id || project.project_path || '').trim()
  if (!id) return null
  return {
    id,
    name: project.project_name || project.project_path || '未绑定项目',
    path: project.project_path || project.workspace_path || '项目路径不可用',
    updated_at: project.updated_at || project.created_at || '',
    created_at: project.created_at || project.updated_at || '',
    sessions: [],
  }
}

export function searchSidebarSessions(
  sessions: SessionInfo[],
  query: string,
): SidebarSearchResult[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return sessions
    .filter((session) => !session.archived_at && !session.draft)
    .filter((session) => searchableText(session).includes(needle))
    .slice(0, 12)
    .map((session) => ({
      id: session.id,
      title: session.title || '新会话',
      subtitle:
        session.mode === 'build'
          ? [session.project_name, session.project_path]
              .filter(Boolean)
              .join(' · ')
          : (session.updated_at || '').slice(0, 10),
      mode: session.mode === 'build' ? 'build' : 'chat',
      projectName: session.project_name,
    }))
}

export function sessionControlPendingTag(
  session: SessionInfo,
): SessionControlPendingTag | null {
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

function sortSessions(
  items: SessionInfo[],
  mode: SidebarSortMode,
  manualOrder: string[],
): SessionInfo[] {
  return [...items].sort((a, b) => {
    const manual = compareManual(a.id, b.id, manualOrder)
    if (mode === 'manual' && manual !== 0) return manual
    if (mode === 'created_at') return compareDate(a.created_at, b.created_at)
    return compareDate(a.updated_at, b.updated_at)
  })
}

function sortProjects(
  items: SidebarProjectGroup[],
  mode: SidebarSortMode,
  manualOrder: string[],
): SidebarProjectGroup[] {
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

function maxIso(a = '', b = ''): string {
  if (!a) return b
  if (!b) return a
  return a.localeCompare(b) >= 0 ? a : b
}

function minIso(a = '', b = ''): string {
  if (!a) return b
  if (!b) return a
  return a.localeCompare(b) <= 0 ? a : b
}

function searchableText(session: SessionInfo): string {
  return [
    session.title,
    session.mode === 'build' ? session.project_name : '',
    session.mode === 'build' ? session.project_path : '',
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

function normalizeSort(value: unknown): SidebarSortMode {
  return value === 'manual' || value === 'created_at' || value === 'updated_at'
    ? value
    : 'updated_at'
}

function normalizeSectionOrder(value: unknown): Array<'projects' | 'chats'> {
  const out = arrayOfStrings(value).filter(
    (item): item is 'projects' | 'chats' =>
      item === 'projects' || item === 'chats',
  )
  for (const item of defaultSidebarState.section_order) {
    if (!out.includes(item)) out.push(item)
  }
  return out.slice(0, 2)
}

function normalizeProjectSessionOrder(
  value: unknown,
): Record<string, string[]> {
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

// ── 手工排序（W6：从 SessionSidebar.vue 下沉的纯数组算法） ──

/** 把可见 id 并入既有手工顺序：保留已排序的可见项，追加未入序的新项。 */
export function completeManualOrder(
  current: string[],
  visible: string[],
): string[] {
  return [
    ...current.filter((id) => visible.includes(id)),
    ...visible.filter((id) => !current.includes(id)),
  ]
}

/** 在列表内把 id 向前/向后移动一位，越界钳制，未找到返回原列表。 */
export function moveId(ids: string[], id: string, delta: -1 | 1): string[] {
  const index = ids.indexOf(id)
  if (index < 0) return ids
  const target = Math.min(ids.length - 1, Math.max(0, index + delta))
  const next = [...ids]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  return next
}

// ── 按天分组（M4a 侧栏：今天 / 昨天 / 7 天内 / 30 天内 / 更早） ──

export interface SidebarDayGroup {
  key: 'today' | 'yesterday' | 'week' | 'month' | 'older'
  label: string
  sessions: SessionInfo[]
}

const DAY_GROUP_LABELS: Record<SidebarDayGroup['key'], string> = {
  today: '今天',
  yesterday: '昨天',
  week: '7 天内',
  month: '30 天内',
  older: '更早',
}

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Day bucket of one timestamp relative to `now` (local calendar days). */
export function sidebarDayKey(
  iso: string | undefined,
  now: number = Date.now(),
): SidebarDayGroup['key'] {
  const time = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(time)) return 'older'
  const today = startOfDay(now)
  const day = 24 * 60 * 60 * 1000
  if (time >= today) return 'today'
  if (time >= today - day) return 'yesterday'
  if (time >= today - 7 * day) return 'week'
  if (time >= today - 30 * day) return 'month'
  return 'older'
}

/**
 * Split an already-sorted session list into consecutive day groups by
 * `updated_at`. Order inside and across groups follows the input (the
 * sidebar sort), so a manual order stays intact — groups only break where
 * the bucket changes.
 */
export function groupSessionsByDay(
  sessions: SessionInfo[],
  now: number = Date.now(),
): SidebarDayGroup[] {
  const groups: SidebarDayGroup[] = []
  for (const session of sessions) {
    const key = sidebarDayKey(session.updated_at || session.created_at, now)
    const last = groups.at(-1)
    if (last && last.key === key) last.sessions.push(session)
    else groups.push({ key, label: DAY_GROUP_LABELS[key], sessions: [session] })
  }
  return groups
}

/** Compact relative time for a sidebar row (刚刚 / 5 分钟 / 3 小时 / 2 天 / 2026-01-02). */
export function sidebarRelativeTime(
  iso: string | undefined,
  now: number = Date.now(),
): string {
  const time = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(time)) return ''
  const diff = Math.max(0, now - time)
  const minute = 60 * 1000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时`
  if (diff < 30 * 24 * 60 * minute)
    return `${Math.floor(diff / (24 * 60 * minute))} 天`
  return (iso || '').slice(0, 10)
}
