/**
 * MemoryStore — 三层记忆（原始 history / 每日情景 / 长期记忆）(MIG-MEM-001)。
 * 对齐 Python `agent/memory.py`。磁盘兼容: 行 schema + checkpoint JSON 不变。
 * 实现 runner 的 MemoryStoreLike（writeCheckpoint/clearCheckpoint/readCheckpoint/appendHistory）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { HistoryLog, type HistoryArchiveGate } from './history'
import { MemoryVersionStore } from './versions'
import { nowIsoUtc8, todayUtc8 } from './time-utc8'
import {
  clearTurnCheckpoint,
  readRecoverableCheckpointHistory,
  writeTurnCheckpoint,
  type CheckpointWriteOptions,
} from '../sessions/checkpoint'

type Row = Record<string, unknown>

export class MemoryStore {
  readonly memoryDir: string
  readonly memoryFile: string
  readonly historyFile: string
  readonly checkpointFile: string
  readonly userFile: string
  readonly memoryTemplate: string | null
  readonly historyLog: HistoryLog
  readonly versions: MemoryVersionStore

  constructor(
    memoryDir: string,
    userFile: string,
    opts?: { memoryTemplate?: string | null },
  ) {
    this.memoryDir = memoryDir
    this.memoryFile = join(memoryDir, 'MEMORY.local.md')
    this.historyFile = join(memoryDir, 'history.jsonl')
    this.checkpointFile = join(memoryDir, '_checkpoint.json')
    this.userFile = userFile
    this.memoryTemplate = opts?.memoryTemplate ?? null
    this.ensure()
    this.historyLog = new HistoryLog(this.memoryDir, this.historyFile)
    this.versions = new MemoryVersionStore(
      join(this.memoryDir, '..'),
      this.memoryDir,
      this.userFile,
    )
  }

  private ensure(): void {
    mkdirSync(this.memoryDir, { recursive: true })
    const legacyMemory = join(this.memoryDir, 'MEMORY.md')
    if (!existsSync(this.memoryFile) && existsSync(legacyMemory))
      renameSync(legacyMemory, this.memoryFile)
    if (!existsSync(this.memoryFile)) {
      if (this.memoryTemplate && existsSync(this.memoryTemplate)) {
        writeFileSync(
          this.memoryFile,
          readFileSync(this.memoryTemplate, 'utf8'),
          'utf8',
        )
      } else {
        writeFileSync(
          this.memoryFile,
          '# 长期记忆\n\n此文件常驻上下文，记录核心目标、当前任务与关键事实。\n',
          'utf8',
        )
      }
    }
    if (!existsSync(this.historyFile))
      writeFileSync(this.historyFile, '', 'utf8')
  }

  // ── 原始层 ──
  appendHistory(
    role: string,
    content: unknown,
    opts?: { extra?: Record<string, unknown> | null },
  ): void {
    const row: Row = {
      ts: nowIsoUtc8(),
      role,
      content: typeof content === 'string' ? content : jsonSafe(content),
    }
    if (opts?.extra) {
      for (const [k, v] of Object.entries(
        jsonSafe(opts.extra) as Record<string, unknown>,
      )) {
        if (!(k in row)) row[k] = v
      }
    }
    this.historyLog.append(row)
  }

  // ── 中期层（按日历日 UTC+8）──
  todayEpisodePath(): string {
    return join(this.memoryDir, `${todayUtc8()}.md`)
  }

  readTodayEpisode(): string {
    const p = this.todayEpisodePath()
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }

  appendEpisode(content: string): void {
    const p = this.todayEpisodePath()
    const stem = todayUtc8()
    const existing = existsSync(p)
      ? readFileSync(p, 'utf8')
      : `# ${stem} 情景记忆\n`
    if (existsSync(p))
      this.versions.snapshotPath(p, {
        target: 'episode',
        reason: 'append_episode',
      })
    const newText =
      existing.replace(/\s+$/, '') + '\n\n' + content.trim() + '\n'
    writeFileSync(p, newText, 'utf8')
  }

  // ── 长期层 ──
  readMemory(): string {
    return existsSync(this.memoryFile)
      ? readFileSync(this.memoryFile, 'utf8')
      : ''
  }

  writeMemory(content: string): void {
    if (existsSync(this.memoryFile))
      this.versions.snapshotPath(this.memoryFile, {
        target: 'memory',
        reason: 'write_memory',
      })
    MemoryVersionStore.atomicWriteText(this.memoryFile, content.trim() + '\n')
  }

  // ── 归档标记 ──
  appendCompactMarker(
    activeHistory?: Row[] | null,
    archiveGate?: HistoryArchiveGate | null,
  ): void {
    if (activeHistory === undefined || activeHistory === null) {
      this.historyLog.append({ ts: nowIsoUtc8(), type: 'compact_event' })
      return
    }
    this.historyLog.compact(activeHistory, archiveGate)
  }

  historyStats(): Row {
    return this.historyLog.stats()
  }

  loadUnarchivedHistory(): Row[] {
    const out: Row[] = []
    const activeRows = this.historyLog.loadActiveRows()
    const hiddenTurns = new Set<string>()
    for (const r of activeRows) {
      if (
        typeof r.turn_id === 'string' &&
        (r.hidden === true || r.schedulerHidden === true)
      )
        hiddenTurns.add(String(r.turn_id))
    }
    for (const r of activeRows) {
      if (!('role' in r) || !('content' in r)) continue
      if (r.type === 'model_call') continue
      if (hiddenTurns.has(String(r.turn_id ?? ''))) continue
      const item: Row = { role: r.role, content: r.content }
      if (Number.isFinite(Number(r.seq)) && Number(r.seq) > 0)
        item.seq = Math.trunc(Number(r.seq))
      if (typeof r.turn_id === 'string') item.turn_id = r.turn_id
      if (Array.isArray(r.attachments)) item.attachments = r.attachments
      if (typeof r.displayContent === 'string')
        item.displayContent = r.displayContent
      out.push(item)
    }
    return out
  }

  loadUnarchivedTurnIds(): string[] {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const item of this.loadUnarchivedHistory()) {
      const turnId = item.turn_id
      if (typeof turnId !== 'string' || !turnId || seen.has(turnId)) continue
      seen.add(turnId)
      ids.push(turnId)
    }
    return ids
  }

  // ── 用户偏好 ──
  readUser(): string {
    return existsSync(this.userFile) ? readFileSync(this.userFile, 'utf8') : ''
  }

  writeUser(content: string): void {
    if (existsSync(this.userFile))
      this.versions.snapshotPath(this.userFile, {
        target: 'user',
        reason: 'write_user',
      })
    MemoryVersionStore.atomicWriteText(this.userFile, content.trim() + '\n')
  }

  // ── 中断恢复 Checkpoint ──
  writeCheckpoint(history: Row[], opts: CheckpointWriteOptions = {}): void {
    try {
      writeTurnCheckpoint(this.checkpointFile, history, {
        ...opts,
        baseHistorySeq:
          opts.baseHistorySeq ??
          Number(this.historyLog.stats().latest_seq ?? 0),
      })
    } catch {
      /* 失败静默：绝不能影响主流程 */
    }
  }

  readCheckpoint(): Row[] | null {
    try {
      return readRecoverableCheckpointHistory(this.checkpointFile, {
        lastHistorySeq: Number(this.historyLog.stats().latest_seq ?? 0),
      }) as Row[] | null
    } catch {
      return null
    }
  }

  clearCheckpoint(): void {
    try {
      clearTurnCheckpoint(this.checkpointFile)
    } catch {
      /* 失败静默 */
    }
  }
}

function jsonSafe(obj: unknown): unknown {
  try {
    JSON.stringify(obj)
    return obj
  } catch {
    if (Array.isArray(obj)) return obj.map(jsonSafe)
    if (obj && typeof obj === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj as Record<string, unknown>))
        out[k] = jsonSafe(v)
      return out
    }
    return String(obj)
  }
}
