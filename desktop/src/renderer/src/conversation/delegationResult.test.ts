/**
 * AGT-06: a subagent's result is one card in the conversation, placed when
 * the result arrives and updated in place as it is applied, undone or
 * discarded (`delegation/result` records).
 */
import { describe, expect, it } from 'vitest'
import { deepEqual } from './assembler'
import {
  describeNodes,
  LogBuilder,
  nodeOf,
  replay,
  stream,
  structural,
} from './testing/fixtures'

function result(extra: Record<string, unknown> = {}) {
  return {
    delegation_id: 'dlg-one',
    run_id: 'dgr-one',
    backend: 'codex',
    title: '重构登录页',
    state: 'ready',
    files: [
      { path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1 },
      { path: 'src/b.ts', status: 'added', additions: 3, deletions: 0 },
    ],
    totals: { files: 2, additions: 7, deletions: 1 },
    at: 1_750_000_000_500,
    ...extra,
  }
}

function conversation(): LogBuilder {
  const log = new LogBuilder()
  log.add('turn/start', { turn: 1 })
  log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
  log.add('delegation/result', result())
  return log
}

describe('the subagent result card', () => {
  it('appears when the result arrives, with files and line counts', () => {
    const log = conversation()
    const { snapshot } = replay(log.events)
    expect(describeNodes(snapshot).at(-1)).toBe(
      'delegationResult[ready]: codex files=2',
    )
    expect(nodeOf(snapshot, 'delegationResult').data).toMatchObject({
      delegationId: 'dlg-one',
      runId: 'dgr-one',
      backend: 'codex',
      title: '重构登录页',
      state: 'ready',
      totals: { files: 2, additions: 7, deletions: 1 },
      conflicts: [],
      undoable: false,
      verifyFirst: false,
    })
    const streamed = stream(log.events).snapshot
    expect(deepEqual(structural(streamed), structural(snapshot))).toBe(true)
  })

  it('stays one card as it is applied, then undone', () => {
    const log = conversation()
    log.add('turn/start', { turn: 2 })
    log.add('turn/end', { turn: 2, reason: { kind: 'completed' } })
    log.add(
      'delegation/result',
      result({ state: 'applied', by: 'user', undoable: true }),
    )
    log.add(
      'delegation/result',
      result({
        state: 'reverted',
        by: 'user',
        reverted: { reverted: ['src/a.ts', 'src/b.ts'], skipped: [] },
      }),
    )
    const { snapshot } = replay(log.events)
    const cards = describeNodes(snapshot).filter((line) =>
      line.startsWith('delegationResult'),
    )
    expect(cards).toEqual(['delegationResult[reverted]: codex files=2'])
    expect(nodeOf(snapshot, 'delegationResult').data.reverted).toEqual({
      reverted: ['src/a.ts', 'src/b.ts'],
      skipped: [],
    })
  })

  it('lists the conflicting files', () => {
    const log = conversation()
    log.add(
      'delegation/result',
      result({ state: 'conflicted', conflicts: ['src/a.ts'] }),
    )
    expect(
      nodeOf(replay(log.events).snapshot, 'delegationResult').data,
    ).toMatchObject({ state: 'conflicted', conflicts: ['src/a.ts'] })
  })

  it('has no card for a run that changed nothing', () => {
    const log = new LogBuilder()
    log.add(
      'delegation/result',
      result({ files: [], totals: { files: 0, additions: 0, deletions: 0 } }),
    )
    expect(
      describeNodes(replay(log.events).snapshot).filter((line) =>
        line.startsWith('delegationResult'),
      ),
    ).toEqual([])
  })
})
