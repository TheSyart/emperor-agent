import { ref, computed } from 'vue'
import { core } from '../api/http'
import type { ControlInteraction, ProjectInfo, SessionControlPending, SessionInfo, SessionMode, WsEvent } from '../types'
import {
  applySessionCreated,
  applySessionTitleUpdated,
  createDraftSession,
  isDraftSessionId,
} from '../runtime/sessionDrafts'

const sessions = ref<SessionInfo[]>([])
const activeId = ref<string>('')
const loading = ref(false)
const creating = ref(false)

export interface CreateSessionDraftOptions {
  title?: string
  mode?: SessionMode
  project?: ProjectInfo
}

export function useSession() {
  const active = computed(() => sessions.value.find((s) => s.id === activeId.value))

  async function load() {
    loading.value = true
    try {
      sessions.value = await core<SessionInfo[]>('sessions.list', { includeArchived: false })
      if (!sessions.value.length) {
        await create({ mode: 'chat', title: '新会话' })
      } else if (!activeId.value || !sessions.value.some((session) => session.id === activeId.value)) {
        activeId.value = sessions.value[0].id
      }
    } finally {
      loading.value = false
    }
  }

  async function loadArchived(): Promise<SessionInfo[]> {
    return core<SessionInfo[]>('sessions.list', { includeArchived: true })
  }

  /**
   * P1-6 懒创建：只建本地隐藏 draft，不 POST、不落盘。
   * 首条消息提交时由 Core 创建真实 session 并通过 session_created 事件晋升。
   */
  async function create(options: string | CreateSessionDraftOptions = '新会话'): Promise<SessionInfo> {
    const opts = typeof options === 'string' ? { title: options } : options
    const mode: SessionMode = opts.mode === 'build' ? 'build' : 'chat'
    const draft = createDraftSession({
      title: opts.title,
      mode,
      projectId: opts.project?.project_id,
      projectPath: opts.project?.project_path,
      projectName: opts.project?.project_name,
    })
    sessions.value = [draft, ...sessions.value.filter((session) => !session.draft)]
    activeId.value = draft.id
    return draft
  }

  async function resolveProject(path: string): Promise<ProjectInfo> {
    return core<ProjectInfo>('projects.resolve', path)
  }

  async function remove(id: string): Promise<boolean> {
    if (isDraftSessionId(id)) {
      sessions.value = sessions.value.filter((s) => s.id !== id)
      if (activeId.value === id) activeId.value = sessions.value[0]?.id || ''
      if (!sessions.value.length) await create()
      return true
    }
    try {
      await core<{ deleted: boolean }>('sessions.delete', id)
      sessions.value = sessions.value.filter((s) => s.id !== id)
      if (activeId.value === id) activeId.value = sessions.value[0]?.id || ''
      if (!sessions.value.length) await create()
      return true
    } catch {
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
      await core<SessionInfo>('sessions.rename', id, { title })
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
      const updated = await core<SessionInfo>('sessions.rename', id, { archived })
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
      await core<{ active: string; complete: boolean }>('sessions.activate', id).catch(() => undefined)
    }
  }

  function applySessionCreatedEvent(event: Extract<WsEvent, { event: 'session_created' }>) {
    sessions.value = applySessionCreated(sessions.value, event)
    if (event.client_draft_id && activeId.value === event.client_draft_id && event.session?.id) {
      activeId.value = event.session.id
    }
  }

  function applySessionTitleUpdatedEvent(event: Extract<WsEvent, { event: 'session_title_updated' }>) {
    sessions.value = applySessionTitleUpdated(sessions.value, event)
  }

  function applySessionControlPending(sessionId: string, interaction?: ControlInteraction | null) {
    const index = sessions.value.findIndex((session) => session.id === sessionId)
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
    activeId,
    active,
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

function sessionControlPendingFromInteraction(interaction?: ControlInteraction | null): SessionControlPending | null {
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
