import {
  withPersistenceLock,
  type DurableWriteOptions,
  type PersistenceAdapter,
} from './io'
import { AtomicSnapshot } from './snapshot'
import {
  PersistenceConflictError,
  PersistenceTerminalError,
  type PersistenceReceipt,
  type SnapshotCodec,
} from './types'

export interface CasState<T> {
  readonly revision: number
  readonly terminal: boolean
  readonly value: T
}

export interface CasAggregateOptions<T> extends DurableWriteOptions {
  readonly path: string
  readonly schemaVersion: number
  readonly codec?: SnapshotCodec<CasState<T>>
  initial(): T
  validateValue(input: unknown): T
  encodeValue?(value: T): unknown
  isTerminal?(value: T): boolean
  assertTransition?(current: T, next: T): void
  readonly adapter?: PersistenceAdapter
}

export class CasAggregate<T> {
  readonly path: string
  private readonly options: CasAggregateOptions<T>
  private readonly snapshot: AtomicSnapshot<CasState<T>>

  constructor(options: CasAggregateOptions<T>) {
    this.path = options.path
    this.options = options
    this.snapshot = new AtomicSnapshot({
      path: options.path,
      codec: options.codec ?? casCodec(options),
      corruptionPolicy: 'quarantine_and_throw',
      adapter: options.adapter,
      fileMode: options.fileMode,
      directoryMode: options.directoryMode,
    })
  }

  async read(): Promise<CasState<T> & { receipt: PersistenceReceipt }> {
    const loaded = await this.snapshot.read({
      fallback: {
        revision: 0,
        terminal: false,
        value: this.options.initial(),
      },
    })
    return { ...loaded.value, receipt: { ...loaded.receipt, primitive: 'cas' } }
  }

  async compareAndSwap(input: {
    expectedRevision: number
    value: T
  }): Promise<CasState<T>> {
    return await withPersistenceLock(
      this.path,
      async () => {
        const current = await this.read()
        if (current.revision !== input.expectedRevision)
          throw new PersistenceConflictError(
            input.expectedRevision,
            current.revision,
          )
        if (current.terminal) {
          if (sameValue(current.value, input.value))
            return {
              revision: current.revision,
              terminal: current.terminal,
              value: current.value,
            }
          throw new PersistenceTerminalError(current.revision)
        }
        this.options.assertTransition?.(current.value, input.value)
        const next: CasState<T> = {
          revision: current.revision + 1,
          terminal: Boolean(this.options.isTerminal?.(input.value)),
          value: input.value,
        }
        await this.snapshot.write(next)
        return next
      },
      {
        adapter: this.options.adapter,
        fileMode: this.options.fileMode,
        directoryMode: this.options.directoryMode,
      },
    )
  }
}

function casCodec<T>(
  options: CasAggregateOptions<T>,
): SnapshotCodec<CasState<T>> {
  return {
    schemaVersion: options.schemaVersion,
    encode(state) {
      return {
        schema_version: options.schemaVersion,
        revision: state.revision,
        terminal: state.terminal,
        value: options.encodeValue?.(state.value) ?? state.value,
      }
    },
    decode(input) {
      if (!isRecord(input)) throw new Error('CAS snapshot must be an object')
      const schemaVersion = Number(input.schema_version)
      const revision = Number(input.revision)
      if (
        schemaVersion !== options.schemaVersion ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        typeof input.terminal !== 'boolean'
      )
        throw new Error('invalid CAS envelope')
      return {
        schemaVersion,
        value: {
          revision,
          terminal: input.terminal,
          value: options.validateValue(input.value),
        },
      }
    },
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return left === right
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
