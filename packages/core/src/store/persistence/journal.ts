import { createHash, randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import {
  NODE_PERSISTENCE_ADAPTER,
  durableReplace,
  withPersistenceLock,
  type DurableWriteOptions,
  type PersistenceAdapter,
} from './io'
import {
  PersistenceCorruptionError,
  PersistenceIoError,
  type JournalCodec,
  type JournalEntry,
  type PersistenceReceipt,
} from './types'

export interface EnvelopeJournalCodecOptions<T> {
  readonly schemaVersion: number
  validatePayload(input: unknown): T
}

export function createEnvelopeJournalCodec<T>(
  options: EnvelopeJournalCodecOptions<T>,
): JournalCodec<T> {
  return {
    schemaVersion: options.schemaVersion,
    create(seq, payload) {
      return {
        schemaVersion: options.schemaVersion,
        seq,
        checksum: checksumFor(options.schemaVersion, seq, payload),
        payload,
      }
    },
    encode(entry) {
      return {
        schema_version: entry.schemaVersion,
        seq: entry.seq,
        checksum: entry.checksum,
        payload: entry.payload,
      }
    },
    decode(input) {
      if (!isRecord(input)) throw new Error('journal row must be an object')
      const schemaVersion = Number(input.schema_version)
      const seq = Number(input.seq)
      const checksum = String(input.checksum ?? '')
      if (
        !Number.isSafeInteger(schemaVersion) ||
        schemaVersion < 1 ||
        schemaVersion > options.schemaVersion ||
        !Number.isSafeInteger(seq) ||
        seq < 1 ||
        !checksum
      )
        throw new Error('invalid journal envelope')
      if (checksum !== checksumFor(schemaVersion, seq, input.payload))
        throw new Error('journal checksum mismatch')
      const payload = options.validatePayload(input.payload)
      return { schemaVersion, seq, checksum, payload }
    },
  }
}

export interface AppendOnlyJournalOptions<T> extends DurableWriteOptions {
  readonly path: string
  readonly codec: JournalCodec<T>
  readonly adapter?: PersistenceAdapter
}

export interface JournalReplayResult<T> {
  readonly entries: JournalEntry<T>[]
  readonly receipt: PersistenceReceipt
}

export class AppendOnlyJournal<T> {
  readonly path: string
  readonly codec: JournalCodec<T>
  private readonly adapter: PersistenceAdapter
  private readonly fileMode: number
  private readonly directoryMode: number

  constructor(options: AppendOnlyJournalOptions<T>) {
    this.path = options.path
    this.codec = options.codec
    this.adapter = options.adapter ?? NODE_PERSISTENCE_ADAPTER
    this.fileMode = options.fileMode ?? 0o600
    this.directoryMode = options.directoryMode ?? 0o700
  }

  async append(payload: T): Promise<JournalEntry<T>> {
    return await withPersistenceLock(
      this.path,
      async () => {
        const replay = await this.replayUnlocked({ repairTail: true })
        const entry = this.codec.create(
          (replay.entries.at(-1)?.seq ?? 0) + 1,
          payload,
        )
        await this.adapter.mkdir(dirname(this.path), this.directoryMode)
        await this.adapter.appendAndSync(
          this.path,
          encodeLines(this.path, this.codec, [entry]),
          this.fileMode,
        )
        await this.adapter.syncDirectory(dirname(this.path))
        return entry
      },
      this.writeOptions(),
    )
  }

  /**
   * Serialized domains may allocate their canonical sequence before append.
   * The caller owns writer exclusion; the journal still owns private modes,
   * fsync and first-file directory durability.
   */
  async appendAtSequence(
    payload: T,
    sequence: number,
  ): Promise<JournalEntry<T>> {
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw new PersistenceIoError('serialize', this.path, {
        cause: new Error('journal sequence must be a positive integer'),
      })
    const entry = this.codec.create(sequence, payload)
    if (entry.seq !== sequence)
      throw new PersistenceIoError('serialize', this.path, {
        cause: new Error('journal codec changed the assigned sequence'),
      })
    const existed = await this.adapter.exists(this.path)
    await this.adapter.mkdir(dirname(this.path), this.directoryMode)
    await this.adapter.appendAndSync(
      this.path,
      encodeLines(this.path, this.codec, [entry]),
      this.fileMode,
    )
    if (!existed) await this.adapter.syncDirectory(dirname(this.path))
    return entry
  }

  async replay(
    options: { repairTail?: boolean } = {},
  ): Promise<JournalReplayResult<T>> {
    return await withPersistenceLock(
      this.path,
      () => this.replayUnlocked(options),
      this.writeOptions(),
    )
  }

  async retain(options: {
    maxRecords: number
    archivePath: string
  }): Promise<{ archived: number; retained: number }> {
    const maxRecords = Math.max(1, Math.trunc(options.maxRecords))
    return await withPersistenceLock(
      this.path,
      async () => {
        const replay = await this.replayUnlocked({ repairTail: true })
        if (replay.entries.length <= maxRecords)
          return { archived: 0, retained: replay.entries.length }
        const archived = replay.entries.slice(0, -maxRecords)
        const retained = replay.entries.slice(-maxRecords)
        const archive = new AppendOnlyJournal({
          path: options.archivePath,
          codec: this.codec,
          adapter: this.adapter,
          fileMode: this.fileMode,
          directoryMode: this.directoryMode,
        })
        await withPersistenceLock(
          options.archivePath,
          async () => {
            const existing = await archive.replayUnlocked({ repairTail: true })
            const expected = existing.entries.at(-1)?.seq ?? 0
            const alreadyArchived = journalRangeMatches(
              existing.entries.slice(-archived.length),
              archived,
            )
            if (!alreadyArchived && archived[0]!.seq !== expected + 1)
              throw new PersistenceCorruptionError(
                options.archivePath,
                expected || null,
              )
            if (!alreadyArchived) {
              await this.adapter.mkdir(
                dirname(options.archivePath),
                this.directoryMode,
              )
              await this.adapter.appendAndSync(
                options.archivePath,
                encodeLines(options.archivePath, this.codec, archived),
                this.fileMode,
              )
              await this.adapter.syncDirectory(dirname(options.archivePath))
            }
          },
          this.writeOptions(),
        )
        await durableReplace(
          this.path,
          encodeLines(this.path, this.codec, retained),
          this.writeOptions(),
        )
        return { archived: archived.length, retained: retained.length }
      },
      this.writeOptions(),
    )
  }

  private async replayUnlocked(options: {
    repairTail?: boolean
  }): Promise<JournalReplayResult<T>> {
    if (!(await this.adapter.exists(this.path)))
      return {
        entries: [],
        receipt: this.receipt(
          this.codec.schemaVersion,
          null,
          'missing_default',
          null,
        ),
      }
    const raw = await this.adapter.readText(this.path)
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
        if (previous && entry.seq !== previous.seq + 1)
          throw new Error('journal sequence gap')
        entries.push(entry)
      } catch (cause) {
        const isPartialTail = index === segments.length - 1 && !endsWithNewline
        if (!isPartialTail || !options.repairTail) {
          const backup = `${this.path}.corrupt-${new Date()
            .toISOString()
            .replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
          await durableReplace(backup, raw, this.writeOptions())
          throw new PersistenceCorruptionError(
            this.path,
            entries.at(-1)?.seq ?? null,
            { cause, corruptionBackup: backup },
          )
        }
        corruptionBackup = `${this.path}.corrupt-tail-${new Date()
          .toISOString()
          .replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`
        await durableReplace(corruptionBackup, line, this.writeOptions())
        const finalNewline = raw.lastIndexOf('\n')
        await durableReplace(
          this.path,
          finalNewline >= 0 ? raw.slice(0, finalNewline + 1) : '',
          this.writeOptions(),
        )
        recoveryAction = 'truncated_partial_tail'
        break
      }
    }

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

  private writeOptions(): DurableWriteOptions {
    return {
      adapter: this.adapter,
      fileMode: this.fileMode,
      directoryMode: this.directoryMode,
    }
  }
}

function checksumFor(schemaVersion: number, seq: number, payload: unknown) {
  return createHash('sha256')
    .update(JSON.stringify({ schemaVersion, seq, payload }))
    .digest('hex')
}

function encodeLines<T>(
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

function journalRangeMatches<T>(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
