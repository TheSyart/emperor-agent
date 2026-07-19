import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appendJsonl, readJsonl } from '../store/jsonl'

export type ExternalAuditDirection = 'ingress' | 'outbound' | 'lifecycle'
export type ExternalAuditOutcome =
  | 'accepted'
  | 'rejected'
  | 'sent'
  | 'dead-letter'
  | 'started'
  | 'stopped'
  | 'degraded'

export interface ExternalAuditRecord {
  id: string
  timestamp: string
  adapter: 'signed-webhook'
  direction: ExternalAuditDirection
  outcome: ExternalAuditOutcome
  reasonCode: string
  messageIdDigest: string | null
  keyIdDigest: string | null
  remoteDigest: string | null
  statusCode: number | null
  durationMs: number | null
}

export type ExternalAuditInput = Omit<ExternalAuditRecord, 'id' | 'timestamp'>

export interface ExternalAuditDiagnostics {
  path: string
  exists: boolean
  bytes: number
  maxHotBytes: number
  maxArchives: number
  archives: Array<{ path: string; bytes: number }>
  records: number
  badLines: number
}

export class ExternalAuditStore {
  readonly auditPath: string
  readonly maxHotBytes: number
  readonly maxArchives: number
  private readonly clock: () => number
  private writeChain: Promise<void> = Promise.resolve()
  private successfulAppends = 0
  private failedAppends = 0

  constructor(
    stateRoot: string,
    opts: {
      maxHotBytes?: number
      maxArchives?: number
      clock?: () => number
    } = {},
  ) {
    this.auditPath = join(stateRoot, 'external', 'audit.jsonl')
    this.maxHotBytes = boundedInteger(
      opts.maxHotBytes,
      8 * 1024 * 1024,
      256,
      64 * 1024 * 1024,
    )
    this.maxArchives = boundedInteger(opts.maxArchives, 5, 0, 20)
    this.clock = opts.clock ?? (() => Date.now() / 1000)
  }

  append(input: ExternalAuditInput): Promise<void> {
    const record = normalizeRecord(input, this.clock())
    const operation = this.writeChain.then(async () => {
      await this.rotateIfNeeded(Buffer.byteLength(JSON.stringify(record)) + 1)
      await appendJsonl(this.auditPath, record)
    })
    const observed = operation.then(
      () => {
        this.successfulAppends += 1
      },
      (error: unknown) => {
        this.failedAppends += 1
        throw error
      },
    )
    this.writeChain = observed.catch(() => {})
    return observed
  }

  get appendedRecords(): number {
    return this.successfulAppends
  }

  get writeFailures(): number {
    return this.failedAppends
  }

  async replay(opts: { limit?: number } = {}): Promise<{
    records: ExternalAuditRecord[]
    totalRecords: number
    badLines: Array<{ path: string; line: number; raw: string }>
  }> {
    await this.writeChain
    const paths = [
      ...(await this.archivePaths()).map((archive) => archive.path),
      this.auditPath,
    ]
    const records: ExternalAuditRecord[] = []
    const badLines: Array<{ path: string; line: number; raw: string }> = []
    for (const path of paths) {
      const replay = await readJsonl<ExternalAuditRecord>(path)
      for (const record of replay.records) {
        const parsed = parseRecord(record)
        if (parsed) records.push(parsed)
      }
      badLines.push(...replay.badLines.map((line) => ({ path, ...line })))
    }
    const limit = boundedInteger(opts.limit, 100, 0, 10_000)
    return {
      records: limit > 0 ? records.slice(-limit) : [],
      totalRecords: records.length,
      badLines,
    }
  }

  async diagnostics(): Promise<ExternalAuditDiagnostics> {
    await this.writeChain
    const archives = await this.archivePaths()
    const replay = await this.replay({ limit: 0 })
    return {
      path: this.auditPath,
      exists: existsSync(this.auditPath),
      bytes: await fileBytes(this.auditPath),
      maxHotBytes: this.maxHotBytes,
      maxArchives: this.maxArchives,
      archives,
      records: replay.totalRecords,
      badLines: replay.badLines.length,
    }
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    const currentBytes = await fileBytes(this.auditPath)
    if (!currentBytes || currentBytes + incomingBytes <= this.maxHotBytes)
      return
    await mkdir(dirname(this.auditPath), { recursive: true })
    const stamp = new Date(this.clock() * 1000)
      .toISOString()
      .replaceAll(':', '-')
      .replaceAll('.', '-')
    const archive = join(
      dirname(this.auditPath),
      `audit.${stamp}-${randomUUID().replaceAll('-', '').slice(0, 8)}.jsonl`,
    )
    await rename(this.auditPath, archive)
    const archives = await this.archivePaths()
    const excess = Math.max(0, archives.length - this.maxArchives)
    for (const item of archives.slice(0, excess)) await unlink(item.path)
  }

  private async archivePaths(): Promise<
    Array<{ path: string; bytes: number }>
  > {
    const parent = dirname(this.auditPath)
    const names = (await readdir(parent).catch(() => []))
      .filter((name) => /^audit\..+\.jsonl$/.test(name))
      .sort()
    const out: Array<{ path: string; bytes: number }> = []
    for (const name of names) {
      const path = join(parent, name)
      out.push({ path, bytes: await fileBytes(path) })
    }
    return out
  }
}

function normalizeRecord(
  input: ExternalAuditInput,
  timestampSeconds: number,
): ExternalAuditRecord {
  return {
    id: `extaudit_${randomUUID().replaceAll('-', '')}`,
    timestamp: new Date(timestampSeconds * 1000).toISOString(),
    adapter: 'signed-webhook',
    direction: input.direction,
    outcome: input.outcome,
    reasonCode: safeReasonCode(input.reasonCode),
    messageIdDigest: safeDigest(input.messageIdDigest),
    keyIdDigest: safeDigest(input.keyIdDigest),
    remoteDigest: safeDigest(input.remoteDigest),
    statusCode: nullableInteger(input.statusCode, 100, 599),
    durationMs: nullableInteger(input.durationMs, 0, 86_400_000),
  }
}

function parseRecord(value: unknown): ExternalAuditRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.adapter !== 'signed-webhook' ||
    !isDirection(record.direction) ||
    !isOutcome(record.outcome) ||
    typeof record.id !== 'string' ||
    typeof record.timestamp !== 'string' ||
    typeof record.reasonCode !== 'string'
  )
    return null
  return record as unknown as ExternalAuditRecord
}

function isDirection(value: unknown): value is ExternalAuditDirection {
  return value === 'ingress' || value === 'outbound' || value === 'lifecycle'
}

function isOutcome(value: unknown): value is ExternalAuditOutcome {
  return (
    value === 'accepted' ||
    value === 'rejected' ||
    value === 'sent' ||
    value === 'dead-letter' ||
    value === 'started' ||
    value === 'stopped' ||
    value === 'degraded'
  )
}

function safeReasonCode(value: string): string {
  const reason = String(value ?? '')
    .trim()
    .slice(0, 128)
  return /^[a-z0-9][a-z0-9_.:-]*$/.test(reason) ? reason : 'invalid_reason'
}

function safeDigest(value: string | null): string | null {
  if (value === null) return null
  const digest = String(value).toLowerCase()
  return /^[a-f0-9]{64}$/.test(digest) ? digest : null
}

function nullableInteger(
  value: number | null,
  min: number,
  max: number,
): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fallback
}

async function fileBytes(path: string): Promise<number> {
  return (await stat(path).catch(() => null))?.size ?? 0
}

export async function externalAuditRawBytes(
  store: ExternalAuditStore,
): Promise<string> {
  return existsSync(store.auditPath)
    ? await readFile(store.auditPath, 'utf8')
    : ''
}
