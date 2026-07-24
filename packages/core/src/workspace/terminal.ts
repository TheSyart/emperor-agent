import { randomUUID } from 'node:crypto'
import {
  resolveOwnedProject,
  WorkspaceOperationError,
  type ResolveWorkspaceProject,
} from './common'

export interface PtyHandle {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): () => void
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): () => void
  emitData?(data: string): void
  emitExit?(event: { exitCode: number; signal?: number }): void
}

export interface PtyHost {
  spawn(input: {
    executable: string
    args: string[]
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
  }): PtyHandle
}

export type TerminalEvent =
  | {
      type: 'output'
      sessionId: string
      terminalId: string
      seq: number
      data: string
    }
  | {
      type: 'exit'
      sessionId: string
      terminalId: string
      seq: number
      exitCode: number | null
      signal?: number
    }

export interface TerminalSummary {
  id: string
  sessionId: string
  title: string
  createdAt: number
  exited: boolean
  exitCode: number | null
}

interface TerminalRecord extends TerminalSummary {
  pid: number
  cwd: string
  handle: PtyHandle
  chunks: Array<{ seq: number; data: string }>
  bufferedBytes: number
  seq: number
  disposeData: () => void
  disposeExit: () => void
}

export interface TerminalServiceOptions {
  host: PtyHost
  resolveProject: ResolveWorkspaceProject
  shell: () => { executable: string; args: string[] }
  env: () => Record<string, string>
  emit?: (event: TerminalEvent) => void
  maxBufferedBytes?: number
  maxPerSession?: number
}

export class TerminalService {
  private readonly records = new Map<string, TerminalRecord>()
  private readonly maxBufferedBytes: number
  private readonly maxPerSession: number

  constructor(private readonly options: TerminalServiceOptions) {
    this.maxBufferedBytes = Math.max(4, options.maxBufferedBytes ?? 1024 * 1024)
    this.maxPerSession = options.maxPerSession ?? 8
  }

  list(input: { sessionId: string }): TerminalSummary[] {
    return [...this.records.values()]
      .filter((record) => record.sessionId === input.sessionId)
      .map(stripTerminal)
  }

  create(input: {
    sessionId: string
    cols: number
    rows: number
  }): TerminalSummary {
    const scope = resolveOwnedProject(
      this.options.resolveProject,
      input.sessionId,
    )
    const tabCount = [...this.records.values()].filter(
      (record) => record.sessionId === input.sessionId,
    ).length
    if (tabCount >= this.maxPerSession)
      throw new WorkspaceOperationError(
        'terminal_capacity_reached',
        `每个会话最多可同时打开 ${this.maxPerSession} 个终端。`,
      )

    const shell = this.options.shell()
    const id = `terminal_${randomUUID()}`
    const handle = this.options.host.spawn({
      executable: shell.executable,
      args: shell.args,
      cwd: scope.projectRoot,
      env: this.options.env(),
      cols: clampDimension(input.cols, 80),
      rows: clampDimension(input.rows, 24),
    })
    const record: TerminalRecord = {
      id,
      sessionId: input.sessionId,
      pid: handle.pid,
      cwd: scope.projectRoot,
      title: shell.executable.split('/').pop() || '终端',
      createdAt: Date.now(),
      exited: false,
      exitCode: null,
      handle,
      chunks: [],
      bufferedBytes: 0,
      seq: 0,
      disposeData: () => undefined,
      disposeExit: () => undefined,
    }
    this.records.set(id, record)
    try {
      record.disposeData = handle.onData((data) =>
        this.recordOutput(record, data),
      )
      record.disposeExit = handle.onExit((event) =>
        this.recordExit(record, event),
      )
    } catch (error) {
      this.records.delete(id)
      try {
        record.disposeData()
      } catch {
        // Continue teardown even when a host subscription is already invalid.
      }
      try {
        handle.kill()
      } catch {
        // The PTY may already have exited while listeners were attached.
      }
      throw error
    }
    return stripTerminal(record)
  }

  read(input: { sessionId: string; terminalId: string; afterSeq: number }): {
    terminal: TerminalSummary
    chunks: Array<{ seq: number; data: string }>
    latestSeq: number
  } {
    const record = this.owned(input.sessionId, input.terminalId)
    return {
      terminal: stripTerminal(record),
      chunks: record.chunks.filter((chunk) => chunk.seq > input.afterSeq),
      latestSeq: record.seq,
    }
  }

  write(input: { sessionId: string; terminalId: string; data: string }): void {
    const record = this.liveOwned(input.sessionId, input.terminalId)
    if (Buffer.byteLength(input.data) > 64 * 1024)
      throw new WorkspaceOperationError(
        'terminal_input_too_large',
        '单次终端输入超过限制。',
      )
    record.handle.write(input.data)
  }

  resize(input: {
    sessionId: string
    terminalId: string
    cols: number
    rows: number
  }): void {
    const record = this.liveOwned(input.sessionId, input.terminalId)
    record.handle.resize(
      clampDimension(input.cols, 80),
      clampDimension(input.rows, 24),
    )
  }

  close(input: { sessionId: string; terminalId: string }): void {
    const record = this.owned(input.sessionId, input.terminalId)
    this.records.delete(record.id)
    try {
      record.disposeData()
    } catch {
      // Closing the owner tab remains idempotent across host teardown races.
    }
    try {
      record.disposeExit()
    } catch {
      // Continue to terminate the process when listener disposal fails.
    }
    if (!record.exited)
      try {
        record.handle.kill()
      } catch {
        // A concurrent shell exit is equivalent to successful close.
      }
  }

  closeSession(sessionId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.sessionId === sessionId)
        this.close({ sessionId, terminalId: record.id })
    }
  }

  closeAll(): void {
    for (const record of [...this.records.values()])
      this.close({ sessionId: record.sessionId, terminalId: record.id })
  }

  private recordOutput(record: TerminalRecord, data: string): void {
    if (!this.records.has(record.id)) return
    const maxChunkBytes = Math.min(this.maxBufferedBytes, 32 * 1024)
    for (const dataChunk of splitUtf8(data, maxChunkBytes)) {
      record.seq += 1
      const chunk = { seq: record.seq, data: dataChunk }
      record.chunks.push(chunk)
      record.bufferedBytes += Buffer.byteLength(dataChunk)
      while (record.bufferedBytes > this.maxBufferedBytes) {
        const first = record.chunks[0]
        if (!first) break
        const before = Buffer.byteLength(first.data)
        first.data = trimUtf8Prefix(
          first.data,
          record.bufferedBytes - this.maxBufferedBytes,
        )
        const after = Buffer.byteLength(first.data)
        record.bufferedBytes -= before - after
        if (!first.data) record.chunks.shift()
      }
      this.options.emit?.({
        type: 'output',
        sessionId: record.sessionId,
        terminalId: record.id,
        seq: chunk.seq,
        data: dataChunk,
      })
    }
  }

  private recordExit(
    record: TerminalRecord,
    event: { exitCode: number; signal?: number },
  ): void {
    if (!this.records.has(record.id)) return
    record.exited = true
    record.exitCode = event.exitCode
    record.seq += 1
    this.options.emit?.({
      type: 'exit',
      sessionId: record.sessionId,
      terminalId: record.id,
      seq: record.seq,
      exitCode: event.exitCode,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    })
  }

  private owned(sessionId: string, terminalId: string): TerminalRecord {
    const record = this.records.get(terminalId)
    if (!record || record.sessionId !== sessionId)
      throw new WorkspaceOperationError(
        'terminal_owner_invalid',
        '终端不存在或不属于当前会话。',
      )
    return record
  }

  private liveOwned(sessionId: string, terminalId: string): TerminalRecord {
    const record = this.owned(sessionId, terminalId)
    if (record.exited)
      throw new WorkspaceOperationError('terminal_exited', '终端进程已结束。')
    return record
  }
}

function splitUtf8(data: string, maxBytes: number): string[] {
  if (Buffer.byteLength(data) <= maxBytes) return data ? [data] : []
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const codePoint of data) {
    const bytes = Buffer.byteLength(codePoint)
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += codePoint
    currentBytes += bytes
  }
  if (current) chunks.push(current)
  return chunks
}

function trimUtf8Prefix(data: string, minimumBytes: number): string {
  let removed = 0
  let offset = 0
  for (const codePoint of data) {
    removed += Buffer.byteLength(codePoint)
    offset += codePoint.length
    if (removed >= minimumBytes) return data.slice(offset)
  }
  return ''
}

function stripTerminal(record: TerminalRecord): TerminalSummary {
  return {
    id: record.id,
    sessionId: record.sessionId,
    title: record.title,
    createdAt: record.createdAt,
    exited: record.exited,
    exitCode: record.exitCode,
  }
}

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(2, Math.min(Math.floor(value), 1000))
}
