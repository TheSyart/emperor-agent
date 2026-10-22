import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  AppendOnlyJournalSync,
  NODE_SYNC_PERSISTENCE_ADAPTER,
  durableReplaceSync,
  withPersistenceLockSync,
  type JournalCodec,
  type JournalEntry,
  type SyncPersistenceAdapter,
} from '../../store/persistence'
import { DelegationError } from './types'
import {
  DelegationFold,
  messageDigest,
  safeDelegationKey,
  type DelegationEvent,
  type DelegationState,
} from './fold'
function checksum(seq: number, payload: DelegationEvent): string {
  return createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, seq, payload }))
    .digest('hex')
}
const codec: JournalCodec<DelegationEvent> = {
  schemaVersion: 1,
  create(seq, payload) {
    return { schemaVersion: 1, seq, payload, checksum: checksum(seq, payload) }
  },
  encode(entry) {
    return entry
  },
  decode(input, context) {
    const e = input as JournalEntry<DelegationEvent>
    if (
      !e ||
      e.schemaVersion !== 1 ||
      e.seq !== context.expectedSeq ||
      !e.payload ||
      typeof e.payload.type !== 'string' ||
      e.checksum !== checksum(e.seq, e.payload)
    )
      throw new Error('unsupported or corrupt delegation event')
    return e
  },
}
/** The file as last read or written by this instance. */
interface JournalCache {
  size: number
  mtimeMs: number
  fold: DelegationFold
  /** Bytes of journal entries per run (and `control`), for the 8 MiB limit. */
  sizes: Map<string, number>
}
const entryScope = (e: DelegationEvent) =>
  'runId' in e ? e.runId : e.type === 'run-created' ? e.run.id : 'control'
/** State as compared for "did this event change anything" (AGT-04). */
const comparable = (state: DelegationState) =>
  JSON.stringify({ ...state, lastSeq: 0 })
/**
 * One external conversation's control journal. State is folded in memory
 * and re-read only when the file changed underneath (another instance, a
 * repaired tail); an event that would not change the state is not appended
 * (AGT-04, SUB-15).
 */
export class DelegationJournal {
  readonly path: string
  readonly snapshotPath: string
  private readonly adapter: SyncPersistenceAdapter
  private readonly storage: AppendOnlyJournalSync<DelegationEvent>
  private cache?: JournalCache
  constructor(
    readonly root: string,
    readonly id: string,
    options: { adapter?: SyncPersistenceAdapter } = {},
  ) {
    safeDelegationKey(id)
    if (!/^dlg-[a-zA-Z0-9-]+$/.test(id))
      throw new DelegationError(
        'INVALID_ID',
        'external conversation id must start with dlg-',
      )
    this.path = join(root, 'conversations', id, 'journal.jsonl')
    this.snapshotPath = join(root, 'conversations', id, 'snapshot.json')
    this.adapter = options.adapter ?? NODE_SYNC_PERSISTENCE_ADAPTER
    this.storage = new AppendOnlyJournalSync({
      path: this.path,
      codec,
      adapter: this.adapter,
      recoveryMode: 'strict',
    })
  }
  private replay(): JournalEntry<DelegationEvent>[] {
    try {
      if (
        this.adapter.exists(this.path) &&
        this.adapter.stat(this.path).size > 264 * 1024 * 1024
      )
        throw new Error('journal hard limit exceeded')
      let repairTail = true
      if (this.adapter.exists(this.path)) {
        const raw = this.adapter.readText(this.path)
        if (raw && !raw.endsWith('\n')) {
          try {
            JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1))
            repairTail = false
          } catch {
            /* only syntactically incomplete tails may be repaired */
          }
        }
      }
      const entries = this.storage.replay({ repairTail }).entries
      if (this.adapter.exists(this.path)) {
        const raw = this.adapter.readText(this.path)
        if (raw && !raw.endsWith('\n'))
          this.adapter.appendAndSync(this.path, '\n', 0o600)
      }
      return entries
    } catch (error) {
      if ((error as { code?: string }).code === 'persistence_io') throw error
      throw new DelegationError(
        'JOURNAL_CORRUPT',
        'delegation journal requires recovery; original facts retained',
      )
    }
  }
  private fileKey(): { size: number; mtimeMs: number } {
    if (!this.adapter.exists(this.path)) return { size: -1, mtimeMs: -1 }
    const stat = this.adapter.stat(this.path)
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  }
  /** The folded state, replaying the file only if it changed since. */
  private current(): JournalCache {
    const key = this.fileKey()
    if (
      this.cache &&
      this.cache.size === key.size &&
      this.cache.mtimeMs === key.mtimeMs
    )
      return this.cache
    this.cache = undefined
    const fold = new DelegationFold(),
      sizes = new Map<string, number>()
    for (const entry of this.replay()) {
      fold.apply(entry)
      const scope = entryScope(entry.payload)
      sizes.set(
        scope,
        (sizes.get(scope) ?? 0) +
          Buffer.byteLength(JSON.stringify(entry), 'utf8'),
      )
    }
    this.cache = { ...this.fileKey(), fold, sizes }
    return this.cache
  }
  load(): DelegationState {
    try {
      return this.current().fold.state
    } catch (error) {
      this.cache = undefined
      throw error
    }
  }
  async append(
    event: DelegationEvent,
    _options: { flush?: boolean } = {},
  ): Promise<{ seq: number; cacheWritten: boolean; changed: boolean }> {
    return withPersistenceLockSync(
      this.path + '.owner',
      () => {
        let cache: JournalCache
        try {
          cache = this.current()
        } catch (error) {
          this.cache = undefined
          throw error
        }
        const current = cache.fold.state
        if (
          event.type === 'message-enqueued' &&
          current.messages[event.message.id]
        ) {
          const previous = current.messages[event.message.id]!
          if (messageDigest(previous) !== messageDigest(event.message))
            throw new DelegationError(
              'IDEMPOTENCY_CONFLICT',
              'message id has different content',
            )
          return { seq: previous.seq!, cacheWritten: true, changed: false }
        }
        const encoded = codec.create(current.lastSeq + 1, event)
        // Validate on a copy: a rejected event leaves the cache untouched.
        const trial = new DelegationFold()
        trial.restore(current)
        const next = trial.apply(encoded)
        if (comparable(next) === comparable(current))
          return { seq: current.lastSeq, cacheWritten: true, changed: false }
        const scope = entryScope(event),
          bytes = Buffer.byteLength(JSON.stringify(encoded), 'utf8'),
          size = (cache.sizes.get(scope) ?? 0) + bytes
        if (size > 8 * 1024 * 1024)
          throw new DelegationError(
            'OUTPUT_LIMIT',
            'delegation control journal limit exceeded',
          )
        try {
          this.storage.appendAtSequence(event, encoded.seq)
        } catch (error) {
          this.cache = undefined
          throw error
        }
        cache.fold = trial
        cache.sizes.set(scope, size)
        Object.assign(cache, this.fileKey())
        let cacheWritten = true
        try {
          durableReplaceSync(
            this.snapshotPath,
            JSON.stringify({
              schemaVersion: 1,
              lastSeq: next.lastSeq,
              state: next,
            }) + '\n',
            { adapter: this.adapter },
          )
        } catch {
          cacheWritten = false
        } // The cache is reconstructible; the journal append is already durable.
        return { seq: encoded.seq, cacheWritten, changed: true }
      },
      { adapter: this.adapter },
    )
  }
}
