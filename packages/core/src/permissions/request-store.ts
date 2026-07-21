import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { GoalGateMutationLedger } from '../goals/mutation-ledger'

export type PermissionRequestStatus =
  'waiting' | 'approved' | 'denied' | 'consumed' | 'cancelled'

export type PermissionRequestOutcome =
  'allow_once' | 'deny' | 'allow_and_full_access'

export interface PermissionRequestOperationRecord {
  id: string
  fingerprint: string
  toolName: string
  argumentsHash: string
  arguments?: Record<string, unknown>
  remainingUses: number
  risk: string
  rule: string
  trace: unknown[]
  explanation: unknown
}

export interface PermissionRequestRecord {
  version: 1
  id: string
  interactionId: string
  sessionId: string
  status: PermissionRequestStatus
  outcome: PermissionRequestOutcome | null
  createdAt: number
  expiresAt: number
  operations: PermissionRequestOperationRecord[]
}

interface PermissionRequestDocument {
  version: 1
  requests: PermissionRequestRecord[]
}

export type PermissionExactResult = 'allow' | 'deny' | 'miss'

const EMPTY_DOCUMENT: PermissionRequestDocument = { version: 1, requests: [] }

export class PermissionRequestStore {
  readonly file: string
  private readonly now: () => number
  private readonly mutations: GoalGateMutationLedger

  constructor(stateRoot: string, opts: { now?: () => number } = {}) {
    const root = resolve(stateRoot)
    this.file = join(root, 'control', 'permission-requests.json')
    this.now = opts.now ?? Date.now
    this.mutations = new GoalGateMutationLedger(root)
  }

  create(record: PermissionRequestRecord): PermissionRequestRecord {
    const normalized = normalizeRecord(record)
    if (!normalized.interactionId)
      throw new Error('permission interaction id is required')
    return this.mutate((document) => {
      if (document.requests.some((item) => item.id === normalized.id))
        throw new Error(`permission request already exists: ${normalized.id}`)
      document.requests.push(normalized)
      return cloneRecord(normalized)
    })
  }

  get(requestId: string): PermissionRequestRecord | null {
    const document = this.load()
    const item = document.requests.find((record) => record.id === requestId)
    return item ? cloneRecord(item) : null
  }

  cleanup(): void {
    if (!existsSync(this.file)) return
    let needsCleanup = false
    try {
      const raw = normalizeDocument(
        JSON.parse(readFileSync(this.file, 'utf8') || '{}'),
      )
      needsCleanup = raw.requests.some((record) => !this.keepOnStartup(record))
    } catch {
      this.load()
      return
    }
    if (!needsCleanup) return
    this.mutate((document) => {
      document.requests = document.requests.filter((record) =>
        this.keepOnStartup(record),
      )
      return null
    })
  }

  resolve(
    requestId: string,
    outcome: PermissionRequestOutcome,
  ): PermissionRequestRecord {
    return this.mutate((document) => {
      const record = requireRequest(document, requestId)
      if (record.status !== 'waiting') {
        if (record.outcome === outcome) return cloneRecord(record)
        throw new Error(`permission request is not waiting: ${record.status}`)
      }
      record.outcome = outcome
      record.status = outcome === 'deny' ? 'denied' : 'approved'
      return cloneRecord(record)
    })
  }

  cancel(requestId: string): PermissionRequestRecord {
    return this.mutate((document) => {
      const record = requireRequest(document, requestId)
      if (record.status === 'waiting') record.status = 'cancelled'
      return cloneRecord(record)
    })
  }

  consumeExact(
    requestId: string,
    sessionId: string,
    fingerprints: string[],
  ): PermissionExactResult {
    let result: PermissionExactResult = 'miss'
    this.mutate((document) => {
      const record = document.requests.find((item) => item.id === requestId)
      if (!record || record.sessionId !== sessionId) return null
      if (!sameFingerprintSequence(record.operations, fingerprints)) return null
      if (record.status === 'denied') {
        result = 'deny'
        return null
      }
      if (record.status !== 'approved') return null
      for (const operation of record.operations) operation.remainingUses = 0
      record.status = 'consumed'
      result = 'allow'
      return null
    })
    return result
  }

  private load(): PermissionRequestDocument {
    if (!existsSync(this.file)) return cloneDocument(EMPTY_DOCUMENT)
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8') || '{}')
      const document = normalizeDocument(parsed)
      const now = this.now()
      document.requests = document.requests.filter(
        (record) => record.expiresAt > now,
      )
      return document
    } catch {
      try {
        renameSync(
          this.file,
          `${this.file}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
        )
      } catch {
        // Fail closed even when the corrupt file cannot be isolated.
      }
      return cloneDocument(EMPTY_DOCUMENT)
    }
  }

  private keepOnStartup(record: PermissionRequestRecord): boolean {
    return (
      record.expiresAt > this.now() &&
      record.status !== 'consumed' &&
      record.status !== 'cancelled' &&
      Boolean(record.interactionId)
    )
  }

  private mutate<T>(apply: (document: PermissionRequestDocument) => T): T {
    return this.mutations.withSynchronousMutation(
      'control',
      `permission-request:${Date.now()}:${randomUUID().slice(0, 8)}`,
      () => {
        const document = this.load()
        const result = apply(document)
        this.write(document)
        return result
      },
    )
  }

  private write(document: PermissionRequestDocument): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(document, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.file)
      chmodSync(this.file, 0o600)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // Best-effort cleanup; preserve the original write error.
      }
      throw error
    }
  }
}

function requireRequest(
  document: PermissionRequestDocument,
  requestId: string,
): PermissionRequestRecord {
  const record = document.requests.find((item) => item.id === requestId)
  if (!record) throw new Error(`unknown permission request: ${requestId}`)
  return record
}

function sameFingerprintSequence(
  operations: PermissionRequestOperationRecord[],
  fingerprints: string[],
): boolean {
  const expected: string[] = []
  for (const operation of operations) {
    for (let count = 0; count < operation.remainingUses; count += 1)
      expected.push(operation.fingerprint)
  }
  return (
    expected.length === fingerprints.length &&
    expected.every((fingerprint, index) => fingerprint === fingerprints[index])
  )
}

function normalizeDocument(value: unknown): PermissionRequestDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('permission request document must be an object')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || !Array.isArray(raw.requests))
    throw new Error('invalid permission request document')
  return {
    version: 1,
    requests: raw.requests.map((item) => normalizeRecord(item)),
  }
}

function normalizeRecord(value: unknown): PermissionRequestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('permission request must be an object')
  const raw = value as PermissionRequestRecord
  const status = String(raw.status) as PermissionRequestStatus
  if (
    !['waiting', 'approved', 'denied', 'consumed', 'cancelled'].includes(status)
  )
    throw new Error(`invalid permission request status: ${status}`)
  const outcome = raw.outcome
  if (
    outcome !== null &&
    !['allow_once', 'deny', 'allow_and_full_access'].includes(String(outcome))
  )
    throw new Error(`invalid permission request outcome: ${String(outcome)}`)
  if (!Array.isArray(raw.operations) || !raw.operations.length)
    throw new Error('permission request operations are required')
  const operations = raw.operations.map((operation) => ({
    id: requiredText(operation.id, 'operation id'),
    fingerprint: requiredText(operation.fingerprint, 'operation fingerprint'),
    toolName: requiredText(operation.toolName, 'operation tool name'),
    argumentsHash: requiredText(
      operation.argumentsHash,
      'operation arguments hash',
    ),
    arguments:
      operation.arguments &&
      typeof operation.arguments === 'object' &&
      !Array.isArray(operation.arguments)
        ? structuredClone(operation.arguments)
        : {},
    remainingUses: nonNegativeInteger(
      operation.remainingUses,
      'operation remaining uses',
    ),
    risk: String(operation.risk ?? ''),
    rule: String(operation.rule ?? ''),
    trace: Array.isArray(operation.trace) ? [...operation.trace] : [],
    explanation: operation.explanation ?? null,
  }))
  if (
    (status === 'waiting' || status === 'approved') &&
    operations.every((operation) => operation.remainingUses === 0)
  )
    throw new Error('active permission request must have remaining uses')
  return {
    version: 1,
    id: requiredText(raw.id, 'permission request id'),
    interactionId: String(raw.interactionId ?? ''),
    sessionId: requiredText(raw.sessionId, 'permission request session id'),
    status,
    outcome: outcome as PermissionRequestOutcome | null,
    createdAt: finiteNumber(raw.createdAt, 'permission request createdAt'),
    expiresAt: finiteNumber(raw.expiresAt, 'permission request expiresAt'),
    operations,
  }
}

function requiredText(value: unknown, label: string): string {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label} is required`)
  return text
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`${label} must be a non-negative integer`)
  return number
}

function finiteNumber(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`)
  return number
}

function cloneRecord(record: PermissionRequestRecord): PermissionRequestRecord {
  return structuredClone(record)
}

function cloneDocument(
  document: PermissionRequestDocument,
): PermissionRequestDocument {
  return structuredClone(document)
}
