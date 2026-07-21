import { randomUUID } from 'node:crypto'
import { cleanString } from '../util/strings'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { basename, dirname, join } from 'node:path'
import { relativePortable } from '../util/paths'
import {
  adaptRuntimeEventToEnvelope,
  createEventEnvelopeV2,
  isEventEnvelopeV2,
  projectEventEnvelopeV2,
  type EventEnvelopeV2,
  type EventVisibility,
} from './envelope'

type Row = Record<string, any>

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

/**
 * replay 读取侧压缩（P1-5）：磁盘 events.jsonl 不变，只收敛回放流里的高频中间态。
 * - 连续的同流 plan_draft_delta 只保留最后一条（终态草稿覆盖前序增量）。
 * - 连续的同 turn message_delta 合并为一条（保留首个 seq，文本拼接）。
 * - 连续的同 Goal goal_runtime_update 只保留最后一条。
 * 任何其他事件都会打断 run，保证投影出的消息结构与不压缩时一致。
 */
export function compactReplayEvents(rows: Row[]): Row[] {
  const out: Row[] = []
  for (const row of rows) {
    const prev = out[out.length - 1]
    if (
      row.event === 'goal_runtime_update' &&
      prev?.event === 'goal_runtime_update' &&
      cleanString(prev.goal_id) === cleanString(row.goal_id)
    ) {
      out[out.length - 1] = row
      continue
    }
    if (
      row.event === 'plan_draft_delta' &&
      prev?.event === 'plan_draft_delta' &&
      planDeltaStreamKey(prev) === planDeltaStreamKey(row) &&
      String(prev.turn_id ?? '') === String(row.turn_id ?? '')
    ) {
      out[out.length - 1] = row
      continue
    }
    if (
      row.event === 'message_delta' &&
      prev?.event === 'message_delta' &&
      String(prev.turn_id ?? '') === String(row.turn_id ?? '')
    ) {
      out[out.length - 1] = {
        ...prev,
        delta: String(prev.delta ?? '') + String(row.delta ?? ''),
      }
      continue
    }
    out.push(row)
  }
  return out
}

function planDeltaStreamKey(row: Row): string {
  const interaction = isRecord(row.interaction) ? row.interaction : {}
  const meta = isRecord(interaction.meta) ? interaction.meta : {}
  return (
    cleanString(meta.plan_stream_id) ||
    cleanString(interaction.parent_call_id) ||
    cleanString(row.tool_call_id) ||
    cleanString(interaction.id)
  )
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
  'turn_paused',
  'turn_continuation_evaluated',
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
  private readonly idempotencyIndex = new Map<string, Row>()
  private _latestSeq = 0
  private lastIndexWriteMs = 0

  constructor(
    root: string,
    opts: {
      sessionDirOverride?: boolean
      writeEnvelopeV2?: boolean | null
    } = {},
  ) {
    this.root = root
    this.sessionId = opts.sessionDirOverride ? basename(root) || null : null
    this.writeEnvelopeV2 =
      opts.writeEnvelopeV2 ?? process.env.EMPEROR_EVENT_ENVELOPE_V2 === '1'
    this.runtimeDir = opts.sessionDirOverride
      ? join(root, 'runtime')
      : join(root, 'memory', 'runtime')
    this.eventsFile = join(this.runtimeDir, 'events.jsonl')
    this.archiveDir = join(this.runtimeDir, 'archive')
    this.indexFile = join(this.runtimeDir, 'index.json')
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
    appendFileSync(this.eventsFile, JSON.stringify(stored) + '\n', 'utf8')
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
    if (!existsSync(this.eventsFile)) writeFileSync(this.eventsFile, '', 'utf8')
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
    if (!existsSync(this.eventsFile)) return []
    return this.parseStoredJsonl(readFileSync(this.eventsFile, 'utf8'))
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
    try {
      const raw = JSON.parse(readFileSync(this.indexFile, 'utf8') || '{}')
      return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
        : { version: 1, latestSeq: this._latestSeq }
    } catch {
      return { version: 1, latestSeq: this._latestSeq }
    }
  }

  private writeIndex(index: Row): void {
    const payload = { ...(jsonSafe(index) as Row), version: 1 }
    const tmp = join(
      this.runtimeDir,
      `.${basename(this.indexFile)}.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, this.indexFile)
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
    const tmp = join(
      dirname(this.eventsFile),
      `.${basename(this.eventsFile)}.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    writeFileSync(
      tmp,
      events.map((event) => JSON.stringify(jsonSafe(event)) + '\n').join(''),
      'utf8',
    )
    renameSync(tmp, this.eventsFile)
  }
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
