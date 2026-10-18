import { expect, it } from 'vitest'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, spec } from './service-test-fixture'
import { AsyncQueue } from './adapters/async-queue'
import { defaultExecutorConfig } from './config'
import type {
  ExecutorAdapter,
  ExecutorOpenInput,
  NormalizedExecutorEvent,
} from './types'

/** A session that never finishes on its own; close ends its event stream. */
function silentAdapter(opened: ExecutorOpenInput[] = []): ExecutorAdapter {
  return {
    backend: 'codex',
    async open(input) {
      opened.push(input)
      const events = new AsyncQueue<NormalizedExecutorEvent>()
      return {
        providerSessionId: 'thread-silent',
        events,
        submit: async () => ({ providerTurnId: 'turn-silent' }),
        steer: async () => {},
        answer: async () => {},
        interrupt: async () => {},
        close: async () => {
          events.end()
          return { quiescent: true }
        },
      }
    },
  }
}

it('keeps the 30 minute run limit as the only backstop for a silent turn', async () => {
  expect(defaultExecutorConfig().limits.runTimeoutMs).toBe(30 * 60_000)
  const f = fixture()
  f.options.adapters.set('codex', silentAdapter())
  f.config.limits.runTimeoutMs = 200
  const started = Date.now()
  const record = await f.service.start(f.owner, spec)
  const run = await f.service.wait(record.id, record.currentRunId!)
  expect(Date.now() - started).toBeLessThan(5000)
  expect(run.phase).toBe('cancelled')
  expect(run.failureCode).toBe('RUN_TIMEOUT')
  f.cleanup()
})

it('hands the linked Codex login to the adapter with a write grant for that one file', async () => {
  const f = fixture()
  const opened: ExecutorOpenInput[] = []
  f.options.adapters.set('codex', silentAdapter(opened))
  const home = join(f.root, 'fake-home', '.codex')
  mkdirSync(home, { recursive: true })
  const source = join(home, 'auth.json')
  writeFileSync(source, '{}', { mode: 0o600 })
  const prepare = f.options.runtime
  f.options.runtime = async (profile, id) => {
    const runtime = await prepare(profile, id)
    return {
      ...runtime,
      codexAuth: { source, isolated: join(runtime.runtimeRoot, 'auth.json') },
    }
  }
  f.config.limits.runTimeoutMs = 200
  const record = await f.service.start(f.owner, spec)
  await f.service.wait(record.id, record.currentRunId!)
  expect(opened[0]!.codexAuth?.source).toBe(source)
  expect(opened[0]!.policy.writableFiles).toEqual([realpathSync(source)])
  f.cleanup()
})
