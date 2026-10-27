/**
 * The Build home's project (MOD-03, docs/design/modes.md § 首页): which
 * project the empty Build session on screen runs in, its branch, the
 * recent projects to offer, and picking one — from a card, the composer's
 * project chip, the folder picker or a dropped folder.
 *
 * A pick binds the draft on screen in place (useSession.setDraftProject),
 * so what was typed stays; on a saved, still empty Build session — whose
 * project Core keeps — it opens a new draft in the picked project instead.
 * The branch is read by project (`projects.branch`, no session exists yet)
 * only while the Build home is on screen.
 */
import { computed, ref, watch } from 'vue'
import { getPathForFile, selectDirectory } from '../../api/backend'
import { core } from '../../api/http'
import { useSession } from '../../composables/useSession'
import type { ProjectInfo, SessionInfo } from '../../types'
import {
  projectInfoOf,
  recentProjects,
  type RecentProject,
} from './heroProjects'

/** What a drop of a file (or an unreadable folder) says. */
export const NOT_A_FOLDER = '拖进来的不是文件夹，请拖入一个项目文件夹'

/** Projects in the chip's menu. */
const MENU_PROJECT_LIMIT = 8

export interface BuildHomeOptions {
  /** The session on screen. */
  session: () => SessionInfo | undefined
  /** The Build home is on screen (the branch is read only then). */
  active: () => boolean
  isRunning: (sessionId: string) => boolean
  /** Route to a session. */
  openSession: (id: string) => void | Promise<void>
  notify: (message: string) => void
  fail: (error: unknown) => void
}

export function useBuildHome(options: BuildHomeOptions) {
  const store = useSession()

  /** The project the session on screen runs in (null: none picked yet). */
  const project = computed<ProjectInfo | null>(() => {
    const session = options.session()
    const path = session?.project_path?.trim()
    if (!session || !path) return null
    return {
      project_id: session.project_id || path,
      project_path: path,
      project_name: session.project_name || '',
    }
  })
  const needsProject = computed(() => project.value === null)

  const recent = computed(() =>
    recentProjects({
      projects: store.projects.value,
      sessions: store.sessions.value,
      isRunning: options.isRunning,
    }),
  )
  const menuProjects = computed(() =>
    recentProjects({
      projects: store.projects.value,
      sessions: store.sessions.value,
      isRunning: options.isRunning,
      limit: MENU_PROJECT_LIMIT,
    }),
  )

  const branch = ref<string | null>(null)
  let generation = 0
  watch(
    () => (options.active() ? (project.value?.project_id ?? '') : ''),
    async (projectId) => {
      const run = ++generation
      branch.value = null
      if (!projectId) return
      try {
        const result = await core('projects.branch', { projectId })
        if (run === generation) branch.value = result?.branch ?? null
      } catch {
        // No branch tag is better than an error on the home.
      }
    },
    { immediate: true },
  )

  async function pickProject(
    picked: ProjectInfo | RecentProject,
  ): Promise<void> {
    const info = 'project_path' in picked ? picked : projectInfoOf(picked)
    const session = options.session()
    if (session?.draft) {
      store.setDraftProject(session.id, info)
      return
    }
    const draft = await store.create({
      mode: 'build',
      title: '新会话',
      project: info,
    })
    await options.openSession(draft.id)
  }

  async function bindFolder(path: string): Promise<void> {
    try {
      await pickProject(await store.resolveProject(path))
    } catch (error) {
      options.fail(error)
    }
  }

  /** 打开文件夹…: the picker; cancelling it does nothing. */
  async function openFolder(): Promise<void> {
    let path = ''
    try {
      path = ((await selectDirectory()) ?? '').trim()
    } catch (error) {
      options.fail(error)
      return
    }
    if (path) await bindFolder(path)
  }

  /** A folder dropped onto the home. */
  async function dropFolder(file: File): Promise<void> {
    let path = ''
    try {
      path = getPathForFile(file).trim()
    } catch {
      // No path for it (not a real file on disk): same as a file.
    }
    if (!path) {
      options.notify(NOT_A_FOLDER)
      return
    }
    await bindFolder(path)
  }

  /** A file (not a folder) dropped onto the home. */
  function rejectDrop(): void {
    options.notify(NOT_A_FOLDER)
  }

  return {
    project,
    needsProject,
    branch,
    recent,
    menuProjects,
    pickProject,
    openFolder,
    dropFolder,
    rejectDrop,
  }
}

export type BuildHome = ReturnType<typeof useBuildHome>
