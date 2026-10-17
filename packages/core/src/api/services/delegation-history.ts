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
  messageId?: string
  /** Legacy journals have instruction order but no position among output bytes. */
  chronology?: 'recorded' | 'unknown'
}
export interface DelegationHistoryPage {
  entries: DelegationHistoryEntry[]
  /** Public transcript unavailable; journal prompts/results may still be trustworthy. */
  unavailable?: {
    runId: string
    reason: 'missing_public_log' | 'corrupt_public_log'
  }[]
  unavailableCount?: number
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
  messageId?: string
  offset: number
  bytes: number
  part: number
}
interface RunIndex {
  mtimeMs: number
  ino: number
  offset: number
  entries: Position[]
}
const PART = 4096
const MAX_PAGE = 240 * 1024
// One control-journal event is bounded below 8 MiB (at most 2048 text
// pieces). Reserve a larger range so every journal-sequence/part pair has
// its own durable frontier without acknowledging undisplayed pieces.
const CONTROL_PART_STRIDE = 8192
const invalid = () =>
  new DelegationError(
    'HISTORY_CURSOR_INVALID',
    'invalid or foreign history cursor',
  )
/** Rebuildable offset-only index over the normalized durable transcript. Never retains output text. */
export class DelegationHistory {
  private readonly indexes = new Map<string, RunIndex>()
  constructor(private readonly root: string) {}
  private parse(bytes: string): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(bytes)
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('not an event')
      return value as Record<string, unknown>
    } catch {
      throw new DelegationError(
        'TRANSCRIPT_CORRUPT',
        'invalid normalized event',
      )
    }
  }
  private event(path: string, position: Position): Record<string, unknown> {
    const fd = openSync(path, 'r')
    try {
      const bytes = Buffer.alloc(position.bytes)
      if (
        readSync(fd, bytes, 0, bytes.length, position.offset) !== bytes.length
      )
        throw invalid()
      return this.parse(bytes.toString('utf8'))
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
    if (event.type === 'public_prompt') {
      if (!bounded('messageId')) return null
      return {
        id,
        runId,
        type: 'prompt',
        messageId: bounded('messageId'),
        status: 'accepted',
        chronology: 'recorded',
        text: str('text') ?? '',
      }
    }
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
          cached.version === 3 &&
          cached.index.ino === stat.ino &&
          (cached.index.offset < stat.size ||
            cached.index.mtimeMs === stat.mtimeMs) &&
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
    if (
      !index ||
      index.ino !== stat.ino ||
      index.offset > stat.size ||
      (index.offset === stat.size && index.mtimeMs !== stat.mtimeMs)
    )
      index = { ino: stat.ino, mtimeMs: stat.mtimeMs, offset: 0, entries: [] }
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
            const event = this.parse(
              pending.subarray(0, newline).toString('utf8'),
            )
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
                index.entries.push({
                  offset,
                  bytes,
                  part,
                  ...(event.type === 'public_prompt' &&
                  typeof event.messageId === 'string'
                    ? { messageId: event.messageId }
                    : {}),
                })
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
    index.mtimeMs = stat.mtimeMs
    if (index.offset !== previousOffset) {
      try {
        durableReplaceSync(
          path + '.public-index.json',
          JSON.stringify({ version: 3, index }) + '\n',
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
    const unavailable: NonNullable<DelegationHistoryPage['unavailable']> = []
    const unavailableRunIds = new Set<string>()
    let unavailableCount = 0,
      diagnosticBytes = 0
    const unavailableRun = (
      issue: NonNullable<DelegationHistoryPage['unavailable']>[number],
    ) => {
      if (unavailableRunIds.has(issue.runId)) return
      unavailableRunIds.add(issue.runId)
      unavailableCount++
      const bytes = Buffer.byteLength(JSON.stringify(issue)) + 1
      if (unavailable.length < 200 && diagnosticBytes + bytes <= 32 * 1024) {
        unavailable.push(issue)
        diagnosticBytes += bytes
      }
    }
    const rows: {
      id: string
      legacySeq?: number
      load: () => DelegationHistoryEntry
    }[] = []
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
      let runIndex: RunIndex | undefined
      if (!existsSync(path)) {
        // A completed provider turn necessarily passed through normalized events.
        // Earlier/no-output runs may legitimately have no transcript yet.
        if (
          run.phase === 'completed' ||
          existsSync(path + '.public-index.json')
        )
          unavailableRun({ runId: run.id, reason: 'missing_public_log' })
      } else {
        try {
          runIndex = this.index(path, owner.id, run.id)
          const transcriptBytes = statSync(path).size
          if (run.phase === 'completed' && transcriptBytes === 0)
            unavailableRun({ runId: run.id, reason: 'missing_public_log' })
          if (
            TERMINAL_RUN_PHASES.has(run.phase) &&
            runIndex.offset < transcriptBytes
          ) {
            unavailableRun({ runId: run.id, reason: 'corrupt_public_log' })
          }
        } catch (cause) {
          if (
            !(cause instanceof DelegationError) ||
            cause.code !== 'TRANSCRIPT_CORRUPT'
          )
            throw cause
          unavailableRun({ runId: run.id, reason: 'corrupt_public_log' })
          this.indexes.delete(path)
        }
      }
      const positionedMessages = new Set(
        runIndex?.entries.flatMap((position) =>
          position.messageId ? [position.messageId] : [],
        ) ?? [],
      )
      if (runIndex)
        for (const position of runIndex.entries) {
          const message = position.messageId
            ? state.messages[position.messageId]
            : undefined
          if (
            position.messageId &&
            (!message ||
              message.id === run.messageId ||
              message.runId !== run.id ||
              message.status !== 'accepted')
          )
            continue
          const id = `${run.id}:${position.offset}:${position.part}`
          rows.push({
            id,
            load: () => {
              const entry = this.public(
                readEvent(path, position, run.id),
                id,
                run.id,
              )!
              if (message) entry.text = message.text
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
      // Old journals can reconstruct accepted same-run corrections from send
      // intents, but cannot establish their interleaving with output bytes.
      // Keep that ambiguity explicit, with stable journal-based identities.
      for (const message of Object.values(state.messages)
        .filter(
          (message) =>
            message.id !== run.messageId &&
            message.runId === run.id &&
            message.status === 'accepted' &&
            !positionedMessages.has(message.id),
        )
        .sort(
          (a, b) =>
            (a.acceptedSeq ?? a.sendIntentSeq ?? a.seq ?? 0) -
            (b.acceptedSeq ?? b.sendIntentSeq ?? b.seq ?? 0),
        )) {
        for (
          let part = 0;
          part < Math.max(1, Math.ceil(message.text.length / PART));
          part++
        ) {
          const entry: DelegationHistoryEntry = {
            id: `${run.id}:message:${message.sendIntentSeq ?? message.seq ?? message.id}:${part}`,
            runId: run.id,
            type: 'prompt',
            messageId: message.id,
            status: 'accepted',
            chronology: 'unknown',
            text: message.text.slice(part * PART, (part + 1) * PART),
          }
          rows.push({
            id: entry.id,
            legacySeq:
              (message.acceptedSeq ??
                message.sendIntentSeq ??
                message.seq ??
                0) *
                CONTROL_PART_STRIDE +
              part +
              1,
            load: () => entry,
          })
        }
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
    // Legacy instructions form a journal-ordered lane whose placement among
    // output bytes is unknown. Carry both durable frontiers in the opaque
    // cursor, so later output cannot be inserted behind a consumed prompt.
    const sourceAt: number[] = [],
      legacyAt: number[] = []
    let source = -1,
      legacy = 0
    for (const [index, row] of rows.entries()) {
      if (row.legacySeq === undefined) source = index
      else legacy = Math.max(legacy, row.legacySeq)
      sourceAt.push(source)
      legacyAt.push(legacy)
    }
    const exact = (id: string, sourceId: string, acknowledged: number) => {
      const payload = [owner.id, id, sourceId, acknowledged]
      return Buffer.from(
        JSON.stringify([
          ...payload,
          createHash('sha256')
            .update(JSON.stringify(payload))
            .digest('hex')
            .slice(0, 16),
        ]),
      ).toString('base64url')
    }
    let anchor = -1,
      sourceAnchor = -1,
      acknowledged = 0
    const cursor = options.before ?? options.after
    if (cursor !== undefined) {
      if (cursor.length > 1024) throw invalid()
      try {
        const decoded = JSON.parse(
          Buffer.from(cursor, 'base64url').toString(),
        ) as unknown[]
        const [delegation, id] = decoded
        if (delegation !== owner.id || typeof id !== 'string') throw invalid()
        anchor = rows.findIndex((row) => row.id === id)
        const lostIds = anchor < 0 && id !== '$empty' ? [id] : []
        if (decoded.length === 3) {
          const old = Buffer.from(
            JSON.stringify([
              owner.id,
              id,
              createHash('sha256')
                .update(owner.id + '\0' + id)
                .digest('hex')
                .slice(0, 16),
            ]),
          ).toString('base64url')
          if (old !== cursor) throw invalid()
          sourceAnchor = sourceAt[anchor] ?? -1
          // Older cursors predate the public-instruction lane. Deliver any
          // retained accepted corrections they could not have acknowledged.
          acknowledged = 0
        } else {
          const sourceId = decoded[2],
            seq = decoded[3]
          if (
            decoded.length !== 5 ||
            typeof sourceId !== 'string' ||
            typeof seq !== 'number' ||
            !Number.isSafeInteger(seq) ||
            seq < 0 ||
            exact(id, sourceId, seq) !== cursor
          )
            throw invalid()
          sourceAnchor = rows.findIndex(
            (row) => row.id === sourceId && row.legacySeq === undefined,
          )
          if (sourceAnchor < 0 && sourceId !== '$empty') lostIds.push(sourceId)
          acknowledged = seq
        }
        if (lostIds.length) {
          // Only a validated, same-delegation cursor whose rows belong to
          // diagnosed unavailable runs may restart from retained journal facts.
          if (
            !lostIds.every(
              (lost) =>
                /^dgr-[^:]+:\d+:\d+$/.test(lost) &&
                unavailableRunIds.has(lost.split(':')[0]!),
            )
          )
            throw invalid()
          return this.read(state, { limit: options.limit })
        }
      } catch {
        throw invalid()
      }
    }
    const forward = options.after !== undefined
    const encode = (index: number) => {
      const sourceIndex = forward
        ? Math.max(sourceAt[index] ?? -1, sourceAnchor)
        : (sourceAt[index] ?? -1)
      return exact(
        rows[index]?.id ?? '$empty',
        rows[sourceIndex]?.id ?? '$empty',
        Math.max(legacyAt[index] ?? 0, forward ? acknowledged : 0),
      )
    }
    const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? 200)))
    const end = options.before !== undefined ? Math.max(0, anchor) : rows.length
    const entries: DelegationHistoryEntry[] = []
    const selected: number[] = []
    // Reserve the envelope/cursors and charge diagnostics to the same page budget.
    let bytes = 2048 + diagnosticBytes
    for (
      let index = forward ? 0 : end - 1;
      index >= 0 &&
      index < (forward ? rows.length : end) &&
      entries.length < limit;
      index += forward ? 1 : -1
    ) {
      const row = rows[index]!
      if (
        forward &&
        (row.legacySeq === undefined
          ? index <= sourceAnchor
          : row.legacySeq <= acknowledged)
      )
        continue
      const entry = row.load(),
        size = Buffer.byteLength(JSON.stringify(entry))
      if (bytes + size > MAX_PAGE) break
      entries.push(entry)
      selected.push(index)
      bytes += size
    }
    if (!forward) {
      entries.reverse()
      selected.reverse()
    }
    const first = selected[0] ?? (forward ? sourceAnchor + 1 : end)
    const last = selected.at(-1) ?? first - 1
    const after = entries.length
      ? encode(last)
      : (cursor ?? exact('$empty', '$empty', 0))
    // Remaining control entries can precede the source frontier; the cursor
    // acknowledges them separately instead of claiming an invented chronology.
    let hasAfter = last < rows.length - 1
    if (forward) {
      const lastSource = Math.max(sourceAt[last] ?? -1, sourceAnchor)
      const lastAcknowledged = Math.max(legacyAt[last] ?? 0, acknowledged)
      hasAfter = rows.some((row, index) =>
        row.legacySeq === undefined
          ? index > lastSource
          : row.legacySeq > lastAcknowledged,
      )
    }
    return {
      entries,
      ...(unavailableCount ? { unavailable, unavailableCount } : {}),
      before: entries.length
        ? encode(first)
        : (cursor ?? exact('$empty', '$empty', 0)),
      after,
      hasBefore: first > 0,
      hasAfter,
    }
  }
}
