import { describe, expect, it } from 'vitest'
import type { TurnChangeSnapshot } from '../../types'
import {
  shouldShowTurnChangesStatus,
  turnChangesHeadline,
  turnChangesStatusText,
} from './turnChangesModel'

const snapshot: TurnChangeSnapshot = {
  version: 1,
  sessionId: 'session-1',
  turnId: 'turn-1',
  status: 'complete',
  filesChanged: 4,
  additions: 126,
  deletions: 34,
  binaryFiles: 0,
  truncated: false,
  files: [],
  seq: 2,
  updatedAt: 1,
}

describe('turn changes presentation', () => {
  it('formats exact and partial summaries without pretending partial is total', () => {
    expect(turnChangesHeadline(snapshot)).toBe('修改了 4 个文件')
    expect(turnChangesStatusText(snapshot)).toBe('4 files changed · +126 −34')
    expect(turnChangesHeadline({ ...snapshot, status: 'partial' })).toBe(
      '已确认修改 4 个文件',
    )
  })

  it('shows the compact status only while the ledger is actively tracking', () => {
    expect(
      shouldShowTurnChangesStatus({ ...snapshot, status: 'tracking' }, true),
    ).toBe(true)
    expect(shouldShowTurnChangesStatus(snapshot, true)).toBe(false)
    expect(
      shouldShowTurnChangesStatus({ ...snapshot, status: 'partial' }, true),
    ).toBe(false)
    expect(
      shouldShowTurnChangesStatus({ ...snapshot, status: 'tracking' }, false),
    ).toBe(false)
  })
})
