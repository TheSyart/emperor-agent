/**
 * 历史 jsonl 热段 + 归档 (MIG-MEM-001)。对齐 Python `agent/memory_history.py`。
 * 热段保持小；compact 时把不再活跃的行归档到 history_archive/<month>.jsonl.gz。
 * 磁盘兼容: history.jsonl 行 schema + history_index.json 不变。
 */
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
import { gzipSync } from 'node:zlib'
import { basename, dirname, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { nowIsoUtc8 } from './time-utc8'

const INDEX_VERSION = 1

type Row = Record<string, unknown>

export interface HistoryArchiveGate {
  canArchiveUntil(seq: number): boolean
  markArchived?(seq: number): void
}

export class HistoryLog {
  readonly memoryDir: string
  readonly historyFile: string
  readonly archiveDir: string
  readonly indexFile: string
  readonly legacyBackup: string

  constructor(memoryDir: string, historyFile: string) {
    this.memoryDir = memoryDir
    this.historyFile = historyFile
    this.archiveDir = join(this.memoryDir, 'history_archive')
    this.indexFile = join(this.memoryDir, 'history_index.json')
    this.legacyBackup = join(this.memoryDir, 'history.legacy-backup.jsonl')
    this.ensure()
  }

  append(row: Row): Row {
    let index = this.loadIndex()
    if (index.active_lines === undefined || index.active_bytes === undefined)
      index = this.statsFromIndex(index)
    const payload: Row = { ...row }
    if (payload.seq === undefined)
      payload.seq = (Number(index.latest_seq) || 0) + 1
    if (payload.archived === undefined) payload.archived = false
    if (payload.ts === undefined) payload.ts = nowIsoUtc8()
    const line = JSON.stringify(jsonSafe(payload)) + '\n'
    appendFileSync(this.historyFile, line, 'utf8')
    index.latest_seq = Math.max(
      Number(index.latest_seq) || 0,
      Number(payload.seq) || 0,
    )
    index.active_lines = (Number(index.active_lines) || 0) + 1
    index.active_bytes =
      (Number(index.active_bytes) || 0) + Buffer.byteLength(line, 'utf8')
    index.hot_limit_lines = 2000
    index.hot_limit_bytes = 5 * 1024 * 1024
    index.needs_rotation =
      Number(index.active_bytes) > 5 * 1024 * 1024 ||
      Number(index.active_lines) > 2000
    this.writeIndex(index)
    return payload
  }

  compact(
    activeMessages: Row[],
    archiveGate?: HistoryArchiveGate | null,
  ): void {
    const hotRows = this.readHotRows()
    const marker: Row = {
      seq: HistoryLog.nextSeq(hotRows),
      ts: nowIsoUtc8(),
      type: 'compact_event',
      archived: true,
    }
    const activeRows = this.activeRowsFromMessages(activeMessages, hotRows)
    const [archivedRows, gatedKeepRows] = this.rowsToArchive(
      hotRows,
      activeRows,
      archiveGate,
    )
    const maxArchivedSeq = maxSeq(archivedRows)
    if (archiveGate && maxArchivedSeq <= 0 && gatedKeepRows.length > 0) {
      throw new Error(
        `cannot archive history beyond semantic compaction cursor: seq ${maxSeq(gatedKeepRows)}`,
      )
    }
    if (
      archiveGate &&
      maxArchivedSeq > 0 &&
      !archiveGate.canArchiveUntil(maxArchivedSeq)
    ) {
      throw new Error(
        `cannot archive history beyond semantic compaction cursor: seq ${maxArchivedSeq}`,
      )
    }
    archivedRows.push(marker)
    if (archivedRows.length) this.appendArchive(archivedRows)
    this.rewriteHot(
      [...activeRows, ...gatedKeepRows].sort(
        (a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0),
      ),
    )
    const index = this.loadIndex()
    index.latest_seq = Math.max(
      Number(index.latest_seq) || 0,
      Number(marker.seq),
    )
    index.last_archive_at = marker.ts
    this.writeIndex(this.statsFromIndex(index))
    if (archiveGate && maxArchivedSeq > 0)
      archiveGate.markArchived?.(maxArchivedSeq)
  }

  loadActiveRows(): Row[] {
    return this.readHotRows().filter((row) => row.type !== 'compact_event')
  }

  lastCompletedTurnSeq(): number {
    const turns = this.completedTurns()
    return turns.length ? turns[turns.length - 1]!.lastSeq : 0
  }

  seqBeforeLastNTurns(n: number): number {
    const turns = this.completedTurns()
    if (!turns.length) return 1
    const keep = Math.max(0, Math.trunc(Number(n) || 0))
    if (keep <= 0) return turns[turns.length - 1]!.lastSeq + 1
    if (keep >= turns.length) return turns[0]!.firstSeq
    return turns[turns.length - keep]!.firstSeq
  }

  countCompletedTurns(fromSeq: number, toSeq: number): number {
    const from = Number(fromSeq) || 0
    const to = Number(toSeq) || 0
    if (to < from) return 0
    return this.completedTurns().filter(
      (turn) => turn.firstSeq >= from && turn.lastSeq <= to,
    ).length
  }

  stats(): Row {
    return this.statsFromIndex(this.loadIndex())
  }

  private ensure(): void {
    mkdirSync(this.memoryDir, { recursive: true })
    mkdirSync(this.archiveDir, { recursive: true })
    if (!existsSync(this.historyFile))
      writeFileSync(this.historyFile, '', 'utf8')
    if (!existsSync(this.indexFile)) this.migrateLegacyHistory()
    else this.writeIndex(this.statsFromIndex(this.loadIndex()))
  }

  private migrateLegacyHistory(): void {
    const rows = this.readHotRows({ assignSeq: true })
    if (existsSync(this.historyFile) && !existsSync(this.legacyBackup)) {
      writeFileSync(this.legacyBackup, readFileSync(this.historyFile), 'utf8')
    }
    let lastMarker = -1
    rows.forEach((row, i) => {
      if (row.type === 'compact_event') lastMarker = i
    })
    const archived = lastMarker >= 0 ? rows.slice(0, lastMarker + 1) : []
    const active = lastMarker >= 0 ? rows.slice(lastMarker + 1) : rows
    for (const row of archived) row.archived = true
    for (const row of active) row.archived = false
    if (archived.length) this.appendArchive(archived)
    this.rewriteHot(active)
    const latest = rows.reduce(
      (max, row) => Math.max(max, Number(row.seq) || 0),
      0,
    )
    this.writeIndex(
      this.statsFromIndex({
        version: INDEX_VERSION,
        latest_seq: latest,
        migrated_at: nowIsoUtc8(),
        last_archive_at: archived.length
          ? archived[archived.length - 1]!.ts
          : null,
      }),
    )
  }

  private readHotRows(opts?: { assignSeq?: boolean }): Row[] {
    const rows: Row[] = []
    let latest = 0
    let text: string
    try {
      text = readFileSync(this.historyFile, 'utf8')
    } catch {
      return []
    }
    for (let line of text.split('\n')) {
      line = line.trim()
      if (!line) continue
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      const r = row as Row
      if (opts?.assignSeq && typeof r.seq !== 'number') {
        latest += 1
        r.seq = latest
      } else {
        latest = Math.max(latest, Number(r.seq) || 0)
      }
      if (r.archived === undefined) r.archived = false
      rows.push(r)
    }
    return rows
  }

  private activeRowsFromMessages(messages: Row[], hotRows: Row[]): Row[] {
    const hotBySignature = new Map<string, Row[]>()
    for (const row of hotRows) {
      const sig = HistoryLog.signature(row)
      if (!hotBySignature.has(sig)) hotBySignature.set(sig, [])
      hotBySignature.get(sig)!.push(row)
    }
    const active: Row[] = []
    let nextSeq = HistoryLog.nextSeq(hotRows) - 1
    for (const msg of messages) {
      const role = String(msg.role ?? '')
      if (role !== 'user' && role !== 'assistant') continue
      if (!('content' in msg)) continue
      const base: Row = { role, content: msg.content }
      for (const key of ['turn_id', 'attachments', 'displayContent']) {
        if (key in msg) base[key] = msg[key]
      }
      const signature = HistoryLog.signature(base)
      const existing = hotBySignature.get(signature) ?? []
      let row: Row
      if (existing.length) {
        row = { ...existing.shift()! }
        row.archived = false
      } else {
        nextSeq += 1
        row = {
          seq: nextSeq,
          ts: nowIsoUtc8(),
          archived: false,
          ...(jsonSafe(base) as Row),
        }
      }
      active.push(row)
    }
    return active
  }

  private rowsToArchive(
    hotRows: Row[],
    activeRows: Row[],
    archiveGate?: HistoryArchiveGate | null,
  ): [Row[], Row[]] {
    const activeCounts = new Map<string, number>()
    for (const row of activeRows) {
      const sig = HistoryLog.signature(row)
      activeCounts.set(sig, (activeCounts.get(sig) ?? 0) + 1)
    }
    const archived: Row[] = []
    const gatedKeep: Row[] = []
    for (const row of hotRows) {
      const sig = HistoryLog.signature(row)
      const count = activeCounts.get(sig) ?? 0
      if (count > 0) {
        activeCounts.set(sig, count - 1)
        continue
      }
      if (archiveGate && !archiveGate.canArchiveUntil(Number(row.seq) || 0)) {
        gatedKeep.push({ ...row, archived: false })
        continue
      }
      archived.push({ ...row, archived: true })
    }
    return [archived, gatedKeep]
  }

  private completedTurns(): Array<{
    turnId: string
    firstSeq: number
    lastSeq: number
  }> {
    const turns = new Map<
      string,
      {
        turnId: string
        firstSeq: number
        lastSeq: number
        hasAssistant: boolean
      }
    >()
    for (const row of this.loadActiveRows()) {
      const turnId = typeof row.turn_id === 'string' ? row.turn_id : ''
      if (!turnId) continue
      const role = String(row.role ?? '')
      if (role !== 'user' && role !== 'assistant') continue
      const seq = Number(row.seq) || 0
      if (seq <= 0) continue
      const existing = turns.get(turnId)
      if (existing) {
        existing.firstSeq = Math.min(existing.firstSeq, seq)
        existing.lastSeq = Math.max(existing.lastSeq, seq)
        if (role === 'assistant') existing.hasAssistant = true
      } else {
        turns.set(turnId, {
          turnId,
          firstSeq: seq,
          lastSeq: seq,
          hasAssistant: role === 'assistant',
        })
      }
    }
    return [...turns.values()]
      .filter((turn) => turn.hasAssistant)
      .sort((a, b) => a.lastSeq - b.lastSeq)
      .map(({ turnId, firstSeq, lastSeq }) => ({ turnId, firstSeq, lastSeq }))
  }

  private appendArchive(rows: Row[]): void {
    const grouped = new Map<string, Row[]>()
    for (const row of rows) {
      const month = HistoryLog.archiveMonth(row)
      if (!grouped.has(month)) grouped.set(month, [])
      grouped.get(month)!.push(row)
    }
    for (const [month, items] of grouped) {
      const path = join(this.archiveDir, `${month}.jsonl.gz`)
      // gzip 成员可拼接：现有 gz + 新 gz 段。对齐 Python gzip.open(at) 行为。
      const body = items
        .map((row) => JSON.stringify(jsonSafe(row)) + '\n')
        .join('')
      const chunk = gzipSync(Buffer.from(body, 'utf8'))
      if (existsSync(path)) appendFileSync(path, chunk)
      else writeFileSync(path, chunk)
    }
  }

  private rewriteHot(rows: Row[]): void {
    for (const row of rows) row.archived = false
    const tmp = join(
      this.memoryDir,
      `.${basename(this.historyFile)}.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    writeFileSync(
      tmp,
      rows.map((row) => JSON.stringify(jsonSafe(row)) + '\n').join(''),
      'utf8',
    )
    renameSync(tmp, this.historyFile)
  }

  private statsFromIndex(index: Row): Row {
    const hotRows = this.readHotRows()
    const archiveFiles = existsSync(this.archiveDir)
      ? readdirSync(this.archiveDir)
          .filter((f) => f.endsWith('.jsonl.gz'))
          .sort()
      : []
    const root = dirname(this.memoryDir)
    const archives = archiveFiles.map((f) => {
      const path = join(this.archiveDir, f)
      const st = statSync(path)
      return {
        path: relative(root, path),
        bytes: st.size,
        updated_at: nowIsoUtc8(st.mtimeMs),
      }
    })
    const hotBytes = existsSync(this.historyFile)
      ? statSync(this.historyFile).size
      : 0
    const archiveBytes = archives.reduce((sum, item) => sum + item.bytes, 0)
    return {
      version: INDEX_VERSION,
      latest_seq: Number(index.latest_seq ?? HistoryLog.nextSeq(hotRows) - 1),
      active_lines: hotRows.length,
      active_bytes: hotBytes,
      archive_files: archives.length,
      archive_bytes: archiveBytes,
      archives,
      last_archive_at: index.last_archive_at ?? null,
      migrated_at: index.migrated_at ?? null,
      hot_limit_lines: 2000,
      hot_limit_bytes: 5 * 1024 * 1024,
      needs_rotation: hotBytes > 5 * 1024 * 1024 || hotRows.length > 2000,
    }
  }

  private loadIndex(): Row {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.indexFile, 'utf8') || '{}')
    } catch {
      return {
        version: INDEX_VERSION,
        latest_seq: HistoryLog.nextSeq(this.readHotRows()) - 1,
      }
    }
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Row)
      : { version: INDEX_VERSION }
  }

  private writeIndex(index: Row): void {
    const payload = { ...index, version: INDEX_VERSION }
    const tmp = join(
      this.memoryDir,
      `.${basename(this.indexFile)}.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    writeFileSync(tmp, JSON.stringify(jsonSafe(payload), null, 2), 'utf8')
    renameSync(tmp, this.indexFile)
  }

  static signature(row: Row): string {
    const role = String(row.role ?? '')
    const turnId = String(row.turn_id ?? '')
    const content = JSON.stringify(sortKeys(jsonSafe(row.content)))
    return `${role}\\0${turnId}\\0${content}`
  }

  static nextSeq(rows: Row[]): number {
    return rows.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0) + 1
  }

  static archiveMonth(row: Row): string {
    const ts = String(row.ts ?? '')
    if (
      ts.length >= 7 &&
      ts[4] === '-' &&
      (ts[7] === undefined || ts[7] === 'T' || ts[7] === '-')
    ) {
      return ts.slice(0, 7)
    }
    return nowIsoUtc8().slice(0, 7)
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

function maxSeq(rows: Row[]): number {
  return rows.reduce(
    (max, row) => Math.max(max, Math.trunc(Number(row.seq) || 0)),
    0,
  )
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    return out
  }
  return value
}
