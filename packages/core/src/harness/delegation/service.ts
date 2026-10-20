import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  DelegationError,
  TERMINAL_RUN_PHASES,
  type ExecutorConfig,
  type DelegationOwner,
  type DelegationStart,
  type DelegationRecord,
  type DelegationRunRecord,
  type ExecutorProfile,
  type ExecutorAdapter,
  type ExecutorSession,
  type NormalizedExecutorEvent,
  type ExecutorProbe,
  type ExecutorBilling,
  type ExecutorRunUsage,
  type ExternalBackend,
  type DelegationResult,
} from './types'
import { defaultExecutorConfig } from './config'
import { ExecutorFactsStore } from './facts'
import { nativeGeneratedImageRoot } from './image-proof'
import { executorSpecialties } from './specialties'
import { DelegationPolicy, type DelegationParentContext } from './policy'
import { DelegationBudget, type BudgetLease } from './budget'
import type { RunPhase } from './types'
import { DelegationJournal } from './journal'
import {
  RUN_TRANSITIONS,
  safeDelegationKey,
  type DelegationState,
  type DelegationEvent,
} from './fold'
import { redactExecutorText } from './redaction'
import { buildDelegationBrief, buildDelegationContext } from './context'
import type {
  DelegationQuestion,
  DelegationQuestionOutcome,
} from './interactions'
import type { ExecutorRegistry } from './registry'
import type { DelegationWorkspaceService } from '../../workspace/delegation-workspaces'
import type { DelegationResults } from '../../workspace/delegation-results'
import {
  workspaceMutationDomain,
  type WorkspaceMutationCoordinator,
} from '../../workspace/mutation-coordinator'
import type { ResourceLease } from './resources'
import { DelegationRecovery, type RecoveryReport } from './recovery'
import { DelegationNoticeOutbox, settlementNotice } from './notices'
import {
  saveOwnership,
  loadOwnership,
  type ProcessOwnership,
} from './ownership'
import {
  cleanBoundaryMarkers,
  currentBootTime,
  terminateRecordedProcess,
} from './process'
import { delegationNeedsExit } from '../../runtime/agent-view'
import { durableReplaceSync } from '../../store/persistence'
import { codexAuthWritableFile, type CodexAuthLink } from './codex-auth'
export interface DelegationServiceOptions {
  facts?: ExecutorFactsStore
  root: string
  config: () => ExecutorConfig
  registry: Pick<ExecutorRegistry, 'requireAvailable' | 'capabilities'>
  adapters: Map<string, ExecutorAdapter>
  parent: (owner: DelegationOwner) => DelegationParentContext
  workspaces: Pick<
    DelegationWorkspaceService,
    'prepare' | 'retain' | 'get' | 'release'
  > &
    Partial<Pick<DelegationWorkspaceService, 'retire'>>
  /**
   * A write run's result (AGT-06): recorded when it settles, applied to
   * the project as a three-way merge, undone, discarded, cleaned up.
   */
  results?: Pick<
    DelegationResults,
    'collect' | 'apply' | 'undo' | 'diff' | 'cleanup' | 'forget'
  >
  mutations: WorkspaceMutationCoordinator
  runtime: (
    profile: ExecutorProfile,
    id: string,
  ) => Promise<{
    environment: Record<string, string>
    runtimeRoot: string
    tempRoot: string
    secretValues?: string[]
    codexAuth?: CodexAuthLink
    /** Absent: API billing (AGT-07). */
    billing?: ExecutorBilling
  }>
  /**
   * Prices an API-billed run's tokens from the model catalog (MOD-01) when
   * the executor reports no cost; null when the model's price is unknown
   * (AGT-07).
   */
  estimateUsd?: (input: {
    backend: ExternalBackend
    model?: string
    provider?: string
    baseUrl?: string
    usage: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      reasoningTokens?: number
    }
  }) => number | null
  /**
   * The root task's cost budget (KRN-03): a spent one refuses new runs, and
   * every settled run's API cost is charged to it (AGT-07).
   */
  taskBudget?: {
    exhausted(owner: DelegationOwner): boolean
    charge(owner: DelegationOwner, usd: number): void
  }
  notices?: {
    parent: (
      owner: DelegationOwner,
    ) => import('../agent/agent').Agent | undefined
    canWake: (owner: DelegationOwner) => boolean
    flush: (sessionId: string) => void
  }
  acceptanceCurrent?: (id: string) => Promise<{ state: string }>
  /** Host receipt decides whether this run has files to check at delivery. */
  deliveryRequiresAcceptance?: (
    receiptId: string,
    record: DelegationRecord,
  ) => boolean
  onState?: (state: DelegationState, event: DelegationEvent) => void
  onSettled?: (id: string, runId: string) => Promise<void>
  onStopRoot?: (rootSessionId: string) => Promise<void>
  onEvent?: (event: NormalizedExecutorEvent) => void
  onQuestion?: (
    question: DelegationQuestion,
    signal: AbortSignal,
  ) => Promise<DelegationQuestionOutcome>
  /**
   * First-dispatch consent (AGT-05): false means the user did not allow this
   * executor, and the start fails with EXECUTOR_CONSENT_DENIED before any
   * record exists, so the caller can run the task locally instead.
   */
  consent?: (
    owner: DelegationOwner,
    profile: ExecutorProfile,
    spec: DelegationStart,
    signal?: AbortSignal,
  ) => Promise<boolean>
  /**
   * This boot of the computer (AGT-04); a run recorded under another one is
   * interrupted without touching its old PID. Defaults to the real marker.
   */
  bootTime?: () => string | null
  /** Where stale Seatbelt boundary markers are removed at startup. */
  boundaryMarkerDir?: string
  /** The wait between stop steps for a recovered process group (tests). */
  stopGraceMs?: number
}
interface Entry {
  journal: DelegationJournal
  tail: Promise<unknown>
  noticeTail?: Promise<void>
  active?: Promise<void>
  controller?: AbortController
  inspectionController?: AbortController
  session?: ExecutorSession
  closing?: Promise<{ quiescent: boolean }>
  /** A run without an outcome: its workspace stays quarantined until it is resolved or ended. It never holds a budget slot (AGT-04). */
  held?: { workspace?: ResourceLease; quiescent: boolean }
  /**
   * Loaded at startup, or its root was stopped: pending notices wait until
   * the user resumes the root. In memory only, so a stop or a restart never
   * rewrites settled conversations (AGT-04).
   */
  noticesHeld?: boolean
  stop: boolean
  /** The run limit (runTimeoutMs) stopped the current run. */
  timedOut?: boolean
  inputFailure?: string
  waiters: Set<() => void>
}
export class DelegationService {
  readonly budget: DelegationBudget
  private readonly policy = new DelegationPolicy()
  private readonly entries = new Map<string, Entry>()
  private readonly starts = new Map<
    string,
    { digest: string; promise: Promise<DelegationRecord> }
  >()
  private readonly rootEpochs = new Map<string, number>()
  private readonly goalProofs = new Map<string, string>()
  private readonly resultLocks = new Map<string, Promise<unknown>>()
  readonly facts: ExecutorFactsStore
  private shutdownPromise?: Promise<void>
  private disposed = false
  private reconciled = false
  recoveryReport: RecoveryReport = { loaded: [], issues: [] }
  constructor(private readonly options: DelegationServiceOptions) {
    this.facts = options.facts ?? new ExecutorFactsStore(options.root)
    let config: ExecutorConfig
    try {
      config = options.config()
    } catch {
      config = defaultExecutorConfig()
    }
    this.budget = new DelegationBudget(config)
  }
  private workspaceAvailable(record: DelegationRecord): boolean {
    try {
      const lease = this.options.workspaces.get(record.workspaceLeaseId)
      return (
        !!lease &&
        lease.id === record.workspaceLeaseId &&
        lease.owner.rootSessionId === record.owner.rootSessionId &&
        lease.owner.parentAgentId === record.owner.parentAgentId &&
        lease.owner.taskScopeId === record.owner.taskScopeId &&
        lease.mode === record.startSpec?.workspace &&
        ['ready', 'retained'].includes(lease.status) &&
        existsSync(record.cwd) &&
        realpathSync(lease.cwd) === realpathSync(record.cwd)
      )
    } catch {
      return false
    }
  }
  private bootTime(): string | null {
    try {
      return (this.options.bootTime ?? currentBootTime)()
    } catch {
      return null
    }
  }
  private quarantine(record: DelegationRecord): ResourceLease | undefined {
    return record.startSpec?.workspace !== 'shared-readonly'
      ? this.options.mutations.resources.quarantine(
          [workspaceMutationDomain(record.cwd)],
          record.id,
        )
      : undefined
  }
  /**
   * After a restart nothing of a run that was in flight can still talk to
   * Emperor: stop its process group if it is still there. Another boot time
   * means it is gone; a PID alive under another birth time was reused and is
   * left alone, which leaves the run unresolved.
   */
  private async stopRecordedRun(
    id: string,
    run: DelegationRunRecord,
    boot: string | null,
  ): Promise<{
    stopped: boolean
    reason: 'APP_RESTARTED' | 'SYSTEM_RESTARTED'
  }> {
    if (!run.process) return { stopped: true, reason: 'APP_RESTARTED' }
    if (run.process.bootTime && boot && run.process.bootTime !== boot)
      return { stopped: true, reason: 'SYSTEM_RESTARTED' }
    try {
      const owned = loadOwnership(this.options.root, run.id)
      if (
        owned.delegationId !== id ||
        owned.generation !== run.generation ||
        owned.boundaryReceiptId !== run.process.boundaryReceiptId ||
        owned.policyDigest !== run.process.policyDigest ||
        owned.pid !== run.process.pid ||
        owned.fingerprint !== run.process.fingerprint
      )
        return { stopped: false, reason: 'APP_RESTARTED' }
      if (owned.bootTime && boot && owned.bootTime !== boot)
        return { stopped: true, reason: 'SYSTEM_RESTARTED' }
      const exit = await terminateRecordedProcess(owned, {
        bootTime: boot,
        ...(this.options.stopGraceMs === undefined
          ? {}
          : { graceMs: this.options.stopGraceMs }),
      })
      saveOwnership(this.options.root, { ...owned, exit })
      return { stopped: exit.quiescent, reason: 'APP_RESTARTED' }
    } catch {
      return { stopped: false, reason: 'APP_RESTARTED' }
    }
  }
  /**
   * Startup: load every conversation and settle what a restart cut off. Only
   * real state changes are appended; settled history is left as it is, and
   * nothing here opens a root conversation (AGT-04, SUB-15).
   */
  async reconcile(): Promise<RecoveryReport> {
    if (this.reconciled) return this.recoveryReport
    this.reconciled = true
    if (this.options.boundaryMarkerDir || process.platform === 'darwin')
      cleanBoundaryMarkers(
        this.options.boundaryMarkerDir
          ? { dir: this.options.boundaryMarkerDir }
          : {},
      )
    const boot = this.bootTime()
    const recovery = new DelegationRecovery({
      root: this.options.root,
      attach: async (journal, original) => {
        const record = original.record!,
          id = record.id
        if (this.entries.has(id)) return
        const e: Entry = {
          journal,
          tail: Promise.resolve(),
          stop: true,
          noticesHeld: true,
          waiters: new Set(),
        }
        this.entries.set(id, e)
        for (const run of Object.values(original.runs)) {
          if (run.quotaReserved || run.startedAt !== undefined)
            this.budget.restore(record.owner.taskScopeId, run.usage)
          if (run.phase === 'queued') {
            // Never dispatched: the queue waits for the user.
            await this.append(e, { type: 'dispatch-paused', paused: true })
            continue
          }
          const unresolved =
            run.phase === 'outcome_unknown' && !run.recoveryResolved
          if (TERMINAL_RUN_PHASES.has(run.phase) && !unresolved) continue
          const stop = await this.stopRecordedRun(id, run, boot)
          if (unresolved) {
            if (stop.stopped && run.quiescent !== true)
              await this.append(e, {
                type: 'run-changed',
                runId: run.id,
                patch: { quiescent: true },
              })
            e.held = stop.stopped
              ? { quiescent: true }
              : { quiescent: false, workspace: this.quarantine(record) }
            continue
          }
          // A run in flight when Emperor stopped: interrupted once its
          // process is known to be gone, unresolved if it could not be.
          await this.append(e, {
            type: 'run-changed',
            runId: run.id,
            patch: stop.stopped
              ? {
                  phase: 'interrupted',
                  quiescent: true,
                  finishedAt: Date.now(),
                  failureCode: run.failureCode ?? stop.reason,
                }
              : {
                  phase: 'outcome_unknown',
                  quiescent: false,
                  finishedAt: Date.now(),
                  failureCode: run.failureCode ?? 'OUTCOME_UNKNOWN',
                  acceptance: 'needs_user',
                },
          })
          if (!stop.stopped)
            e.held = { quiescent: false, workspace: this.quarantine(record) }
        }
        for (const run of Object.values(e.journal.load().runs))
          if (
            TERMINAL_RUN_PHASES.has(run.phase) &&
            !e.journal.load().outbox['dgn-' + run.id]
          )
            await this.append(e, {
              type: 'outbox',
              notice: settlementNotice(e.journal.load().record!, run),
            })
        for (const message of Object.values(e.journal.load().messages))
          if (message.status === 'sending')
            await this.append(e, {
              type: 'message-delivery',
              messageId: message.id,
              status: 'delivery_unknown',
            })
        for (const interaction of Object.values(e.journal.load().interactions))
          if (['pending', 'answering'].includes(interaction.state))
            await this.append(e, { ...interaction, state: 'cancelled' })
        // A conversation that owns a workspace must still own it; one that
        // never got one, or is closed, has nothing to lose.
        const current = e.journal.load().record!
        if (
          current.workspaceLeaseId &&
          current.availability !== 'closed' &&
          current.availability !== 'needs_recovery' &&
          !this.workspaceAvailable(current)
        )
          await this.append(e, {
            type: 'recovery',
            reason: 'workspace ownership is missing; existing files retained',
          })
        if (record.clientRequestId && record.requestDigest) {
          const key = JSON.stringify([
            record.owner.rootSessionId,
            record.owner.parentAgentId,
            record.owner.taskScopeId,
            record.clientRequestId,
          ])
          this.starts.set(key, {
            digest: record.requestDigest,
            promise: Promise.resolve(record),
          })
        }
        // Pending notices remain durable until a direct user resumes this root.
      },
    })
    this.recoveryReport = await recovery.reconcile()
    return this.recoveryReport
  }
  async inspectRecovery(
    id: string,
  ): Promise<import('./types').NativeSessionInspection> {
    const e = this.entry(id)
    return this.serial(e, async () => {
      const state = e.journal.load(),
        record = state.record!,
        run = record.currentRunId ? state.runs[record.currentRunId] : undefined
      if (e.active || !run || !TERMINAL_RUN_PHASES.has(run.phase))
        throw new DelegationError(
          'ACTIVE_RUN',
          'inspection requires a settled host run',
        )
      if (run.phase === 'outcome_unknown' && !e.held?.quiescent)
        throw new DelegationError(
          'OUTCOME_UNKNOWN',
          'stop proof is required before native history can be opened',
        )
      if (!record.providerSessionId || !record.startSpec)
        throw new DelegationError(
          'PROVIDER_SESSION_MISSING',
          'delivery has no confirmed native session',
        )
      const adapter = this.options.adapters.get(record.backend)
      if (!adapter?.inspect)
        throw new DelegationError(
          'HISTORY_UNAVAILABLE',
          'executor has no pinned history reader',
        )
      const profile = this.profile({
          ...record.startSpec,
          profileId: record.profileId,
        }),
        runtime = await this.options.runtime(profile, id)
      await this.options.registry.requireAvailable(profile)
      const controller = new AbortController(),
        inspectionId = 'dgr-inspection-' + randomUUID(),
        boundaryReceiptId = 'dgb-' + randomUUID()
      e.inspectionController = controller
      let ownership: ProcessOwnership | undefined
      const timer = setTimeout(() => controller.abort(), 30000)
      timer.unref()
      try {
        const history = await adapter.inspect({
          delegationId: id,
          profile,
          cwd: record.cwd,
          environment: runtime.environment,
          secretValues: runtime.secretValues,
          runtimeRoot: runtime.runtimeRoot,
          resumeSessionId: record.providerSessionId,
          generation: run.generation,
          boundaryReceiptId,
          signal: controller.signal,
          ...(runtime.codexAuth ? { codexAuth: runtime.codexAuth } : {}),
          policy: {
            mode: 'read-only',
            workspaceRoot: record.cwd,
            runtimeStateRoots: [runtime.runtimeRoot],
            privateTempRoot: runtime.tempRoot,
            // Opening the thread may refresh the shared Codex login too.
            ...(runtime.codexAuth
              ? { writableFiles: [codexAuthWritableFile(runtime.codexAuth)] }
              : {}),
          },
          onProcessStarted: async (identity) => {
            ownership = {
              schemaVersion: 1,
              ...identity,
              delegationId: id,
              runId: inspectionId,
              generation: run.generation,
              boundaryReceiptId,
              policyDigest: 'native-history-readonly',
              cwd: record.cwd,
              platform: process.platform,
              descendants: [],
            }
            saveOwnership(this.options.root, ownership)
          },
          onProcessExit: (exit) => {
            if (ownership)
              saveOwnership(this.options.root, { ...ownership, exit })
          },
        })
        if (history.sessionId !== record.providerSessionId)
          throw new DelegationError(
            'PROVIDER_SESSION_CHANGED',
            'history belongs to another session',
          )
        const sanitized = JSON.parse(
          redactExecutorText(
            JSON.stringify(history),
            runtime.secretValues ?? [],
          ),
        ) as import('./types').NativeSessionInspection
        durableReplaceSync(
          join(this.options.root, 'inspections', inspectionId + '.json'),
          JSON.stringify(sanitized) + '\n',
        )
        await this.append(e, {
          type: 'run-changed',
          runId: run.id,
          patch: {
            recoveryInspection: {
              id: inspectionId,
              sessionId: history.sessionId,
              inspectedAt: Date.now(),
              nativeStatus: history.nativeStatus,
            },
          },
        })
        return sanitized
      } finally {
        clearTimeout(timer)
        controller.abort()
        e.inspectionController = undefined
      }
    })
  }
  async recover(
    id: string,
    expectedRevision: number,
  ): Promise<DelegationRecord> {
    const e = this.entry(id)
    return this.serial(e, async () => {
      const state = e.journal.load(),
        record = state.record!,
        run = record.currentRunId ? state.runs[record.currentRunId] : undefined
      if (!run || run.revision !== expectedRevision)
        throw new DelegationError('STALE_REVISION', 'recovery facts changed')
      if (e.active)
        throw new DelegationError(
          'ACTIVE_RUN',
          'live execution cannot be repaired',
        )
      if (run.phase === 'outcome_unknown' && !e.held?.quiescent)
        throw new DelegationError(
          'OUTCOME_UNKNOWN',
          'process shutdown cannot be proved; writer remains quarantined',
        )
      if (
        run.phase === 'outcome_unknown' &&
        record.providerSessionId &&
        !run.recoveryInspection
      )
        throw new DelegationError(
          'HISTORY_NOT_INSPECTED',
          'inspect the native session and preserved workspace before explicit recovery',
        )
      if (!this.workspaceAvailable(record))
        throw new DelegationError(
          'WORKSPACE_UNAVAILABLE',
          'workspace ownership needs inspection; artifacts retained',
        )
      if (run.phase === 'queued')
        await this.append(e, {
          type: 'run-changed',
          runId: run.id,
          patch: {
            phase: 'cancelled',
            finishedAt: Date.now(),
            failureCode: 'RESTART_PAUSED',
            quiescent: true,
          },
        })
      else if (!TERMINAL_RUN_PHASES.has(run.phase))
        throw new DelegationError('ACTIVE_RUN', 'run has not settled')
      for (const message of Object.values(state.messages))
        if (['queued', 'sending', 'delivery_unknown'].includes(message.status))
          await this.append(e, {
            type: 'message-delivery',
            messageId: message.id,
            status: 'cancelled',
          })
      await this.append(e, {
        type: 'run-changed',
        runId: run.id,
        patch: { recoveryResolved: true },
      })
      await this.append(e, { type: 'availability', availability: 'idle' })
      await this.append(e, { type: 'dispatch-paused', paused: false })
      e.held?.workspace?.release()
      e.held = undefined
      e.stop = false
      e.noticesHeld = false
      return e.journal.load().record!
    })
  }
  async resumeRootNotices(rootSessionId: string): Promise<void> {
    for (const e of this.entries.values())
      if (e.journal.load().record!.owner.rootSessionId === rootSessionId) {
        // Only resume automatic notification, never a queued provider operation.
        const state = e.journal.load(),
          run = state.record!.currentRunId
            ? state.runs[state.record!.currentRunId]
            : undefined
        if (run && !TERMINAL_RUN_PHASES.has(run.phase)) continue
        e.noticesHeld = false
        // Appended only when it was paused (AGT-04: no change, no event).
        await this.serial(e, () =>
          this.append(e, { type: 'dispatch-paused', paused: false }),
        )
        if (
          Object.values(state.outbox).some(
            (notice) => !notice.delivered && notice.recipient !== 'collector',
          )
        )
          await this.dispatchNotices(state.record!.id)
      }
  }
  async dispatchNotices(id: string): Promise<void> {
    const e = this.entry(id)
    if (!this.options.notices) return
    const operation = (e.noticeTail ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const state = e.journal.load(),
          record = state.record!
        const outbox = new DelegationNoticeOutbox({
          ...this.options.notices!,
          canWake: (owner) =>
            !e.noticesHeld &&
            !e.journal.load().record!.dispatchPaused &&
            this.options.notices!.canWake(owner),
          markDelivered: (noticeId) =>
            this.serial(e, () =>
              this.append(e, { type: 'notice-delivered', noticeId }),
            ),
        })
        for (const notice of Object.values(state.outbox))
          if (!notice.delivered && notice.recipient !== 'collector')
            await outbox.dispatch(record.owner, notice)
      })
    e.noticeTail = operation
    await operation
  }
  private entry(id: string): Entry {
    safeDelegationKey(id)
    const e = this.entries.get(id)
    if (e) return e
    throw new DelegationError(
      'DELEGATION_NOT_FOUND',
      'conversation is not loaded',
    )
  }
  inspect(id: string): DelegationState {
    return this.entry(id).journal.load()
  }
  list(): DelegationState[] {
    return [...this.entries.values()].map((e) => e.journal.load())
  }
  async probeProfiles(): Promise<void> {
    let config: ExecutorConfig
    try {
      config = this.options.config()
    } catch {
      return
    }
    this.budget.reconfigure(config)
    await Promise.all(
      config.profiles
        .filter((p) => p.enabled)
        .map(async (profile) => {
          let probe: ExecutorProbe
          try {
            probe = await this.options.registry.requireAvailable(profile)
          } catch (error) {
            probe = {
              status:
                error instanceof DelegationError &&
                error.code === 'EXECUTOR_MISSING'
                  ? 'missing'
                  : 'incompatible',
              capabilities: this.options.registry.capabilities(profile.backend),
              checkedAt: Date.now(),
              authVerified: false,
              diagnostic:
                error instanceof DelegationError
                  ? error.message.replace(/^[A-Z_]+: /, '').slice(0, 512)
                  : 'executor preflight failed',
            }
          }
          this.facts.setProbe(profile, probe)
        }),
    )
  }
  /** Revoke existing processes when any live ancestor narrows their authority. */
  /**
   * A conversation of this root may now do more than its parent allows.
   * Closed conversations never count; one whose parent subagent has ended
   * (or is not loaded after a restart) is checked against the root (AGT-09).
   */
  parentPermissionsRevoked(rootSessionId: string): boolean {
    return this.list().some((state) => {
      const record = state.record!
      if (record.owner.rootSessionId !== rootSessionId) return false
      if (record.availability === 'closed') return false
      const parent = this.parentOrRoot(record.owner)
      if (parent === null) return false
      return (
        // Plan mode still allows a read-only review (AGT-05).
        (!!parent.planMode && record.effectivePermission !== 'read-only') ||
        permissionRank(parent.policy.mode) <
          permissionRank(record.effectivePermission)
      )
    })
  }
  private parentOrRoot(owner: DelegationOwner): DelegationParentContext | null {
    try {
      return this.options.parent(owner)
    } catch {
      if (owner.parentAgentId === owner.rootSessionId) return null
      try {
        return this.options.parent({
          ...owner,
          parentAgentId: owner.rootSessionId,
        })
      } catch {
        return null
      }
    }
  }
  hasOutstanding(
    owner: string | Pick<DelegationOwner, 'rootSessionId'>,
  ): boolean {
    const root = typeof owner === 'string' ? owner : owner.rootSessionId
    return this.list().some(
      (state) =>
        state.record?.owner.rootSessionId === root &&
        (state.record.availability === 'needs_recovery' ||
          Object.values(state.runs).some(
            (run) => !TERMINAL_RUN_PHASES.has(run.phase),
          ) ||
          Object.values(state.messages).some(
            (message) =>
              message.status === 'queued' ||
              message.status === 'sending' ||
              // An unknown delivery is still pending only while its run is;
              // after that it is history (never resent), not work (AGT-04).
              (message.status === 'delivery_unknown' &&
                (!message.runId ||
                  !TERMINAL_RUN_PHASES.has(
                    state.runs[message.runId]?.phase ?? 'running',
                  ))),
          )),
    )
  }
  requiredForGoal(
    goal: { id: string; revision: number },
    rootSessionId: string,
  ): DelegationState[] {
    return this.list().filter(
      (state) =>
        state.record?.owner.rootSessionId === rootSessionId &&
        state.record.owner.requiredForGoal &&
        state.record.owner.goalRef?.id === goal.id,
    )
  }
  async disposeGoalFailure(id: string, reason: string): Promise<void> {
    const e = this.entry(id),
      state = e.journal.load(),
      record = state.record!,
      run = state.runs[record.currentRunId!]
    if (
      !reason.trim() ||
      Buffer.byteLength(reason) > 4096 ||
      !record.owner.requiredForGoal ||
      !run ||
      !TERMINAL_RUN_PHASES.has(run.phase) ||
      !run.quiescent ||
      run.acceptance === 'passed' ||
      Object.values(state.messages).some((m) =>
        ['queued', 'sending', 'delivery_unknown'].includes(m.status),
      )
    )
      throw new DelegationError(
        'INVALID_DISPOSITION',
        'explicit human reason and a settled failed or unverified required run are required',
      )
    await this.change(e, run.id, {
      goalFailureDisposition: {
        source: 'human',
        reason: reason.trim(),
        at: Date.now(),
      },
    })
  }
  private goalProof(
    goal: { id: string; revision: number },
    root: string,
  ): string {
    return JSON.stringify(
      this.requiredForGoal(goal, root)
        .map((state) => ({
          id: state.record!.id,
          currentRunId: state.record!.currentRunId,
          availability: state.record!.availability,
          runs: Object.values(state.runs).map((run) => [run.id, run.revision]),
          messages: Object.values(state.messages).map((message) => [
            message.id,
            message.status,
          ]),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    )
  }
  goalCompletionCurrent(
    goal: { id: string; revision: number },
    root: string,
  ): boolean {
    return (
      this.goalProofs.get(JSON.stringify([root, goal.id])) ===
      this.goalProof(goal, root)
    )
  }
  async verifyGoalCompletion(
    goal: { id: string; revision: number },
    rootSessionId: string,
  ): Promise<void> {
    const key = JSON.stringify([rootSessionId, goal.id]),
      proof = this.goalProof(goal, rootSessionId)
    this.goalProofs.delete(key)
    // 高级 › 验证后再应用: every result goes through its receipt (AGT-06).
    let verifyFirst = false
    try {
      verifyFirst = this.options.config().verifyBeforeApply === true
    } catch {
      /* an unreadable configuration keeps the default */
    }
    for (const state of this.requiredForGoal(goal, rootSessionId)) {
      const record = state.record!,
        run = record.currentRunId ? state.runs[record.currentRunId] : undefined
      if (
        run?.goalFailureDisposition?.source === 'human' &&
        run.quiescent &&
        TERMINAL_RUN_PHASES.has(run.phase) &&
        record.availability === 'closed'
      )
        continue
      // Marked as ended by the user (or the model, with approval): disposed.
      if (run?.abandoned && TERMINAL_RUN_PHASES.has(run.phase)) continue
      // Its result was applied (or undone, or discarded) by a decision: disposed (AGT-06).
      if (
        run?.result &&
        run.phase === 'completed' &&
        ['applied', 'reverted', 'discarded'].includes(run.result.state)
      )
        continue
      // A text result: a review, or a run that changed no file (AGT-06);
      // a run with a receipt (验证后再应用) keeps the receipt's say.
      const resultOnly = run?.receiptId
        ? run.acceptance === 'unverified' &&
          this.options.deliveryRequiresAcceptance?.(run.receiptId, record) ===
            false
        : !!run &&
          !verifyFirst &&
          (run.result
            ? run.result.totals.files === 0
            : record.startSpec?.workspace === 'shared-readonly')
      if (
        !run ||
        record.availability === 'needs_recovery' ||
        run.phase !== 'completed' ||
        !run.quiescent ||
        Object.values(state.messages).some((message) =>
          ['queued', 'sending', 'delivery_unknown'].includes(message.status),
        ) ||
        (!resultOnly &&
          (run.acceptance !== 'passed' ||
            !run.acceptanceId ||
            (await this.options.acceptanceCurrent?.(run.acceptanceId))
              ?.state !== 'passed'))
      )
        throw new DelegationError(
          'REQUIRED_DELEGATION_UNVERIFIED',
          `required delegation ${record.id} has no current host acceptance or settled text result; apply or discard its result (collect_agent apply=true asks the user), or check its file deliverables before delivery`,
        )
    }
    if (this.goalProof(goal, rootSessionId) !== proof)
      throw new DelegationError(
        'REQUIRED_DELEGATION_UNVERIFIED',
        'required delegation state changed during completion verification',
      )
    this.goalProofs.set(key, proof)
  }
  /**
   * Runtime context for the parent model. Nothing at all when no external
   * executor is enabled; otherwise a short note (AGT-05: kept well under 600
   * tokens, never telling the model to skip the user).
   */
  executorContext(): string {
    let config: ExecutorConfig
    try {
      config = this.options.config()
    } catch {
      return ''
    }
    const enabled = config.profiles.filter((profile) => profile.enabled)
    if (!enabled.length) return ''
    return [
      'External subagents: the subagent tool can also hand a task to a local CLI (backend=claude-code or backend=codex). Internal subagents remain the default.',
      'Choose an external backend when the user asks for one or the task clearly fits it; follow an explicit user choice, and reuse an existing child for follow-ups on the same task.',
      'The first dispatch to each executor asks the user, because it uses their own subscription quota or API billing; if they decline, the task runs as an internal subagent.',
      'Collect text results directly; check changed files before delivery or integration. A model or tool capability stays unknown until a run proves it. Do not run these CLIs through Bash to bypass managed delegation.',
      'Enabled executors:',
      ...enabled.map((profile) => this.executorLine(profile)),
    ].join('\n')
  }
  private executorLine(profile: ExecutorProfile): string {
    const probe = this.facts.probe(profile),
      facts = this.facts.view(profile),
      model =
        profile.defaultModel ??
        facts.reportedModel ??
        facts.configuredModel ??
        'CLI default'
    const parts = [
      'status=' + (probe?.status ?? 'unchecked'),
      ...(probe?.compatibility === 'unverified'
        ? ['protocol unverified (a failure may be the version)']
        : []),
      'model=' + model,
      'specialties=' + (executorSpecialties(profile).join(', ') || 'none'),
      'search=' + facts.nativeCapabilities.search.status,
      ...(profile.backend === 'codex'
        ? [
            'image generation=' +
              facts.nativeCapabilities.imageGeneration.status,
            'steer=yes',
          ]
        : ['steer=no']),
    ]
    return '- ' + profile.id + ' (' + profile.backend + '): ' + parts.join('; ')
  }
  async stopRoot(rootSessionId: string): Promise<void> {
    const auxiliary = this.options.onStopRoot?.(rootSessionId)
    this.rootEpochs.set(
      rootSessionId,
      (this.rootEpochs.get(rootSessionId) ?? 0) + 1,
    )
    const entries = [...this.entries.values()].filter(
      (e) => e.journal.load().record?.owner.rootSessionId === rootSessionId,
    )
    for (const e of entries) e.inspectionController?.abort()
    await Promise.all(
      entries.map(async (e) => {
        const state = e.journal.load(),
          id = state.record!.id,
          run = state.record!.currentRunId
            ? state.runs[state.record!.currentRunId]
            : undefined
        if (run && !TERMINAL_RUN_PHASES.has(run.phase)) {
          // Its result must not wake the stopped parent by itself.
          e.noticesHeld = true
          await this.serial(e, () =>
            this.append(e, { type: 'dispatch-paused', paused: true }),
          )
          // interrupt() sets e.stop and writes `cancelling` together (SUB-29).
          await this.interrupt(id, run.id).catch((error) => {
            if (
              !(error instanceof DelegationError) ||
              error.code !== 'STALE_RUN'
            )
              throw error
          })
          return
        }
        // A settled conversation is not rewritten: its pending notices are
        // held in memory and a queued message, if any, is cancelled
        // (AGT-04: no event for every historical conversation on every stop).
        await this.serial(e, async () => {
          e.stop = true
          e.noticesHeld = true
          for (const message of Object.values(e.journal.load().messages))
            if (message.status === 'queued')
              await this.append(e, {
                type: 'message-delivery',
                messageId: message.id,
                status: 'cancelled',
              })
        })
      }),
    )
    await auxiliary
  }
  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      this.disposed = true
      const roots = new Set([
        ...this.rootEpochs.keys(),
        ...this.list().map((s) => s.record!.owner.rootSessionId),
      ])
      await Promise.all([...roots].map((id) => this.stopRoot(id)))
    })()
    return this.shutdownPromise
  }
  private serial<T>(e: Entry, action: () => Promise<T>): Promise<T> {
    const next = e.tail.catch(() => undefined).then(action)
    e.tail = next
    return next
  }
  private async append(e: Entry, event: DelegationEvent): Promise<void> {
    // An event that changes nothing is not written, published or projected.
    if (!(await e.journal.append(event)).changed) return
    const state = e.journal.load()
    if (event.type === 'message-delivery' && event.status === 'accepted') {
      const message = state.messages[event.messageId]
      const run = message?.runId ? state.runs[message.runId] : undefined
      if (message && run && message.id !== run.messageId) {
        // Record the acknowledged public instruction at its actual durable
        // transcript position before publishing the state callback. No await
        // separates this append from the snapshot/notification below.
        try {
          const directory = join(
            this.options.root,
            'conversations',
            state.record!.id,
            'runs',
          )
          mkdirSync(directory, { recursive: true, mode: 0o700 })
          appendFileSync(
            join(directory, run.id + '.jsonl'),
            JSON.stringify({
              type: 'public_prompt',
              delegationId: state.record!.id,
              runId: run.id,
              generation: run.generation,
              messageId: message.id,
              text: message.text,
              status: 'accepted',
            }) + '\n',
            { mode: 0o600 },
          )
        } catch {
          // The accepted instruction remains authoritative in the control
          // journal. History reconstructs it with explicit unknown chronology
          // if its output-position mirror could not be written.
        }
      }
    }
    this.options.onState?.(state, event)
    for (const wake of e.waiters) wake()
  }
  private profile(spec: DelegationStart): ExecutorProfile {
    const p = this.options
      .config()
      .profiles.find(
        (p) =>
          p.backend === spec.backend &&
          (spec.profileId ? p.id === spec.profileId : p.enabled),
      )
    if (!p)
      throw new DelegationError(
        'PROFILE_NOT_FOUND',
        'requested executor profile missing',
      )
    return p
  }
  start(
    owner: DelegationOwner,
    spec: DelegationStart,
    signal?: AbortSignal,
  ): Promise<DelegationRecord> {
    if (this.disposed)
      return Promise.reject(
        new DelegationError('EXECUTOR_CLOSED', 'delegation service is closing'),
      )
    const key = JSON.stringify([
      owner.rootSessionId,
      owner.parentAgentId,
      owner.taskScopeId,
      spec.clientRequestId,
    ])
    const digest = createHash('sha256')
      .update(JSON.stringify(spec))
      .digest('hex')
    const previous = this.starts.get(key)
    if (previous) {
      if (previous.digest !== digest)
        return Promise.reject(
          new DelegationError('IDEMPOTENCY_CONFLICT', 'start request changed'),
        )
      return previous.promise
    }
    const promise = this.create(owner, spec, digest, signal)
    this.starts.set(key, { digest, promise })
    void promise.catch(() => {
      if (
        ![...this.entries.values()].some(
          (e) => e.journal.load().record?.requestDigest === digest,
        )
      )
        this.starts.delete(key)
    })
    return promise
  }
  private async create(
    owner: DelegationOwner,
    spec: DelegationStart,
    digest: string,
    signal?: AbortSignal,
  ): Promise<DelegationRecord> {
    if (signal?.aborted)
      throw new DelegationError(
        'ABORTED',
        'caller stopped before delegation start',
      )
    const epoch = this.rootEpochs.get(owner.rootSessionId) ?? 0
    this.rootEpochs.set(owner.rootSessionId, epoch)
    if (!spec.clientRequestId || !spec.prompt.trim())
      throw new DelegationError(
        'INVALID_REQUEST',
        'request identity and prompt required',
      )
    if (Buffer.byteLength(spec.prompt) > 32 * 1024)
      throw new DelegationError(
        'BRIEF_LIMIT',
        'delegation brief exceeds 32 KiB',
      )
    const config = this.options.config(),
      parent = this.options.parent(owner)
    const effective = this.policy.resolve(
      parent,
      spec,
      owner,
      config.limits.maxDepth,
    )
    const profile = this.profile(spec)
    const probe = await this.options.registry.requireAvailable(profile, signal)
    if (
      this.options.consent &&
      !(await this.options.consent(owner, profile, spec, signal))
    )
      throw new DelegationError(
        'EXECUTOR_CONSENT_DENIED',
        'the user did not allow this external executor',
      )
    if (
      signal?.aborted ||
      this.disposed ||
      (this.rootEpochs.get(owner.rootSessionId) ?? 0) !== epoch
    )
      throw new DelegationError(
        'ABORTED',
        'root session stopped before delegation was accepted',
      )
    this.facts.setProbe(profile, probe)
    if (!this.options.adapters.has(spec.backend))
      throw new DelegationError(
        'EXECUTOR_UNAVAILABLE',
        'backend adapter not registered',
      )
    const id = 'dlg-' + randomUUID(),
      messageId = 'dgm-' + randomUUID(),
      runId = 'dgr-' + randomUUID()
    const record: DelegationRecord = {
      schemaVersion: 1,
      id,
      owner: structuredClone(owner),
      backend: spec.backend,
      profileId: profile.id,
      cwd: parent.cwd,
      workspaceLeaseId: '',
      effectivePermission: effective.mode,
      capabilitySnapshot: probe.capabilities,
      ...(probe.executableVersion
        ? { executorVersion: probe.executableVersion }
        : {}),
      availability: 'idle',
      createdAt: Date.now(),
      clientRequestId: spec.clientRequestId,
      requestDigest: digest,
      startSpec: structuredClone(spec),
    }
    const entry: Entry = {
      journal: new DelegationJournal(this.options.root, id),
      tail: Promise.resolve(),
      stop: false,
      waiters: new Set(),
    }
    this.entries.set(id, entry)
    await this.append(entry, { type: 'created', record })
    await this.append(entry, {
      type: 'message-enqueued',
      message: { id: messageId, text: spec.prompt, status: 'queued' },
    })
    await this.append(entry, {
      type: 'run-created',
      run: {
        id: runId,
        delegationId: id,
        revision: 0,
        generation: 1,
        messageId,
        phase: 'queued',
        acceptance: 'unverified',
      },
    })
    const result = entry.journal.load().record!
    if (signal) {
      const abort = () => {
        void this.interrupt(id, runId).catch(() => undefined)
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void this.wait(id, runId).then(
        () => signal.removeEventListener('abort', abort),
        () => signal.removeEventListener('abort', abort),
      )
    }
    this.pump(id)
    return result
  }
  async send(
    id: string,
    input: {
      messageId: string
      text: string
      delivery: 'queue' | 'steer'
      expectedRunId?: string
      signal?: AbortSignal
    },
  ): Promise<{
    messageId: string
    state: 'queued' | 'accepted'
    runId?: string
  }> {
    const e = this.entry(id)
    const result = await this.serial(e, async () => {
      if (input.signal?.aborted)
        throw new DelegationError('ABORTED', 'parent tool call was cancelled')
      safeDelegationKey(input.messageId)
      if (!input.text.trim() || Buffer.byteLength(input.text) > 32 * 1024)
        throw new DelegationError(
          'BRIEF_LIMIT',
          'message is empty or exceeds 32 KiB',
        )
      const state = e.journal.load(),
        record = state.record!,
        run = record.currentRunId ? state.runs[record.currentRunId] : undefined
      if (
        record.availability === 'closed' ||
        record.availability === 'needs_recovery'
      )
        throw new DelegationError(
          'NEEDS_RECOVERY',
          'conversation is closed or requires recovery',
        )
      if (record.dispatchPaused && run?.phase === 'queued')
        throw new DelegationError(
          'RESTART_PAUSED',
          'review the preserved queue before sending new work',
        )
      const previous = state.messages[input.messageId]
      if (previous) {
        if (previous.text !== input.text)
          throw new DelegationError(
            'IDEMPOTENCY_CONFLICT',
            'message id content changed',
          )
        if (previous.status === 'delivery_unknown')
          throw new DelegationError(
            'DELIVERY_UNKNOWN',
            'message acceptance is unknown',
          )
        if (previous.status === 'cancelled')
          throw new DelegationError(
            'MESSAGE_CANCELLED',
            'this message was cancelled; use a new explicit send',
          )
        return {
          messageId: input.messageId,
          state:
            previous.status === 'accepted'
              ? ('accepted' as const)
              : ('queued' as const),
        }
      }
      if (e.stop && run && !TERMINAL_RUN_PHASES.has(run.phase))
        throw new DelegationError(
          'STOPPING',
          'wait for current cancellation proof before sending another message',
        )
      const spec = record.startSpec!
      const effective = this.policy.resolve(
        this.options.parent(record.owner),
        spec,
        record.owner,
        this.options.config().limits.maxDepth,
      )
      if (
        permissionRank(effective.mode) <
        permissionRank(record.effectivePermission)
      )
        throw new DelegationError(
          'PERMISSION_REVOKED',
          'parent permission narrowed; create a new delegation',
        )
      if (input.delivery === 'steer') {
        if (
          !run ||
          run.id !== input.expectedRunId ||
          run.phase !== 'running' ||
          !e.session ||
          !run.providerTurnId
        )
          throw new DelegationError(
            'STALE_RUN',
            'steer requires the current running turn',
          )
        if (!record.capabilitySnapshot.steer)
          throw new DelegationError(
            'UNSUPPORTED_OPTION',
            'executor does not support steer',
          )
        await this.append(e, {
          type: 'message-enqueued',
          message: { id: input.messageId, text: input.text, status: 'queued' },
        })
        await this.append(e, {
          type: 'send-intent',
          runId: run.id,
          messageId: input.messageId,
        })
        if (e.stop || input.signal?.aborted) {
          await this.append(e, {
            type: 'message-delivery',
            messageId: input.messageId,
            status: 'cancelled',
          })
          throw new DelegationError(
            'ABORTED',
            'parent stopped before steer was sent',
          )
        }
        try {
          await e.session.steer({
            providerTurnId: run.providerTurnId,
            messageId: input.messageId,
            text: input.text,
          })
          await this.append(e, {
            type: 'message-delivery',
            messageId: input.messageId,
            status: 'accepted',
          })
        } catch (error) {
          await this.append(e, {
            type: 'message-delivery',
            messageId: input.messageId,
            status: 'delivery_unknown',
          })
          throw error
        }
        return {
          messageId: input.messageId,
          state: 'accepted' as const,
          runId: run.id,
        }
      }
      // The current run's own initial message is not part of the followup queue.
      const count = Object.values(state.messages).filter(
        (m) => m.status === 'queued' && m.id !== run?.messageId,
      ).length
      if (count >= this.options.config().limits.maxQueuedMessages)
        throw new DelegationError('QUEUE_LIMIT', 'queued message limit reached')
      e.stop = false
      e.noticesHeld = false
      await this.append(e, { type: 'dispatch-paused', paused: false })
      await this.append(e, {
        type: 'message-enqueued',
        message: { id: input.messageId, text: input.text, status: 'queued' },
      })
      return { messageId: input.messageId, state: 'queued' as const }
    })
    this.pump(id)
    return result
  }
  private pump(id: string): void {
    const e = this.entry(id)
    if (e.active || e.stop || e.journal.load().record?.dispatchPaused) return
    const state = e.journal.load()
    if (
      state.record!.availability === 'closed' ||
      state.record!.availability === 'needs_recovery'
    )
      return
    const current = state.record!.currentRunId
      ? state.runs[state.record!.currentRunId]
      : undefined
    if (
      current &&
      !TERMINAL_RUN_PHASES.has(current.phase) &&
      current.phase !== 'queued'
    )
      return
    const next = Object.values(state.messages)
      .filter((m) => m.status === 'queued')
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0]
    if (!next) return
    const operation = this.execute(
      id,
      current?.phase === 'queued' ? current.id : undefined,
      next.id,
    )
    const settled = operation
      .catch(async () => {
        await this.append(e, {
          type: 'recovery',
          reason: 'dispatch finalization failed; effects require inspection',
        })
      })
      .finally(() => {
        if (e.active === settled) e.active = undefined
        for (const wake of e.waiters) wake()
        this.pump(id)
      })
    e.active = settled
    void settled.catch(() => undefined)
  }
  private async change(
    e: Entry,
    runId: string,
    patch: Extract<DelegationEvent, { type: 'run-changed' }>['patch'],
  ): Promise<void> {
    await this.serial(e, async () => {
      const run = e.journal.load().runs[runId]
      if (run && (!TERMINAL_RUN_PHASES.has(run.phase) || !('phase' in patch)))
        await this.append(e, { type: 'run-changed', runId, patch })
    })
  }
  private async execute(
    id: string,
    existingRun: string | undefined,
    messageId: string,
  ): Promise<void> {
    const e = this.entry(id)
    let state = e.journal.load(),
      record = state.record!,
      runId = existingRun
    if (!runId) {
      runId = 'dgr-' + randomUUID()
      const generation =
        Math.max(0, ...Object.values(state.runs).map((r) => r.generation)) + 1
      const run: DelegationRunRecord = {
        id: runId,
        delegationId: id,
        revision: 0,
        generation,
        messageId,
        phase: 'queued',
        acceptance: 'unverified',
      }
      await this.serial(e, () => this.append(e, { type: 'run-created', run }))
    }
    const activeRunId = runId
    const controller = new AbortController()
    e.controller = controller
    e.inputFailure = undefined
    e.timedOut = false
    e.closing = undefined
    let budget: BudgetLease | undefined,
      workspace: ResourceLease | undefined,
      session: ExecutorSession | undefined,
      timer: ReturnType<typeof setTimeout> | undefined
    let sent = false,
      accepted = false,
      quiescent = true,
      status: 'completed' | 'failed' | 'interrupted' | undefined,
      summary = '',
      failureCode: string | undefined,
      usage: DelegationRunRecord['usage'],
      /** Set when the CLI's protocol only matched by minor (AGT-01). */
      protocolNote: string | undefined
    let structured: unknown
    try {
      if (e.stop) controller.abort()
      const config = this.options.config()
      this.budget.reconfigure(config)
      if (this.options.taskBudget?.exhausted(record.owner))
        throw new DelegationError(
          'BUDGET_LIMIT',
          'the root task has spent its cost cap',
        )
      budget = await this.budget.reserve(
        record.owner.taskScopeId,
        record.profileId,
        controller.signal,
      )
      await this.change(e, activeRunId, { quotaReserved: true })
      if (e.stop)
        throw new DelegationError('ABORTED', 'cancelled before prepare')
      await this.change(e, activeRunId, {
        phase: 'preparing',
        startedAt: Date.now(),
      })
      const spec = record.startSpec!,
        profile = this.profile({ ...spec, profileId: record.profileId })
      const effective = this.policy.resolve(
        this.options.parent(record.owner),
        spec,
        record.owner,
        config.limits.maxDepth,
      )
      if (
        permissionRank(effective.mode) <
        permissionRank(record.effectivePermission)
      )
        throw new DelegationError(
          'PERMISSION_REVOKED',
          'parent permissions narrowed',
        )
      if (!record.workspaceLeaseId) {
        const lease = await this.options.workspaces.prepare(record.owner, {
          cwd: record.cwd,
          workspace: spec.workspace,
          base: spec.base,
          readOnly: record.effectivePermission === 'read-only',
          // Stopping the run ends its wait for the workspace (AGT-06).
          signal: controller.signal,
        })
        await this.serial(e, () =>
          this.append(e, {
            type: 'workspace-bound',
            leaseId: lease.id,
            cwd: lease.cwd,
          }),
        )
        record = e.journal.load().record!
      }
      if (e.stop || controller.signal.aborted)
        throw new DelegationError('ABORTED', 'cancelled during prepare')
      if (spec.workspace === 'shared-exclusive')
        workspace = await this.options.mutations.resources.acquire(
          {
            keys: [workspaceMutationDomain(record.cwd)],
            mode: 'exclusive',
            owner: id,
          },
          controller.signal,
        )
      else if (spec.workspace === 'isolated-worktree')
        workspace = await this.options.mutations.acquireWriter(
          record.cwd,
          id,
          controller.signal,
        )
      const runtime = await this.options.runtime(profile, id)
      const effectiveProfile = {
        ...profile,
        defaultModel: spec.model ?? profile.defaultModel,
      }
      const billing: ExecutorBilling = runtime.billing ?? 'api'
      let model = effectiveProfile.defaultModel,
        modelProvider: string | undefined
      this.facts.bind(effectiveProfile, runtime.environment, activeRunId)
      if (e.stop || controller.signal.aborted)
        throw new DelegationError('ABORTED', 'cancelled before process open')
      const preflight = await this.options.registry.requireAvailable(
        profile,
        controller.signal,
      )
      if (preflight.compatibility === 'unverified')
        protocolNote =
          preflight.diagnostic ??
          'the executor protocol is not a verified one; it may be incompatible'
      state = e.journal.load()
      const run = state.runs[activeRunId]!
      const lease = record.workspaceLeaseId
        ? this.options.workspaces.get(record.workspaceLeaseId)
        : undefined
      const prior = Object.values(state.runs).filter(
        (r) => r.id !== activeRunId && r.providerTurnId,
      )
      // Claude reports the session's running cost; a subscription keeps it
      // as nominal, which still counts toward the baseline.
      const reported = (r: DelegationRunRecord) =>
        r.usage?.estimatedUsd ?? r.usage?.nominalUsd
      const usageBaseline = prior.every((r) => reported(r) !== undefined)
        ? {
            estimatedUsd: prior.reduce((n, r) => n + reported(r)!, 0),
          }
        : undefined
      // The first message carries the task's name; a follow-up is a new
      // instruction and is delivered as written (AGT-05).
      const firstMessage = Object.keys(state.messages)[0] === messageId
      const dispatchText = (
        firstMessage ? buildDelegationBrief : buildDelegationContext
      )({
        prompt: state.messages[messageId]!.text,
        description: spec.description,
        context: spec.context,
        ...(lease?.snapshot
          ? {
              workspace: {
                cwd: record.cwd,
                base: spec.base,
                commit: lease.snapshot.commit,
                manifestDigest: lease.snapshot.manifestDigest,
                excluded: lease.snapshot.excluded,
              },
            }
          : {}),
      })
      const boundaryReceiptId = 'dgb-' + randomUUID(),
        policyDigest = createHash('sha256')
          .update(
            JSON.stringify({
              cwd: record.cwd,
              permission: record.effectivePermission,
              runtimeRoot: runtime.runtimeRoot,
              commonDir: lease?.snapshot?.commonDir ?? null,
            }),
          )
          .digest('hex')
      let ownership: ProcessOwnership | undefined
      session = await this.options.adapters.get(record.backend)!.open({
        onProcessStarted: async (identity) => {
          ownership = {
            schemaVersion: 1,
            ...identity,
            delegationId: id,
            runId: activeRunId,
            generation: run.generation,
            boundaryReceiptId,
            policyDigest,
            cwd: record.cwd,
            platform: process.platform,
            descendants: [],
          }
          saveOwnership(this.options.root, ownership)
          await this.change(e, activeRunId, {
            process: { ...identity, boundaryReceiptId, policyDigest },
          })
        },
        onProcessExit: (exit) => {
          if (ownership) {
            ownership = { ...ownership, exit }
            saveOwnership(this.options.root, ownership)
          }
        },
        delegationId: id,
        profile: {
          ...profile,
          defaultModel: spec.model ?? profile.defaultModel,
        },
        outputSchema: spec.outputSchema,
        usageBaseline,
        ...(billing === 'api'
          ? { budgetUsd: this.budget.remainingUsd(record.owner.taskScopeId) }
          : {}),
        cwd: record.cwd,
        environment: runtime.environment,
        boundaryReceiptId,
        resumeSessionId: record.providerSessionId,
        generation: run.generation,
        signal: controller.signal,
        runtimeRoot: runtime.runtimeRoot,
        secretValues: runtime.secretValues,
        ...(runtime.codexAuth ? { codexAuth: runtime.codexAuth } : {}),
        policy: {
          mode: record.effectivePermission,
          workspaceRoot: record.cwd,
          runtimeStateRoots: [runtime.runtimeRoot],
          privateTempRoot: runtime.tempRoot,
          readOnlyRoots: lease?.snapshot
            ? [lease.snapshot.commonDir, join(lease.path, '.git')]
            : [],
          // A token refresh rewrites the user's Codex login in place through
          // the isolated home's link; nothing beside that one file.
          ...(runtime.codexAuth
            ? { writableFiles: [codexAuthWritableFile(runtime.codexAuth)] }
            : {}),
        },
      })
      e.session = session
      if (e.stop || controller.signal.aborted)
        throw new DelegationError('ABORTED', 'cancelled before submit')
      await this.serial(e, () =>
        this.append(e, { type: 'send-intent', runId: activeRunId, messageId }),
      )
      if (e.stop || controller.signal.aborted)
        throw new DelegationError('ABORTED', 'cancelled before submit')
      sent = true
      const provider = await session.submit({
        runId: activeRunId,
        messageId,
        text: dispatchText,
        outputSchema: spec.outputSchema,
      })
      accepted = true
      await this.serial(e, async () => {
        await this.append(e, {
          type: 'provider-bound',
          runId: activeRunId,
          sessionId: session!.providerSessionId,
          turnId: provider.providerTurnId,
          generation: run.generation,
        })
        await this.append(e, {
          type: 'message-delivery',
          messageId,
          status: 'accepted',
        })
        const current = e.journal.load().runs[activeRunId]!
        if (current.phase === 'preparing')
          await this.append(e, {
            type: 'run-changed',
            runId: activeRunId,
            patch: { phase: 'running' },
          })
      })
      // The only backstop for a long turn: the protocol's idle timer pauses
      // while a turn runs or a question waits for the user.
      timer = setTimeout(() => {
        e.timedOut = true
        void this.interrupt(id, activeRunId).catch(() => undefined)
      }, config.limits.runTimeoutMs)
      timer.unref()
      let bytes = 0
      for await (const raw of session.events) {
        if (
          raw.delegationId !== id ||
          raw.runId !== activeRunId ||
          raw.generation !== run.generation
        )
          continue
        const text = redactExecutorText(
          JSON.stringify(raw),
          runtime.secretValues ?? [],
        )
        bytes += Buffer.byteLength(text)
        if (bytes > 32 * 1024 * 1024)
          throw new DelegationError(
            'OUTPUT_LIMIT',
            'run transcript exceeded 32 MiB',
          )
        const event = JSON.parse(text) as NormalizedExecutorEvent
        mkdirSync(join(this.options.root, 'conversations', id, 'runs'), {
          recursive: true,
          mode: 0o700,
        })
        appendFileSync(
          join(
            this.options.root,
            'conversations',
            id,
            'runs',
            activeRunId + '.jsonl',
          ),
          text + '\n',
          { mode: 0o600 },
        )
        this.facts.observe(
          effectiveProfile,
          {
            cwd: record.cwd,
            runId: activeRunId,
            delegationId: id,
            permissionMode: record.effectivePermission,
            ...(record.backend === 'codex'
              ? {
                  nativeImageRoot: nativeGeneratedImageRoot(
                    runtime.runtimeRoot,
                    this.options.root,
                  ),
                }
              : {}),
          },
          event,
        )
        if (event.type === 'text_delta')
          summary = boundText(summary + event.text, 8192)
        if (event.type === 'runtime_metadata') {
          if (event.model) model = event.model
          if (event.provider) modelProvider = event.provider
        }
        if (event.type === 'usage') {
          const { type: _type, ...reported } = event as typeof event & {
            type: 'usage'
          }
          usage = billUsage(
            { ...usage, ...withoutRunFields(reported) },
            billing,
            (counts) =>
              this.options.estimateUsd?.({
                backend: record.backend,
                ...(model ? { model } : {}),
                ...(modelProvider ? { provider: modelProvider } : {}),
                ...((runtime.environment.OPENAI_BASE_URL ??
                runtime.environment.ANTHROPIC_BASE_URL)
                  ? {
                      baseUrl:
                        runtime.environment.OPENAI_BASE_URL ??
                        runtime.environment.ANTHROPIC_BASE_URL,
                    }
                  : {}),
                usage: counts,
              }) ?? null,
            'estimatedUsd' in event,
          )
          // A run that takes its task past a cap stops now (AGT-07).
          const over = this.budget.exceeds(record.owner.taskScopeId, usage)
          if (over) throw over
        }
        if (event.type === 'transport_error')
          throw new DelegationError(event.code, event.message)
        if (
          event.type === 'session_bound' &&
          event.sessionId !== session.providerSessionId
        )
          throw new DelegationError(
            'PROVIDER_SESSION_CHANGED',
            'executor changed session identity',
          )
        if (event.type === 'question') {
          await this.serial(e, async () => {
            if (e.stop) return
            await this.append(e, {
              type: 'interaction',
              requestId: event.requestId,
              runId: activeRunId,
              generation: run.generation,
              state: 'pending',
              questions: event.questions,
            })
            await this.append(e, {
              type: 'run-changed',
              runId: activeRunId,
              patch: { phase: 'waiting_input' },
            })
          })
        }
        // Publish only after durable question linkage and phase are committed.
        try {
          this.options.onEvent?.(event)
        } catch {
          /* observer only */
        }
        if (event.type === 'question' && !e.stop) {
          const question: DelegationQuestion = {
            owner: record.owner,
            delegationId: id,
            runId: activeRunId,
            generation: run.generation,
            requestId: event.requestId,
            backend: record.backend,
            questions: event.questions,
          }
          void this.handleQuestion(question, controller.signal)
        }
        if (event.type === 'turn_finished') {
          status = event.status
          structured = event.structured
          if (event.status === 'failed') failureCode = 'EXECUTOR_TURN_FAILED'
          summary = boundText(event.text ?? event.error ?? summary, 8192)
          break
        }
      }
      if (!status && !e.stop) failureCode = 'OUTCOME_UNKNOWN'
    } catch (error) {
      failureCode =
        error instanceof DelegationError
          ? error.code
          : controller.signal.aborted
            ? 'ABORTED'
            : 'EXECUTOR_ERROR'
      if (failureCode === 'OUTCOME_UNKNOWN') quiescent = false
    } finally {
      if (timer) clearTimeout(timer)
      controller.abort()
      if (session) {
        try {
          e.closing ??= session.close()
          quiescent = (await e.closing).quiescent
        } catch {
          quiescent = false
        }
      }
      e.session = undefined
      let settledPhase: RunPhase | undefined
      // One serial section from reading the run to writing its outcome: a
      // stop sets e.stop and writes `cancelling` in its own section, so this
      // sees both or neither (SUB-29).
      await this.serial(e, async () => {
        let current = e.journal.load().runs[activeRunId]!
        const step = async (phase: RunPhase) => {
          await this.append(e, {
            type: 'run-changed',
            runId: activeRunId,
            patch: { phase },
          })
          current = e.journal.load().runs[activeRunId]!
        }
        if (current.phase === 'queued' && !e.stop) await step('preparing')
        let phase: RunPhase = !quiescent
          ? 'outcome_unknown'
          : e.inputFailure
            ? 'interrupted'
            : e.stop
              ? status === 'completed'
                ? 'completed'
                : 'cancelled'
              : status === 'completed'
                ? 'completed'
                : status === 'failed'
                  ? 'failed'
                  : status === 'interrupted'
                    ? 'interrupted'
                    : sent
                      ? 'outcome_unknown'
                      : 'failed'
        if (current.phase === 'cancelling' && phase === 'failed') {
          phase = 'outcome_unknown'
          failureCode = 'OUTCOME_UNKNOWN'
        }
        if (e.timedOut && phase === 'cancelled') failureCode = 'RUN_TIMEOUT'
        if (!TERMINAL_RUN_PHASES.has(current.phase)) {
          // Reach the outcome through legal steps only.
          if (
            phase === 'cancelled' &&
            ['preparing', 'running', 'waiting_input'].includes(current.phase)
          )
            await step('cancelling')
          if (
            current.phase === 'waiting_input' &&
            (phase === 'completed' || phase === 'failed')
          )
            await step('running')
          if (!RUN_TRANSITIONS[current.phase].includes(phase))
            phase = current.phase === 'queued' ? 'cancelled' : 'outcome_unknown'
        }
        settledPhase = TERMINAL_RUN_PHASES.has(current.phase)
          ? current.phase
          : phase
        // A failure on an unverified protocol says so first (the summary is
        // bounded from its start), so the user can tell a version problem from
        // an ordinary task failure.
        if (settledPhase === 'failed' && protocolNote)
          summary = boundText(
            protocolNote +
              '. Install a verified version or update Emperor if this keeps failing.' +
              (summary ? '\n\n' + summary : ''),
            8192,
          )
        if (!accepted && sent)
          await this.append(e, {
            type: 'message-delivery',
            messageId,
            status: 'delivery_unknown',
          })
        else if (!sent)
          await this.append(e, {
            type: 'message-delivery',
            messageId,
            status: 'cancelled',
          })
        // The budget slot is free once the process is; a run whose stop
        // could not be confirmed keeps only its workspace quarantined.
        budget?.release(sent ? usage : { estimatedUsd: 0 })
        // The root task's cap counts what its external runs really spent.
        if (
          sent &&
          usage?.billing !== 'subscription' &&
          usage?.estimatedUsd !== undefined &&
          usage.estimatedUsd > 0
        )
          this.options.taskBudget?.charge(record.owner, usage.estimatedUsd)
        if (quiescent && settledPhase !== 'outcome_unknown')
          workspace?.release()
        else e.held = { workspace, quiescent }
        if (record.workspaceLeaseId) {
          try {
            this.options.workspaces.retain(record.workspaceLeaseId)
          } catch {
            /* Durable ownership intent still preserves the directory. */
          }
        }
        if (!TERMINAL_RUN_PHASES.has(current.phase))
          await this.append(e, {
            type: 'run-changed',
            runId: activeRunId,
            patch: {
              phase: settledPhase,
              quiescent,
              finishedAt: Date.now(),
              summary,
              usage,
              ...(structured === undefined ? {} : { structured }),
              ...(e.inputFailure
                ? {
                    acceptance: 'needs_user' as const,
                    failureCode: e.inputFailure,
                  }
                : failureCode
                  ? { failureCode }
                  : {}),
            },
          })
        for (const interaction of Object.values(e.journal.load().interactions))
          if (
            interaction.runId === activeRunId &&
            ['pending', 'answering'].includes(interaction.state)
          )
            await this.append(e, { ...interaction, state: 'cancelled' })
      })
      if (quiescent && settledPhase !== 'outcome_unknown') {
        await this.collectResult(e, activeRunId)
        try {
          await this.options.onSettled?.(id, activeRunId)
        } catch {
          await this.change(e, activeRunId, {
            acceptance: 'needs_user',
            failureCode: 'ARTIFACT_COLLECTION_FAILED',
          })
        }
      }
      await this.serial(e, () =>
        this.append(e, {
          type: 'outbox',
          notice: settlementNotice(
            e.journal.load().record!,
            e.journal.load().runs[activeRunId]!,
          ),
        }),
      )
      void this.dispatchNotices(id).catch(() => undefined)
      e.controller = undefined
    }
  }
  private async handleQuestion(
    question: DelegationQuestion,
    signal: AbortSignal,
  ): Promise<void> {
    const e = this.entry(question.delegationId)
    try {
      const outcome = await (this.options.onQuestion?.(question, signal) ??
        Promise.resolve({ outcome: 'unavailable' } as const))
      if (e.stop || signal.aborted) return
      if (outcome.outcome === 'answered') {
        await this.answer(question.delegationId, {
          rootSessionId: question.owner.rootSessionId,
          runId: question.runId,
          generation: question.generation,
          requestId: question.requestId,
          answers: outcome.answers,
        })
      } else
        await this.interrupt(
          question.delegationId,
          question.runId,
          'QUESTION_' + outcome.outcome.toUpperCase(),
        )
    } catch {
      if (!e.stop && !signal.aborted)
        await this.interrupt(
          question.delegationId,
          question.runId,
          'QUESTION_UNAVAILABLE',
        ).catch(() => undefined)
    }
  }
  async answer(
    id: string,
    input: {
      rootSessionId: string
      runId: string
      generation: number
      requestId: string
      answers: Record<string, string>
    },
  ): Promise<void> {
    const e = this.entry(id)
    await this.serial(e, async () => {
      const state = e.journal.load(),
        run = state.runs[input.runId],
        request = state.interactions[input.requestId]
      if (state.record!.owner.rootSessionId !== input.rootSessionId)
        throw new DelegationError(
          'PERMISSION_DENIED',
          'question belongs to another root session',
        )
      if (
        e.stop ||
        state.record!.currentRunId !== input.runId ||
        !run ||
        run.generation !== input.generation ||
        TERMINAL_RUN_PHASES.has(run.phase)
      )
        throw new DelegationError(
          'STALE_RUN',
          'question run is no longer current',
        )
      if (
        !request ||
        request.state !== 'pending' ||
        request.runId !== input.runId ||
        request.generation !== input.generation ||
        !e.session
      )
        throw new DelegationError(
          'STALE_REQUEST',
          'question is no longer pending',
        )
      const questions =
        request.questions as import('./types').ExecutorQuestion[]
      const answers: Record<string, string> = {}
      for (const q of questions) {
        const text = input.answers[q.id]
        if (
          typeof text !== 'string' ||
          !text.trim() ||
          Buffer.byteLength(text) > 4096
        )
          throw new DelegationError(
            'INVALID_ANSWER',
            'each business question needs bounded text',
          )
        answers[q.id] = text
      }
      await this.append(e, { ...request, state: 'answering' })
      await e.session.answer({
        requestId: input.requestId,
        generation: input.generation,
        kind: 'question',
        answers,
      })
      await this.append(e, { ...request, state: 'answered' })
      if (
        !Object.values(e.journal.load().interactions).some(
          (q) => q.runId === input.runId && q.state === 'pending',
        )
      )
        await this.append(e, {
          type: 'run-changed',
          runId: input.runId,
          patch: { phase: 'running' },
        })
    })
  }
  async interrupt(
    id: string,
    expectedRunId: string,
    inputFailure?: string,
  ): Promise<{ requested: boolean }> {
    const e = this.entry(id),
      state = e.journal.load(),
      run = state.runs[expectedRunId]
    if (state.record!.currentRunId !== expectedRunId || !run)
      throw new DelegationError('STALE_RUN', 'interrupt target changed')
    if (TERMINAL_RUN_PHASES.has(run.phase)) return { requested: false }
    // e.stop and `cancelling` change together in one serial section, the
    // same one that settles a finished turn (SUB-29).
    const requested = await this.serial(e, async () => {
      const current = e.journal.load().runs[expectedRunId]!
      if (TERMINAL_RUN_PHASES.has(current.phase)) return false
      e.stop = true
      e.inputFailure ??= inputFailure
      if (current.phase === 'queued')
        await this.append(e, {
          type: 'run-changed',
          runId: expectedRunId,
          patch: { phase: 'cancelled', finishedAt: Date.now() },
        })
      else if (current.phase !== 'cancelling')
        await this.append(e, {
          type: 'run-changed',
          runId: expectedRunId,
          patch: { phase: 'cancelling' },
        })
      for (const message of Object.values(e.journal.load().messages))
        if (message.status === 'queued')
          await this.append(e, {
            type: 'message-delivery',
            messageId: message.id,
            status: 'cancelled',
          })
      return true
    })
    if (!requested) return { requested: false }
    if (inputFailure && e.session) {
      for (const request of Object.values(e.journal.load().interactions))
        if (request.runId === expectedRunId && request.state === 'pending')
          await e.session
            .answer({
              requestId: request.requestId,
              generation: request.generation,
              kind: 'deny',
              reason: inputFailure,
            })
            .catch(() => undefined)
    }
    if (e.session) {
      const session = e.session
      try {
        const current = e.journal.load().runs[expectedRunId]!
        await session.interrupt(current.providerTurnId ?? '')
      } catch {
        /* close decides whether termination is known. */
      } finally {
        e.closing ??= session.close()
        await e.closing.catch(() => undefined)
      }
    } else
      e.controller?.abort(
        new DelegationError('ABORTED', 'delegation interrupted'),
      )
    await e.active
    return { requested: true }
  }
  /**
   * 「标记为已结束」 (AGT-04): end a run that has no outcome, as it is. Its
   * workspace quarantine is released (a budget slot was never held), its
   * queue cancelled, and a Goal no longer waits for it. A run still live in
   * this process is stopped instead, with interrupt.
   */
  async abandon(id: string, by: 'user' | 'model'): Promise<DelegationRecord> {
    const e = this.entry(id)
    return this.serial(e, async () => {
      const state = e.journal.load(),
        record = state.record!,
        run = record.currentRunId ? state.runs[record.currentRunId] : undefined
      if (e.active)
        throw new DelegationError(
          'ACTIVE_RUN',
          'the run is still in progress; stop it instead',
        )
      if (
        !run ||
        !(
          delegationNeedsExit(record, run) ||
          !TERMINAL_RUN_PHASES.has(run.phase)
        )
      )
        throw new DelegationError(
          'NOTHING_TO_END',
          'this task has no unfinished run to end',
        )
      // A quarantined group gets one last stop before its workspace is
      // released; whatever the result, the user's decision stands.
      if (e.held && !e.held.quiescent && run.process)
        await this.stopRecordedRun(id, run, this.bootTime()).catch(
          () => undefined,
        )
      const closeIt =
        record.availability !== 'closed' &&
        !!record.workspaceLeaseId &&
        !this.workspaceAvailable(record)
      await this.append(e, {
        type: 'run-abandoned',
        runId: run.id,
        by,
        at: Date.now(),
      })
      // Its workspace is gone: nothing can continue in this conversation.
      if (closeIt)
        await this.append(e, { type: 'availability', availability: 'closed' })
      if (!e.journal.load().outbox['dgn-' + run.id])
        await this.append(e, {
          type: 'outbox',
          notice: settlementNotice(
            e.journal.load().record!,
            e.journal.load().runs[run.id]!,
          ),
        })
      e.held?.workspace?.release()
      e.held = undefined
      e.stop = false
      return e.journal.load().record!
    })
  }
  async bindIntegration(
    id: string,
    runId: string,
    previewId: string,
  ): Promise<void> {
    await this.change(this.entry(id), runId, {
      integrationPreviewId: previewId,
    })
  }
  async bindReceipt(
    id: string,
    runId: string,
    receiptId: string,
    acceptance: DelegationRunRecord['acceptance'],
    acceptanceId?: string,
  ): Promise<void> {
    const e = this.entry(id)
    await this.serial(e, () =>
      this.append(e, {
        type: 'receipt',
        runId,
        receiptId,
        acceptance,
        ...(acceptanceId ? { acceptanceId } : {}),
      }),
    )
  }
  /** A settled run's result, from its workspace (AGT-06). Best effort. */
  private async collectResult(e: Entry, runId: string): Promise<void> {
    const record = e.journal.load().record!
    if (!this.options.results || !record.workspaceLeaseId) return
    try {
      const lease = this.options.workspaces.get(record.workspaceLeaseId)
      const result = await this.options.results.collect(lease, runId)
      if (result)
        await this.serial(e, () =>
          this.append(e, { type: 'run-result', runId, result }),
        )
    } catch {
      // The files stay in the run's workspace; the card just does not show.
    }
  }
  private resultOf(id: string, runId: string) {
    const e = this.entry(id),
      state = e.journal.load(),
      record = state.record!,
      run = state.runs[runId]
    if (!run)
      throw new DelegationError('RUN_NOT_FOUND', 'run does not belong here')
    if (!run.result || run.result.totals.files === 0)
      throw new DelegationError(
        'NOTHING_TO_APPLY',
        'this run left no changed files',
      )
    if (!this.options.results)
      throw new DelegationError(
        'EXECUTOR_UNAVAILABLE',
        'results are not composed',
      )
    return { e, record, run, result: run.result, results: this.options.results }
  }
  private async recordResult(
    e: Entry,
    runId: string,
    result: DelegationResult,
  ): Promise<DelegationResult> {
    await this.serial(e, () =>
      this.append(e, { type: 'run-result', runId, result }),
    )
    return e.journal.load().runs[runId]!.result!
  }
  /**
   * The result's worktree (or copy) and private refs go, its lease is
   * released and the conversation closes: nothing is left to continue in.
   */
  private async retireWorkspace(e: Entry, keepUndo: boolean): Promise<void> {
    const state = e.journal.load(),
      record = state.record!
    const runs = Object.values(state.runs)
    try {
      const lease = this.options.workspaces.get(record.workspaceLeaseId)
      await this.options.results?.cleanup(lease, {
        keepUndo,
        // What the 高级 › 验证后再应用 chain left: patch snapshots and
        // integration previews of this conversation's runs.
        refs: runs.flatMap((run) =>
          run.receiptId
            ? [`refs/emperor/delegations/${run.receiptId}/base`]
            : [],
        ),
        worktrees: runs.flatMap((run) =>
          run.integrationPreviewId
            ? [
                join(
                  this.options.root,
                  'integrations',
                  run.integrationPreviewId,
                  'workspace',
                ),
              ]
            : [],
        ),
      })
      this.options.workspaces.retire?.(lease.id)
    } catch {
      /* the lease intent keeps the paths known */
    }
    if (e.journal.load().record!.availability !== 'closed')
      await this.serial(e, () =>
        this.append(e, { type: 'availability', availability: 'closed' }),
      )
  }
  /**
   * 应用到项目 (AGT-06): a three-way merge of the result into the current
   * workspace. A conflict writes nothing and keeps the result; otherwise
   * the result's worktree and refs go and only its undo record stays.
   */
  applyResult(
    id: string,
    runId: string,
    by: 'user' | 'model',
  ): Promise<DelegationResult> {
    return this.underResultLock(id, () => this.applyNow(id, runId, by))
  }
  /**
   * One decision about a delegation's result at a time (a click and the
   * model's collect_agent may race): each reads the state it acts on
   * inside the lock.
   */
  private underResultLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.resultLocks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    const tail = next.catch(() => undefined)
    this.resultLocks.set(id, tail)
    void tail.then(() => {
      if (this.resultLocks.get(id) === tail) this.resultLocks.delete(id)
    })
    return next
  }
  private async applyNow(
    id: string,
    runId: string,
    by: 'user' | 'model',
  ): Promise<DelegationResult> {
    const { e, record, result, results } = this.resultOf(id, runId)
    if (this.options.config().verifyBeforeApply)
      throw new DelegationError(
        'VERIFY_BEFORE_APPLY',
        '验证后再应用 is on: check the result in its task details before applying it',
      )
    if (record.currentRunId !== runId)
      throw new DelegationError(
        'STALE_RUN',
        'a later run of this task replaced this result',
      )
    if (result.state !== 'ready' && result.state !== 'conflicted')
      throw new DelegationError(
        'RESULT_SETTLED',
        'this result was already ' + result.state,
      )
    if (e.active)
      throw new DelegationError('ACTIVE_RUN', 'the task is still running')
    const lease = this.options.workspaces.get(record.workspaceLeaseId)
    const outcome = await results.apply(lease, result, {
      sessionId: record.owner.rootSessionId,
      runId,
    })
    const changedAt = Date.now()
    if (outcome.state === 'conflicted')
      return this.recordResult(e, runId, {
        ...result,
        state: 'conflicted',
        conflicts: outcome.conflicts,
        changedAt,
        by,
      })
    const { conflicts: _old, truncated: _truncated, ...rest } = result
    const applied = await this.recordResult(e, runId, {
      ...rest,
      state: 'applied',
      files: outcome.files,
      totals: outcome.totals,
      ...(outcome.truncated ? { truncated: true as const } : {}),
      undo: outcome.undo,
      changedAt,
      by,
    })
    await this.retireWorkspace(e, true)
    return applied
  }
  /** 丢弃 (AGT-06): the result goes, the project is left as it is. */
  discardResult(
    id: string,
    runId: string,
    by: 'user' | 'model',
  ): Promise<DelegationResult> {
    return this.underResultLock(id, () => this.discardNow(id, runId, by))
  }
  private async discardNow(
    id: string,
    runId: string,
    by: 'user' | 'model',
  ): Promise<DelegationResult> {
    const { e, result } = this.resultOf(id, runId)
    if (result.state !== 'ready' && result.state !== 'conflicted')
      throw new DelegationError(
        'RESULT_SETTLED',
        'this result was already ' + result.state,
      )
    if (e.active)
      throw new DelegationError('ACTIVE_RUN', 'the task is still running')
    const discarded = await this.recordResult(e, runId, {
      ...result,
      state: 'discarded',
      changedAt: Date.now(),
      by,
    })
    await this.retireWorkspace(e, false)
    return discarded
  }
  /** 撤销 after 应用到项目 (AGT-06): files nobody changed since go back. */
  undoResult(id: string, runId: string): Promise<DelegationResult> {
    return this.underResultLock(id, () => this.undoNow(id, runId))
  }
  private async undoNow(id: string, runId: string): Promise<DelegationResult> {
    const { e, record, result, results } = this.resultOf(id, runId)
    if (result.state !== 'applied' || !result.undo)
      throw new DelegationError(
        'NOTHING_TO_UNDO',
        'only an applied result can be undone',
      )
    const lease = this.options.workspaces.get(record.workspaceLeaseId)
    const reverted = await results.undo(lease, result, {
      sessionId: record.owner.rootSessionId,
    })
    return this.recordResult(e, runId, {
      ...result,
      state: 'reverted',
      reverted,
      changedAt: Date.now(),
    })
  }
  /** 查看差异: one file of the result (or of what applying it changed). */
  async resultDiff(
    id: string,
    runId: string,
    path: string,
  ): Promise<{ path: string; diff: string; truncated: boolean }> {
    const { record, result, results } = this.resultOf(id, runId)
    if (result.state === 'discarded')
      throw new DelegationError('RESULT_GONE', 'this result was discarded')
    const lease = this.options.workspaces.get(record.workspaceLeaseId)
    return results.diff(lease, result, path, record.owner.rootSessionId)
  }
  /**
   * The conversation is deleted for good (AGT-06): every result worktree,
   * folder copy, private ref and undo record of its subagents goes.
   */
  async forgetRoot(rootSessionId: string): Promise<void> {
    const entries = [...this.entries.values()].filter(
      (e) => e.journal.load().record?.owner.rootSessionId === rootSessionId,
    )
    if (entries.some((e) => e.active)) await this.stopRoot(rootSessionId)
    for (const e of entries) {
      const record = e.journal.load().record!
      if (!record.workspaceLeaseId) continue
      try {
        const lease = this.options.workspaces.get(record.workspaceLeaseId)
        await this.options.results?.forget(lease, rootSessionId)
        if (!lease.cleaned) this.options.workspaces.retire?.(lease.id)
      } catch {
        /* nothing more to remove */
      }
      if (e.journal.load().record!.availability !== 'closed')
        await this.serial(e, () =>
          this.append(e, { type: 'availability', availability: 'closed' }),
        )
    }
  }
  async wait(
    id: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<DelegationRunRecord> {
    const e = this.entry(id)
    while (true) {
      if (signal?.aborted)
        throw new DelegationError('ABORTED', 'wait cancelled')
      const run = e.journal.load().runs[runId]
      if (!run) throw new DelegationError('RUN_NOT_FOUND', 'run missing')
      if (TERMINAL_RUN_PHASES.has(run.phase)) {
        await e.active
        return e.journal.load().runs[runId]!
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          e.waiters.delete(wake)
          signal?.removeEventListener('abort', wake)
          resolve()
        }
        e.waiters.add(wake)
        signal?.addEventListener('abort', wake, { once: true })
        if (signal?.aborted) wake()
      })
    }
  }
  async close(id: string): Promise<void> {
    const state = this.inspect(id),
      run = state.record!.currentRunId
        ? state.runs[state.record!.currentRunId]
        : undefined
    if (run && !TERMINAL_RUN_PHASES.has(run.phase))
      await this.interrupt(id, run.id)
    if (this.inspect(id).record!.availability === 'needs_recovery') return
    const e = this.entry(id)
    e.stop = true
    await this.serial(e, () =>
      this.append(e, { type: 'availability', availability: 'closed' }),
    )
  }
}
/** The usage fields of a normalized usage event. */
function withoutRunFields(event: Record<string, unknown>): ExecutorRunUsage {
  const { delegationId: _d, runId: _r, generation: _g, ...rest } = event
  return rest as ExecutorRunUsage
}
/**
 * A run's usage as the budget counts it (AGT-07): a subscription's cost is
 * nominal; an API run without a reported cost is priced from its tokens,
 * and its token total is known either way.
 */
function billUsage(
  usage: ExecutorRunUsage,
  billing: ExecutorBilling,
  estimate: (counts: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    reasoningTokens?: number
  }) => number | null,
  reportedCost: boolean,
): ExecutorRunUsage {
  const { estimatedUsd, nominalUsd, ...counts } = usage
  const base: ExecutorRunUsage = {
    ...counts,
    totalTokens:
      counts.totalTokens ??
      (counts.inputTokens ?? 0) +
        (counts.cacheReadTokens ?? 0) +
        (counts.outputTokens ?? 0),
    billing,
  }
  if (billing === 'subscription') {
    const nominal = estimatedUsd ?? nominalUsd
    return nominal === undefined ? base : { ...base, nominalUsd: nominal }
  }
  const usd = reportedCost
    ? estimatedUsd
    : (estimate({
        inputTokens: counts.inputTokens ?? 0,
        outputTokens: counts.outputTokens ?? 0,
        ...(counts.cacheReadTokens === undefined
          ? {}
          : { cacheReadTokens: counts.cacheReadTokens }),
        ...(counts.reasoningTokens === undefined
          ? {}
          : { reasoningTokens: counts.reasoningTokens }),
      }) ?? estimatedUsd)
  return usd === undefined || usd === null
    ? base
    : { ...base, estimatedUsd: usd }
}
function permissionRank(mode: string): number {
  return mode === 'read-only' ? 0 : mode === 'workspace-write' ? 1 : 2
}
function boundText(text: string, bytes: number): string {
  const buffer = Buffer.from(text)
  if (buffer.length <= bytes) return text
  return buffer
    .subarray(0, bytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '')
}
