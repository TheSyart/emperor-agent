import { SessionRequiredError } from '../../harness/host/scope'
import {
  DelegationHistory,
  type DelegationHistoryOptions,
} from './delegation-history'
import { agentTitle } from '../../runtime/agent-view'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DelegationService } from '../../harness/delegation/service'
import type { DelegationState } from '../../harness/delegation/fold'
import {
  requiresArtifactAcceptance,
  type DelegationReceipts,
} from '../../harness/delegation/receipts'
import {
  criteriaDigest,
  type AcceptanceCriteria,
  type DelegationAcceptance,
} from '../../harness/delegation/acceptance'
import type {
  DelegationIntegration,
  IntegrationBase,
} from '../../workspace/delegation-integration'
import {
  DelegationError,
  type DelegationRunRecord,
  TERMINAL_RUN_PHASES,
} from '../../harness/delegation/types'
import { delegationNeedsExit } from '../../runtime/agent-view'
export function externalTask(state: DelegationState, run: DelegationRunRecord) {
  const record = state.record!
  return {
    id: run.id,
    kind: 'external-agent' as const,
    label: agentTitle(record.startSpec?.description, record.backend),
    description: agentTitle(record.startSpec?.description, record.backend),
    status: run.phase,
    session_id: record.owner.rootSessionId,
    owner_id: record.owner.parentAgentId,
    started_at: run.startedAt ?? record.createdAt,
    finished_at: run.finishedAt ?? null,
    delegation_id: record.id,
    backend: record.backend,
    model: record.startSpec?.model,
    capabilities: record.capabilitySnapshot,
    acceptance: run.acceptance,
    receipt_id: run.receiptId,
    usage: run.usage,
    workspace_summary: record.cwd,
    recoverable:
      record.availability === 'needs_recovery' ||
      record.dispatchPaused === true,
    // Its current run ended without an outcome: offer 「标记为已结束」.
    needs_exit:
      run.id === record.currentRunId && delegationNeedsExit(record, run),
    ...(run.abandoned ? { abandoned_by: run.abandoned.by } : {}),
    detail: run.summary ?? null,
    // VER-06: a failure for its version, for the card's buttons.
    ...(run.versionFailure ? { version_failure: run.versionFailure } : {}),
    revision: run.revision,
  }
}
export class CoreDelegationService {
  private historyIndex?: DelegationHistory
  history(
    input: { id: string; sessionId?: string | null } & DelegationHistoryOptions,
  ) {
    const state = this.access(input.id, input.sessionId)
    this.historyIndex ??= new DelegationHistory(this.options.root)
    return this.historyIndex.read(state, input)
  }
  constructor(
    private readonly options: {
      root: string
      service: DelegationService
      cachedState?: (id: string) => DelegationState | undefined
      receipts: DelegationReceipts
      acceptance: DelegationAcceptance
      integration: DelegationIntegration
      session: (id: string) => { archived_at?: string | null } | null
      assertMutation: (id: string, action: string) => void
    },
  ) {}
  private access(
    id: string,
    sessionId?: string | null,
    write = false,
  ): DelegationState {
    const cached = write ? undefined : this.options.cachedState?.(id)
    const state = cached
        ? structuredClone(cached)
        : this.options.service.inspect(id),
      // The caller names the owning chat (KRN-01: never the one in view).
      root = String(sessionId ?? '').trim()
    if (!root) throw new SessionRequiredError('delegations')
    const session = this.options.session(root)
    if (!session || state.record?.owner.rootSessionId !== root)
      throw new DelegationError(
        'PERMISSION_DENIED',
        'external task belongs to another root session',
      )
    if (write) {
      if (session.archived_at)
        throw new DelegationError(
          'PERMISSION_DENIED',
          'archived sessions are read-only',
        )
      this.options.assertMutation(root, 'control')
    }
    return state
  }
  get(input: { id: string; sessionId?: string | null }) {
    return this.access(input.id, input.sessionId)
  }
  run(runId: string, sessionId?: string | null) {
    const state = this.options.service.list().find((s) => s.runs[runId])
    if (!state?.record)
      throw new DelegationError('RUN_NOT_FOUND', 'external run not found')
    this.access(state.record.id, sessionId)
    return { state, record: state.record, run: state.runs[runId]! }
  }
  tasks(sessionId: string) {
    if (!this.options.session(sessionId)) return []
    return this.options.service
      .list()
      .filter((s) => s.record?.owner.rootSessionId === sessionId)
      .flatMap((s) => Object.values(s.runs).map((run) => externalTask(s, run)))
  }
  transcript(
    runId: string,
    sessionId?: string | null,
  ): { role: string; content: string }[] {
    const { record } = this.run(runId, sessionId),
      path = join(
        this.options.root,
        'conversations',
        record.id,
        'runs',
        runId + '.jsonl',
      )
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const event = JSON.parse(line) as Record<string, unknown>
        if (event.runId !== runId || event.delegationId !== record.id)
          throw new DelegationError(
            'TRANSCRIPT_CORRUPT',
            'transcript identity changed',
          )
        if (event.type === 'text_delta')
          return [{ role: 'assistant', content: String(event.text) }]
        if (event.type === 'tool_started' || event.type === 'tool_finished')
          return [
            {
              role: 'tool',
              content: [event.name, event.status, event.detail]
                .filter((v) => typeof v === 'string')
                .join(': '),
            },
          ]
        if (event.type === 'question')
          return [
            { role: 'question', content: JSON.stringify(event.questions) },
          ]
        if (event.type === 'permission_denied')
          return [{ role: 'permission', content: String(event.reason) }]
        return []
      })
  }
  async send(input: {
    id: string
    sessionId?: string | null
    messageId: string
    text: string
    delivery: 'queue' | 'steer'
    expectedRunId?: string
  }) {
    this.access(input.id, input.sessionId, true)
    this.options.assertMutation(String(input.sessionId), 'send')
    return this.options.service.send(input.id, input)
  }
  async interrupt(input: {
    id: string
    runId: string
    sessionId?: string | null
  }) {
    const state = this.access(input.id, input.sessionId, true)
    if (!state.runs[input.runId])
      throw new DelegationError(
        'RUN_NOT_FOUND',
        'run does not belong to this child',
      )
    await this.options.acceptance.stopRun(input.runId)
    return this.options.service.interrupt(input.id, input.runId)
  }
  async recover(input: {
    id: string
    expectedRevision: number
    sessionId?: string | null
    inspect?: boolean
    verificationId?: string
  }) {
    const state = this.access(input.id, input.sessionId, true)
    if (input.verificationId) {
      if (
        !Object.values(state.runs).some((run) =>
          this.options.acceptance
            .pendingRecoveries(run.id)
            .includes(input.verificationId!),
        )
      )
        throw new DelegationError(
          'PERMISSION_DENIED',
          'verification recovery belongs to another task',
        )
      await this.options.acceptance.recoverVerification(input.verificationId)
      return this.options.service.inspect(input.id).record!
    }
    return input.inspect
      ? this.options.service.inspectRecovery(input.id)
      : this.options.service.recover(input.id, input.expectedRevision)
  }
  /** 「标记为已结束」 from the conversation (AGT-04). */
  async abandon(input: { id: string; sessionId?: string | null }) {
    const state = this.access(input.id, input.sessionId, true)
    for (const run of Object.values(state.runs))
      await this.options.acceptance.stopRun(run.id)
    return this.options.service.abandon(input.id, 'user')
  }
  async collect(input: { runId: string; sessionId?: string | null }) {
    const { record, run } = this.run(input.runId, input.sessionId)
    this.access(record.id, input.sessionId, true)
    if (!TERMINAL_RUN_PHASES.has(run.phase))
      throw new DelegationError(
        'ACTIVE_RUN',
        'collection requires a terminal run',
      )
    await this.options.service.wait(record.id, run.id)
    const settled = this.options.service.inspect(record.id).runs[run.id]!
    if (settled.receiptId) return this.options.receipts.get(settled.receiptId)
    const receipt = await this.options.receipts.collect(run.id)
    await this.options.service.bindReceipt(
      record.id,
      run.id,
      receipt.id,
      'unverified',
    )
    return receipt
  }
  async validate(input: {
    runId: string
    receiptId: string
    criteria: AcceptanceCriteria
    sessionId?: string | null
    reviewedTreeDigest?: string
  }) {
    const { record, run } = this.run(input.runId, input.sessionId)
    this.access(record.id, input.sessionId, true)
    if (run.receiptId !== input.receiptId)
      throw new DelegationError(
        'PERMISSION_DENIED',
        'receipt does not belong to this run',
      )
    const accepted = await this.options.acceptance.validate(
      input.receiptId,
      input.criteria,
      {
        source: 'human',
        taskScopeId: record.owner.taskScopeId,
        criteriaDigest: criteriaDigest(input.criteria),
        reviewedTreeDigest: input.reviewedTreeDigest,
      },
    )
    await this.options.service.bindReceipt(
      record.id,
      run.id,
      input.receiptId,
      accepted.state,
      accepted.id,
    )
    return accepted
  }
  async receipt(input: { runId: string; sessionId?: string | null }) {
    const { run, record } = this.run(input.runId, input.sessionId)
    let preview: ReturnType<DelegationIntegration['get']> | null = null,
      previewError: string | null = null,
      patch: ReturnType<DelegationReceipts['readPatch']> = null,
      patchError: string | null = null
    if (run.integrationPreviewId)
      try {
        preview = this.options.integration.get(run.integrationPreviewId)
      } catch {
        previewError =
          'PREVIEW_UNREADABLE: retained preview requires inspection'
      }
    if (run.receiptId)
      try {
        patch = this.options.receipts.readPatch(run.receiptId)
      } catch {
        patchError = 'PATCH_UNREADABLE: inspect the retained workspace'
      }
    const receipt = run.receiptId
      ? this.options.receipts.get(run.receiptId)
      : null
    return {
      patch,
      patchError,
      previewError,
      receipt,
      requiresAcceptance: receipt
        ? requiresArtifactAcceptance(record, receipt)
        : false,
      acceptance: run.acceptanceId
        ? await this.options.acceptance.current(run.acceptanceId)
        : null,
      preview,
      verificationActive: this.options.acceptance.isActive(run.id),
      verificationRecoveryIds: this.options.acceptance.pendingRecoveries(
        run.id,
      ),
    }
  }
  async integrate(input: {
    runId: string
    sessionId?: string | null
    action: 'preview' | 'apply'
    expectedBase?: IntegrationBase
    previewId?: string
    expectedRevision?: number
    previewDigest?: string
  }) {
    const { record, run } = this.run(input.runId, input.sessionId)
    this.access(record.id, input.sessionId, true)
    this.options.assertMutation(record.owner.rootSessionId, 'integrate')
    if (input.action === 'preview') {
      if (!run.receiptId || !run.acceptanceId)
        throw new DelegationError(
          'ACCEPTANCE_REQUIRED',
          'validate the exact receipt first',
        )
      const receipt = this.options.receipts.get(run.receiptId)
      const preview = await this.options.integration.previewIntegration(
        run.receiptId,
        input.expectedBase ??
          (await this.options.integration.captureBase(receipt.originCwd)),
        run.acceptanceId,
      )
      await this.options.service.bindIntegration(record.id, run.id, preview.id)
      return preview
    }
    if (
      !input.previewId ||
      input.expectedRevision === undefined ||
      !input.previewDigest
    )
      throw new DelegationError(
        'PREVIEW_REQUIRED',
        'exact preview and revision required',
      )
    const preview = this.options.integration.get(input.previewId)
    if (preview.receiptId !== run.receiptId)
      throw new DelegationError(
        'PERMISSION_DENIED',
        'preview belongs to another run',
      )
    return this.options.integration.applyIntegration(
      input.previewId,
      input.expectedRevision,
      {
        source: 'human',
        taskScopeId: record.owner.taskScopeId,
        previewDigest: input.previewDigest,
      },
    )
  }
  /** 应用到项目 on the result card (AGT-06). */
  async apply(input: { runId: string; sessionId?: string | null }) {
    const { record, run } = this.run(input.runId, input.sessionId)
    this.access(record.id, input.sessionId, true)
    this.options.assertMutation(record.owner.rootSessionId, 'integrate')
    return this.options.service.applyResult(record.id, run.id, 'user')
  }
  /** 丢弃 / 清理 on the result card (AGT-06). */
  async discard(input: { runId: string; sessionId?: string | null }) {
    const { record, run } = this.run(input.runId, input.sessionId)
    this.access(record.id, input.sessionId, true)
    this.options.assertMutation(record.owner.rootSessionId, 'integrate')
    return this.options.service.discardResult(record.id, run.id, 'user')
  }
  /** 撤销 after 应用到项目 (AGT-06). */
  async undo(input: { runId: string; sessionId?: string | null }) {
    const { record, run } = this.run(input.runId, input.sessionId)
    this.access(record.id, input.sessionId, true)
    this.options.assertMutation(record.owner.rootSessionId, 'integrate')
    return this.options.service.undoResult(record.id, run.id)
  }
  /** 查看差异: one file of a run's result (AGT-06). */
  async diff(input: {
    runId: string
    path: string
    sessionId?: string | null
  }) {
    const { record, run } = this.run(input.runId, input.sessionId)
    return this.options.service.resultDiff(record.id, run.id, input.path)
  }
  async close(input: {
    id: string
    sessionId?: string | null
    failureDisposition?: string
  }) {
    const state = this.access(input.id, input.sessionId, true)
    for (const run of Object.values(state.runs))
      await this.options.acceptance.stopRun(run.id)
    if (input.failureDisposition)
      await this.options.service.disposeGoalFailure(
        input.id,
        input.failureDisposition,
      )
    return this.options.service.close(input.id)
  }
  async wait(runId: string, timeoutMs: number, sessionId?: string | null) {
    const { record, run } = this.run(runId, sessionId)
    if (TERMINAL_RUN_PHASES.has(run.phase))
      return {
        status: run.phase,
        task: externalTask(this.options.service.inspect(record.id), run),
      }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.options.service
          .wait(record.id, runId, controller.signal)
          .then((r) => ({
            status: r.phase,
            task: externalTask(this.options.service.inspect(record.id), r),
          })),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs)
        }),
      ])
    } finally {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }
}
