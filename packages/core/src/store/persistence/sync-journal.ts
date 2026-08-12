import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import {
  NODE_SYNC_PERSISTENCE_ADAPTER,
  durableReplaceSync,
  withPersistenceLockSync,
  type SyncDurableWriteOptions,
  type SyncPersistenceAdapter,
} from './sync-io'
import {
  PersistenceCorruptionError,
  PersistenceIoError,
  type JournalCodec,
  type JournalEntry,
  type PersistenceReceipt,
} from './types'

export interface AppendOnlyJournalSyncOptions<
  T,
> extends SyncDurableWriteOptions {
  readonly path: string
  readonly codec: JournalCodec<T>
  readonly recoveryMode?: 'strict' | 'tolerant'
  readonly adapter?: SyncPersistenceAdapter
}

export interface JournalSyncReplayResult<T> {
  readonly entries: JournalEntry<T>[]
  readonly receipt: PersistenceReceipt
}

export class AppendOnlyJournalSync<T> {
  readonly path: string
  readonly codec: JournalCodec<T>
  private readonly adapter: SyncPersistenceAdapter
  private readonly fileMode: number
  private readonly directoryMode: number
  private readonly recoveryMode: 'strict' | 'tolerant'

  constructor(options: AppendOnlyJournalSyncOptions<T>) {
    this.path = options.path
    this.codec = options.codec
    this.adapter = options.adapter ?? NODE_SYNC_PERSISTENCE_ADAPTER
    this.fileMode = options.fileMode ?? 0o600
    this.directoryMode = options.directoryMode ?? 0o700
    this.recoveryMode = options.recoveryMode ?? 'strict'
  }

  append(payload: T): JournalEntry<T> {
    return withPersistenceLockSync(
      this.path,
      () => {
        const replay = this.replayUnlocked({ repairTail: true })
        const entry = this.codec.create(
          (replay.entries.at(-1)?.seq ?? 0) + 1,
          payload,
        )
        const existed = this.adapter.exists(this.path)
        this.adapter.mkdir(dirname(this.path), this.directoryMode)
        this.adapter.appendAndSync(
          this.path,
          encodeSyncLines(this.path, this.codec, [entry]),
          this.fileMode,
        )
        if (!existed) this.adapter.syncDirectory(dirname(this.path))
        return entry
      },
      this.writeOptions(),
    )
  }

  /**
   * Single-owner domains may allocate their canonical sequence before append.
   * This avoids an O(n) replay and lock for high-frequency journals while the
   * caller remains responsible for serializing writers.
   */
  appendAtSequence(payload: T, sequence: number): JournalEntry<T> {
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw new PersistenceIoError('serialize', this.path, {
        cause: new Error('journal sequence must be a positive integer'),
      })
    const entry = this.codec.create(sequence, payload)
    if (entry.seq !== sequence)
      throw new PersistenceIoError('serialize', this.path, {
        cause: new Error('journal codec changed the assigned sequence'),
      })
    const existed = this.adapter.exists(this.path)
    this.adapter.mkdir(dirname(this.path), this.directoryMode)
    this.adapter.appendAndSync(
      this.path,
      encodeSyncLines(this.path, this.codec, [entry]),
      this.fileMode,
    )
    if (!existed) this.adapter.syncDirectory(dirname(this.path))
    return entry
  }

  replay(options: { repairTail?: boolean } = {}): JournalSyncReplayResult<T> {
    return withPersistenceLockSync(
      this.path,
      () => this.replayUnlocked(options),
      this.writeOptions(),
    )
  }

  retain(options: { maxRecords: number; archivePath: string }): {
    archived: number
    retained: number
  } {
    const maxRecords = Math.max(1, Math.trunc(options.maxRecords))
    return withPersistenceLockSync(
      this.path,
      () => {
        const replay = this.replayUnlocked({ repairTail: true })
        if (replay.entries.length <= maxRecords)
          return { archived: 0, retained: replay.entries.length }
        const archived = replay.entries.slice(0, -maxRecords)
        const retained = replay.entries.slice(-maxRecords)
        const archive = new AppendOnlyJournalSync({
          path: options.archivePath,
          codec: this.codec,
          adapter: this.adapter,
          fileMode: this.fileMode,
          directoryMode: this.directoryMode,
          recoveryMode: this.recoveryMode,
        })
        withPersistenceLockSync(
          options.archivePath,
          () => {
            const existing = archive.replayUnlocked({ repairTail: true })
            const expected = existing.entries.at(-1)?.seq ?? 0
            const alreadyArchived = journalSyncRangeMatches(
              existing.entries.slice(-archived.length),
              archived,
            )
            if (!alreadyArchived && archived[0]!.seq !== expected + 1)
              throw new PersistenceCorruptionError(
                options.archivePath,
                expected || null,
              )
            if (!alreadyArchived) {
              this.adapter.mkdir(
                dirname(options.archivePath),
                this.directoryMode,
              )
              this.adapter.appendAndSync(
                options.archivePath,
                encodeSyncLines(options.archivePath, this.codec, archived),
                this.fileMode,
              )
              this.adapter.syncDirectory(dirname(options.archivePath))
            }
          },
          this.writeOptions(),
        )
        durableReplaceSync(
          this.path,
          encodeSyncLines(this.path, this.codec, retained),
          this.writeOptions(),
        )
        return { archived: archived.length, retained: retained.length }
      },
      this.writeOptions(),
    )
  }

  private replayUnlocked(options: {
    repairTail?: boolean
  }): JournalSyncReplayResult<T> {
    if (!this.adapter.exists(this.path))
      return {
        entries: [],
        receipt: this.receipt(
          this.codec.schemaVersion,
          null,
          'missing_default',
          null,
        ),
      }
    const raw = this.adapter.readText(this.path)
    const endsWithNewline = raw.endsWith('\n')
    const segments = raw.split('\n')
    const entries: JournalEntry<T>[] = []
    let recoveryAction: PersistenceReceipt['recoveryAction'] = 'none'
    let corruptionBackup: string | null = null

    for (let index = 0; index < segments.length; index += 1) {
      const line = segments[index]!
      if (!line.trim()) continue
      try {
        const entry = this.codec.decode(JSON.parse(line) as unknown, {
          line: index + 1,
          expectedSeq: (entries.at(-1)?.seq ?? 0) + 1,
        })
        const previous = entries.at(-1)
        if (
          previous &&
          (this.recoveryMode === 'tolerant'
            ? entry.seq <= previous.seq
            : entry.seq !== previous.seq + 1)
        )
          throw new Error('journal sequence gap')
        entries.push(entry)
      } catch (cause) {
        const isPartialTail = index === segments.length - 1 && !endsWithNewline
        if (!isPartialTail && this.recoveryMode === 'tolerant') {
          if (!corruptionBackup) {
            corruptionBackup = `${this.path}.corrupt-${new Date()
              .toISOString()
              .replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
            durableReplaceSync(corruptionBackup, raw, this.writeOptions())
          }
          recoveryAction = 'filtered_corrupt_journal_rows'
          continue
        }
        if (!isPartialTail || !options.repairTail) {
          const backup = `${this.path}.corrupt-${new Date()
            .toISOString()
            .replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
          durableReplaceSync(backup, raw, this.writeOptions())
          throw new PersistenceCorruptionError(
            this.path,
            entries.at(-1)?.seq ?? null,
            { cause, corruptionBackup: backup },
          )
        }
        corruptionBackup = `${this.path}.corrupt-tail-${new Date()
          .toISOString()
          .replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
        durableReplaceSync(corruptionBackup, line, this.writeOptions())
        const finalNewline = raw.lastIndexOf('\n')
        durableReplaceSync(
          this.path,
          finalNewline >= 0 ? raw.slice(0, finalNewline + 1) : '',
          this.writeOptions(),
        )
        recoveryAction = 'truncated_partial_tail'
        break
      }
    }

    if (
      recoveryAction === 'filtered_corrupt_journal_rows' &&
      options.repairTail
    )
      durableReplaceSync(
        this.path,
        encodeSyncLines(this.path, this.codec, entries),
        this.writeOptions(),
      )

    return {
      entries,
      receipt: this.receipt(
        entries.at(-1)?.schemaVersion ?? this.codec.schemaVersion,
        entries.at(-1)?.seq ?? null,
        recoveryAction,
        corruptionBackup,
      ),
    }
  }

  private receipt(
    schemaVersion: number,
    lastGoodSeq: number | null,
    recoveryAction: PersistenceReceipt['recoveryAction'],
    corruptionBackup: string | null,
  ): PersistenceReceipt {
    return {
      primitive: 'journal',
      schemaVersion,
      lastGoodSeq,
      recoveryAction,
      corruptionBackup,
      durability:
        this.adapter.directorySync === 'supported'
          ? 'file_and_directory'
          : 'file_only',
    }
  }

  private writeOptions(): SyncDurableWriteOptions {
    return {
      adapter: this.adapter,
      fileMode: this.fileMode,
      directoryMode: this.directoryMode,
    }
  }
}

function encodeSyncLines<T>(
  path: string,
  codec: JournalCodec<T>,
  entries: readonly JournalEntry<T>[],
): string {
  if (entries.length === 0) return ''
  try {
    const lines = entries.map((entry) => {
      const encoded = JSON.stringify(codec.encode(entry))
      if (encoded === undefined)
        throw new Error('journal codec did not produce a JSON row')
      return encoded
    })
    return `${lines.join('\n')}\n`
  } catch (cause) {
    throw new PersistenceIoError('serialize', path, { cause })
  }
}

function journalSyncRangeMatches<T>(
  existing: readonly JournalEntry<T>[],
  candidate: readonly JournalEntry<T>[],
): boolean {
  return (
    existing.length === candidate.length &&
    existing.every(
      (entry, index) =>
        entry.seq === candidate[index]?.seq &&
        entry.checksum === candidate[index]?.checksum,
    )
  )
}
