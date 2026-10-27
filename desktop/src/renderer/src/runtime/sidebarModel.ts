import type {
  ProjectInfo,
  SessionInfo,
  SidebarSortMode,
  SidebarSectionKey,
  SidebarState,
} from '../types'
import {
  isAppMode,
  isListedSession,
  normalizeModeRoutes,
  sessionAppMode,
  shownSessionTarget,
  type AppMode,
} from './appMode'

export interface SidebarProjectGroup {
  id: string
  name: string
  path: string
  updated_at: string
  created_at: string
  sessions: SessionInfo[]
}

export interface SidebarGroups {
  /** Pinned sessions in pin order (stale / archived / draft ids dropped). */
  pinned: SessionInfo[]
  projects: SidebarProjectGroup[]
  chats: SessionInfo[]
}

export interface SidebarSearchResult {
  id: string
  title: string
  subtitle: string
  /** The mode it opens in, shown as its tag (MOD-04); null: not known. */
  mode: AppMode | null
  projectName?: string | null
  /** A title match, or a session found by what was said in it (UI-S11). */
  group?: 'title' | 'content'
  /** The shown session's last change, for the order. */
  updatedAt?: string
}

/** One answer of Core's content search (`sessions.search`). */
export interface ContentSearchHit {
  sessionId: string
  title: string
  role: 'user' | 'assistant'
  snippet: string
}

/**
 * The search results by mode (MOD-04): the current mode's, then the rest
 * (「其他模式」). Empty sections are left out.
 */
export interface SearchSection {
  key: 'current' | 'other'
  /** The current mode for `current`; null for `other`. */
  mode: AppMode | null
  results: SidebarSearchResult[]
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
  collapsed_sections: [],
  pinned_session_ids: [],
  right_workspace: {
    version: 3,
    workbenchOpen: false,
    width: 840,
    filesTreeWidth: 280,
    pane: 'launcher',
  },
  app_mode: 'chat',
  mode_routes: {},
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
    collapsed_sections: normalizeCollapsedSections(value?.collapsed_sections),
    pinned_session_ids: normalizePinnedSessionIds(value?.pinned_session_ids),
    right_workspace: normalizeRightWorkspace(value?.right_workspace),
    // Core fills a missing mode from the sessions; Chat is the last resort.
    app_mode: normalizeAppMode(value?.app_mode),
    mode_routes: normalizeModeRoutes(value?.mode_routes),
  }
}

/** Max pinned sessions (mirrors Core `normalizeSidebarState`). */
export const MAX_PINNED_SESSIONS = 50

/**
 * Pinned session ids in pin order: strings only, trimmed, first occurrence
 * wins, capped at {@link MAX_PINNED_SESSIONS} (the first ones are kept).
 * Same rules as Core, so a round trip never reorders or grows the list.
 */
export function normalizePinnedSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || id.length > 256 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_PINNED_SESSIONS) break
  }
  return out
}

/**
 * Pin `id` at the top of the pinned list. Returns null when the list is
 * already full (the caller tells the user instead of silently dropping the
 * oldest pin); an already pinned id keeps its place.
 */
export function pinSessionId(ids: string[], id: string): string[] | null {
  const target = id.trim()
  if (!target || ids.includes(target)) return ids
  if (ids.length >= MAX_PINNED_SESSIONS) return null
  return [target, ...ids]
}

export function unpinSessionId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : ids
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
  // P1-6：draft 会话未发首条消息前不出现在侧边栏. MOD-01: only Chat and
  // Build sessions (by `sessionAppMode`) — a group member's or a trial
  // session is listed nowhere, and Group sessions get their own sections.
  // MOD-02: 项目 / 对话 split by the current project binding (D2), not by
  // `mode`: a Chat session bound mid-way sits under its project, an old
  // Build session with no project path under 对话.
  const listed = sessions.filter((session) => {
    if (!isListedSession(session)) return false
    return sessionAppMode(session) !== 'group'
  })
  // Pinned sessions only show in the 置顶 section (pin order); ids that no
  // longer match a listed session are stale and ignored.
  const byId = new Map(listed.map((session) => [session.id, session]))
  const pinned = state.pinned_session_ids
    .map((id) => byId.get(id))
    .filter((session): session is SessionInfo => Boolean(session))
  const pinnedIds = new Set(pinned.map((session) => session.id))
  const visible = listed.filter((session) => !pinnedIds.has(session.id))
  const chats = sortSessions(
    visible.filter((session) => sessionAppMode(session) === 'chat'),
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
    if (sessionAppMode(session) !== 'build') continue
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
    pinned,
    projects: sortProjects(projects, state.project_sort, state.project_order),
    chats,
  }
}

/** The pinned sessions of one mode, in pin order (MOD-02: 置顶 per mode). */
export function pinnedInMode(
  pinned: SessionInfo[],
  mode: AppMode,
): SessionInfo[] {
  return pinned.filter((session) => sessionAppMode(session) === mode)
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

/** Most search results by title. */
const SEARCH_TITLE_LIMIT = 12

/**
 * Sessions whose title, project name or path match, in every mode, each
 * tagged with the mode it opens in (MOD-04). A hit shows the listed
 * session it belongs to (shownSessionTarget): a group member's session
 * shows its group, once; a trial session, a draft or one nobody lists
 * never shows (MOD-01).
 */
export function searchSidebarSessions(
  sessions: SessionInfo[],
  query: string,
): SidebarSearchResult[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const seen = new Set<string>()
  const out: SidebarSearchResult[] = []
  for (const session of sessions) {
    if (!searchableText(session).includes(needle)) continue
    const target = shownSessionTarget(session.id, sessions)
    const shown = target ? byId.get(target.id) : undefined
    if (!target?.mode || !shown || seen.has(shown.id)) continue
    seen.add(shown.id)
    out.push(titleResult(shown, target.mode))
    if (out.length >= SEARCH_TITLE_LIMIT) break
  }
  return out
}

function titleResult(session: SessionInfo, mode: AppMode): SidebarSearchResult {
  const project = session.project_path?.trim() ? session.project_name : ''
  return {
    id: session.id,
    title: session.title || '新会话',
    subtitle: [project, sidebarRelativeTime(session.updated_at)]
      .filter(Boolean)
      .join(' · '),
    mode,
    projectName: session.project_name,
    group: 'title',
    updatedAt: session.updated_at,
  }
}

/**
 * Content search hits as results (MOD-04): each shows the session it
 * belongs to like a title hit (a member's hit shows its group, a trial's
 * none), once; a session the list does not know stays, untagged.
 */
export function searchContentResults(
  hits: ContentSearchHit[],
  sessions: SessionInfo[],
): SidebarSearchResult[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const seen = new Set<string>()
  const out: SidebarSearchResult[] = []
  for (const hit of hits) {
    const target = shownSessionTarget(hit.sessionId, sessions)
    if (!target || seen.has(target.id)) continue
    seen.add(target.id)
    const shown = byId.get(target.id)
    out.push({
      id: target.id,
      title: shown?.title || hit.title || '新会话',
      subtitle: `${hit.role === 'user' ? '你' : '助手'}：${hit.snippet}`,
      mode: target.mode,
      group: 'content',
      updatedAt: shown?.updated_at ?? '',
    })
  }
  return out
}

function searchTime(result: SidebarSearchResult): number {
  const time = Date.parse(result.updatedAt ?? '')
  return Number.isFinite(time) ? time : 0
}

/** Title hits first, then content hits; each most recent first. */
function searchOrder(results: SidebarSearchResult[]): SidebarSearchResult[] {
  const byTime = (a: SidebarSearchResult, b: SidebarSearchResult) =>
    searchTime(b) - searchTime(a)
  return [
    ...results.filter((item) => item.group !== 'content').sort(byTime),
    ...results.filter((item) => item.group === 'content').sort(byTime),
  ]
}

/**
 * The results by mode (MOD-04): the current mode's first, then every other
 * mode's together by time (「其他模式」). A content hit already found by
 * its title is dropped.
 */
export function arrangeSearchResults(
  results: SidebarSearchResult[],
  current: AppMode,
): SearchSection[] {
  const titled = new Set(
    results.filter((item) => item.group !== 'content').map((item) => item.id),
  )
  const kept = results.filter(
    (item) => item.group !== 'content' || !titled.has(item.id),
  )
  const sections: SearchSection[] = [
    {
      key: 'current',
      mode: current,
      results: searchOrder(kept.filter((item) => item.mode === current)),
    },
    {
      key: 'other',
      mode: null,
      results: searchOrder(kept.filter((item) => item.mode !== current)),
    },
  ]
  return sections.filter((section) => section.results.length)
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
  // The project counts while the session is bound to it (D2), not by `mode`.
  const bound = Boolean(session.project_path?.trim())
  return [
    session.title,
    bound ? session.project_name : '',
    bound ? session.project_path : '',
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

function normalizeAppMode(value: unknown): AppMode {
  return isAppMode(value) ? value : 'chat'
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

const SECTION_KEYS: readonly SidebarSectionKey[] = [
  'pinned',
  'projects',
  'chats',
  'chats.today',
  'chats.yesterday',
  'chats.week',
  'chats.month',
  'chats.older',
]

/** Folded sections like Core: known keys only, each once (BUG-06). */
function normalizeCollapsedSections(value: unknown): SidebarSectionKey[] {
  return [...new Set(arrayOfStrings(value))].filter(
    (key): key is SidebarSectionKey =>
      SECTION_KEYS.includes(key as SidebarSectionKey),
  )
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

// ── 按天分组（M4a 侧栏：今天 / 昨天 / 7 天内 / 30 天内 / 更早；MOD-03 起是 Chat 的分区标题） ──

/**
 * Move `id` one step among `visible` (the rows on screen, a subset of `ids`
 * in the same order) and return the whole list: the ids of other modes keep
 * their places. Unchanged (same array) at an edge or for an unknown id.
 */
export function moveIdAmong(
  ids: string[],
  visible: string[],
  id: string,
  delta: -1 | 1,
): string[] {
  const at = visible.indexOf(id)
  const neighbour = at < 0 ? undefined : visible[at + delta]
  if (!neighbour) return ids
  const from = ids.indexOf(id)
  const to = ids.indexOf(neighbour)
  if (from < 0 || to < 0) return ids
  const next = [...ids]
  next[from] = neighbour
  next[to] = id
  return next
}

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
 * Split an already-sorted session list into day groups by `by` (the field
 * the list is sorted by; `updated_at` by default). Order inside and across
 * groups follows the input. Each bucket is one Chat section heading
 * (MOD-03), so it appears once: a stray session of an earlier bucket (an
 * odd timestamp) joins that group.
 */
export function groupSessionsByDay(
  sessions: SessionInfo[],
  now: number = Date.now(),
  by: 'updated_at' | 'created_at' = 'updated_at',
): SidebarDayGroup[] {
  const groups: SidebarDayGroup[] = []
  const byKey = new Map<SidebarDayGroup['key'], SidebarDayGroup>()
  for (const session of sessions) {
    const stamp =
      by === 'created_at'
        ? session.created_at || session.updated_at
        : session.updated_at || session.created_at
    const key = sidebarDayKey(stamp, now)
    const group = byKey.get(key)
    if (group) {
      group.sessions.push(session)
      continue
    }
    const created = { key, label: DAY_GROUP_LABELS[key], sessions: [session] }
    byKey.set(key, created)
    groups.push(created)
  }
  return groups
}

/**
 * Compact relative time for a sidebar row, never an ISO date (UI-S11):
 * 刚刚 / 5 分钟 / 3 小时 (today) / 昨天 / 2 天 (within a week) / 9月10日
 * (this year) / 2025/12/31 (earlier years).
 */
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
  const today = startOfDay(now)
  const day = 24 * 60 * minute
  if (time >= today) return `${Math.floor(diff / (60 * minute))} 小时`
  if (time >= today - day) return '昨天'
  const days = Math.round((today - startOfDay(time)) / day)
  if (days < 7) return `${days} 天`
  const date = new Date(time)
  if (date.getFullYear() === new Date(now).getFullYear())
    return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}
