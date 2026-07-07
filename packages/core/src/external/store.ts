import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nowTs } from '../util/time'
import { ExternalInbound, seenKey, splitSeenKey } from './models'

export interface ExternalBridgeState {
  seen: Set<string>
  inbox: Array<Record<string, unknown>>
  pending: ExternalInbound[]
  outbox: Map<string, Record<string, unknown>>
  recentErrors: Array<Record<string, unknown>>
}

export class ExternalBridgeStore {
  readonly root: string
  readonly maxRecent: number
  readonly externalDir: string
  readonly stateFile: string

  constructor(root: string, opts: { maxRecent?: number } = {}) {
    this.root = root
    this.maxRecent = opts.maxRecent ?? 100
    this.externalDir = join(root, 'external')
    this.stateFile = join(this.externalDir, 'state.json')
    mkdirSync(this.externalDir, { recursive: true })
    this.copyLegacyStateIfNeeded()
  }

  load(): ExternalBridgeState {
    if (!existsSync(this.stateFile)) return emptyState()
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.stateFile, 'utf8') || '{}')
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('external state root must be an object')
    } catch {
      this.preserveCorruptState()
      return emptyState()
    }
    const obj = raw as Record<string, unknown>
    const seen = new Set<string>()
    for (const item of Array.isArray(obj.seen) ? obj.seen : []) {
      if (Array.isArray(item) && item.length === 2 && item[0] && item[1]) seen.add(seenKey(String(item[0]), String(item[1])))
    }
    const inbox = trimRecent((Array.isArray(obj.inbox) ? obj.inbox : []).filter(isRecord), this.maxRecent)
    const pending = trimRecent((Array.isArray(obj.pending) ? obj.pending : []).filter(isRecord).map((item) => ExternalInbound.fromDict(item)), this.maxRecent)
    const outbox = new Map<string, Record<string, unknown>>()
    for (const item of Array.isArray(obj.outbox) ? obj.outbox : []) {
      if (!isRecord(item)) continue
      const message = isRecord(item.message) ? item.message : {}
      const messageId = String(message.id ?? '')
      if (messageId) outbox.set(messageId, item)
    }
    const recentErrors = trimRecent((Array.isArray(obj.recentErrors) ? obj.recentErrors : []).filter(isRecord), this.maxRecent)
    return { seen, inbox, pending, outbox, recentErrors }
  }

  save(state: {
    seen: Set<string>
    inbox: Array<Record<string, unknown>>
    pending: ExternalInbound[]
    outbox: Map<string, Record<string, unknown>>
    recentErrors: Array<Record<string, unknown>>
  }): void {
    const payload = {
      version: 1,
      updatedAt: nowTs(),
      seen: [...state.seen].map(splitSeenKey).filter((item) => item[0] && item[1]).sort(),
      inbox: trimRecent(state.inbox, this.maxRecent),
      pending: trimRecent(state.pending, this.maxRecent).map((message) => message.toDict()),
      outbox: trimRecent([...state.outbox.values()], this.maxRecent),
      recentErrors: trimRecent(state.recentErrors, this.maxRecent),
    }
    mkdirSync(this.externalDir, { recursive: true })
    const tmp = join(this.externalDir, `.${randomUUID().replace(/-/g, '')}.state.json.tmp`)
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      renameSync(tmp, this.stateFile)
    } catch (error) {
      try { unlinkSync(tmp) } catch {}
      throw error
    }
  }

  diagnostics(): Record<string, unknown> {
    const backups = existsSync(this.externalDir)
      ? readdirSync(this.externalDir).filter((name) => name.startsWith('state.json.corrupt-')).sort().reverse().slice(0, 10)
      : []
    return {
      path: this.stateFile,
      exists: existsSync(this.stateFile),
      bytes: existsSync(this.stateFile) ? statSync(this.stateFile).size : 0,
      corruptBackups: backups.map((name) => {
        const path = join(this.externalDir, name)
        const st = statSync(path)
        return { path, bytes: st.size, updatedAt: st.mtimeMs / 1000 }
      }),
    }
  }

  private preserveCorruptState(): void {
    if (!existsSync(this.stateFile)) return
    const backup = join(this.externalDir, `state.json.corrupt-${Math.floor(nowTs())}-${randomUUID().replace(/-/g, '').slice(0, 8)}`)
    try { renameSync(this.stateFile, backup) } catch {}
  }

  private copyLegacyStateIfNeeded(): void {
    const legacy = join(this.root, 'memory', 'external', 'state.json')
    if (existsSync(this.stateFile) || !existsSync(legacy)) return
    try { copyFileSync(legacy, this.stateFile) } catch { /* non-destructive best effort */ }
  }
}

function emptyState(): ExternalBridgeState {
  return { seen: new Set(), inbox: [], pending: [], outbox: new Map(), recentErrors: [] }
}

function trimRecent<T>(items: T[], max: number): T[] {
  return items.slice(Math.max(0, items.length - max))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
