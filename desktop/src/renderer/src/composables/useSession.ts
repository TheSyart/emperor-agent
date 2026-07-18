import { ref, computed } from 'vue'
import { core } from '../api/http'
import type {
  ControlInteraction,
  ProjectInfo,
  SessionControlPending,
  SessionInfo,
  SessionMode,
  WsEvent,
} from '../types'
import {
  applySessionCreated,
  applySessionTitleUpdated,
  createDraftSession,
  isDraftSessionId,
} from '../runtime/sessionDrafts'

const sessions = ref<SessionInfo[]>([])
const projects = ref<ProjectInfo[]>([])
const activeId = ref<string>('')
const loading = ref(false)
const creating = ref(false)
const sessionActionError = ref('')

export interface CreateSessionDraftOptions {
  title?: string
  mode?: SessionMode
  project?: ProjectInfo
}

export function useSession() {
  const active = computed(() =>
    sessions.value.find((s) => s.id === activeId.value),
  )
  const canDeletePersistedSession = computed(
    () => sessions.value.filter((session) => !session.draft).length > 1,
  )

  async function load() {
    loading.value = true
    try {
      const [sessionItems, projectItems] = await Promise.all([
        core('sessions.list', { includeArchived: false }),
        core('projects.list'),
      ])
      sessions.value = sessionItems
      projects.value = normalizeProjects(projectItems)
      if (!sessions.value.length) {
        await create({ mode: 'chat', title: '新会话' })
      } else if (
        !activeId.value ||
        !sessions.value.some((session) => session.id === activeId.value)
      ) {
        activeId.value = sessions.value[0].id
      }
    } finally {
      loading.value = false
    }
  }

  async function loadArchived(): Promise<SessionInfo[]> {
    return core('sessions.list', { includeArchived: true })
  }

  /**
   * P1-6 懒创建：只建本地隐藏 draft，不 POST、不落盘。
   * 首条消息提交时由 Core 创建真实 session 并通过 session_created 事件晋升。
   */
  async function create(
    options: string | CreateSessionDraftOptions = '新会话',
  ): Promise<SessionInfo> {
    const opts = typeof options === 'string' ? { title: options } : options
    const mode: SessionMode = opts.mode === 'build' ? 'build' : 'chat'
    const draft = createDraftSession({
      title: opts.title,
      mode,
      projectId: opts.project?.project_id,
      projectPath: opts.project?.project_path,
      projectName: opts.project?.project_name,
    })
    sessions.value = [
      draft,
      ...sessions.value.filter((session) => !session.draft),
    ]
    activeId.value = draft.id
    return draft
  }

  async function resolveProject(path: string): Promise<ProjectInfo> {
    const project = await core('projects.resolve', path)
    upsertProject(project)
    return project
  }

  async function remove(id: string): Promise<boolean> {
    sessionActionError.value = ''
    if (isDraftSessionId(id)) {
      sessions.value = sessions.value.filter((s) => s.id !== id)
      if (activeId.value === id) activeId.value = sessions.value[0]?.id || ''
      if (!sessions.value.length) await create()
      return true
    }
    try {
      await core('sessions.delete', id)
      sessions.value = sessions.value.filter((s) => s.id !== id)
      if (activeId.value === id) activeId.value = sessions.value[0]?.id || ''
      if (!sessions.value.length) await create()
      return true
    } catch (error) {
      sessionActionError.value =
        error instanceof Error ? error.message : String(error)
      return false
    }
  }

  async function rename(id: string, title: string): Promise<boolean> {
    if (isDraftSessionId(id)) {
      const hit = sessions.value.find((s) => s.id === id)
      if (hit) hit.title = title
      return true
    }
    try {
      await core('sessions.rename', id, { title })
      const hit = sessions.value.find((s) => s.id === id)
      if (hit) hit.title = title
      return true
    } catch {
      return false
    }
  }

  async function archive(id: string, archived: boolean): Promise<boolean> {
    if (isDraftSessionId(id)) {
      if (archived) {
        sessions.value = sessions.value.filter((s) => s.id !== id)
        if (activeId.value === id) activeId.value = sessions.value[0]?.id || ''
      }
      return true
    }
    try {
      const updated = await core('sessions.rename', id, {
        archived,
      })
      if (archived) {
        sessions.value = sessions.value.filter((s) => s.id !== id)
        if (activeId.value === id) activeId.value = sessions.value[0]?.id || ''
        if (!sessions.value.length) await create()
      } else {
        const index = sessions.value.findIndex((s) => s.id === id)
        if (index >= 0) sessions.value[index] = updated
        else sessions.value.unshift(updated)
      }
      return true
    } catch {
      return false
    }
  }

  async function activate(id: string): Promise<void> {
    activeId.value = id
    if (!isDraftSessionId(id)) {
      await core('sessions.activate', id).catch(() => undefined)
    }
  }

  function applySessionCreatedEvent(
    event: Extract<WsEvent, { event: 'session_created' }>,
  ) {
    sessions.value = applySessionCreated(sessions.value, event)
    upsertProject(projectFromSession(event.session))
    if (
      event.client_draft_id &&
      activeId.value === event.client_draft_id &&
      event.session?.id
    ) {
      activeId.value = event.session.id
    }
  }

  function applySessionTitleUpdatedEvent(
    event: Extract<WsEvent, { event: 'session_title_updated' }>,
  ) {
    sessions.value = applySessionTitleUpdated(sessions.value, event)
  }

  function applySessionControlPending(
    sessionId: string,
    interaction?: ControlInteraction | null,
  ) {
    const index = sessions.value.findIndex(
      (session) => session.id === sessionId,
    )
    if (index < 0) return
    const next = sessions.value.slice()
    next[index] = {
      ...next[index],
      control_pending: sessionControlPendingFromInteraction(interaction),
    }
    sessions.value = next
  }

  function backendSessionId() {
    return isDraftSessionId(activeId.value) ? '' : activeId.value
  }

  function getSession(id: string) {
    return sessions.value.find((session) => session.id === id)
  }

  return {
    sessions,
    projects,
    activeId,
    active,
    canDeletePersistedSession,
    sessionActionError,
    loading,
    creating,
    load,
    loadArchived,
    create,
    resolveProject,
    remove,
    rename,
    archive,
    activate,
    applySessionCreatedEvent,
    applySessionTitleUpdatedEvent,
    applySessionControlPending,
    backendSessionId,
    getSession,
    isDraftSessionId,
  }
}

function upsertProject(input?: ProjectInfo | null) {
  const project = normalizeProject(input)
  if (!project) return
  const key = projectKey(project)
  const existing = projects.value.find((item) => projectKey(item) === key)
  const merged: ProjectInfo = {
    ...existing,
    ...project,
    created_at: project.created_at || existing?.created_at,
    updated_at: project.updated_at || existing?.updated_at,
  }
  projects.value = [
    merged,
    ...projects.value.filter((item) => projectKey(item) !== key),
  ]
}

function normalizeProjects(items: unknown): ProjectInfo[] {
  if (!Array.isArray(items)) return []
  const out: ProjectInfo[] = []
  for (const item of items) {
    const project = normalizeProject(item as ProjectInfo)
    if (!project) continue
    if (out.some((existing) => projectKey(existing) === projectKey(project)))
      continue
    out.push(project)
  }
  return out
}

function normalizeProject(
  input?: Partial<ProjectInfo> | null,
): ProjectInfo | null {
  if (!input || typeof input !== 'object') return null
  const id = String(input.project_id || input.project_path || '').trim()
  const path = String(input.project_path || input.workspace_path || '').trim()
  if (!id && !path) return null
  return {
    ...input,
    project_id: id || path,
    project_path: path,
    project_name: String(
      input.project_name || basenameFromPath(path) || '未绑定项目',
    ),
  } as ProjectInfo
}

function projectFromSession(session?: SessionInfo | null): ProjectInfo | null {
  if (!session || session.mode !== 'build') return null
  const projectId = String(
    session.project_id || session.project_path || '',
  ).trim()
  const projectPath = String(session.project_path || '').trim()
  if (!projectId && !projectPath) return null
  return normalizeProject({
    project_id: projectId || projectPath,
    project_path: projectPath,
    project_name: session.project_name || basenameFromPath(projectPath),
    created_at: session.created_at,
    updated_at: session.updated_at,
  })
}

function projectKey(project: ProjectInfo): string {
  return String(project.project_id || project.project_path || '').trim()
}

function basenameFromPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

function sessionControlPendingFromInteraction(
  interaction?: ControlInteraction | null,
): SessionControlPending | null {
  if (!interaction || interaction.status !== 'waiting') return null
  if (interaction.kind === 'plan') {
    return {
      kind: 'plan',
      label: '计划需要用户确认',
      tone: 'green',
      interaction_id: interaction.id,
      updated_at: Date.now(),
    }
  }
  if (interaction.kind === 'ask') {
    return {
      kind: 'ask',
      label: '需要用户输入',
      tone: 'blue',
      interaction_id: interaction.id,
      updated_at: Date.now(),
    }
  }
  return null
}
