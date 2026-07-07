/**
 * 记忆子系统契约 (MIG-MEM-001/002)。
 * 移植 Python:
 *  - tests/unit/test_history_log.py (HistoryLog 迁移/compact/归档 + MemoryStore.loadUnarchived/checkpoint)
 *  - tests/unit/test_memory_versions.py (MemoryVersionStore snapshot/restore/dedupe + MemoryStore writes 建版本)
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HistoryLog } from './history'
import { MemoryStore } from './store'
import { MemoryVersionStore, memoryVersionFromDict } from './versions'

type Row = Record<string, unknown>

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function archiveRows(memoryDir: string): Row[] {
  const dir = join(memoryDir, 'history_archive')
  if (!existsSync(dir)) return []
  const rows: Row[] = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl.gz')).sort()) {
    const text = gunzipSync(readFileSync(join(dir, f))).toString('utf8')
    for (const line of text.split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line))
    }
  }
  return rows
}

// ── test_history_log.py ──

describe('HistoryLog (test_history_log.py)', () => {
  it('uses text-safe separators for row signatures', () => {
    const signature = HistoryLog.signature({ role: 'user', turn_id: 't1', content: 'hello' })
    expect(signature).not.toContain('\0')
    expect(signature).toContain('\\0')
  })

  it('legacy migration archives before last marker', () => {
    const memoryDir = join(tmp('emperor-hist-mig-'), 'memory')
    mkdirSync(memoryDir, { recursive: true })
    const historyFile = join(memoryDir, 'history.jsonl')
    const legacy: Row[] = [
      { ts: '2026-05-01T10:00:00+08:00', role: 'user', content: 'old' },
      { ts: '2026-05-01T10:01:00+08:00', type: 'compact_event' },
      { ts: '2026-05-02T10:00:00+08:00', role: 'user', content: 'active' },
      { ts: '2026-05-02T10:01:00+08:00', role: 'assistant', content: 'reply' },
    ]
    writeFileSync(historyFile, legacy.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

    const log = new HistoryLog(memoryDir, historyFile)
    const active = log.loadActiveRows()
    const archived = archiveRows(memoryDir)

    expect(existsSync(join(memoryDir, 'history.legacy-backup.jsonl'))).toBe(true)
    expect(active.map((r) => r.content)).toEqual(['active', 'reply'])
    expect(archived.length).toBe(2)
    expect(active.length + archived.length).toBe(legacy.length)
    expect(log.stats().archive_files).toBe(1)
  })

  it('compact rewrites hot history and preserves archive', () => {
    const memoryDir = join(tmp('emperor-hist-compact-'), 'memory')
    const log = new HistoryLog(memoryDir, join(memoryDir, 'history.jsonl'))
    log.append({ role: 'user', content: 'old', turn_id: 'turn_old' })
    log.append({ role: 'assistant', content: 'old reply', turn_id: 'turn_old' })
    log.append({ role: 'user', content: 'new', turn_id: 'turn_new' })
    log.append({ role: 'assistant', content: 'new reply', turn_id: 'turn_new' })

    log.compact([
      { role: 'user', content: 'new', turn_id: 'turn_new' },
      { role: 'assistant', content: 'new reply', turn_id: 'turn_new' },
    ])

    const active = log.loadActiveRows()
    const archived = archiveRows(memoryDir)
    expect(active.map((r) => r.content)).toEqual(['new', 'new reply'])
    expect(archived.filter((r) => r.role).map((r) => r.content)).toEqual(['old', 'old reply'])
    expect(archived.some((r) => r.type === 'compact_event')).toBe(true)
    expect(log.stats().active_lines).toBe(2)
  })

  it('refuses to archive rows beyond the semantic compaction cursor', () => {
    const memoryDir = join(tmp('emperor-hist-gated-'), 'memory')
    const log = new HistoryLog(memoryDir, join(memoryDir, 'history.jsonl'))
    log.append({ role: 'user', content: 'old', turn_id: 'turn_old' })
    log.append({ role: 'assistant', content: 'old reply', turn_id: 'turn_old' })
    log.append({ role: 'user', content: 'new', turn_id: 'turn_new' })
    log.append({ role: 'assistant', content: 'new reply', turn_id: 'turn_new' })
    const before = readFileSync(join(memoryDir, 'history.jsonl'), 'utf8')

    expect(() => log.compact([
      { role: 'user', content: 'new', turn_id: 'turn_new' },
      { role: 'assistant', content: 'new reply', turn_id: 'turn_new' },
    ], {
      canArchiveUntil: () => false,
    })).toThrow(/semantic compaction cursor/)

    expect(readFileSync(join(memoryDir, 'history.jsonl'), 'utf8')).toBe(before)
    expect(archiveRows(memoryDir)).toEqual([])
  })

  it('records archived progress only up to rows permitted by compaction cursor', () => {
    const memoryDir = join(tmp('emperor-hist-gated-ok-'), 'memory')
    const log = new HistoryLog(memoryDir, join(memoryDir, 'history.jsonl'))
    log.append({ role: 'user', content: 'old', turn_id: 'turn_old' })
    log.append({ role: 'assistant', content: 'old reply', turn_id: 'turn_old' })
    log.append({ role: 'user', content: 'new', turn_id: 'turn_new' })
    log.append({ role: 'assistant', content: 'new reply', turn_id: 'turn_new' })
    const archivedUntil: number[] = []

    log.compact([
      { role: 'user', content: 'new', turn_id: 'turn_new' },
      { role: 'assistant', content: 'new reply', turn_id: 'turn_new' },
    ], {
      canArchiveUntil: (seq) => seq <= 2,
      markArchived: (seq) => { archivedUntil.push(seq) },
    })

    expect(archiveRows(memoryDir).filter((row) => row.role).map((row) => row.content)).toEqual(['old', 'old reply'])
    expect(archivedUntil).toEqual([2])
  })

  it('compact archive failure keeps hot history', () => {
    const memoryDir = join(tmp('emperor-hist-fail-'), 'memory')
    const log = new HistoryLog(memoryDir, join(memoryDir, 'history.jsonl'))
    log.append({ role: 'user', content: 'keep' })
    const before = readFileSync(join(memoryDir, 'history.jsonl'), 'utf8')

    vi.spyOn(log as unknown as { appendArchive: () => void }, 'appendArchive').mockImplementation(() => {
      throw new Error('archive failed')
    })
    expect(() => log.compact([])).toThrow(/archive failed/)
    expect(readFileSync(join(memoryDir, 'history.jsonl'), 'utf8')).toBe(before)
  })
})

// ── test_history_log.py (MemoryStore) ──

describe('MemoryStore history (test_history_log.py)', () => {
  it('load unarchived reads only hot log', () => {
    const root = tmp('emperor-mem-unarch-')
    const memory = new MemoryStore(join(root, 'memory'), join(root, 'USER.local.md'))
    memory.appendHistory('user', 'old', { extra: { turn_id: 'turn_old' } })
    memory.appendHistory('assistant', 'old reply', { extra: { turn_id: 'turn_old' } })
    memory.appendHistory('user', 'new', { extra: { turn_id: 'turn_new' } })
    memory.appendCompactMarker([{ role: 'user', content: 'new', turn_id: 'turn_new' }])

    expect(memory.loadUnarchivedHistory()).toEqual([{ role: 'user', content: 'new', seq: 3, turn_id: 'turn_new' }])
    expect(memory.historyStats().archive_files).toBe(1)
  })

  it('hides scheduler background turns', () => {
    const root = tmp('emperor-mem-hidden-')
    const memory = new MemoryStore(join(root, 'memory'), join(root, 'USER.local.md'))
    memory.appendHistory('user', 'visible', { extra: { turn_id: 'turn_visible' } })
    memory.appendHistory('user', 'hidden scheduler', { extra: { turn_id: 'turn_hidden', hidden: true, schedulerHidden: true } })
    memory.appendHistory('assistant', 'hidden reply', { extra: { turn_id: 'turn_hidden' } })

    expect(memory.loadUnarchivedHistory()).toEqual([{ role: 'user', content: 'visible', seq: 1, turn_id: 'turn_visible' }])
  })

  it('checkpoint round-trips and clears', () => {
    const root = tmp('emperor-mem-ckpt-')
    const memory = new MemoryStore(join(root, 'memory'), join(root, 'USER.local.md'))
    expect(memory.readCheckpoint()).toBeNull()
    memory.writeCheckpoint([{ role: 'user', content: 'wip', turn_id: 'turn_1' }], {
      sessionId: 'session_1',
      turnId: 'turn_1',
      phase: 'model_called',
      baseHistorySeq: 0,
      contextPlanId: 'context_1',
      promptSnapshotId: 'snapshot_1',
    })
    const payload = JSON.parse(readFileSync(memory.checkpointFile, 'utf8'))
    expect(payload).toMatchObject({
      schemaVersion: 'emperor.turn-checkpoint.v1',
      sessionId: 'session_1',
      turnId: 'turn_1',
      baseHistorySeq: 0,
      phase: 'model_called',
      contextPlanId: 'context_1',
      promptSnapshotId: 'snapshot_1',
      partialMessages: [{ role: 'user', content: 'wip', turn_id: 'turn_1' }],
    })
    expect(memory.readCheckpoint()).toEqual([{ role: 'user', content: 'wip', turn_id: 'turn_1' }])
    memory.clearCheckpoint()
    expect(memory.readCheckpoint()).toBeNull()
  })

  it('reads legacy checkpoints but ignores committed, aborted, stale, and corrupt checkpoints', () => {
    const root = tmp('emperor-mem-ckpt-rules-')
    const memory = new MemoryStore(join(root, 'memory'), join(root, 'USER.local.md'))

    writeFileSync(memory.checkpointFile, JSON.stringify({
      ts: '2026-07-06T00:00:00+08:00',
      history: [{ role: 'user', content: 'legacy draft' }],
    }), 'utf8')
    expect(memory.readCheckpoint()).toEqual([{ role: 'user', content: 'legacy draft' }])

    writeFileSync(memory.checkpointFile, JSON.stringify({
      schemaVersion: 'emperor.turn-checkpoint.v1',
      sessionId: 'session_1',
      turnId: 'turn_committed',
      baseHistorySeq: 0,
      phase: 'committed',
      partialMessages: [{ role: 'user', content: 'committed draft' }],
    }), 'utf8')
    expect(memory.readCheckpoint()).toBeNull()

    writeFileSync(memory.checkpointFile, JSON.stringify({
      schemaVersion: 'emperor.turn-checkpoint.v1',
      sessionId: 'session_1',
      turnId: 'turn_aborted',
      baseHistorySeq: 0,
      phase: 'aborted',
      partialMessages: [{ role: 'user', content: 'aborted draft' }],
    }), 'utf8')
    expect(memory.readCheckpoint()).toBeNull()

    writeFileSync(memory.checkpointFile, JSON.stringify({
      schemaVersion: 'emperor.turn-checkpoint.v1',
      sessionId: 'session_1',
      turnId: 'turn_stale',
      baseHistorySeq: 99,
      phase: 'tool_calls_pending',
      partialMessages: [{ role: 'user', content: 'stale draft' }],
    }), 'utf8')
    expect(memory.readCheckpoint()).toBeNull()

    writeFileSync(memory.checkpointFile, '{bad json', 'utf8')
    expect(memory.readCheckpoint()).toBeNull()
  })
})

// ── test_memory_versions.py ──

describe('MemoryVersionStore (test_memory_versions.py)', () => {
  it('rejects unknown serialized version targets instead of silently coercing to memory', () => {
    expect(() => memoryVersionFromDict({
      id: 'memv_bad',
      target: 'global',
      relPath: 'memory/MEMORY.local.md',
    })).toThrow(/unknown memory version target/)
  })

  it('snapshots and restores', () => {
    const root = tmp('emperor-memv-')
    const memoryDir = join(root, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    const memoryFile = join(memoryDir, 'MEMORY.local.md')
    const userFile = join(root, 'USER.local.md')
    writeFileSync(memoryFile, 'v1\n', 'utf8')
    const store = new MemoryVersionStore(root, memoryDir, userFile)

    const v1 = store.snapshotPath(memoryFile, { reason: 'first' })
    expect(v1).not.toBeNull()
    expect(v1!.target).toBe('memory')
    writeFileSync(memoryFile, 'v2\n', 'utf8')
    store.snapshotPath(memoryFile, { reason: 'second' })

    expect(store.list().length).toBe(2)
    const restored = store.restore(v1!.id)
    expect(restored.content).toBe('v1\n')
    expect(readFileSync(memoryFile, 'utf8')).toBe('v1\n')
  })

  it('skips duplicate latest snapshot', () => {
    const root = tmp('emperor-memv-dup-')
    const memoryDir = join(root, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    const memoryFile = join(memoryDir, 'MEMORY.local.md')
    writeFileSync(memoryFile, 'same\n', 'utf8')
    const store = new MemoryVersionStore(root, memoryDir, join(root, 'USER.local.md'))
    const v1 = store.snapshotPath(memoryFile)
    const v2 = store.snapshotPath(memoryFile)
    expect(v1!.id).toBe(v2!.id)
    expect(store.list().length).toBe(1)
  })

  it('MemoryStore writes create versions', () => {
    const root = tmp('emperor-memv-store-')
    const memory = new MemoryStore(join(root, 'memory'), join(root, 'USER.local.md'))
    memory.writeMemory('first memory')
    memory.writeMemory('second memory')
    const versions = memory.versions.list({ target: 'memory' })
    expect(versions.length).toBeGreaterThanOrEqual(1)
    expect(memory.readMemory()).toBe('second memory\n')
  })
})
