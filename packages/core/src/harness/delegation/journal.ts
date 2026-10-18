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
export class DelegationJournal {
  readonly path: string
  readonly snapshotPath: string
  private readonly adapter: SyncPersistenceAdapter
  private readonly storage: AppendOnlyJournalSync<DelegationEvent>
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
  load(): DelegationState {
    return withPersistenceLockSync(
      this.path + '.owner',
      () => {
        const fold = new DelegationFold()
        for (const entry of this.replay()) fold.apply(entry)
        return fold.state
      },
      { adapter: this.adapter },
    )
  }
  async append(
    event: DelegationEvent,
    _options: { flush?: boolean } = {},
  ): Promise<{ seq: number; cacheWritten: boolean }> {
    return withPersistenceLockSync(
      this.path + '.owner',
      () => {
        const entries = this.replay(),
          fold = new DelegationFold()
        for (const entry of entries) fold.apply(entry)
        const current = fold.state
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
          return { seq: previous.seq!, cacheWritten: true }
        }
        const encoded = codec.create(current.lastSeq + 1, event)
        const scope = (e: DelegationEvent) =>
          'runId' in e
            ? e.runId
            : e.type === 'run-created'
              ? e.run.id
              : 'control'
        const size =
          entries
            .filter((e) => scope(e.payload) === scope(event))
            .reduce(
              (n, e) => n + Buffer.byteLength(JSON.stringify(e), 'utf8'),
              0,
            ) + Buffer.byteLength(JSON.stringify(encoded), 'utf8')
        if (size > 8 * 1024 * 1024)
          throw new DelegationError(
            'OUTPUT_LIMIT',
            'delegation control journal limit exceeded',
          )
        const next = fold.apply(encoded)
        this.storage.appendAtSequence(event, encoded.seq)
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
        return { seq: encoded.seq, cacheWritten }
      },
      { adapter: this.adapter },
    )
  }
}
