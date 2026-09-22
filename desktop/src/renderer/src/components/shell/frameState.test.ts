import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN,
  computeColumns,
  DETAILS_DEFAULT,
  SIDEBAR_COLLAPSED,
  SIDEBAR_DEFAULT,
} from './columns'
import {
  defaultFrameState,
  frameActions,
  restoreFrameState,
  serializeFrameState,
} from './frameState'

describe('column solver (dsh concession chain)', () => {
  it('keeps preferred widths when everything fits', () => {
    expect(computeColumns(1440, 280, 360)).toEqual({
      sidebar: 280,
      center: 800,
      details: 360,
    })
  })

  it('renders a closed sidebar as the 56px rail', () => {
    expect(computeColumns(1440, 0, 0).sidebar).toBe(SIDEBAR_COLLAPSED)
  })

  it('shrinks details toward its minimum before auto-closing it', () => {
    const shrunk = computeColumns(280 + CENTER_MIN + 320, 280, 400)
    expect(shrunk).toEqual({ sidebar: 280, center: CENTER_MIN, details: 320 })
    const closed = computeColumns(900, 280, 400)
    expect(closed.details).toBe(0)
    expect(closed.center).toBe(620)
  })

  it('clamps out-of-range preferences', () => {
    expect(computeColumns(2000, 9999, 10).sidebar).toBe(420)
    expect(computeColumns(2000, 280, 10).details).toBe(300)
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

  it('opens details on a tab and remembers the dragged width', () => {
    const state = defaultFrameState()
    frameActions.openDetails(state, 'git')
    expect(state.details).toBe(DETAILS_DEFAULT)
    expect(state.detailsTab).toBe('git')
    frameActions.setDetails(state, 480)
    frameActions.closeDetails(state)
    expect(state.details).toBe(0)
    frameActions.openDetails(state)
    expect(state.details).toBe(480)
    frameActions.toggleDetails(state, 'files')
    expect(state.detailsTab).toBe('files')
    expect(state.details).toBe(480)
    frameActions.toggleDetails(state)
    expect(state.details).toBe(0)
  })

  it('round-trips persisted state and ignores garbage', () => {
    const state = defaultFrameState()
    state.sidebar = 0
    state.details = 400
    state.detailsTab = 'terminal'
    const restored = restoreFrameState(serializeFrameState(state))
    expect(restored.sidebar).toBe(0)
    expect(restored.details).toBe(400)
    expect(restored.detailsTab).toBe('terminal')
    expect(restoreFrameState('{not json')).toEqual(defaultFrameState())
    expect(
      restoreFrameState(JSON.stringify({ detailsTab: 'nope', sidebar: 'x' })),
    ).toEqual(defaultFrameState())
  })
})
