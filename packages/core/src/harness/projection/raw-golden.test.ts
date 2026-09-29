/**
 * Raw session-log golden: one real HarnessHost session recorded as the RAW
 * `SessionEvent` log the renderer conversation engine consumes (not the
 * projected UiEvents of `golden.test.ts`). The script exercises a retried
 * request, reasoning + streamed text, two tool calls in one step, an answered
 * ask_user_question, a foreground subagent, a final answer and a manual
 * compaction. The delegated child's log is recorded beside the root.
 *
 * Consumers: `desktop/src/renderer/src/conversation/*.test.ts` read the
 * fixture through fs, so a kernel log-shape change the renderer has not
 * absorbed fails on one side or the other.
 *
 * Refresh after an intentional log-shape change:
 *   UPDATE_GOLDEN=1 npx vitest run src/harness/projection/raw-golden.test.ts
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmClient } from '../../llm/client'
import type { SessionHistoryPage } from '../../session-log/history'
import { assertRequestInvariant } from '../agent/invariant'
import { HarnessHost } from '../host/host'
import type { SandboxBackend } from '../sandbox/backend'
import { replyChunks, ScriptedAdapter, testRoute } from '../testing'

const RAW_FIXTURE = join(__dirname, '__golden__', 'kernel-turn.log.json')

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
/** Wall-clock values replaced by 0 (event `time` is rewritten separately). */
const VOLATILE_KEYS = new Set(['createdAt', 'durationMs', 'digest'])
/** Fixture clock: event `time` becomes BASE_TIME + seq * TIME_STEP. */
const BASE_TIME = 1_700_000_000_000
const TIME_STEP = 100

function normalize(
  value: unknown,
  roots: readonly string[],
  ids: Map<string, string>,
): unknown {
  if (typeof value === 'string') {
    return roots
      .reduce((text, root) => text.split(root).join('<root>'), value)
      .replace(UUID, (match) => {
        if (!ids.has(match)) ids.set(match, `<id${ids.size + 1}>`)
        return ids.get(match)!
      })
  }
  if (Array.isArray(value))
    return value.map((item) => normalize(item, roots, ids))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key)) out[key] = typeof item === 'string' ? '' : 0
      else out[key] = normalize(item, roots, ids)
    }
    return out
  }
  return value
}

/** Deterministic clock: keep ordering, drop wall-clock jitter. */
function retime(page: SessionHistoryPage): SessionHistoryPage {
  return {
    ...page,
    events: page.events.map((event) => ({
      ...event,
      time: BASE_TIME + event.seq * TIME_STEP,
    })),
  }
}

describe('raw session-log golden', () => {
  it('records one full kernel session exactly as the committed fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-raw-golden-'))
    const adapter = new ScriptedAdapter([
      { error: 'upstream exploded', code: 'SERVER' },
      {
        reasoning: 'I should look first.',
        text: 'Checking.',
        tools: [
          {
            id: 'call_bash_a',
            name: 'bash',
            args: { command: 'echo alpha', description: 'print alpha' },
          },
          {
            id: 'call_bash_b',
            name: 'bash',
            args: { command: 'echo beta', description: 'print beta' },
          },
        ],
        usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 30 },
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
      {
        tools: [
          {
            id: 'call_delegate',
            name: 'subagent',
            args: {
              description: 'research',
              prompt: 'find x',
              run_in_background: false,
            },
          },
        ],
      },
      { text: 'child found x' },
      () =>
        replyChunks({
          text: 'Blue it is.',
          usage: { inputTokens: 200, outputTokens: 12 },
        }),
      { text: 'Summary: the user picked blue.' },
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
      displayContent: 'pick a color (shown)',
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
    const compacted = await host.compactNow(entry.id)
    expect(compacted.compacted).toBe(true)
    expect(adapter.remaining).toBe(0)

    const page = host.history(entry.id, { maxMessages: 1000 })!
    const children = host
      .children(entry.id)
      .map((child) => host.history(child.subagentId, { maxMessages: 1000 })!)
    const types = new Set(page.events.map((event) => event.type))
    for (const type of [
      'host/user-meta',
      'llm/retry',
      'assistant/chunk',
      'tool/call',
      'subagent/started',
      'subagent/settled',
      'compaction/summary',
    ])
      expect(types.has(type as never)).toBe(true)

    const ids = new Map<string, string>()
    // The resolved path first: on macOS the runtime reports /private/var/…
    // for a temporary root under /var/…, and Linux has no such prefix.
    const fixture = normalize(
      { root: retime(page), children: children.map(retime) },
      [realpathSync(root), root],
      ids,
    )
    const sessionPattern = new RegExp(entry.id, 'g')
    const text = `${JSON.stringify(fixture, null, 2).replace(sessionPattern, '<session>')}\n`
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(RAW_FIXTURE)) {
      writeFileSync(RAW_FIXTURE, text)
    }
    expect(text).toBe(readFileSync(RAW_FIXTURE, 'utf8'))
  })
})
