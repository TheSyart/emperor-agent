import { createHash } from 'node:crypto'
import { cleanString } from '../util/strings'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { basename, join } from 'node:path'
import { compactReplayEvents } from './replay'
import { relativePortable } from '../util/paths'
import {
  adaptRuntimeEventToEnvelope,
  createEventEnvelopeV2,
  isEventEnvelopeV2,
  projectEventEnvelopeV2,
  type EventEnvelopeV2,
  type EventVisibility,
} from './envelope'
import {
  AppendOnlyJournalSync,
  AtomicSnapshotSync,
  durableReplaceSync,
  type JournalCodec,
  type SnapshotCodec,
  type SyncPersistenceAdapter,
} from '../store/persistence'

type Row = Record<string, any>

export { compactReplayEvents } from './replay'

export interface RuntimeAppendOptions {
  turnId?: string | null
  sessionId?: string | null
  source?: string | null
  owner?: Row | null
  envelopeV2?: boolean | null
  eventId?: string | null
  idempotencyKey?: string | null
  requestId?: string | null
  attemptId?: string | null
  taskId?: string | null
  parentTaskId?: string | null
  toolCallId?: string | null
  ownerId?: string | null
  visibility?: EventVisibility | null
}

export interface RuntimeReplayOptions {
  limit?: number | null
  sessionId?: string | null
  includeArchive?: boolean | null
  compact?: boolean | null
  visibility?: EventVisibility | EventVisibility[] | null
}

export interface RuntimeStats {
  version: number
  path: string
  bytes: number
  events: number
  latestSeq: number
  latestTs: number | null
  activeTurnEvents: number
  activeTurns: number
  archiveFiles: number
  archiveBytes: number
  archives: RuntimeArchiveStats[]
  lastArchiveAt: number | null
  hotLimitEvents: number
  hotLimitBytes: number
  needsRotation: boolean
}

export interface RuntimeArchiveStats {
  path: string
  bytes: number
  updatedAt: number
}

const INDEX_WRITE_INTERVAL_MS = 500
const INDEX_FORCE_WRITE_EVENTS = new Set([
  'assistant_done',
  'turn_change_snapshot',
  'plan_execution_settled',
  'git_operation_completed',
  'turn_paused',
  'runtime_task_cancelled',
  'error',
  'plan_draft',
  'plan_approved',
  'interaction_cancelled',
  'session_created',
  'environment_install_completed',
  'environment_install_failed',
  'environment_changed',
  'profile_onboarding_status_changed',
  'goal_created',
  'goal_completed',
  'goal_blocked',
  'goal_paused',
  'goal_cancelled',
  'goal_policy_stopped',
])

export class RuntimeEventStore {
  readonly root: string
  readonly runtimeDir: string
  readonly eventsFile: string
  readonly archiveDir: string
  readonly indexFile: string
  private readonly sessionId: string | null
  private readonly writeEnvelopeV2: boolean
  private readonly persistenceAdapter?: SyncPersistenceAdapter
  private readonly eventJournal: AppendOnlyJournalSync<Row>
  private readonly indexSnapshot: AtomicSnapshotSync<Row>
  private readonly idempotencyIndex = new Map<string, Row>()
  private _latestSeq = 0
  private lastIndexWriteMs = 0

  constructor(
    root: string,
    opts: {
      sessionDirOverride?: boolean
      writeEnvelopeV2?: boolean | null
      persistenceAdapter?: SyncPersistenceAdapter
    } = {},
  ) {
    this.root = root
    this.sessionId = opts.sessionDirOverride ? basename(root) || null : null
    this.writeEnvelopeV2 =
      opts.writeEnvelopeV2 ?? process.env.EMPEROR_EVENT_ENVELOPE_V2 === '1'
    this.persistenceAdapter = opts.persistenceAdapter
    this.runtimeDir = opts.sessionDirOverride
      ? join(root, 'runtime')
      : join(root, 'memory', 'runtime')
    this.eventsFile = join(this.runtimeDir, 'events.jsonl')
    this.archiveDir = join(this.runtimeDir, 'archive')
    this.indexFile = join(this.runtimeDir, 'index.json')
    this.eventJournal = new AppendOnlyJournalSync({
      path: this.eventsFile,
      codec: RUNTIME_EVENT_JOURNAL_CODEC,
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
      recoveryMode: 'tolerant',
    })
    this.indexSnapshot = new AtomicSnapshotSync({
      path: this.indexFile,
      codec: RUNTIME_INDEX_CODEC,
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
    })
    this.ensure()
    this._latestSeq = this.scanLatestSeq()
    this.rebuildIdempotencyIndex()
  }

  get latestSeq(): number {
    return this._latestSeq
  }

  append(event: Row, opts: RuntimeAppendOptions = {}): Row {
    const idempotencyKey = cleanString(
      opts.idempotencyKey ?? event.idempotency_key ?? event.idempotencyKey,
    )
    if (idempotencyKey) {
      const existing = this.idempotencyIndex.get(idempotencyKey)
      if (existing) return this.normalizeEvent(existing)!
    }
    this._latestSeq += 1
    const payload = jsonSafe({ ...event }) as Row
    payload.seq = this._latestSeq
    if (payload.ts === undefined) payload.ts = Date.now() / 1000
    if (opts.turnId && !payload.turn_id) payload.turn_id = opts.turnId
    const sessionId = cleanString(
      payload.session_id ?? opts.sessionId ?? this.sessionId,
    )
    const turnId = cleanString(payload.turn_id ?? opts.turnId)
    if (sessionId && !payload.session_id) payload.session_id = sessionId
    if (payload.source === undefined) payload.source = opts.source ?? 'core'
    const receipt = ownerReceipt(payload.owner ?? opts.owner ?? null, {
      sessionId,
      turnId,
    })
    if (receipt) payload.owner = receipt
    if (idempotencyKey) payload.idempotency_key = idempotencyKey
    if (opts.eventId) payload.event_id = cleanString(opts.eventId)
    if (opts.requestId) payload.request_id = cleanString(opts.requestId)
    if (opts.attemptId) payload.attempt_id = cleanString(opts.attemptId)
    if (opts.taskId) payload.task_id = cleanString(opts.taskId)
    if (opts.parentTaskId)
      payload.parent_task_id = cleanString(opts.parentTaskId)
    if (opts.toolCallId) payload.tool_call_id = cleanString(opts.toolCallId)
    if (opts.ownerId) payload.owner_id = cleanString(opts.ownerId)
    if (opts.visibility) payload.visibility = opts.visibility

    const stored: Row =
      opts.envelopeV2 || (opts.envelopeV2 !== false && this.writeEnvelopeV2)
        ? (createEventEnvelopeV2(payload, {
            eventId: opts.eventId,
            idempotencyKey,
            sessionId,
            turnId,
            requestId: opts.requestId,
            attemptId: opts.attemptId,
            taskId: opts.taskId,
            parentTaskId: opts.parentTaskId,
            toolCallId: opts.toolCallId,
            ownerId: opts.ownerId,
            sequence: this._latestSeq,
            timestamp: payload.ts,
            visibility: opts.visibility,
          }) as unknown as Row)
        : payload
    const projected = this.normalizeEvent(stored)!
    this.eventJournal.appendAtSequence(stored, this._latestSeq)
    if (idempotencyKey) this.idempotencyIndex.set(idempotencyKey, stored)
    // B6：index 重建是 O(全部事件) 的全量扫描，高频 delta 期间按时间窗节流；
    // 终态事件强制落盘，保证崩溃后 index 至多落后一个窗口。
    const now = Date.now()
    if (
      INDEX_FORCE_WRITE_EVENTS.has(String(projected.event)) ||
      now - this.lastIndexWriteMs >= INDEX_WRITE_INTERVAL_MS
    ) {
      this.lastIndexWriteMs = now
      this.writeIndex(this.statsFromIndex(this.loadIndex()))
    }
    return projected
  }

  replayAfter(seq: number, opts: RuntimeReplayOptions = {}): Row[] {
    const sessionId = cleanString(opts.sessionId)
    let out = this.iterEvents({ includeArchive: opts.includeArchive }).filter(
      (event) => {
        if (Number(event.seq || 0) <= seq) return false
        if (!sessionId) return true
        return (
          cleanString(
            event.session_id ?? event.owner?.session_id ?? this.sessionId,
          ) === sessionId
        )
      },
    )
    if (opts.compact) out = compactReplayEvents(out)
    return opts.limit && out.length > opts.limit ? out.slice(-opts.limit) : out
  }

  replayEnvelopesAfter(
    seq: number,
    opts: RuntimeReplayOptions = {},
  ): EventEnvelopeV2[] {
    const sessionId = cleanString(opts.sessionId)
    const visibility = new Set(
      Array.isArray(opts.visibility)
        ? opts.visibility
        : opts.visibility
          ? [opts.visibility]
          : [],
    )
    let out = this.iterStoredEvents({
      includeArchive: opts.includeArchive,
    })
      .map((event) =>
        adaptRuntimeEventToEnvelope(event, {
          sessionId: this.sessionId,
        }),
      )
      .filter((event) => {
        if (event.sequence <= seq) return false
        if (sessionId && event.sessionId !== sessionId) return false
        return !visibility.size || visibility.has(event.visibility)
      })
    if (opts.limit && out.length > opts.limit) out = out.slice(-opts.limit)
    return out
  }

  recent(limit: number): Row[] {
    if (limit <= 0) return []
    return this.iterEvents().slice(-limit)
  }

  eventsForTurns(turnIds: string[], opts: RuntimeReplayOptions = {}): Row[] {
    const wanted = new Set(turnIds.filter(Boolean).map(String))
    if (!wanted.size) return []
    const out = this.iterEvents({ includeArchive: opts.includeArchive }).filter(
      (event) => wanted.has(String(event.turn_id || '')),
    )
    return opts.limit && out.length > opts.limit ? out.slice(-opts.limit) : out
  }

  stats(opts: { activeTurnIds?: string[] | null } = {}): RuntimeStats {
    return this.statsFromIndex(this.loadIndex(), {
      activeTurnIds: opts.activeTurnIds ?? [],
    })
  }

  compact(activeTurnIds: string[]): RuntimeStats {
    const active = new Set(activeTurnIds.filter(Boolean).map(String))
    const keep: Row[] = []
    const archive: Row[] = []
    for (const event of this.iterStoredEvents()) {
      const turnId = storedTurnId(event)
      if (turnId && active.has(turnId)) keep.push(event)
      else archive.push(event)
    }
    if (archive.length) {
      this.appendArchive(archive)
      this.rewriteHot(keep)
    }
    const index = this.loadIndex()
    if (archive.length) index.lastArchiveAt = Date.now() / 1000
    this.writeIndex(this.statsFromIndex(index, { activeTurnIds: [...active] }))
    return this.stats({ activeTurnIds: [...active] })
  }

  private ensure(): void {
    mkdirSync(this.runtimeDir, { recursive: true })
    mkdirSync(this.archiveDir, { recursive: true })
    if (!existsSync(this.eventsFile))
      durableReplaceSync(this.eventsFile, '', {
        adapter: this.persistenceAdapter,
        fileMode: 0o600,
      })
    if (!existsSync(this.indexFile))
      this.writeIndex(this.statsFromIndex({ version: 1 }))
  }

  private scanLatestSeq(): number {
    const index = this.loadIndex()
    let latest = Number(index.latestSeq ?? index.latest_seq ?? 0) || 0
    for (const event of this.iterStoredEvents({ includeArchive: true }))
      latest = Math.max(latest, storedSequence(event))
    return latest
  }

  private rebuildIdempotencyIndex(): void {
    this.idempotencyIndex.clear()
    for (const event of this.iterStoredEvents({ includeArchive: true })) {
      const key = storedIdempotencyKey(event)
      if (key) this.idempotencyIndex.set(key, event)
    }
  }

  private iterEvents(opts: { includeArchive?: boolean | null } = {}): Row[] {
    return this.iterStoredEvents(opts)
      .map((event) => this.normalizeEvent(event))
      .filter((event): event is Row => event !== null)
  }

  private iterStoredEvents(
    opts: { includeArchive?: boolean | null } = {},
  ): Row[] {
    const rows = opts.includeArchive
      ? [...this.iterStoredArchiveEvents(), ...this.iterStoredHotEvents()]
      : this.iterStoredHotEvents()
    rows.sort((a, b) => storedSequence(a) - storedSequence(b))
    return rows
  }

  private iterStoredHotEvents(): Row[] {
    return this.eventJournal
      .replay({ repairTail: true })
      .entries.map((entry) => entry.payload)
  }

  private iterStoredArchiveEvents(): Row[] {
    if (!existsSync(this.archiveDir)) return []
    const rows: Row[] = []
    const names = readdirSync(this.archiveDir)
      .filter((name) => name.endsWith('.jsonl.gz'))
      .sort()
    for (const name of names) {
      const path = join(this.archiveDir, name)
      try {
        rows.push(
          ...this.parseStoredJsonl(
            gunzipSync(readFileSync(path)).toString('utf8'),
          ),
        )
      } catch {
        continue
      }
    }
    return rows
  }

  private parseStoredJsonl(content: string): Row[] {
    const rows: Row[] = []
    for (let line of content.split('\n')) {
      line = line.trim()
      if (!line) continue
      try {
        const raw = JSON.parse(line)
        if (isEventEnvelopeV2(raw)) rows.push(raw as unknown as Row)
        else if (
          raw &&
          typeof raw === 'object' &&
          !Array.isArray(raw) &&
          typeof (raw as Row).event === 'string'
        )
          rows.push(jsonSafe({ ...(raw as Row) }) as Row)
      } catch {
        continue
      }
    }
    return rows
  }

  private normalizeEvent(raw: unknown): Row | null {
    if (isEventEnvelopeV2(raw)) return projectEventEnvelopeV2(raw)
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      typeof (raw as Row).event !== 'string'
    )
      return null
    const payload = jsonSafe({ ...(raw as Row) }) as Row
    const sessionId = cleanString(
      payload.session_id ?? payload.owner?.session_id ?? this.sessionId,
    )
    const turnId = cleanString(payload.turn_id ?? payload.owner?.turn_id)
    if (sessionId && !payload.session_id) payload.session_id = sessionId
    if (payload.source === undefined) payload.source = 'core'
    const receipt = ownerReceipt(payload.owner ?? null, { sessionId, turnId })
    if (receipt) payload.owner = receipt
    return payload
  }

  private statsFromIndex(
    index: Row,
    opts: { activeTurnIds?: string[] | null } = {},
  ): RuntimeStats {
    const events = this.iterEvents()
    const active = new Set(
      (opts.activeTurnIds ?? []).filter(Boolean).map(String),
    )
    const activeEvents = events.filter(
      (event) => active.size && active.has(String(event.turn_id || '')),
    )
    const latestTs = Math.max(0, ...events.map(eventTsSeconds))
    const archiveFiles = existsSync(this.archiveDir)
      ? readdirSync(this.archiveDir)
          .filter((name) => name.endsWith('.jsonl.gz'))
          .sort()
      : []
    const archives = archiveFiles.map((name) => {
      const path = join(this.archiveDir, name)
      const st = statSync(path)
      return {
        path: relativePortable(this.root, path),
        bytes: st.size,
        updatedAt: st.mtimeMs / 1000,
      }
    })
    const bytes = existsSync(this.eventsFile)
      ? statSync(this.eventsFile).size
      : 0
    const archiveBytes = archives.reduce(
      (sum, item) => sum + Number(item.bytes || 0),
      0,
    )
    const latestSeq = Math.max(
      this._latestSeq,
      Number(index.latestSeq ?? index.latest_seq ?? 0) || 0,
      Math.max(0, ...events.map((event) => Number(event.seq || 0) || 0)),
    )
    return {
      version: 1,
      path: relativePortable(this.root, this.eventsFile),
      bytes,
      events: events.length,
      latestSeq,
      latestTs: latestTs || null,
      activeTurnEvents: activeEvents.length,
      activeTurns: active.size,
      archiveFiles: archives.length,
      archiveBytes,
      archives,
      lastArchiveAt: (index.lastArchiveAt ?? index.last_archive_at ?? null) as
        number | null,
      hotLimitEvents: 5000,
      hotLimitBytes: 5 * 1024 * 1024,
      needsRotation: bytes > 5 * 1024 * 1024 || events.length > 5000,
    }
  }

  private loadIndex(): Row {
    return this.indexSnapshot.read({
      fallback: { version: 1, latestSeq: this._latestSeq },
    }).value
  }

  private writeIndex(index: Row): void {
    const payload = { ...(jsonSafe(index) as Row), version: 1 }
    this.indexSnapshot.write(payload)
  }

  private appendArchive(events: Row[]): void {
    const grouped = new Map<string, Row[]>()
    for (const event of events) {
      const month = archiveMonth(event)
      if (!grouped.has(month)) grouped.set(month, [])
      grouped.get(month)!.push(event)
    }
    for (const [month, rows] of grouped) {
      const path = join(this.archiveDir, `${month}.jsonl.gz`)
      const body = rows
        .map((event) => JSON.stringify(jsonSafe(event)) + '\n')
        .join('')
      const chunk = gzipSync(Buffer.from(body, 'utf8'))
      if (existsSync(path)) appendFileSync(path, chunk)
      else writeFileSync(path, chunk)
    }
  }

  private rewriteHot(events: Row[]): void {
    durableReplaceSync(
      this.eventsFile,
      events.map((event) => JSON.stringify(jsonSafe(event)) + '\n').join(''),
      { adapter: this.persistenceAdapter, fileMode: 0o600 },
    )
  }
}

const RUNTIME_EVENT_JOURNAL_CODEC: JournalCodec<Row> = {
  schemaVersion: 2,
  create(_seq, payload) {
    const seq = storedSequence(payload)
    if (!Number.isSafeInteger(seq) || seq < 1)
      throw new Error('runtime event sequence is invalid')
    return {
      schemaVersion: isEventEnvelopeV2(payload) ? 2 : 1,
      seq,
      checksum: runtimeRowChecksum(payload),
      payload,
    }
  },
  encode(entry) {
    return entry.payload
  },
  decode(input) {
    if (
      !isEventEnvelopeV2(input) &&
      (!input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        typeof (input as Row).event !== 'string')
    )
      throw new Error('runtime journal row is invalid')
    const payload = jsonSafe({ ...(input as Row) }) as Row
    const seq = storedSequence(payload)
    if (!Number.isSafeInteger(seq) || seq < 1)
      throw new Error('runtime event sequence is invalid')
    return {
      schemaVersion: isEventEnvelopeV2(payload) ? 2 : 1,
      seq,
      checksum: runtimeRowChecksum(payload),
      payload,
    }
  },
}

const RUNTIME_INDEX_CODEC: SnapshotCodec<Row> = {
  schemaVersion: 1,
  encode(value) {
    return value
  },
  decode(input) {
    return {
      value:
        input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Row)
          : { version: 1 },
      schemaVersion: 1,
    }
  },
}

function runtimeRowChecksum(row: Row): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex')
}

function eventTsSeconds(event: Row): number {
  const ts = event.ts
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts)
    return Number.isFinite(parsed) ? parsed / 1000 : 0
  }
  return 0
}

function storedSequence(event: Row): number {
  return isEventEnvelopeV2(event) ? event.sequence : Number(event.seq || 0) || 0
}

function storedTurnId(event: Row): string {
  return isEventEnvelopeV2(event)
    ? cleanString(event.turnId)
    : cleanString(event.turn_id ?? event.owner?.turn_id)
}

function storedIdempotencyKey(event: Row): string {
  return isEventEnvelopeV2(event)
    ? cleanString(event.idempotencyKey)
    : cleanString(event.idempotency_key ?? event.idempotencyKey)
}

function ownerReceipt(
  owner: unknown,
  scope: { sessionId?: string | null; turnId?: string | null },
): Row | undefined {
  const sessionId = cleanString(scope.sessionId)
  const turnId = cleanString(scope.turnId)
  if (!sessionId && !turnId && !isRecord(owner)) return undefined
  const out = isRecord(owner) ? { ...owner } : {}
  if (sessionId && !out.session_id) out.session_id = sessionId
  if (turnId && !out.turn_id) out.turn_id = turnId
  return out
}

function isRecord(value: unknown): value is Row {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function archiveMonth(event: Row): string {
  if (isEventEnvelopeV2(event)) return event.timestamp.slice(0, 7)
  const ts = event.ts
  if (typeof ts === 'number')
    return new Date(ts * 1000).toISOString().slice(0, 7)
  if (typeof ts === 'string' && ts.length >= 7 && ts[4] === '-')
    return ts.slice(0, 7)
  return new Date().toISOString().slice(0, 7)
}

function jsonSafe(value: unknown): unknown {
  try {
    JSON.stringify(value)
    return value
  } catch {
    if (Array.isArray(value)) return value.map(jsonSafe)
    if (value && typeof value === 'object') {
      const out: Row = {}
      for (const [key, item] of Object.entries(value as Row)) {
        if (!String(key).startsWith('_')) out[String(key)] = jsonSafe(item)
      }
      return out
    }
    return String(value)
  }
}
