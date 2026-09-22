/**
 * Projection golden: one real HarnessHost turn (reasoning, text, a shell tool
 * call, an answered ask_user_question, final text) projected from the session
 * log. The normalized events are the shared fixture the renderer's
 * chatProjection golden test consumes, so a projector change that the
 * renderer has not absorbed fails on one side or the other.
 *
 * Refresh after an intentional projector change:
 *   UPDATE_GOLDEN=1 npx vitest run src/harness/projection/golden.test.ts
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmClient } from '../../llm/client'
import { assertRequestInvariant } from '../agent/invariant'
import { HarnessHost } from '../host/host'
import type { SandboxBackend } from '../sandbox/backend'
import { replyChunks, ScriptedAdapter, testRoute } from '../testing'

const GOLDEN_FIXTURE = join(__dirname, '__golden__', 'kernel-turn.events.json')

const passthroughBackend: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: [],
    runnerFailureRules: [],
  }),
}

const hosts: HarnessHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const VOLATILE_KEYS = new Set([
  'ts',
  'created_at',
  'updated_at',
  'started_at',
  'finished_at',
  'duration_ms',
  'durationMs',
  'elapsed_ms',
  'elapsedMs',
])

/** Replace ids, temp paths and clock values with stable placeholders. */
function normalize(
  value: unknown,
  root: string,
  ids: Map<string, string>,
): unknown {
  if (typeof value === 'string') {
    return value
      .split(root)
      .join('<root>')
      .replace(UUID, (match) => {
        if (!ids.has(match)) ids.set(match, `<id${ids.size + 1}>`)
        return ids.get(match)!
      })
  }
  if (Array.isArray(value))
    return value.map((item) => normalize(item, root, ids))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key) && typeof item === 'number') out[key] = 0
      else out[key] = normalize(item, root, ids)
    }
    return out
  }
  return value
}

describe('projection golden', () => {
  it('projects one full kernel turn exactly as the committed fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-golden-'))
    const adapter = new ScriptedAdapter([
      {
        reasoning: 'I should look first.',
        text: 'Checking.',
        tools: [
          {
            id: 'call_bash',
            name: 'bash',
            args: { command: 'echo golden', description: 'print a word' },
          },
        ],
      },
      {
        tools: [
          {
            id: 'call_ask',
            name: 'ask_user_question',
            args: {
              questions: [
                {
                  id: 'color',
                  question: 'Which color?',
                  options: [{ label: 'red' }, { label: 'blue' }],
                },
              ],
            },
          },
        ],
      },
      () => replyChunks({ text: 'Blue it is.' }),
    ])
    const ref: { host?: HarnessHost } = {}
    const llm = new LlmClient({
      adapterFor: () => adapter,
      onRequest: (request) => {
        assertRequestInvariant(request, (id) => ref.host?.sessionLog(id))
      },
    })
    llm.setRoutes([testRoute()], 'test-route')
    const live: Array<Record<string, unknown>> = []
    const host = await HarnessHost.create({
      root,
      stateRoot: join(root, 'home'),
      stateRootSource: 'explicit',
      emperorHomePrepared: false,
      llm,
      sandboxBackend: passthroughBackend,
      initializeMcp: false,
      eventSink: (event) => {
        live.push(event)
      },
    })
    ref.host = host
    hosts.push(host)
    const entry = host.kept.sessionStore.create('golden', { mode: 'chat' })
    const submitted = host.submit({
      sessionId: entry.id,
      content: 'pick a color',
      clientMessageId: 'client-1',
    })
    const deadline = Date.now() + 5000
    while (!live.some((event) => event.event === 'ask_request')) {
      if (Date.now() > deadline) throw new Error('ask_request never arrived')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const ask = live.find((event) => event.event === 'ask_request')!
      .interaction as { id: string }
    host.answerInteraction(ask.id, { color: { choice: 'blue', freeform: '' } })
    await submitted

    const replayed = host.replay(entry.id).events
    expect(replayed).toEqual(live.filter((event) => Number(event.seq) > 0))

    const ids = new Map<string, string>()
    const normalized = normalize(
      replayed.map((event) => ({ ...event, session_id: '<session>' })),
      root,
      ids,
    ) as Array<Record<string, unknown>>
    const sessionPattern = new RegExp(entry.id, 'g')
    const text = `${JSON.stringify(normalized, null, 2).replace(sessionPattern, '<session>')}\n`
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN_FIXTURE)) {
      writeFileSync(GOLDEN_FIXTURE, text)
    }
    expect(text).toBe(readFileSync(GOLDEN_FIXTURE, 'utf8'))
  })
})
