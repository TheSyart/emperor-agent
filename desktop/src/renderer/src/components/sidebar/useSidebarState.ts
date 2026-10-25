/**
 * The persisted sidebar layout (Core `sidebar.get` / `sidebar.patch`):
 * section sorts, manual orders, collapsed projects and sections (BUG-06),
 * pinned sessions, plus the grouped session list derived from it.
 * Patches are optimistic; every patch carries the pinned list so a Core
 * state written by an older shape can never drop the pins.
 *
 * Nothing is written before the saved layout has been read (`status`
 * 'unloaded' or 'failed'): a patch built on the defaults would overwrite
 * the user's pins and orders. A refused change says so and retries the read.
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
  SidebarSectionKey,
  SidebarSortMode,
  SidebarState,
} from '../../types'

export type SidebarStateStatus = 'unloaded' | 'loaded' | 'failed'

export function useSidebarState(input: {
  sessions: Ref<SessionInfo[]>
  projects: Ref<ProjectInfo[]>
  showToast: (message: string) => void
}) {
  const state = ref<SidebarState>({ ...defaultSidebarState })
  const status = ref<SidebarStateStatus>('unloaded')
  const grouped = computed(() =>
    buildSidebarGroups(input.sessions.value, state.value, input.projects.value),
  )

  async function load(): Promise<void> {
    try {
      state.value = normalizeSidebarState(await core('sidebar.get'))
      status.value = 'loaded'
    } catch {
      if (status.value !== 'loaded') {
        state.value = { ...defaultSidebarState }
        status.value = 'failed'
      }
    }
  }

  async function patch(update: Partial<SidebarState>): Promise<void> {
    if (status.value !== 'loaded') {
      input.showToast('侧栏布局还没有读取成功，稍后再试')
      if (status.value === 'failed') void load()
      return
    }
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

  function isSectionCollapsed(key: SidebarSectionKey): boolean {
    return state.value.collapsed_sections.includes(key)
  }

  function toggleSection(key: SidebarSectionKey): void {
    const current = state.value.collapsed_sections
    void patch({
      collapsed_sections: current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    })
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
    status,
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
    isSectionCollapsed,
    toggleSection,
    moveChat,
    moveProjectSession,
  }
}
