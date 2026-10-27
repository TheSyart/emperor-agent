// A continued delegation's run counts toward the task it was sent in, not
// the one that started the delegation (GRP-09, GRP-11): without that, a
// conversation continued across many messages would hit the per-task run
// guard (防失控) once in its whole life.
import { expect, it, vi } from 'vitest'
import { fixture, spec } from './service-test-fixture'

/** The delegation's current run once it is not `after`, settled. */
async function settled(
  f: ReturnType<typeof fixture>,
  id: string,
  after?: string,
) {
  let runId = ''
  await vi.waitFor(() => {
    runId = f.service.inspect(id).record!.currentRunId!
    expect(runId).not.toBe(after)
  })
  return f.service.wait(id, runId)
}

it('a follow-up sent in a new task runs, past the per-task run guard', async () => {
  const f = fixture()
  f.config.limits.maxRunsPerTask = 1
  const record = await f.service.start(f.owner, spec)
  const first = await settled(f, record.id)
  expect(first.phase).toBe('completed')
  await f.service.send(record.id, {
    messageId: 'dgm-next-task',
    text: 'again, for the next message',
    delivery: 'queue',
    taskScopeId: 'message:next',
  })
  const next = await settled(f, record.id, first.id)
  expect(next.phase).toBe('completed')
  expect(next.taskScopeId).toBe('message:next')
  f.cleanup()
})

it('a follow-up in the same task still meets the guard', async () => {
  const f = fixture()
  f.config.limits.maxRunsPerTask = 1
  const record = await f.service.start(f.owner, spec)
  const first = await settled(f, record.id)
  await f.service.send(record.id, {
    messageId: 'dgm-same-task',
    text: 'again, same task',
    delivery: 'queue',
  })
  const next = await settled(f, record.id, first.id)
  expect(next.failureCode).toBe('RUN_LIMIT')
  f.cleanup()
})
