/**
 * The three modes of the app (0.3, docs/design/modes.md): Chat, Build and
 * Group. A mode is a UI notion (D1): a session keeps `mode: chat | build`,
 * and the mode it is listed under follows its `surface` and its current
 * project binding (D2), never `mode`. Shared by Core (the sidebar state's
 * default mode) and the renderer (`runtime/appMode.ts`), so the two never
 * disagree about where a session belongs. No Node imports: the renderer
 * loads it through `@emperor/core/runtime-contract`.
 */
import { DRAFT_SESSION_PREFIX } from './constants'

export type AppMode = 'chat' | 'build' | 'group'

/** In menu order (⌘1 / ⌘2 / ⌘3). */
export const APP_MODES: readonly AppMode[] = ['chat', 'build', 'group']

/**
 * Where a group-chat session lives (GRP-05 sets it; absent for Chat and
 * Build): a 1:1 chat with a contact, a group, a member's own session inside
 * a group, or a trial (试用台) session.
 */
export type SessionSurface = 'contact' | 'group' | 'group_member' | 'trial'

export const SESSION_SURFACES: readonly SessionSurface[] = [
  'contact',
  'group',
  'group_member',
  'trial',
]

/** mode → the last session (or group / contact) opened in it; no drafts. */
export type ModeRoutes = Partial<Record<AppMode, string>>

/** Longest id kept in `mode_routes`. */
export const MODE_ROUTE_MAX_LENGTH = 128

/** The session facts the mode depends on (a Core entry or a renderer row). */
export interface AppModeSessionFacts {
  mode?: string | null
  surface?: string | null
  project_path?: string | null
  draft?: boolean
  archived_at?: string | null
}

export function isAppMode(value: unknown): value is AppMode {
  return APP_MODES.includes(value as AppMode)
}

export function isKnownSessionSurface(value: unknown): value is SessionSurface {
  return SESSION_SURFACES.includes(value as SessionSurface)
}

/**
 * The mode a session is listed under, or null when it is listed nowhere: a
 * group member's own session, a trial session, and a `surface` this version
 * does not know (a newer Emperor's), which must never turn into a Chat. A
 * contact chat or a group is Group; otherwise a project decides (D2): bound
 * (a non-blank `project_path`) is Build, unbound is Chat. A Build draft that
 * has not picked its project yet is the Build home, so Build.
 */
export function sessionAppMode(session: AppModeSessionFacts): AppMode | null {
  const surface = session.surface
  if (surface) {
    if (surface === 'contact' || surface === 'group') return 'group'
    return null
  }
  if (session.project_path?.trim()) return 'build'
  if (session.draft && session.mode === 'build') return 'build'
  return 'chat'
}

/** An id `mode_routes` may keep: a string of 1–128 characters, no draft. */
export function isModeRouteId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MODE_ROUTE_MAX_LENGTH &&
    !value.startsWith(DRAFT_SESSION_PREFIX)
  )
}

/**
 * `mode_routes` as stored: known modes only, each a trimmed id that
 * {@link isModeRouteId} accepts; anything else is dropped.
 */
export function normalizeModeRoutes(value: unknown): ModeRoutes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const out: ModeRoutes = {}
  for (const mode of APP_MODES) {
    const item = raw[mode]
    const id = typeof item === 'string' ? item.trim() : item
    if (isModeRouteId(id)) out[mode] = id
  }
  return out
}

/**
 * The mode before one was ever chosen: that of the first listed session
 * (session lists put the most recently updated first), else Chat.
 */
export function defaultAppMode(
  sessions: Iterable<AppModeSessionFacts>,
): AppMode {
  for (const session of sessions) {
    if (session.archived_at || session.draft) continue
    const mode = sessionAppMode(session)
    if (mode) return mode
  }
  return 'chat'
}
