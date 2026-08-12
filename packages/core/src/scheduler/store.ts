import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_VERSION, SchedulerJob, validateJobId } from './models'
import {
  AppendOnlyJournalSync,
  AtomicSnapshotSync,
  PersistenceCorruptionError,
  durableReplaceSync,
  type JournalCodec,
  type SnapshotCodec,
  type SyncPersistenceAdapter,
} from '../store/persistence'

export class SchedulerStoreCorrupt extends Error {}

export class SchedulerStoreData {
  version: number
  jobs: SchedulerJob[]
  constructor(opts: { version?: number; jobs?: SchedulerJob[] } = {}) {
    this.version = opts.version ?? SCHEMA_VERSION
    this.jobs = opts.jobs ?? []
  }
  static fromDict(raw: Record<string, any>): SchedulerStoreData {
    const jobs = (raw.jobs ?? []).filter(isObject).map(SchedulerJob.fromDict)
    return new SchedulerStoreData({
      version: Number(raw.version || SCHEMA_VERSION),
      jobs,
    })
  }
  toDict(): Record<string, unknown> {
    return {
      version: this.version || SCHEMA_VERSION,
      jobs: this.jobs.map((job) => job.toDict()),
    }
  }
}

export class SchedulerStore {
  readonly root: string
  readonly schedulerDir: string
  readonly jobsFile: string
  readonly actionFile: string
  readonly lockFile: string
  private lastActionErrors: Array<Record<string, unknown>> = []
  private lastGood: SchedulerStoreData | null = null
  private readonly jobsSnapshot: AtomicSnapshotSync<SchedulerStoreData>
  private readonly actionJournal: AppendOnlyJournalSync<Record<string, unknown>>
  private readonly persistenceAdapter?: SyncPersistenceAdapter

  constructor(
    root: string,
    opts: { persistenceAdapter?: SyncPersistenceAdapter } = {},
  ) {
    this.root = root
    this.schedulerDir = join(root, 'scheduler')
    this.jobsFile = join(this.schedulerDir, 'jobs.json')
    this.actionFile = join(this.schedulerDir, 'action.jsonl')
    this.lockFile = join(this.schedulerDir, 'scheduler.lock')
    this.persistenceAdapter = opts.persistenceAdapter
    this.jobsSnapshot = new AtomicSnapshotSync({
      path: this.jobsFile,
      codec: SCHEDULER_STORE_CODEC,
      adapter: opts.persistenceAdapter,
      fileMode: 0o600,
      corruptionPolicy: 'quarantine_and_throw',
      corruptionBackupPath: (path) =>
        `${path}.corrupt-${Math.trunc(Date.now() / 1000)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    })
    this.actionJournal = new AppendOnlyJournalSync({
      path: this.actionFile,
      codec: SCHEDULER_ACTION_CODEC,
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
      recoveryMode: 'tolerant',
    })
    mkdirSync(this.schedulerDir, { recursive: true })
    this.copyLegacyFilesIfNeeded()
    if (!existsSync(this.jobsFile))
      this.jobsSnapshot.write(new SchedulerStoreData())
  }

  load(
    opts: { mergeActions?: boolean; allowLastGood?: boolean } = {},
  ): SchedulerStoreData {
    const mergeActions = opts.mergeActions ?? true
    const allowLastGood = opts.allowLastGood ?? true
    let data: SchedulerStoreData
    try {
      data = this.readStore()
    } catch (error) {
      if (allowLastGood && this.lastGood) return this.lastGood
      throw error
    }
    if (mergeActions) data = this.mergeActions(data)
    this.lastGood = data
    return data
  }

  save(data: SchedulerStoreData): void {
    this.jobsSnapshot.write(data)
    this.lastGood = SchedulerStoreData.fromDict(
      data.toDict() as Record<string, any>,
    )
  }

  listJobs(opts: { includeDisabled?: boolean } = {}): SchedulerJob[] {
    let jobs = this.load().jobs
    if (opts.includeDisabled === false) jobs = jobs.filter((job) => job.enabled)
    return jobs
      .slice()
      .sort(
        (a, b) =>
          (a.state.next_run_at_ms ?? Infinity) -
          (b.state.next_run_at_ms ?? Infinity),
      )
  }

  getJob(jobId: string): SchedulerJob | null {
    const safe = validateJobId(jobId)
    return this.load().jobs.find((job) => job.id === safe) ?? null
  }

  upsertJob(job: SchedulerJob): SchedulerJob {
    const data = this.load()
    const jobs = data.jobs.filter((item) => item.id !== job.id)
    jobs.push(job)
    data.jobs = jobs
    this.save(data)
    return job
  }

  removeJob(jobId: string): SchedulerJob | null {
    const safe = validateJobId(jobId)
    const data = this.load()
    const removed = data.jobs.find((job) => job.id === safe) ?? null
    if (!removed) return null
    data.jobs = data.jobs.filter((job) => job.id !== safe)
    this.save(data)
    return removed
  }

  appendAction(
    action: 'add' | 'update' | 'delete',
    opts: { job?: SchedulerJob | null; jobId?: string | null } = {},
  ): void {
    if ((action === 'add' || action === 'update') && !opts.job)
      throw new Error(`job is required for action=${action}`)
    if (action === 'delete' && !opts.jobId)
      throw new Error('job_id is required for action=delete')
    const payload: Record<string, unknown> = { action }
    if (opts.job) payload.job = opts.job.toDict()
    if (opts.jobId) payload.jobId = validateJobId(opts.jobId)
    this.actionJournal.append(payload)
  }

  diagnostics(): Record<string, unknown> {
    const corrupt = existsSync(this.schedulerDir)
      ? readdirSync(this.schedulerDir)
          .filter(
            (name) =>
              name.startsWith('action.corrupt-') && name.endsWith('.jsonl'),
          )
          .sort()
          .reverse()
      : []
    return {
      jobsFile: this.jobsFile,
      actionFile: this.actionFile,
      lastActionErrors: this.lastActionErrors.slice(-20),
      corruptActionFiles: corrupt.slice(0, 10).map((name) => {
        const path = join(this.schedulerDir, name)
        const st = statSync(path)
        return { path, bytes: st.size, updatedAt: st.mtimeMs / 1000 }
      }),
    }
  }

  private readStore(): SchedulerStoreData {
    try {
      const data = this.jobsSnapshot.read({
        fallback: new SchedulerStoreData(),
      }).value
      this.lastGood = data
      return data
    } catch (error) {
      const backup =
        error instanceof PersistenceCorruptionError
          ? error.corruptionBackup
          : null
      throw new SchedulerStoreCorrupt(
        `scheduler store at ${this.jobsFile} is corrupt; preserved at ${String(backup ?? '')}`,
        { cause: error },
      )
    }
  }

  private copyLegacyFilesIfNeeded(): void {
    const legacyDir = join(this.root, 'memory', 'scheduler')
    for (const name of ['jobs.json', 'action.jsonl']) {
      const source = join(legacyDir, name)
      const dest = join(this.schedulerDir, name)
      if (existsSync(dest) || !existsSync(source)) continue
      try {
        copyFileSync(source, dest)
      } catch {
        /* non-destructive best effort */
      }
    }
  }

  private mergeActions(data: SchedulerStoreData): SchedulerStoreData {
    if (!existsSync(this.actionFile)) return data
    const jobs = new Map(data.jobs.map((job) => [job.id, job]))
    let changed = false
    const corruptRecords: Array<Record<string, unknown>> = []
    const replay = this.actionJournal.replay({ repairTail: true })
    if (replay.receipt.corruptionBackup)
      corruptRecords.push(
        ...collectInvalidSchedulerActionRows(replay.receipt.corruptionBackup),
      )
    replay.entries.forEach((entry, index) => {
      const action = entry.payload
      try {
        const kind = action.action
        if (kind === 'add' || kind === 'update') {
          const job = SchedulerJob.fromDict(
            isObject(action.job) ? action.job : {},
          )
          jobs.set(job.id, job)
          changed = true
        } else if (kind === 'delete') {
          const jobId = validateJobId(
            String(action.jobId ?? action.job_id ?? ''),
          )
          if (jobs.delete(jobId)) changed = true
        } else {
          throw new Error(`unknown scheduler action: ${kind}`)
        }
      } catch (error) {
        corruptRecords.push({
          line: index + 1,
          error: String(error instanceof Error ? error.message : error),
          raw: JSON.stringify(action),
        })
      }
    })
    if (corruptRecords.length) {
      this.writeCorruptActions(corruptRecords)
      this.lastActionErrors = corruptRecords
    }
    if (!changed && !corruptRecords.length) return data
    const merged = changed
      ? new SchedulerStoreData({
          version: data.version,
          jobs: [...jobs.values()],
        })
      : data
    if (changed) this.jobsSnapshot.write(merged)
    durableReplaceSync(this.actionFile, '', {
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
    })
    return merged
  }

  private writeCorruptActions(records: Array<Record<string, unknown>>): string {
    const path = join(
      this.schedulerDir,
      `action.corrupt-${Math.trunc(Date.now() / 1000)}-${randomUUID().replace(/-/g, '').slice(0, 8)}.jsonl`,
    )
    durableReplaceSync(
      path,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      { adapter: this.persistenceAdapter, fileMode: 0o600 },
    )
    return path
  }
}

const SCHEDULER_STORE_CODEC: SnapshotCodec<SchedulerStoreData> = {
  schemaVersion: SCHEMA_VERSION,
  encode(value) {
    return value.toDict()
  },
  decode(input) {
    if (!isObject(input))
      throw new Error('scheduler store root must be an object')
    const value = SchedulerStoreData.fromDict(input)
    return { value, schemaVersion: value.version }
  },
}

const SCHEDULER_ACTION_CODEC: JournalCodec<Record<string, unknown>> = {
  schemaVersion: 1,
  create(seq, payload) {
    return {
      schemaVersion: 1,
      seq,
      checksum: schedulerActionChecksum(payload),
      payload,
    }
  },
  encode(entry) {
    return entry.payload
  },
  decode(input, context) {
    if (!isObject(input)) throw new Error('action log row must be an object')
    return {
      schemaVersion: 1,
      seq: context.expectedSeq,
      checksum: schedulerActionChecksum(input),
      payload: input,
    }
  },
}

function schedulerActionChecksum(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function collectInvalidSchedulerActionRows(
  path: string,
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = []
  for (const [index, rawLine] of readFileSync(path, 'utf8')
    .split('\n')
    .entries()) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      if (!isObject(JSON.parse(line)))
        throw new Error('action log row must be an object')
    } catch (error) {
      records.push({
        line: index + 1,
        error: String(error instanceof Error ? error.message : error),
        raw: rawLine,
      })
    }
  }
  return records
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
