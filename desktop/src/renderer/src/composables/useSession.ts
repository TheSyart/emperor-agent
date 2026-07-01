import { ref, computed } from 'vue'
import { api } from '../api/http'
import type { ControlInteraction, ProjectInfo, SessionControlPending, SessionInfo, SessionMode, WsEvent } from '../types'
import {
  applySessionCreated,
  applySessionTitleUpdated,
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
      sessions.value = await api<SessionInfo[]>('/api/sessions')
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
    return api<SessionInfo[]>('/api/sessions?archived=1')
  }

  async function create(options: string | CreateSessionDraftOptions = '新会话'): Promise<SessionInfo> {
    const opts = typeof options === 'string' ? { title: options } : options
    const mode: SessionMode = opts.mode === 'build' ? 'build' : 'chat'
    const previousActiveId = activeId.value
    creating.value = true
    try {
      const created = normalizeSessionInfo(await api<SessionInfo>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title: (opts.title || '').trim() || '新会话',
          mode,
          project: mode === 'build' ? opts.project ?? null : null,
        }),
      }))
      sessions.value = [
        created,
        ...sessions.value.filter((session) => session.id !== created.id && !session.draft),
      ]
      activeId.value = created.id
      await activate(created.id)
      return created
    } catch (err) {
      activeId.value = previousActiveId
      sessions.value = sessions.value.filter((session) => !session.draft)
      throw err
    } finally {
      creating.value = false
    }
  }

  async function resolveProject(path: string): Promise<ProjectInfo> {
    return api<ProjectInfo>('/api/projects/resolve', {
      method: 'POST',
      body: JSON.stringify({ path }),
    })
  }

  async function remove(id: string): Promise<boolean> {
    if (isDraftSessionId(id)) {
      sessions.value = sessions.value.filter((s) => s.id !== id)
      if (activeId.value === id) activeId.value = sessions.value[0]?.id || ''
      if (!sessions.value.length) await create()
      return true
    }
    try {
      await api<{ deleted: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
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
      await api<SessionInfo>(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      })
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
      const updated = await api<SessionInfo>(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived }),
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
      await api<{ active: string; complete: boolean }>(`/api/sessions/${encodeURIComponent(id)}/activate`, {
        method: 'POST',
        body: JSON.stringify({}),
      }).catch(() => undefined)
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

function normalizeSessionInfo(value: SessionInfo): SessionInfo {
  return {
    ...value,
    id: String(value.id),
    title: String(value.title || '新会话'),
    mode: value.mode === 'build' ? 'build' : 'chat',
    project_id: value.project_id ?? null,
    project_path: value.project_path ?? null,
    project_name: value.project_name ?? null,
    control_pending: value.control_pending ?? null,
    draft: undefined,
  }
}
