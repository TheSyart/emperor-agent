import { describe, expect, it } from 'vitest'
import {
  applyTurnChangeSnapshot,
  createTurnChangeProjection,
  latestTurnChangeForSession,
  turnChangeForMessage,
} from './turnChangeProjection'

describe('turn change projection', () => {
  it('keeps the newest snapshot for each turn and exposes the active task', () => {
    const state = createTurnChangeProjection()
    applyTurnChangeSnapshot(state, {
      event: 'turn_change_snapshot',
      seq: 8,
      session_id: 'session-1',
      turn_id: 'turn-1',
      version: 1,
      turnId: 'turn-1',
      status: 'tracking',
      filesChanged: 1,
      additions: 3,
      deletions: 1,
      binaryFiles: 0,
      truncated: false,
      files: [
        {
          path: 'src/a.ts',
          kind: 'modified',
          additions: 3,
          deletions: 1,
          binary: false,
        },
      ],
    })
    applyTurnChangeSnapshot(state, {
      event: 'turn_change_snapshot',
      seq: 9,
      session_id: 'session-1',
      turn_id: 'turn-1',
      version: 1,
      turnId: 'turn-1',
      status: 'complete',
      filesChanged: 2,
      additions: 7,
      deletions: 2,
      binaryFiles: 0,
      truncated: false,
      files: [],
    })

    expect(latestTurnChangeForSession(state, 'session-1')).toMatchObject({
      turnId: 'turn-1',
      status: 'complete',
      filesChanged: 2,
    })
    expect(turnChangeForMessage(state, 'session-1', 'turn-1')).toMatchObject({
      additions: 7,
      deletions: 2,
    })
  })

  it('ignores stale and foreign snapshots', () => {
    const state = createTurnChangeProjection()
    const current = {
      event: 'turn_change_snapshot' as const,
      seq: 12,
      session_id: 'session-1',
      turn_id: 'turn-1',
      version: 1 as const,
      turnId: 'turn-1',
      status: 'tracking' as const,
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      binaryFiles: 0,
      truncated: false,
      files: [],
    }
    applyTurnChangeSnapshot(state, current)
    applyTurnChangeSnapshot(state, { ...current, seq: 11, filesChanged: 9 })
    applyTurnChangeSnapshot(state, {
      ...current,
      seq: 13,
      session_id: '',
      filesChanged: 10,
    })

    expect(latestTurnChangeForSession(state, 'session-1')?.filesChanged).toBe(1)
  })

  it('updates one execution snapshot when a control resume creates a new turn', () => {
    const state = createTurnChangeProjection()
    const base = {
      event: 'turn_change_snapshot' as const,
      session_id: 'session-1',
      version: 2 as const,
      executionId: 'execution-1',
      rootTurnId: 'turn-1',
      status: 'tracking' as const,
      binaryFiles: 0,
      truncated: false,
      files: [],
    }
    applyTurnChangeSnapshot(state, {
      ...base,
      seq: 20,
      turn_id: 'turn-1',
      turnId: 'turn-1',
      activeTurnId: 'turn-1',
      filesChanged: 1,
      additions: 100,
      deletions: 0,
    })
    applyTurnChangeSnapshot(state, {
      ...base,
      seq: 21,
      turn_id: 'turn-2',
      turnId: 'turn-2',
      activeTurnId: 'turn-2',
      status: 'complete',
      filesChanged: 1,
      additions: 443,
      deletions: 0,
    })

    expect(Object.values(state.byTurn)).toHaveLength(1)
    expect(latestTurnChangeForSession(state, 'session-1')).toMatchObject({
      executionId: 'execution-1',
      rootTurnId: 'turn-1',
      activeTurnId: 'turn-2',
      additions: 443,
      status: 'complete',
    })
    expect(turnChangeForMessage(state, 'session-1', 'turn-2')).toMatchObject({
      executionId: 'execution-1',
    })
  })
})
