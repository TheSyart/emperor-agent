/**
 * PlanStore (MIG-CTRL-012)。对齐 Python `agent/plans/store.py`。
 * 磁盘格式: <root>/memory/plans/index.json，按 plan id 的字典；indent=2；腐坏隔离为 index.json.corrupt-*。
 */
import {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { planFromDict, planToDict, PlanStatus, type PlanRecord } from './models'
import { GoalGateMutationLedger } from '../goals/mutation-ledger'
import type { GoalMutationLease } from '../goals/mutation-guard'

const TERMINAL = new Set<string>([
  PlanStatus.COMPLETED,
  PlanStatus.FAILED,
  PlanStatus.CANCELLED,
])

const APPROVAL_INTENT_KEY = 'goal_approval_intent'
const SKIP_INTENT_KEY = 'goal_skip_intent'
const QUARANTINE_WRITE_ATTEMPTS = 3

export interface PlanApprovalIntent {
  readonly code:
    'goal_plan_approval_prepared' | 'goal_plan_compensation_required'
  readonly goalId: string
  readonly interactionId: string
  readonly approvalGeneration: number
  readonly preparedAt: number
}

export type PlanSkipIntentStage =
  | 'intent_persisted'
  | 'plan_skipped'
  | 'tasks_synced'
  | 'todo_synced'
  | 'completed'

export interface PlanSkipIntent {
  readonly version: 1
  readonly goalId: string
  readonly planId: string
  readonly approvalGeneration: number
  readonly stepId: string
  readonly receiptId: string
  readonly startedAt: number
  readonly stage: PlanSkipIntentStage
}

const SKIP_INTENT_STAGE_ORDER: Readonly<Record<PlanSkipIntentStage, number>> = {
  intent_persisted: 0,
  plan_skipped: 1,
  tasks_synced: 2,
  todo_synced: 3,
  completed: 4,
}

const PLAN_STATUS_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    [PlanStatus.DRAFT]: new Set([
      PlanStatus.DRAFT,
      PlanStatus.WAITING_APPROVAL,
      PlanStatus.CANCELLED,
    ]),
    [PlanStatus.WAITING_APPROVAL]: new Set([
      PlanStatus.WAITING_APPROVAL,
      PlanStatus.DRAFT,
      PlanStatus.APPROVED,
      PlanStatus.CANCELLED,
    ]),
    [PlanStatus.APPROVED]: new Set([
      PlanStatus.APPROVED,
      PlanStatus.EXECUTING,
      PlanStatus.CANCELLED,
    ]),
    [PlanStatus.EXECUTING]: new Set([
      PlanStatus.EXECUTING,
      PlanStatus.COMPLETED,
      PlanStatus.FAILED,
      PlanStatus.CANCELLED,
    ]),
    [PlanStatus.COMPLETED]: new Set([PlanStatus.COMPLETED]),
    [PlanStatus.FAILED]: new Set([PlanStatus.FAILED]),
    [PlanStatus.CANCELLED]: new Set([PlanStatus.CANCELLED]),
  })

export class PlanStoreConflictError extends Error {
  readonly code = 'plan_store_conflict'
  constructor(message = 'Plan write conflicts with the current snapshot.') {
    super(message)
    this.name = 'PlanStoreConflictError'
  }
}

export class PlanStore {
  readonly root: string
  readonly planDir: string
  readonly indexFile: string
  readonly archiveDir: string
  readonly quarantineFile: string
  readonly maxTerminal: number
  private readonly quarantinedMemory = new Set<string>()
  private readonly goalMutations: GoalGateMutationLedger

  constructor(root: string, opts: { maxTerminal?: number } = {}) {
    this.root = resolve(root)
    this.planDir = join(this.root, 'memory', 'plans')
    this.indexFile = join(this.planDir, 'index.json')
    this.archiveDir = join(this.planDir, 'archive')
    this.quarantineFile = join(this.planDir, 'quarantine.json')
    this.maxTerminal = Math.max(1, Math.trunc(opts.maxTerminal ?? 500))
    this.goalMutations = new GoalGateMutationLedger(this.root)
    if (!existsSync(this.indexFile))
      this.goalMutations.withSynchronousMutation(
        'plan',
        'plan-store:init',
        () => {
          mkdirSync(this.planDir, { recursive: true })
          if (!existsSync(this.indexFile)) this.write({})
        },
      )
  }

  list(): PlanRecord[] {
    return this.goalMutations.guard.runExclusiveSync('mutation', (lease) => {
      const data = this.read(lease)
      return Object.values(data)
        .filter((item) => item && typeof item === 'object')
        .map((item) => planFromDict(item as Record<string, unknown>))
    })
  }

  get(planId: string): PlanRecord | null {
    return this.goalMutations.guard.runExclusiveSync('mutation', (lease) => {
      const payload = this.read(lease)[String(planId)]
      if (payload && typeof payload === 'object')
        return planFromDict(payload as Record<string, unknown>)
      return this.getArchived(String(planId), lease)
    })
  }

  inspect(planId: string): {
    record: PlanRecord | null
    issue: { code: 'plan_store_corrupt'; path: string } | null
  } {
    if (!existsSync(this.indexFile)) return { record: null, issue: null }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.indexFile, 'utf8') || '{}')
    } catch {
      return {
        record: null,
        issue: { code: 'plan_store_corrupt', path: this.indexFile },
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return {
        record: null,
        issue: { code: 'plan_store_corrupt', path: this.indexFile },
      }
    const payload = (raw as Record<string, unknown>)[String(planId)]
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return { record: null, issue: null }
    try {
      return {
        record: planFromDict(payload as Record<string, unknown>),
        issue: null,
      }
    } catch {
      return {
        record: null,
        issue: { code: 'plan_store_corrupt', path: this.indexFile },
      }
    }
  }

  /**
   * Read-only lookup across the hot index and immutable monthly archives.
   * Unlike `get()`, this never repairs corrupt JSON, creates directories, or
   * records a Goal mutation. Completion-gate callers must use this path.
   */
  inspectIncludingArchive(planId: string): {
    record: PlanRecord | null
    issue: { code: 'plan_store_corrupt'; path: string } | null
  } {
    const hot = this.inspect(planId)
    if (hot.record || hot.issue || !existsSync(this.archiveDir)) return hot
    let names: string[]
    try {
      names = readdirSync(this.archiveDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .reverse()
    } catch {
      return {
        record: null,
        issue: { code: 'plan_store_corrupt', path: this.archiveDir },
      }
    }
    for (const name of names) {
      const path = join(this.archiveDir, name)
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
      } catch {
        return {
          record: null,
          issue: { code: 'plan_store_corrupt', path },
        }
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {
          record: null,
          issue: { code: 'plan_store_corrupt', path },
        }
      const payload = (raw as Record<string, unknown>)[String(planId)]
      if (!payload) continue
      if (typeof payload !== 'object' || Array.isArray(payload))
        return {
          record: null,
          issue: { code: 'plan_store_corrupt', path },
        }
      try {
        return {
          record: planFromDict(payload as Record<string, unknown>),
          issue: null,
        }
      } catch {
        return {
          record: null,
          issue: { code: 'plan_store_corrupt', path },
        }
      }
    }
    return { record: null, issue: null }
  }

  inspectAllIncludingArchives(): {
    records: readonly PlanRecord[]
    issue: { code: 'plan_store_corrupt'; path: string } | null
  } {
    const paths = [
      ...(existsSync(this.indexFile) ? [this.indexFile] : []),
      ...(existsSync(this.archiveDir)
        ? readdirSync(this.archiveDir)
            .filter((name) => name.endsWith('.json'))
            .sort()
            .map((name) => join(this.archiveDir, name))
        : []),
    ]
    const records: PlanRecord[] = []
    const ids = new Set<string>()
    for (const path of paths) {
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
      } catch {
        return { records: [], issue: { code: 'plan_store_corrupt', path } }
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { records: [], issue: { code: 'plan_store_corrupt', path } }
      try {
        for (const payload of Object.values(raw as Record<string, unknown>)) {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload))
            throw new Error('invalid Plan payload')
          const record = planFromDict(payload as Record<string, unknown>)
          if (ids.has(record.id)) throw new Error('duplicate Plan id')
          ids.add(record.id)
          records.push(record)
        }
      } catch {
        return { records: [], issue: { code: 'plan_store_corrupt', path } }
      }
    }
    return {
      records: records.sort((left, right) => left.id.localeCompare(right.id)),
      issue: null,
    }
  }

  inspectQuarantine(planId: string): {
    quarantined: boolean
    issue: { code: 'plan_store_corrupt'; path: string } | null
  } {
    const id = String(planId).trim()
    if (!id || !existsSync(this.quarantineFile))
      return { quarantined: false, issue: null }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.quarantineFile, 'utf8') || '{}')
    } catch {
      return {
        quarantined: true,
        issue: { code: 'plan_store_corrupt', path: this.quarantineFile },
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return {
        quarantined: true,
        issue: { code: 'plan_store_corrupt', path: this.quarantineFile },
      }
    return {
      quarantined: Boolean((raw as Record<string, unknown>)[id]),
      issue: null,
    }
  }

  latest(): PlanRecord | null {
    const plans = this.list()
    if (!plans.length) return null
    return plans.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
  }

  prepareApprovalQuarantine(opts: {
    planId: string
    goalId: string
    interactionId: string
    approvalGeneration: number
    preparedAt?: number
  }): PlanRecord {
    const planId = String(opts.planId).trim()
    const goalId = String(opts.goalId).trim()
    const interactionId = String(opts.interactionId).trim()
    const approvalGeneration = Number(opts.approvalGeneration)
    if (
      !planId ||
      !goalId ||
      !interactionId ||
      !Number.isInteger(approvalGeneration) ||
      approvalGeneration < 1
    )
      throw new Error('Goal Plan approval quarantine identity is invalid.')
    let record = this.get(planId)
    if (!record) throw new Error('Plan does not exist')
    const intent: PlanApprovalIntent = {
      code: 'goal_plan_approval_prepared',
      goalId,
      interactionId,
      approvalGeneration,
      preparedAt: Number(opts.preparedAt ?? Date.now() / 1000),
    }
    const existing = planApprovalIntent(record)
    if (existing && !approvalIntentsMatch(existing, intent))
      throw new Error('Plan approval quarantine belongs to another approval.')
    if (!existing) {
      record = this.save({
        ...record,
        metadata: {
          ...record.metadata,
          [APPROVAL_INTENT_KEY]: approvalIntentToDict(intent),
        },
      })
    }
    this.quarantine(planId, intent.code, approvalIntentToDict(intent))
    return record
  }

  quarantine(
    planId: string,
    code = 'goal_plan_compensation_required',
    details: Record<string, unknown> = {},
  ): void {
    const id = String(planId).trim()
    if (!id) return
    this.goalMutations.withSynchronousMutation(
      'plan',
      `quarantine:${id}:${Date.now()}`,
      (lease) => {
        this.quarantinedMemory.add(id)
        this.retryQuarantineWrite(() =>
          this.withWriteLock(() => {
            const data = existsSync(this.quarantineFile)
              ? this.readAt(this.quarantineFile, lease)
              : {}
            data[id] = {
              ...details,
              code,
              quarantined_at: Date.now() / 1000,
            }
            this.writeAt(this.quarantineFile, data)
          }),
        )
      },
    )
  }

  clearQuarantine(planId: string): void {
    const id = String(planId).trim()
    if (!id) return
    this.goalMutations.withSynchronousMutation(
      'plan',
      `quarantine-clear:${id}:${Date.now()}`,
      (lease) => {
        this.retryQuarantineWrite(() =>
          this.withWriteLock(() => {
            const data = existsSync(this.quarantineFile)
              ? this.readAt(this.quarantineFile, lease)
              : {}
            delete data[id]
            this.writeAt(this.quarantineFile, data)
          }),
        )
        this.quarantinedMemory.delete(id)
      },
    )
  }

  clearApprovalQuarantine(planId: string): void {
    const id = String(planId).trim()
    if (!id) return
    for (let attempt = 0; attempt < QUARANTINE_WRITE_ATTEMPTS; attempt += 1) {
      const record = this.get(id)
      if (!record || !planApprovalIntent(record)) break
      const metadata = { ...record.metadata }
      delete metadata[APPROVAL_INTENT_KEY]
      try {
        this.save({ ...record, metadata })
        break
      } catch (cause) {
        if (
          !(cause instanceof PlanStoreConflictError) ||
          attempt === QUARANTINE_WRITE_ATTEMPTS - 1
        )
          throw cause
      }
    }
    this.clearQuarantine(id)
  }

  isQuarantined(planId: string): boolean {
    const id = String(planId).trim()
    if (!id) return false
    if (this.quarantinedMemory.has(id)) return true
    if (planApprovalIntent(this.get(id))) {
      this.quarantinedMemory.add(id)
      return true
    }
    if (!existsSync(this.quarantineFile)) return false
    const quarantined = this.goalMutations.guard.runExclusiveSync(
      'mutation',
      (lease) => Boolean(this.readAt(this.quarantineFile, lease)[id]),
    )
    if (quarantined) this.quarantinedMemory.add(id)
    return quarantined
  }

  isExecutionBlocked(planId: string): boolean {
    const id = String(planId).trim()
    if (!id) return false
    return this.isQuarantined(id) || hasBlockingSkipIntent(this.get(id))
  }

  listQuarantined(): string[] {
    const disk = existsSync(this.quarantineFile)
      ? this.goalMutations.guard.runExclusiveSync('mutation', (lease) =>
          Object.keys(this.readAt(this.quarantineFile, lease)),
        )
      : []
    for (const id of disk) this.quarantinedMemory.add(id)
    for (const plan of this.list()) {
      if (planApprovalIntent(plan)) this.quarantinedMemory.add(plan.id)
    }
    return [...this.quarantinedMemory].sort()
  }

  save(
    record: PlanRecord,
    opts: { expectedEventSeq?: number } = {},
  ): PlanRecord {
    return this.goalMutations.guard.runExclusiveSync('mutation', (lease) =>
      this.withWriteLock(() => {
        const data = this.read(lease)
        const hot = data[record.id]
        const current =
          hot && typeof hot === 'object'
            ? planFromDict(hot as Record<string, unknown>)
            : this.getArchived(record.id, lease)
        const expectedEventSeq = Math.max(
          0,
          Math.trunc(opts.expectedEventSeq ?? record.eventSeq),
        )
        if ((current?.eventSeq ?? 0) !== expectedEventSeq)
          throw new PlanStoreConflictError()
        if (current) assertMonotonicMutation(current, record)
        else assertInitialSkipIntent(record)
        const saved = { ...record, eventSeq: (current?.eventSeq ?? 0) + 1 }
        this.goalMutations.recordUnderLease(
          lease,
          'plan',
          `${saved.id}:${saved.eventSeq}`,
        )
        data[record.id] = planToDict(saved)
        this.archiveIfNeeded(data, lease)
        this.write(data)
        return saved
      }),
    )
  }

  /**
   * Commit a related set of Plan mutations with one atomic index replacement.
   * Validation is completed for the whole batch before any record is changed,
   * so a Plan replacement never exposes cancelled predecessors without its
   * successor draft.
   */
  saveBatch(records: readonly PlanRecord[]): PlanRecord[] {
    if (!records.length) return []
    const ids = new Set<string>()
    for (const record of records) {
      if (ids.has(record.id))
        throw new Error(`duplicate Plan batch id: ${record.id}`)
      ids.add(record.id)
    }
    return this.goalMutations.guard.runExclusiveSync('mutation', (lease) =>
      this.withWriteLock(() => {
        const data = this.read(lease)
        const prepared = records.map((record) => {
          const hot = data[record.id]
          const current =
            hot && typeof hot === 'object'
              ? planFromDict(hot as Record<string, unknown>)
              : this.getArchived(record.id, lease)
          if ((current?.eventSeq ?? 0) !== Math.max(0, record.eventSeq))
            throw new PlanStoreConflictError()
          if (current) assertMonotonicMutation(current, record)
          else assertInitialSkipIntent(record)
          return {
            ...record,
            eventSeq: (current?.eventSeq ?? 0) + 1,
          }
        })
        for (const saved of prepared) {
          this.goalMutations.recordUnderLease(
            lease,
            'plan',
            `${saved.id}:${saved.eventSeq}`,
          )
          data[saved.id] = planToDict(saved)
        }
        this.archiveIfNeeded(data, lease)
        this.write(data)
        return prepared
      }),
    )
  }

  /** 级联删除：仅删除带 session_id stamp 的计划；legacy 无主计划不动。 */
  deleteBySession(sessionId: string): number {
    const target = String(sessionId || '').trim()
    if (!target) return 0
    return this.goalMutations.guard.runExclusiveSync('mutation', (lease) =>
      this.withWriteLock(() => {
        const data = this.read(lease)
        let removed = 0
        for (const [planId, item] of Object.entries(data)) {
          if (!item || typeof item !== 'object') continue
          if (
            String((item as Record<string, unknown>).session_id ?? '') !==
            target
          )
            continue
          delete data[planId]
          removed += 1
        }
        if (removed > 0) {
          this.goalMutations.recordUnderLease(
            lease,
            'plan',
            `delete-session:${target}:${removed}`,
          )
          this.write(data)
        }
        return removed
      }),
    )
  }

  /**
   * 审计 P1-4：index.json 此前无归档，永久累积所有计划——对齐 tasks/store.ts 已有的
   * "终态超阈值按月归档，进行中的计划永不归档" 模式，避免热索引无界增长。
   */
  private archiveIfNeeded(
    data: Record<string, unknown>,
    lease: GoalMutationLease,
  ): void {
    const terminal = Object.values(data).filter(
      (item): item is Record<string, unknown> => {
        if (!item || typeof item !== 'object') return false
        const record = planFromDict(item as Record<string, unknown>)
        return TERMINAL.has(record.status) && !hasBlockingSkipIntent(record)
      },
    )
    if (terminal.length <= this.maxTerminal) return
    terminal.sort(
      (a, b) => Number(a.updated_at || 0) - Number(b.updated_at || 0),
    )
    const overflow = terminal.slice(0, terminal.length - this.maxTerminal)
    const byMonth = new Map<string, Record<string, unknown>[]>()
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
    items: Record<string, unknown>[],
    lease: GoalMutationLease,
  ): void {
    mkdirSync(this.archiveDir, { recursive: true })
    const path = join(this.archiveDir, `${month}.json`)
    const existing = existsSync(path) ? this.readAt(path, lease) : {}
    for (const item of items) existing[String(item.id)] = item
    this.writeAt(path, existing)
  }

  private getArchived(
    planId: string,
    lease: GoalMutationLease,
  ): PlanRecord | null {
    if (!existsSync(this.archiveDir)) return null
    for (const name of readdirSync(this.archiveDir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse()) {
      const payload = this.readAt(join(this.archiveDir, name), lease)[planId]
      if (payload && typeof payload === 'object')
        return planFromDict(payload as Record<string, unknown>)
    }
    return null
  }

  private read(lease: GoalMutationLease): Record<string, unknown> {
    return this.readAt(this.indexFile, lease, { onCorruptWriteEmpty: true })
  }

  private write(data: Record<string, unknown>): void {
    this.writeAt(this.indexFile, data)
  }

  private readAt(
    path: string,
    lease: GoalMutationLease,
    opts: { onCorruptWriteEmpty?: boolean } = {},
  ): Record<string, unknown> {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
    } catch {
      this.goalMutations.recordUnderLease(
        lease,
        'plan',
        `plan-store:recover:${basename(path)}:${Date.now()}`,
      )
      const corrupt = `${path}.corrupt-${Math.trunc(Date.now() / 1000)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
      try {
        renameSync(path, corrupt)
      } catch {
        /* ignore */
      }
      if (opts.onCorruptWriteEmpty) this.writeAt(path, {})
      return {}
    }
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  }

  private writeAt(path: string, data: Record<string, unknown>): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = join(
      dirname(path),
      `.${basename(path)}.${randomUUID().replace(/-/g, '')}.tmp`,
    )
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  }

  private retryQuarantineWrite(action: () => void): void {
    let lastError: unknown = null
    for (let attempt = 0; attempt < QUARANTINE_WRITE_ATTEMPTS; attempt += 1) {
      try {
        action()
        return
      } catch (cause) {
        lastError = cause
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Plan quarantine persistence failed.')
  }

  private withWriteLock<T>(action: () => T): T {
    const lockPath = `${this.indexFile}.lock`
    const deadline = Date.now() + 5_000
    let handle: number | null = null
    while (handle === null) {
      try {
        handle = openSync(lockPath, 'wx')
        writeFileSync(handle, String(process.pid), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000)
            unlinkSync(lockPath)
        } catch {
          // Another writer released or recovered the lock.
        }
        if (Date.now() > deadline)
          throw new PlanStoreConflictError('Plan store lock timed out.')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
    }
    try {
      return action()
    } finally {
      closeSync(handle)
      try {
        unlinkSync(lockPath)
      } catch {
        // A stale-lock recovery may already have removed it.
      }
    }
  }
}

export function planApprovalIntent(
  record: PlanRecord | null | undefined,
): PlanApprovalIntent | null {
  const raw = record?.metadata[APPROVAL_INTENT_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const code = String(item.code ?? '')
  const goalId = String(item.goal_id ?? '').trim()
  const interactionId = String(item.interaction_id ?? '').trim()
  const approvalGeneration = Number(item.approval_generation)
  const preparedAt = Number(item.prepared_at)
  if (
    (code !== 'goal_plan_approval_prepared' &&
      code !== 'goal_plan_compensation_required') ||
    !goalId ||
    !interactionId ||
    !Number.isInteger(approvalGeneration) ||
    approvalGeneration < 1 ||
    !Number.isFinite(preparedAt)
  )
    return null
  return { code, goalId, interactionId, approvalGeneration, preparedAt }
}

export function planSkipIntent(
  record: PlanRecord | null | undefined,
): PlanSkipIntent | null {
  const raw = record?.metadata[SKIP_INTENT_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const stage = String(item.stage ?? '') as PlanSkipIntentStage
  const intent: PlanSkipIntent = {
    version: 1,
    goalId: String(item.goal_id ?? '').trim(),
    planId: String(item.plan_id ?? '').trim(),
    approvalGeneration: Number(item.approval_generation),
    stepId: String(item.step_id ?? '').trim(),
    receiptId: String(item.receipt_id ?? '').trim(),
    startedAt: Number(item.started_at),
    stage,
  }
  return Number(item.version) === 1 &&
    intent.goalId &&
    intent.planId === record?.id &&
    Number.isInteger(intent.approvalGeneration) &&
    intent.approvalGeneration > 0 &&
    intent.stepId &&
    intent.receiptId &&
    Number.isFinite(intent.startedAt) &&
    Object.hasOwn(SKIP_INTENT_STAGE_ORDER, stage)
    ? intent
    : null
}

function hasBlockingSkipIntent(record: PlanRecord | null | undefined): boolean {
  if (!record || record.metadata[SKIP_INTENT_KEY] === undefined) return false
  const intent = planSkipIntent(record)
  return !intent || intent.stage !== 'completed'
}

function approvalIntentToDict(
  intent: PlanApprovalIntent,
): Record<string, unknown> {
  return {
    code: intent.code,
    goal_id: intent.goalId,
    interaction_id: intent.interactionId,
    approval_generation: intent.approvalGeneration,
    prepared_at: intent.preparedAt,
  }
}

function approvalIntentsMatch(
  left: PlanApprovalIntent,
  right: PlanApprovalIntent,
): boolean {
  return (
    left.goalId === right.goalId &&
    left.interactionId === right.interactionId &&
    left.approvalGeneration === right.approvalGeneration
  )
}

function assertMonotonicMutation(
  current: PlanRecord,
  candidate: PlanRecord,
): void {
  if (!PLAN_STATUS_TRANSITIONS[current.status]?.has(candidate.status))
    throw new PlanStoreConflictError('Plan status cannot move backwards.')
  if (
    current.approvedAt !== null &&
    candidate.approvedAt !== current.approvedAt
  )
    throw new PlanStoreConflictError('Plan approval cannot be rewritten.')
  if (
    current.approvedAt === null &&
    candidate.approvedAt !== null &&
    !(
      current.status === PlanStatus.WAITING_APPROVAL &&
      candidate.status === PlanStatus.APPROVED
    )
  )
    throw new PlanStoreConflictError(
      'Plan approval can only be set during approval transition.',
    )
  const tokensRevoked = Boolean(current.metadata.permission_tokens_revoked)
  if (tokensRevoked && !candidate.metadata.permission_tokens_revoked)
    throw new PlanStoreConflictError('Plan token revocation is permanent.')
  const candidateTokens = candidate.metadata.permission_tokens
  if (
    tokensRevoked &&
    Array.isArray(candidateTokens) &&
    candidateTokens.length > 0
  )
    throw new PlanStoreConflictError('Revoked Plan tokens cannot be restored.')
  assertSkipIntentMonotonic(current, candidate)
  if (
    TERMINAL.has(current.status) &&
    (!terminalStepsAppendOnly(current, candidate) ||
      current.completedAt !== candidate.completedAt ||
      current.goalId !== candidate.goalId ||
      current.sessionId !== candidate.sessionId ||
      current.supersedesPlanId !== candidate.supersedesPlanId)
  )
    throw new PlanStoreConflictError(
      'Terminal Plan execution fields cannot be rewritten.',
    )
}

function assertSkipIntentMonotonic(
  current: PlanRecord,
  candidate: PlanRecord,
): void {
  const currentRaw = current.metadata[SKIP_INTENT_KEY]
  const candidateRaw = candidate.metadata[SKIP_INTENT_KEY]
  const currentIntent = planSkipIntent(current)
  const candidateIntent = planSkipIntent(candidate)
  if (candidateRaw !== undefined && candidateIntent === null)
    throw new PlanStoreConflictError('Plan skip intent is invalid.')
  if (currentRaw !== undefined && currentIntent === null)
    throw new PlanStoreConflictError('Current Plan skip intent is invalid.')
  if (!currentIntent) {
    if (candidateIntent && candidateIntent.stage !== 'intent_persisted')
      throw new PlanStoreConflictError(
        'Plan skip intent must begin at intent_persisted.',
      )
    return
  }
  if (!candidateIntent)
    throw new PlanStoreConflictError('Plan skip intent cannot be removed.')
  if (!skipIntentIdentityMatches(currentIntent, candidateIntent)) {
    if (
      currentIntent.stage !== 'completed' ||
      candidateIntent.stage !== 'intent_persisted' ||
      candidateIntent.goalId !== currentIntent.goalId ||
      candidateIntent.planId !== currentIntent.planId ||
      candidateIntent.approvalGeneration !== currentIntent.approvalGeneration ||
      candidateIntent.startedAt < currentIntent.startedAt
    )
      throw new PlanStoreConflictError(
        'Plan skip intent identity cannot change before completion.',
      )
    return
  }
  const stageDelta =
    SKIP_INTENT_STAGE_ORDER[candidateIntent.stage] -
    SKIP_INTENT_STAGE_ORDER[currentIntent.stage]
  if (stageDelta < 0)
    throw new PlanStoreConflictError('Plan skip intent cannot move backwards.')
  if (stageDelta > 1)
    throw new PlanStoreConflictError(
      'Plan skip intent must advance exactly one stage at a time.',
    )
}

function assertInitialSkipIntent(candidate: PlanRecord): void {
  const raw = candidate.metadata[SKIP_INTENT_KEY]
  if (raw === undefined) return
  const intent = planSkipIntent(candidate)
  if (!intent) throw new PlanStoreConflictError('Plan skip intent is invalid.')
  if (intent.stage !== 'intent_persisted')
    throw new PlanStoreConflictError(
      'Plan skip intent must begin at intent_persisted.',
    )
}

function skipIntentIdentityMatches(
  left: PlanSkipIntent,
  right: PlanSkipIntent,
): boolean {
  return (
    left.goalId === right.goalId &&
    left.planId === right.planId &&
    left.approvalGeneration === right.approvalGeneration &&
    left.stepId === right.stepId &&
    left.receiptId === right.receiptId &&
    left.startedAt === right.startedAt
  )
}

function terminalStepsAppendOnly(
  current: PlanRecord,
  candidate: PlanRecord,
): boolean {
  if (current.steps.length !== candidate.steps.length) return false
  return current.steps.every((step, index) => {
    const next = candidate.steps[index]
    if (!next || step.id !== next.id) return false
    const { evidence, ...stable } = step
    const { evidence: nextEvidence, ...nextStable } = next
    if (JSON.stringify(stable) !== JSON.stringify(nextStable)) return false
    if (nextEvidence.length < evidence.length) return false
    return evidence.every(
      (item, evidenceIndex) =>
        JSON.stringify(item) === JSON.stringify(nextEvidence[evidenceIndex]),
    )
  })
}

function monthKey(item: Record<string, unknown>): string {
  const ts = Number(item.updated_at || Date.now() / 1000)
  return new Date(ts * 1000).toISOString().slice(0, 7)
}
