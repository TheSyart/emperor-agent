import { expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DelegationService } from './service'
import { defaultExecutorConfig } from './config'
import { ExecutorRegistry } from './registry'
import {
  FakeExecutorAdapter,
  delegationTestDirectory,
  fixtureDelegationRecord,
} from './testing'
import { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
import type { DelegationStart } from './types'

/** Waits on work that runs processes, Git or the file system: room for a
 * loaded CI runner instead of the 1 s default (FIX-17). */
const LOADED = { timeout: 10_000 }

it('scheduler and ordinary children share global quota; stable Goal identity retains required children across revisions', async () => {
  const f = delegationTestDirectory(),
    config = defaultExecutorConfig(),
    registry = new ExecutorRegistry()
  config.profiles.forEach((p) => {
    p.enabled = true
    p.concurrencyLimit = 2
  })
  const releases: (() => void)[] = [],
    started: string[] = [],
    deliveryRequiresAcceptance = vi.fn().mockReturnValue(true)
  const script: ConstructorParameters<typeof FakeExecutorAdapter>[1] =
    async function* (turn, open) {
      started.push(turn.runId)
      await new Promise<void>((resolve) => {
        releases.push(resolve)
        open.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield {
        type: 'turn_finished',
        status: 'completed',
        delegationId: open.delegationId,
        runId: turn.runId,
        generation: open.generation,
      }
    }
  const service = new DelegationService({
    root: f.root,
    config: () => config,
    registry: {
      capabilities: (backend) => registry.capabilities(backend),
      requireAvailable: async (p) => ({
        status: 'available',
        capabilities: registry.capabilities(p.backend),
        checkedAt: 1,
        authVerified: false,
      }),
    },
    adapters: new Map([
      ['codex', new FakeExecutorAdapter('codex', script)],
      ['claude-code', new FakeExecutorAdapter('claude-code', script)],
    ]),
    acceptanceCurrent: async () => ({ state: 'passed' }),
    deliveryRequiresAcceptance,
    parent: () => ({
      cwd: f.root,
      policy: { workspaceRoot: f.root, mode: 'read-only' },
    }),
    workspaces: {
      prepare: async (owner) => ({
        id: 'lease',
        revision: 1,
        owner,
        cwd: f.root,
        path: f.root,
        mode: 'shared-readonly',
        status: 'ready',
      }),
      retain: vi.fn(),
      get: vi.fn(),
      release: vi.fn(),
    },
    mutations: new WorkspaceMutationCoordinator(),
    runtime: async (_, id) => {
      const root = join(f.root, id)
      mkdirSync(root, { recursive: true })
      return { runtimeRoot: root, tempRoot: root, environment: {} }
    },
  })
  try {
    const owner = {
      ...fixtureDelegationRecord().owner,
      taskScopeId: 'goal:g',
      goalRef: { id: 'g', revision: 1 },
      requiredForGoal: true,
    }
    const spec: DelegationStart = {
      backend: 'codex',
      description: 'fixture',
      prompt: 'fixture',
      context: 'isolated',
      workspace: 'shared-readonly',
      base: 'committed',
      runInBackground: true,
      clientRequestId: '1',
    }
    const a = await service.start(owner, spec),
      b = await service.start(
        { ...owner, source: 'scheduler', goalRef: { id: 'g', revision: 3 } },
        { ...spec, backend: 'claude-code', clientRequestId: '2' },
      ),
      c = await service.start(
        { ...owner, source: 'scheduler' },
        { ...spec, clientRequestId: '3' },
      )
    await vi.waitFor(() => expect(started).toHaveLength(2), LOADED)
    expect(service.hasOutstanding('root')).toBe(true)
    expect(
      service
        .requiredForGoal({ id: 'g', revision: 9 }, 'root')
        .map((s) => s.record!.id)
        .sort(),
    ).toEqual([a.id, b.id, c.id].sort())
    expect(service.budget.usage('goal:g').runs).toBe(2)
    releases[1]!()
    await vi.waitFor(() => expect(started).toHaveLength(3), LOADED)
    releases.forEach((release) => release())
    await Promise.all(
      [a, b, c].map((record) => service.wait(record.id, record.currentRunId!)),
    )
    await service.stopRoot('root')
    expect(service.hasOutstanding('root')).toBe(false)
    // A settled read-only review is a text result (AGT-06: no receipt is
    // collected unless 高级 › 验证后再应用 is on).
    await expect(
      service.verifyGoalCompletion({ id: 'g', revision: 9 }, 'root'),
    ).resolves.toBeUndefined()
    // With 验证后再应用 on, the receipt decides, as before.
    config.verifyBeforeApply = true
    await expect(
      service.verifyGoalCompletion({ id: 'g', revision: 9 }, 'root'),
    ).rejects.toThrow('no current host acceptance')
    // Successful text results do not require an invented artifact test. A
    // settled receipt still identifies the result; failed checks stay blocking.
    deliveryRequiresAcceptance.mockReturnValue(false)
    await expect(
      service.verifyGoalCompletion({ id: 'g', revision: 9 }, 'root'),
    ).rejects.toThrow('no current host acceptance')
    for (const record of [a, b, c])
      await service.bindReceipt(
        record.id,
        record.currentRunId!,
        'receipt-' + record.id,
        'unverified',
      )
    await expect(
      service.verifyGoalCompletion({ id: 'g', revision: 9 }, 'root'),
    ).resolves.toBeUndefined()
    await service.bindReceipt(
      a.id,
      a.currentRunId!,
      'receipt-' + a.id,
      'failed',
    )
    await expect(
      service.verifyGoalCompletion({ id: 'g', revision: 9 }, 'root'),
    ).rejects.toThrow('no current host acceptance')
    deliveryRequiresAcceptance.mockReturnValue(true)
    for (const record of [a, b, c])
      await service.bindReceipt(
        record.id,
        record.currentRunId!,
        'receipt-' + record.id,
        'passed',
        'acceptance-' + record.id,
      )
    await expect(
      service.verifyGoalCompletion({ id: 'g', revision: 9 }, 'root'),
    ).resolves.toBeUndefined()

    await service.bindReceipt(
      a.id,
      a.currentRunId!,
      'receipt-' + a.id,
      'failed',
      'acceptance-' + a.id,
    )
    await service.disposeGoalFailure(
      a.id,
      'User explicitly accepted this fixture failure and omitted its deliverable',
    )
    await expect(
      service.verifyGoalCompletion({ id: 'g', revision: 9 }, 'root'),
    ).rejects.toThrow('no current host acceptance')
    await service.close(a.id)
    await expect(
      service.verifyGoalCompletion({ id: 'g', revision: 9 }, 'root'),
    ).resolves.toBeUndefined()
    // Stopping the root does not rewrite settled conversations (AGT-04).
    expect(service.list().some((s) => s.record!.dispatchPaused)).toBe(false)
  } finally {
    releases.forEach((release) => release())
    await service.shutdown()
    f.cleanup()
  }
})
