/**
 * `SessionLogStore`: live-session registry plus JSONL persistence
 * (ported from dsh-session `SessionStore` and dsh-session-persistence-jsonl,
 * uncompressed and without the Cordis coordinator).
 *
 * Layout: `<root>/<sessionId>/log.jsonl`. The first line is the header
 * (`{"type":"session",…}`); every later line is one event or one packed
 * chunk row. Writes are batched (write-behind, 200ms) and appended in
 * order; loading tolerates one truncated trailing line and then applies
 * crash repair so an interrupted turn is closed before anyone resumes.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { logger } from '../util/log'
import { decodeStorageRecord, packChunkRuns } from './chunk-rows'
import { interruptedTurnClosers } from './repair'
import { Session } from './session'
import {
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
} from './types'

export const LOG_FILE = 'log.jsonl'
export const DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200

export type SessionForkErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_EXISTS'
  | 'INVALID_BOUNDARY'
  | 'OPEN_TURN'

export class SessionForkError extends Error {
  constructor(
    message: string,
    readonly code: SessionForkErrorCode,
  ) {
    super(message)
    this.name = 'SessionForkError'
  }
}

/** Additional repair steps domains contribute (e.g. closing pending approvals). */
export type RepairContributor = (
  events: readonly SessionEvent[],
) => Array<Omit<SessionEvent, 'seq' | 'time'>>

interface HeaderLine extends Omit<SessionHeader, 'version' | 'id'> {
  type: 'session'
  version: number
  id: string
}

function headerLine(header: SessionHeader): HeaderLine {
  return { type: 'session', ...header }
}

function parseHeaderLine(value: unknown): SessionHeader {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { type?: unknown }).type !== 'session'
  ) {
    throw new Error('session log does not start with a header line')
  }
  const { type: _type, ...rest } = value as HeaderLine
  return rest as SessionHeader
}

interface LiveEntry {
  session: Session
  pending: SessionEvent[]
  timer: ReturnType<typeof setTimeout> | undefined
  unsubscribe: () => void
}

export interface SessionLogStoreOptions {
  /** Directory holding one sub-directory per session. */
  root: string
  /** `false` keeps sessions in memory only (tests). */
  persist?: boolean
  writeBatchMaxDelayMs?: number
  repairContributors?: RepairContributor[]
}

export class SessionLogStore {
  private readonly live = new Map<string, LiveEntry>()
  private readonly persist: boolean
  private readonly delayMs: number
  private readonly repairContributors: RepairContributor[]

  constructor(private readonly options: SessionLogStoreOptions) {
    this.persist = options.persist ?? true
    this.delayMs =
      options.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS
    this.repairContributors = options.repairContributors ?? []
  }

  get root(): string {
    return this.options.root
  }

  addRepairContributor(contributor: RepairContributor): void {
    this.repairContributors.push(contributor)
  }

  private dir(id: string): string {
    return join(this.options.root, id)
  }

  private logPath(id: string): string {
    return join(this.dir(id), LOG_FILE)
  }

  /** Whether a session exists live or on disk. */
  has(id: string): boolean {
    return this.live.has(id) || (this.persist && existsSync(this.logPath(id)))
  }

  get(id: string): Session | undefined {
    return this.live.get(id)?.session
  }

  list(): Session[] {
    return [...this.live.values()].map((entry) => entry.session)
  }

  /** Ids of every session with a log on disk. */
  listStored(): string[] {
    if (!this.persist || !existsSync(this.options.root)) return []
    return readdirSync(this.options.root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(this.options.root, entry.name, LOG_FILE)),
      )
      .map((entry) => entry.name)
  }

  /** Create a new session (optionally seeded by a fork prefix). */
  create(
    header: Omit<SessionHeader, 'version' | 'createdAt'> & {
      createdAt?: number
    },
    seed?: readonly SessionEvent[],
  ): Session {
    if (this.has(header.id))
      throw new Error(`session "${header.id}" already exists`)
    const full: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      createdAt: header.createdAt ?? Date.now(),
      ...header,
    }
    const session = new Session(full, seed ?? [], 'seed')
    if (this.persist) {
      mkdirSync(this.dir(full.id), { recursive: true })
      const lines = [
        JSON.stringify(headerLine(session.header)),
        ...packChunkRuns(session.events).map((record) =>
          JSON.stringify(record),
        ),
      ]
      writeFileSync(this.logPath(full.id), `${lines.join('\n')}\n`, {
        mode: 0o600,
      })
    }
    this.attach(session)
    return session
  }

  /**
   * Load a stored session (or return the live one). A trailing truncated
   * line is dropped; an open turn is closed by crash repair.
   */
  open(id: string): Session {
    const existing = this.get(id)
    if (existing) return existing
    if (!this.persist) throw new Error(`session "${id}" not found`)
    const path = this.logPath(id)
    if (!existsSync(path)) throw new Error(`session "${id}" not found`)
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    const first = lines.shift()
    if (first === undefined) throw new Error(`session "${id}" log is empty`)
    const header = parseHeaderLine(JSON.parse(first))
    const events: SessionEvent[] = []
    for (const [index, line] of lines.entries()) {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (error: unknown) {
        if (index === lines.length - 1) {
          logger.warn('session log: dropping truncated trailing line', {
            session: id,
          })
          break
        }
        throw new Error(
          `session "${id}" log line ${index + 2} is not JSON: ${String(error)}`,
        )
      }
      events.push(...decodeStorageRecord(value))
    }
    const session = new Session(header, events, 'restore')
    this.attach(session)
    this.repair(session)
    return session
  }

  /** Open if stored, else undefined. */
  tryOpen(id: string): Session | undefined {
    try {
      return this.has(id) ? this.open(id) : undefined
    } catch (error: unknown) {
      logger.warn('session log: failed to open', {
        session: id,
        error: String(error),
      })
      return undefined
    }
  }

  private repair(session: Session): void {
    const events = session.events
    const extra = this.repairContributors.flatMap((contributor) =>
      contributor(events),
    )
    for (const event of extra) {
      ;(
        session.append as (type: string, data: unknown, opts?: unknown) => void
      )(event.type, event.data)
    }
    for (const closer of interruptedTurnClosers(session.events)) {
      const intent =
        'surfaceOp' in closer && closer.surfaceOp !== undefined
          ? {
              surfaceOp: closer.surfaceOp,
              ...(closer.sourceEventSeqs === undefined
                ? {}
                : { sourceEventSeqs: closer.sourceEventSeqs }),
            }
          : undefined
      ;(
        session.append as (type: string, data: unknown, opts?: unknown) => void
      )(closer.type, closer.data, intent)
    }
  }

  private attach(session: Session): void {
    const entry: LiveEntry = {
      session,
      pending: [],
      timer: undefined,
      unsubscribe: () => {},
    }
    if (this.persist) {
      entry.unsubscribe = session.subscribe((_session, event) => {
        entry.pending.push(event)
        entry.timer ??= setTimeout(() => {
          this.flushEntry(entry)
        }, this.delayMs)
      })
    }
    this.live.set(session.id, entry)
  }

  private flushEntry(entry: LiveEntry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.pending.length === 0) return
    const batch = entry.pending
    entry.pending = []
    const text = packChunkRuns(batch)
      .map((record) => JSON.stringify(record))
      .join('\n')
    try {
      appendFileSync(this.logPath(entry.session.id), `${text}\n`, {
        mode: 0o600,
      })
    } catch (error: unknown) {
      logger.error('session log: append failed', {
        session: entry.session.id,
        error: String(error),
      })
      entry.pending = [...batch, ...entry.pending]
    }
  }

  /** Durably write every pending event of one session (or all). */
  flush(id?: string): void {
    if (id !== undefined) {
      const entry = this.live.get(id)
      if (entry) this.flushEntry(entry)
      return
    }
    for (const entry of this.live.values()) this.flushEntry(entry)
  }

  /** Flush and forget a live session (the log stays on disk). */
  close(id: string): void {
    const entry = this.live.get(id)
    if (!entry) return
    this.flushEntry(entry)
    entry.unsubscribe()
    this.live.delete(id)
  }

  /** Close and remove a session's log directory. */
  delete(id: string): void {
    const entry = this.live.get(id)
    if (entry) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.unsubscribe()
      this.live.delete(id)
    }
    if (this.persist) rmSync(this.dir(id), { recursive: true, force: true })
  }

  closeAll(): void {
    for (const id of [...this.live.keys()]) this.close(id)
  }

  /**
   * Fork a live session: copy `events[0..boundary]` as the child's seed.
   * The boundary must not fall inside an open turn.
   */
  fork(
    sourceId: string,
    childId: string,
    options: {
      boundary?: number
      origin?: 'subagent'
      delegationDepth?: number
    } = {},
  ): Session {
    if (this.has(childId))
      throw new SessionForkError(
        `session "${childId}" already exists`,
        'SESSION_ALREADY_EXISTS',
      )
    const source = this.get(sourceId)
    if (!source)
      throw new SessionForkError(
        `session "${sourceId}" not found`,
        'SESSION_NOT_FOUND',
      )
    const events = source.events
    const boundary = options.boundary ?? events.length - 1
    let seed: SessionEvent[] = []
    if (events.length > 0) {
      if (
        !Number.isSafeInteger(boundary) ||
        boundary < 0 ||
        boundary >= events.length
      ) {
        throw new SessionForkError(
          `fork boundary ${String(boundary)} does not exist in session "${sourceId}"`,
          'INVALID_BOUNDARY',
        )
      }
      const prefix = events.slice(0, boundary + 1)
      let lastTurnBoundary: SessionEvent | undefined
      for (
        let index = prefix.length - 1;
        index >= 0 && lastTurnBoundary === undefined;
        index--
      ) {
        const event = prefix[index]
        if (event?.type === 'turn/start' || event?.type === 'turn/end')
          lastTurnBoundary = event
      }
      if (lastTurnBoundary?.type === 'turn/start') {
        throw new SessionForkError(
          `fork boundary ${boundary} in session "${sourceId}" ends inside open turn ${lastTurnBoundary.data.turn}`,
          'OPEN_TURN',
        )
      }
      seed = prefix
    }
    return this.create(
      {
        id: childId,
        ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
        parentSession: source.id,
        seedLength: seed.length,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.delegationDepth === undefined
          ? {}
          : { delegationDepth: options.delegationDepth }),
      },
      seed,
    )
  }
}
