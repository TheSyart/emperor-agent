import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN_CHAT,
  CENTER_MIN_TRAJECTORY,
  computeColumns,
  INSPECTOR_DEFAULT,
  SIDEBAR_COLLAPSED,
  SIDEBAR_DEFAULT,
  WORKSPACE_DEFAULT,
  WORKSPACE_MAX,
  WORKSPACE_MIN,
} from './columns'
import {
  defaultFrameState,
  FRAME_STORAGE_KEY,
  frameActions,
  LEGACY_FRAME_STORAGE_KEY,
  loadFrameState,
  migrateFrameV1,
  restoreFrameState,
  serializeFrameState,
  type FrameState,
  type FrameStorage,
} from './frameState'

describe('column solver (dsh concession chain)', () => {
  it('keeps preferred widths when everything fits', () => {
    expect(computeColumns(1440, 280, 560)).toEqual({
      sidebar: 280,
      center: 600,
      workspace: 560,
    })
  })

  it('renders a closed sidebar as the 56px rail', () => {
    expect(computeColumns(1440, 0, 0).sidebar).toBe(SIDEBAR_COLLAPSED)
  })

  it('shrinks the workspace toward its minimum before auto-closing it', () => {
    const shrunk = computeColumns(280 + CENTER_MIN_CHAT + 400, 280, 600)
    expect(shrunk).toEqual({
      sidebar: 280,
      center: CENTER_MIN_CHAT,
      workspace: 400,
    })
    const closed = computeColumns(1000, 280, 600)
    expect(closed.workspace).toBe(0)
    expect(closed.center).toBe(720)
  })

  it('concedes to the center floor it is given (chat 480, trajectory 640)', () => {
    expect(CENTER_MIN_CHAT).toBe(480)
    expect(CENTER_MIN_TRAJECTORY).toBe(640)
    // 1280 − 280 − 560 = 440: under both floors.
    expect(computeColumns(1280, 280, 560)).toEqual({
      sidebar: 280,
      center: 480,
      workspace: 520,
    })
    expect(computeColumns(1280, 280, 560, CENTER_MIN_TRAJECTORY)).toEqual({
      sidebar: 280,
      center: 640,
      workspace: 360,
    })
    // The trajectory floor closes the column where chat still fits it.
    expect(computeColumns(1200, 280, 560).workspace).toBe(440)
    expect(
      computeColumns(1200, 280, 560, CENTER_MIN_TRAJECTORY).workspace,
    ).toBe(0)
  })

  it('clamps out-of-range preferences', () => {
    expect(computeColumns(3000, 9999, 10).sidebar).toBe(420)
    expect(computeColumns(3000, 280, 10).workspace).toBe(WORKSPACE_MIN)
    expect(computeColumns(3000, 280, 5000).workspace).toBe(WORKSPACE_MAX)
  })
})

describe('frame state', () => {
  it('toggles the sidebar preference, or the narrow override below 1024px', () => {
    const state = defaultFrameState()
    frameActions.toggleSidebar(state)
    expect(state.sidebar).toBe(0)
    expect(frameActions.sidebarCollapsed(state)).toBe(true)
    frameActions.toggleSidebar(state)
    expect(state.sidebar).toBe(SIDEBAR_DEFAULT)

    frameActions.setNarrow(state, true)
    expect(frameActions.sidebarCollapsed(state)).toBe(true)
    frameActions.toggleSidebar(state)
    expect(frameActions.sidebarCollapsed(state)).toBe(false)
    expect(state.sidebar).toBe(SIDEBAR_DEFAULT)
    frameActions.setNarrow(state, false)
    expect(state.narrowExpanded).toBe(false)
  })

  it('opens the workspace on a pane and remembers the dragged width', () => {
    const state = defaultFrameState()
    expect(state.workspacePane).toBe('launcher')
    frameActions.openWorkspace(state, 'review')
    expect(state.workspace).toBe(WORKSPACE_DEFAULT)
    expect(state.workspacePane).toBe('review')
    frameActions.setWorkspace(state, 700)
    frameActions.closeWorkspace(state)
    expect(state.workspace).toBe(0)
    frameActions.openWorkspace(state)
    expect(state.workspace).toBe(700)
    // Another pane switches instead of closing; the same pane closes.
    frameActions.toggleWorkspace(state, 'files')
    expect(state.workspacePane).toBe('files')
    expect(state.workspace).toBe(700)
    frameActions.toggleWorkspace(state, 'files')
    expect(state.workspace).toBe(0)
    frameActions.toggleWorkspace(state)
    expect(state.workspace).toBe(700)
    expect(state.workspacePane).toBe('files')
    frameActions.toggleWorkspace(state)
    expect(state.workspace).toBe(0)
  })

  it('toggles the environment card and the inspector column', () => {
    const state = defaultFrameState()
    expect(state.envCardOpen).toBe(false)
    frameActions.toggleEnvCard(state)
    expect(state.envCardOpen).toBe(true)
    expect(state.inspectorOpen).toBe(false)
    frameActions.openInspector(state)
    expect(state.inspectorOpen).toBe(true)
    frameActions.closeInspector(state)
    expect(state.inspectorOpen).toBe(false)
    expect(state.inspectorWidth).toBe(INSPECTOR_DEFAULT)
    frameActions.setInspectorWidth(state, 9999)
    expect(state.inspectorWidth).toBe(720)
    frameActions.setInspectorWidth(state, 10)
    expect(state.inspectorWidth).toBe(320)
  })

  it('round-trips persisted state and ignores garbage', () => {
    const state = defaultFrameState()
    state.sidebar = 0
    state.workspace = 640
    state.workspacePane = 'terminal'
    state.envCardOpen = true
    state.inspectorOpen = true
    state.inspectorWidth = 500
    const restored = restoreFrameState(serializeFrameState(state))
    expect(restored).toEqual(state)
    expect(restoreFrameState('{not json')).toEqual(defaultFrameState())
    expect(
      restoreFrameState(
        JSON.stringify({
          workspacePane: 'nope',
          sidebar: 'x',
          envCardOpen: 'yes',
          inspectorWidth: 'wide',
        }),
      ),
    ).toEqual(defaultFrameState())
  })
})

describe('v1 → v2 frame migration', () => {
  type Expected = Partial<
    Pick<
      FrameState,
      'workspace' | 'workspacePane' | 'envCardOpen' | 'inspectorOpen'
    >
  >
  // [v1 detailsTab, v1 details width (0 = closed), expected v2 fields]
  const TABLE: readonly [string, number, Expected][] = [
    ['git', 400, { workspacePane: 'review', workspace: 400 }],
    ['git', 0, { workspacePane: 'review', workspace: 0 }],
    ['files', 480, { workspacePane: 'files', workspace: 480 }],
    ['terminal', 320, { workspacePane: 'terminal', workspace: WORKSPACE_MIN }],
    ['browser', 360, { workspacePane: 'launcher', workspace: 360 }],
    [
      'environment',
      360,
      { workspacePane: 'launcher', workspace: 0, envCardOpen: true },
    ],
    // v1 defaulted the tab to 'environment': a closed column opens nothing.
    [
      'environment',
      0,
      { workspacePane: 'launcher', workspace: 0, envCardOpen: false },
    ],
    [
      'inspect',
      360,
      { workspacePane: 'launcher', workspace: 0, inspectorOpen: true },
    ],
    [
      'inspect',
      0,
      { workspacePane: 'launcher', workspace: 0, inspectorOpen: false },
    ],
    ['bogus', 400, { workspacePane: 'launcher', workspace: 0 }],
  ]

  it.each(TABLE)('maps tab %s (details %i)', (tab, details, expected) => {
    const migrated = migrateFrameV1(
      JSON.stringify({
        sidebar: 300,
        details,
        detailsWidth: 400,
        detailsTab: tab,
      }),
    )
    expect(migrated).toMatchObject(expected)
    expect(migrated.sidebar).toBe(300)
    expect(migrated.workspaceWidth).toBe(400)
  })

  it('keeps a collapsed sidebar and clamps the remembered width', () => {
    const migrated = migrateFrameV1(
      JSON.stringify({ sidebar: 0, details: 0, detailsWidth: 300 }),
    )
    expect(migrated.sidebar).toBe(0)
    expect(migrated.workspaceWidth).toBe(WORKSPACE_MIN)
    expect(migrateFrameV1('{broken')).toEqual(defaultFrameState())
  })

  function memoryStorage(seed: Record<string, string>): FrameStorage & {
    data: Map<string, string>
  } {
    const data = new Map(Object.entries(seed))
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    }
  }

  it('migrates once: writes v2, then deletes v1', () => {
    const storage = memoryStorage({
      [LEGACY_FRAME_STORAGE_KEY]: JSON.stringify({
        sidebar: 280,
        details: 400,
        detailsWidth: 400,
        detailsTab: 'files',
      }),
    })
    const state = loadFrameState(storage)
    expect(state).toMatchObject({ workspacePane: 'files', workspace: 400 })
    expect(storage.data.has(LEGACY_FRAME_STORAGE_KEY)).toBe(false)
    expect(
      restoreFrameState(storage.data.get(FRAME_STORAGE_KEY)),
    ).toMatchObject({ workspacePane: 'files', workspace: 400 })
  })

  it('prefers an existing v2 snapshot and drops a stale v1 one', () => {
    const v2 = defaultFrameState()
    v2.workspacePane = 'terminal'
    const storage = memoryStorage({
      [FRAME_STORAGE_KEY]: serializeFrameState(v2),
      [LEGACY_FRAME_STORAGE_KEY]: JSON.stringify({ detailsTab: 'git' }),
    })
    expect(loadFrameState(storage).workspacePane).toBe('terminal')
    expect(storage.data.has(LEGACY_FRAME_STORAGE_KEY)).toBe(false)
  })

  it('falls back to defaults without storage', () => {
    expect(loadFrameState(null)).toEqual(defaultFrameState())
    const throwing: FrameStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    }
    expect(loadFrameState(throwing)).toEqual(defaultFrameState())
  })
})
