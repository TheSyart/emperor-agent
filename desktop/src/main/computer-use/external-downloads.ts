/**
 * Emperor's downloads in the user's own Chrome or Edge (PLAN-CAP-001 RV-09)
 * for 设置 › 浏览器 › 下载历史记录 › Emperor 的下载. The files stay in the
 * browser's own download folder, so these rows have no file actions: they
 * say where a file came from, when, from which browser, and whether it was
 * saved, refused (and why) or interrupted. Kept in a 0600 file beside the
 * other computer use state (newest 200); a damaged file reads as empty.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ExternalDownloadState = 'completed' | 'refused' | 'interrupted'

export interface ExternalDownloadEntry {
  /** `xd_` + 12 hex digits. */
  readonly id: string
  readonly name: string
  /** Origin of the file, or of the page when the browser did not say. */
  readonly origin: string
  readonly browser: 'chrome' | 'edge'
  readonly state: ExternalDownloadState
  /** Why a refused download was refused: executable / blocked / denied. */
  readonly reason?: string
  readonly bytes: number
  /** When it was decided or ended (ms). */
  readonly time: number
}

/** One row as 下载历史记录 lists the inbox's (plus where it came from). */
export interface ExternalDownloadRow {
  readonly downloadId: string
  readonly name: string
  readonly origin: string
  readonly time: number
  readonly bytes: number
  /** Never in Emperor's inbox: no file actions. */
  readonly exists: false
  readonly browser: 'chrome' | 'edge'
  readonly state: ExternalDownloadState
  readonly reason?: string
}

const ID = /^xd_[0-9a-f]{12}$/
const LIMIT = 200
const STATES = new Set<string>(['completed', 'refused', 'interrupted'])

export function externalDownloadId(): string {
  return `xd_${randomBytes(6).toString('hex')}`
}

function valid(value: unknown): value is ExternalDownloadEntry {
  const entry = value as Partial<ExternalDownloadEntry> | null
  return Boolean(
    entry &&
    typeof entry.id === 'string' &&
    ID.test(entry.id) &&
    typeof entry.name === 'string' &&
    typeof entry.origin === 'string' &&
    (entry.browser === 'chrome' || entry.browser === 'edge') &&
    typeof entry.state === 'string' &&
    STATES.has(entry.state) &&
    (entry.reason === undefined || typeof entry.reason === 'string') &&
    Number.isSafeInteger(entry.bytes) &&
    (entry.bytes as number) >= 0 &&
    Number.isSafeInteger(entry.time) &&
    (entry.time as number) >= 0,
  )
}

export class ExternalDownloadLog {
  private entries: Map<string, ExternalDownloadEntry> | null = null

  constructor(private readonly path: string) {}

  record(entry: ExternalDownloadEntry): void {
    const entries = this.load()
    entries.delete(entry.id)
    entries.set(entry.id, {
      ...entry,
      name: entry.name.slice(0, 200),
      origin: entry.origin.slice(0, 512),
      ...(entry.reason === undefined
        ? {}
        : { reason: entry.reason.slice(0, 40) }),
    })
    while (entries.size > LIMIT) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    this.persist(entries)
  }

  /** Newest first. */
  list(): ExternalDownloadRow[] {
    return [...this.load().values()]
      .map((entry) => ({
        downloadId: entry.id,
        name: entry.name,
        origin: entry.origin,
        time: entry.time,
        bytes: entry.bytes,
        exists: false as const,
        browser: entry.browser,
        state: entry.state,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      }))
      .sort((a, b) => b.time - a.time)
  }

  private load(): Map<string, ExternalDownloadEntry> {
    if (this.entries !== null) return this.entries
    this.entries = new Map()
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as {
        version?: unknown
        entries?: unknown
      }
      if (parsed.version === 1 && Array.isArray(parsed.entries))
        for (const item of parsed.entries.slice(-LIMIT))
          if (valid(item)) this.entries.set(item.id, item)
    } catch {
      // missing or damaged: start empty
    }
    return this.entries
  }

  private persist(entries: Map<string, ExternalDownloadEntry>): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const temp = join(
        dirname(this.path),
        `.external-downloads-${randomBytes(4).toString('hex')}.tmp`,
      )
      writeFileSync(
        temp,
        JSON.stringify({ version: 1, entries: [...entries.values()] }),
        { mode: 0o600 },
      )
      renameSync(temp, this.path)
    } catch {
      // best effort: the browser keeps its own download list
    }
  }
}
