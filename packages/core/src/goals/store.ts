import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { EmperorError } from '../errors'
import { readJsonl, type ReadJsonlResult } from '../store/jsonl'
import {
  AppendOnlyJournal,
  AtomicSnapshot,
  PersistenceCorruptionError,
  type JournalCodec,
  type PersistenceAdapter,
  type SnapshotCodec,
} from '../store/persistence'
import {
  isGoalTerminal,
  type GoalPhase,
  type GoalRecord,
  type GoalStatus,
} from './models'
import {
  GOAL_EVENT_SCHEMA_VERSION,
  GoalJsonValueError,
  computeGoalEventHash,
  createGoalEventEnvelope,
  normalizeJsonValue,
  parseGoalEventEnvelope,
  type GoalDomainEventType,
  type GoalEventEnvelope,
  type GoalEventPayload,
  type JsonObject,
  type JsonValue,
} from './events'
import {
  GoalDomainError,
  assertGoalTransition,
  parseGoalRecord,
} from './validation'
import { GoalGateMutationLedger } from './mutation-ledger'
import type { GoalMutationLease } from './mutation-guard'
import { registerGoalTerminalCommitter } from './goal-terminal-internal'
import type { GoalTerminalCommitInput } from './contracts/completion'
export type { GoalTerminalCommitInput } from './contracts/completion'

export const GOAL_INDEX_SCHEMA_VERSION = 'emperor.goal.index.v1' as const

export interface GoalIndexEntry {
  readonly id: string
  readonly sessionId: string
  readonly status: GoalStatus
  readonly phase: GoalPhase
  readonly outcomePreview: string
  readonly updatedAt: string
  readonly terminalAt: string | null
}

export type GoalRecoveryIssueCode =
  'snapshot_stale' | 'event_corrupt' | 'hash_chain_broken' | 'scope_missing'

export interface GoalRecoveryIssue {
  readonly goalId: string
  readonly code: GoalRecoveryIssueCode
  readonly path: string
  readonly recovered: boolean
}

export interface GoalStoreDiagnostics {
  readonly root: string
  readonly issues: readonly GoalRecoveryIssue[]
  readonly recoveryRequired: number
  readonly indexRebuilt: boolean
  readonly indexCorruptBackup: string | null
  readonly observationCorruptions: ReadonlyArray<{
    goalId: string
    path: string
    badLines: number
  }>
  readonly deleteFailures: ReadonlyArray<{
    sessionId: string
    goalId: string
  }>
}

export interface GoalStoreInspection {
  readonly record: GoalRecord | null
  readonly issue: GoalRecoveryIssue | null
}

export interface GoalStoreHooks {
  readonly beforeEventAppend?: (
    context: GoalWriteContext,
  ) => void | Promise<void>
  readonly afterEventSync?: (context: GoalWriteContext) => void | Promise<void>
  readonly beforeSnapshotWrite?: (
    context: GoalWriteContext,
  ) => void | Promise<void>
  readonly beforeIndexWrite?: (
    context: GoalWriteContext,
  ) => void | Promise<void>
  readonly beforeDeleteRemove?: (context: {
    readonly sessionId: string
    readonly goalIds: readonly string[]
  }) => void | Promise<void>
  readonly afterDiagnosticsRead?: () => void | Promise<void>
  readonly beforeDiagnosticsUpdate?: () => void | Promise<void>
  readonly beforeDiagnosticsWrite?: () => void | Promise<void>
  /**
   * Best-effort projection hook invoked only after the domain event, snapshot,
   * and index are durable. Projection failures never roll back Goal truth.
   */
  readonly afterCommit?: (context: GoalCommitContext) => void | Promise<void>
}

export interface GoalWriteContext {
  readonly goalId: string
  readonly seq: number
  readonly type: GoalDomainEventType
}

export interface GoalCommitContext extends GoalWriteContext {
  readonly event: GoalEventEnvelope<GoalEventPayload>
  readonly previous: GoalRecord | null
  readonly record: GoalRecord
}

export interface GoalAppendInput {
  readonly type: Exclude<
    GoalDomainEventType,
    'goal_created' | 'goal_completed' | 'goal_blocked'
  >
  readonly record: GoalRecord
  readonly createdAt?: string
  readonly data?: Readonly<JsonObject>
  readonly expectedLastEventSeq?: number
}

interface GoalEventInput extends Omit<GoalAppendInput, 'type'> {
  readonly type: GoalDomainEventType
}

export interface GoalStoreOptions {
  readonly hooks?: GoalStoreHooks
  readonly now?: () => string
  readonly persistenceAdapter?: PersistenceAdapter
}

interface GoalIndexDocument {
  readonly schemaVersion: typeof GOAL_INDEX_SCHEMA_VERSION
  readonly goals: readonly GoalIndexEntry[]
}

interface MutableDiagnostics {
  issues: GoalRecoveryIssue[]
  indexRebuilt: boolean
  indexCorruptBackup: string | null
  observationCorruptions: Array<{
    goalId: string
    path: string
    badLines: number
  }>
  deleteFailures: Array<{ sessionId: string; goalId: string }>
}

interface LedgerReadResult {
  events: GoalEventEnvelope<GoalEventPayload>[]
  issue: GoalRecoveryIssue | null
  trustedRecord: GoalRecord | null
}

export class GoalStoreError extends EmperorError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}

export class GoalStore {
  readonly stateRoot: string
  readonly goalsRoot: string
  readonly indexPath: string
  readonly diagnosticsPath: string

  private readonly hooks: GoalStoreHooks
  private readonly now: () => string
  private readonly persistenceAdapter?: PersistenceAdapter
  private readonly mutationLedger: GoalGateMutationLedger
  private activeMutationLease: GoalMutationLease | null = null
  private diagnosticsLoaded = false
  private diagnosticsLoadPromise: Promise<void> | null = null
  private diagnosticsState: MutableDiagnostics = emptyDiagnostics()

  constructor(stateRoot: string, options: GoalStoreOptions = {}) {
    this.stateRoot = resolve(stateRoot)
    this.goalsRoot = join(this.stateRoot, 'goals')
    this.indexPath = join(this.goalsRoot, 'index.json')
    this.diagnosticsPath = join(this.goalsRoot, 'diagnostics.json')
    this.hooks = options.hooks ?? {}
    this.now = options.now ?? (() => new Date().toISOString())
    this.persistenceAdapter = options.persistenceAdapter
    this.mutationLedger = new GoalGateMutationLedger(this.stateRoot)
    registerGoalTerminalCommitter(this, (goalId, type, input) =>
      this.commitTerminal(goalId, type, input),
    )
  }

  async create(recordValue: GoalRecord): Promise<GoalRecord> {
    const input = parseGoalRecord(recordValue)
    validateGoalId(input.id)
    if (input.lastEventSeq !== 0)
      throw new GoalStoreError(
        'goal_create_invalid',
        'A new Goal must not already contain persisted events.',
      )
    let committed: GoalEventEnvelope<GoalEventPayload> | null = null
    const projected = await this.withMutationLifecycle(async () => {
      await this.ensureRoot()
      const records = await this.scanGoalRecords()
      const scopedGoalIds = new Set(records.map((record) => record.id))
      if (
        this.diagnosticsState.issues.some(
          (issue) => !issue.recovered && !scopedGoalIds.has(issue.goalId),
        )
      ) {
        throw new GoalStoreError(
          'storage_recovery_required',
          'Goal scope must be recovered before another Goal can be created.',
        )
      }
      if (
        records.some(
          (record) =>
            record.scope.sessionId === input.scope.sessionId &&
            !isGoalTerminal(record.status),
        )
      ) {
        throw new GoalStoreError(
          'goal_active_exists',
          'This session already has a non-terminal Goal.',
        )
      }
      if (existsSync(this.goalRoot(input.id)))
        throw new GoalStoreError('goal_exists', 'Goal already exists.')

      const event = this.makeEvent(null, {
        type: 'goal_created',
        record: input,
        createdAt: input.createdAt,
      })
      const projected = projectEvent(null, event)
      await this.commitEvent(event, projected)
      await this.syncIndex(eventContext(event))
      committed = event
      return projected
    })
    await this.notifyAfterCommit(committed, null, projected)
    return projected
  }

  async get(goalIdValue: string): Promise<GoalRecord | null> {
    const goalId = validateGoalId(goalIdValue)
    return this.withMutationLifecycle(async () => {
      const record = await this.rebuildSnapshotInternal(goalId)
      if (record) await this.syncIndex()
      return record
    })
  }

  /** Ledger-authoritative read for deterministic gates; never repairs disk projections. */
  async inspect(goalIdValue: string): Promise<GoalStoreInspection> {
    const goalId = validateGoalId(goalIdValue)
    return this.withLifecycleLock(async () => {
      if (!existsSync(this.goalRoot(goalId)))
        return { record: null, issue: null }
      const ledger = await this.readLedger(goalId)
      return {
        record: ledger.trustedRecord
          ? structuredClone(ledger.trustedRecord)
          : null,
        issue: ledger.issue ? { ...ledger.issue } : null,
      }
    })
  }

  async list(): Promise<GoalRecord[]> {
    return this.withMutationLifecycle(async () => {
      await this.ensureRoot()
      await this.validateIndex()
      const records = await this.scanGoalRecords()
      await this.writeIndex(records)
      return records.sort((left, right) => {
        const byTime = right.updatedAt.localeCompare(left.updatedAt)
        return byTime || left.id.localeCompare(right.id)
      })
    })
  }

  /** Ledger-authoritative list for prompt/tool reads; never repairs snapshots or indexes. */
  async listReadonly(): Promise<GoalRecord[]> {
    return this.withLifecycleLock(async () => {
      const { records } = await this.scanGoalRecordsReadonly()
      return records.map((record) => structuredClone(record))
    })
  }

  async findActiveBySession(
    sessionIdValue: string,
  ): Promise<GoalRecord | null> {
    const sessionId = String(sessionIdValue ?? '').trim()
    if (!sessionId) return null
    return this.withLifecycleLock(async () => {
      const { records, issues } = await this.scanGoalRecordsReadonly()
      if (
        issues.some(
          ({ record }) =>
            record?.scope.sessionId === sessionId &&
            !isGoalTerminal(record.status),
        )
      )
        throw new GoalStoreError(
          'storage_recovery_required',
          'Goal storage requires recovery before the session can run.',
        )
      const active = records.find(
        (record) =>
          record.scope.sessionId === sessionId &&
          !isGoalTerminal(record.status),
      )
      return active ? structuredClone(active) : null
    })
  }

  async append(
    goalIdValue: string,
    input: GoalAppendInput,
  ): Promise<GoalRecord> {
    const goalId = validateGoalId(goalIdValue)
    if (
      (input as { readonly type?: unknown }).type === 'goal_completed' ||
      (input as { readonly type?: unknown }).type === 'goal_blocked'
    )
      throw new GoalStoreError(
        'goal_terminal_write_forbidden',
        'Terminal Goal events require the dedicated Core terminal writer.',
      )
    let committed: GoalEventEnvelope<GoalEventPayload> | null = null
    let previous: GoalRecord | null = null
    const projected = await this.withMutationLifecycle(async () => {
      const current = await this.rebuildSnapshotInternal(goalId)
      if (!current)
        throw new GoalStoreError('goal_not_found', 'Goal does not exist.')
      if (this.hasBlockingIssue(goalId))
        throw new GoalStoreError(
          'storage_recovery_required',
          'Goal storage requires recovery before new events can be appended.',
        )
      if (
        input.expectedLastEventSeq !== undefined &&
        current.lastEventSeq !== input.expectedLastEventSeq
      )
        throw new GoalStoreError(
          'goal_event_conflict',
          'Goal changed before the event could be appended.',
        )
      const event = this.makeEvent(current, input)
      previous = current
      const projected = projectEvent(current, event)
      await this.commitEvent(event, projected)
      await this.syncIndex(eventContext(event))
      committed = event
      return projected
    })
    await this.notifyAfterCommit(committed, previous, projected)
    return projected
  }

  async commitCompletion(
    _goalIdValue: string,
    _input: GoalTerminalCommitInput,
  ): Promise<GoalRecord> {
    throw new GoalStoreError(
      'goal_terminal_write_forbidden',
      'Terminal Goal events require an authorized Core terminal writer.',
    )
  }

  async commitBlocked(
    _goalIdValue: string,
    _input: GoalTerminalCommitInput,
  ): Promise<GoalRecord> {
    throw new GoalStoreError(
      'goal_terminal_write_forbidden',
      'Terminal Goal events require an authorized Core terminal writer.',
    )
  }

  async deleteBySession(sessionIdValue: string): Promise<number> {
    const sessionId = String(sessionIdValue ?? '').trim()
    if (!sessionId) return 0
    return this.withMutationLifecycle(async () => {
      const targets = (await this.scanGoalRecords()).filter(
        (record) => record.scope.sessionId === sessionId,
      )
      if (
        targets.some(
          (record) =>
            record.status === 'active' &&
            (record.runtime.phase === 'executing' ||
              record.runtime.phase === 'verifying'),
        )
      ) {
        throw new GoalStoreError(
          'goal_running_delete_forbidden',
          'Pause or cancel a running Goal before deleting its session.',
        )
      }
      await this.hooks.beforeDeleteRemove?.({
        sessionId,
        goalIds: targets.map((record) => record.id),
      })
      for (const record of targets) {
        try {
          this.recordMutation(
            'goal',
            `${record.id}:delete:${record.lastEventSeq}`,
          )
          await rm(this.goalRoot(record.id), { recursive: true })
        } catch (cause) {
          this.diagnosticsState.deleteFailures.push({
            sessionId,
            goalId: record.id,
          })
          await this.persistDiagnostics()
          throw new GoalStoreError(
            'goal_delete_failed',
            'Goal data could not be deleted completely.',
            { cause },
          )
        }
      }
      await this.syncIndex()
      return targets.length
    })
  }

  async rebuildSnapshot(goalIdValue: string): Promise<GoalRecord | null> {
    const goalId = validateGoalId(goalIdValue)
    return this.withMutationLifecycle(async () => {
      const record = await this.rebuildSnapshotInternal(goalId)
      await this.syncIndex()
      return record
    })
  }

  async requireScopeRecovery(goalIdValue: string): Promise<GoalRecord | null> {
    const goalId = validateGoalId(goalIdValue)
    return this.withMutationLifecycle(async () => {
      const current = await this.rebuildSnapshotInternal(goalId)
      if (!current) return null
      await this.recordIssue({
        goalId,
        code: 'scope_missing',
        path: this.goalRoot(goalId),
        recovered: false,
      })
      const safe = await this.safeRecoverySnapshot(current)
      if (safe) await this.writeSnapshot(safe)
      await this.syncIndex()
      return safe
    })
  }

  async appendObservation(
    goalIdValue: string,
    observation: unknown,
  ): Promise<void> {
    const goalId = validateGoalId(goalIdValue)
    let normalized: JsonValue
    try {
      normalized = normalizeJsonValue(observation)
    } catch (cause) {
      throw jsonValueError(cause)
    }
    await this.withMutationLifecycle(async () => {
      if (!existsSync(this.goalRoot(goalId)))
        throw new GoalStoreError('goal_not_found', 'Goal does not exist.')
      this.recordMutation('observation', `${goalId}:${this.now()}`)
      await this.ensureGoalRoot(goalId)
      await this.observationJournal(goalId).append(normalized)
    })
  }

  async appendObservationIfActive(
    goalIdValue: string,
    sessionIdValue: string,
    observation: unknown,
  ): Promise<boolean> {
    const goalId = validateGoalId(goalIdValue)
    const sessionId = String(sessionIdValue ?? '').trim()
    let normalized: JsonValue
    try {
      normalized = normalizeJsonValue(observation)
    } catch (cause) {
      throw jsonValueError(cause)
    }
    return await this.withMutationLifecycle(async () => {
      const current = await this.rebuildSnapshotInternal(goalId)
      if (
        !current ||
        current.status !== 'active' ||
        current.scope.sessionId !== sessionId
      )
        return false
      this.recordMutation(
        'observation',
        `${goalId}:${String((normalized as Record<string, unknown>).id ?? this.now())}`,
      )
      const journal = await readJsonl<Record<string, unknown>>(
        this.observationsPath(goalId),
      )
      if (journal.badLines.length)
        throw new GoalStoreError(
          'goal_observation_store_corrupt',
          'Goal observation journal contains malformed JSON.',
        )
      const fact = normalized as Record<string, unknown>
      if (journal.records.some((item) => item.id === fact.id))
        throw new GoalStoreError(
          'goal_observation_id_duplicate',
          'Goal observation IDs must be unique.',
        )
      if (journal.records.some((item) => item.toolCallId === fact.toolCallId))
        throw new GoalStoreError(
          'goal_observation_tool_call_duplicate',
          'A Goal tool call can be observed only once.',
        )
      await this.ensureGoalRoot(goalId)
      await this.observationJournal(goalId).append(normalized)
      return true
    })
  }

  async readObservations<T = unknown>(
    goalIdValue: string,
  ): Promise<ReadJsonlResult<T>> {
    const goalId = validateGoalId(goalIdValue)
    return this.withMutationLifecycle(async () => {
      const path = this.observationsPath(goalId)
      const result = await readJsonl<T>(path)
      if (result.badLines.length > 0) {
        await this.hooks.beforeDiagnosticsUpdate?.()
        await this.loadDiagnostics()
        const next = {
          goalId,
          path,
          badLines: result.badLines.length,
        }
        this.diagnosticsState.observationCorruptions = [
          ...this.diagnosticsState.observationCorruptions.filter(
            (item) => item.goalId !== goalId,
          ),
          next,
        ]
        await this.persistDiagnostics()
      }
      return result
    })
  }

  async readObservationsReadonly<T = unknown>(
    goalIdValue: string,
  ): Promise<ReadJsonlResult<T>> {
    const goalId = validateGoalId(goalIdValue)
    return this.withLifecycleLock(async () =>
      readJsonl<T>(this.observationsPath(goalId)),
    )
  }

  async readEvents(
    goalIdValue: string,
  ): Promise<readonly GoalEventEnvelope<GoalEventPayload>[]> {
    const goalId = validateGoalId(goalIdValue)
    return this.withMutationLifecycle(async () => {
      await this.ensureRoot()
      const ledger = await this.readLedger(goalId)
      if (ledger.issue) {
        await this.recordIssue(ledger.issue)
        throw new GoalStoreError(
          'storage_recovery_required',
          'Goal ledger could not be verified.',
        )
      }
      return ledger.events.map((event) => structuredClone(event))
    })
  }

  async readEventsReadonly(
    goalIdValue: string,
  ): Promise<readonly GoalEventEnvelope<GoalEventPayload>[]> {
    const goalId = validateGoalId(goalIdValue)
    return this.withLifecycleLock(async () => {
      const ledger = await this.readLedger(goalId)
      if (ledger.issue)
        throw new GoalStoreError(
          'storage_recovery_required',
          'Goal ledger could not be verified.',
        )
      return ledger.events.map((event) => structuredClone(event))
    })
  }

  async diagnostics(): Promise<GoalStoreDiagnostics> {
    await this.loadDiagnostics()
    return {
      root: this.goalsRoot,
      issues: this.diagnosticsState.issues.map((issue) => ({ ...issue })),
      recoveryRequired: new Set(
        this.diagnosticsState.issues
          .filter((issue) => !issue.recovered)
          .map((issue) => issue.goalId),
      ).size,
      indexRebuilt: this.diagnosticsState.indexRebuilt,
      indexCorruptBackup: this.diagnosticsState.indexCorruptBackup,
      observationCorruptions: this.diagnosticsState.observationCorruptions.map(
        (item) => ({
          ...item,
        }),
      ),
      deleteFailures: this.diagnosticsState.deleteFailures.map((item) => ({
        ...item,
      })),
    }
  }

  private withLifecycleLock<T>(action: () => Promise<T>): Promise<T> {
    return GLOBAL_GOAL_LIFECYCLE_MUTEX.run(
      `${this.goalsRoot}:lifecycle`,
      action,
    )
  }

  private async withMutationLifecycle<T>(action: () => Promise<T>): Promise<T> {
    return await this.mutationLedger.guard.runExclusive(
      'mutation',
      async (lease) =>
        await this.withLifecycleLock(
          async () => await this.withMutationLease(lease, action),
        ),
    )
  }

  private async withMutationLease<T>(
    lease: GoalMutationLease,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.activeMutationLease)
      throw new GoalStoreError(
        'goal_mutation_lease_nested',
        'Goal mutation lease is already active for this Store.',
      )
    this.activeMutationLease = lease
    try {
      return await action()
    } finally {
      this.activeMutationLease = null
    }
  }

  private recordMutation(
    source: Parameters<GoalGateMutationLedger['recordUnderLease']>[1],
    version: string,
  ): void {
    if (!this.activeMutationLease)
      throw new GoalStoreError(
        'goal_mutation_lease_required',
        'Goal persistence requires an active mutation lease.',
      )
    this.mutationLedger.recordUnderLease(
      this.activeMutationLease,
      source,
      version,
    )
  }

  private async commitTerminal(
    goalIdValue: string,
    type: 'goal_completed' | 'goal_blocked',
    input: GoalTerminalCommitInput,
  ): Promise<GoalRecord> {
    const goalId = validateGoalId(goalIdValue)
    let committed: GoalEventEnvelope<GoalEventPayload> | null = null
    let previous: GoalRecord | null = null
    const projected = await this.mutationLedger.guard.runExclusive(
      'terminal',
      async (lease) => {
        await this.withLifecycleLock(async () => {
          const current = await this.readTerminalCandidate(goalId)
          if (current.lastEventSeq !== input.expectedLastEventSeq)
            throw new GoalStoreError(
              'goal_event_conflict',
              'Goal changed before the terminal event could be appended.',
            )
        })
        this.mutationLedger.assertPreconditionUnderLease(
          lease,
          input.mutationPrecondition,
        )
        // External Gate facts deliberately re-enter readonly Goal APIs. Keep the
        // process-wide mutation guard, but do not hold the Goal lifecycle mutex
        // until every external fact has been validated.
        await input.validatePrecondition()
        return await this.withLifecycleLock(
          async () =>
            await this.withMutationLease(lease, async () => {
              const current = await this.readTerminalCandidate(goalId)
              if (current.lastEventSeq !== input.expectedLastEventSeq)
                throw new GoalStoreError(
                  'goal_event_conflict',
                  'Goal changed before the terminal event could be appended.',
                )
              const event = this.makeEvent(current, { ...input, type })
              previous = current
              const projected = projectEvent(current, event)
              await this.commitEvent(event, projected)
              await this.syncIndex(eventContext(event))
              committed = event
              return projected
            }),
        )
      },
    )
    await this.notifyAfterCommit(committed, previous, projected)
    return projected
  }

  private async notifyAfterCommit(
    event: GoalEventEnvelope<GoalEventPayload> | null,
    previous: GoalRecord | null,
    record: GoalRecord,
  ): Promise<void> {
    if (!event || !this.hooks.afterCommit) return
    try {
      await this.hooks.afterCommit({
        ...eventContext(event),
        event: structuredClone(event),
        previous: previous ? structuredClone(previous) : null,
        record: structuredClone(record),
      })
    } catch {
      // Runtime projection is rebuildable; durable Goal truth remains valid.
    }
  }

  private async readTerminalCandidate(goalId: string): Promise<GoalRecord> {
    await this.loadDiagnostics()
    const ledger = await this.readLedger(goalId)
    if (ledger.issue || this.hasBlockingIssue(goalId))
      throw new GoalStoreError(
        'storage_recovery_required',
        'Goal storage requires recovery before terminal commit.',
      )
    if (!ledger.trustedRecord)
      throw new GoalStoreError('goal_not_found', 'Goal does not exist.')
    return ledger.trustedRecord
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.goalsRoot, { recursive: true, mode: 0o700 })
    await chmod(this.goalsRoot, 0o700)
    await this.loadDiagnostics()
  }

  private async ensureGoalRoot(goalId: string): Promise<void> {
    await this.ensureRoot()
    const path = this.goalRoot(goalId)
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
  }

  private makeEvent(
    current: GoalRecord | null,
    input: GoalEventInput,
  ): GoalEventEnvelope<GoalEventPayload> {
    const seq = (current?.lastEventSeq ?? 0) + 1
    const candidate = parseGoalRecord({ ...input.record, lastEventSeq: seq })
    const record = current
      ? assertGoalTransition(current, candidate)
      : candidate
    if (record.id !== (current?.id ?? input.record.id))
      throw new GoalStoreError('goal_event_invalid', 'Goal event ID changed.')
    const payload: GoalEventPayload = {
      ...(input.data ?? {}),
      record,
    }
    try {
      return createGoalEventEnvelope({
        schemaVersion: GOAL_EVENT_SCHEMA_VERSION,
        goalId: record.id,
        seq,
        type: input.type,
        payload,
        prevHash: current ? this.lastVerifiedHash(current.id) : null,
        createdAt: input.createdAt ?? this.now(),
      })
    } catch (cause) {
      throw jsonValueError(cause)
    }
  }

  private verifiedHashByGoal = new Map<string, string>()

  private lastVerifiedHash(goalId: string): string {
    const hash = this.verifiedHashByGoal.get(goalId)
    if (!hash)
      throw new GoalStoreError(
        'storage_recovery_required',
        'Goal ledger head could not be verified.',
      )
    return hash
  }

  private async commitEvent(
    event: GoalEventEnvelope<GoalEventPayload>,
    projected: GoalRecord,
  ): Promise<void> {
    const context = eventContext(event)
    await this.hooks.beforeEventAppend?.(context)
    await this.appendEventSynced(event)
    this.verifiedHashByGoal.set(event.goalId, event.hash)
    await this.hooks.afterEventSync?.(context)
    await this.hooks.beforeSnapshotWrite?.(context)
    await this.writeSnapshot(projected)
  }

  private async appendEventSynced(
    event: GoalEventEnvelope<GoalEventPayload>,
  ): Promise<void> {
    this.recordMutation('goal', `${event.goalId}:${event.seq}:${event.hash}`)
    await this.ensureGoalRoot(event.goalId)
    await this.eventJournal(event.goalId).appendAtSequence(event, event.seq)
  }

  private async writeSnapshot(record: GoalRecord): Promise<void> {
    this.recordMutation(
      'storage',
      `${record.id}:snapshot:${record.lastEventSeq}`,
    )
    await this.ensureGoalRoot(record.id)
    await this.goalSnapshot(record.id).write(record)
  }

  private async rebuildSnapshotInternal(
    goalId: string,
  ): Promise<GoalRecord | null> {
    await this.ensureRoot()
    if (!existsSync(this.goalRoot(goalId))) return null
    const ledger = await this.readLedger(goalId)
    if (ledger.issue) {
      await this.recordIssue(ledger.issue)
      const safe = await this.safeRecoverySnapshot(ledger.trustedRecord)
      if (safe) await this.writeSnapshot(safe)
      return safe
    }
    if (ledger.events.length === 0) {
      const issue: GoalRecoveryIssue = {
        goalId,
        code: 'scope_missing',
        path: this.goalRoot(goalId),
        recovered: false,
      }
      await this.recordIssue(issue)
      return null
    }

    const snapshot = await this.readSnapshot(goalId)
    const projections: GoalRecord[] = []
    let verifiedProjection: GoalRecord | null = null
    for (const event of ledger.events) {
      verifiedProjection = projectEvent(verifiedProjection, event)
      projections.push(verifiedProjection)
    }
    let current: GoalRecord | null = null
    let startAt = 0
    if (snapshot) {
      const matchingProjection = projections[snapshot.lastEventSeq - 1]
      if (matchingProjection && sameJson(matchingProjection, snapshot)) {
        current = snapshot
        startAt = snapshot.lastEventSeq
      }
    }
    for (const event of ledger.events.slice(startAt)) {
      current = projectEvent(current, event)
    }
    if (!current) return null
    this.verifiedHashByGoal.set(
      goalId,
      ledger.events[ledger.events.length - 1]!.hash,
    )
    if (this.hasBlockingIssue(goalId)) {
      const safe = await this.safeRecoverySnapshot(current)
      if (safe && (!snapshot || !sameJson(snapshot, safe)))
        await this.writeSnapshot(safe)
      return safe
    }
    if (!snapshot || !sameJson(snapshot, current)) {
      await this.recordIssue({
        goalId,
        code: 'snapshot_stale',
        path: this.snapshotPath(goalId),
        recovered: true,
      })
      await this.writeSnapshot(current)
    }
    return current
  }

  private async readLedger(goalId: string): Promise<LedgerReadResult> {
    const path = this.eventsPath(goalId)
    if (!existsSync(path))
      return { events: [], issue: null, trustedRecord: null }
    const raw = await readFile(path, 'utf8')
    const events: GoalEventEnvelope<GoalEventPayload>[] = []
    let trustedRecord: GoalRecord | null = null
    let prevHash: string | null = null
    let expectedSeq = 1
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue
      let event: GoalEventEnvelope<GoalEventPayload>
      try {
        event = parseGoalEventEnvelope(
          JSON.parse(line),
        ) as GoalEventEnvelope<GoalEventPayload>
        normalizeJsonValue(event)
      } catch {
        return {
          events,
          trustedRecord,
          issue: {
            goalId,
            code: 'event_corrupt',
            path: `${path}#L${index + 1}`,
            recovered: false,
          },
        }
      }
      let hashMatches = false
      try {
        hashMatches = computeGoalEventHash(event) === event.hash
      } catch {
        return {
          events,
          trustedRecord,
          issue: {
            goalId,
            code: 'event_corrupt',
            path: `${path}#L${index + 1}`,
            recovered: false,
          },
        }
      }
      if (
        event.goalId !== goalId ||
        event.seq !== expectedSeq ||
        event.prevHash !== prevHash ||
        !hashMatches
      ) {
        return {
          events,
          trustedRecord,
          issue: {
            goalId,
            code: 'hash_chain_broken',
            path: `${path}#L${index + 1}`,
            recovered: false,
          },
        }
      }
      try {
        trustedRecord = projectEvent(trustedRecord, event)
      } catch (cause) {
        return {
          events,
          trustedRecord,
          issue: {
            goalId,
            code: isExplicitScopeError(cause)
              ? 'scope_missing'
              : 'event_corrupt',
            path: `${path}#L${index + 1}`,
            recovered: false,
          },
        }
      }
      events.push(event)
      prevHash = event.hash
      expectedSeq += 1
    }
    if (prevHash) this.verifiedHashByGoal.set(goalId, prevHash)
    return { events, issue: null, trustedRecord }
  }

  private async readSnapshot(goalId: string): Promise<GoalRecord | null> {
    const path = this.snapshotPath(goalId)
    try {
      const loaded = await this.goalSnapshot(goalId).read({ fallback: null })
      if (loaded.receipt.recoveryAction === 'quarantined_corrupt_snapshot') {
        this.recordMutation(
          'storage',
          `${goalId}:snapshot-quarantine:${this.now()}`,
        )
        await this.recordIssue({
          goalId,
          code: 'snapshot_stale',
          path: loaded.receipt.corruptionBackup ?? path,
          recovered: true,
        })
      }
      return loaded.value
    } catch (cause) {
      if (!(cause instanceof PersistenceCorruptionError)) throw cause
      await this.recordIssue({
        goalId,
        code: 'snapshot_stale',
        path: cause.corruptionBackup ?? path,
        recovered: true,
      })
      return null
    }
  }

  private async safeRecoverySnapshot(
    trusted: GoalRecord | null,
  ): Promise<GoalRecord | null> {
    if (!trusted || trusted.status !== 'active') return trusted
    return parseGoalRecord({
      ...trusted,
      runtime: {
        ...trusted.runtime,
        phase: 'paused',
        currentRunId: null,
        pauseReason: 'recovery_required',
      },
      updatedAt: this.now(),
    })
  }

  private async scanGoalRecords(): Promise<GoalRecord[]> {
    await this.ensureRoot()
    const records: GoalRecord[] = []
    for (const entry of await readdir(this.goalsRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !isSafeGoalId(entry.name)) continue
      const record = await this.rebuildSnapshotInternal(entry.name)
      if (record) records.push(record)
    }
    return records
  }

  private async scanGoalRecordsReadonly(): Promise<{
    records: GoalRecord[]
    issues: Array<{ issue: GoalRecoveryIssue; record: GoalRecord | null }>
  }> {
    if (!existsSync(this.goalsRoot)) return { records: [], issues: [] }
    const records: GoalRecord[] = []
    const issues: Array<{
      issue: GoalRecoveryIssue
      record: GoalRecord | null
    }> = []
    for (const entry of await readdir(this.goalsRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !isSafeGoalId(entry.name)) continue
      const ledger = await this.readLedger(entry.name)
      if (ledger.issue) {
        issues.push({ issue: ledger.issue, record: ledger.trustedRecord })
        continue
      }
      if (ledger.trustedRecord) records.push(ledger.trustedRecord)
    }
    records.sort((left, right) => {
      const byTime = right.updatedAt.localeCompare(left.updatedAt)
      return byTime || left.id.localeCompare(right.id)
    })
    return { records, issues }
  }

  private async syncIndex(context?: GoalWriteContext): Promise<void> {
    if (context) await this.hooks.beforeIndexWrite?.(context)
    await this.writeIndex(await this.scanGoalRecords())
  }

  private async validateIndex(): Promise<GoalIndexDocument | null> {
    await this.ensureRoot()
    try {
      const loaded = await this.indexSnapshot().read({ fallback: null })
      if (loaded.receipt.recoveryAction === 'quarantined_corrupt_snapshot') {
        this.recordMutation('storage', `goal-index-quarantine:${this.now()}`)
        this.diagnosticsState.indexRebuilt = true
        this.diagnosticsState.indexCorruptBackup =
          loaded.receipt.corruptionBackup
        await this.persistDiagnostics()
      }
      return loaded.value
    } catch (cause) {
      if (!(cause instanceof PersistenceCorruptionError)) throw cause
      this.diagnosticsState.indexRebuilt = true
      this.diagnosticsState.indexCorruptBackup = cause.corruptionBackup
      await this.persistDiagnostics()
      return null
    }
  }

  private async writeIndex(records: readonly GoalRecord[]): Promise<void> {
    this.recordMutation(
      'storage',
      `goal-index:${records.map((record) => `${record.id}:${record.lastEventSeq}`).join(',') || 'empty'}`,
    )
    await this.ensureRoot()
    await this.validateIndex()
    const goals = records
      .map(toIndexEntry)
      .sort((left, right) => left.id.localeCompare(right.id))
    const document: GoalIndexDocument = {
      schemaVersion: GOAL_INDEX_SCHEMA_VERSION,
      goals,
    }
    await this.indexSnapshot().write(document)
  }

  private hasBlockingIssue(goalId: string): boolean {
    return this.diagnosticsState.issues.some(
      (issue) => issue.goalId === goalId && !issue.recovered,
    )
  }

  private async recordIssue(issue: GoalRecoveryIssue): Promise<void> {
    await this.loadDiagnostics()
    this.diagnosticsState.issues = [
      ...this.diagnosticsState.issues.filter(
        (current) =>
          current.goalId !== issue.goalId || current.code !== issue.code,
      ),
      issue,
    ]
    await this.persistDiagnostics()
  }

  private async loadDiagnostics(): Promise<void> {
    if (this.diagnosticsLoaded) return
    this.diagnosticsLoadPromise ??= this.loadDiagnosticsOnce()
    await this.diagnosticsLoadPromise
  }

  private async loadDiagnosticsOnce(): Promise<void> {
    try {
      if (!existsSync(this.diagnosticsPath)) return
      const value = JSON.parse(await readFile(this.diagnosticsPath, 'utf8'))
      await this.hooks.afterDiagnosticsRead?.()
      if (isMutableDiagnostics(value)) this.diagnosticsState = value
    } catch {
      // Diagnostics are a projection; a corrupt copy must not block ledger recovery.
    } finally {
      this.diagnosticsLoaded = true
    }
  }

  private async persistDiagnostics(): Promise<void> {
    this.recordMutation(
      'storage',
      `goal-diagnostics:${this.diagnosticsState.issues.length}:${this.diagnosticsState.observationCorruptions.length}:${this.diagnosticsState.deleteFailures.length}`,
    )
    await this.hooks.beforeDiagnosticsWrite?.()
    await mkdir(this.goalsRoot, { recursive: true, mode: 0o700 })
    await chmod(this.goalsRoot, 0o700)
    await this.diagnosticsSnapshot().write(this.diagnosticsState)
  }

  private goalSnapshot(goalId: string): AtomicSnapshot<GoalRecord | null> {
    return new AtomicSnapshot({
      path: this.snapshotPath(goalId),
      codec: GOAL_RECORD_CODEC,
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
    })
  }

  private indexSnapshot(): AtomicSnapshot<GoalIndexDocument | null> {
    return new AtomicSnapshot({
      path: this.indexPath,
      codec: GOAL_INDEX_CODEC,
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
    })
  }

  private diagnosticsSnapshot(): AtomicSnapshot<MutableDiagnostics> {
    return new AtomicSnapshot({
      path: this.diagnosticsPath,
      codec: GOAL_DIAGNOSTICS_CODEC,
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
    })
  }

  private eventJournal(
    goalId: string,
  ): AppendOnlyJournal<GoalEventEnvelope<GoalEventPayload>> {
    return new AppendOnlyJournal({
      path: this.eventsPath(goalId),
      codec: GOAL_EVENT_JOURNAL_CODEC,
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
    })
  }

  private observationJournal(goalId: string): AppendOnlyJournal<JsonValue> {
    return new AppendOnlyJournal({
      path: this.observationsPath(goalId),
      codec: GOAL_OBSERVATION_JOURNAL_CODEC,
      adapter: this.persistenceAdapter,
      fileMode: 0o600,
    })
  }

  private goalRoot(goalId: string): string {
    return join(this.goalsRoot, goalId)
  }

  private snapshotPath(goalId: string): string {
    return join(this.goalRoot(goalId), 'goal.json')
  }

  private eventsPath(goalId: string): string {
    return join(this.goalRoot(goalId), 'events.jsonl')
  }

  private observationsPath(goalId: string): string {
    return join(this.goalRoot(goalId), 'observations.jsonl')
  }
}

const GOAL_RECORD_CODEC: SnapshotCodec<GoalRecord | null> = {
  schemaVersion: 1,
  encode(value) {
    if (!value) throw new Error('Goal snapshot cannot be null.')
    return value
  },
  decode(input) {
    return { value: parseGoalRecord(input), schemaVersion: 1 }
  },
}

const GOAL_INDEX_CODEC: SnapshotCodec<GoalIndexDocument | null> = {
  schemaVersion: 1,
  encode(value) {
    if (!value) throw new Error('Goal index cannot be null.')
    return value
  },
  decode(input) {
    if (!isIndexDocument(input)) throw new Error('Goal index is invalid.')
    return { value: input, schemaVersion: 1 }
  },
}

const GOAL_DIAGNOSTICS_CODEC: SnapshotCodec<MutableDiagnostics> = {
  schemaVersion: 1,
  encode(value) {
    return value
  },
  decode(input) {
    if (!isMutableDiagnostics(input))
      throw new Error('Goal diagnostics are invalid.')
    return { value: input, schemaVersion: 1 }
  },
}

const GOAL_EVENT_JOURNAL_CODEC: JournalCodec<
  GoalEventEnvelope<GoalEventPayload>
> = {
  schemaVersion: 1,
  create(seq, payload) {
    const event = parseGoalEventEnvelope(
      payload,
    ) as GoalEventEnvelope<GoalEventPayload>
    normalizeJsonValue(event)
    if (event.seq !== seq || computeGoalEventHash(event) !== event.hash)
      throw new Error('Goal journal event does not match its sequence or hash.')
    return {
      schemaVersion: 1,
      seq,
      checksum: event.hash,
      payload: event,
    }
  },
  encode(entry) {
    return entry.payload
  },
  decode(input) {
    const event = parseGoalEventEnvelope(
      input,
    ) as GoalEventEnvelope<GoalEventPayload>
    normalizeJsonValue(event)
    if (computeGoalEventHash(event) !== event.hash)
      throw new Error('Goal journal event hash is invalid.')
    return {
      schemaVersion: 1,
      seq: event.seq,
      checksum: event.hash,
      payload: event,
    }
  },
}

const GOAL_OBSERVATION_JOURNAL_CODEC: JournalCodec<JsonValue> = {
  schemaVersion: 1,
  create(seq, payload) {
    const value = normalizeJsonValue(payload)
    return {
      schemaVersion: 1,
      seq,
      checksum: JSON.stringify(value),
      payload: value,
    }
  },
  encode(entry) {
    return entry.payload
  },
  decode(input, context) {
    const value = normalizeJsonValue(input)
    return {
      schemaVersion: 1,
      seq: context.expectedSeq,
      checksum: JSON.stringify(value),
      payload: value,
    }
  },
}

function projectEvent(
  current: GoalRecord | null,
  event: GoalEventEnvelope<GoalEventPayload>,
): GoalRecord {
  const record = parseGoalRecord(event.payload.record)
  if (
    record.id !== event.goalId ||
    record.lastEventSeq !== event.seq ||
    (current === null && event.type !== 'goal_created') ||
    (current !== null && event.type === 'goal_created')
  ) {
    throw new GoalStoreError('goal_event_invalid', 'Goal event is invalid.')
  }
  assertGoalEventSemantics(current, event.type, record)
  return current ? assertGoalTransition(current, record) : record
}

function assertGoalEventSemantics(
  current: GoalRecord | null,
  type: GoalDomainEventType,
  next: GoalRecord,
): void {
  if (!current) return
  const terminalShape =
    next.runtime.phase === 'terminal' &&
    next.terminalAt !== null &&
    next.runtime.currentRunId === null &&
    next.runtime.pendingInteractionId === null &&
    next.runtime.pauseReason === null
  const validCompleted =
    type === 'goal_completed' &&
    current.status === 'active' &&
    next.status === 'completed' &&
    terminalShape
  const validBlocked =
    type === 'goal_blocked' &&
    current.status === 'active' &&
    next.status === 'blocked' &&
    terminalShape
  if (
    (type === 'goal_completed' && !validCompleted) ||
    (type === 'goal_blocked' && !validBlocked) ||
    (type !== 'goal_completed' && next.status === 'completed') ||
    (type !== 'goal_blocked' && next.status === 'blocked')
  ) {
    throw new GoalStoreError(
      'goal_event_invalid',
      'Goal terminal event subtype does not match its state transition.',
    )
  }
  const recoveryPauseState =
    next.status === 'active' &&
    next.runtime.phase === 'paused' &&
    next.runtime.pauseReason === 'recovery_required'
  const validRecoveryTarget =
    recoveryPauseState && next.runtime.currentRunId === null
  const validRecoverySource =
    current.status === 'active' &&
    ((current.runtime.phase === 'planning' &&
      current.runtime.currentRunId !== null) ||
      current.runtime.phase === 'executing' ||
      current.runtime.phase === 'verifying')
  if (
    (type === 'goal_recovery_paused' &&
      (!validRecoveryTarget || !validRecoverySource)) ||
    (type === 'goal_updated' && recoveryPauseState)
  ) {
    throw new GoalStoreError(
      'goal_event_invalid',
      'Goal event subtype does not match its state transition.',
    )
  }
}

function toIndexEntry(record: GoalRecord): GoalIndexEntry {
  return {
    id: record.id,
    sessionId: record.scope.sessionId,
    status: record.status,
    phase: record.runtime.phase,
    outcomePreview: record.contract.outcome.slice(0, 160),
    updatedAt: record.updatedAt,
    terminalAt: record.terminalAt,
  }
}

function eventContext(event: GoalEventEnvelope): GoalWriteContext {
  return { goalId: event.goalId, seq: event.seq, type: event.type }
}

function jsonValueError(cause: unknown): GoalStoreError {
  if (!(cause instanceof GoalJsonValueError))
    return new GoalStoreError(
      'goal_event_invalid',
      'Goal event could not be normalized.',
      cause instanceof Error ? { cause } : undefined,
    )
  return new GoalStoreError(
    'goal_json_invalid',
    'Goal persistence values must be plain JSON.',
    cause instanceof Error ? { cause } : undefined,
  )
}

function isExplicitScopeError(cause: unknown): boolean {
  return (
    cause instanceof GoalDomainError &&
    (cause.code === 'goal_scope_invalid' ||
      cause.code === 'goal_scope_mismatch' ||
      cause.code === 'goal_scope_immutable')
  )
}

function validateGoalId(value: string): string {
  const goalId = String(value ?? '').trim()
  if (!isSafeGoalId(goalId))
    throw new GoalStoreError('goal_id_invalid', 'Goal ID is invalid.')
  return goalId
}

function isSafeGoalId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isIndexDocument(value: unknown): value is GoalIndexDocument {
  if (!isRecord(value) || value.schemaVersion !== GOAL_INDEX_SCHEMA_VERSION)
    return false
  if (!Array.isArray(value.goals)) return false
  return value.goals.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.id === 'string' &&
      typeof entry.sessionId === 'string' &&
      typeof entry.status === 'string' &&
      typeof entry.phase === 'string' &&
      typeof entry.outcomePreview === 'string' &&
      typeof entry.updatedAt === 'string' &&
      (entry.terminalAt === null || typeof entry.terminalAt === 'string'),
  )
}

function emptyDiagnostics(): MutableDiagnostics {
  return {
    issues: [],
    indexRebuilt: false,
    indexCorruptBackup: null,
    observationCorruptions: [],
    deleteFailures: [],
  }
}

function isMutableDiagnostics(value: unknown): value is MutableDiagnostics {
  return (
    isRecord(value) &&
    Array.isArray(value.issues) &&
    value.issues.every(isGoalRecoveryIssue) &&
    Array.isArray(value.observationCorruptions) &&
    value.observationCorruptions.every(isObservationCorruption) &&
    Array.isArray(value.deleteFailures) &&
    value.deleteFailures.every(isDeleteFailure) &&
    typeof value.indexRebuilt === 'boolean' &&
    (value.indexCorruptBackup === null ||
      typeof value.indexCorruptBackup === 'string')
  )
}

function isGoalRecoveryIssue(value: unknown): value is GoalRecoveryIssue {
  return (
    isRecord(value) &&
    typeof value.goalId === 'string' &&
    isSafeGoalId(value.goalId) &&
    (value.code === 'snapshot_stale' ||
      value.code === 'event_corrupt' ||
      value.code === 'hash_chain_broken' ||
      value.code === 'scope_missing') &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    typeof value.recovered === 'boolean'
  )
}

function isObservationCorruption(
  value: unknown,
): value is MutableDiagnostics['observationCorruptions'][number] {
  return (
    isRecord(value) &&
    typeof value.goalId === 'string' &&
    isSafeGoalId(value.goalId) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    Number.isInteger(value.badLines) &&
    Number(value.badLines) > 0
  )
}

function isDeleteFailure(
  value: unknown,
): value is MutableDiagnostics['deleteFailures'][number] {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    value.sessionId.trim().length > 0 &&
    typeof value.goalId === 'string' &&
    isSafeGoalId(value.goalId)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent
    })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

const GLOBAL_GOAL_LIFECYCLE_MUTEX = new KeyedMutex()
