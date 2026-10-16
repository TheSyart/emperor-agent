import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DelegationService, type DelegationServiceOptions } from './service'
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
  callbacks: Pick<
    DelegationServiceOptions,
    'onSettled' | 'onState' | 'onStopRoot'
  > = {},
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
    ...callbacks,
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
    registry,
    prepare,
    mutations,
    setParent: (mode: DelegationParentContext['policy']['mode']) => {
      parent = { cwd: f.root, policy: { mode, workspaceRoot: f.root } }
    },
  }
}
it('root stop fences an in-flight start before any provider work is dispatched', async () => {
  const f = fixture()
  let ready!: () => void
  const gate = new Promise<void>((resolve) => {
    ready = resolve
  })
  vi.spyOn(f.registry, 'requireAvailable').mockImplementation(
    async (profile) => {
      await gate
      return {
        status: 'available',
        checkedAt: Date.now(),
        authVerified: false,
        capabilities: f.registry.capabilities(profile.backend),
      }
    },
  )
  const starting = f.service.start(f.owner, spec).catch((error) => error)
  await f.service.stopRoot('root')
  ready()
  expect(String(await starting)).toContain('ABORTED')
  expect(f.service.list()).toEqual([])
  expect(f.adapter.opened.length).toBe(0)
  f.cleanup()
})
it('root stop cancels active and queued descendant work without closing an idle conversation', async () => {
  let prepared!: () => void
  const gate = new Promise<void>((resolve) => {
    prepared = resolve
  })
  const f = fixture(undefined, gate),
    record = await f.service.start(f.owner, spec)
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalled())
  await f.service.send(record.id, {
    messageId: 'dgm-after',
    text: 'after',
    delivery: 'queue',
  })
  const stopping = f.service.stopRoot('root')
  prepared()
  await stopping
  expect((await f.service.wait(record.id, record.currentRunId!)).phase).toBe(
    'cancelled',
  )
  expect(f.adapter.submitted.length).toBe(0)
  expect(
    Object.values(f.service.inspect(record.id).messages).every(
      (m) => m.status === 'cancelled',
    ),
  ).toBe(true)
  f.cleanup()
})
it('a queued send cannot reopen a conversation while its current run is cancelling', async () => {
  let prepared!: () => void
  const gate = new Promise<void>((resolve) => {
    prepared = resolve
  })
  const f = fixture(undefined, gate),
    record = await f.service.start(f.owner, spec)
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalled())
  const stopping = f.service.interrupt(record.id, record.currentRunId!)
  await vi.waitFor(() =>
    expect(f.service.inspect(record.id).runs[record.currentRunId!]!.phase).toBe(
      'cancelling',
    ),
  )
  await expect(
    f.service.send(record.id, {
      messageId: 'dgm-race',
      text: 'do more',
      delivery: 'queue',
    }),
  ).rejects.toThrow('STOPPING')
  prepared()
  await stopping
  expect((await f.service.wait(record.id, record.currentRunId!)).phase).toBe(
    'cancelled',
  )
  expect(f.adapter.submitted.length).toBe(0)
  f.cleanup()
})
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

it('finishes durable receipt collection before submitting a queued followup', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    collected = vi.fn(async () => {
      await gate
    })
  const f = fixture(undefined, undefined, { onSettled: collected })
  try {
    const record = await f.service.start(f.owner, spec)
    await vi.waitFor(() => expect(collected).toHaveBeenCalledOnce())
    await f.service.send(record.id, {
      messageId: 'dgm-followup',
      text: 'next',
      delivery: 'queue',
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(f.adapter.submitted).toHaveLength(1)
    release()
    await vi.waitFor(() => expect(f.adapter.submitted).toHaveLength(2))
    expect(f.service.inspect(record.id).runs[record.currentRunId!]?.phase).toBe(
      'completed',
    )
  } finally {
    release()
    await f.service.shutdown()
    f.cleanup()
  }
})

it('awaits the same shutdown barrier for concurrent and repeated close requests', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    stop = vi.fn(async () => {
      await gate
    })
  const f = fixture(undefined, undefined, { onStopRoot: stop })
  try {
    const record = await f.service.start(f.owner, spec)
    await f.service.wait(record.id, record.currentRunId!)
    const first = f.service.shutdown(),
      second = f.service.shutdown()
    await vi.waitFor(() => expect(stop).toHaveBeenCalled())
    expect(stop).toHaveBeenCalledTimes(1)
    let settled = false
    void second.then(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    release()
    await Promise.all([first, second])
    const seq = f.service.inspect(record.id).lastSeq
    await f.service.shutdown()
    expect(f.service.inspect(record.id).lastSeq).toBe(seq)
  } finally {
    release()
    await f.service.shutdown()
    f.cleanup()
  }
})
