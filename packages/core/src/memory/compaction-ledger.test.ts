import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompactionCursorStore, CompactionLedger } from './compaction-ledger'
import type {
  ActiveMemoryBinding,
  CompactionRunRecord,
} from './compaction-models'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const binding: ActiveMemoryBinding = {
  profile: {
    scope: { kind: 'user_profile' },
    readable: true,
    writable: true,
    path: '/state/memory/profile/USER.local.md',
  },
  longTerm: {
    scope: { kind: 'global' },
    readable: true,
    writable: true,
    path: '/state/memory/MEMORY.local.md',
  },
  episode: {
    scope: { kind: 'episode', date: '2026-07-06' },
    readable: false,
    writable: true,
    path: '/state/memory/2026-07-06.md',
  },
}

function runRecord(
  overrides: Partial<CompactionRunRecord> = {},
): CompactionRunRecord {
  return {
    compactionId: 'compact_1',
    sessionId: 'session_1',
    mode: 'chat',
    trigger: { kind: 'manual' },
    range: { fromSeq: 1, toSeq: 12 },
    status: 'started',
    activeMemoryBinding: binding,
    input: {
      historyHash: 'history-hash',
      historyCount: 12,
      userProfileHash: 'profile-hash',
      episodeHash: 'episode-hash',
    },
    ...overrides,
  }
}

describe('CompactionCursorStore', () => {
  it('initializes a new session cursor in active state', () => {
    const store = new CompactionCursorStore(tmp('emperor-compaction-cursor-'))

    const cursor = store.readOrInit('session_1')

    expect(cursor).toMatchObject({
      sessionId: 'session_1',
      lastHistorySeq: 0,
      compactedUntilSeq: 0,
      archivedUntilSeq: 0,
      status: 'active',
    })
  })

  it('advances only while compacting and never moves compactedUntilSeq backwards', () => {
    const store = new CompactionCursorStore(tmp('emperor-compaction-cursor-'))

    expect(() =>
      store.advance('session_1', {
        compactedUntilSeq: 10,
        compactionId: 'compact_1',
      }),
    ).toThrow(/not compacting/)

    store.markCompacting('session_1', {
      lastHistorySeq: 15,
      compactionId: 'compact_1',
    })
    const advanced = store.advance('session_1', {
      compactedUntilSeq: 10,
      compactionId: 'compact_1',
    })

    expect(advanced).toMatchObject({
      lastHistorySeq: 15,
      compactedUntilSeq: 10,
      archivedUntilSeq: 0,
      lastCompactionId: 'compact_1',
      status: 'active',
    })

    store.markCompacting('session_1', {
      lastHistorySeq: 15,
      compactionId: 'compact_2',
    })
    expect(() =>
      store.advance('session_1', {
        compactedUntilSeq: 9,
        compactionId: 'compact_2',
      }),
    ).toThrow(/backwards/)
  })

  it('rejects archive progress beyond compactedUntilSeq', () => {
    const store = new CompactionCursorStore(tmp('emperor-compaction-cursor-'))
    store.markCompacting('session_1', {
      lastHistorySeq: 20,
      compactionId: 'compact_1',
    })
    store.advance('session_1', {
      compactedUntilSeq: 12,
      compactionId: 'compact_1',
    })

    expect(() =>
      store.markArchived('session_1', { archivedUntilSeq: 13 }),
    ).toThrow(/beyond compactedUntilSeq/)

    const cursor = store.markArchived('session_1', { archivedUntilSeq: 12 })
    expect(cursor.archivedUntilSeq).toBe(12)
  })

  it('exposes a HistoryLog archive gate backed by the session cursor', () => {
    const store = new CompactionCursorStore(
      tmp('emperor-compaction-cursor-gate-'),
    )
    const gate = store.archiveGate('session_1')

    expect(gate.canArchiveUntil(1)).toBe(false)

    store.markCompacting('session_1', {
      lastHistorySeq: 5,
      compactionId: 'compact_1',
    })
    store.advance('session_1', {
      compactedUntilSeq: 3,
      compactionId: 'compact_1',
    })

    expect(gate.canArchiveUntil(3)).toBe(true)
    expect(gate.canArchiveUntil(4)).toBe(false)
    gate.markArchived?.(3)
    expect(store.readOrInit('session_1').archivedUntilSeq).toBe(3)
  })
})

describe('CompactionLedger', () => {
  it('records started, applied, and failed runs in jsonl plus index', () => {
    const root = tmp('emperor-compaction-ledger-')
    const ledger = new CompactionLedger(root)

    const started = ledger.recordStarted(runRecord())
    const applied = ledger.recordApplied({
      ...started,
      output: {
        decisions: [],
        discarded: [],
        targetVersions: [
          {
            scope: { kind: 'global' },
            beforeVersion: 1,
            beforeHash: 'before',
            afterVersion: 2,
            afterHash: 'after',
            operationCount: 1,
          },
        ],
      },
    })
    const failed = ledger.recordFailed(
      runRecord({ compactionId: 'compact_2' }),
      {
        code: 'validation_failed',
        message: 'patch rejected',
        validationErrors: ['base_hash_mismatch'],
      },
    )

    expect(started.status).toBe('started')
    expect(applied.status).toBe('applied')
    expect(failed.status).toBe('failed')

    const rows = readFileSync(
      join(root, 'memory', 'compaction', 'runs.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as CompactionRunRecord)
    expect(rows.map((row) => row.status)).toEqual([
      'started',
      'applied',
      'failed',
    ])

    const indexPath = join(root, 'memory', 'compaction', 'index.json')
    expect(existsSync(indexPath)).toBe(true)
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<
      string,
      CompactionRunRecord
    >
    expect(index.compact_1?.status).toBe('applied')
    expect(index.compact_2?.error?.validationErrors).toEqual([
      'base_hash_mismatch',
    ])
  })
})
