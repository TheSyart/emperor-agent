import { CasAggregate } from './cas'
import type { DurableWriteOptions, PersistenceAdapter } from './io'
import { PersistenceConflictError, type PersistenceReceipt } from './types'

export type LeaseIntentPhase = 'prepared' | 'applied'

export interface LeaseIntentRecord<T> {
  readonly id: string
  readonly owner: string
  readonly revision: number
  readonly phase: LeaseIntentPhase
  readonly preparedAt: number
  readonly expiresAt: number
  readonly appliedAt: number | null
  readonly payload: T
}

interface LeaseIntentDocument<T> {
  readonly intents: LeaseIntentRecord<T>[]
}

export interface LeaseIntentStoreOptions<T> extends DurableWriteOptions {
  readonly path: string
  readonly schemaVersion: number
  readonly retentionMs: number
  validatePayload(input: unknown): T
  encodePayload?(value: T): unknown
  readonly adapter?: PersistenceAdapter
}

export class LeaseIntentStore<T> {
  readonly path: string
  private readonly options: LeaseIntentStoreOptions<T>
  private readonly aggregate: CasAggregate<LeaseIntentDocument<T>>

  constructor(options: LeaseIntentStoreOptions<T>) {
    this.path = options.path
    this.options = options
    this.aggregate = new CasAggregate({
      path: options.path,
      schemaVersion: options.schemaVersion,
      initial: () => ({ intents: [] }),
      validateValue: (input) =>
        validateDocument(input, options.validatePayload),
      encodeValue: (document) => ({
        intents: document.intents.map((intent) => ({
          ...intent,
          payload: options.encodePayload?.(intent.payload) ?? intent.payload,
        })),
      }),
      isTerminal: () => false,
      adapter: options.adapter,
      fileMode: options.fileMode,
      directoryMode: options.directoryMode,
    })
  }

  async list(): Promise<LeaseIntentRecord<T>[]> {
    return (await this.inspect()).intents
  }

  async inspect(): Promise<{
    intents: LeaseIntentRecord<T>[]
    receipt: PersistenceReceipt
  }> {
    const state = await this.aggregate.read()
    return {
      intents: state.value.intents.map((intent) => ({ ...intent })),
      receipt: { ...state.receipt, primitive: 'lease_intent' },
    }
  }

  async prepare(input: {
    id: string
    owner: string
    now: number
    ttlMs: number
    payload: T
  }): Promise<LeaseIntentRecord<T>> {
    const id = requiredText(input.id, 'intent id')
    const owner = requiredText(input.owner, 'intent owner')
    const ttlMs = Math.max(1, Math.trunc(input.ttlMs))
    return await this.mutate((document) => {
      const index = document.intents.findIndex((intent) => intent.id === id)
      const existing = document.intents[index]
      if (
        existing &&
        existing.owner === owner &&
        sameValue(existing.payload, input.payload)
      )
        return { document, result: existing, changed: false }
      if (existing?.phase === 'applied')
        throw new PersistenceConflictError(
          existing.revision,
          existing.revision,
          'Applied intent is retained as an idempotency receipt.',
        )
      if (existing && existing.expiresAt > input.now)
        throw new PersistenceConflictError(
          existing.revision,
          existing.revision,
          'Lease is owned by another active intent.',
        )
      const next: LeaseIntentRecord<T> = {
        id,
        owner,
        revision: (existing?.revision ?? 0) + 1,
        phase: 'prepared',
        preparedAt: input.now,
        expiresAt: input.now + ttlMs,
        appliedAt: null,
        payload: input.payload,
      }
      const intents = [...document.intents]
      if (index >= 0) intents[index] = next
      else intents.push(next)
      return { document: { intents }, result: next, changed: true }
    })
  }

  async markApplied(input: {
    id: string
    owner: string
    now: number
  }): Promise<LeaseIntentRecord<T>> {
    const id = requiredText(input.id, 'intent id')
    const owner = requiredText(input.owner, 'intent owner')
    return await this.mutate((document) => {
      const index = document.intents.findIndex((intent) => intent.id === id)
      const existing = document.intents[index]
      if (!existing || existing.owner !== owner)
        throw new PersistenceConflictError(
          existing?.revision ?? 0,
          existing?.revision ?? 0,
          'Lease intent owner does not match.',
        )
      if (existing.phase === 'applied')
        return { document, result: existing, changed: false }
      const next: LeaseIntentRecord<T> = {
        ...existing,
        revision: existing.revision + 1,
        phase: 'applied',
        appliedAt: input.now,
      }
      const intents = [...document.intents]
      intents[index] = next
      return { document: { intents }, result: next, changed: true }
    })
  }

  async recover(input: { now: number }): Promise<{
    expiredPrepared: LeaseIntentRecord<T>[]
    prunedApplied: number
  }> {
    return await this.mutate((document) => {
      const expiredPrepared = document.intents
        .filter(
          (intent) =>
            intent.phase === 'prepared' && intent.expiresAt <= input.now,
        )
        .map((intent) => ({ ...intent }))
        .sort((left, right) => left.id.localeCompare(right.id))
      const retained = document.intents.filter(
        (intent) =>
          intent.phase !== 'applied' ||
          intent.appliedAt === null ||
          intent.appliedAt > input.now - this.options.retentionMs,
      )
      const prunedApplied = document.intents.length - retained.length
      return {
        document: { intents: retained },
        result: { expiredPrepared, prunedApplied },
        changed: prunedApplied > 0,
      }
    })
  }

  private async mutate<R>(
    project: (document: LeaseIntentDocument<T>) => {
      document: LeaseIntentDocument<T>
      result: R
      changed: boolean
    },
  ): Promise<R> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.aggregate.read()
      const projected = project(current.value)
      if (!projected.changed) return projected.result
      try {
        await this.aggregate.compareAndSwap({
          expectedRevision: current.revision,
          value: projected.document,
        })
        return projected.result
      } catch (cause) {
        if (!(cause instanceof PersistenceConflictError) || attempt === 7)
          throw cause
      }
    }
    throw new Error('unreachable lease intent mutation')
  }
}

function validateDocument<T>(
  input: unknown,
  validatePayload: (input: unknown) => T,
): LeaseIntentDocument<T> {
  if (!isRecord(input) || !Array.isArray(input.intents))
    throw new Error('invalid lease intent document')
  return {
    intents: input.intents.map((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.id !== 'string' ||
        typeof entry.owner !== 'string' ||
        !Number.isSafeInteger(entry.revision) ||
        (entry.phase !== 'prepared' && entry.phase !== 'applied') ||
        typeof entry.preparedAt !== 'number' ||
        typeof entry.expiresAt !== 'number' ||
        (entry.appliedAt !== null && typeof entry.appliedAt !== 'number')
      )
        throw new Error('invalid lease intent record')
      return {
        id: entry.id,
        owner: entry.owner,
        revision: Number(entry.revision),
        phase: entry.phase,
        preparedAt: entry.preparedAt,
        expiresAt: entry.expiresAt,
        appliedAt: entry.appliedAt,
        payload: validatePayload(entry.payload),
      }
    }),
  }
}

function requiredText(value: string, label: string): string {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
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
