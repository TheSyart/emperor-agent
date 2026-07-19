import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { TaskRecord } from './models'
import { GoalGateMutationLedger } from '../goals/mutation-ledger'
import type { GoalMutationLease } from '../goals/mutation-guard'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const GOAL_REVIEWER_SOURCE = 'goal_reviewer_dispatch'

export class TaskStoreConflictError extends Error {
  readonly code = 'task_store_conflict'

  constructor(message = 'Task write conflicts with the current revision.') {
    super(message)
    this.name = 'TaskStoreConflictError'
  }
}

export class TaskStoreAuthorityError extends Error {
  readonly code = 'task_store_reviewer_authority_required'

  constructor(message = 'Goal reviewer Task write requires Core authority.') {
    super(message)
    this.name = 'TaskStoreAuthorityError'
  }
}

export class TaskStore {
  readonly root: string
  readonly tasksDir: string
  readonly indexFile: string
  readonly archiveDir: string
  readonly maxTerminal: number
  private readonly goalMutations: GoalGateMutationLedger
  private readonly reviewerCapability: object | null

  constructor(
    root: string,
    opts: { maxTerminal?: number; reviewerCapability?: object | null } = {},
  ) {
    this.root = root
    this.tasksDir = join(root, 'tasks')
    this.indexFile = join(this.tasksDir, 'index.json')
    this.archiveDir = join(this.tasksDir, 'archive')
    this.maxTerminal = Math.max(1, Math.trunc(opts.maxTerminal ?? 500))
    this.reviewerCapability = opts.reviewerCapability ?? null
    this.goalMutations = new GoalGateMutationLedger(this.root)
    if (!existsSync(this.indexFile))
      this.goalMutations.withSynchronousMutation(
        'task',
        'task-store:init',
        () => {
          mkdirSync(this.tasksDir, { recursive: true })
          this.copyLegacyFilesIfNeeded()
          if (!existsSync(this.indexFile)) this.write(this.indexFile, {})
        },
      )
  }

  list(): TaskRecord[] {
    return this.goalMutations.guard.runExclusiveSync('mutation', (lease) => {
      const data = this.read(this.indexFile, lease)
      return Object.values(data)
        .filter(isObject)
        .map((item) => TaskRecord.fromDict(item))
    })
  }

  get(taskId: string): TaskRecord | null {
    return this.goalMutations.guard.runExclusiveSync('mutation', (lease) => {
      const data = this.read(this.indexFile, lease)
      const hot = data[String(taskId)]
      if (isObject(hot)) return TaskRecord.fromDict(hot)
      return this.getArchived(String(taskId), lease)
    })
  }

  inspect(taskId: string): {
    record: TaskRecord | null
    issue: { code: 'task_store_corrupt'; path: string } | null
  } {
    if (!existsSync(this.indexFile)) return { record: null, issue: null }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.indexFile, 'utf8') || '{}')
    } catch {
      return {
        record: null,
        issue: { code: 'task_store_corrupt', path: this.indexFile },
      }
    }
    if (!isObject(raw))
      return {
        record: null,
        issue: { code: 'task_store_corrupt', path: this.indexFile },
      }
    const payload = raw[String(taskId)]
    if (!isObject(payload)) return { record: null, issue: null }
    try {
      return { record: TaskRecord.fromDict(payload), issue: null }
    } catch {
      return {
        record: null,
        issue: { code: 'task_store_corrupt', path: this.indexFile },
      }
    }
  }

  /** Pure inspection across hot and archived records; never quarantines disk. */
  inspectIncludingArchive(taskIdValue: string): {
    record: TaskRecord | null
    issue: { code: 'task_store_corrupt'; path: string } | null
  } {
    const taskId = String(taskIdValue)
    const hot = this.inspect(taskId)
    if (hot.issue || hot.record) return hot
    if (!existsSync(this.archiveDir)) return hot
    let names: string[]
    try {
      names = readdirSync(this.archiveDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    } catch {
      return {
        record: null,
        issue: { code: 'task_store_corrupt', path: this.archiveDir },
      }
    }
    let record: TaskRecord | null = null
    for (const name of names) {
      const path = join(this.archiveDir, name)
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
        if (!isObject(raw)) throw new Error('invalid Task archive')
        const payload = raw[taskId]
        if (!isObject(payload)) continue
        if (record) throw new Error('duplicate archived Task')
        record = TaskRecord.fromDict(payload)
      } catch {
        return {
          record: null,
          issue: { code: 'task_store_corrupt', path },
        }
      }
    }
    return { record, issue: null }
  }

  upsert(
    record: TaskRecord,
    opts: {
      expectedRevision?: number | null
      reviewerCapability?: object | null
    } = {},
  ): TaskRecord {
    return this.goalMutations.withSynchronousMutation(
      'task',
      `${record.id}:${record.revision}:${record.status}:${record.ended_at ?? 'open'}`,
      (lease) => {
        const data = this.read(this.indexFile, lease)
        const payload = data[record.id]
        const current = isObject(payload) ? TaskRecord.fromDict(payload) : null
        const expected =
          opts.expectedRevision === undefined
            ? current
              ? record.revision
              : null
            : opts.expectedRevision
        if (
          (current === null && expected !== null) ||
          (current !== null && expected !== current.revision)
        )
          throw new TaskStoreConflictError()
        this.assertReviewerWriteAuthorized(
          current,
          record,
          opts.reviewerCapability ?? null,
        )
        const saved = TaskRecord.fromDict({
          ...record.toDict(),
          revision: (current?.revision ?? 0) + 1,
        })
        record.revision = saved.revision
        data[record.id] = saved.toDict()
        this.archiveIfNeeded(data, lease)
        this.write(this.indexFile, data)
        return saved
      },
    )
  }

  delete(
    taskIdValue: string,
    opts: { reviewerCapability?: object | null } = {},
  ): boolean {
    const taskId = String(taskIdValue || '').trim()
    if (!taskId) return false
    return this.goalMutations.withSynchronousMutation(
      'task',
      `delete:${taskId}`,
      (lease) => {
        const data = this.read(this.indexFile, lease)
        if (!(taskId in data)) return false
        const current = data[taskId]
        if (
          isObject(current) &&
          String(current.source) === GOAL_REVIEWER_SOURCE &&
          (!this.reviewerCapability ||
            opts.reviewerCapability !== this.reviewerCapability)
        )
          throw new TaskStoreAuthorityError()
        delete data[taskId]
        rmSync(join(this.tasksDir, taskId), { recursive: true, force: true })
        this.write(this.indexFile, data)
        return true
      },
    )
  }

  deleteIncludingArchive(
    taskIdValue: string,
    opts: { reviewerCapability?: object | null } = {},
  ): boolean {
    const taskId = String(taskIdValue || '').trim()
    if (!taskId) return false
    return this.goalMutations.withSynchronousMutation(
      'task',
      `delete-including-archive:${taskId}`,
      (lease) => {
        const hot = this.read(this.indexFile, lease)
        const hotPayload = hot[taskId]
        if (isObject(hotPayload)) {
          this.assertReviewerDeleteAuthorized(hotPayload, opts)
          delete hot[taskId]
          this.write(this.indexFile, hot)
          rmSync(join(this.tasksDir, taskId), { recursive: true, force: true })
          return true
        }
        if (!existsSync(this.archiveDir)) return false
        for (const name of readdirSync(this.archiveDir)
          .filter((item) => item.endsWith('.json'))
          .sort()
          .reverse()) {
          const path = join(this.archiveDir, name)
          const archived = this.read(path, lease)
          const payload = archived[taskId]
          if (!isObject(payload)) continue
          this.assertReviewerDeleteAuthorized(payload, opts)
          delete archived[taskId]
          if (Object.keys(archived).length === 0) rmSync(path, { force: true })
          else this.write(path, archived)
          rmSync(join(this.tasksDir, taskId), { recursive: true, force: true })
          return true
        }
        return false
      },
    )
  }

  failCompletedReviewerIncludingArchive(
    taskIdValue: string,
    errorValue: string,
    opts: { reviewerCapability?: object | null } = {},
  ): TaskRecord | null {
    const taskId = String(taskIdValue || '').trim()
    if (!taskId) return null
    return this.goalMutations.withSynchronousMutation(
      'task',
      `fail-completed-reviewer:${taskId}`,
      (lease) => {
        const hot = this.read(this.indexFile, lease)
        const hotPayload = hot[taskId]
        if (isObject(hotPayload)) {
          const failed = this.failedReviewerRecord(hotPayload, errorValue, opts)
          hot[taskId] = failed.toDict()
          this.write(this.indexFile, hot)
          return failed
        }
        if (!existsSync(this.archiveDir)) return null
        for (const name of readdirSync(this.archiveDir)
          .filter((item) => item.endsWith('.json'))
          .sort()
          .reverse()) {
          const path = join(this.archiveDir, name)
          const archived = this.read(path, lease)
          const payload = archived[taskId]
          if (!isObject(payload)) continue
          const failed = this.failedReviewerRecord(payload, errorValue, opts)
          archived[taskId] = failed.toDict()
          this.write(path, archived)
          return failed
        }
        return null
      },
    )
  }

  /** 级联删除：仅删除带 session_id stamp 的记录及其 sidechain 目录；legacy 无主记录不动。 */
  deleteBySession(sessionId: string): number {
    const target = String(sessionId || '').trim()
    if (!target) return 0
    return this.goalMutations.withSynchronousMutation(
      'task',
      `delete-session:${target}`,
      (lease) => {
        const data = this.read(this.indexFile, lease)
        let removed = 0
        for (const [taskId, item] of Object.entries(data)) {
          if (!isObject(item) || String(item.session_id ?? '') !== target)
            continue
          delete data[taskId]
          rmSync(join(this.tasksDir, taskId), { recursive: true, force: true })
          removed += 1
        }
        if (removed > 0) this.write(this.indexFile, data)
        return removed
      },
    )
  }

  private archiveIfNeeded(
    data: Record<string, any>,
    lease: GoalMutationLease,
  ): void {
    const terminal = Object.values(data).filter(
      (item) => isObject(item) && TERMINAL.has(String(item.status)),
    )
    if (terminal.length <= this.maxTerminal) return
    terminal.sort(
      (a, b) => Number(a.started_at || 0) - Number(b.started_at || 0),
    )
    const overflow = terminal.slice(0, terminal.length - this.maxTerminal)
    const byMonth = new Map<string, Record<string, any>[]>()
    for (const item of overflow) {
      const month = monthKey(item)
      if (!byMonth.has(month)) byMonth.set(month, [])
      byMonth.get(month)!.push(item)
      delete data[String(item.id)]
    }
    for (const [month, items] of byMonth) this.mergeArchive(month, items, lease)
  }

  private mergeArchive(
    month: string,
    items: Record<string, any>[],
    lease: GoalMutationLease,
  ): void {
    mkdirSync(this.archiveDir, { recursive: true })
    const path = join(this.archiveDir, `${month}.json`)
    const existing = existsSync(path) ? this.read(path, lease) : {}
    for (const item of items) existing[String(item.id)] = item
    this.write(path, existing)
  }

  private getArchived(
    taskId: string,
    lease: GoalMutationLease,
  ): TaskRecord | null {
    if (!existsSync(this.archiveDir)) return null
    for (const name of readdirSync(this.archiveDir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse()) {
      const payload = this.read(join(this.archiveDir, name), lease)[taskId]
      if (isObject(payload)) return TaskRecord.fromDict(payload)
    }
    return null
  }

  private read(path: string, lease: GoalMutationLease): Record<string, any> {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
      return isObject(raw) ? raw : {}
    } catch (error) {
      if (existsSync(path)) {
        this.goalMutations.recordUnderLease(
          lease,
          'task',
          `task-store:recover:${basename(path)}:${Date.now()}`,
        )
        const corrupt = `${path}.corrupt-${Math.trunc(Date.now() / 1000)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
        try {
          renameSync(path, corrupt)
        } catch {
          /* ignore */
        }
        this.write(path, {})
      }
      void error
      return {}
    }
  }

  private write(path: string, data: Record<string, any>): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = join(
      dirname(path),
      `.${basename(path)}.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  }

  private copyLegacyFilesIfNeeded(): void {
    const legacyDir = join(this.root, 'memory', 'tasks')
    if (!existsSync(legacyDir)) return
    const legacyIndex = join(legacyDir, 'index.json')
    if (!existsSync(this.indexFile) && existsSync(legacyIndex)) {
      try {
        copyFileSync(legacyIndex, this.indexFile)
      } catch {
        /* non-destructive best effort */
      }
    }
    const legacyArchive = join(legacyDir, 'archive')
    if (!existsSync(this.archiveDir) && existsSync(legacyArchive)) {
      try {
        cpSync(legacyArchive, this.archiveDir, {
          recursive: true,
          errorOnExist: false,
        })
      } catch {
        /* non-destructive best effort */
      }
    }
    for (const name of readdirSync(legacyDir)) {
      if (!name || name === 'archive' || name === 'index.json') continue
      const source = join(legacyDir, name)
      const dest = join(this.tasksDir, name)
      if (existsSync(dest)) continue
      try {
        cpSync(source, dest, { recursive: true, errorOnExist: false })
      } catch {
        /* non-destructive best effort */
      }
    }
  }

  private assertReviewerWriteAuthorized(
    current: TaskRecord | null,
    candidate: TaskRecord,
    capability: object | null,
  ): void {
    const currentReviewer = current?.source === GOAL_REVIEWER_SOURCE
    const candidateReviewer = candidate.source === GOAL_REVIEWER_SOURCE
    if (!currentReviewer && !candidateReviewer) return
    if (!this.reviewerCapability || capability !== this.reviewerCapability)
      throw new TaskStoreAuthorityError()
    if (current && !currentReviewer)
      throw new TaskStoreAuthorityError(
        'An ordinary Task cannot be promoted into a Goal reviewer Task.',
      )
    if (!candidateReviewer || !validReviewerProvenance(candidate))
      throw new TaskStoreAuthorityError(
        'Goal reviewer Task provenance is invalid or was removed.',
      )
    if (
      currentReviewer &&
      canonicalReviewerProvenance(current!) !==
        canonicalReviewerProvenance(candidate)
    )
      throw new TaskStoreAuthorityError(
        'Goal reviewer Task provenance is immutable.',
      )
  }

  private assertReviewerDeleteAuthorized(
    current: Record<string, unknown>,
    opts: { reviewerCapability?: object | null },
  ): void {
    if (
      String(current.source) === GOAL_REVIEWER_SOURCE &&
      (!this.reviewerCapability ||
        opts.reviewerCapability !== this.reviewerCapability)
    )
      throw new TaskStoreAuthorityError()
  }

  private failedReviewerRecord(
    payload: Record<string, unknown>,
    errorValue: string,
    opts: { reviewerCapability?: object | null },
  ): TaskRecord {
    this.assertReviewerDeleteAuthorized(payload, opts)
    const current = TaskRecord.fromDict(payload)
    if (
      current.source !== GOAL_REVIEWER_SOURCE ||
      current.status !== 'completed'
    )
      throw new TaskStoreAuthorityError(
        'Only a completed Goal reviewer Task can be invalidated after receipt failure.',
      )
    return TaskRecord.fromDict({
      ...current.toDict(),
      status: 'failed',
      ended_at: Date.now() / 1000,
      progress: {
        ...current.progress,
        error: String(
          errorValue || 'Goal reviewer receipt persistence failed.',
        ),
        receipt_persisted: false,
      },
    })
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function monthKey(item: Record<string, any>): string {
  const ts = Number(item.started_at || Date.now() / 1000)
  return new Date(ts * 1000).toISOString().slice(0, 7)
}

function validReviewerProvenance(record: TaskRecord): boolean {
  const metadata = record.metadata
  return Boolean(
    record.kind === 'subagent' &&
    record.turn_id &&
    record.session_id &&
    record.transcript_path &&
    metadata.issued_by === 'core' &&
    metadata.agent_type === 'verification_reviewer' &&
    String(metadata.agent_id ?? '') &&
    metadata.turn_id === record.turn_id &&
    String(metadata.goal_id ?? '') &&
    String(metadata.plan_id ?? '') &&
    Number.isInteger(Number(metadata.plan_event_seq)) &&
    Number(metadata.plan_event_seq) > 0,
  )
}

function canonicalReviewerProvenance(record: TaskRecord): string {
  return JSON.stringify({
    id: record.id,
    kind: record.kind,
    title: record.title,
    source: record.source,
    started_at: record.started_at,
    turn_id: record.turn_id,
    tool_call_id: record.tool_call_id,
    job_id: record.job_id,
    session_id: record.session_id,
    transcript_path: record.transcript_path,
    metadata: record.metadata,
  })
}
