import {
  NODE_PERSISTENCE_ADAPTER,
  durableReplace,
  quarantineFile,
  type DurableWriteOptions,
  type PersistenceAdapter,
} from './io'
import {
  PersistenceCorruptionError,
  PersistenceIoError,
  type PersistenceReceipt,
  type SnapshotCodec,
} from './types'

export interface AtomicSnapshotOptions<T> extends DurableWriteOptions {
  readonly path: string
  readonly codec: SnapshotCodec<T>
  readonly corruptionPolicy?: 'quarantine_and_fallback' | 'quarantine_and_throw'
  corruptionBackupPath?(path: string): string
  readonly adapter?: PersistenceAdapter
}

export interface SnapshotReadResult<T> {
  readonly found: boolean
  readonly value: T
  readonly receipt: PersistenceReceipt
}

export class AtomicSnapshot<T> {
  readonly path: string
  readonly codec: SnapshotCodec<T>
  private readonly adapter: PersistenceAdapter
  private readonly fileMode: number
  private readonly directoryMode: number
  private readonly corruptionPolicy:
    'quarantine_and_fallback' | 'quarantine_and_throw'
  private readonly corruptionBackupPath?: (path: string) => string

  constructor(options: AtomicSnapshotOptions<T>) {
    this.path = options.path
    this.codec = options.codec
    this.adapter = options.adapter ?? NODE_PERSISTENCE_ADAPTER
    this.fileMode = options.fileMode ?? 0o600
    this.directoryMode = options.directoryMode ?? 0o700
    this.corruptionPolicy =
      options.corruptionPolicy ?? 'quarantine_and_fallback'
    this.corruptionBackupPath = options.corruptionBackupPath
  }

  async read(options: { fallback: T }): Promise<SnapshotReadResult<T>> {
    if (!(await this.adapter.exists(this.path)))
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
      const input = JSON.parse(
        await this.adapter.readText(this.path),
      ) as unknown
      const decoded = this.codec.decode(input)
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
        backup = await quarantineFile(
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

  async write(value: T): Promise<PersistenceReceipt> {
    let body: string
    try {
      const encoded = JSON.stringify(this.codec.encode(value), null, 2)
      if (encoded === undefined)
        throw new Error('snapshot codec did not produce a JSON document')
      body = `${encoded}\n`
    } catch (cause) {
      throw new PersistenceIoError('serialize', this.path, { cause })
    }
    await durableReplace(this.path, body, this.writeOptions())
    return this.receipt(this.codec.schemaVersion, 'none', null)
  }

  private writeOptions(): DurableWriteOptions {
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
