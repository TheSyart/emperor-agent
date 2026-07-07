import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HistoryLog } from './history'
import { selectCompactionRange } from './compaction-range'
import type { SessionMemoryCursor } from './compaction-models'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function cursor(overrides: Partial<SessionMemoryCursor> = {}): SessionMemoryCursor {
  return {
    sessionId: 'session_1',
    lastHistorySeq: 0,
    compactedUntilSeq: 0,
    archivedUntilSeq: 0,
    status: 'active',
    ...overrides,
  }
}

function makeHistory(turns: number): HistoryLog {
  const dir = tmp('emperor-compaction-range-')
  const log = new HistoryLog(dir, join(dir, 'history.jsonl'))
  for (let i = 1; i <= turns; i += 1) {
    log.append({ role: 'user', content: `request ${i}`, turn_id: `turn_${i}` })
    log.append({ role: 'assistant', content: `answer ${i}`, turn_id: `turn_${i}` })
  }
  return log
}

describe('selectCompactionRange', () => {
  it('selects an uncompacted range while keeping the latest completed turns', () => {
    const history = makeHistory(6)

    const range = selectCompactionRange({
      sessionId: 'session_1',
      cursor: cursor(),
      history,
      trigger: { kind: 'manual' },
      keepTailTurns: 2,
    })

    expect(range).toMatchObject({
      sessionId: 'session_1',
      fromSeq: 1,
      toSeq: 8,
      keepTailFromSeq: 9,
      stableBoundarySeq: 12,
      completedTurnCount: 4,
      reason: 'manual',
    })
  })

  it('does not return already compacted ranges', () => {
    const history = makeHistory(4)

    const range = selectCompactionRange({
      sessionId: 'session_1',
      cursor: cursor({ compactedUntilSeq: 8 }),
      history,
      trigger: { kind: 'manual' },
      keepTailTurns: 2,
    })

    expect(range).toBeNull()
  })

  it('force manual compaction includes the whole stable boundary', () => {
    const history = makeHistory(3)

    const range = selectCompactionRange({
      sessionId: 'session_1',
      cursor: cursor(),
      history,
      trigger: { kind: 'manual', force: true },
      keepTailTurns: 2,
    })

    expect(range).toMatchObject({
      fromSeq: 1,
      toSeq: 6,
      keepTailFromSeq: 7,
      stableBoundarySeq: 6,
      completedTurnCount: 3,
    })
  })
})
