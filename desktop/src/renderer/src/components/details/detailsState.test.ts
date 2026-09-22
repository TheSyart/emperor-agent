// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FRAME_STORAGE_KEY,
  resetFrameStateForTest,
  useFrameState,
} from '../shell/frameState'
import {
  closeDetails,
  consumeDetailsRequest,
  detailsRequest,
  openDetailsTab,
  requestDetails,
} from './detailsState'
import {
  clearInspectSelection,
  inspectSelection,
  selectCall,
} from './inspectState'

beforeEach(() => {
  window.localStorage.removeItem(FRAME_STORAGE_KEY)
  resetFrameStateForTest()
  const pending = detailsRequest().value
  if (pending) consumeDetailsRequest(pending)
  clearInspectSelection()
})

describe('detailsState', () => {
  it('opens the column on the requested tab and exposes the payload', () => {
    const frame = useFrameState()
    expect(frame.details).toBe(0)
    const request = requestDetails({
      tab: 'files',
      file: { path: 'src/a.ts', line: 3 },
    })
    expect(frame.details).toBeGreaterThan(0)
    expect(frame.detailsTab).toBe('files')
    expect(detailsRequest().value).toEqual(request)
    expect(request.file).toEqual({ path: 'src/a.ts', line: 3 })
  })

  it('gives every request a fresh nonce and only consumes the latest', () => {
    const first = requestDetails({ tab: 'git', paths: ['a.ts'] })
    const second = requestDetails({ tab: 'browser', previewId: 'p1' })
    expect(second.nonce).toBeGreaterThan(first.nonce)
    consumeDetailsRequest(first)
    expect(detailsRequest().value).toBe(second)
    consumeDetailsRequest(second)
    expect(detailsRequest().value).toBeNull()
  })

  it('opens and closes the column without a payload', () => {
    const frame = useFrameState()
    openDetailsTab('terminal')
    expect(frame.detailsTab).toBe('terminal')
    expect(frame.details).toBeGreaterThan(0)
    closeDetails()
    expect(frame.details).toBe(0)
    expect(detailsRequest().value).toBeNull()
  })

  it('selectCall records the inspected call and brings Inspect forward', () => {
    const frame = useFrameState()
    selectCall('s1', 'call_1')
    expect(inspectSelection.value).toEqual({
      sessionId: 's1',
      callId: 'call_1',
    })
    expect(frame.detailsTab).toBe('inspect')
    expect(frame.details).toBeGreaterThan(0)
  })
})
