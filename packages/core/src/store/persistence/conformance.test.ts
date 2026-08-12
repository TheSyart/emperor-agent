import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AppendOnlyJournal,
  AppendOnlyJournalSync,
  AtomicSnapshot,
  AtomicSnapshotSync,
  CasAggregate,
  LeaseIntentStore,
  PersistenceConflictError,
  PersistenceCorruptionError,
  PersistenceTerminalError,
  createEnvelopeJournalCodec,
  createNodePersistenceAdapter,
  createNodeSyncPersistenceAdapter,
  type SnapshotCodec,
} from './index'

interface SnapshotValue {
  label: string
}

const snapshotCodec: SnapshotCodec<SnapshotValue> = {
  schemaVersion: 1,
  encode(value) {
    return { schema_version: 1, label: value.label }
  },
  decode(input) {
    if (!isRecord(input)) throw new Error('snapshot must be an object')
    const version = Number(input.schema_version ?? 0)
    if (version === 0 && typeof input.name === 'string')
      return {
        value: { label: input.name },
        schemaVersion: 0,
        migrated: true,
      }
    if (version !== 1 || typeof input.label !== 'string')
      throw new Error('invalid snapshot')
    return { value: { label: input.label }, schemaVersion: 1 }
  },
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'emperor-persistence-kernel-'))
})

describe('atomic snapshot conformance', () => {
  it('atomically replaces a private snapshot and records schema durability', async () => {
    const path = join(root, 'nested', 'state.json')
    const store = new AtomicSnapshot({ path, codec: snapshotCodec })

    const written = await store.write({ label: 'current' })
    const loaded = await store.read({ fallback: { label: 'fallback' } })

    expect(written).toMatchObject({
      primitive: 'snapshot',
      schemaVersion: 1,
      durability: 'file_and_directory',
    })
    expect(loaded).toMatchObject({
      found: true,
      value: { label: 'current' },
      receipt: { schemaVersion: 1, recoveryAction: 'none' },
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('preserves the previous snapshot on temp fsync or rename failure', async () => {
    for (const operation of ['file_sync', 'rename'] as const) {
      const path = join(root, operation, 'state.json')
      const healthy = new AtomicSnapshot({ path, codec: snapshotCodec })
      await healthy.write({ label: 'old' })
      const failing = new AtomicSnapshot({
        path,
        codec: snapshotCodec,
        adapter: createNodePersistenceAdapter({
          beforeOperation(current, operationPath) {
            if (
              current === operation &&
              (current !== 'file_sync' || operationPath.includes('.tmp-'))
            )
              throw new Error(`injected ${current}`)
          },
        }),
      })

      await expect(failing.write({ label: 'new' })).rejects.toMatchObject({
        code: 'persistence_io',
        operation,
      })
      await expect(
        healthy.read({ fallback: { label: 'fallback' } }),
      ).resolves.toMatchObject({ value: { label: 'old' } })
      expect(
        (await readdir(join(root, operation))).filter((name) =>
          name.includes('.tmp-'),
        ),
      ).toEqual([])
    }
  })

  it('reports file-only durability when directory fsync is unavailable', async () => {
    const path = join(root, 'portable', 'state.json')
    const store = new AtomicSnapshot({
      path,
      codec: snapshotCodec,
      adapter: createNodePersistenceAdapter({
        directorySync: 'best_effort',
      }),
    })

    await expect(store.write({ label: 'portable' })).resolves.toMatchObject({
      durability: 'file_only',
    })
    await expect(
      store.read({ fallback: { label: 'fallback' } }),
    ).resolves.toMatchObject({
      receipt: { durability: 'file_only' },
    })
  })

  it('quarantines corrupt JSON and reads legacy schema through the codec', async () => {
    const corruptPath = join(root, 'corrupt.json')
    await writeFile(corruptPath, '{broken', 'utf8')
    const corruptStore = new AtomicSnapshot({
      path: corruptPath,
      codec: snapshotCodec,
    })
    const recovered = await corruptStore.read({
      fallback: { label: 'fallback' },
    })
    expect(recovered).toMatchObject({
      found: false,
      value: { label: 'fallback' },
      receipt: {
        schemaVersion: 1,
        recoveryAction: 'quarantined_corrupt_snapshot',
      },
    })
    expect(recovered.receipt.corruptionBackup).toContain(
      'corrupt.json.corrupt-',
    )
    expect(await readFile(recovered.receipt.corruptionBackup!, 'utf8')).toBe(
      '{broken',
    )

    const legacyPath = join(root, 'legacy.json')
    await writeFile(legacyPath, JSON.stringify({ name: 'legacy' }), 'utf8')
    const legacy = await new AtomicSnapshot({
      path: legacyPath,
      codec: snapshotCodec,
    }).read({ fallback: { label: 'fallback' } })
    expect(legacy).toMatchObject({
      value: { label: 'legacy' },
      receipt: { schemaVersion: 0, recoveryAction: 'migrated_in_memory' },
    })
  })

  it('rejects a codec that produces no JSON document before replacing authority', async () => {
    const path = join(root, 'invalid-encoding.json')
    const healthy = new AtomicSnapshot({ path, codec: snapshotCodec })
    await healthy.write({ label: 'old' })
    const invalid = new AtomicSnapshot<SnapshotValue>({
      path,
      codec: {
        ...snapshotCodec,
        encode: () => undefined,
      },
    })

    await expect(invalid.write({ label: 'new' })).rejects.toMatchObject({
      code: 'persistence_io',
      operation: 'serialize',
    })
    await expect(
      healthy.read({ fallback: { label: 'fallback' } }),
    ).resolves.toMatchObject({ value: { label: 'old' } })
  })
})

describe('synchronous atomic snapshot conformance', () => {
  it('preserves disk shape, private mode, legacy decoding and corruption recovery', async () => {
    const path = join(root, 'sync', 'state.json')
    const store = new AtomicSnapshotSync({ path, codec: snapshotCodec })

    store.write({ label: 'current' })
    expect(store.read({ fallback: { label: 'fallback' } })).toMatchObject({
      found: true,
      value: { label: 'current' },
      receipt: { schemaVersion: 1, recoveryAction: 'none' },
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    await writeFile(path, JSON.stringify({ name: 'legacy' }), 'utf8')
    expect(store.read({ fallback: { label: 'fallback' } })).toMatchObject({
      value: { label: 'legacy' },
      receipt: { schemaVersion: 0, recoveryAction: 'migrated_in_memory' },
    })

    await writeFile(path, '{broken', 'utf8')
    const recovered = store.read({ fallback: { label: 'fallback' } })
    expect(recovered).toMatchObject({
      found: false,
      value: { label: 'fallback' },
      receipt: { recoveryAction: 'quarantined_corrupt_snapshot' },
    })
    expect(recovered.receipt.corruptionBackup).toContain('state.json.corrupt-')
  })

  it('keeps the previous snapshot when synchronous fsync or rename fails', () => {
    for (const operation of ['file_sync', 'rename'] as const) {
      const path = join(root, 'sync-failure', operation, 'state.json')
      const healthy = new AtomicSnapshotSync({ path, codec: snapshotCodec })
      healthy.write({ label: 'old' })
      const failing = new AtomicSnapshotSync({
        path,
        codec: snapshotCodec,
        adapter: createNodeSyncPersistenceAdapter({
          beforeOperation(current, operationPath) {
            if (
              current === operation &&
              (current !== 'file_sync' || operationPath.includes('.tmp-'))
            )
              throw new Error(`injected ${current}`)
          },
        }),
      })

      expect(() => failing.write({ label: 'new' })).toThrow(
        expect.objectContaining({ code: 'persistence_io', operation }),
      )
      expect(healthy.read({ fallback: { label: 'fallback' } }).value).toEqual({
        label: 'old',
      })
    }
  })
})

describe('synchronous append journal conformance', () => {
  it('appends private checksummed rows and repairs a partial tail', async () => {
    const path = join(root, 'sync-journal', 'events.jsonl')
    const codec = createEnvelopeJournalCodec({
      schemaVersion: 1,
      validatePayload(input) {
        if (!isRecord(input) || typeof input.label !== 'string')
          throw new Error('invalid payload')
        return { label: input.label }
      },
    })
    const journal = new AppendOnlyJournalSync({ path, codec })

    journal.append({ label: 'one' })
    journal.append({ label: 'two' })
    await appendFile(path, '{"schema_version":1', 'utf8')
    const replayed = journal.replay({ repairTail: true })

    expect(replayed.entries.map((entry) => entry.payload.label)).toEqual([
      'one',
      'two',
    ])
    expect(replayed.receipt).toMatchObject({
      primitive: 'journal',
      lastGoodSeq: 2,
      recoveryAction: 'truncated_partial_tail',
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(
      (await readdir(dirname(path))).some((name) =>
        name.startsWith('events.jsonl.corrupt-tail-'),
      ),
    ).toBe(true)
  })

  it('retains rows idempotently with the synchronous durability adapter', () => {
    const path = join(root, 'sync-retain', 'events.jsonl')
    const archivePath = join(root, 'sync-retain', 'archive.jsonl')
    const codec = createEnvelopeJournalCodec({
      schemaVersion: 1,
      validatePayload(input) {
        if (!isRecord(input) || typeof input.value !== 'number')
          throw new Error('invalid payload')
        return { value: input.value }
      },
    })
    const journal = new AppendOnlyJournalSync({ path, codec })
    for (let value = 1; value <= 4; value += 1) journal.append({ value })

    expect(journal.retain({ maxRecords: 2, archivePath })).toEqual({
      archived: 2,
      retained: 2,
    })
    expect(journal.replay().entries.map((entry) => entry.seq)).toEqual([3, 4])
    expect(
      new AppendOnlyJournalSync({ path: archivePath, codec })
        .replay()
        .entries.map((entry) => entry.seq),
    ).toEqual([1, 2])
  })

  it('supports a domain-owned tolerant recovery policy while preserving a backup', async () => {
    const path = join(root, 'sync-tolerant', 'events.jsonl')
    const codec = createEnvelopeJournalCodec({
      schemaVersion: 1,
      validatePayload(input) {
        if (!isRecord(input) || typeof input.value !== 'number')
          throw new Error('invalid payload')
        return { value: input.value }
      },
    })
    const first = codec.create(1, { value: 1 })
    const third = codec.create(3, { value: 3 })
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      `${JSON.stringify(codec.encode(first))}\nnot-json\n${JSON.stringify(codec.encode(third))}\n`,
      'utf8',
    )
    const journal = new AppendOnlyJournalSync({
      path,
      codec,
      recoveryMode: 'tolerant',
    })

    const replayed = journal.replay({ repairTail: true })

    expect(replayed.entries.map((entry) => entry.seq)).toEqual([1, 3])
    expect(replayed.receipt.recoveryAction).toBe(
      'filtered_corrupt_journal_rows',
    )
    expect(replayed.receipt.corruptionBackup).toContain('events.jsonl.corrupt-')
    expect((await readFile(path, 'utf8')).includes('not-json')).toBe(false)
  })
})

describe('append journal conformance', () => {
  const journalCodec = createEnvelopeJournalCodec<{ value: number }>({
    schemaVersion: 1,
    validatePayload(input) {
      if (!isRecord(input) || !Number.isInteger(input.value))
        throw new Error('invalid journal payload')
      return { value: Number(input.value) }
    },
  })

  it('assigns unique checksummed sequences under concurrent writers', async () => {
    const path = join(root, 'events.jsonl')
    const first = new AppendOnlyJournal({ path, codec: journalCodec })
    const second = new AppendOnlyJournal({ path, codec: journalCodec })

    await Promise.all(
      Array.from({ length: 8 }, (_, value) =>
        (value % 2 === 0 ? first : second).append({ value }),
      ),
    )
    const replay = await first.replay()

    expect(replay.entries.map((entry) => entry.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ])
    expect(new Set(replay.entries.map((entry) => entry.checksum)).size).toBe(8)
    expect(replay.receipt).toMatchObject({
      schemaVersion: 1,
      lastGoodSeq: 8,
      recoveryAction: 'none',
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('supports a sequence owned by a serialized domain writer', async () => {
    const path = join(root, 'domain-sequence.jsonl')
    const journal = new AppendOnlyJournal({ path, codec: journalCodec })

    await journal.appendAtSequence({ value: 1 }, 1)
    await journal.appendAtSequence({ value: 2 }, 2)

    await expect(journal.replay()).resolves.toMatchObject({
      entries: [
        { seq: 1, payload: { value: 1 } },
        { seq: 2, payload: { value: 2 } },
      ],
      receipt: { lastGoodSeq: 2 },
    })
  })

  it('backs up and truncates only an invalid partial tail', async () => {
    const path = join(root, 'events.jsonl')
    const journal = new AppendOnlyJournal({ path, codec: journalCodec })
    await journal.append({ value: 1 })
    await journal.append({ value: 2 })
    await appendFile(path, '{"schema_version":1', 'utf8')

    const replay = await journal.replay({ repairTail: true })

    expect(replay.entries.map((entry) => entry.payload.value)).toEqual([1, 2])
    expect(replay.receipt).toMatchObject({
      lastGoodSeq: 2,
      recoveryAction: 'truncated_partial_tail',
    })
    expect(await readFile(replay.receipt.corruptionBackup!, 'utf8')).toBe(
      '{"schema_version":1',
    )
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true)
  })

  it('fails closed on a corrupt committed line', async () => {
    const path = join(root, 'events.jsonl')
    const journal = new AppendOnlyJournal({ path, codec: journalCodec })
    await journal.append({ value: 1 })
    await appendFile(path, 'not-json\n', 'utf8')

    const failure = await journal
      .replay({ repairTail: true })
      .then(() => null)
      .catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(PersistenceCorruptionError)
    expect(failure).toMatchObject({ lastGoodSeq: 1 })
    expect((failure as PersistenceCorruptionError).corruptionBackup).toContain(
      'events.jsonl.corrupt-',
    )
    expect(
      await readFile(
        (failure as PersistenceCorruptionError).corruptionBackup!,
        'utf8',
      ),
    ).toContain('not-json')
    expect(await readFile(path, 'utf8')).toContain('not-json')
  })

  it('reports the schema version actually read instead of the writer maximum', async () => {
    const path = join(root, 'reader-version.jsonl')
    const versionOne = new AppendOnlyJournal({ path, codec: journalCodec })
    await versionOne.append({ value: 1 })
    const readerCodec = {
      ...journalCodec,
      schemaVersion: 2,
    }

    await expect(
      new AppendOnlyJournal({ path, codec: readerCodec }).replay(),
    ).resolves.toMatchObject({
      receipt: { schemaVersion: 1, lastGoodSeq: 1 },
    })
  })

  it('checksums the persisted payload independently of validator key order', async () => {
    const path = join(root, 'normalized-payload.jsonl')
    const codec = createEnvelopeJournalCodec<{ a: number; b: number }>({
      schemaVersion: 1,
      validatePayload(input) {
        if (!isRecord(input)) throw new Error('invalid normalized payload')
        return { a: Number(input.a), b: Number(input.b) }
      },
    })
    const journal = new AppendOnlyJournal({ path, codec })
    const payload = { b: 2, a: 1 } as { a: number; b: number }

    await journal.append(payload)

    await expect(journal.replay()).resolves.toMatchObject({
      entries: [{ payload: { a: 1, b: 2 } }],
    })
  })

  it('rejects a line codec that produces no JSON row before appending', async () => {
    const path = join(root, 'invalid-row.jsonl')
    const invalidCodec = {
      ...journalCodec,
      encode: () => undefined,
    }
    const journal = new AppendOnlyJournal({ path, codec: invalidCodec })

    await expect(journal.append({ value: 1 })).rejects.toMatchObject({
      code: 'persistence_io',
      operation: 'serialize',
    })
    expect(await readdir(root)).not.toContain('invalid-row.jsonl')
  })

  it('retains a bounded hot segment and archives older entries', async () => {
    const path = join(root, 'events.jsonl')
    const archivePath = join(root, 'archive', 'events.jsonl')
    const journal = new AppendOnlyJournal({ path, codec: journalCodec })
    for (let value = 1; value <= 5; value += 1) await journal.append({ value })

    const retained = await journal.retain({ maxRecords: 2, archivePath })

    expect(retained).toMatchObject({ archived: 3, retained: 2 })
    expect(
      (await journal.replay()).entries.map((entry) => entry.payload.value),
    ).toEqual([4, 5])
    expect(
      (
        await new AppendOnlyJournal({
          path: archivePath,
          codec: journalCodec,
        }).replay()
      ).entries.map((entry) => entry.payload.value),
    ).toEqual([1, 2, 3])
  })

  it('recovers idempotently when archive append committed before hot rewrite', async () => {
    const path = join(root, 'retention-crash.jsonl')
    const archivePath = join(root, 'archive-crash.jsonl')
    const journal = new AppendOnlyJournal({ path, codec: journalCodec })
    for (let value = 1; value <= 5; value += 1) await journal.append({ value })
    const entries = (await journal.replay()).entries
    await writeFile(
      archivePath,
      `${entries
        .slice(0, 3)
        .map((entry) => JSON.stringify(journalCodec.encode(entry)))
        .join('\n')}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )

    await expect(
      journal.retain({ maxRecords: 2, archivePath }),
    ).resolves.toEqual({ archived: 3, retained: 2 })
    expect(
      (
        await new AppendOnlyJournal({
          path: archivePath,
          codec: journalCodec,
        }).replay()
      ).entries,
    ).toHaveLength(3)
    expect(
      (await journal.replay()).entries.map((entry) => entry.payload.value),
    ).toEqual([4, 5])
  })
})

describe('CAS aggregate conformance', () => {
  interface Aggregate {
    count: number
    status: 'active' | 'done'
  }

  function aggregate(path: string) {
    return new CasAggregate<Aggregate>({
      path,
      schemaVersion: 1,
      initial: () => ({ count: 0, status: 'active' }),
      validateValue(input) {
        if (
          !isRecord(input) ||
          !Number.isInteger(input.count) ||
          (input.status !== 'active' && input.status !== 'done')
        )
          throw new Error('invalid aggregate')
        return { count: Number(input.count), status: input.status }
      },
      isTerminal: (value) => value.status === 'done',
    })
  }

  it('rejects stale and concurrent writers with an exact revision conflict', async () => {
    const path = join(root, 'aggregate.json')
    const first = aggregate(path)
    const second = aggregate(path)

    const outcomes = await Promise.allSettled([
      first.compareAndSwap({
        expectedRevision: 0,
        value: { count: 1, status: 'active' },
      }),
      second.compareAndSwap({
        expectedRevision: 0,
        value: { count: 2, status: 'active' },
      }),
    ])

    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1)
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    )
    expect(rejected?.reason).toBeInstanceOf(PersistenceConflictError)
    expect(rejected?.reason).toMatchObject({
      expectedRevision: 0,
      actualRevision: 1,
    })
  })

  it('makes terminal state monotonic', async () => {
    const store = aggregate(join(root, 'terminal.json'))
    const terminal = await store.compareAndSwap({
      expectedRevision: 0,
      value: { count: 1, status: 'done' },
    })
    expect(terminal).toMatchObject({ revision: 1, terminal: true })

    await expect(
      store.compareAndSwap({
        expectedRevision: 1,
        value: { count: 2, status: 'active' },
      }),
    ).rejects.toBeInstanceOf(PersistenceTerminalError)
  })

  it('fails closed on corrupt authority instead of resetting to the initial value', async () => {
    const path = join(root, 'corrupt-cas.json')
    await writeFile(path, '{broken', 'utf8')
    const store = aggregate(path)

    await expect(store.read()).rejects.toBeInstanceOf(
      PersistenceCorruptionError,
    )
    expect(
      (await readdir(root)).some((name) =>
        name.startsWith('corrupt-cas.json.corrupt-'),
      ),
    ).toBe(true)
  })

  it('allows a domain codec to preserve and read a legacy CAS document shape', async () => {
    const path = join(root, 'legacy-cas.json')
    await writeFile(
      path,
      JSON.stringify({ revision: 7, status: 'active', count: 3 }),
      'utf8',
    )
    const store = new CasAggregate<Aggregate>({
      path,
      schemaVersion: 1,
      initial: () => ({ count: 0, status: 'active' }),
      validateValue: (input) => input as Aggregate,
      isTerminal: (value) => value.status === 'done',
      codec: {
        schemaVersion: 1,
        encode(state) {
          return {
            revision: state.revision,
            status: state.value.status,
            count: state.value.count,
          }
        },
        decode(input) {
          if (!isRecord(input)) throw new Error('invalid legacy CAS')
          return {
            schemaVersion: 1,
            value: {
              revision: Number(input.revision),
              terminal: input.status === 'done',
              value: {
                count: Number(input.count),
                status: input.status === 'done' ? 'done' : 'active',
              },
            },
          }
        },
      },
    })

    await expect(store.read()).resolves.toMatchObject({
      revision: 7,
      terminal: false,
      value: { count: 3, status: 'active' },
    })
  })
})

describe('lease/intent conformance', () => {
  function leases(path: string) {
    return new LeaseIntentStore<{ action: string }>({
      path,
      schemaVersion: 1,
      retentionMs: 50,
      validatePayload(input) {
        if (!isRecord(input) || typeof input.action !== 'string')
          throw new Error('invalid intent payload')
        return { action: input.action }
      },
    })
  }

  it('prepares idempotently, enforces owner/expiry, and applies once', async () => {
    const store = leases(join(root, 'leases.json'))
    const prepared = await store.prepare({
      id: 'install',
      owner: 'session-a',
      now: 100,
      ttlMs: 50,
      payload: { action: 'download' },
    })
    const repeated = await store.prepare({
      id: 'install',
      owner: 'session-a',
      now: 110,
      ttlMs: 50,
      payload: { action: 'download' },
    })
    expect(repeated).toEqual(prepared)

    await expect(
      store.prepare({
        id: 'install',
        owner: 'session-b',
        now: 120,
        ttlMs: 50,
        payload: { action: 'download' },
      }),
    ).rejects.toBeInstanceOf(PersistenceConflictError)

    const replaced = await store.prepare({
      id: 'install',
      owner: 'session-b',
      now: 151,
      ttlMs: 50,
      payload: { action: 'download' },
    })
    expect(replaced).toMatchObject({ owner: 'session-b', revision: 2 })
    const applied = await store.markApplied({
      id: 'install',
      owner: 'session-b',
      now: 160,
    })
    expect(applied).toMatchObject({ phase: 'applied', appliedAt: 160 })
    await expect(
      store.markApplied({ id: 'install', owner: 'session-b', now: 170 }),
    ).resolves.toEqual(applied)
    await expect(
      store.prepare({
        id: 'install',
        owner: 'session-c',
        now: 250,
        ttlMs: 50,
        payload: { action: 'download' },
      }),
    ).rejects.toBeInstanceOf(PersistenceConflictError)
  })

  it('reports expired prepared intents and prunes applied retention', async () => {
    const store = leases(join(root, 'recover.json'))
    await store.prepare({
      id: 'prepared',
      owner: 'session-a',
      now: 100,
      ttlMs: 10,
      payload: { action: 'resume' },
    })
    await store.prepare({
      id: 'applied',
      owner: 'session-a',
      now: 100,
      ttlMs: 10,
      payload: { action: 'settled' },
    })
    await store.markApplied({ id: 'applied', owner: 'session-a', now: 105 })

    const first = await store.recover({ now: 120 })
    const second = await store.recover({ now: 120 })
    expect(first.expiredPrepared.map((entry) => entry.id)).toEqual(['prepared'])
    expect(second.expiredPrepared).toEqual(first.expiredPrepared)

    const pruned = await store.recover({ now: 156 })
    expect(pruned.prunedApplied).toBe(1)
    expect((await store.list()).map((entry) => entry.id)).toEqual(['prepared'])
    await expect(store.inspect()).resolves.toMatchObject({
      receipt: {
        primitive: 'lease_intent',
        schemaVersion: 1,
        recoveryAction: 'none',
      },
    })
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
