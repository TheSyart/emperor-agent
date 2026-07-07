import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { TaskRecord } from './models'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export class TaskStore {
  readonly root: string
  readonly tasksDir: string
  readonly indexFile: string
  readonly archiveDir: string
  readonly maxTerminal: number

  constructor(root: string, opts: { maxTerminal?: number } = {}) {
    this.root = root
    this.tasksDir = join(root, 'tasks')
    this.indexFile = join(this.tasksDir, 'index.json')
    this.archiveDir = join(this.tasksDir, 'archive')
    this.maxTerminal = Math.max(1, Math.trunc(opts.maxTerminal ?? 500))
    mkdirSync(this.tasksDir, { recursive: true })
    this.copyLegacyFilesIfNeeded()
    if (!existsSync(this.indexFile)) this.write(this.indexFile, {})
  }

  list(): TaskRecord[] {
    const data = this.read(this.indexFile)
    return Object.values(data).filter(isObject).map((item) => TaskRecord.fromDict(item))
  }

  get(taskId: string): TaskRecord | null {
    const data = this.read(this.indexFile)
    const hot = data[String(taskId)]
    if (isObject(hot)) return TaskRecord.fromDict(hot)
    return this.getArchived(String(taskId))
  }

  upsert(record: TaskRecord): void {
    const data = this.read(this.indexFile)
    data[record.id] = record.toDict()
    this.archiveIfNeeded(data)
    this.write(this.indexFile, data)
  }

  /** 级联删除：仅删除带 session_id stamp 的记录及其 sidechain 目录；legacy 无主记录不动。 */
  deleteBySession(sessionId: string): number {
    const target = String(sessionId || '').trim()
    if (!target) return 0
    const data = this.read(this.indexFile)
    let removed = 0
    for (const [taskId, item] of Object.entries(data)) {
      if (!isObject(item) || String(item.session_id ?? '') !== target) continue
      delete data[taskId]
      rmSync(join(this.tasksDir, taskId), { recursive: true, force: true })
      removed += 1
    }
    if (removed > 0) this.write(this.indexFile, data)
    return removed
  }

  private archiveIfNeeded(data: Record<string, any>): void {
    const terminal = Object.values(data).filter((item) => isObject(item) && TERMINAL.has(String(item.status)))
    if (terminal.length <= this.maxTerminal) return
    terminal.sort((a, b) => Number(a.started_at || 0) - Number(b.started_at || 0))
    const overflow = terminal.slice(0, terminal.length - this.maxTerminal)
    const byMonth = new Map<string, Record<string, any>[]>()
    for (const item of overflow) {
      const month = monthKey(item)
      if (!byMonth.has(month)) byMonth.set(month, [])
      byMonth.get(month)!.push(item)
      delete data[String(item.id)]
    }
    for (const [month, items] of byMonth) this.mergeArchive(month, items)
  }

  private mergeArchive(month: string, items: Record<string, any>[]): void {
    mkdirSync(this.archiveDir, { recursive: true })
    const path = join(this.archiveDir, `${month}.json`)
    const existing = existsSync(path) ? this.read(path) : {}
    for (const item of items) existing[String(item.id)] = item
    this.write(path, existing)
  }

  private getArchived(taskId: string): TaskRecord | null {
    if (!existsSync(this.archiveDir)) return null
    for (const name of readdirSync(this.archiveDir).filter((n) => n.endsWith('.json')).sort().reverse()) {
      const payload = this.read(join(this.archiveDir, name))[taskId]
      if (isObject(payload)) return TaskRecord.fromDict(payload)
    }
    return null
  }

  private read(path: string): Record<string, any> {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
      return isObject(raw) ? raw : {}
    } catch (error) {
      if (existsSync(path)) {
        const corrupt = `${path}.corrupt-${Math.trunc(Date.now() / 1000)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
        try { renameSync(path, corrupt) } catch { /* ignore */ }
        this.write(path, {})
      }
      void error
      return {}
    }
  }

  private write(path: string, data: Record<string, any>): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.${basename(path)}.${randomUUID().replace(/-/g, '')}.tmp`)
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  }

  private copyLegacyFilesIfNeeded(): void {
    const legacyDir = join(this.root, 'memory', 'tasks')
    if (!existsSync(legacyDir)) return
    const legacyIndex = join(legacyDir, 'index.json')
    if (!existsSync(this.indexFile) && existsSync(legacyIndex)) {
      try { copyFileSync(legacyIndex, this.indexFile) } catch { /* non-destructive best effort */ }
    }
    const legacyArchive = join(legacyDir, 'archive')
    if (!existsSync(this.archiveDir) && existsSync(legacyArchive)) {
      try { cpSync(legacyArchive, this.archiveDir, { recursive: true, errorOnExist: false }) } catch { /* non-destructive best effort */ }
    }
    for (const name of readdirSync(legacyDir)) {
      if (!name || name === 'archive' || name === 'index.json') continue
      const source = join(legacyDir, name)
      const dest = join(this.tasksDir, name)
      if (existsSync(dest)) continue
      try { cpSync(source, dest, { recursive: true, errorOnExist: false }) } catch { /* non-destructive best effort */ }
    }
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function monthKey(item: Record<string, any>): string {
  const ts = Number(item.started_at || Date.now() / 1000)
  return new Date(ts * 1000).toISOString().slice(0, 7)
}
