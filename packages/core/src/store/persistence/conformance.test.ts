import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AppendOnlyJournalSync,
  AtomicSnapshot,
  AtomicSnapshotSync,
  createNodePersistenceAdapter,
  createNodeSyncPersistenceAdapter,
  type JournalCodec,
  type SnapshotCodec,
} from './index'

interface SnapshotValue {
  label: string
}

/**
 * 测试夹具：带 schema 信封和 sha256 校验和的 JSONL 行编解码器。
 * 生产代码的 journal 使用各自领域自带的 codec，这里只为约束 kernel 行为。
 */
function createEnvelopeJournalCodec<T>(options: {
  readonly schemaVersion: number
  validatePayload(input: unknown): T
}): JournalCodec<T> {
  const checksumFor = (schemaVersion: number, seq: number, payload: unknown) =>
    createHash('sha256')
      .update(JSON.stringify({ schemaVersion, seq, payload }))
      .digest('hex')
  return {
    schemaVersion: options.schemaVersion,
    create(seq, payload) {
      return {
        schemaVersion: options.schemaVersion,
        seq,
        checksum: checksumFor(options.schemaVersion, seq, payload),
        payload,
      }
    },
    encode(entry) {
      return {
        schema_version: entry.schemaVersion,
        seq: entry.seq,
        checksum: entry.checksum,
        payload: entry.payload,
      }
    },
    decode(input) {
      if (!isRecord(input)) throw new Error('journal row must be an object')
      const schemaVersion = Number(input.schema_version)
      const seq = Number(input.seq)
      const checksum = String(input.checksum ?? '')
      if (
        !Number.isSafeInteger(schemaVersion) ||
        schemaVersion < 1 ||
        schemaVersion > options.schemaVersion ||
        !Number.isSafeInteger(seq) ||
        seq < 1 ||
        !checksum
      )
        throw new Error('invalid journal envelope')
      if (checksum !== checksumFor(schemaVersion, seq, input.payload))
        throw new Error('journal checksum mismatch')
      return {
        schemaVersion,
        seq,
        checksum,
        payload: options.validatePayload(input.payload),
      }
    },
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
