import { expect, it, vi } from 'vitest'
import { ToolRegistry } from './registry'
import { DelegationResources } from '../delegation/resources'
import { JobRegistry, type JobOutcome } from '../jobs/registry'
function registry() {
  const resources = new DelegationResources()
  const tools = new ToolRegistry()
  tools.setWorkspaceAccessLeaseProvider({
    acquire: (call) =>
      resources.acquire(
        { keys: ['ws'], owner: call.callId, mode: 'shared' },
        call.signal,
      ),
  })
  return { tools, resources }
}
it('keeps actual tool body under its lease and releases after failure', async () => {
  const { tools, resources } = registry()
  let finish!: () => void
  const gate = new Promise<void>((r) => {
    finish = r
  })
  tools.register({
    name: 'write',
    description: 'fixture',
    parameters: {},
    parse: (r) => r,
    execute: async () => {
      await gate
      throw new Error('failed')
    },
  })
  const run = tools.execute({
    callId: 'write',
    name: 'write',
    arguments: {},
    signal: new AbortController().signal,
  })
  await vi.waitFor(() => expect(resources.hasActive('ws')).toBe(true))
  const acquired = vi.fn()
  const exclusive = resources
    .acquire({ keys: ['ws'], mode: 'exclusive', owner: 'external' })
    .then((l) => {
      acquired()
      return l
    })
  await new Promise((r) => setImmediate(r))
  expect(acquired).not.toHaveBeenCalled()
  finish()
  expect((await run).isError).toBe(true)
  ;(await exclusive).release()
  expect(resources.hasActive('ws')).toBe(false)
})
it('background job keeps the write lease after the shell tool returned until terminal', async () => {
  const { tools, resources } = registry()
  const jobs = new JobRegistry()
  let finish!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((r) => {
    finish = r
  })
  tools.register({
    name: 'bash',
    description: 'fixture',
    parameters: {},
    parse: (r) => r,
    execute: async (_args, ctx) => {
      jobs.start({
        kind: 'bash',
        label: 'background',
        retainExecutionLease: ctx.retainWorkspaceLease,
        run: () => ({ done, cancel: () => undefined }),
      })
      return 'started'
    },
  })
  await tools.execute({
    callId: 'bg',
    name: 'bash',
    arguments: {},
    signal: new AbortController().signal,
  })
  expect(resources.hasActive('ws')).toBe(true)
  const acquired = vi.fn()
  const pending = resources
    .acquire({ keys: ['ws'], mode: 'exclusive', owner: 'external' })
    .then((l) => {
      acquired()
      return l
    })
  await new Promise((r) => setImmediate(r))
  expect(acquired).not.toHaveBeenCalled()
  finish({ status: 'completed' })
  ;(await pending).release()
  await jobs.dispose()
})
it('a timeout does not release ownership while an uncooperative body still writes', async () => {
  const { tools, resources } = registry()
  let finish!: () => void
  const gate = new Promise<void>((r) => {
    finish = r
  })
  tools.register({
    name: 'bash',
    description: 'fixture',
    parameters: {},
    timeoutMs: 10,
    parse: (r) => r,
    execute: async () => {
      await gate
      return 'done'
    },
  })
  expect(
    (
      await tools.execute({
        callId: 'slow',
        name: 'bash',
        arguments: {},
        signal: new AbortController().signal,
      })
    ).isError,
  ).toBe(true)
  expect(resources.hasActive('ws')).toBe(true)
  finish()
  await vi.waitFor(() => expect(resources.hasActive('ws')).toBe(false))
})
