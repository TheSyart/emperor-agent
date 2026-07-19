import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { nowTs } from '../util/time'
import { ExternalInbound, seenKey } from './models'

export const EXTERNAL_BRIDGE_STATE_VERSION = 2
export type ExternalIngestStatus =
  'received' | 'accepted' | 'dispatched' | 'failed' | 'dead-letter'

export interface ExternalDedupeRecord {
  key: string
  platform: string
  external_message_id: string
  status: ExternalIngestStatus
  revision: number
  received_at: number
  updated_at: number
  expires_at: number | null
  lease_expires_at: number | null
  attempts: number
  turn_id: string | null
  last_error: string | null
}

export interface ExternalBridgeState {
  dedupeRevision: number
  dedupe: Map<string, ExternalDedupeRecord>
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
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('external state root must be an object')
    } catch {
      this.preserveCorruptState()
      return emptyState()
    }
    const obj = raw as Record<string, unknown>
    const dedupe = new Map<string, ExternalDedupeRecord>()
    let dedupeRevision = nonNegativeInteger(obj.dedupeRevision)
    for (const item of Array.isArray(obj.dedupe) ? obj.dedupe : []) {
      if (!isRecord(item)) continue
      const record = parseDedupeRecord(item)
      if (!record) continue
      dedupe.set(record.key, record)
      dedupeRevision = Math.max(dedupeRevision, record.revision)
    }
    const legacyUpdatedAt = finiteNumber(obj.updatedAt, nowTs())
    for (const item of Array.isArray(obj.seen) ? obj.seen : []) {
      if (!Array.isArray(item) || item.length !== 2 || !item[0] || !item[1])
        continue
      const platform = String(item[0])
      const externalMessageId = String(item[1])
      const key = seenKey(platform, externalMessageId)
      if (dedupe.has(key)) continue
      dedupeRevision += 1
      dedupe.set(key, {
        key,
        platform,
        external_message_id: externalMessageId,
        status: 'dispatched',
        revision: dedupeRevision,
        received_at: legacyUpdatedAt,
        updated_at: legacyUpdatedAt,
        // Legacy `seen` had no timestamp/receipt semantics. Give it a finite
        // migration lifetime; the service applies its configured TTL on load.
        expires_at: null,
        lease_expires_at: null,
        attempts: 1,
        turn_id: null,
        last_error: null,
      })
    }
    const inbox = trimRecent(
      (Array.isArray(obj.inbox) ? obj.inbox : []).filter(isRecord),
      this.maxRecent,
    )
    const pending = trimRecent(
      (Array.isArray(obj.pending) ? obj.pending : [])
        .filter(isRecord)
        .map((item) => ExternalInbound.fromDict(item)),
      this.maxRecent,
    )
    const outbox = new Map<string, Record<string, unknown>>()
    for (const item of Array.isArray(obj.outbox) ? obj.outbox : []) {
      if (!isRecord(item)) continue
      const message = isRecord(item.message) ? item.message : {}
      const messageId = String(message.id ?? '')
      if (messageId) outbox.set(messageId, item)
    }
    const recentErrors = trimRecent(
      (Array.isArray(obj.recentErrors) ? obj.recentErrors : []).filter(
        isRecord,
      ),
      this.maxRecent,
    )
    return {
      dedupeRevision,
      dedupe,
      inbox,
      pending,
      outbox,
      recentErrors,
    }
  }

  save(state: {
    dedupeRevision: number
    dedupe: Map<string, ExternalDedupeRecord>
    inbox: Array<Record<string, unknown>>
    pending: ExternalInbound[]
    outbox: Map<string, Record<string, unknown>>
    recentErrors: Array<Record<string, unknown>>
  }): void {
    const payload = {
      version: EXTERNAL_BRIDGE_STATE_VERSION,
      updatedAt: nowTs(),
      dedupeRevision: Math.max(0, Math.floor(state.dedupeRevision)),
      dedupe: [...state.dedupe.values()].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
      inbox: trimRecent(state.inbox, this.maxRecent),
      pending: trimRecent(state.pending, this.maxRecent).map((message) =>
        message.toDict(),
      ),
      outbox: trimRecent([...state.outbox.values()], this.maxRecent),
      recentErrors: trimRecent(state.recentErrors, this.maxRecent),
    }
    mkdirSync(this.externalDir, { recursive: true })
    const tmp = join(
      this.externalDir,
      `.${randomUUID().replace(/-/g, '')}.state.json.tmp`,
    )
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
      renameSync(tmp, this.stateFile)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {}
      throw error
    }
  }

  diagnostics(): Record<string, unknown> {
    const backups = existsSync(this.externalDir)
      ? readdirSync(this.externalDir)
          .filter((name) => name.startsWith('state.json.corrupt-'))
          .sort()
          .reverse()
          .slice(0, 10)
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
    const backup = join(
      this.externalDir,
      `state.json.corrupt-${Math.floor(nowTs())}-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    )
    try {
      renameSync(this.stateFile, backup)
    } catch {}
  }

  private copyLegacyStateIfNeeded(): void {
    const legacy = join(this.root, 'memory', 'external', 'state.json')
    if (existsSync(this.stateFile) || !existsSync(legacy)) return
    try {
      copyFileSync(legacy, this.stateFile)
    } catch {
      /* non-destructive best effort */
    }
  }
}

function emptyState(): ExternalBridgeState {
  return {
    dedupeRevision: 0,
    dedupe: new Map(),
    inbox: [],
    pending: [],
    outbox: new Map(),
    recentErrors: [],
  }
}

function trimRecent<T>(items: T[], max: number): T[] {
  return items.slice(Math.max(0, items.length - max))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseDedupeRecord(
  raw: Record<string, unknown>,
): ExternalDedupeRecord | null {
  const platform = String(raw.platform ?? '').trim()
  const externalMessageId = String(raw.external_message_id ?? '').trim()
  const status = String(raw.status ?? '')
  if (!platform || !externalMessageId || !isExternalIngestStatus(status))
    return null
  const key = seenKey(platform, externalMessageId)
  return {
    key,
    platform,
    external_message_id: externalMessageId,
    status,
    revision: nonNegativeInteger(raw.revision),
    received_at: finiteNumber(raw.received_at, 0),
    updated_at: finiteNumber(raw.updated_at, 0),
    expires_at: nullableFiniteNumber(raw.expires_at),
    lease_expires_at: nullableFiniteNumber(raw.lease_expires_at),
    attempts: nonNegativeInteger(raw.attempts),
    turn_id:
      raw.turn_id === undefined || raw.turn_id === null
        ? null
        : String(raw.turn_id),
    last_error:
      raw.last_error === undefined || raw.last_error === null
        ? null
        : String(raw.last_error),
  }
}

function isExternalIngestStatus(value: string): value is ExternalIngestStatus {
  return (
    value === 'received' ||
    value === 'accepted' ||
    value === 'dispatched' ||
    value === 'failed' ||
    value === 'dead-letter'
  )
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
