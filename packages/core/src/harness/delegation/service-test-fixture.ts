import { vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DelegationService, type DelegationServiceOptions } from './service'
import { defaultExecutorConfig } from './config'
import { ExecutorRegistry } from './registry'
import {
  FakeExecutorAdapter,
  delegationTestDirectory,
  fixtureDelegationRecord,
} from './testing'
import { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
import type { DelegationParentContext } from './policy'
import type {
  DelegationStart,
  ExecutorOpenInput,
  ExecutorTurnInput,
  NormalizedExecutorEvent,
} from './types'
export const spec: DelegationStart = {
  backend: 'codex',
  description: 'fixture task',
  prompt: 'perform fixture',
  context: 'isolated',
  workspace: 'shared-readonly',
  base: 'committed',
  runInBackground: true,
  clientRequestId: 'start',
}
export function fixture(
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
  const options: DelegationServiceOptions = {
    root: f.root,
    // Keep startup marker cleanup away from the real /private/tmp.
    boundaryMarkerDir: join(f.root, 'markers'),
    config: () => config,
    registry,
    adapters: new Map([['codex', adapter]]),
    parent: () => parent,
    workspaces: {
      prepare,
      retain: vi.fn(),
      get: vi.fn(() => ({
        id: 'lease-fixture',
        revision: 1,
        owner,
        cwd: f.root,
        path: f.root,
        mode: 'shared-readonly' as const,
        status: 'ready' as const,
      })),
      release: vi.fn(),
    },
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
  }
  const service = new DelegationService(options)
  return {
    ...f,
    options,
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
