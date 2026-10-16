import { expect, it } from 'vitest'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, spec } from './service-test-fixture'
import { DelegationService } from './service'
import { DelegationJournal } from './journal'
import { fixtureDelegationRecord, fixtureDelegationRun } from './testing'
import { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
it('reconciles a completed conversation without re-dispatch and resumes only a new explicit turn in the same native session', async () => {
  const f = fixture(),
    record = await f.service.start(f.owner, spec)
  await f.service.wait(record.id, record.currentRunId!)
  const state = f.service.inspect(record.id),
    count = f.adapter.submitted.length
  const restarted = new DelegationService({
    ...f.options,
    mutations: new WorkspaceMutationCoordinator(),
  })
  await restarted.reconcile()
  expect(restarted.inspect(record.id).record?.providerSessionId).toBe(
    state.record?.providerSessionId,
  )
  expect(f.adapter.submitted).toHaveLength(count)
  expect(restarted.budget.usage(f.owner.taskScopeId).runs).toBe(1)
  await restarted.send(record.id, {
    messageId: 'dgm-new',
    text: 'explicit next operation',
    delivery: 'queue',
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const next = restarted.inspect(record.id).record!.currentRunId!
  expect(next).not.toBe(record.currentRunId)
  await restarted.wait(record.id, next)
  expect(f.adapter.opened.at(-1)?.resumeSessionId).toBe(
    state.record?.providerSessionId,
  )
  f.cleanup()
})
it('unknown sends are not replayed and retain quota and writer quarantine until proven recoverable', async () => {
  const f = fixture(),
    record = {
      ...fixtureDelegationRecord(),
      cwd: f.root,
      startSpec: { ...spec, workspace: 'shared-exclusive' as const },
      effectivePermission: 'workspace-write' as const,
    },
    journal = new DelegationJournal(f.root, record.id)
  await journal.append({ type: 'created', record })
  await journal.append({
    type: 'message-enqueued',
    message: { id: 'dgm-1', text: 'side effect', status: 'queued' },
  })
  await journal.append({ type: 'run-created', run: fixtureDelegationRun() })
  await journal.append({
    type: 'run-changed',
    runId: 'dgr-1',
    patch: { phase: 'preparing', quotaReserved: true },
  })
  await journal.append({
    type: 'send-intent',
    runId: 'dgr-1',
    messageId: 'dgm-1',
  })
  await journal.append({
    type: 'run-changed',
    runId: 'dgr-1',
    patch: { phase: 'running' },
  })
  const restarted = new DelegationService(f.options)
  await restarted.reconcile()
  const state = restarted.inspect(record.id)
  expect(state.runs['dgr-1']).toMatchObject({
    phase: 'outcome_unknown',
    quiescent: false,
  })
  expect(state.messages['dgm-1']?.status).toBe('delivery_unknown')
  expect(f.adapter.submitted).toHaveLength(0)
  expect(f.mutations.hasActiveWriter(f.root)).toBe(true)
  expect(restarted.budget.usage('task')).toMatchObject({
    runs: 1,
    unknownRuns: 1,
  })
  await expect(
    restarted.recover(record.id, state.runs['dgr-1']!.revision - 1),
  ).rejects.toThrow('STALE_REVISION')
  await expect(
    restarted.recover(record.id, state.runs['dgr-1']!.revision),
  ).rejects.toThrow('OUTCOME_UNKNOWN')
  expect(f.adapter.submitted).toHaveLength(0)
  f.cleanup()
})
it('keeps restart queues paused until explicit recovery and preserves dirty output when the workspace lease is missing', async () => {
  const f = fixture(),
    record = {
      ...fixtureDelegationRecord(),
      cwd: f.root,
      workspaceLeaseId: 'lease-fixture',
      startSpec: spec,
    },
    journal = new DelegationJournal(f.root, record.id),
    dirty = join(f.root, 'user-output.txt')
  writeFileSync(dirty, 'retained edits')
  await journal.append({ type: 'created', record })
  await journal.append({
    type: 'message-enqueued',
    message: { id: 'dgm-1', text: 'queued original', status: 'queued' },
  })
  await journal.append({ type: 'run-created', run: fixtureDelegationRun() })
  const restarted = new DelegationService(f.options)
  await restarted.reconcile()
  expect(restarted.inspect(record.id).record?.dispatchPaused).toBe(true)
  expect(f.adapter.submitted).toHaveLength(0)
  await expect(
    restarted.send(record.id, {
      messageId: 'dgm-2',
      text: 'more',
      delivery: 'queue',
    }),
  ).rejects.toThrow('RESTART_PAUSED')
  f.options.workspaces.get = () => {
    throw new Error('lease removed')
  }
  await expect(
    restarted.recover(
      record.id,
      restarted.inspect(record.id).runs['dgr-1']!.revision,
    ),
  ).rejects.toThrow('WORKSPACE_UNAVAILABLE')
  expect(readFileSync(dirty, 'utf8')).toBe('retained edits')
  expect(f.adapter.submitted).toHaveLength(0)
  f.cleanup()
})
it('restores pending completion notices without inference and does not wake a stopped parent until direct continuation', async () => {
  const { createTestHarness } = await import('../testing'),
    parent = createTestHarness().agent(),
    wake = (await import('vitest')).vi
      .spyOn(parent, 'wakeInbox')
      .mockImplementation(() => {})
  const f = fixture(),
    record = await f.service.start(f.owner, spec)
  await f.service.wait(record.id, record.currentRunId!)
  const count = f.adapter.submitted.length,
    restarted = new DelegationService({
      ...f.options,
      mutations: new WorkspaceMutationCoordinator(),
      notices: { parent: () => parent, canWake: () => true, flush: () => {} },
    })
  await restarted.reconcile()
  await restarted.dispatchNotices(record.id)
  expect(wake).not.toHaveBeenCalled()
  expect(f.adapter.submitted).toHaveLength(count)
  await restarted.resumeRootNotices(f.owner.rootSessionId)
  expect(wake).toHaveBeenCalledTimes(1)
  expect(
    restarted.inspect(record.id).outbox['dgn-' + record.currentRunId]
      ?.delivered,
  ).toBe(true)
  await restarted.resumeRootNotices(f.owner.rootSessionId)
  expect(wake).toHaveBeenCalledTimes(1)
  expect(f.adapter.submitted).toHaveLength(count)
  f.cleanup()
})
it('ignores stale-generation terminal events without settling the current run', async () => {
  let ready!: () => void
  const gate = new Promise<void>((r) => (ready = r))
  const f = fixture(async function* (turn, open) {
    yield {
      delegationId: open.delegationId,
      runId: turn.runId,
      generation: open.generation - 1,
      type: 'turn_finished',
      status: 'completed',
      text: 'stale',
    }
    await gate
    yield {
      delegationId: open.delegationId,
      runId: turn.runId,
      generation: open.generation,
      type: 'turn_finished',
      status: 'completed',
      text: 'current',
    }
  })
  const record = await f.service.start(f.owner, spec)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(f.service.inspect(record.id).runs[record.currentRunId!]?.phase).toBe(
    'running',
  )
  expect(Object.values(f.service.inspect(record.id).outbox)).toHaveLength(0)
  ready()
  expect((await f.service.wait(record.id, record.currentRunId!)).summary).toBe(
    'current',
  )
  f.cleanup()
})
it('requires native history inspection before releasing a proven stopped unknown run and never rewrites its terminal phase', async () => {
  const { saveOwnership } = await import('./ownership'),
    { vi } = await import('vitest'),
    f = fixture(),
    record = {
      ...fixtureDelegationRecord(),
      cwd: f.root,
      workspaceLeaseId: 'lease-fixture',
      providerSessionId: 'native-original',
      startSpec: { ...spec, workspace: 'shared-exclusive' as const },
      effectivePermission: 'workspace-write' as const,
    },
    journal = new DelegationJournal(f.root, record.id),
    processIdentity = {
      pid: 2000000000,
      startedAt: 1,
      fingerprint: 'historic',
      boundaryReceiptId: 'dgb-persisted',
      policyDigest: 'policy',
    }
  f.setParent('workspace-write')
  f.options.workspaces.get = () => ({
    id: 'lease-fixture',
    revision: 1,
    owner: record.owner,
    cwd: f.root,
    path: f.root,
    mode: 'shared-exclusive',
    status: 'retained',
  })
  await journal.append({ type: 'created', record })
  await journal.append({
    type: 'message-enqueued',
    message: { id: 'dgm-1', text: 'unknown old operation', status: 'queued' },
  })
  await journal.append({ type: 'run-created', run: fixtureDelegationRun() })
  await journal.append({
    type: 'run-changed',
    runId: 'dgr-1',
    patch: {
      phase: 'preparing',
      quotaReserved: true,
      process: processIdentity,
    },
  })
  await journal.append({
    type: 'provider-bound',
    runId: 'dgr-1',
    sessionId: 'native-original',
    turnId: 'turn-original',
    generation: 1,
  })
  await journal.append({
    type: 'send-intent',
    runId: 'dgr-1',
    messageId: 'dgm-1',
  })
  await journal.append({
    type: 'run-changed',
    runId: 'dgr-1',
    patch: { phase: 'running' },
  })
  saveOwnership(f.root, {
    schemaVersion: 1,
    ...processIdentity,
    platform: process.platform,
    delegationId: record.id,
    runId: 'dgr-1',
    generation: 1,
    cwd: f.root,
    descendants: [],
  })
  const inspect = vi.fn(async () => ({
    sessionId: 'native-original',
    nativeStatus: 'idle',
    turns: [
      { id: 'turn-original', status: 'completed', text: 'native closing text' },
    ],
  }))
  f.options.adapters.set('codex', {
    backend: 'codex',
    open: (input) => f.adapter.open(input),
    inspect,
  })
  const restarted = new DelegationService(f.options)
  await restarted.reconcile()
  let run = restarted.inspect(record.id).runs['dgr-1']!
  expect(run).toMatchObject({ phase: 'outcome_unknown', quiescent: true })
  await expect(restarted.recover(record.id, run.revision)).rejects.toThrow(
    'HISTORY_NOT_INSPECTED',
  )
  expect(f.mutations.hasActiveWriter(f.root)).toBe(true)
  await restarted.inspectRecovery(record.id)
  expect(inspect).toHaveBeenCalledTimes(1)
  expect(f.adapter.submitted).toHaveLength(0)
  run = restarted.inspect(record.id).runs['dgr-1']!
  await restarted.recover(record.id, run.revision)
  expect(restarted.inspect(record.id).runs['dgr-1']).toMatchObject({
    phase: 'outcome_unknown',
    recoveryResolved: true,
  })
  expect(f.mutations.hasActiveWriter(f.root)).toBe(false)
  expect(restarted.inspect(record.id).messages['dgm-1']?.status).toBe(
    'cancelled',
  )
  const again = new DelegationService({
    ...f.options,
    mutations: new WorkspaceMutationCoordinator(),
  })
  await again.reconcile()
  expect(again.inspect(record.id).runs['dgr-1']?.recoveryResolved).toBe(true)
  expect(f.adapter.submitted).toHaveLength(0)
  f.cleanup()
})
it('rejects a workspace lease reassigned to a different parent in the same root', async () => {
  const f = fixture(),
    record = await f.service.start(f.owner, spec)
  await f.service.wait(record.id, record.currentRunId!)
  f.options.workspaces.get = () => ({
    id: 'lease-fixture',
    revision: 1,
    owner: { ...f.owner, parentAgentId: 'other-child' },
    cwd: f.root,
    path: f.root,
    mode: 'shared-readonly',
    status: 'retained',
  })
  const restarted = new DelegationService(f.options)
  await restarted.reconcile()
  expect(restarted.inspect(record.id).record?.availability).toBe(
    'needs_recovery',
  )
  await expect(
    restarted.recover(
      record.id,
      restarted.inspect(record.id).runs[record.currentRunId!]!.revision,
    ),
  ).rejects.toThrow('WORKSPACE_UNAVAILABLE')
  f.cleanup()
})
