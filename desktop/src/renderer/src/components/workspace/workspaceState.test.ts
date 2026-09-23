// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FRAME_STORAGE_KEY,
  resetFrameStateForTest,
  useFrameState,
} from '../shell/frameState'
import {
  closeWorkspace,
  consumeWorkspaceRequest,
  openWorkspacePane,
  requestWorkspace,
  toggleWorkspacePane,
  workspaceRequest,
} from './workspaceState'

beforeEach(() => {
  window.localStorage.removeItem(FRAME_STORAGE_KEY)
  resetFrameStateForTest()
  const pending = workspaceRequest().value
  if (pending) consumeWorkspaceRequest(pending)
})

describe('workspaceState', () => {
  it('opens the column on the requested pane and exposes the payload', () => {
    const frame = useFrameState()
    expect(frame.workspace).toBe(0)
    const request = requestWorkspace({
      pane: 'files',
      file: { path: 'src/a.ts', line: 3 },
    })
    expect(frame.workspace).toBeGreaterThan(0)
    expect(frame.workspacePane).toBe('files')
    expect(workspaceRequest().value).toEqual(request)
    expect(request.file).toEqual({ path: 'src/a.ts', line: 3 })
  })

  it('gives every request a fresh nonce and only consumes the latest', () => {
    const first = requestWorkspace({ pane: 'review', paths: ['a.ts'] })
    const second = requestWorkspace({
      pane: 'browser',
      url: 'http://localhost:5173',
    })
    expect(second.nonce).toBeGreaterThan(first.nonce)
    expect(useFrameState().workspacePane).toBe('browser')
    consumeWorkspaceRequest(first)
    expect(workspaceRequest().value).toBe(second)
    consumeWorkspaceRequest(second)
    expect(workspaceRequest().value).toBeNull()
  })

  it('opens, toggles and closes the column without a payload', () => {
    const frame = useFrameState()
    openWorkspacePane('terminal')
    expect(frame.workspacePane).toBe('terminal')
    expect(frame.workspace).toBeGreaterThan(0)
    // Another pane switches; the showing pane closes.
    toggleWorkspacePane('review')
    expect(frame.workspacePane).toBe('review')
    expect(frame.workspace).toBeGreaterThan(0)
    toggleWorkspacePane('review')
    expect(frame.workspace).toBe(0)
    toggleWorkspacePane()
    expect(frame.workspace).toBeGreaterThan(0)
    closeWorkspace()
    expect(frame.workspace).toBe(0)
    expect(workspaceRequest().value).toBeNull()
  })
})
