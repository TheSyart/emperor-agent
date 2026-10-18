import { appendFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DelegationJournal } from './journal'
import {
  delegationTestDirectory,
  fixtureDelegationRecord as record,
  fixtureDelegationRun as run,
} from './testing'
import {
  NODE_SYNC_PERSISTENCE_ADAPTER,
  PersistenceIoError,
} from '../../store/persistence'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))
function setup() {
  const d = delegationTestDirectory()
  cleanup.push(d.cleanup)
  return { root: d.root, journal: new DelegationJournal(d.root, 'dlg-test') }
}
describe('durable external delegation journal', () => {
  it('replays two completed runs in the same conversation after reopening', async () => {
    const { root, journal } = setup()
    await journal.append({ type: 'created', record: record() })
    for (const id of ['dgr-1', 'dgr-2']) {
      await journal.append({ type: 'run-created', run: run(id) })
      await journal.append({
        type: 'run-changed',
        runId: id,
        patch: { phase: 'preparing' },
      })
      await journal.append({
        type: 'run-changed',
        runId: id,
        patch: { phase: 'running' },
      })
      await journal.append({
        type: 'run-changed',
        runId: id,
        patch: { phase: 'completed' },
      })
    }
    const state = new DelegationJournal(root, 'dlg-test').load()
    expect(state.record?.id).toBe('dlg-test')
    expect(Object.values(state.runs).map((r) => r.phase)).toEqual([
      'completed',
      'completed',
    ])
  })
  it('does not append a duplicate message with identical contents', async () => {
    const { journal } = setup()
    await journal.append({ type: 'created', record: record() })
    const event = {
      type: 'message-enqueued' as const,
      message: { id: 'dgm-1', text: 'work', status: 'queued' as const },
    }
    const a = await journal.append(event)
    const b = await journal.append(event)
    expect(a.seq).toBe(b.seq)
    expect(journal.load().lastSeq).toBe(2)
  })
  it('rebuilds state from the journal with a missing or stale snapshot', async () => {
    const { journal } = setup()
    await journal.append({ type: 'created', record: record() })
    const old = readFileSync(journal.snapshotPath, 'utf8')
    await journal.append({ type: 'run-created', run: run() })
    const expected = journal.load()
    writeFileSync(journal.snapshotPath, old)
    expect(journal.load()).toEqual(expected)
    rmSync(journal.snapshotPath)
    expect(journal.load()).toEqual(expected)
  })
  it('repairs only an incomplete final row, retaining complete facts', async () => {
    const { journal } = setup()
    await journal.append({ type: 'created', record: record() })
    appendFileSync(journal.path, '{"schemaVersion":')
    expect(journal.load().lastSeq).toBe(1)
    await journal.append({ type: 'run-created', run: run() })
    expect(journal.load().lastSeq).toBe(2)
  })
  it('rejects conflicting message ids without changing durable contents', async () => {
    const { journal } = setup()
    await journal.append({ type: 'created', record: record() })
    await journal.append({
      type: 'message-enqueued',
      message: { id: 'dgm-1', text: 'first', status: 'queued' },
    })
    const before = readFileSync(journal.path, 'utf8')
    await expect(
      journal.append({
        type: 'message-enqueued',
        message: { id: 'dgm-1', text: 'second', status: 'queued' },
      }),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/)
    expect(readFileSync(journal.path, 'utf8')).toBe(before)
  })
  it('fails closed on middle corruption and future versions without overwriting', async () => {
    const { journal } = setup()
    await journal.append({ type: 'created', record: record() })
    const body = readFileSync(journal.path, 'utf8')
    for (const damaged of [
      '{bad}\n' + body,
      body.replace('"schemaVersion":1', '"schemaVersion":2'),
    ]) {
      writeFileSync(journal.path, damaged)
      expect(() => journal.load()).toThrow(/JOURNAL_CORRUPT/)
      expect(readFileSync(journal.path, 'utf8')).toBe(damaged)
    }
  })
  it('does not acknowledge an append when disk sync fails', async () => {
    const { root } = setup()
    const adapter = {
      ...NODE_SYNC_PERSISTENCE_ADAPTER,
      appendAndSync: () => {
        throw new PersistenceIoError('append_sync', 'fixture')
      },
    }
    const journal = new DelegationJournal(root, 'dlg-test', { adapter })
    await expect(
      journal.append({ type: 'created', record: record() }),
    ).rejects.toThrow()
    expect(journal.load().record).toBeUndefined()
  })
  it('rejects path traversal before reading or writing', () => {
    const { root } = setup()
    expect(() => new DelegationJournal(root, '../foreign')).toThrow(
      /INVALID_ID/,
    )
  })
  it('does not truncate a complete future-version row without a final newline', async () => {
    const { journal } = setup()
    await journal.append({ type: 'created', record: record() })
    const future = readFileSync(journal.path, 'utf8')
      .trimEnd()
      .replace('"schemaVersion":1', '"schemaVersion":2')
    writeFileSync(journal.path, future)
    expect(() => journal.load()).toThrow(/JOURNAL_CORRUPT/)
    expect(readFileSync(journal.path, 'utf8')).toBe(future)
  })
  it('acknowledges a durable fact even if its rebuildable snapshot cache fails', async () => {
    const { root } = setup()
    const adapter = {
      ...NODE_SYNC_PERSISTENCE_ADAPTER,
      rename: (source: string, target: string) => {
        if (target.endsWith('snapshot.json'))
          throw new PersistenceIoError('rename', target)
        NODE_SYNC_PERSISTENCE_ADAPTER.rename(source, target)
      },
    }
    const journal = new DelegationJournal(root, 'dlg-test', { adapter })
    expect(
      await journal.append({ type: 'created', record: record() }),
    ).toMatchObject({ seq: 1, cacheWritten: false })
    expect(journal.load().record?.id).toBe('dlg-test')
  })
})
