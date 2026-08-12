import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  AppendOnlyJournalSync,
  AtomicSnapshotSync,
  type JournalCodec,
  type SnapshotCodec,
  type SyncPersistenceAdapter,
} from '../store/persistence'

const VERSION = 1

export interface SessionControlPending {
  kind: 'ask' | 'plan'
  label: string
  tone: 'blue' | 'green'
  interaction_id: string
  updated_at: number
}

export interface SessionEntry {
  id: string
  title: string
  created_at: string
  updated_at: string
  preview: string
  message_count: number
  title_status: string
  mode: 'chat' | 'build'
  project_id: string | null
  project_path: string | null
  project_name: string | null
  archived_at: string | null
  control_pending: SessionControlPending | null
  parent_session_id: string | null
  lineage_root_id: string | null
  transition_reason: 'clear' | null
  transitioned_to_session_id: string | null
  transitioned_at: string | null
  version: number
}

export interface SessionCreateOptions {
  id?: string | null
  titleStatus?: string | null
  mode?: string
  project?: Record<string, unknown> | null
  parentSessionId?: string | null
  lineageRootId?: string | null
  transitionReason?: 'clear' | null
}

export type SessionIndexSource = 'cache' | 'rebuilt'

export interface SessionStoreDiagnostics {
  sessionIndexSource: SessionIndexSource
  repairedSessions: number
  rebuildReasons: string[]
  legacyBackupPath: string | null
}

export type SessionMetaEvent =
  | { type: 'session_snapshot'; ts: string; session: SessionEntry }
  | { type: 'session_deleted'; ts: string; id: string }

export class SessionStore {
  readonly root: string
  readonly sessionsDir: string
  readonly indexPath: string
  private readonly persistenceAdapter?: SyncPersistenceAdapter
  private lastDiagnostics: SessionStoreDiagnostics = {
    sessionIndexSource: 'cache',
    repairedSessions: 0,
    rebuildReasons: [],
    legacyBackupPath: null,
  }

  constructor(
    root: string,
    opts: { persistenceAdapter?: SyncPersistenceAdapter } = {},
  ) {
    this.root = root
    this.sessionsDir = join(root, 'sessions')
    this.indexPath = join(this.sessionsDir, 'index.json')
    this.persistenceAdapter = opts.persistenceAdapter
  }

  sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId)
  }

  metaPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'meta.jsonl')
  }

  diagnostics(): SessionStoreDiagnostics {
    return {
      sessionIndexSource: this.lastDiagnostics.sessionIndexSource,
      repairedSessions: this.lastDiagnostics.repairedSessions,
      rebuildReasons: [...this.lastDiagnostics.rebuildReasons],
      legacyBackupPath: this.lastDiagnostics.legacyBackupPath,
    }
  }

  list(opts: { includeArchived?: boolean } = {}): SessionEntry[] {
    let items = this.load()
    if (!opts.includeArchived) items = items.filter((item) => !item.archived_at)
    items.sort((a, b) =>
      String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')),
    )
    return items.map(cloneSession)
  }

  create(title = '', opts: SessionCreateOptions = {}): SessionEntry {
    const now = stamp()
    const cleanTitle = title.trim()
    const mode = opts.mode === 'build' ? 'build' : 'chat'
    const project = opts.project ?? {}
    const entry: SessionEntry = {
      id: sessionId(opts.id),
      title: cleanTitle || 'Untitled',
      created_at: now,
      updated_at: now,
      preview: '',
      message_count: 0,
      title_status: opts.titleStatus || (cleanTitle ? 'manual' : 'placeholder'),
      mode,
      project_id: nullableText(project.project_id),
      project_path: nullableText(project.project_path),
      project_name: nullableText(project.project_name),
      archived_at: null,
      control_pending: null,
      parent_session_id: nullableText(opts.parentSessionId),
      lineage_root_id: nullableText(opts.lineageRootId),
      transition_reason: opts.transitionReason === 'clear' ? 'clear' : null,
      transitioned_to_session_id: null,
      transitioned_at: null,
      version: VERSION,
    }
    this.appendSnapshot(entry)
    this.load()
    return cloneSession(entry)
  }

  get(sessionId: string): SessionEntry | null {
    const found = this.load().find((item) => item.id === sessionId) ?? null
    return found ? cloneSession(found) : null
  }

  delete(sessionId: string): boolean {
    const items = this.load()
    if (items.length <= 1) return false
    const idx = items.findIndex((item) => item.id === sessionId)
    if (idx < 0) return false
    items.splice(idx, 1)
    rmSync(this.sessionDir(sessionId), { recursive: true, force: true })
    this.save(items)
    return true
  }

  rename(sessionId: string, title: string): boolean {
    const items = this.load()
    for (const item of items) {
      if (item.id !== sessionId) continue
      item.title = title.trim()
      item.updated_at = stamp()
      item.title_status = 'manual'
      this.appendSnapshot(item)
      this.load()
      return true
    }
    return false
  }

  archive(sessionId: string): SessionEntry | null {
    return this.setArchived(sessionId, true)
  }

  restore(sessionId: string): SessionEntry | null {
    return this.setArchived(sessionId, false)
  }

  setGeneratedTitle(sessionId: string, title: string): SessionEntry | null {
    const items = this.load()
    for (const item of items) {
      if (item.id !== sessionId) continue
      item.title = title.trim()
      item.title_status = 'generated'
      item.updated_at = stamp()
      this.appendSnapshot(item)
      this.load()
      return cloneSession(item)
    }
    return null
  }

  touch(
    sessionId: string,
    preview: string,
    opts: { incrementMessages?: boolean } = {},
  ): SessionEntry | null {
    const items = this.load()
    for (const item of items) {
      if (item.id !== sessionId) continue
      item.preview = preview.slice(0, 280)
      if (opts.incrementMessages)
        item.message_count = Number(item.message_count || 0) + 1
      item.updated_at = stamp()
      this.appendSnapshot(item)
      this.load()
      return cloneSession(item)
    }
    return null
  }

  setControlPending(
    sessionId: string,
    pending: SessionControlPending,
  ): SessionEntry | null {
    const normalized = normalizeControlPending(pending)
    if (!normalized) return null
    const items = this.load()
    for (const item of items) {
      if (item.id !== sessionId) continue
      item.control_pending = normalized
      item.updated_at = stamp()
      this.appendSnapshot(item)
      this.load()
      return cloneSession(item)
    }
    return null
  }

  clearControlPending(sessionId: string): SessionEntry | null {
    const items = this.load()
    for (const item of items) {
      if (item.id !== sessionId) continue
      item.control_pending = null
      item.updated_at = stamp()
      this.appendSnapshot(item)
      this.load()
      return cloneSession(item)
    }
    return null
  }

  reconcileSessionControlPending(
    sessionId: string,
    pending: SessionControlPending | null,
  ): void {
    const current = this.get(sessionId)
    if (!current) return
    const normalized = normalizeControlPending(pending)
    if (JSON.stringify(current.control_pending) === JSON.stringify(normalized))
      return
    if (normalized) this.setControlPending(sessionId, normalized)
    else this.clearControlPending(sessionId)
  }

  markTransitioned(
    sessionId: string,
    targetSessionId: string,
  ): SessionEntry | null {
    const items = this.load()
    for (const item of items) {
      if (item.id !== sessionId) continue
      item.transitioned_to_session_id = targetSessionId
      item.transitioned_at = stamp()
      item.updated_at = stamp()
      this.appendSnapshot(item)
      this.load()
      return cloneSession(item)
    }
    return null
  }

  reconcileControlPending(
    pending: SessionControlPending | null,
    fallbackSessionId: string | null = null,
  ): void {
    const normalized = normalizeControlPending(pending)
    const items = this.load()
    let changed = false
    let matched = false

    for (const item of items) {
      if (!normalized) {
        if (item.control_pending !== null) {
          item.control_pending = null
          item.updated_at = stamp()
          changed = true
        }
        continue
      }

      if (item.control_pending?.interaction_id === normalized.interaction_id) {
        matched = true
        if (
          JSON.stringify(item.control_pending) !== JSON.stringify(normalized)
        ) {
          item.control_pending = normalized
          item.updated_at = stamp()
          changed = true
        }
        continue
      }

      if (item.control_pending !== null) {
        item.control_pending = null
        item.updated_at = stamp()
        changed = true
      }
    }

    if (normalized && !matched && fallbackSessionId) {
      for (const item of items) {
        if (item.id !== fallbackSessionId) continue
        item.control_pending = normalized
        item.updated_at = stamp()
        changed = true
        break
      }
    }

    if (changed) {
      for (const item of items) this.appendSnapshot(item)
      this.load()
    }
  }

  private load(): SessionEntry[] {
    mkdirSync(this.sessionsDir, { recursive: true })
    const diagnostics: SessionStoreDiagnostics = {
      sessionIndexSource: existsSync(this.indexPath) ? 'cache' : 'rebuilt',
      repairedSessions: 0,
      rebuildReasons: existsSync(this.indexPath) ? [] : ['index_missing'],
      legacyBackupPath: this.legacyBackupPathIfExists(),
    }

    const indexItems = this.loadIndex(diagnostics)
    const needsLegacyBackup = indexItems.some(
      (item) => item.id && !existsSync(this.metaPath(item.id)),
    )
    if (needsLegacyBackup) this.backupLegacyIndex(diagnostics)
    for (const item of indexItems) {
      if (!item.id) continue
      if (existsSync(this.metaPath(item.id))) continue
      this.appendSnapshot(item)
      diagnostics.repairedSessions += 1
      diagnostics.rebuildReasons.push(`materialized_legacy_index:${item.id}`)
    }

    const byId = new Map<string, SessionEntry>()
    for (const item of this.scanSessionDirectories(diagnostics)) {
      if (!item.id) continue
      byId.set(item.id, item)
    }

    const items = [...byId.values()].sort((a, b) =>
      String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')),
    )
    this.save(items)
    this.lastDiagnostics = diagnostics
    return items
  }

  private loadIndex(diagnostics: SessionStoreDiagnostics): SessionEntry[] {
    const loaded = this.indexSnapshot(diagnostics).read({ fallback: [] })
    if (loaded.receipt.recoveryAction === 'quarantined_corrupt_snapshot') {
      diagnostics.sessionIndexSource = 'rebuilt'
      diagnostics.rebuildReasons.push('index_corrupt')
    }
    return loaded.value
  }

  private save(items: SessionEntry[]): void {
    this.indexSnapshot().write(items)
  }

  private indexSnapshot(
    diagnostics?: SessionStoreDiagnostics,
  ): AtomicSnapshotSync<SessionEntry[]> {
    return new AtomicSnapshotSync({
      path: this.indexPath,
      codec: sessionIndexCodec(diagnostics),
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
      corruptionBackupPath: () =>
        join(this.sessionsDir, `index.corrupt-${stampForFilename()}.json`),
    })
  }

  private legacyBackupPath(): string {
    return join(this.sessionsDir, 'index.legacy-backup.json')
  }

  private legacyBackupPathIfExists(): string | null {
    const path = this.legacyBackupPath()
    return existsSync(path) ? path : null
  }

  private backupLegacyIndex(diagnostics: SessionStoreDiagnostics): void {
    if (!existsSync(this.indexPath)) return
    const backupPath = this.legacyBackupPath()
    if (existsSync(backupPath)) {
      diagnostics.legacyBackupPath = backupPath
      return
    }
    try {
      writeFileSync(backupPath, readFileSync(this.indexPath, 'utf8'), 'utf8')
      diagnostics.legacyBackupPath = backupPath
      diagnostics.rebuildReasons.push('legacy_index_backed_up')
    } catch (err) {
      diagnostics.rebuildReasons.push(
        `legacy_index_backup_failed:${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private setArchived(
    sessionId: string,
    archived: boolean,
  ): SessionEntry | null {
    const items = this.load()
    for (const item of items) {
      if (item.id !== sessionId) continue
      item.archived_at = archived ? stamp() : null
      item.updated_at = stamp()
      this.appendSnapshot(item)
      this.load()
      return cloneSession(item)
    }
    return null
  }

  private appendSnapshot(session: SessionEntry): void {
    const clean = normalizeSession(
      session as unknown as Record<string, unknown>,
    )
    if (!clean.id) return
    const event: SessionMetaEvent = {
      type: 'session_snapshot',
      ts: stamp(),
      session: clean,
    }
    this.metaJournal(clean.id).append(event)
  }

  private scanSessionDirectories(
    diagnostics: SessionStoreDiagnostics,
  ): SessionEntry[] {
    if (!existsSync(this.sessionsDir)) return []
    const out: SessionEntry[] = []
    for (const dirent of readdirSync(this.sessionsDir, {
      withFileTypes: true,
    })) {
      if (!dirent.isDirectory()) continue
      const id = dirent.name
      const sessionDir = this.sessionDir(id)
      const fromMeta = this.readLatestMeta(id, diagnostics)
      if (fromMeta) {
        out.push(fromMeta)
        continue
      }
      const recovered = this.recoverFromSessionFiles(
        id,
        sessionDir,
        diagnostics,
      )
      if (recovered) out.push(recovered)
    }
    return out
  }

  private readLatestMeta(
    sessionId: string,
    diagnostics: SessionStoreDiagnostics,
  ): SessionEntry | null {
    const path = this.metaPath(sessionId)
    if (!existsSync(path)) return null
    let latest: SessionEntry | null = null
    let deleted = false
    const replay = this.metaJournal(sessionId).replay({ repairTail: true })
    if (replay.receipt.recoveryAction !== 'none')
      diagnostics.rebuildReasons.push(`meta_line_invalid:${sessionId}`)
    for (const entry of replay.entries) {
      const event = entry.payload
      try {
        if (event.type === 'session_deleted') {
          deleted = true
          latest = null
          continue
        }
        const session = event.session as unknown as Record<string, unknown>
        const clean = normalizeSession({ id: sessionId, ...session })
        latest = clean
        deleted = false
      } catch {
        diagnostics.rebuildReasons.push(`meta_line_invalid:${sessionId}`)
      }
    }
    if (deleted) return null
    return latest
  }

  private metaJournal(
    sessionId: string,
  ): AppendOnlyJournalSync<SessionMetaEvent> {
    return new AppendOnlyJournalSync({
      path: this.metaPath(sessionId),
      codec: SESSION_META_JOURNAL_CODEC,
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
      recoveryMode: 'tolerant',
    })
  }

  private recoverFromSessionFiles(
    sessionId: string,
    sessionDir: string,
    diagnostics: SessionStoreDiagnostics,
  ): SessionEntry | null {
    const historyPath = join(sessionDir, 'history.jsonl')
    const runtimePath = join(sessionDir, 'runtime', 'events.jsonl')
    if (!existsSync(historyPath) && !existsSync(runtimePath)) {
      diagnostics.rebuildReasons.push(`session_dir_empty:${sessionId}`)
      return null
    }

    const messages: Array<{ ts: string; role: string; content: string }> = []
    if (existsSync(historyPath)) {
      for (const line of readFileSync(historyPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const row = JSON.parse(trimmed) as Record<string, unknown>
          const role = String(row.role ?? '')
          if (role !== 'user' && role !== 'assistant') continue
          if (typeof row.content !== 'string') continue
          messages.push({
            ts: typeof row.ts === 'string' ? row.ts : '',
            role,
            content: row.content,
          })
        } catch {
          diagnostics.rebuildReasons.push(`history_line_invalid:${sessionId}`)
        }
      }
    }

    const first = messages[0] ?? null
    const last = messages[messages.length - 1] ?? null
    const firstUser = messages.find((row) => row.role === 'user')
    const now = stamp()
    const entry: SessionEntry = {
      id: sessionId,
      title: truncateText(firstUser?.content || sessionId, 80) || sessionId,
      created_at: first?.ts || now,
      updated_at: last?.ts || first?.ts || now,
      preview: truncateText(last?.content || '', 280),
      message_count: messages.length,
      title_status: firstUser ? 'generated' : 'placeholder',
      mode: 'chat',
      project_id: null,
      project_path: null,
      project_name: null,
      archived_at: null,
      control_pending: null,
      parent_session_id: null,
      lineage_root_id: null,
      transition_reason: null,
      transitioned_to_session_id: null,
      transitioned_at: null,
      version: VERSION,
    }
    this.appendSnapshot(entry)
    diagnostics.sessionIndexSource = 'rebuilt'
    diagnostics.repairedSessions += 1
    diagnostics.rebuildReasons.push(`recovered_session:${sessionId}`)
    return entry
  }
}

const SESSION_META_JOURNAL_CODEC: JournalCodec<SessionMetaEvent> = {
  schemaVersion: VERSION,
  create(seq, payload) {
    return {
      schemaVersion: VERSION,
      seq,
      checksum: sessionMetaChecksum(payload),
      payload,
    }
  },
  encode(entry) {
    return entry.payload
  },
  decode(input, context) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('session meta row must be an object')
    const row = input as Record<string, unknown>
    let payload: SessionMetaEvent
    if (row.type === 'session_deleted' && typeof row.id === 'string') {
      payload = {
        type: 'session_deleted',
        ts: typeof row.ts === 'string' ? row.ts : '',
        id: row.id,
      }
    } else if (
      row.type === 'session_snapshot' &&
      row.session &&
      typeof row.session === 'object' &&
      !Array.isArray(row.session)
    ) {
      payload = {
        type: 'session_snapshot',
        ts: typeof row.ts === 'string' ? row.ts : '',
        session: row.session as unknown as SessionEntry,
      }
    } else {
      throw new Error('session meta event is invalid')
    }
    return {
      schemaVersion: VERSION,
      seq: context.expectedSeq,
      checksum: sessionMetaChecksum(payload),
      payload,
    }
  },
}

function sessionMetaChecksum(event: SessionMetaEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex')
}

function sessionIndexCodec(
  diagnostics?: SessionStoreDiagnostics,
): SnapshotCodec<SessionEntry[]> {
  return {
    schemaVersion: VERSION,
    encode(items) {
      return items
        .map((item) =>
          normalizeSession(item as unknown as Record<string, unknown>),
        )
        .filter((item) => item.id)
    },
    decode(input) {
      if (!Array.isArray(input)) throw new Error('index.json must be a list')
      const normalized: SessionEntry[] = []
      for (const item of input) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          if (diagnostics) {
            diagnostics.sessionIndexSource = 'rebuilt'
            diagnostics.rebuildReasons.push('index_entry_invalid')
          }
          continue
        }
        const clean = normalizeSession(item as Record<string, unknown>)
        if (!clean.id) {
          if (diagnostics) {
            diagnostics.sessionIndexSource = 'rebuilt'
            diagnostics.rebuildReasons.push('index_entry_missing_id')
          }
          continue
        }
        if (diagnostics && JSON.stringify(clean) !== JSON.stringify(item)) {
          diagnostics.sessionIndexSource = 'rebuilt'
          diagnostics.rebuildReasons.push(`index_entry_normalized:${clean.id}`)
        }
        normalized.push(clean)
      }
      return { value: normalized, schemaVersion: VERSION }
    },
  }
}

function sessionId(requested: string | null | undefined): string {
  const value = String(requested ?? '').trim()
  if (value && /^[A-Za-z0-9][A-Za-z0-9_.-]{7,95}$/.test(value)) return value
  if (value) throw new Error('invalid session id')
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

function normalizeSession(raw: Record<string, unknown>): SessionEntry {
  const mode =
    String(raw.mode ?? 'chat')
      .trim()
      .toLowerCase() === 'build'
      ? 'build'
      : 'chat'
  const updated = String(
    raw.updated_at ??
      raw.updatedAt ??
      raw.created_at ??
      raw.createdAt ??
      stamp(),
  )
  const created = String(raw.created_at ?? raw.createdAt ?? updated)
  return {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? 'Untitled'),
    created_at: created,
    updated_at: updated,
    preview: truncateText(raw.preview ?? '', 280),
    message_count: toInt(raw.message_count ?? raw.messageCount, 0),
    title_status: String(raw.title_status ?? raw.titleStatus ?? 'manual'),
    mode,
    project_id: nullableText(raw.project_id ?? raw.projectId),
    project_path: nullableText(raw.project_path ?? raw.projectPath),
    project_name: nullableText(raw.project_name ?? raw.projectName),
    archived_at: nullableText(raw.archived_at ?? raw.archivedAt),
    control_pending: normalizeControlPending(
      raw.control_pending ?? raw.controlPending,
    ),
    parent_session_id: nullableText(
      raw.parent_session_id ?? raw.parentSessionId,
    ),
    lineage_root_id: nullableText(raw.lineage_root_id ?? raw.lineageRootId),
    transition_reason:
      String(raw.transition_reason ?? raw.transitionReason ?? '') === 'clear'
        ? 'clear'
        : null,
    transitioned_to_session_id: nullableText(
      raw.transitioned_to_session_id ?? raw.transitionedToSessionId,
    ),
    transitioned_at: nullableText(raw.transitioned_at ?? raw.transitionedAt),
    version: toInt(raw.version, VERSION),
  }
}

function cloneSession(item: SessionEntry): SessionEntry {
  return {
    ...item,
    control_pending: item.control_pending ? { ...item.control_pending } : null,
  }
}

function normalizeControlPending(value: unknown): SessionControlPending | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const kind = String(raw.kind || '').trim()
  if (kind !== 'ask' && kind !== 'plan') return null
  const interactionId = String(
    raw.interaction_id ?? raw.interactionId ?? '',
  ).trim()
  if (!interactionId) return null
  const defaultLabel = kind === 'plan' ? '计划需要用户确认' : '需要用户输入'
  const tone = kind === 'plan' ? 'green' : 'blue'
  return {
    kind,
    label:
      String(raw.label || defaultLabel)
        .trim()
        .slice(0, 40) || defaultLabel,
    tone,
    interaction_id: interactionId,
    updated_at:
      Number(raw.updated_at ?? raw.updatedAt ?? Date.now()) || Date.now(),
  }
}

function nullableText(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text || null
}

function toInt(value: unknown, fallback: number): number {
  const n =
    typeof value === 'number'
      ? Math.trunc(value)
      : Number.parseInt(String(value), 10)
  return Number.isFinite(n) ? n : fallback
}

function truncateText(value: unknown, max: number): string {
  return String(value ?? '')
    .trim()
    .slice(0, max)
}

function stamp(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+0800`
}

function stampForFilename(): string {
  return stamp().replace(/[-:]/g, '').replace('+0800', '')
}
