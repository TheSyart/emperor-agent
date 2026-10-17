import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { durableReplaceSync } from '../../store/persistence'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  DelegationError,
  TERMINAL_RUN_PHASES,
} from '../../harness/delegation/types'
import type { DelegationState } from '../../harness/delegation/fold'

export interface DelegationHistoryEntry {
  id: string
  runId: string
  type: 'prompt' | 'text' | 'tool' | 'question' | 'permission' | 'state'
  text?: string
  toolId?: string
  name?: string
  status?: string
  requestId?: string
}
export interface DelegationHistoryPage {
  entries: DelegationHistoryEntry[]
  before: string | null
  after: string | null
  hasBefore: boolean
  hasAfter: boolean
}
export interface DelegationHistoryOptions {
  before?: string
  after?: string
  limit?: number
}
interface Position {
  offset: number
  bytes: number
  part: number
}
interface RunIndex {
  ino: number
  offset: number
  entries: Position[]
}
const PART = 4096
const MAX_PAGE = 240 * 1024
const invalid = () =>
  new DelegationError(
    'HISTORY_CURSOR_INVALID',
    'invalid or foreign history cursor',
  )
/** Rebuildable offset-only index over the normalized durable transcript. Never retains output text. */
export class DelegationHistory {
  private readonly indexes = new Map<string, RunIndex>()
  constructor(private readonly root: string) {}
  private event(path: string, position: Position): Record<string, unknown> {
    const fd = openSync(path, 'r')
    try {
      const bytes = Buffer.alloc(position.bytes)
      if (
        readSync(fd, bytes, 0, bytes.length, position.offset) !== bytes.length
      )
        throw invalid()
      return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    } finally {
      closeSync(fd)
    }
  }
  private public(
    event: Record<string, unknown>,
    id: string,
    runId: string,
  ): DelegationHistoryEntry | null {
    const str = (key: string) =>
      typeof event[key] === 'string' ? (event[key] as string) : undefined
    const bounded = (key: string) => str(key)?.slice(0, 512)
    if (event.type === 'text_delta')
      return { id, runId, type: 'text', text: str('text') ?? '' }
    if (event.type === 'tool_started' || event.type === 'tool_finished')
      return {
        id,
        runId,
        type: 'tool',
        toolId: bounded('id'),
        name: bounded('name'),
        status: bounded('status') ?? 'running',
        text: str('detail'),
      }
    if (event.type === 'question')
      return {
        id,
        runId,
        type: 'question',
        requestId: bounded('requestId'),
        text: Array.isArray(event.questions)
          ? event.questions
              .flatMap((q: unknown) => {
                if (!q || typeof q !== 'object') return []
                const question = q as Record<string, unknown>
                return [
                  typeof question.title === 'string' ? question.title : '',
                  ...(Array.isArray(question.options)
                    ? question.options
                        .filter(
                          (option): option is string =>
                            typeof option === 'string',
                        )
                        .map((option) => `- ${option}`)
                    : []),
                ]
              })
              .join('\n')
          : '',
      }
    if (event.type === 'permission_denied')
      return {
        id,
        runId,
        type: 'permission',
        requestId: bounded('requestId'),
        text: str('reason'),
      }
    return null
  }
  private index(path: string, delegationId: string, runId: string): RunIndex {
    const stat = statSync(path)
    let index = this.indexes.get(path)
    if (!index && existsSync(path + '.public-index.json')) {
      try {
        const cached = JSON.parse(
          readFileSync(path + '.public-index.json', 'utf8'),
        ) as { version: number; index: RunIndex }
        if (
          cached.version === 1 &&
          cached.index.ino === stat.ino &&
          Number.isSafeInteger(cached.index.offset) &&
          cached.index.offset >= 0 &&
          cached.index.offset <= stat.size &&
          Array.isArray(cached.index.entries) &&
          cached.index.entries.every(
            (p) =>
              Number.isSafeInteger(p.offset) &&
              p.offset >= 0 &&
              Number.isSafeInteger(p.bytes) &&
              p.bytes > 0 &&
              p.offset + p.bytes <= cached.index.offset &&
              Number.isSafeInteger(p.part) &&
              p.part >= 0,
          )
        )
          index = cached.index
      } catch {
        /* A damaged cache is rebuildable from normalized durable facts. */
      }
    }
    if (!index || index.ino !== stat.ino || index.offset > stat.size)
      index = { ino: stat.ino, offset: 0, entries: [] }
    const previousOffset = index.offset
    const fd = openSync(path, 'r')
    try {
      let cursor = index.offset,
        pending = Buffer.alloc(0)
      const chunk = Buffer.alloc(64 * 1024)
      while (cursor < stat.size) {
        const count = readSync(
          fd,
          chunk,
          0,
          Math.min(chunk.length, stat.size - cursor),
          cursor,
        )
        if (!count) break
        cursor += count
        pending = Buffer.concat([pending, chunk.subarray(0, count)])
        let newline: number
        while ((newline = pending.indexOf(10)) >= 0) {
          const bytes = newline + 1,
            offset = index.offset
          if (newline) {
            const event = JSON.parse(
              pending.subarray(0, newline).toString('utf8'),
            ) as Record<string, unknown>
            if (event.runId !== runId || event.delegationId !== delegationId)
              throw new DelegationError(
                'TRANSCRIPT_CORRUPT',
                'transcript identity changed',
              )
            const entry = this.public(event, '', runId)
            if (entry)
              for (
                let part = 0;
                part < Math.max(1, Math.ceil((entry.text?.length ?? 0) / PART));
                part++
              )
                index.entries.push({ offset, bytes, part })
          }
          index.offset += bytes
          pending = pending.subarray(bytes)
        }
        if (pending.length > 32 * 1024 * 1024)
          throw new DelegationError(
            'TRANSCRIPT_CORRUPT',
            'transcript line exceeds limit',
          )
      }
    } finally {
      closeSync(fd)
    }
    if (index.offset !== previousOffset) {
      try {
        durableReplaceSync(
          path + '.public-index.json',
          JSON.stringify({ version: 1, index }) + '\n',
        )
      } catch {
        /* Cache write failure cannot hide durable output. */
      }
    }
    this.indexes.delete(path)
    this.indexes.set(path, index)
    while (this.indexes.size > 64)
      this.indexes.delete(this.indexes.keys().next().value!)
    return index
  }
  read(
    state: DelegationState,
    options: DelegationHistoryOptions = {},
  ): DelegationHistoryPage {
    if (options.before !== undefined && options.after !== undefined)
      throw invalid()
    const owner = state.record!
    const rows: { id: string; load: () => DelegationHistoryEntry }[] = []
    let loadedEvent: { key: string; value: Record<string, unknown> } | undefined
    const readEvent = (path: string, position: Position, runId: string) => {
      const key = `${path}:${position.offset}`
      if (loadedEvent?.key !== key) {
        const value = this.event(path, position)
        if (value.delegationId !== owner.id || value.runId !== runId)
          throw new DelegationError(
            'TRANSCRIPT_CORRUPT',
            'transcript identity changed',
          )
        loadedEvent = { key, value }
      }
      return loadedEvent.value
    }
    for (const run of Object.values(state.runs)) {
      const prompt = state.messages[run.messageId]?.text
      if (prompt)
        for (let part = 0; part < Math.ceil(prompt.length / PART); part++) {
          const entry: DelegationHistoryEntry = {
            id: `${run.id}:prompt:${part}`,
            runId: run.id,
            type: 'prompt',
            text: prompt.slice(part * PART, (part + 1) * PART),
          }
          rows.push({ id: entry.id, load: () => entry })
        }
      const path = join(
        this.root,
        'conversations',
        owner.id,
        'runs',
        run.id + '.jsonl',
      )
      if (existsSync(path))
        for (const position of this.index(path, owner.id, run.id).entries) {
          const id = `${run.id}:${position.offset}:${position.part}`
          rows.push({
            id,
            load: () => {
              const entry = this.public(
                readEvent(path, position, run.id),
                id,
                run.id,
              )!
              return {
                ...entry,
                ...(entry.text !== undefined
                  ? {
                      text: entry.text.slice(
                        position.part * PART,
                        (position.part + 1) * PART,
                      ),
                    }
                  : {}),
              }
            },
          })
        }
      if (TERMINAL_RUN_PHASES.has(run.phase)) {
        const result = run.summary ?? run.failureCode ?? ''
        for (
          let part = 0;
          part < Math.max(1, Math.ceil(result.length / PART));
          part++
        ) {
          const entry: DelegationHistoryEntry = {
            id: `${run.id}:settled:${part}`,
            runId: run.id,
            type: 'state',
            status: run.phase,
            text: result.slice(part * PART, (part + 1) * PART),
          }
          rows.push({ id: entry.id, load: () => entry })
        }
      }
    }
    const encode = (id: string) =>
      Buffer.from(
        JSON.stringify([
          owner.id,
          id,
          createHash('sha256')
            .update(owner.id + '\0' + id)
            .digest('hex')
            .slice(0, 16),
        ]),
      ).toString('base64url')
    let anchor = -1
    const cursor = options.before ?? options.after
    if (cursor !== undefined) {
      if (cursor.length > 1024) throw invalid()
      try {
        const [delegation, id] = JSON.parse(
          Buffer.from(cursor, 'base64url').toString(),
        ) as string[]
        if (
          delegation !== owner.id ||
          typeof id !== 'string' ||
          encode(id) !== cursor
        )
          throw invalid()
        anchor = rows.findIndex((r) => r.id === id)
        if (anchor < 0 && id !== '$empty') throw invalid()
      } catch {
        throw invalid()
      }
    }
    const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? 200)))
    const forward = options.after !== undefined
    const end = options.before !== undefined ? Math.max(0, anchor) : rows.length
    const entries: DelegationHistoryEntry[] = []
    let bytes = 0,
      start = forward ? anchor + 1 : end - 1
    while (
      start >= 0 &&
      start < (forward ? rows.length : end) &&
      entries.length < limit
    ) {
      const entry = rows[start]!.load(),
        size = Buffer.byteLength(JSON.stringify(entry))
      if (bytes + size > MAX_PAGE) break
      entries.push(entry)
      bytes += size
      start += forward ? 1 : -1
    }
    if (!forward) entries.reverse()
    const first = entries.length
      ? rows.findIndex((r) => r.id === entries[0]!.id)
      : forward
        ? anchor + 1
        : end
    const last = entries.length ? first + entries.length - 1 : first - 1
    return {
      entries,
      before: entries.length
        ? encode(entries[0]!.id)
        : (cursor ?? encode('$empty')),
      after: entries.length
        ? encode(entries.at(-1)!.id)
        : (cursor ?? encode('$empty')),
      hasBefore: first > 0,
      hasAfter: last < rows.length - 1,
    }
  }
}
