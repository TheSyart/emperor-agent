import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DelegationService } from '../../harness/delegation/service'
import type { DelegationState } from '../../harness/delegation/fold'
import type { DelegationReceipts } from '../../harness/delegation/receipts'
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
export function externalTask(state: DelegationState, run: DelegationRunRecord) {
  const record = state.record!
  return {
    id: run.id,
    kind: 'external-agent' as const,
    label: record.startSpec?.description ?? record.backend,
    description: record.startSpec?.description ?? record.backend,
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
    detail: run.summary ?? null,
    revision: run.revision,
  }
}
export class CoreDelegationService {
  constructor(
    private readonly options: {
      root: string
      service: DelegationService
      receipts: DelegationReceipts
      acceptance: DelegationAcceptance
      integration: DelegationIntegration
      activeSession: () => string | null
      session: (id: string) => { archived_at?: string | null } | null
      assertMutation: (id: string, action: string) => void
    },
  ) {}
  private access(
    id: string,
    sessionId?: string | null,
    write = false,
  ): DelegationState {
    const state = this.options.service.inspect(id),
      root = String(sessionId ?? this.options.activeSession() ?? '')
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
    this.options.assertMutation(
      String(input.sessionId ?? this.options.activeSession()),
      'send',
    )
    return this.options.service.send(input.id, input)
  }
  async interrupt(input: {
    id: string
    runId: string
    sessionId?: string | null
  }) {
    this.access(input.id, input.sessionId, true)
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
    const { run } = this.run(input.runId, input.sessionId)
    return {
      receipt: run.receiptId ? this.options.receipts.get(run.receiptId) : null,
      acceptance: run.acceptanceId
        ? await this.options.acceptance.current(run.acceptanceId)
        : null,
      preview: run.integrationPreviewId
        ? this.options.integration.get(run.integrationPreviewId)
        : null,
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
  async close(input: { id: string; sessionId?: string | null }) {
    const state = this.access(input.id, input.sessionId, true)
    for (const run of Object.values(state.runs))
      await this.options.acceptance.stopRun(run.id)
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
