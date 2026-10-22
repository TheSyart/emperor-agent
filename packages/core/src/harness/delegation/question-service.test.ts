import { expect, it, vi } from 'vitest'
import { DelegationService } from './service'
import { defaultExecutorConfig } from './config'
import { ExecutorRegistry } from './registry'
import { AsyncQueue } from './adapters/async-queue'
import { delegationTestDirectory, fixtureDelegationRecord } from './testing'
import { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
import type {
  ExecutorSession,
  ExecutorOpenInput,
  NormalizedExecutorEvent,
  DelegationStart,
  ExecutorInteractionAnswer,
  ExecutorEventPayload,
} from './types'

/** Waits on work that runs processes, Git or the file system: room for a
 * loaded CI runner instead of the 1 s default (FIX-17). */
const LOADED = { timeout: 10_000 }

function fixture(
  onQuestion?: ConstructorParameters<typeof DelegationService>[0]['onQuestion'],
) {
  const f = delegationTestDirectory(),
    config = defaultExecutorConfig(),
    registry = new ExecutorRegistry(),
    owner = fixtureDelegationRecord().owner
  config.profiles.forEach((p) => (p.enabled = true))
  vi.spyOn(registry, 'requireAvailable').mockImplementation(async (p) => ({
    status: 'available',
    authVerified: false,
    checkedAt: 0,
    capabilities: registry.capabilities(p.backend),
  }))
  const events = new AsyncQueue<NormalizedExecutorEvent>(),
    answer = vi.fn(async (_answer: ExecutorInteractionAnswer) => {}),
    denied = vi.fn(async (_answer: ExecutorInteractionAnswer) => {}),
    observed: NormalizedExecutorEvent[] = []
  const persisted: string[] = []
  let runId = '',
    open!: ExecutorOpenInput
  const lease = {
    id: 'lease',
    revision: 1,
    cwd: f.root,
    path: f.root,
    owner,
    mode: 'shared-readonly' as const,
    status: 'ready' as const,
  }
  const service = new DelegationService({
    root: f.root,
    config: () => config,
    registry,
    adapters: new Map([
      [
        'codex',
        {
          backend: 'codex',
          open: async (input: ExecutorOpenInput) => {
            open = input
            const session: ExecutorSession = {
              providerSessionId: 'native',
              events,
              submit: async (t) => {
                runId = t.runId
                return { providerTurnId: 'turn' }
              },
              answer: async (a) => {
                if (a.kind === 'deny') await denied(a)
                else await answer(a)
              },
              steer: async () => {},
              interrupt: async () => {},
              close: async () => {
                events.end()
                return { quiescent: true }
              },
            }
            return session
          },
        },
      ],
    ]),
    parent: () => ({
      cwd: f.root,
      policy: { mode: 'read-only', workspaceRoot: f.root },
    }),
    workspaces: {
      prepare: async () => lease,
      get: () => lease,
      retain: () => lease,
      release: () => lease,
    },
    mutations: new WorkspaceMutationCoordinator(),
    runtime: async () => ({
      environment: {},
      runtimeRoot: f.root,
      tempRoot: f.root,
    }),
    onQuestion,
    onEvent: (e) => {
      if (e.type === 'question')
        persisted.push(
          service.inspect(e.delegationId).interactions[e.requestId]?.state ??
            'missing',
        )
      observed.push(e)
    },
  })
  const spec: DelegationStart = {
    backend: 'codex',
    prompt: 'fixture',
    description: 'business task',
    context: 'isolated',
    workspace: 'shared-readonly',
    base: 'committed',
    runInBackground: true,
    clientRequestId: 'start',
  }
  const emit = (e: ExecutorEventPayload, id: string) =>
    events.push({
      ...e,
      delegationId: id,
      runId,
      generation: open.generation,
    } as NormalizedExecutorEvent)
  return {
    ...f,
    service,
    owner,
    spec,
    answer,
    denied,
    emit,
    observed,
    persisted,
  }
}
it('persists question ownership before publishing, fences generations and answers exactly once', async () => {
  const f = fixture(() => new Promise(() => {})),
    record = await f.service.start(f.owner, f.spec)
  await vi.waitFor(
    () =>
      expect(
        f.service.inspect(record.id).runs[record.currentRunId!]!.phase,
      ).toBe('running'),
    LOADED,
  )
  f.emit(
    {
      type: 'question',
      requestId: 'req',
      questions: [{ id: 'q', title: 'Choose?' }],
    },
    record.id,
  )
  await vi.waitFor(
    () =>
      expect(
        f.service.inspect(record.id).runs[record.currentRunId!]!.phase,
      ).toBe('waiting_input'),
    LOADED,
  )
  expect(f.persisted).toEqual(['pending'])
  const input = {
    rootSessionId: 'root',
    runId: record.currentRunId!,
    generation: 1,
    requestId: 'req',
    answers: { q: 'blue' },
  }
  await expect(
    f.service.answer(record.id, { ...input, generation: 2 }),
  ).rejects.toThrow('STALE_RUN')
  await expect(
    f.service.answer(record.id, { ...input, rootSessionId: 'other' }),
  ).rejects.toThrow('PERMISSION_DENIED')
  await expect(
    f.service.answer(record.id, {
      ...input,
      answers: { permissions: 'allow' },
    }),
  ).rejects.toThrow('INVALID_ANSWER')
  expect(f.answer).not.toHaveBeenCalled()
  await f.service.answer(record.id, input)
  await expect(f.service.answer(record.id, input)).rejects.toThrow(
    'STALE_REQUEST',
  )
  expect(f.answer).toHaveBeenCalledTimes(1)
  expect(f.answer).toHaveBeenCalledWith({
    requestId: 'req',
    generation: 1,
    kind: 'question',
    answers: { q: 'blue' },
  })
  f.emit({ type: 'turn_finished', status: 'completed' }, record.id)
  expect((await f.service.wait(record.id, record.currentRunId!)).phase).toBe(
    'completed',
  )
  f.cleanup()
})
it('unavailable answers deny the request and interrupt with needs_user rather than hang', async () => {
  const f = fixture(),
    record = await f.service.start(f.owner, f.spec)
  await vi.waitFor(
    () =>
      expect(
        f.service.inspect(record.id).runs[record.currentRunId!]!.phase,
      ).toBe('running'),
    LOADED,
  )
  f.emit(
    {
      type: 'question',
      requestId: 'req',
      questions: [{ id: 'q', title: 'Choose?' }],
    },
    record.id,
  )
  const run = await f.service.wait(record.id, record.currentRunId!)
  expect(run).toMatchObject({
    phase: 'interrupted',
    acceptance: 'needs_user',
    failureCode: 'QUESTION_UNAVAILABLE',
  })
  expect(f.denied).toHaveBeenCalledTimes(1)
  expect(f.answer).not.toHaveBeenCalled()
  expect(f.service.inspect(record.id).interactions.req?.state).toBe('cancelled')
  f.cleanup()
})
it('permission denials never become business questions or widen parent policy', async () => {
  const ask = vi.fn(),
    f = fixture(ask),
    record = await f.service.start(f.owner, f.spec)
  await vi.waitFor(
    () =>
      expect(
        f.service.inspect(record.id).runs[record.currentRunId!]!.phase,
      ).toBe('running'),
    LOADED,
  )
  f.emit(
    {
      type: 'permission_denied',
      requestId: 'p',
      reason: 'sandbox widening denied',
    },
    record.id,
  )
  f.emit({ type: 'turn_finished', status: 'completed' }, record.id)
  await f.service.wait(record.id, record.currentRunId!)
  expect(ask).not.toHaveBeenCalled()
  expect(f.answer).not.toHaveBeenCalled()
  expect(f.service.inspect(record.id).record?.effectivePermission).toBe(
    'read-only',
  )
  expect(f.observed.some((e) => e.type === 'permission_denied')).toBe(true)
  f.cleanup()
})
