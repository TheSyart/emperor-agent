import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
  version: number
}

export interface SessionCreateOptions {
  titleStatus?: string | null
  mode?: string
  project?: Record<string, unknown> | null
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
  private lastDiagnostics: SessionStoreDiagnostics = {
    sessionIndexSource: 'cache',
    repairedSessions: 0,
    rebuildReasons: [],
    legacyBackupPath: null,
  }

  constructor(root: string) {
    this.root = root
    this.sessionsDir = join(root, 'sessions')
    this.indexPath = join(this.sessionsDir, 'index.json')
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
    items.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    return items.map(cloneSession)
  }

  create(title = '', opts: SessionCreateOptions = {}): SessionEntry {
    const now = stamp()
    const cleanTitle = title.trim()
    const mode = opts.mode === 'build' ? 'build' : 'chat'
    const project = opts.project ?? {}
    const entry: SessionEntry = {
      id: randomUUID().replace(/-/g, '').slice(0, 16),
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

  touch(sessionId: string, preview: string, opts: { incrementMessages?: boolean } = {}): SessionEntry | null {
    const items = this.load()
    for (const item of items) {
      if (item.id !== sessionId) continue
      item.preview = preview.slice(0, 280)
      if (opts.incrementMessages) item.message_count = Number(item.message_count || 0) + 1
      item.updated_at = stamp()
      this.appendSnapshot(item)
      this.load()
      return cloneSession(item)
    }
    return null
  }

  setControlPending(sessionId: string, pending: SessionControlPending): SessionEntry | null {
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

  reconcileControlPending(pending: SessionControlPending | null, fallbackSessionId: string | null = null): void {
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
        if (JSON.stringify(item.control_pending) !== JSON.stringify(normalized)) {
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
    const needsLegacyBackup = indexItems.some((item) => item.id && !existsSync(this.metaPath(item.id)))
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

    const items = [...byId.values()].sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    this.save(items)
    this.lastDiagnostics = diagnostics
    return items
  }

  private loadIndex(diagnostics: SessionStoreDiagnostics): SessionEntry[] {
    if (!existsSync(this.indexPath)) return []
    try {
      const text = readFileSync(this.indexPath, 'utf8').trim()
      if (!text) return []
      const data = JSON.parse(text)
      if (!Array.isArray(data)) throw new Error('index.json must be a list')
      const normalized: SessionEntry[] = []
      for (const item of data) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          diagnostics.sessionIndexSource = 'rebuilt'
          diagnostics.rebuildReasons.push('index_entry_invalid')
          continue
        }
        const clean = normalizeSession(item as Record<string, unknown>)
        if (!clean.id) {
          diagnostics.sessionIndexSource = 'rebuilt'
          diagnostics.rebuildReasons.push('index_entry_missing_id')
          continue
        }
        if (JSON.stringify(clean) !== JSON.stringify(item)) {
          diagnostics.sessionIndexSource = 'rebuilt'
          diagnostics.rebuildReasons.push(`index_entry_normalized:${clean.id}`)
        }
        normalized.push(clean)
      }
      return normalized
    } catch {
      this.quarantineIndex()
      diagnostics.sessionIndexSource = 'rebuilt'
      diagnostics.rebuildReasons.push('index_corrupt')
      return []
    }
  }

  private save(items: SessionEntry[]): void {
    mkdirSync(this.sessionsDir, { recursive: true })
    const tmp = this.indexPath.replace(/\.json$/, '.json.tmp')
    const normalized = items.map((item) => normalizeSession(item as unknown as Record<string, unknown>)).filter((item) => item.id)
    writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8')
    renameSync(tmp, this.indexPath)
  }

  private quarantineIndex(): void {
    mkdirSync(this.sessionsDir, { recursive: true })
    if (!existsSync(this.indexPath)) return
    const target = join(this.sessionsDir, `index.corrupt-${stampForFilename()}.json`)
    try { renameSync(this.indexPath, target) } catch { /* ignore */ }
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
      diagnostics.rebuildReasons.push(`legacy_index_backup_failed:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private setArchived(sessionId: string, archived: boolean): SessionEntry | null {
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
    const clean = normalizeSession(session as unknown as Record<string, unknown>)
    if (!clean.id) return
    mkdirSync(this.sessionDir(clean.id), { recursive: true })
    const event: SessionMetaEvent = { type: 'session_snapshot', ts: stamp(), session: clean }
    writeFileSync(this.metaPath(clean.id), JSON.stringify(event) + '\n', { encoding: 'utf8', flag: 'a' })
  }

  private scanSessionDirectories(diagnostics: SessionStoreDiagnostics): SessionEntry[] {
    if (!existsSync(this.sessionsDir)) return []
    const out: SessionEntry[] = []
    for (const dirent of readdirSync(this.sessionsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue
      const id = dirent.name
      const sessionDir = this.sessionDir(id)
      const fromMeta = this.readLatestMeta(id, diagnostics)
      if (fromMeta) {
        out.push(fromMeta)
        continue
      }
      const recovered = this.recoverFromSessionFiles(id, sessionDir, diagnostics)
      if (recovered) out.push(recovered)
    }
    return out
  }

  private readLatestMeta(sessionId: string, diagnostics: SessionStoreDiagnostics): SessionEntry | null {
    const path = this.metaPath(sessionId)
    if (!existsSync(path)) return null
    let latest: SessionEntry | null = null
    let deleted = false
    const text = readFileSync(path, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed) as Partial<SessionMetaEvent> & Record<string, unknown>
        if (event.type === 'session_deleted') {
          deleted = true
          latest = null
          continue
        }
        if (event.type !== 'session_snapshot' || !event.session || typeof event.session !== 'object' || Array.isArray(event.session)) {
          diagnostics.rebuildReasons.push(`meta_event_ignored:${sessionId}`)
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

  private recoverFromSessionFiles(sessionId: string, sessionDir: string, diagnostics: SessionStoreDiagnostics): SessionEntry | null {
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
      version: VERSION,
    }
    this.appendSnapshot(entry)
    diagnostics.sessionIndexSource = 'rebuilt'
    diagnostics.repairedSessions += 1
    diagnostics.rebuildReasons.push(`recovered_session:${sessionId}`)
    return entry
  }
}

function normalizeSession(raw: Record<string, unknown>): SessionEntry {
  const mode = String(raw.mode ?? 'chat').trim().toLowerCase() === 'build' ? 'build' : 'chat'
  const updated = String(raw.updated_at ?? raw.updatedAt ?? raw.created_at ?? raw.createdAt ?? stamp())
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
    control_pending: normalizeControlPending(raw.control_pending ?? raw.controlPending),
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
  const interactionId = String(raw.interaction_id ?? raw.interactionId ?? '').trim()
  if (!interactionId) return null
  const defaultLabel = kind === 'plan' ? '计划需要用户确认' : '需要用户输入'
  const tone = kind === 'plan' ? 'green' : 'blue'
  return {
    kind,
    label: String(raw.label || defaultLabel).trim().slice(0, 40) || defaultLabel,
    tone,
    interaction_id: interactionId,
    updated_at: Number(raw.updated_at ?? raw.updatedAt ?? Date.now()) || Date.now(),
  }
}

function nullableText(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text || null
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10)
  return Number.isFinite(n) ? n : fallback
}

function truncateText(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max)
}

function stamp(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+0800`
}

function stampForFilename(): string {
  return stamp().replace(/[-:]/g, '').replace('+0800', '')
}
