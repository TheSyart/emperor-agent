/**
 * AppFrame panel state (port of dsh ui-layout stores.ts), v2: sidebar /
 * workspace width preferences in px (0 = closed), the narrow-viewport
 * override, the active workspace pane, the chat environment card and the
 * trajectory inspector column. Persisted per viewer in localStorage under
 * `emperor.frame.v2` (best effort — every storage access is guarded so a
 * blocked store never breaks the shell).
 *
 * The v1 snapshot (`emperor.frame.v1`, the retired details column) is
 * migrated once by `migrateFrameV1` and then removed.
 */
import { effectScope, reactive, watch } from 'vue'
import {
  clampWidth,
  INSPECTOR_DEFAULT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  WORKSPACE_DEFAULT,
  WORKSPACE_MAX,
  WORKSPACE_MIN,
} from './columns'

/** Right workspace panes; `launcher` is the pane picker (home). */
export type WorkspacePane =
  'launcher' | 'review' | 'terminal' | 'files' | 'browser'

export const WORKSPACE_PANES: readonly WorkspacePane[] = [
  'launcher',
  'review',
  'terminal',
  'files',
  'browser',
]

export interface FrameState {
  /** Sidebar width preference (0 = collapsed to the rail). */
  sidebar: number
  /** Workspace width preference (0 = closed). */
  workspace: number
  /** Last open workspace width, restored on reopen. */
  workspaceWidth: number
  workspacePane: WorkspacePane
  /** Chat-tab environment card (floats right of the conversation). */
  envCardOpen: boolean
  /** Trajectory inspector column. */
  inspectorOpen: boolean
  inspectorWidth: number
  /** Mirrors AppFrame's breakpoint reading (viewport < 1024). */
  narrow: boolean
  /** Manual re-expand of the auto-collapsed sidebar on narrow viewports. */
  narrowExpanded: boolean
}

export const FRAME_STORAGE_KEY = 'emperor.frame.v2'
/** Retired v1 key (details column); read once by the migration. */
export const LEGACY_FRAME_STORAGE_KEY = 'emperor.frame.v1'

interface PersistedFrame {
  sidebar?: number
  workspace?: number
  workspaceWidth?: number
  workspacePane?: string
  envCardOpen?: boolean
  inspectorOpen?: boolean
  inspectorWidth?: number
}

interface PersistedFrameV1 {
  sidebar?: number
  details?: number
  detailsWidth?: number
  detailsTab?: string
}

export function isWorkspacePane(value: unknown): value is WorkspacePane {
  return (
    typeof value === 'string' &&
    (WORKSPACE_PANES as readonly string[]).includes(value)
  )
}

export function defaultFrameState(): FrameState {
  return {
    sidebar: SIDEBAR_DEFAULT,
    workspace: 0,
    workspaceWidth: WORKSPACE_DEFAULT,
    workspacePane: 'launcher',
    envCardOpen: false,
    inspectorOpen: false,
    inspectorWidth: INSPECTOR_DEFAULT,
    narrow: false,
    narrowExpanded: false,
  }
}

function parseObject(raw: string | null | undefined): object | null {
  if (!raw) return null
  try {
    const data: unknown = JSON.parse(raw)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

function restoreSidebar(state: FrameState, value: unknown): void {
  if (value === 0) state.sidebar = 0
  else if (typeof value === 'number')
    state.sidebar = clampWidth(value, SIDEBAR_MIN, SIDEBAR_MAX)
}

/** Parse a persisted v2 snapshot; anything malformed falls back to defaults. */
export function restoreFrameState(raw: string | null | undefined): FrameState {
  const state = defaultFrameState()
  const data = parseObject(raw) as PersistedFrame | null
  if (!data) return state
  restoreSidebar(state, data.sidebar)
  if (typeof data.workspaceWidth === 'number')
    state.workspaceWidth = clampWidth(
      data.workspaceWidth,
      WORKSPACE_MIN,
      WORKSPACE_MAX,
    )
  if (typeof data.workspace === 'number' && data.workspace > 0)
    state.workspace = clampWidth(data.workspace, WORKSPACE_MIN, WORKSPACE_MAX)
  if (isWorkspacePane(data.workspacePane))
    state.workspacePane = data.workspacePane
  if (typeof data.envCardOpen === 'boolean')
    state.envCardOpen = data.envCardOpen
  if (typeof data.inspectorOpen === 'boolean')
    state.inspectorOpen = data.inspectorOpen
  if (typeof data.inspectorWidth === 'number')
    state.inspectorWidth = clampWidth(
      data.inspectorWidth,
      INSPECTOR_MIN,
      INSPECTOR_MAX,
    )
  return state
}

/**
 * v1 details tab → v2 workspace pane. Environment and Inspect left the
 * right column (environment card / trajectory inspector column), so they
 * land on the launcher and set their own flag instead.
 */
const V1_TAB_MIGRATION: Record<
  string,
  { pane: WorkspacePane; envCardOpen?: true; inspectorOpen?: true }
> = {
  git: { pane: 'review' },
  files: { pane: 'files' },
  terminal: { pane: 'terminal' },
  browser: { pane: 'launcher' },
  environment: { pane: 'launcher', envCardOpen: true },
  inspect: { pane: 'launcher', inspectorOpen: true },
}

/**
 * One-shot v1 → v2 migration. The sidebar preference carries over; the
 * details tab maps through V1_TAB_MIGRATION. The environment / inspect
 * flags only follow a column that was actually open (v1 defaulted the tab
 * to 'environment', so a closed column says nothing about the card), and the
 * workspace only reopens when the tab still lives there.
 */
export function migrateFrameV1(raw: string | null | undefined): FrameState {
  const state = defaultFrameState()
  const data = parseObject(raw) as PersistedFrameV1 | null
  if (!data) return state
  restoreSidebar(state, data.sidebar)
  if (typeof data.detailsWidth === 'number')
    state.workspaceWidth = clampWidth(
      data.detailsWidth,
      WORKSPACE_MIN,
      WORKSPACE_MAX,
    )
  const mapped =
    typeof data.detailsTab === 'string'
      ? V1_TAB_MIGRATION[data.detailsTab]
      : undefined
  if (mapped) state.workspacePane = mapped.pane
  const wasOpen = typeof data.details === 'number' && data.details > 0
  if (!wasOpen || !mapped) return state
  if (mapped.envCardOpen) state.envCardOpen = true
  else if (mapped.inspectorOpen) state.inspectorOpen = true
  else
    state.workspace = clampWidth(
      data.details as number,
      WORKSPACE_MIN,
      WORKSPACE_MAX,
    )
  return state
}

export function serializeFrameState(state: FrameState): string {
  const persisted: PersistedFrame = {
    sidebar: state.sidebar,
    workspace: state.workspace,
    workspaceWidth: state.workspaceWidth,
    workspacePane: state.workspacePane,
    envCardOpen: state.envCardOpen,
    inspectorOpen: state.inspectorOpen,
    inspectorWidth: state.inspectorWidth,
  }
  return JSON.stringify(persisted)
}

/** Minimal Storage surface (tests pass a fake). */
export interface FrameStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function browserStorage(): FrameStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Read the v2 snapshot, migrating (and then deleting) a v1 snapshot when no
 * v2 one exists yet. Storage failures fall back to defaults.
 */
export function loadFrameState(
  storage: FrameStorage | null = browserStorage(),
): FrameState {
  if (!storage) return defaultFrameState()
  try {
    const current = storage.getItem(FRAME_STORAGE_KEY)
    if (current !== null) {
      storage.removeItem(LEGACY_FRAME_STORAGE_KEY)
      return restoreFrameState(current)
    }
    const legacy = storage.getItem(LEGACY_FRAME_STORAGE_KEY)
    if (legacy === null) return defaultFrameState()
    const migrated = migrateFrameV1(legacy)
    storage.setItem(FRAME_STORAGE_KEY, serializeFrameState(migrated))
    storage.removeItem(LEGACY_FRAME_STORAGE_KEY)
    return migrated
  } catch {
    return defaultFrameState()
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
  toggleSidebar(state: FrameState): void {
    if (state.narrow) state.narrowExpanded = !state.narrowExpanded
    else state.sidebar = state.sidebar === 0 ? SIDEBAR_DEFAULT : 0
  },
  setNarrow(state: FrameState, narrow: boolean): void {
    if (state.narrow === narrow) return
    state.narrow = narrow
    state.narrowExpanded = false
  },
  /** Whether the sidebar currently renders as the collapsed rail. */
  sidebarCollapsed(state: FrameState): boolean {
    return state.narrow ? !state.narrowExpanded : state.sidebar === 0
  },

  setWorkspace(state: FrameState, px: number): void {
    state.workspace = clampWidth(px, WORKSPACE_MIN, WORKSPACE_MAX)
    state.workspaceWidth = state.workspace
  },
  workspaceOpen(state: FrameState): boolean {
    return state.workspace > 0
  },
  /** Open the workspace (on `pane` when given) at its remembered width. */
  openWorkspace(state: FrameState, pane?: WorkspacePane): void {
    if (pane) state.workspacePane = pane
    if (state.workspace === 0)
      state.workspace = clampWidth(
        state.workspaceWidth || WORKSPACE_DEFAULT,
        WORKSPACE_MIN,
        WORKSPACE_MAX,
      )
  },
  closeWorkspace(state: FrameState): void {
    if (state.workspace > 0) state.workspaceWidth = state.workspace
    state.workspace = 0
  },
  /**
   * Toggle the column; with a pane, close only when that pane is already
   * showing (otherwise switch to it and open).
   */
  toggleWorkspace(state: FrameState, pane?: WorkspacePane): void {
    if (state.workspace > 0 && (!pane || pane === state.workspacePane))
      frameActions.closeWorkspace(state)
    else frameActions.openWorkspace(state, pane)
  },
  setWorkspacePane(state: FrameState, pane: WorkspacePane): void {
    state.workspacePane = pane
  },

  setEnvCard(state: FrameState, open: boolean): void {
    state.envCardOpen = open
  },
  toggleEnvCard(state: FrameState): void {
    state.envCardOpen = !state.envCardOpen
  },

  openInspector(state: FrameState): void {
    state.inspectorOpen = true
  },
  /** Collapse the inspector column (the trajectory keeps its selection). */
  closeInspector(state: FrameState): void {
    state.inspectorOpen = false
  },
  toggleInspector(state: FrameState): void {
    state.inspectorOpen = !state.inspectorOpen
  },
  setInspectorWidth(state: FrameState, px: number): void {
    state.inspectorWidth = clampWidth(px, INSPECTOR_MIN, INSPECTOR_MAX)
  },
}

let singleton: FrameState | null = null

/** App-wide frame state (one per window), persisted on change. */
export function useFrameState(): FrameState {
  if (singleton) return singleton
  const state = reactive(loadFrameState()) as FrameState
  // Detached: the first caller's component scope must not own persistence.
  effectScope(true).run(() =>
    watch(
      () => serializeFrameState(state),
      (value) => writeStorage(value),
    ),
  )
  singleton = state
  return state
}

/** Test hook: drop the singleton so each test starts from storage. */
export function resetFrameStateForTest(): void {
  singleton = null
}
