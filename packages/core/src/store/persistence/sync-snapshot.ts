import {
  NODE_SYNC_PERSISTENCE_ADAPTER,
  durableReplaceSync,
  quarantineFileSync,
  type SyncDurableWriteOptions,
  type SyncPersistenceAdapter,
} from './sync-io'
import {
  PersistenceCorruptionError,
  PersistenceIoError,
  type PersistenceReceipt,
  type SnapshotCodec,
} from './types'

export interface AtomicSnapshotSyncOptions<T> extends SyncDurableWriteOptions {
  readonly path: string
  readonly codec: SnapshotCodec<T>
  readonly corruptionPolicy?: 'quarantine_and_fallback' | 'quarantine_and_throw'
  corruptionBackupPath?(path: string): string
  readonly adapter?: SyncPersistenceAdapter
}

export interface SnapshotSyncReadResult<T> {
  readonly found: boolean
  readonly value: T
  readonly receipt: PersistenceReceipt
}

export class AtomicSnapshotSync<T> {
  readonly path: string
  readonly codec: SnapshotCodec<T>
  private readonly adapter: SyncPersistenceAdapter
  private readonly fileMode: number
  private readonly directoryMode: number
  private readonly corruptionPolicy:
    'quarantine_and_fallback' | 'quarantine_and_throw'
  private readonly corruptionBackupPath?: (path: string) => string

  constructor(options: AtomicSnapshotSyncOptions<T>) {
    this.path = options.path
    this.codec = options.codec
    this.adapter = options.adapter ?? NODE_SYNC_PERSISTENCE_ADAPTER
    this.fileMode = options.fileMode ?? 0o600
    this.directoryMode = options.directoryMode ?? 0o700
    this.corruptionPolicy =
      options.corruptionPolicy ?? 'quarantine_and_fallback'
    this.corruptionBackupPath = options.corruptionBackupPath
  }

  read(options: { fallback: T }): SnapshotSyncReadResult<T> {
    if (!this.adapter.exists(this.path))
      return {
        found: false,
        value: options.fallback,
        receipt: this.receipt(
          this.codec.schemaVersion,
          'missing_default',
          null,
        ),
      }

    try {
      const decoded = this.codec.decode(
        JSON.parse(this.adapter.readText(this.path)) as unknown,
      )
      return {
        found: true,
        value: decoded.value,
        receipt: this.receipt(
          decoded.schemaVersion,
          decoded.migrated ? 'migrated_in_memory' : 'none',
          null,
        ),
      }
    } catch (cause) {
      if (cause instanceof PersistenceIoError) throw cause
      let backup: string
      try {
        backup = quarantineFileSync(
          this.path,
          this.writeOptions(),
          this.corruptionBackupPath?.(this.path),
        )
      } catch (quarantineCause) {
        throw new PersistenceCorruptionError(this.path, null, {
          cause: quarantineCause,
        })
      }
      if (this.corruptionPolicy === 'quarantine_and_throw')
        throw new PersistenceCorruptionError(this.path, null, {
          cause,
          corruptionBackup: backup,
        })
      return {
        found: false,
        value: options.fallback,
        receipt: this.receipt(
          this.codec.schemaVersion,
          'quarantined_corrupt_snapshot',
          backup,
        ),
      }
    }
  }

  write(value: T): PersistenceReceipt {
    let body: string
    try {
      const encoded = JSON.stringify(this.codec.encode(value), null, 2)
      if (encoded === undefined)
        throw new Error('snapshot codec did not produce a JSON document')
      body = `${encoded}\n`
    } catch (cause) {
      throw new PersistenceIoError('serialize', this.path, { cause })
    }
    durableReplaceSync(this.path, body, this.writeOptions())
    return this.receipt(this.codec.schemaVersion, 'none', null)
  }

  private writeOptions(): SyncDurableWriteOptions {
    return {
      adapter: this.adapter,
      fileMode: this.fileMode,
      directoryMode: this.directoryMode,
    }
  }

  private receipt(
    schemaVersion: number,
    recoveryAction: PersistenceReceipt['recoveryAction'],
    corruptionBackup: string | null,
  ): PersistenceReceipt {
    return {
      primitive: 'snapshot',
      schemaVersion,
      lastGoodSeq: null,
      recoveryAction,
      corruptionBackup,
      durability:
        this.adapter.directorySync === 'supported'
          ? 'file_and_directory'
          : 'file_only',
    }
  }
}
