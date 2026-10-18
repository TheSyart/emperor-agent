/**
 * `SessionLogStore`: live-session registry plus JSONL persistence
 * (ported from dsh-session `SessionStore` and dsh-session-persistence-jsonl,
 * uncompressed and without the Cordis coordinator).
 *
 * Layout: `<root>/<sessionId>/log.jsonl`. The first line is the header
 * (`{"type":"session",…}`); every later line is one event or one packed
 * chunk row. Writes are batched (write-behind, 200ms) and appended in
 * order; the events a user waits on (turn end, a question, an approval) are
 * written and synced at once. A batch is all or nothing: a failed or partial
 * write is cut back off the file, so a retry never repeats a seq.
 *
 * Opening repairs the file before crash repair closes an interrupted turn:
 * an unfinished last line is cut off and kept as `log.jsonl.tail-<ms>`; a
 * damaged line earlier keeps the readable prefix and moves the original to
 * `log.jsonl.corrupt-<ms>`. Only an unreadable header makes a session
 * unrecoverable, and then the file is left exactly as it was.
 */

import {
  closeSync,
  existsSync,
  fdatasyncSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
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
export const DEFAULT_WRITE_RETRY_DELAY_MS = 2_000

/** Events written and synced as soon as they happen: someone is waiting on them. */
const DURABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn/end',
  'question/asked',
  'approval/asked',
])

const NEWLINE = 0x0a

/** What the store tells the host about a log's health (UI notice). */
export type SessionLogState =
  | {
      sessionId: string
      state: 'repaired'
      /** `tail`: an unfinished last line; `corrupt`: a damaged earlier line. */
      kind: 'tail' | 'corrupt'
      droppedBytes: number
      /** 1-based line of the first damaged line (`corrupt` only). */
      line?: number
      backupPath: string
    }
  | { sessionId: string; state: 'unrecoverable'; reason: string }
  | {
      sessionId: string
      state: 'write_paused'
      error: string
      pendingEvents: number
    }
  | { sessionId: string; state: 'write_resumed' }

/** The file calls the append path makes (test seam). */
export interface SessionLogIo {
  openSync: typeof openSync
  closeSync: typeof closeSync
  fstatSync: typeof fstatSync
  readSync: typeof readSync
  writeSync: typeof writeSync
  ftruncateSync: typeof ftruncateSync
  fdatasyncSync: typeof fdatasyncSync
}

const NODE_IO: SessionLogIo = {
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeSync,
  ftruncateSync,
  fdatasyncSync,
}

export class SessionLogUnrecoverableError extends Error {
  readonly code = 'SESSION_LOG_UNRECOVERABLE'
  constructor(
    readonly sessionId: string,
    reason: string,
  ) {
    super(`session "${sessionId}" log cannot be read: ${reason}`)
    this.name = 'SessionLogUnrecoverableError'
  }
}

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

interface ParsedLog {
  header: SessionHeader
  events: SessionEvent[]
  /** Bytes of whole, readable lines (always ends at a newline). */
  goodBytes: number
  /** Bytes after the last newline: an append that did not finish. */
  tailBytes: number
  /** The unfinished tail is a whole record that only lacks its newline. */
  tailComplete: boolean
  /** 1-based line number of the first damaged whole line. */
  corruptLine?: number
}

function decodeLine(line: string): SessionEvent[] | undefined {
  try {
    return decodeStorageRecord(JSON.parse(line))
  } catch {
    return undefined
  }
}

/** Byte offset where 0-based line `index` starts (slow path: damage only). */
function lineStart(buffer: Buffer, index: number): number {
  let offset = 0
  for (let line = 0; line < index; line++)
    offset = buffer.indexOf(NEWLINE, offset) + 1
  return offset
}

function parseLog(id: string, buffer: Buffer): ParsedLog {
  const lines = buffer.toString('utf8').split('\n')
  const headerText = lines[0] ?? ''
  if (headerText.length === 0)
    throw new SessionLogUnrecoverableError(id, 'the log is empty')
  let header: SessionHeader
  try {
    header = parseHeaderLine(JSON.parse(headerText))
  } catch (error: unknown) {
    throw new SessionLogUnrecoverableError(
      id,
      `the header line is unreadable (${String(error)})`,
    )
  }
  if (header.id !== id)
    throw new SessionLogUnrecoverableError(id, 'session log identity changed')
  const lastNewline = buffer.lastIndexOf(NEWLINE)
  if (lastNewline === -1)
    return {
      header,
      events: [],
      goodBytes: 0,
      tailBytes: buffer.length,
      tailComplete: false,
    }
  const events: SessionEvent[] = []
  // lines[1 .. tail-1] end in a newline; lines[tail] is what follows the last one.
  const tail = lines.length - 1
  for (let index = 1; index < tail; index++) {
    const line = lines[index] as string
    if (line.length === 0) continue
    const decoded = decodeLine(line)
    if (decoded === undefined)
      return {
        header,
        events,
        goodBytes: lineStart(buffer, index),
        tailBytes: 0,
        tailComplete: false,
        corruptLine: index + 1,
      }
    events.push(...decoded)
  }
  const goodBytes = lastNewline + 1
  const rest = lines[tail] as string
  if (rest.length === 0)
    return { header, events, goodBytes, tailBytes: 0, tailComplete: false }
  const decoded = decodeLine(rest)
  if (decoded !== undefined) events.push(...decoded)
  return {
    header,
    events,
    goodBytes,
    tailBytes: buffer.length - goodBytes,
    tailComplete: decoded !== undefined,
  }
}

/** `<path>.<kind>-<ms>`, never overwriting an earlier backup. */
function backupPath(path: string, kind: 'tail' | 'corrupt'): string {
  const base = `${path}.${kind}-${Date.now()}`
  let candidate = base
  for (let n = 1; existsSync(candidate); n++) candidate = `${base}-${n}`
  return candidate
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : String(error)
}

interface LiveEntry {
  session: Session
  pending: SessionEvent[]
  timer: ReturnType<typeof setTimeout> | undefined
  unsubscribe: () => void
  /** File length after the last batch that fully reached the file. */
  bytes: number
  /** Written since the last fdatasync. */
  unsynced: boolean
  /** A sync was asked for while writes were paused. */
  wantSync: boolean
  /** The last append failed; events wait in memory for the retry. */
  paused: boolean
}

export interface SessionLogStoreOptions {
  /** Directory holding one sub-directory per session. */
  root: string
  /** `false` keeps sessions in memory only (tests). */
  persist?: boolean
  writeBatchMaxDelayMs?: number
  /** How long a failed append waits before trying again. */
  retryDelayMs?: number
  repairContributors?: RepairContributor[]
  /** Repairs, unreadable logs and paused writes (shown to the user). */
  onLogState?: (state: SessionLogState) => void
  io?: Partial<SessionLogIo>
}

export class SessionLogStore {
  private readonly live = new Map<string, LiveEntry>()
  private readonly persist: boolean
  private readonly delayMs: number
  private readonly retryDelayMs: number
  private readonly repairContributors: RepairContributor[]
  private readonly io: SessionLogIo

  constructor(private readonly options: SessionLogStoreOptions) {
    this.persist = options.persist ?? true
    this.delayMs =
      options.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_WRITE_RETRY_DELAY_MS
    this.repairContributors = options.repairContributors ?? []
    this.io = { ...NODE_IO, ...options.io }
  }

  private report(state: SessionLogState): void {
    try {
      this.options.onLogState?.(state)
    } catch (error: unknown) {
      logger.warn('session log: state listener failed', {
        error: String(error),
      })
    }
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
    let bytes = 0
    if (this.persist) {
      mkdirSync(this.dir(full.id), { recursive: true })
      const lines = [
        JSON.stringify(headerLine(session.header)),
        ...packChunkRuns(session.events).map((record) =>
          JSON.stringify(record),
        ),
      ]
      const text = Buffer.from(`${lines.join('\n')}\n`)
      writeFileSync(this.logPath(full.id), text, { mode: 0o600 })
      bytes = text.byteLength
    }
    this.attach(session, bytes)
    return session
  }

  /**
   * Load a stored session (or return the live one). The file is repaired
   * first (see the module comment); an open turn is closed by crash repair.
   */
  open(id: string): Session {
    const existing = this.get(id)
    if (existing) return existing
    const { session, bytes } = this.load(id, true)
    this.attach(session, bytes)
    this.repair(session)
    return session
  }

  /** Read durable facts without attaching, crash repair, or writing to the log. */
  readSnapshot(id: string): Session {
    const live = this.get(id)
    if (live) return live
    return this.load(id, false).session
  }

  private load(id: string, fix: boolean): { session: Session; bytes: number } {
    if (!this.persist) throw new Error(`session "${id}" not found`)
    const path = this.logPath(id)
    if (!existsSync(path)) throw new Error(`session "${id}" not found`)
    const buffer = readFileSync(path)
    let parsed: ParsedLog
    try {
      parsed = parseLog(id, buffer)
    } catch (error: unknown) {
      if (fix && error instanceof SessionLogUnrecoverableError)
        this.report({
          sessionId: id,
          state: 'unrecoverable',
          reason: error.message,
        })
      throw error
    }
    const session = new Session(parsed.header, parsed.events, 'restore')
    if (parsed.corruptLine === undefined && parsed.tailBytes === 0)
      return { session, bytes: buffer.byteLength }
    if (!fix) {
      logger.warn('session log: reading past a damaged line', {
        session: id,
        line: parsed.corruptLine ?? 'tail',
      })
      return { session, bytes: buffer.byteLength }
    }
    return { session, bytes: this.repairFile(id, path, buffer, parsed) }
  }

  /** Make the file match what was read; returns its new length. */
  private repairFile(
    id: string,
    path: string,
    buffer: Buffer,
    parsed: ParsedLog,
  ): number {
    if (parsed.corruptLine !== undefined) {
      const backup = backupPath(path, 'corrupt')
      const temp = `${path}.repair`
      writeFileSync(temp, buffer.subarray(0, parsed.goodBytes), { mode: 0o600 })
      this.syncPath(temp)
      renameSync(path, backup)
      renameSync(temp, path)
      logger.warn('session log: kept the readable prefix of a damaged log', {
        session: id,
        line: parsed.corruptLine,
        backup,
      })
      this.report({
        sessionId: id,
        state: 'repaired',
        kind: 'corrupt',
        droppedBytes: buffer.byteLength - parsed.goodBytes,
        line: parsed.corruptLine,
        backupPath: backup,
      })
      return parsed.goodBytes
    }
    const fd = this.io.openSync(path, 'r+')
    try {
      if (parsed.tailComplete) {
        // A whole record that only lost its newline: finish the line.
        this.io.writeSync(fd, Buffer.from('\n'), 0, 1, buffer.byteLength)
        this.io.fdatasyncSync(fd)
        return buffer.byteLength + 1
      }
      const backup = this.saveTail(path, buffer.subarray(parsed.goodBytes))
      this.io.ftruncateSync(fd, parsed.goodBytes)
      this.io.fdatasyncSync(fd)
      logger.warn('session log: cut off an unfinished last line', {
        session: id,
        bytes: parsed.tailBytes,
        backup,
      })
      this.report({
        sessionId: id,
        state: 'repaired',
        kind: 'tail',
        droppedBytes: parsed.tailBytes,
        backupPath: backup,
      })
      return parsed.goodBytes
    } finally {
      this.io.closeSync(fd)
    }
  }

  private saveTail(path: string, tail: Buffer): string {
    const backup = backupPath(path, 'tail')
    writeFileSync(backup, tail, { mode: 0o600 })
    return backup
  }

  private syncPath(path: string): void {
    const fd = this.io.openSync(path, 'r')
    try {
      this.io.fdatasyncSync(fd)
    } finally {
      this.io.closeSync(fd)
    }
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

  private attach(session: Session, bytes = 0): void {
    const entry: LiveEntry = {
      session,
      pending: [],
      timer: undefined,
      unsubscribe: () => {},
      bytes,
      unsynced: false,
      wantSync: false,
      paused: false,
    }
    if (this.persist) {
      entry.unsubscribe = session.subscribe((_session, event) => {
        entry.pending.push(event)
        if (DURABLE_EVENT_TYPES.has(event.type)) {
          if (!entry.paused) {
            this.flushEntry(entry, true)
            return
          }
          entry.wantSync = true
        }
        entry.timer ??= setTimeout(() => {
          this.flushEntry(entry)
        }, this.delayMs)
      })
    }
    this.live.set(session.id, entry)
  }

  private flushEntry(entry: LiveEntry, sync = false): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    const wantSync = sync || entry.wantSync
    if (entry.pending.length === 0) {
      if (wantSync && entry.unsynced) this.syncEntry(entry)
      return
    }
    const batch = entry.pending
    entry.pending = []
    const text = packChunkRuns(batch)
      .map((record) => JSON.stringify(record))
      .join('\n')
    try {
      this.append(entry, Buffer.from(`${text}\n`), wantSync)
    } catch (error: unknown) {
      entry.pending = [...batch, ...entry.pending]
      entry.wantSync = wantSync
      if (!entry.paused) {
        entry.paused = true
        logger.error('session log: append failed; holding events in memory', {
          session: entry.session.id,
          error: String(error),
        })
        this.report({
          sessionId: entry.session.id,
          state: 'write_paused',
          error: errorCode(error),
          pendingEvents: entry.pending.length,
        })
      }
      entry.timer = setTimeout(() => {
        this.flushEntry(entry)
      }, this.retryDelayMs)
      return
    }
    entry.wantSync = false
    if (entry.paused) {
      entry.paused = false
      logger.info('session log: writes resumed', { session: entry.session.id })
      this.report({ sessionId: entry.session.id, state: 'write_resumed' })
    }
  }

  /**
   * Append one whole batch or nothing: anything a failed write left behind
   * is cut off again, so the caller can retry the same batch.
   */
  private append(entry: LiveEntry, buffer: Buffer, sync: boolean): void {
    const io = this.io
    const path = this.logPath(entry.session.id)
    const fd = io.openSync(path, 'r+')
    try {
      let before = io.fstatSync(fd).size
      if (before > entry.bytes && entry.bytes > 0) {
        // Bytes past the last whole batch belong to a write that failed.
        const stray = Buffer.alloc(before - entry.bytes)
        io.readSync(fd, stray, 0, stray.byteLength, entry.bytes)
        const backup = this.saveTail(path, stray)
        io.ftruncateSync(fd, entry.bytes)
        logger.warn('session log: cut off bytes a failed write left', {
          session: entry.session.id,
          bytes: stray.byteLength,
          backup,
        })
        before = entry.bytes
      } else if (before > 0) {
        const last = Buffer.alloc(1)
        io.readSync(fd, last, 0, 1, before - 1)
        if (last[0] !== NEWLINE) {
          io.writeSync(fd, Buffer.from('\n'), 0, 1, before)
          before += 1
        }
      }
      let written = 0
      try {
        while (written < buffer.byteLength) {
          const n = io.writeSync(
            fd,
            buffer,
            written,
            buffer.byteLength - written,
            before + written,
          )
          if (n <= 0) throw new Error('session log write made no progress')
          written += n
        }
        if (sync) io.fdatasyncSync(fd)
      } catch (error: unknown) {
        try {
          io.ftruncateSync(fd, before)
        } catch {
          // The next append cuts the file back to `entry.bytes` instead.
        }
        throw error
      }
      entry.bytes = before + buffer.byteLength
      entry.unsynced = !sync
    } finally {
      io.closeSync(fd)
    }
  }

  private syncEntry(entry: LiveEntry): void {
    try {
      this.syncPath(this.logPath(entry.session.id))
      entry.unsynced = false
    } catch (error: unknown) {
      logger.warn('session log: sync failed', {
        session: entry.session.id,
        error: String(error),
      })
    }
  }

  /**
   * Write every pending event of one session (or all). `sync` also waits
   * for the disk (`fdatasync`), for app exit and other last chances.
   */
  flush(id?: string, options: { sync?: boolean } = {}): void {
    const sync = options.sync ?? false
    if (id !== undefined) {
      const entry = this.live.get(id)
      if (entry) this.flushEntry(entry, sync)
      return
    }
    for (const entry of this.live.values()) this.flushEntry(entry, sync)
  }

  /** Flush, sync and forget a live session (the log stays on disk). */
  close(id: string): void {
    const entry = this.live.get(id)
    if (!entry) return
    this.flushEntry(entry, true)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.pending.length > 0)
      logger.error('session log: closing with unwritten events', {
        session: id,
        events: entry.pending.length,
      })
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
