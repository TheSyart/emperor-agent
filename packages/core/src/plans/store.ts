/**
 * PlanStore (MIG-CTRL-012)。对齐 Python `agent/plans/store.py`。
 * 磁盘格式: <root>/memory/plans/index.json，按 plan id 的字典；indent=2；腐坏隔离为 index.json.corrupt-*。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { planFromDict, planToDict, PlanStatus, type PlanRecord } from './models'

const TERMINAL = new Set<string>([PlanStatus.COMPLETED, PlanStatus.FAILED, PlanStatus.CANCELLED])

export class PlanStore {
  readonly root: string
  readonly planDir: string
  readonly indexFile: string
  readonly archiveDir: string
  readonly maxTerminal: number

  constructor(root: string, opts: { maxTerminal?: number } = {}) {
    this.root = resolve(root)
    this.planDir = join(this.root, 'memory', 'plans')
    this.indexFile = join(this.planDir, 'index.json')
    this.archiveDir = join(this.planDir, 'archive')
    this.maxTerminal = Math.max(1, Math.trunc(opts.maxTerminal ?? 500))
    mkdirSync(this.planDir, { recursive: true })
    if (!existsSync(this.indexFile)) this.write({})
  }

  list(): PlanRecord[] {
    const data = this.read()
    return Object.values(data)
      .filter((item) => item && typeof item === 'object')
      .map((item) => planFromDict(item as Record<string, unknown>))
  }

  get(planId: string): PlanRecord | null {
    const payload = this.read()[String(planId)]
    if (payload && typeof payload === 'object') return planFromDict(payload as Record<string, unknown>)
    return this.getArchived(String(planId))
  }

  latest(): PlanRecord | null {
    const plans = this.list()
    if (!plans.length) return null
    return plans.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
  }

  save(record: PlanRecord): void {
    const data = this.read()
    data[record.id] = planToDict(record)
    this.archiveIfNeeded(data)
    this.write(data)
  }

  /** 级联删除：仅删除带 session_id stamp 的计划；legacy 无主计划不动。 */
  deleteBySession(sessionId: string): number {
    const target = String(sessionId || '').trim()
    if (!target) return 0
    const data = this.read()
    let removed = 0
    for (const [planId, item] of Object.entries(data)) {
      if (!item || typeof item !== 'object') continue
      if (String((item as Record<string, unknown>).session_id ?? '') !== target) continue
      delete data[planId]
      removed += 1
    }
    if (removed > 0) this.write(data)
    return removed
  }

  /**
   * 审计 P1-4：index.json 此前无归档，永久累积所有计划——对齐 tasks/store.ts 已有的
   * "终态超阈值按月归档，进行中的计划永不归档" 模式，避免热索引无界增长。
   */
  private archiveIfNeeded(data: Record<string, unknown>): void {
    const terminal = Object.values(data).filter(
      (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object') && TERMINAL.has(String((item as Record<string, unknown>).status)),
    )
    if (terminal.length <= this.maxTerminal) return
    terminal.sort((a, b) => Number(a.updated_at || 0) - Number(b.updated_at || 0))
    const overflow = terminal.slice(0, terminal.length - this.maxTerminal)
    const byMonth = new Map<string, Record<string, unknown>[]>()
    for (const item of overflow) {
      const month = monthKey(item)
      if (!byMonth.has(month)) byMonth.set(month, [])
      byMonth.get(month)!.push(item)
      delete data[String(item.id)]
    }
    for (const [month, items] of byMonth) this.mergeArchive(month, items)
  }

  private mergeArchive(month: string, items: Record<string, unknown>[]): void {
    mkdirSync(this.archiveDir, { recursive: true })
    const path = join(this.archiveDir, `${month}.json`)
    const existing = existsSync(path) ? this.readAt(path) : {}
    for (const item of items) existing[String(item.id)] = item
    this.writeAt(path, existing)
  }

  private getArchived(planId: string): PlanRecord | null {
    if (!existsSync(this.archiveDir)) return null
    for (const name of readdirSync(this.archiveDir).filter((n) => n.endsWith('.json')).sort().reverse()) {
      const payload = this.readAt(join(this.archiveDir, name))[planId]
      if (payload && typeof payload === 'object') return planFromDict(payload as Record<string, unknown>)
    }
    return null
  }

  private read(): Record<string, unknown> {
    return this.readAt(this.indexFile, { onCorruptWriteEmpty: true })
  }

  private write(data: Record<string, unknown>): void {
    this.writeAt(this.indexFile, data)
  }

  private readAt(path: string, opts: { onCorruptWriteEmpty?: boolean } = {}): Record<string, unknown> {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
    } catch {
      const corrupt = `${path}.corrupt-${Math.trunc(Date.now() / 1000)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
      try { renameSync(path, corrupt) } catch { /* ignore */ }
      if (opts.onCorruptWriteEmpty) this.writeAt(path, {})
      return {}
    }
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  }

  private writeAt(path: string, data: Record<string, unknown>): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.${basename(path)}.${randomUUID().replace(/-/g, '')}.tmp`)
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  }
}

function monthKey(item: Record<string, unknown>): string {
  const ts = Number(item.updated_at || Date.now() / 1000)
  return new Date(ts * 1000).toISOString().slice(0, 7)
}
