// KRN-12 (CORE-37): a version the index no longer lists loses its snapshot
// file — when the index is trimmed to maxVersions, and in a sweep for
// snapshot files nothing lists (older than an hour, so a snapshot written
// just before its index line is never taken).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryVersionStore } from './versions'

function setup(maxVersions: number) {
  const root = mkdtempSync(join(tmpdir(), 'emperor-memv-'))
  const memoryDir = join(root, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const file = join(memoryDir, 'MEMORY.local.md')
  const store = new MemoryVersionStore(root, memoryDir, join(root, 'USER.md'), {
    maxVersions,
  })
  return { root, store, file, snapshots: store.snapshotsDir }
}

function snapshotFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

const DAY = 24 * 60 * 60 * 1000

describe('MemoryVersionStore retention (KRN-12)', () => {
  it('deletes the snapshot of a version trimmed from the index', () => {
    const { store, file, snapshots } = setup(3)
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(file, `版本 ${index}\n`, 'utf8')
      store.snapshotPath(file, { reason: 'test' })
    }
    const kept = store.list({ limit: 10 })
    expect(kept).toHaveLength(3)
    expect(snapshotFiles(snapshots)).toEqual(
      kept.map((version) => `${version.id}.json`).sort(),
    )
    expect(store.detail(kept[2]!.id).content).toBe('版本 2\n')
  })

  it('sweeps snapshot files the index does not list, older than an hour', () => {
    const { store, file, snapshots } = setup(10)
    writeFileSync(file, '保留\n', 'utf8')
    const listed = store.snapshotPath(file)!
    const old = join(snapshots, 'memv_1700000000000_deadbeef_abcdef.json')
    const fresh = join(snapshots, 'memv_1700000000001_deadbeef_abcdef.json')
    const tmpLeft = join(snapshots, '.memv_x.json.0123456789abcdef.tmp')
    const foreign = join(snapshots, 'notes.txt')
    for (const path of [old, fresh, tmpLeft, foreign])
      writeFileSync(path, '{"version":{},"content":"x"}', 'utf8')
    const longAgo = new Date(Date.now() - 2 * DAY)
    for (const path of [old, tmpLeft, foreign])
      utimesSync(path, longAgo, longAgo)
    const listedPath = join(snapshots, `${listed.id}.json`)
    utimesSync(listedPath, longAgo, longAgo)

    const swept = store.pruneOrphans()

    expect(swept.removed).toBe(2)
    expect(swept.bytes).toBeGreaterThan(0)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(tmpLeft)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(listedPath)).toBe(true)
    expect(store.detail(listed.id).content).toBe('保留\n')
  })
})
