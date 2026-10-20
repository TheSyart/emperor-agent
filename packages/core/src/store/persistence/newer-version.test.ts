// REL-03: a snapshot written by a newer Emperor (its version field above
// what this build writes) is read as well as it can be, never quarantined
// and never overwritten. A damaged file is still quarantined as before.
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AtomicSnapshot,
  AtomicSnapshotSync,
  DataFileNewerError,
  NEWER_FILE_MESSAGE,
  assertNotNewerSync,
  declaredVersion,
  type SnapshotCodec,
} from './index'

interface Doc {
  version: number
  label: string
}

/** Rejects any version but 1, the way a strict store decoder does. */
const strictCodec: SnapshotCodec<Doc> = {
  schemaVersion: 1,
  versionKey: 'version',
  encode(value) {
    return { ...value, version: 1 }
  },
  decode(input) {
    const raw = input as Record<string, unknown>
    if (raw.version !== 1) throw new Error('unsupported version')
    return {
      value: { version: 1, label: String(raw.label ?? '') },
      schemaVersion: 1,
    }
  },
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-newer-'))
}

function fixture(body: unknown): { root: string; path: string; raw: string } {
  const root = dir()
  const path = join(root, 'doc.json')
  const raw = `${JSON.stringify(body, null, 2)}\n`
  writeFileSync(path, raw, { mode: 0o600 })
  return { root, path, raw }
}

describe('declaredVersion', () => {
  it('reads the key of an object and the highest item version of a list', () => {
    expect(declaredVersion({ version: 2 }, 'version')).toBe(2)
    expect(declaredVersion({ schemaVersion: 3 }, 'schemaVersion')).toBe(3)
    expect(declaredVersion({ schemaVersion: 3 }, 'version')).toBeNull()
    expect(
      declaredVersion([{ version: 1 }, { version: 4 }, {}], 'version'),
    ).toBe(4)
    expect(declaredVersion([], 'version')).toBeNull()
    expect(declaredVersion({ version: '2' }, 'version')).toBeNull()
    expect(declaredVersion(null, 'version')).toBeNull()
  })
})

describe('AtomicSnapshot and a file from a newer Emperor', () => {
  it('reads it as well as it can, keeps it in place and refuses to write', async () => {
    const { root, path, raw } = fixture({
      version: 7,
      label: 'from the future',
      futureOnly: true,
    })
    const before = statSync(path)
    const snapshot = new AtomicSnapshot({ path, codec: strictCodec })

    const read = await snapshot.read({
      fallback: { version: 1, label: 'fallback' },
    })
    expect(read.found).toBe(true)
    expect(read.value.label).toBe('from the future')
    expect(read.receipt).toMatchObject({
      recoveryAction: 'newer_version_read_only',
      schemaVersion: 7,
      corruptionBackup: null,
    })

    await expect(
      snapshot.write({ version: 1, label: 'overwrite' }),
    ).rejects.toBeInstanceOf(DataFileNewerError)
    await expect(
      new AtomicSnapshot({ path, codec: strictCodec }).write({
        version: 1,
        label: 'a fresh instance',
      }),
    ).rejects.toMatchObject({
      code: 'data_file_newer',
      message: `${NEWER_FILE_MESSAGE}：doc.json`,
    })

    expect(readFileSync(path, 'utf8')).toBe(raw)
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
    expect(readdirSync(root)).toEqual(['doc.json'])
  })

  it('falls back without quarantine when even the best-effort read fails', async () => {
    const { root, path, raw } = fixture({ version: 9, label: 3 })
    const codec: SnapshotCodec<Doc> = {
      ...strictCodec,
      decode() {
        throw new Error('cannot make sense of it')
      },
    }
    const read = await new AtomicSnapshot({ path, codec }).read({
      fallback: { version: 1, label: 'fallback' },
    })
    expect(read).toMatchObject({
      found: true,
      value: { label: 'fallback' },
      receipt: { recoveryAction: 'newer_version_read_only' },
    })
    expect(readFileSync(path, 'utf8')).toBe(raw)
    expect(readdirSync(root)).toEqual(['doc.json'])
  })

  it('still quarantines a damaged file and writes over an older one', async () => {
    const broken = fixture('placeholder')
    writeFileSync(broken.path, '{"version": 1, "label": ')
    const read = await new AtomicSnapshot({
      path: broken.path,
      codec: strictCodec,
    }).read({ fallback: { version: 1, label: 'fallback' } })
    expect(read.receipt.recoveryAction).toBe('quarantined_corrupt_snapshot')
    expect(
      readdirSync(broken.root).some((name) => name.includes('.corrupt-')),
    ).toBe(true)

    const older = fixture({ label: 'unversioned' })
    await new AtomicSnapshot({ path: older.path, codec: strictCodec }).write({
      version: 1,
      label: 'now versioned',
    })
    expect(JSON.parse(readFileSync(older.path, 'utf8'))).toEqual({
      version: 1,
      label: 'now versioned',
    })
  })
})

describe('AtomicSnapshotSync and a file from a newer Emperor', () => {
  it('behaves like the async snapshot', () => {
    const { root, path, raw } = fixture([
      { version: 1, label: 'a' },
      { version: 2, label: 'b' },
    ])
    const listCodec: SnapshotCodec<Doc[]> = {
      schemaVersion: 1,
      versionKey: 'version',
      encode: (value) => value,
      decode: (input) => ({ value: input as Doc[], schemaVersion: 1 }),
    }
    const snapshot = new AtomicSnapshotSync({ path, codec: listCodec })
    const read = snapshot.read({ fallback: [] })
    expect(read.value).toHaveLength(2)
    expect(read.receipt.recoveryAction).toBe('newer_version_read_only')
    expect(() => snapshot.write([])).toThrow(DataFileNewerError)
    expect(readFileSync(path, 'utf8')).toBe(raw)
    expect(readdirSync(root)).toEqual(['doc.json'])
  })
})

describe('assertNotNewerSync', () => {
  it('throws only for a file that declares a newer version', () => {
    const newer = fixture({ schemaVersion: 2 })
    expect(() => assertNotNewerSync(newer.path, 'schemaVersion', 1)).toThrow(
      DataFileNewerError,
    )
    const same = fixture({ schemaVersion: 1 })
    expect(() =>
      assertNotNewerSync(same.path, 'schemaVersion', 1),
    ).not.toThrow()
    const damaged = fixture('x')
    writeFileSync(damaged.path, '{')
    expect(() =>
      assertNotNewerSync(damaged.path, 'schemaVersion', 1),
    ).not.toThrow()
    expect(() =>
      assertNotNewerSync(join(dir(), 'missing.json'), 'version', 1),
    ).not.toThrow()
  })
})
