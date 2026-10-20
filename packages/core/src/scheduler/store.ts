import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { uptime } from 'node:os'
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

/** Another live process runs the scheduler on this data directory. */
export class SchedulerLockHeld extends Error {
  constructor(readonly holder: SchedulerLockHolder) {
    super(
      `另一个 Emperor 进程（pid ${holder.pid}）正在运行定时任务，本进程不启动定时任务`,
    )
    this.name = 'SchedulerLockHeld'
  }
}

export interface SchedulerLockHolder {
  pid: number
  startedAt: number
  /** When the machine booted, to tell a lock left before a reboot. */
  bootAt: number | null
}

/**
 * A job entry that could not be read (KRN-10): set aside in
 * `jobs.rejected.json` so the other jobs still load.
 */
export interface SchedulerRejectedJob {
  id: string | null
  name: string | null
  error: string
  raw: unknown
  rejected_at_ms?: number
}

export class SchedulerStoreData {
  version: number
  jobs: SchedulerJob[]
  /** Entries that failed to parse; never written back to `jobs.json`. */
  rejected: SchedulerRejectedJob[]
  constructor(
    opts: {
      version?: number
      jobs?: SchedulerJob[]
      rejected?: SchedulerRejectedJob[]
    } = {},
  ) {
    this.version = opts.version ?? SCHEMA_VERSION
    this.jobs = opts.jobs ?? []
    this.rejected = opts.rejected ?? []
  }
  static fromDict(raw: Record<string, any>): SchedulerStoreData {
    const jobs: SchedulerJob[] = []
    const rejected: SchedulerRejectedJob[] = []
    for (const entry of Array.isArray(raw.jobs) ? raw.jobs : []) {
      try {
        if (!isObject(entry)) throw new Error('job entry must be an object')
        jobs.push(SchedulerJob.fromDict(entry))
      } catch (error) {
        rejected.push({
          id: isObject(entry) && typeof entry.id === 'string' ? entry.id : null,
          name:
            isObject(entry) && typeof entry.name === 'string'
              ? entry.name
              : null,
          error: String(error instanceof Error ? error.message : error),
          raw: entry,
        })
      }
    }
    return new SchedulerStoreData({
      version: Number(raw.version || SCHEMA_VERSION),
      jobs,
      rejected,
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
  readonly rejectedFile: string
  private lastActionErrors: Array<Record<string, unknown>> = []
  private lastGood: SchedulerStoreData | null = null
  /** Entries this process set aside (the page says so once). */
  private rejectedThisRun = 0
  private lockHeld = false
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
    this.rejectedFile = join(this.schedulerDir, 'jobs.rejected.json')
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

  /** Entries set aside since this store was opened. */
  rejectedCount(): number {
    return this.rejectedThisRun
  }

  /**
   * Take `scheduler.lock` for this process. Another live process keeps it
   * (SchedulerLockHeld); a lock left by a process that is gone, by this
   * process, or before the last reboot (its pid may belong to something
   * else now) is taken over.
   */
  acquireLock(startedAt: number): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockFile, 'wx', 0o600)
        try {
          writeSync(
            fd,
            JSON.stringify({ pid: process.pid, startedAt, bootAt: bootTime() }),
          )
        } finally {
          closeSync(fd)
        }
        this.lockHeld = true
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const holder = readLockHolder(this.lockFile)
      if (
        holder &&
        holder.pid !== process.pid &&
        !beforeThisBoot(holder) &&
        processAlive(holder.pid)
      )
        throw new SchedulerLockHeld(holder)
      try {
        unlinkSync(this.lockFile)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    throw new Error(`could not take ${this.lockFile}`)
  }

  /** Give `scheduler.lock` back (only when this process holds it). */
  releaseLock(): void {
    if (!this.lockHeld) return
    this.lockHeld = false
    if (readLockHolder(this.lockFile)?.pid !== process.pid) return
    try {
      unlinkSync(this.lockFile)
    } catch {
      /* already gone */
    }
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
      rejectedFile: this.rejectedFile,
      rejectedJobs: readRejected(this.rejectedFile).map((entry) => ({
        id: entry.id,
        name: entry.name,
        error: entry.error,
        rejectedAtMs: entry.rejected_at_ms ?? null,
      })),
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
      if (data.rejected.length) this.setAside(data.rejected)
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

  /**
   * Add entries to `jobs.rejected.json` (an entry already there is not
   * repeated: `jobs.json` keeps it until the next save).
   */
  private setAside(entries: SchedulerRejectedJob[]): void {
    const existing = readRejected(this.rejectedFile)
    const seen = new Set(existing.map((entry) => rejectedDigest(entry.raw)))
    const added = entries.filter(
      (entry) => !seen.has(rejectedDigest(entry.raw)),
    )
    if (!added.length) return
    const stamp = Date.now()
    durableReplaceSync(
      this.rejectedFile,
      `${JSON.stringify(
        {
          version: 1,
          jobs: [
            ...existing,
            ...added.map((entry) => ({ ...entry, rejected_at_ms: stamp })),
          ],
        },
        null,
        2,
      )}\n`,
      { adapter: this.persistenceAdapter, fileMode: 0o600 },
    )
    this.rejectedThisRun += added.length
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

function readRejected(path: string): SchedulerRejectedJob[] {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed?.jobs) ? parsed.jobs.filter(isObject) : []
  } catch {
    // Keep an unreadable file instead of writing over it.
    copyFileSync(path, `${path}.corrupt-${Math.trunc(Date.now() / 1000)}`)
    return []
  }
}

function rejectedDigest(raw: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(raw) ?? 'undefined')
    .digest('hex')
}

function readLockHolder(path: string): SchedulerLockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const pid = Number(parsed?.pid)
    if (!Number.isSafeInteger(pid) || pid <= 0) return null
    const bootAt = Number(parsed?.bootAt)
    return {
      pid,
      startedAt: Number(parsed?.startedAt) || 0,
      bootAt: Number.isFinite(bootAt) && bootAt > 0 ? bootAt : null,
    }
  } catch {
    return null
  }
}

function bootTime(): number {
  return Math.round(Date.now() - uptime() * 1000)
}

/** Written during an earlier boot (a minute of slack for clock drift). */
function beforeThisBoot(holder: SchedulerLockHolder): boolean {
  return holder.bootAt !== null && bootTime() - holder.bootAt > 60_000
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
