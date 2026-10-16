import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DelegationService } from './service'
import { DelegationJournal } from './journal'
import { defaultExecutorConfig } from './config'
import { ExecutorRegistry } from './registry'
import {
  FakeExecutorAdapter,
  delegationTestDirectory,
  fixtureDelegationRecord,
} from './testing'
import { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
import type { DelegationParentContext } from './policy'
import { DelegationError } from './types'
import type {
  DelegationStart,
  ExecutorOpenInput,
  ExecutorTurnInput,
  NormalizedExecutorEvent,
} from './types'
const spec: DelegationStart = {
  backend: 'codex',
  description: 'fixture task',
  prompt: 'perform fixture',
  context: 'isolated',
  workspace: 'shared-readonly',
  base: 'committed',
  runInBackground: true,
  clientRequestId: 'start',
}
function fixture(
  script?: (
    turn: ExecutorTurnInput,
    open: ExecutorOpenInput,
  ) => AsyncIterable<NormalizedExecutorEvent>,
  prepareGate?: Promise<void>,
) {
  const f = delegationTestDirectory(),
    config = defaultExecutorConfig()
  config.profiles.forEach((p) => {
    p.enabled = true
  })
  const owner = fixtureDelegationRecord().owner
  const registry = new ExecutorRegistry()
  vi.spyOn(registry, 'requireAvailable').mockImplementation(async (p) => ({
    status: 'available',
    checkedAt: Date.now(),
    authVerified: false,
    capabilities: registry.capabilities(p.backend),
  }))
  const adapter = new FakeExecutorAdapter(
    'codex',
    script ??
      async function* (turn, open) {
        yield {
          type: 'turn_finished',
          status: 'completed',
          text: 'done',
          delegationId: open.delegationId,
          runId: turn.runId,
          generation: open.generation,
        }
      },
  )
  const prepare = vi.fn(async () => {
    await prepareGate
    return {
      id: 'lease-fixture',
      revision: 1,
      owner,
      cwd: f.root,
      path: f.root,
      mode: 'shared-readonly' as const,
      status: 'ready' as const,
    }
  })
  let parent: DelegationParentContext = {
    cwd: f.root,
    policy: { mode: 'read-only', workspaceRoot: f.root },
  }
  const mutations = new WorkspaceMutationCoordinator()
  const service = new DelegationService({
    root: f.root,
    config: () => config,
    registry,
    adapters: new Map([['codex', adapter]]),
    parent: () => parent,
    workspaces: { prepare, retain: vi.fn(), get: vi.fn(), release: vi.fn() },
    mutations,
    runtime: async (_profile, id) => {
      const runtimeRoot = join(f.root, 'runtime', id),
        tempRoot = join(runtimeRoot, 'tmp')
      mkdirSync(tempRoot, { recursive: true })
      return {
        runtimeRoot,
        tempRoot,
        environment: { PATH: process.env.PATH ?? '' },
      }
    },
  })
  return {
    ...f,
    owner,
    adapter,
    service,
    config,
    prepare,
    mutations,
    setParent: (mode: DelegationParentContext['policy']['mode']) => {
      parent = { cwd: f.root, policy: { mode, workspaceRoot: f.root } }
    },
  }
}
it('background start returns a durable queued identity before the provider finishes', async () => {
  let finish!: () => void
  const gate = new Promise<void>((r) => {
    finish = r
  })
  const f = fixture(async function* (turn, open) {
    await gate
    yield {
      type: 'turn_finished',
      status: 'completed',
      text: 'done',
      delegationId: open.delegationId,
      runId: turn.runId,
      generation: open.generation,
    }
  })
  const record = await f.service.start(f.owner, spec)
  expect(record.id).toMatch(/^dlg-/)
  expect(new DelegationJournal(f.root, record.id).load().record?.id).toBe(
    record.id,
  )
  expect(
    f.service.inspect(record.id).runs[record.currentRunId!]!.phase,
  ).not.toBe('completed')
  finish()
  expect((await f.service.wait(record.id, record.currentRunId!)).phase).toBe(
    'completed',
  )
  f.cleanup()
})
it('queued followup creates a new run and resumes the same provider session; duplicate message never resubmits', async () => {
  const f = fixture()
  const record = await f.service.start(f.owner, spec)
  await f.service.wait(record.id, record.currentRunId!)
  const session = f.service.inspect(record.id).record!.providerSessionId
  const sent = await f.service.send(record.id, {
    messageId: 'dgm-next',
    text: 'continue',
    delivery: 'queue',
  })
  await vi.waitFor(() =>
    expect(f.service.inspect(record.id).record!.currentRunId).not.toBe(
      record.currentRunId,
    ),
  )
  const next = f.service.inspect(record.id).record!.currentRunId!
  await f.service.wait(record.id, next)
  expect(f.service.inspect(record.id).record!.providerSessionId).toBe(session)
  expect(f.adapter.opened[1]!.resumeSessionId).toBe(session)
  expect(sent.state).toBe('queued')
  await f.service.send(record.id, {
    messageId: 'dgm-next',
    text: 'continue',
    delivery: 'queue',
  })
  expect(f.adapter.submitted.length).toBe(2)
  await expect(
    f.service.send(record.id, {
      messageId: 'dgm-next',
      text: 'different',
      delivery: 'queue',
    }),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  f.cleanup()
})
it('cancel during preparation cannot submit or dispatch followup', async () => {
  let prepared!: () => void
  const gate = new Promise<void>((r) => {
    prepared = r
  })
  const f = fixture(undefined, gate)
  const record = await f.service.start(f.owner, spec)
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalled())
  const stop = f.service.interrupt(record.id, record.currentRunId!)
  prepared()
  await stop
  expect((await f.service.wait(record.id, record.currentRunId!)).phase).toBe(
    'cancelled',
  )
  expect(f.adapter.submitted.length).toBe(0)
  f.cleanup()
})
it('rejects stale steer and queue overflow without calling the provider', async () => {
  let finish!: () => void
  const gate = new Promise<void>((r) => {
    finish = r
  })
  const f = fixture(async function* (turn, open) {
    await gate
    yield {
      type: 'turn_finished',
      status: 'completed',
      delegationId: open.delegationId,
      runId: turn.runId,
      generation: open.generation,
    }
  })
  const record = await f.service.start(f.owner, spec)
  await expect(
    f.service.send(record.id, {
      messageId: 'dgm-steer',
      text: 'wrong',
      delivery: 'steer',
      expectedRunId: 'dgr-foreign',
    }),
  ).rejects.toThrow('STALE_RUN')
  for (let i = 0; i < 16; i++)
    await f.service.send(record.id, {
      messageId: 'dgm-' + i,
      text: 'queued',
      delivery: 'queue',
    })
  await expect(
    f.service.send(record.id, {
      messageId: 'dgm-over',
      text: 'overflow',
      delivery: 'queue',
    }),
  ).rejects.toThrow('QUEUE_LIMIT')
  const stop = f.service.interrupt(record.id, record.currentRunId!)
  finish()
  await stop
  expect(f.adapter.submitted.length).toBeLessThanOrEqual(1)
  f.cleanup()
})
it('rejects unauthorized depth and writable permission before creating a delegation', async () => {
  const f = fixture()
  await expect(f.service.start({ ...f.owner, depth: 4 }, spec)).rejects.toThrow(
    'DEPTH_LIMIT',
  )
  await expect(
    f.service.start(f.owner, { ...spec, workspace: 'isolated-worktree' }),
  ).rejects.toThrow('PERMISSION_DENIED')
  expect(f.adapter.opened.length).toBe(0)
  f.cleanup()
})
it('start idempotency returns original identity and conflicting payload fails', async () => {
  const f = fixture()
  const a = await f.service.start(f.owner, spec)
  const b = await f.service.start(f.owner, spec)
  expect(a.id).toBe(b.id)
  await expect(
    f.service.start(f.owner, { ...spec, prompt: 'changed' }),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  await f.service.wait(a.id, a.currentRunId!)
  f.cleanup()
})
it('unknown process termination never becomes cancelled and retains the writer domain', async () => {
  let finish!: () => void
  const gate = new Promise<void>((r) => {
    finish = r
  })
  const f = fixture(async function* (turn, open) {
    await gate
    yield {
      type: 'turn_finished',
      status: 'interrupted',
      delegationId: open.delegationId,
      runId: turn.runId,
      generation: open.generation,
    }
  })
  const open = f.adapter.open.bind(f.adapter)
  vi.spyOn(f.adapter, 'open').mockImplementation(async (input) => {
    const session = await open(input)
    return { ...session, close: async () => ({ quiescent: false }) }
  })
  // Trusted parent context grants writes for this fixture.
  f.setParent('workspace-write')
  const record = await f.service.start(f.owner, {
    ...spec,
    workspace: 'shared-exclusive',
  })
  await vi.waitFor(() => expect(f.adapter.submitted.length).toBe(1))
  const stop = f.service.interrupt(record.id, record.currentRunId!)
  finish()
  await stop
  expect((await f.service.wait(record.id, record.currentRunId!)).phase).toBe(
    'outcome_unknown',
  )
  expect(f.service.inspect(record.id).record!.availability).toBe(
    'needs_recovery',
  )
  expect(f.mutations.hasActiveWriter(f.root)).toBe(true)
  f.cleanup()
})
it('permanently narrowed parent permission blocks continued execution', async () => {
  const f = fixture()
  f.setParent('workspace-write')
  const record = await f.service.start(f.owner, {
    ...spec,
    workspace: 'shared-exclusive',
  })
  await f.service.wait(record.id, record.currentRunId!)
  f.setParent('read-only')
  await expect(
    f.service.send(record.id, {
      messageId: 'dgm-revoked',
      text: 'continue',
      delivery: 'queue',
    }),
  ).rejects.toThrow(/PERMISSION_DENIED|PERMISSION_REVOKED/)
  expect(f.adapter.submitted.length).toBe(1)
  f.cleanup()
})
it('startup with unknown process ownership retains capacity and workspace instead of reporting failure', async () => {
  const f = fixture()
  f.setParent('workspace-write')
  vi.spyOn(f.adapter, 'open').mockRejectedValue(
    new DelegationError(
      'OUTCOME_UNKNOWN',
      'spawn ownership could not be proven',
    ),
  )
  const record = await f.service.start(f.owner, {
    ...spec,
    workspace: 'shared-exclusive',
  })
  expect((await f.service.wait(record.id, record.currentRunId!)).phase).toBe(
    'outcome_unknown',
  )
  expect(f.mutations.hasActiveWriter(f.root)).toBe(true)
  f.cleanup()
})
