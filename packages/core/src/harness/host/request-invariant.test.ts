// KRN-13 (finding CORE-42): the request invariant (a model request equals
// what its session log derives) runs in development builds and the
// packaged smoke (EMPEROR_ASSERT_INVARIANT=1), not only in tests; it is off
// in production by default.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmClient } from '../../llm/client'
import type { GenerateOptions } from '../../llm/types'
import type { SandboxBackend } from '../sandbox/backend'
import { ScriptedAdapter, testRoute } from '../testing'
import { HarnessHost } from './host'

const hosts: HarnessHost[] = []
const previous = process.env.EMPEROR_ASSERT_INVARIANT
afterEach(async () => {
  if (previous === undefined) delete process.env.EMPEROR_ASSERT_INVARIANT
  else process.env.EMPEROR_ASSERT_INVARIANT = previous
  for (const host of hosts.splice(0)) await host.close()
})

const passthrough: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: [],
    runnerFailureRules: [],
  }),
}

async function host(
  options: { assertRequestInvariant?: boolean } = {},
  replies = [{ text: 'hello' }],
): Promise<HarnessHost> {
  const root = mkdtempSync(join(tmpdir(), 'emperor-krn13-invariant-'))
  const llm = new LlmClient({ adapterFor: () => new ScriptedAdapter(replies) })
  llm.setRoutes([testRoute()], 'test-route')
  const created = await HarnessHost.create({
    root,
    stateRoot: join(root, 'home'),
    stateRootSource: 'explicit',
    emperorHomePrepared: false,
    llm,
    sandboxBackend: passthrough,
    initializeMcp: false,
    startScheduler: false,
    watchSkills: false,
    ...options,
  })
  hosts.push(created)
  return created
}

/** A loop request (it names a session) that no session log derives. */
const STRAY: GenerateOptions = {
  provider: 'test-route',
  sessionId: 'no-such-session',
  messages: [],
} as unknown as GenerateOptions

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Only a thrown invariant matters here.
  }
}

describe('the request invariant outside tests (KRN-13)', () => {
  it('6 · enabled, a request the session log does not derive is refused', async () => {
    const enabled = await host({ assertRequestInvariant: true })
    await expect(drain(enabled.llm.stream(STRAY))).rejects.toThrow(
      /request invariant violated/,
    )
  })

  it('a real turn passes the invariant', async () => {
    const enabled = await host({ assertRequestInvariant: true })
    const entry = enabled.kept.sessionStore.create('t', { mode: 'chat' })
    const result = await enabled.submit({ sessionId: entry.id, content: 'hi' })
    expect(result).toMatchObject({ content: 'hello' })
  })

  it('EMPEROR_ASSERT_INVARIANT=1 turns it on', async () => {
    process.env.EMPEROR_ASSERT_INVARIANT = '1'
    const fromEnv = await host()
    await expect(drain(fromEnv.llm.stream(STRAY))).rejects.toThrow(
      /request invariant violated/,
    )
  })

  it('production default: off', async () => {
    delete process.env.EMPEROR_ASSERT_INVARIANT
    const plain = await host()
    await expect(drain(plain.llm.stream(STRAY))).resolves.toBeUndefined()
  })
})
