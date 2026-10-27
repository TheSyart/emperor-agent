/**
 * The app mode of the window (0.3 MOD-01, docs/design/modes.md): Chat,
 * Build or Group, kept in Core's sidebar state (`app_mode`) with the last
 * session opened in each mode (`mode_routes`, never a draft).
 *
 * - App.vue loads it at start-up and lands in a session of the saved mode
 *   (`landAtStartup`), so the mode survives a restart.
 * - ⌘1 / ⌘2 / ⌘3 switch it (`switchTo`): back to the mode's last session,
 *   or the mode's home when that session is gone. ⌘N starts the mode's own
 *   kind of session (`newSession`).
 * - The route leads (`followRoute`): opening a session of another mode —
 *   from a notification, search, a deep link, back / forward — or a binding
 *   change of the open session switches the mode with it. Pages belong to
 *   no mode and leave it alone.
 *
 * Nothing is written before the saved state has been read (like
 * useSidebarState): a write built on the defaults would forget the
 * remembered sessions. The sidebar reaches the mode and the controller
 * through the app context (`AppModeAccess`, MOD-02).
 */
import {
  readonly,
  ref,
  shallowRef,
  watch,
  type Ref,
  type WatchStopHandle,
} from 'vue'
import { core } from '../api/http'
import {
  currentBuildProject,
  defaultAppMode,
  GROUP_HOME_ROUTE,
  isAppMode,
  modeLandingSessionId,
  modeSwitchTarget,
  normalizeModeRoutes,
  rememberModeRoute,
  sessionAppMode,
  sessionsInMode,
  type AppMode,
  type ModeRoutes,
  type RouteModeTarget,
} from '../runtime/appMode'
import type { ProjectInfo, SessionInfo } from '../types'
import type { CreateSessionDraftOptions } from './useSession'

export type AppModeStatus = 'unloaded' | 'loaded' | 'failed'

export interface AppModeStore {
  mode: Readonly<Ref<AppMode>>
  routes: Readonly<Ref<ModeRoutes>>
  status: Readonly<Ref<AppModeStatus>>
  /** Read the saved state; `sessions` give the default when there is none. */
  load(sessions: SessionInfo[]): Promise<void>
  setMode(next: AppMode): void
  /** The route is on a session of `target.mode`: switch to it, remember it. */
  follow(target: RouteModeTarget): void
  /** Keep following the route from now on (the invariant). */
  followRoute(source: () => RouteModeTarget): WatchStopHandle
}

export function createAppModeStore(): AppModeStore {
  const mode = ref<AppMode>('chat')
  // Replaced, never mutated: plain objects go to Core as they are.
  const routes = shallowRef<ModeRoutes>({})
  const status = ref<AppModeStatus>('unloaded')

  async function load(sessions: SessionInfo[]): Promise<void> {
    try {
      const state = (await core('sidebar.get')) as {
        app_mode?: unknown
        mode_routes?: unknown
      } | null
      mode.value = isAppMode(state?.app_mode)
        ? state.app_mode
        : defaultAppMode(sessions)
      routes.value = normalizeModeRoutes(state?.mode_routes)
      status.value = 'loaded'
    } catch {
      if (status.value === 'loaded') return
      mode.value = defaultAppMode(sessions)
      status.value = 'failed'
    }
  }

  /** Apply a new mode and routes; one Core write with what changed. */
  function apply(nextMode: AppMode, nextRoutes: ModeRoutes): void {
    const patch: { app_mode?: AppMode; mode_routes?: ModeRoutes } = {}
    if (nextMode !== mode.value) patch.app_mode = nextMode
    if (nextRoutes !== routes.value) patch.mode_routes = nextRoutes
    if (!patch.app_mode && !patch.mode_routes) return
    mode.value = nextMode
    routes.value = nextRoutes
    if (status.value !== 'loaded') return
    // Best effort: the window already shows the new mode.
    void core('sidebar.patch', patch).catch(() => undefined)
  }

  function setMode(next: AppMode): void {
    apply(next, routes.value)
  }

  function follow(target: RouteModeTarget): void {
    if (!target.mode) return
    apply(
      target.mode,
      rememberModeRoute(routes.value, target.mode, target.sessionId),
    )
  }

  /**
   * Follow the target when it changes (another session, or the open one's
   * mode after a binding change), not on every re-run of `source`: a list
   * update of the open session (its turn running) must not undo a switch
   * made since — ⌘3 while that session stays on screen (MOD-02).
   */
  function followRoute(source: () => RouteModeTarget): WatchStopHandle {
    return watch(
      source,
      (target, previous) => {
        if (
          previous &&
          previous.mode === target.mode &&
          previous.sessionId === target.sessionId
        )
          return
        follow(target)
      },
      { immediate: true },
    )
  }

  return {
    mode: readonly(mode),
    routes: readonly(routes),
    status: readonly(status),
    load,
    setMode,
    follow,
    followRoute,
  }
}

let windowStore: AppModeStore | null = null

/** The window's app mode store (one per renderer). */
export function useAppMode(): AppModeStore {
  windowStore ??= createAppModeStore()
  return windowStore
}

/** What switching and ⌘N need from the window. */
export interface AppModeNavigation {
  sessions(): SessionInfo[]
  projects(): ProjectInfo[]
  /** The session on screen ('' on pages). */
  currentSessionId(): string
  /** Make a session the active one without routing (start-up). */
  selectSession(id: string): void
  /** Route to a session. */
  openSession(id: string): Promise<void>
  /** A local draft; it becomes the active session. */
  createDraft(options: CreateSessionDraftOptions): Promise<SessionInfo>
  /** Route to a named route; false when the app has no such route. */
  openRoute(name: string): Promise<boolean>
}

export function createAppModeController(
  store: AppModeStore,
  nav: AppModeNavigation,
) {
  function find(id: string): SessionInfo | undefined {
    return id ? nav.sessions().find((session) => session.id === id) : undefined
  }

  /**
   * The mode's home: a new Chat draft; a new Build draft in the current
   * project (no project: the Build home, MOD-03); the Group home route once
   * the app has it (GRP-05) — until then the window stays where it is.
   */
  async function startHome(mode: AppMode, open: boolean): Promise<void> {
    if (mode === 'group') {
      await nav.openRoute(GROUP_HOME_ROUTE)
      return
    }
    let options: CreateSessionDraftOptions = { mode: 'chat', title: '新会话' }
    if (mode === 'build') {
      const remembered = sessionsInMode(nav.sessions(), 'build').find(
        (session) => session.id === store.routes.value.build,
      )
      const project = currentBuildProject({
        current: find(nav.currentSessionId()),
        remembered,
        projects: nav.projects(),
      })
      options = project
        ? { mode: 'build', title: '新会话', project }
        : { mode: 'build', title: '新会话' }
    }
    const draft = await nav.createDraft(options)
    if (open) await nav.openSession(draft.id)
  }

  /** ⌘1 / ⌘2 / ⌘3: the mode first, then its last session or its home. */
  async function switchTo(mode: AppMode): Promise<void> {
    const current = find(nav.currentSessionId())
    // Already there: the session on screen stays.
    if (
      current &&
      store.mode.value === mode &&
      sessionAppMode(current) === mode
    )
      return
    store.setMode(mode)
    const target = modeSwitchTarget(mode, store.routes.value, nav.sessions())
    if (target.kind === 'session') {
      await nav.openSession(target.id)
      return
    }
    await startHome(mode, true)
  }

  /** ⌘N: the current mode's new session. */
  async function newSession(): Promise<void> {
    await startHome(store.mode.value, true)
  }

  /**
   * Start-up, before the first session opens and only when no route names
   * one: a session of the saved mode, else the mode's home.
   */
  async function landAtStartup(activeId: string): Promise<void> {
    const mode = store.mode.value
    const id = modeLandingSessionId(
      mode,
      store.routes.value,
      nav.sessions(),
      activeId,
    )
    if (id) {
      if (id !== activeId) nav.selectSession(id)
      return
    }
    await startHome(mode, false)
  }

  return { switchTo, newSession, landAtStartup }
}

export type AppModeController = ReturnType<typeof createAppModeController>

/**
 * The mode as the sidebar sees it (app context, MOD-02): the current mode
 * and the controller's switch and ⌘N, so the switcher, the rail and the
 * primary row run the very code ⌘1–⌘3 and ⌘N run.
 */
export interface AppModeAccess {
  mode: Readonly<Ref<AppMode>>
  switchTo: (mode: AppMode) => Promise<void>
  newSession: () => Promise<void>
}
