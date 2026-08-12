import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import {
  appendFile,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { z } from 'zod'
import { redactSensitiveOutput, redactSensitiveValue } from '../util/redaction'
import {
  environmentIdSchema,
  environmentJobRecordSchema,
  environmentLogInputSchema,
  environmentLogRecordSchema,
  environmentReceiptSchema,
  type EnvironmentJobRecord,
  type EnvironmentLogInput,
  type EnvironmentLogRecord,
  type EnvironmentReceipt,
} from './models'

const MAX_LOG_MESSAGE_CHARS = 8_000
const MAX_LOG_DETAILS_CHARS = 6_000
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024

export interface EnvironmentStoreOptions {
  now?: () => string
  homeDir?: string
  username?: string
  maxLogBytes?: number
}

export interface EnvironmentStorePaths {
  root: string
  bin: string
  tools: string
  data: string
  registry: string
  jobs: string
  installations: string
  receipts: string
  downloads: string
  lock: string
}

export interface EnvironmentStoreDiagnostic {
  kind: 'corrupt_job' | 'corrupt_receipt' | 'corrupt_log'
  jobId: string
  path: string
  backupPath: string
  message: string
}

export interface EnvironmentLogPage {
  records: EnvironmentLogRecord[]
  badLines: Array<{ line: number; raw: string }>
  cursor: number
  nextCursor: number | null
  total: number
}

export class EnvironmentStore {
  readonly stateRoot: string
  readonly paths: EnvironmentStorePaths
  private readonly now: () => string
  private readonly homeDir: string
  private readonly username: string
  private readonly maxLogBytes: number
  private readonly diagnosticRecords: EnvironmentStoreDiagnostic[] = []
  private readonly pathOperations = new Map<string, Promise<unknown>>()

  constructor(stateRoot: string, opts: EnvironmentStoreOptions = {}) {
    this.stateRoot = resolve(stateRoot)
    const root = join(this.stateRoot, 'environment')
    this.paths = {
      root,
      bin: join(root, 'bin'),
      tools: join(root, 'tools'),
      data: join(root, 'data'),
      registry: join(root, 'registry.v1.json'),
      jobs: join(root, 'jobs'),
      installations: join(root, 'installations'),
      receipts: join(root, 'receipts'),
      downloads: join(root, 'downloads'),
      lock: join(root, 'environment.lock'),
    }
    this.now = opts.now ?? (() => new Date().toISOString())
    this.homeDir = opts.homeDir ?? homedir()
    this.username = opts.username ?? safeUsername()
    this.maxLogBytes = Math.max(
      1_024,
      Math.min(100 * 1024 * 1024, opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES),
    )
  }

  initialize(): void {
    this.ensureLayout()
  }

  jobPath(jobId: string): string {
    return join(this.paths.jobs, `${assertEnvironmentId(jobId, 'job id')}.json`)
  }

  receiptPath(jobId: string): string {
    return join(
      this.paths.receipts,
      `${assertEnvironmentId(jobId, 'job id')}.json`,
    )
  }

  logPath(jobId: string): string {
    return join(
      this.paths.installations,
      `${assertEnvironmentId(jobId, 'job id')}.jsonl`,
    )
  }

  async saveJob(job: EnvironmentJobRecord): Promise<void> {
    const parsed = environmentJobRecordSchema.parse(job)
    this.ensureLayout()
    const path = this.jobPath(parsed.jobId)
    await this.serializePath(path, () => writeJsonAtomic(path, parsed))
  }

  async getJob(jobId: string): Promise<EnvironmentJobRecord | null> {
    this.ensureLayout()
    const path = this.jobPath(jobId)
    return this.serializePath(path, () =>
      this.readValidatedJson(
        path,
        environmentJobRecordSchema,
        'corrupt_job',
        jobId,
      ),
    )
  }

  async listJobs(): Promise<EnvironmentJobRecord[]> {
    this.ensureLayout()
    const entries = await readdir(this.paths.jobs, { withFileTypes: true })
    const jobs: EnvironmentJobRecord[] = []
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isDirectory() || !entry.name.endsWith('.json')) continue
      const jobId = entry.name.slice(0, -'.json'.length)
      if (!environmentIdSchema.safeParse(jobId).success) continue
      const job = await this.getJob(jobId)
      if (job) jobs.push(job)
    }
    return jobs.sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.jobId.localeCompare(right.jobId)
        : left.createdAt.localeCompare(right.createdAt),
    )
  }

  async saveReceipt(receipt: EnvironmentReceipt): Promise<void> {
    const parsed = environmentReceiptSchema.parse(receipt)
    this.ensureLayout()
    const path = this.receiptPath(parsed.jobId)
    await this.serializePath(path, () => writeJsonAtomic(path, parsed))
  }

  async getReceipt(jobId: string): Promise<EnvironmentReceipt | null> {
    this.ensureLayout()
    const path = this.receiptPath(jobId)
    return this.serializePath(path, () =>
      this.readValidatedJson(
        path,
        environmentReceiptSchema,
        'corrupt_receipt',
        jobId,
      ),
    )
  }

  async appendLog(jobId: string, input: EnvironmentLogInput): Promise<void> {
    const safeJobId = assertEnvironmentId(jobId, 'job id')
    const parsed = environmentLogInputSchema.parse(input)
    const record = environmentLogRecordSchema.parse({
      schemaVersion: 1,
      timestamp: this.now(),
      jobId: safeJobId,
      level: parsed.level,
      kind: parsed.kind,
      message: redactSensitiveOutput(parsed.message, {
        home: this.homeDir,
        username: this.username,
      }).slice(0, MAX_LOG_MESSAGE_CHARS),
      details: boundedDetails(
        redactSensitiveValue(parsed.details, {
          home: this.homeDir,
          username: this.username,
        }),
      ),
    })
    this.ensureLayout()
    const path = this.logPath(safeJobId)
    await this.serializePath(path, async () => {
      assertSafeLogTarget(path)
      const line = `${JSON.stringify(record)}\n`
      const currentBytes = existsSync(path) ? lstatSync(path).size : 0
      const remaining = Math.max(0, this.maxLogBytes - currentBytes)
      if (Buffer.byteLength(line) > remaining) return
      await appendFile(path, line, {
        encoding: 'utf8',
        flag: 'a',
      })
    })
  }

  async readLog(
    jobId: string,
    opts: { cursor?: number; limit?: number } = {},
  ): Promise<EnvironmentLogPage> {
    const safeJobId = assertEnvironmentId(jobId, 'job id')
    this.ensureLayout()
    const path = this.logPath(safeJobId)
    const cursor = Math.max(0, Math.trunc(opts.cursor ?? 0))
    const limit = Math.min(200, Math.max(1, Math.trunc(opts.limit ?? 50)))
    return this.serializePath(path, async () => {
      if (!existsSync(path))
        return { records: [], badLines: [], cursor, nextCursor: null, total: 0 }
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        this.ensureLayout()
        const backupPath = isolateCorruptFile(path, this.now())
        this.recordDiagnostic({
          kind: 'corrupt_log',
          jobId: safeJobId,
          path,
          backupPath,
          message: 'Environment log path was unsafe and has been isolated.',
        })
        return { records: [], badLines: [], cursor, nextCursor: null, total: 0 }
      }
      const raw = await readFile(path, 'utf8')
      const records: EnvironmentLogRecord[] = []
      const badLines: Array<{ line: number; raw: string }> = []
      raw.split('\n').forEach((line, index) => {
        if (!line.trim()) return
        try {
          const parsed: unknown = JSON.parse(line)
          const result = environmentLogRecordSchema.safeParse(parsed)
          if (!result.success)
            throw new Error('environment log schema mismatch')
          records.push(result.data)
        } catch {
          badLines.push({
            line: index + 1,
            raw: redactSensitiveOutput(line, {
              home: this.homeDir,
              username: this.username,
            }).slice(0, 2_000),
          })
        }
      })
      if (badLines.length)
        this.recordDiagnostic({
          kind: 'corrupt_log',
          jobId: safeJobId,
          path,
          backupPath: '',
          message: `${badLines.length} malformed environment log line(s)`,
        })
      const page = records.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + page.length < records.length ? cursor + page.length : null
      return {
        records: page,
        badLines,
        cursor,
        nextCursor,
        total: records.length,
      }
    })
  }

  diagnostics(): EnvironmentStoreDiagnostic[] {
    return this.diagnosticRecords.map((item) => ({ ...item }))
  }

  private ensureLayout(): void {
    mkdirSync(this.stateRoot, { recursive: true })
    ensureManagedDirectory(this.stateRoot, this.paths.root)
    for (const path of [
      this.paths.bin,
      this.paths.jobs,
      this.paths.installations,
      this.paths.receipts,
      this.paths.downloads,
    ])
      ensureManagedDirectory(this.paths.root, path)
    if (existsSync(this.paths.registry)) {
      const stat = lstatSync(this.paths.registry)
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(
          `Environment managed registry is unsafe: ${this.paths.registry}`,
        )
    } else {
      writeFileSync(
        this.paths.registry,
        `${JSON.stringify({ schemaVersion: 1, tools: {} }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      )
    }
  }

  private async readValidatedJson<T>(
    path: string,
    schema: z.ZodType<T>,
    kind: EnvironmentStoreDiagnostic['kind'],
    jobId: string,
  ): Promise<T | null> {
    const safeJobId = assertEnvironmentId(jobId, 'job id')
    await recoverAtomicBackup(path)
    if (!existsSync(path)) return null
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error('environment store path is not a regular file')
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      return schema.parse(parsed)
    } catch {
      this.ensureLayout()
      const backupPath = isolateCorruptFile(path, this.now())
      this.recordDiagnostic({
        kind,
        jobId: safeJobId,
        path,
        backupPath,
        message: 'Environment store data was corrupt and has been isolated.',
      })
      return null
    }
  }

  private recordDiagnostic(record: EnvironmentStoreDiagnostic): void {
    const key = `${record.kind}:${record.jobId}:${record.path}:${record.backupPath}`
    if (
      this.diagnosticRecords.some(
        (item) =>
          `${item.kind}:${item.jobId}:${item.path}:${item.backupPath}` === key,
      )
    )
      return
    this.diagnosticRecords.push({ ...record })
  }

  private async serializePath<T>(
    path: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.pathOperations.get(path) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.pathOperations.set(path, current)
    try {
      return await current
    } finally {
      if (this.pathOperations.get(path) === current)
        this.pathOperations.delete(path)
    }
  }
}

function assertEnvironmentId(value: string, label: string): string {
  const parsed = environmentIdSchema.safeParse(value)
  if (!parsed.success) throw new Error(`Invalid ${label}`)
  return parsed.data
}

function ensureManagedDirectory(boundary: string, path: string): void {
  const canonicalBoundary = realpathSync(boundary)
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Environment managed directory is unsafe: ${path}`)
  } else mkdirSync(path)
  const canonicalPath = realpathSync(path)
  if (!pathInside(canonicalBoundary, canonicalPath))
    throw new Error(`Environment managed directory escapes state root: ${path}`)
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const backup = `${path}.replace-backup`
  await recoverAtomicBackup(path)
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  try {
    try {
      await rename(temp, path)
      return
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !existsSync(path) ||
        !isReplaceConflict(error)
      )
        throw error
    }
    await rm(backup, { force: true })
    await rename(path, backup)
    try {
      await rename(temp, path)
      await rm(backup, { force: true })
    } catch (error) {
      if (!existsSync(path) && existsSync(backup)) await rename(backup, path)
      throw error
    }
  } finally {
    await rm(temp, { force: true })
  }
}

async function recoverAtomicBackup(path: string): Promise<void> {
  const backup = `${path}.replace-backup`
  if (!existsSync(backup)) return
  if (existsSync(path)) await rm(backup, { force: true })
  else await rename(backup, path)
}

function isolateCorruptFile(path: string, now: string): string {
  if (!existsSync(path)) return ''
  const suffix = now.replace(/[:.]/g, '-')
  let backup = `${path}.corrupt-${suffix}`
  let counter = 1
  while (existsSync(backup)) backup = `${path}.corrupt-${suffix}-${counter++}`
  renameSync(path, backup)
  return backup
}

function boundedDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const details = value as Record<string, unknown>
  return JSON.stringify(details).length <= MAX_LOG_DETAILS_CHARS
    ? details
    : { truncated: true }
}

function assertSafeLogTarget(path: string): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error('Environment log target is unsafe or symbolic')
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

function isReplaceConflict(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : ''
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES'
}

function safeUsername(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}
