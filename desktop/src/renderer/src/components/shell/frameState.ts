/**
 * AppFrame panel state (port of dsh ui-layout stores.ts): sidebar / details
 * width preferences in px (0 = closed), the narrow-viewport override, and the
 * active details tab. Persisted per viewer in localStorage (best effort —
 * every storage access is guarded so a blocked store never breaks the shell).
 */
import { reactive, watch } from 'vue'
import {
  clampWidth,
  DETAILS_DEFAULT,
  DETAILS_MAX,
  DETAILS_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from './columns'

export type DetailsTab =
  'inspect' | 'git' | 'files' | 'terminal' | 'environment' | 'browser'

export const DETAILS_TABS: readonly DetailsTab[] = [
  'inspect',
  'git',
  'files',
  'terminal',
  'environment',
  'browser',
]

export interface FrameState {
  /** Sidebar width preference (0 = collapsed to the rail). */
  sidebar: number
  /** Details width preference (0 = closed). */
  details: number
  /** Last open details width, restored on reopen. */
  detailsWidth: number
  detailsTab: DetailsTab
  /** Mirrors AppFrame's breakpoint reading (viewport < 1024). */
  narrow: boolean
  /** Manual re-expand of the auto-collapsed sidebar on narrow viewports. */
  narrowExpanded: boolean
}

export const FRAME_STORAGE_KEY = 'emperor.frame.v1'

interface PersistedFrame {
  sidebar?: number
  details?: number
  detailsWidth?: number
  detailsTab?: string
}

export function isDetailsTab(value: unknown): value is DetailsTab {
  return (
    typeof value === 'string' &&
    (DETAILS_TABS as readonly string[]).includes(value)
  )
}

export function defaultFrameState(): FrameState {
  return {
    sidebar: SIDEBAR_DEFAULT,
    details: 0,
    detailsWidth: DETAILS_DEFAULT,
    detailsTab: 'environment',
    narrow: false,
    narrowExpanded: false,
  }
}

/** Parse a persisted snapshot; anything malformed falls back to defaults. */
export function restoreFrameState(raw: string | null | undefined): FrameState {
  const state = defaultFrameState()
  if (!raw) return state
  let data: PersistedFrame
  try {
    data = JSON.parse(raw) as PersistedFrame
  } catch {
    return state
  }
  if (!data || typeof data !== 'object') return state
  if (data.sidebar === 0) state.sidebar = 0
  else if (typeof data.sidebar === 'number')
    state.sidebar = clampWidth(data.sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  if (typeof data.detailsWidth === 'number')
    state.detailsWidth = clampWidth(data.detailsWidth, DETAILS_MIN, DETAILS_MAX)
  if (typeof data.details === 'number' && data.details > 0)
    state.details = clampWidth(data.details, DETAILS_MIN, DETAILS_MAX)
  if (isDetailsTab(data.detailsTab)) state.detailsTab = data.detailsTab
  return state
}

export function serializeFrameState(state: FrameState): string {
  const persisted: PersistedFrame = {
    sidebar: state.sidebar,
    details: state.details,
    detailsWidth: state.detailsWidth,
    detailsTab: state.detailsTab,
  }
  return JSON.stringify(persisted)
}

function readStorage(): string | null {
  try {
    return window.localStorage.getItem(FRAME_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStorage(value: string): void {
  try {
    window.localStorage.setItem(FRAME_STORAGE_KEY, value)
  } catch {
    // Best effort: a blocked store keeps the in-memory layout.
  }
}

/** Pure transitions over a FrameState draft (unit-tested). */
export const frameActions = {
  setSidebar(state: FrameState, px: number): void {
    state.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX)
  },
  setDetails(state: FrameState, px: number): void {
    state.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX)
    state.detailsWidth = state.details
  },
  toggleSidebar(state: FrameState): void {
    if (state.narrow) state.narrowExpanded = !state.narrowExpanded
    else state.sidebar = state.sidebar === 0 ? SIDEBAR_DEFAULT : 0
  },
  setNarrow(state: FrameState, narrow: boolean): void {
    if (state.narrow === narrow) return
    state.narrow = narrow
    state.narrowExpanded = false
  },
  openDetails(state: FrameState, tab?: DetailsTab): void {
    if (tab) state.detailsTab = tab
    if (state.details === 0)
      state.details = clampWidth(
        state.detailsWidth || DETAILS_DEFAULT,
        DETAILS_MIN,
        DETAILS_MAX,
      )
  },
  closeDetails(state: FrameState): void {
    if (state.details > 0) state.detailsWidth = state.details
    state.details = 0
  },
  toggleDetails(state: FrameState, tab?: DetailsTab): void {
    if (state.details > 0 && (!tab || tab === state.detailsTab))
      frameActions.closeDetails(state)
    else frameActions.openDetails(state, tab)
  },
  /** Whether the sidebar currently renders as the collapsed rail. */
  sidebarCollapsed(state: FrameState): boolean {
    return state.narrow ? !state.narrowExpanded : state.sidebar === 0
  },
}

let singleton: FrameState | null = null

/** App-wide frame state (one per window), persisted on change. */
export function useFrameState(): FrameState {
  if (singleton) return singleton
  const state = reactive(restoreFrameState(readStorage())) as FrameState
  watch(
    () => serializeFrameState(state),
    (value) => writeStorage(value),
  )
  singleton = state
  return state
}

/** Test hook: drop the singleton so each test starts from storage. */
export function resetFrameStateForTest(): void {
  singleton = null
}
