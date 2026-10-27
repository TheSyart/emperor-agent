/**
 * The three modes, Chat, Build and Group (0.3 MOD-01, docs/design/modes.md):
 * which mode a session is listed under, which mode the route on screen
 * belongs to, and where switching to a mode goes. Pure; the store and the
 * ⌘1 / ⌘2 / ⌘3 controller are composables/useAppMode.ts.
 *
 * The classification itself is Core's (`sessions/app-mode.ts`), so Core's
 * default mode and the sidebar never disagree: a contact chat or a group is
 * Group, otherwise a project decides (bound: Build, unbound: Chat, D2), and
 * a group member's or a trial session is listed nowhere. Every list of
 * sessions goes through {@link isListedSession} (appModeUsage.test.ts).
 */
import {
  APP_MODES,
  defaultAppMode,
  isAppMode,
  isKnownSessionSurface,
  isModeRouteId,
  normalizeModeRoutes,
  sessionAppMode as coreSessionAppMode,
  type AppMode,
  type ModeRoutes,
} from '@emperor/core/runtime-contract'
import type { ProjectInfo, SessionInfo } from '../types'

export { APP_MODES, defaultAppMode, isAppMode, normalizeModeRoutes }
export type { AppMode, ModeRoutes }

/** Route names that show one session; the route's mode is that session's. */
const SESSION_ROUTE_NAMES: readonly string[] = [
  'chat',
  'trajectory',
  'external-agent',
]

/** The Group home (contacts and groups); the route arrives with GRP-05. */
export const GROUP_HOME_ROUTE = 'contacts'

/** The contact editor's routes (GRP-04): Group, like the Group home. */
export const CONTACT_EDITOR_ROUTES: readonly string[] = [
  'contact-new',
  'contact-edit',
]

type ModeFacts = Pick<
  SessionInfo,
  'mode' | 'surface' | 'project_path' | 'draft'
>

/** Unknown surfaces already reported, so a list render logs each once. */
const reportedSurfaces = new Set<string>()

/**
 * The mode a session is listed under, or null when it is listed nowhere.
 * An unknown `surface` (a newer Emperor's data) is logged once.
 */
export function sessionAppMode(session: ModeFacts): AppMode | null {
  const mode = coreSessionAppMode(session)
  const surface = session.surface
  if (
    mode === null &&
    surface &&
    !isKnownSessionSurface(surface) &&
    !reportedSurfaces.has(surface)
  ) {
    reportedSurfaces.add(surface)
    console.warn(
      `[appMode] unknown session surface "${surface}": the session is not listed`,
    )
  }
  return mode
}

/** A session a list may show: saved, not archived, and in some mode. */
export function isListedSession(
  session: ModeFacts & Pick<SessionInfo, 'archived_at'>,
): boolean {
  return (
    !session.archived_at && !session.draft && sessionAppMode(session) !== null
  )
}

/** The listed sessions of one mode, in list order. */
export function sessionsInMode(
  sessions: SessionInfo[],
  mode: AppMode,
): SessionInfo[] {
  return sessions.filter(
    (session) => isListedSession(session) && sessionAppMode(session) === mode,
  )
}

/** The mode of the route on screen, and its session ('' when none). */
export interface RouteModeTarget {
  mode: AppMode | null
  sessionId: string
}

export const NO_ROUTE_MODE: RouteModeTarget = { mode: null, sessionId: '' }

/**
 * What the route on screen belongs to. A conversation route has its
 * session's mode (drafts included); the Group home is Group. Pages
 * (定时任务, 能力, Pull Request, …) belong to no mode, nor does a session
 * nobody lists (a subagent's log, a group member's session): null, and the
 * current mode stays.
 */
export function routeModeTarget(
  route: { name?: unknown; params: Record<string, unknown> },
  find: (id: string) => SessionInfo | undefined,
): RouteModeTarget {
  const name = typeof route.name === 'string' ? route.name : ''
  if (name === GROUP_HOME_ROUTE || CONTACT_EDITOR_ROUTES.includes(name))
    return { mode: 'group', sessionId: '' }
  if (!SESSION_ROUTE_NAMES.includes(name)) return NO_ROUTE_MODE
  const raw = route.params.sessionId
  const id = typeof raw === 'string' ? raw : ''
  const session = id ? find(id) : undefined
  return { mode: session ? sessionAppMode(session) : null, sessionId: id }
}

/** `routes` with `id` as the mode's last session; unchanged for a draft. */
export function rememberModeRoute(
  routes: ModeRoutes,
  mode: AppMode,
  id: string,
): ModeRoutes {
  if (!isModeRouteId(id) || routes[mode] === id) return routes
  return { ...routes, [mode]: id }
}

export type ModeSwitchTarget =
  { kind: 'session'; id: string } | { kind: 'home' }

/** The remembered session of `mode` while it is listed there, if any. */
function rememberedSession(
  mode: AppMode,
  routes: ModeRoutes,
  sessions: SessionInfo[],
): SessionInfo | undefined {
  const id = routes[mode]
  if (!id) return undefined
  return sessionsInMode(sessions, mode).find((session) => session.id === id)
}

/**
 * Where switching to `mode` goes: its last session while it is still
 * listed in that mode (not deleted, archived or moved by a binding change),
 * else the mode's home.
 */
export function modeSwitchTarget(
  mode: AppMode,
  routes: ModeRoutes,
  sessions: SessionInfo[],
): ModeSwitchTarget {
  const session = rememberedSession(mode, routes, sessions)
  return session ? { kind: 'session', id: session.id } : { kind: 'home' }
}

/**
 * The session to open at start-up in the saved mode: the active one (the
 * most recent, or the draft of an empty list) when it is in that mode, as
 * before 0.3; else the mode's last session; else its most recent one.
 * Null: the mode's home.
 */
export function modeLandingSessionId(
  mode: AppMode,
  routes: ModeRoutes,
  sessions: SessionInfo[],
  activeId: string,
): string | null {
  const active = sessions.find((session) => session.id === activeId)
  // The draft made for an empty list counts too: no second draft.
  if (active && !active.archived_at && sessionAppMode(active) === mode)
    return activeId
  return (
    rememberedSession(mode, routes, sessions)?.id ??
    sessionsInMode(sessions, mode)[0]?.id ??
    null
  )
}

function projectOf(session: SessionInfo | undefined): ProjectInfo | null {
  const path = session?.project_path?.trim()
  if (!session || !path) return null
  return {
    project_id: session.project_id || path,
    project_path: path,
    project_name: session.project_name || '',
  }
}

/**
 * The project ⌘N starts a Build session in: the open session's, else the
 * last Build session's, else the most recently updated project. Null: the
 * Build home (no project yet).
 */
export function currentBuildProject(input: {
  current?: SessionInfo
  remembered?: SessionInfo
  projects: ProjectInfo[]
}): ProjectInfo | null {
  const fromSession =
    projectOf(
      input.current && sessionAppMode(input.current) === 'build'
        ? input.current
        : undefined,
    ) ?? projectOf(input.remembered)
  if (fromSession) return fromSession
  const recent = [...input.projects]
    .filter((project) => project.project_path)
    .sort((a, b) =>
      String(b.updated_at || b.created_at || '').localeCompare(
        String(a.updated_at || a.created_at || ''),
      ),
    )[0]
  return recent ?? null
}

/** What the switcher shows beside a mode (MOD-02). */
export interface ModeActivity {
  /** Listed sessions of the mode with a turn running. */
  running: number
  /** Some listed session of the mode waits for an approval or an answer. */
  waiting: boolean
}

/**
 * Running and waiting per mode, over the listed sessions only: a draft, an
 * archived session, a group member's or a trial session counts nowhere.
 */
export function modeActivity(
  sessions: SessionInfo[],
  probe: {
    running: (id: string) => boolean
    waiting: (session: SessionInfo) => boolean
  },
): Record<AppMode, ModeActivity> {
  const out = Object.fromEntries(
    APP_MODES.map((mode) => [mode, { running: 0, waiting: false }]),
  ) as Record<AppMode, ModeActivity>
  for (const session of sessions) {
    if (!isListedSession(session)) continue
    const entry = out[sessionAppMode(session)!]
    if (probe.running(session.id)) entry.running += 1
    if (!entry.waiting && probe.waiting(session)) entry.waiting = true
  }
  return out
}

/**
 * The dot on the mark: some mode other than `current` waits for the user.
 * Running never lights it (docs/design/modes.md § 侧栏).
 */
export function waitingElsewhere(
  activity: Record<AppMode, ModeActivity>,
  current: AppMode,
): boolean {
  return APP_MODES.some((mode) => mode !== current && activity[mode].waiting)
}

/**
 * The session to show when `exclude` goes away (deleted, archived, gone) or
 * none is open: the first listed session of `mode`, else — with `anyMode` —
 * the first listed one of any mode. Never a draft, an archived session or
 * one nobody lists. Undefined: nothing fits (the caller goes to a home).
 */
export function nextListedSession(
  sessions: SessionInfo[],
  options: { mode: AppMode | null; exclude?: string; anyMode?: boolean },
): SessionInfo | undefined {
  const candidates = sessions.filter(
    (session) => session.id !== options.exclude && isListedSession(session),
  )
  const inMode = options.mode
    ? candidates.find((session) => sessionAppMode(session) === options.mode)
    : undefined
  return inMode ?? (options.anyMode ? candidates[0] : undefined)
}
