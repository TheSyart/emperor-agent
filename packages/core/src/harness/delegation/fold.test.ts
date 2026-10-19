import { describe, expect, it } from 'vitest'
import { DelegationFold, type DelegationEvent } from './fold'
import {
  fixtureDelegationRecord as record,
  fixtureDelegationRun as run,
} from './testing'

function entry(seq: number, payload: DelegationEvent) {
  return { schemaVersion: 1, seq, checksum: 'fixture', payload }
}
describe('delegation state transitions', () => {
  it('never returns a terminal run to running', () => {
    const fold = new DelegationFold()
    fold.apply(entry(1, { type: 'created', record: record() }))
    fold.apply(entry(2, { type: 'run-created', run: run() }))
    fold.apply(
      entry(3, {
        type: 'run-changed',
        runId: 'dgr-1',
        patch: { phase: 'cancelled' },
      }),
    )
    expect(() =>
      fold.apply(
        entry(4, {
          type: 'run-changed',
          runId: 'dgr-1',
          patch: { phase: 'running' },
        }),
      ),
    ).toThrow(/INVALID_TRANSITION/)
    expect(fold.state.runs['dgr-1']?.phase).toBe('cancelled')
  })
  it('rejects a second active run in a conversation', () => {
    const fold = new DelegationFold()
    fold.apply(entry(1, { type: 'created', record: record() }))
    fold.apply(entry(2, { type: 'run-created', run: run() }))
    expect(() =>
      fold.apply(entry(3, { type: 'run-created', run: run('dgr-2') })),
    ).toThrow(/ACTIVE_RUN/)
  })
  it('binds provider identity and send intent before acknowledgement', () => {
    const fold = new DelegationFold()
    fold.apply(entry(1, { type: 'created', record: record() }))
    fold.apply(entry(2, { type: 'run-created', run: run() }))
    fold.apply(
      entry(3, { type: 'send-intent', runId: 'dgr-1', messageId: 'dgm-1' }),
    )
    fold.apply(
      entry(4, {
        type: 'provider-bound',
        runId: 'dgr-1',
        sessionId: 'provider-1',
        turnId: 'turn-1',
        generation: 1,
      }),
    )
    expect(fold.state.record?.providerSessionId).toBe('provider-1')
    expect(fold.state.runs['dgr-1']?.providerTurnId).toBe('turn-1')
  })
  it('rejects sequence gaps and keeps the last valid state', () => {
    const fold = new DelegationFold()
    expect(() =>
      fold.apply(entry(2, { type: 'created', record: record() })),
    ).toThrow(/SEQUENCE/)
    expect(fold.state.lastSeq).toBe(0)
  })
})
it('terminal metadata cannot reopen a closed conversation or idle a newer active run', () => {
  const fold = new DelegationFold()
  const events: DelegationEvent[] = [
    { type: 'created', record: record() },
    { type: 'run-created', run: run() },
    { type: 'run-changed', runId: 'dgr-1', patch: { phase: 'cancelled' } },
    { type: 'availability', availability: 'closed' },
    {
      type: 'run-changed',
      runId: 'dgr-1',
      patch: { summary: 'native history inspected' },
    },
  ]
  events.forEach((e, i) => fold.apply(entry(i + 1, e)))
  expect(fold.state.record?.availability).toBe('closed')
  fold.apply(entry(6, { type: 'availability', availability: 'idle' }))
  fold.apply(entry(7, { type: 'run-created', run: run('dgr-2') }))
  fold.apply(
    entry(8, {
      type: 'run-changed',
      runId: 'dgr-1',
      patch: { summary: 'old metadata' },
    }),
  )
  expect(fold.state.record?.availability).toBe('active')
})
describe('AGT-04 fold rules', () => {
  const settled = (failureCode: string): DelegationEvent[] => [
    { type: 'created', record: record() },
    { type: 'run-created', run: run() },
    { type: 'run-changed', runId: 'dgr-1', patch: { phase: 'preparing' } },
    { type: 'run-changed', runId: 'dgr-1', patch: { phase: 'running' } },
    {
      type: 'run-changed',
      runId: 'dgr-1',
      patch: { phase: 'outcome_unknown', failureCode },
    },
  ]
  it('keeps the first failure reason of a settled run', () => {
    const fold = new DelegationFold()
    // An older build rewrote it to CONNECTION_LOST on every start (SUB-33).
    ;[
      ...settled('OUTPUT_LIMIT'),
      {
        type: 'run-changed' as const,
        runId: 'dgr-1',
        patch: { failureCode: 'CONNECTION_LOST', quiescent: true },
      },
    ].forEach((e, i) => fold.apply(entry(i + 1, e)))
    expect(fold.state.runs['dgr-1']).toMatchObject({
      failureCode: 'OUTPUT_LIMIT',
      quiescent: true,
    })
  })
  it('does not bump the revision for a patch that changes nothing', () => {
    const fold = new DelegationFold()
    settled('OUTPUT_LIMIT').forEach((e, i) => fold.apply(entry(i + 1, e)))
    const revision = fold.state.runs['dgr-1']!.revision
    fold.apply(
      entry(6, {
        type: 'run-changed',
        runId: 'dgr-1',
        patch: { phase: 'outcome_unknown' },
      }),
    )
    expect(fold.state.runs['dgr-1']!.revision).toBe(revision)
  })
})
