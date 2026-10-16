import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
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
} from './types'
import { DelegationPolicy, type DelegationParentContext } from './policy'
import { DelegationBudget, type BudgetLease } from './budget'
import { DelegationJournal } from './journal'
import {
  safeDelegationKey,
  type DelegationState,
  type DelegationEvent,
} from './fold'
import { redactExecutorText } from './redaction'
import type { ExecutorRegistry } from './registry'
import type { DelegationWorkspaceService } from '../../workspace/delegation-workspaces'
import {
  workspaceMutationDomain,
  type WorkspaceMutationCoordinator,
} from '../../workspace/mutation-coordinator'
import type { ResourceLease } from './resources'
export interface DelegationServiceOptions {
  root: string
  config: () => ExecutorConfig
  registry: Pick<ExecutorRegistry, 'requireAvailable' | 'capabilities'>
  adapters: Map<string, ExecutorAdapter>
  parent: (owner: DelegationOwner) => DelegationParentContext
  workspaces: Pick<
    DelegationWorkspaceService,
    'prepare' | 'retain' | 'get' | 'release'
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
  }>
  onEvent?: (event: NormalizedExecutorEvent) => void
}
interface Entry {
  journal: DelegationJournal
  tail: Promise<unknown>
  active?: Promise<void>
  controller?: AbortController
  session?: ExecutorSession
  closing?: Promise<{ quiescent: boolean }>
  held?: { workspace?: ResourceLease; budget?: BudgetLease; quiescent: boolean }
  stop: boolean
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
  constructor(private readonly options: DelegationServiceOptions) {
    this.budget = new DelegationBudget(options.config())
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
  private serial<T>(e: Entry, action: () => Promise<T>): Promise<T> {
    const next = e.tail.catch(() => undefined).then(action)
    e.tail = next
    return next
  }
  private async append(e: Entry, event: DelegationEvent): Promise<void> {
    await e.journal.append(event)
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
  ): Promise<DelegationRecord> {
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
    const promise = this.create(owner, spec, digest)
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
  ): Promise<DelegationRecord> {
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
    const probe = await this.options.registry.requireAvailable(profile)
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
    },
  ): Promise<{
    messageId: string
    state: 'queued' | 'accepted'
    runId?: string
  }> {
    const e = this.entry(id)
    const result = await this.serial(e, async () => {
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
        return {
          messageId: input.messageId,
          state:
            previous.status === 'accepted'
              ? ('accepted' as const)
              : ('queued' as const),
        }
      }
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
      await this.append(e, {
        type: 'message-enqueued',
        message: { id: input.messageId, text: input.text, status: 'queued' },
      })
      e.stop = false
      return { messageId: input.messageId, state: 'queued' as const }
    })
    this.pump(id)
    return result
  }
  private pump(id: string): void {
    const e = this.entry(id)
    if (e.active || e.stop) return
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
      if (run && !TERMINAL_RUN_PHASES.has(run.phase))
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
      usage: DelegationRunRecord['usage']
    try {
      if (e.stop) controller.abort()
      const config = this.options.config()
      this.budget.reconfigure(config)
      budget = await this.budget.reserve(
        record.owner.taskScopeId,
        record.profileId,
        controller.signal,
      )
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
      if (e.stop || controller.signal.aborted)
        throw new DelegationError('ABORTED', 'cancelled before process open')
      await this.options.registry.requireAvailable(profile, controller.signal)
      state = e.journal.load()
      const run = state.runs[activeRunId]!
      const lease = record.workspaceLeaseId
        ? this.options.workspaces.get(record.workspaceLeaseId)
        : undefined
      session = await this.options.adapters
        .get(record.backend)!
        .open({
          delegationId: id,
          profile,
          cwd: record.cwd,
          environment: runtime.environment,
          boundaryReceiptId: 'dgb-' + randomUUID(),
          resumeSessionId: record.providerSessionId,
          generation: run.generation,
          signal: controller.signal,
          runtimeRoot: runtime.runtimeRoot,
          secretValues: runtime.secretValues,
          policy: {
            mode: record.effectivePermission,
            workspaceRoot: record.cwd,
            runtimeStateRoots: [runtime.runtimeRoot],
            privateTempRoot: runtime.tempRoot,
            readOnlyRoots: lease?.snapshot ? [lease.snapshot.commonDir] : [],
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
        text: state.messages[messageId]!.text,
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
      timer = setTimeout(
        () => void this.interrupt(id, activeRunId).catch(() => undefined),
        config.limits.runTimeoutMs,
      )
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
        try {
          this.options.onEvent?.(event)
        } catch {
          /* UI subscribers do not change execution. */
        }
        if (event.type === 'text_delta')
          summary = boundText(summary + event.text, 8192)
        if (event.type === 'usage')
          usage = {
            ...usage,
            ...('inputTokens' in event
              ? { inputTokens: event.inputTokens }
              : {}),
            ...('outputTokens' in event
              ? { outputTokens: event.outputTokens }
              : {}),
            ...('estimatedUsd' in event
              ? { estimatedUsd: event.estimatedUsd }
              : {}),
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
        if (event.type === 'turn_finished') {
          status = event.status
          summary = boundText(event.text ?? summary, 8192)
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
      if (session) {
        try {
          e.closing ??= session.close()
          quiescent = (await e.closing).quiescent
        } catch {
          quiescent = false
        }
      }
      e.session = undefined
      let current = e.journal.load().runs[activeRunId]!
      if (current.phase === 'queued' && !e.stop) {
        await this.change(e, activeRunId, { phase: 'preparing' })
        current = e.journal.load().runs[activeRunId]!
      }
      const phase = !quiescent
        ? 'outcome_unknown'
        : e.stop
          ? status === 'completed'
            ? 'completed'
            : current.phase === 'queued'
              ? 'cancelled'
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
      if (phase === 'cancelled' && current.phase === 'preparing') {
        await this.change(e, activeRunId, { phase: 'cancelling' })
        current = e.journal.load().runs[activeRunId]!
      }
      if (
        current.phase === 'waiting_input' &&
        ['completed', 'failed'].includes(phase)
      ) {
        await this.change(e, activeRunId, { phase: 'running' })
      }
      if (current.phase === 'cancelling' && phase === 'failed')
        failureCode = 'OUTCOME_UNKNOWN'
      const finalPhase =
        current.phase === 'cancelling' && phase === 'failed'
          ? 'outcome_unknown'
          : phase
      if (!accepted && sent)
        await this.serial(e, () =>
          this.append(e, {
            type: 'message-delivery',
            messageId,
            status: 'delivery_unknown',
          }),
        )
      else if (!sent)
        await this.serial(e, () =>
          this.append(e, {
            type: 'message-delivery',
            messageId,
            status: 'cancelled',
          }),
        )
      // Unknown descendants keep both workspace and quota occupied until explicit recovery.
      if (quiescent && finalPhase !== 'outcome_unknown') {
        workspace?.release()
        budget?.release(sent ? usage : { estimatedUsd: 0 })
      } else e.held = { workspace, budget, quiescent }
      if (record.workspaceLeaseId) {
        try {
          this.options.workspaces.retain(record.workspaceLeaseId)
        } catch {
          /* Durable ownership intent still preserves the directory. */
        }
      }
      await this.change(e, activeRunId, {
        phase: finalPhase,
        finishedAt: Date.now(),
        summary,
        usage,
        ...(failureCode ? { failureCode } : {}),
      })
      e.controller = undefined
    }
  }
  async interrupt(
    id: string,
    expectedRunId: string,
  ): Promise<{ requested: boolean }> {
    const e = this.entry(id),
      state = e.journal.load(),
      run = state.runs[expectedRunId]
    if (state.record!.currentRunId !== expectedRunId || !run)
      throw new DelegationError('STALE_RUN', 'interrupt target changed')
    if (TERMINAL_RUN_PHASES.has(run.phase)) return { requested: false }
    e.stop = true
    await this.serial(e, async () => {
      const current = e.journal.load().runs[expectedRunId]!
      if (current.phase === 'queued')
        await this.append(e, {
          type: 'run-changed',
          runId: expectedRunId,
          patch: { phase: 'cancelled', finishedAt: Date.now() },
        })
      else if (
        !TERMINAL_RUN_PHASES.has(current.phase) &&
        current.phase !== 'cancelling'
      )
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
    })
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
  async wait(id: string, runId: string): Promise<DelegationRunRecord> {
    const e = this.entry(id)
    while (true) {
      const run = e.journal.load().runs[runId]
      if (!run) throw new DelegationError('RUN_NOT_FOUND', 'run missing')
      if (TERMINAL_RUN_PHASES.has(run.phase)) {
        await e.active
        return e.journal.load().runs[runId]!
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          e.waiters.delete(wake)
          resolve()
        }
        e.waiters.add(wake)
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
