import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { MemoryVersionStore } from './versions'
import type { CompactionRunRecord, SessionMemoryCursor } from './compaction-models'
import type { HistoryArchiveGate } from './history'

export interface MarkCompactingOptions {
  lastHistorySeq?: number
  compactionId?: string
}

export interface AdvanceCursorOptions {
  compactedUntilSeq: number
  compactionId: string
  lastHistorySeq?: number
}

export interface MarkArchivedOptions {
  archivedUntilSeq: number
}

export class CompactionCursorStore {
  readonly root: string
  readonly cursorDir: string

  constructor(root: string) {
    this.root = resolve(root)
    this.cursorDir = join(this.root, 'memory', 'compaction', 'cursors')
  }

  readOrInit(sessionId: string): SessionMemoryCursor {
    const existing = this.read(sessionId)
    if (existing) return existing
    return {
      sessionId,
      lastHistorySeq: 0,
      compactedUntilSeq: 0,
      archivedUntilSeq: 0,
      status: 'active',
    }
  }

  markCompacting(sessionId: string, opts: MarkCompactingOptions = {}): SessionMemoryCursor {
    const current = this.readOrInit(sessionId)
    if (current.status === 'closed') throw new Error(`cannot compact closed session: ${sessionId}`)
    const next: SessionMemoryCursor = {
      ...current,
      lastHistorySeq: Math.max(current.lastHistorySeq, Number(opts.lastHistorySeq ?? current.lastHistorySeq) || 0),
      status: 'compacting',
    }
    if (opts.compactionId) next.lastCompactionId = opts.compactionId
    this.write(next)
    return next
  }

  markActive(sessionId: string): SessionMemoryCursor {
    const current = this.readOrInit(sessionId)
    if (current.status === 'closed') return current
    const next: SessionMemoryCursor = { ...current, status: 'active' }
    this.write(next)
    return next
  }

  advance(sessionId: string, opts: AdvanceCursorOptions): SessionMemoryCursor {
    const current = this.readOrInit(sessionId)
    if (current.status !== 'compacting') {
      throw new Error(`cannot advance compaction cursor while not compacting: ${sessionId}`)
    }
    const compactedUntilSeq = Number(opts.compactedUntilSeq)
    if (!Number.isFinite(compactedUntilSeq) || compactedUntilSeq < 0) {
      throw new Error('compactedUntilSeq must be a non-negative finite number')
    }
    if (compactedUntilSeq < current.compactedUntilSeq) {
      throw new Error(`cannot move compactedUntilSeq backwards: ${compactedUntilSeq} < ${current.compactedUntilSeq}`)
    }
    const next: SessionMemoryCursor = {
      ...current,
      lastHistorySeq: Math.max(current.lastHistorySeq, Number(opts.lastHistorySeq ?? compactedUntilSeq) || 0),
      compactedUntilSeq,
      lastCompactionAt: new Date().toISOString(),
      lastCompactionId: opts.compactionId,
      status: 'active',
    }
    this.write(next)
    return next
  }

  markArchived(sessionId: string, opts: MarkArchivedOptions): SessionMemoryCursor {
    const current = this.readOrInit(sessionId)
    const archivedUntilSeq = Number(opts.archivedUntilSeq)
    if (!Number.isFinite(archivedUntilSeq) || archivedUntilSeq < 0) {
      throw new Error('archivedUntilSeq must be a non-negative finite number')
    }
    if (archivedUntilSeq > current.compactedUntilSeq) {
      throw new Error(`cannot archive beyond compactedUntilSeq: ${archivedUntilSeq} > ${current.compactedUntilSeq}`)
    }
    if (archivedUntilSeq < current.archivedUntilSeq) {
      throw new Error(`cannot move archivedUntilSeq backwards: ${archivedUntilSeq} < ${current.archivedUntilSeq}`)
    }
    const next: SessionMemoryCursor = {
      ...current,
      archivedUntilSeq,
      status: archivedUntilSeq >= current.compactedUntilSeq && current.compactedUntilSeq > 0 ? 'archived' : current.status,
    }
    this.write(next)
    return next
  }

  canArchiveUntil(sessionId: string, seq: number): boolean {
    const cursor = this.readOrInit(sessionId)
    return seq >= cursor.archivedUntilSeq && seq <= cursor.compactedUntilSeq
  }

  archiveGate(sessionId: string): HistoryArchiveGate {
    return {
      canArchiveUntil: (seq) => this.canArchiveUntil(sessionId, seq),
      markArchived: (seq) => {
        this.markArchived(sessionId, { archivedUntilSeq: seq })
      },
    }
  }

  close(sessionId: string): SessionMemoryCursor {
    const current = this.readOrInit(sessionId)
    const next: SessionMemoryCursor = { ...current, status: 'closed' }
    this.write(next)
    return next
  }

  restore(cursor: SessionMemoryCursor): SessionMemoryCursor {
    const next: SessionMemoryCursor = { ...cursor }
    this.write(next)
    return next
  }

  cursorPath(sessionId: string): string {
    return join(this.cursorDir, `${safeSessionId(sessionId)}.json`)
  }

  private read(sessionId: string): SessionMemoryCursor | null {
    const path = this.cursorPath(sessionId)
    if (!existsSync(path)) return null
    try {
      return normalizeCursor(JSON.parse(readFileSync(path, 'utf8') || '{}'), sessionId)
    } catch {
      return null
    }
  }

  private write(cursor: SessionMemoryCursor): void {
    mkdirSync(this.cursorDir, { recursive: true })
    MemoryVersionStore.atomicWriteText(this.cursorPath(cursor.sessionId), JSON.stringify(cursor, null, 2) + '\n')
  }
}

export class CompactionLedger {
  readonly root: string
  readonly ledgerDir: string
  readonly runsPath: string
  readonly indexPath: string

  constructor(root: string) {
    this.root = resolve(root)
    this.ledgerDir = join(this.root, 'memory', 'compaction')
    this.runsPath = join(this.ledgerDir, 'runs.jsonl')
    this.indexPath = join(this.ledgerDir, 'index.json')
  }

  recordStarted(record: CompactionRunRecord): CompactionRunRecord {
    return this.record({ ...record, status: 'started' })
  }

  recordApplied(record: CompactionRunRecord): CompactionRunRecord {
    return this.record({ ...record, status: 'applied' })
  }

  recordFailed(record: CompactionRunRecord, error: NonNullable<CompactionRunRecord['error']>): CompactionRunRecord {
    return this.record({ ...record, status: 'failed', error })
  }

  readIndex(): Record<string, CompactionRunRecord> {
    if (!existsSync(this.indexPath)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8') || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed as Record<string, CompactionRunRecord>
    } catch {
      return {}
    }
  }

  private record(record: CompactionRunRecord): CompactionRunRecord {
    mkdirSync(this.ledgerDir, { recursive: true })
    appendFileSync(this.runsPath, JSON.stringify(record) + '\n', 'utf8')
    const index = this.readIndex()
    index[record.compactionId] = record
    mkdirSync(dirname(this.indexPath), { recursive: true })
    MemoryVersionStore.atomicWriteText(this.indexPath, JSON.stringify(index, null, 2) + '\n')
    return record
  }
}

export function latestAppliedCompactionRun(
  index: Record<string, CompactionRunRecord>,
  sessionId: string,
  preferredId?: string | null,
  maxToSeq?: number | null,
): CompactionRunRecord | null {
  const maxSeq = nonNegativeNumber(maxToSeq)
  const preferred = preferredId ? index[preferredId] : null
  if (isAppliedRunForSession(preferred, sessionId, maxSeq)) return preferred
  const records = Object.values(index)
    .filter((record): record is CompactionRunRecord => isAppliedRunForSession(record, sessionId, maxSeq))
  records.sort((a, b) => (
    (nonNegativeNumber(b.range?.toSeq) - nonNegativeNumber(a.range?.toSeq))
    || String(b.compactionId ?? '').localeCompare(String(a.compactionId ?? ''))
  ))
  return records[0] ?? null
}

function normalizeCursor(raw: unknown, sessionId: string): SessionMemoryCursor | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const status = normalizeStatus(item.status)
  return {
    sessionId: String(item.sessionId || sessionId),
    lastHistorySeq: nonNegativeNumber(item.lastHistorySeq),
    compactedUntilSeq: nonNegativeNumber(item.compactedUntilSeq),
    archivedUntilSeq: nonNegativeNumber(item.archivedUntilSeq),
    ...(typeof item.lastCompactionAt === 'string' ? { lastCompactionAt: item.lastCompactionAt } : {}),
    ...(typeof item.lastCompactionId === 'string' ? { lastCompactionId: item.lastCompactionId } : {}),
    status,
  }
}

function normalizeStatus(value: unknown): SessionMemoryCursor['status'] {
  if (value === 'active' || value === 'compacting' || value === 'archived' || value === 'closed') return value
  return 'active'
}

function nonNegativeNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

function isAppliedRunForSession(record: unknown, sessionId: string, maxToSeq: number): record is CompactionRunRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false
  const item = record as CompactionRunRecord
  if (item.status !== 'applied') return false
  if (String(item.sessionId ?? '') !== sessionId) return false
  const toSeq = nonNegativeNumber(item.range?.toSeq)
  if (toSeq <= 0) return false
  return maxToSeq <= 0 || toSeq <= maxToSeq
}

function safeSessionId(sessionId: string): string {
  return String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'default'
}
