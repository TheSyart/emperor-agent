import { randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { SCHEMA_VERSION, SchedulerJob, validateJobId } from './models'

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
    return new SchedulerStoreData({ version: Number(raw.version || SCHEMA_VERSION), jobs })
  }
  toDict(): Record<string, unknown> {
    return { version: this.version || SCHEMA_VERSION, jobs: this.jobs.map((job) => job.toDict()) }
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

  constructor(root: string) {
    this.root = root
    this.schedulerDir = join(root, 'scheduler')
    this.jobsFile = join(this.schedulerDir, 'jobs.json')
    this.actionFile = join(this.schedulerDir, 'action.jsonl')
    this.lockFile = join(this.schedulerDir, 'scheduler.lock')
    mkdirSync(this.schedulerDir, { recursive: true })
    this.copyLegacyFilesIfNeeded()
    if (!existsSync(this.jobsFile)) this.atomicWriteJson(this.jobsFile, new SchedulerStoreData().toDict())
  }

  load(opts: { mergeActions?: boolean; allowLastGood?: boolean } = {}): SchedulerStoreData {
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
    this.atomicWriteJson(this.jobsFile, data.toDict())
    this.lastGood = SchedulerStoreData.fromDict(data.toDict() as Record<string, any>)
  }

  listJobs(opts: { includeDisabled?: boolean } = {}): SchedulerJob[] {
    let jobs = this.load().jobs
    if (opts.includeDisabled === false) jobs = jobs.filter((job) => job.enabled)
    return jobs.slice().sort((a, b) => (a.state.next_run_at_ms ?? Infinity) - (b.state.next_run_at_ms ?? Infinity))
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

  appendAction(action: 'add' | 'update' | 'delete', opts: { job?: SchedulerJob | null; jobId?: string | null } = {}): void {
    if ((action === 'add' || action === 'update') && !opts.job) throw new Error(`job is required for action=${action}`)
    if (action === 'delete' && !opts.jobId) throw new Error('job_id is required for action=delete')
    const payload: Record<string, unknown> = { action }
    if (opts.job) payload.job = opts.job.toDict()
    if (opts.jobId) payload.jobId = validateJobId(opts.jobId)
    appendFileSync(this.actionFile, JSON.stringify(payload) + '\n', 'utf8')
  }

  diagnostics(): Record<string, unknown> {
    const corrupt = existsSync(this.schedulerDir)
      ? readdirSync(this.schedulerDir).filter((name) => name.startsWith('action.corrupt-') && name.endsWith('.jsonl')).sort().reverse()
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
      const raw = JSON.parse(readFileSync(this.jobsFile, 'utf8') || '{}')
      if (!isObject(raw)) throw new Error('scheduler store root must be an object')
      const data = SchedulerStoreData.fromDict(raw)
      this.lastGood = data
      return data
    } catch (error) {
      const backup = `${this.jobsFile}.corrupt-${Math.trunc(Date.now() / 1000)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
      if (existsSync(this.jobsFile)) {
        try { renameSync(this.jobsFile, backup) } catch { /* ignore */ }
      }
      throw new SchedulerStoreCorrupt(`scheduler store at ${this.jobsFile} is corrupt; preserved at ${backup}`, { cause: error })
    }
  }

  private copyLegacyFilesIfNeeded(): void {
    const legacyDir = join(this.root, 'memory', 'scheduler')
    for (const name of ['jobs.json', 'action.jsonl']) {
      const source = join(legacyDir, name)
      const dest = join(this.schedulerDir, name)
      if (existsSync(dest) || !existsSync(source)) continue
      try { copyFileSync(source, dest) } catch { /* non-destructive best effort */ }
    }
  }

  private mergeActions(data: SchedulerStoreData): SchedulerStoreData {
    if (!existsSync(this.actionFile)) return data
    const jobs = new Map(data.jobs.map((job) => [job.id, job]))
    let changed = false
    const corruptRecords: Array<Record<string, unknown>> = []
    const lines = readFileSync(this.actionFile, 'utf8').split('\n')
    lines.forEach((rawLine, index) => {
      const line = rawLine.trim()
      if (!line) return
      try {
        const action = JSON.parse(line)
        if (!isObject(action)) throw new Error('action log row must be an object')
        const kind = action.action
        if (kind === 'add' || kind === 'update') {
          const job = SchedulerJob.fromDict(isObject(action.job) ? action.job : {})
          jobs.set(job.id, job)
          changed = true
        } else if (kind === 'delete') {
          const jobId = validateJobId(String(action.jobId ?? action.job_id ?? ''))
          if (jobs.delete(jobId)) changed = true
        } else {
          throw new Error(`unknown scheduler action: ${kind}`)
        }
      } catch (error) {
        corruptRecords.push({ line: index + 1, error: String(error instanceof Error ? error.message : error), raw: rawLine })
      }
    })
    if (corruptRecords.length) {
      this.writeCorruptActions(corruptRecords)
      this.lastActionErrors = corruptRecords
    }
    if (!changed && !corruptRecords.length) return data
    const merged = changed ? new SchedulerStoreData({ version: data.version, jobs: [...jobs.values()] }) : data
    if (changed) this.atomicWriteJson(this.jobsFile, merged.toDict())
    writeFileSync(this.actionFile, '', 'utf8')
    return merged
  }

  private writeCorruptActions(records: Array<Record<string, unknown>>): string {
    const path = join(this.schedulerDir, `action.corrupt-${Math.trunc(Date.now() / 1000)}-${randomUUID().replace(/-/g, '').slice(0, 8)}.jsonl`)
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
    return path
  }

  private atomicWriteJson(path: string, payload: Record<string, unknown>): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.${basename(path)}.${randomUUID().replace(/-/g, '')}.tmp`)
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
