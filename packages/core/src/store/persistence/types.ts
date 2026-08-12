export type PersistencePrimitive =
  'snapshot' | 'journal' | 'cas' | 'lease_intent'

export type PersistenceRecoveryAction =
  | 'none'
  | 'missing_default'
  | 'migrated_in_memory'
  | 'quarantined_corrupt_snapshot'
  | 'truncated_partial_tail'
  | 'filtered_corrupt_journal_rows'

export type PersistenceOperation =
  | 'append_sync'
  | 'directory_sync'
  | 'file_sync'
  | 'mkdir'
  | 'read'
  | 'rename'
  | 'serialize'
  | 'stat'
  | 'unlink'
  | 'write'

export interface PersistenceReceipt {
  readonly primitive: PersistencePrimitive
  readonly schemaVersion: number
  readonly lastGoodSeq: number | null
  readonly recoveryAction: PersistenceRecoveryAction
  readonly corruptionBackup: string | null
  readonly durability: 'file_and_directory' | 'file_only'
}

export interface SnapshotDecodeResult<T> {
  readonly value: T
  readonly schemaVersion: number
  readonly migrated?: boolean
}

/** Domain codecs keep business schema and legacy migration outside the kernel. */
export interface SnapshotCodec<T> {
  readonly schemaVersion: number
  encode(value: T): unknown
  decode(input: unknown): SnapshotDecodeResult<T>
}

export interface JournalEntry<T> {
  readonly schemaVersion: number
  readonly seq: number
  readonly checksum: string
  readonly payload: T
}

export interface JournalDecodeContext {
  readonly line: number
  readonly expectedSeq: number
}

/** Custom codecs may preserve an existing domain JSONL row shape. */
export interface JournalCodec<T> {
  readonly schemaVersion: number
  create(seq: number, payload: T): JournalEntry<T>
  encode(entry: JournalEntry<T>): unknown
  decode(input: unknown, context: JournalDecodeContext): JournalEntry<T>
}

export class PersistenceIoError extends Error {
  readonly code = 'persistence_io'

  constructor(
    readonly operation: PersistenceOperation,
    readonly path: string,
    options: { cause?: unknown } = {},
  ) {
    super(`Persistence ${operation} failed.`, options)
    this.name = 'PersistenceIoError'
  }
}

export class PersistenceCorruptionError extends Error {
  readonly code = 'persistence_corrupt'

  constructor(
    readonly path: string,
    readonly lastGoodSeq: number | null,
    options: { cause?: unknown; corruptionBackup?: string | null } = {},
  ) {
    super('Persistence data is corrupt.', options)
    this.name = 'PersistenceCorruptionError'
    this.corruptionBackup = options.corruptionBackup ?? null
  }

  readonly corruptionBackup: string | null
}

export class PersistenceConflictError extends Error {
  readonly code = 'persistence_conflict'

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
    message = 'Persistence revision conflict.',
  ) {
    super(message)
    this.name = 'PersistenceConflictError'
  }
}

export class PersistenceTerminalError extends Error {
  readonly code = 'persistence_terminal'

  constructor(readonly revision: number) {
    super('Terminal persistence state cannot transition again.')
    this.name = 'PersistenceTerminalError'
  }
}
