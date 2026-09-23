/**
 * The persisted sidebar layout (Core `sidebar.get` / `sidebar.patch`):
 * section sorts, manual orders, collapsed projects and pinned sessions, plus
 * the grouped session list derived from it. Patches are optimistic; every
 * patch carries the pinned list so a Core state written by an older shape
 * can never drop the pins.
 */
import { computed, ref, type Ref } from 'vue'
import { core } from '../../api/http'
import {
  buildSidebarGroups,
  completeManualOrder,
  defaultSidebarState,
  MAX_PINNED_SESSIONS,
  moveId,
  normalizeSidebarState,
  pinSessionId,
  unpinSessionId,
  type SidebarProjectGroup,
} from '../../runtime/sidebarModel'
import type {
  ProjectInfo,
  SessionInfo,
  SidebarSortMode,
  SidebarState,
} from '../../types'

export function useSidebarState(input: {
  sessions: Ref<SessionInfo[]>
  projects: Ref<ProjectInfo[]>
  showToast: (message: string) => void
}) {
  const state = ref<SidebarState>({ ...defaultSidebarState })
  const grouped = computed(() =>
    buildSidebarGroups(input.sessions.value, state.value, input.projects.value),
  )

  async function load(): Promise<void> {
    try {
      state.value = normalizeSidebarState(await core('sidebar.get'))
    } catch {
      state.value = { ...defaultSidebarState }
    }
  }

  async function patch(update: Partial<SidebarState>): Promise<void> {
    const next = normalizeSidebarState({ ...state.value, ...update })
    state.value = next
    try {
      state.value = normalizeSidebarState(
        await core('sidebar.patch', {
          ...update,
          pinned_session_ids: next.pinned_session_ids,
        }),
      )
    } catch {
      state.value = next
    }
  }

  function togglePin(id: string): void {
    const current = state.value.pinned_session_ids
    if (current.includes(id)) {
      void patch({ pinned_session_ids: unpinSessionId(current, id) })
      return
    }
    const next = pinSessionId(current, id)
    if (!next) {
      input.showToast(`最多置顶 ${MAX_PINNED_SESSIONS} 个会话`)
      return
    }
    void patch({ pinned_session_ids: next })
  }

  function movePinned(id: string, delta: -1 | 1): void {
    void patch({
      pinned_session_ids: moveId(
        grouped.value.pinned.map((session) => session.id),
        id,
        delta,
      ),
    })
  }

  /** Core already unpinned a deleted / archived session; mirror it locally. */
  function forgetPinned(id: string): void {
    const current = state.value.pinned_session_ids
    if (!current.includes(id)) return
    state.value = {
      ...state.value,
      pinned_session_ids: unpinSessionId(current, id),
    }
  }

  function setProjectSort(mode: SidebarSortMode): void {
    void patch({ project_sort: mode })
  }

  function setChatSort(mode: SidebarSortMode): void {
    void patch({ chat_sort: mode })
  }

  function isProjectCollapsed(projectId: string): boolean {
    return state.value.collapsed_project_ids.includes(projectId)
  }

  function toggleProject(projectId: string): void {
    const current = state.value.collapsed_project_ids
    const next = current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId]
    void patch({ collapsed_project_ids: next })
  }

  function moveChat(sessionId: string, delta: -1 | 1): void {
    const ids = grouped.value.chats.map((session) => session.id)
    void patch({
      chat_sort: 'manual',
      chat_order: moveId(
        completeManualOrder(state.value.chat_order, ids),
        sessionId,
        delta,
      ),
    })
  }

  function moveProjectSession(
    project: SidebarProjectGroup,
    sessionId: string,
    delta: -1 | 1,
  ): void {
    const current = state.value.project_session_order
    const order = completeManualOrder(
      current[project.id] || [],
      project.sessions.map((session) => session.id),
    )
    void patch({
      project_sort: 'manual',
      project_session_order: {
        ...current,
        [project.id]: moveId(order, sessionId, delta),
      },
    })
  }

  return {
    state,
    grouped,
    load,
    patch,
    togglePin,
    movePinned,
    forgetPinned,
    setProjectSort,
    setChatSort,
    isProjectCollapsed,
    toggleProject,
    moveChat,
    moveProjectSession,
  }
}
