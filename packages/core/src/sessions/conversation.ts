import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HistoryLog, type HistoryArchiveGate } from '../memory/history'
import type { MemoryStore } from '../memory/store'
import { nowIsoUtc8 } from '../memory/time-utc8'
import { clearTurnCheckpoint, readRecoverableCheckpointHistory, writeTurnCheckpoint, type CheckpointWriteOptions } from './checkpoint'

type Row = Record<string, unknown>

export class ConversationStore {
  readonly sessionDir: string
  readonly historyFile: string
  readonly checkpointFile: string
  readonly historyLog: HistoryLog

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir
    mkdirSync(this.sessionDir, { recursive: true })
    this.historyFile = join(this.sessionDir, 'history.jsonl')
    this.checkpointFile = join(this.sessionDir, '_checkpoint.json')
    this.historyLog = new HistoryLog(this.sessionDir, this.historyFile)
  }

  appendHistory(role: string, content: unknown, opts?: { extra?: Row | null }): void {
    const row: Row = {
      ts: nowIsoUtc8(),
      role,
      content: typeof content === 'string' ? content : JSON.stringify(jsonSafe(content)),
    }
    if (opts?.extra) {
      for (const [key, value] of Object.entries(jsonSafe(opts.extra) as Row)) {
        if (!(key in row)) row[key] = value
      }
    }
    this.historyLog.append(row)
  }

  loadUnarchivedHistory(): Row[] {
    const out: Row[] = []
    const active = this.historyLog.loadActiveRows()
    const hidden = new Set<string>()
    for (const row of active) {
      if (typeof row.turn_id === 'string' && (row.hidden === true || row.schedulerHidden === true)) {
        hidden.add(row.turn_id)
      }
    }
    for (const row of active) {
      if (!('role' in row) || !('content' in row)) continue
      if (row.type === 'model_call') continue
      if (hidden.has(String(row.turn_id ?? ''))) continue
      const item: Row = { role: row.role, content: row.content }
      if (Number.isFinite(Number(row.seq)) && Number(row.seq) > 0) item.seq = Math.trunc(Number(row.seq))
      if (typeof row.turn_id === 'string') item.turn_id = row.turn_id
      if (Array.isArray(row.attachments)) item.attachments = row.attachments
      if (typeof row.displayContent === 'string') item.displayContent = row.displayContent
      out.push(item)
    }
    return out
  }

  loadUnarchivedTurnIds(): string[] {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const row of this.loadUnarchivedHistory()) {
      const turnId = row.turn_id
      if (typeof turnId !== 'string' || !turnId || seen.has(turnId)) continue
      seen.add(turnId)
      ids.push(turnId)
    }
    return ids
  }

  appendCompactMarker(activeHistory?: Row[] | null, archiveGate?: HistoryArchiveGate | null): void {
    if (activeHistory === undefined || activeHistory === null) {
      this.historyLog.append({ ts: '', type: 'compact_event' })
      return
    }
    this.historyLog.compact(activeHistory, archiveGate)
  }

  stats(): Row {
    return this.historyLog.stats()
  }

  writeCheckpoint(history: Row[], opts: CheckpointWriteOptions = {}): void {
    writeTurnCheckpoint(this.checkpointFile, history, {
      ...opts,
      baseHistorySeq: opts.baseHistorySeq ?? Number(this.historyLog.stats().latest_seq ?? 0),
    })
  }

  readCheckpoint(): Row[] | null {
    return readRecoverableCheckpointHistory(this.checkpointFile, {
      lastHistorySeq: Number(this.historyLog.stats().latest_seq ?? 0),
    }) as Row[] | null
  }

  clearCheckpoint(): void {
    clearTurnCheckpoint(this.checkpointFile)
  }
}

export class SessionMemoryStore {
  readonly sharedMemory: MemoryStore
  readonly conversation: ConversationStore
  readonly memoryDir: string
  readonly historyFile: string
  readonly checkpointFile: string
  readonly versions: MemoryStore['versions']

  constructor(sharedMemory: MemoryStore, conversation: ConversationStore) {
    this.sharedMemory = sharedMemory
    this.conversation = conversation
    this.memoryDir = sharedMemory.memoryDir
    this.historyFile = conversation.historyFile
    this.checkpointFile = conversation.checkpointFile
    this.versions = sharedMemory.versions
  }

  appendHistory(role: string, content: unknown, opts?: { extra?: Row | null }): void {
    this.conversation.appendHistory(role, content, opts)
  }

  loadUnarchivedHistory(): Row[] {
    return this.conversation.loadUnarchivedHistory()
  }

  loadUnarchivedTurnIds(): string[] {
    return this.conversation.loadUnarchivedTurnIds()
  }

  appendCompactMarker(activeHistory?: Row[] | null, archiveGate?: HistoryArchiveGate | null): void {
    this.conversation.appendCompactMarker(activeHistory, archiveGate)
  }

  historyStats(): Row {
    return this.conversation.stats()
  }

  writeCheckpoint(history: Row[], opts: CheckpointWriteOptions = {}): void {
    this.conversation.writeCheckpoint(history, opts)
  }

  readCheckpoint(): Row[] | null {
    return this.conversation.readCheckpoint()
  }

  clearCheckpoint(): void {
    this.conversation.clearCheckpoint()
  }

  readMemory(): string { return this.sharedMemory.readMemory() }
  writeMemory(content: string): void { this.sharedMemory.writeMemory(content) }
  readTodayEpisode(): string { return this.sharedMemory.readTodayEpisode() }
  appendEpisode(content: string): void { this.sharedMemory.appendEpisode(content) }
  readUser(): string { return this.sharedMemory.readUser() }
  writeUser(content: string): void { this.sharedMemory.writeUser(content) }
}

export interface ProjectMemoryStoreLike {
  readManagedMemory(projectId: string): string
  updateMemory(projectId: string, content: string): void
}

export class ProjectSessionMemoryStore extends SessionMemoryStore {
  readonly projectStore: ProjectMemoryStoreLike
  readonly projectId: string

  constructor(
    sharedMemory: MemoryStore,
    conversation: ConversationStore,
    projectStore: ProjectMemoryStoreLike,
    projectId: string,
  ) {
    super(sharedMemory, conversation)
    this.projectStore = projectStore
    this.projectId = projectId
  }

  override readMemory(): string {
    return this.projectStore.readManagedMemory(this.projectId)
  }

  override writeMemory(content: string): void {
    this.projectStore.updateMemory(this.projectId, content)
  }

  override readTodayEpisode(): string {
    return ''
  }

  override appendEpisode(_content: string): void {
    return undefined
  }

  override writeUser(_content: string): void {
    return undefined
  }
}

function jsonSafe(obj: unknown): unknown {
  try {
    JSON.stringify(obj)
    return obj
  } catch {
    if (Array.isArray(obj)) return obj.map(jsonSafe)
    if (obj && typeof obj === 'object') {
      const out: Row = {}
      for (const [key, value] of Object.entries(obj as Row)) out[key] = jsonSafe(value)
      return out
    }
    return String(obj)
  }
}
