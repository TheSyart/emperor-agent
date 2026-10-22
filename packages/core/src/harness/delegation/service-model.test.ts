/**
 * FIX-16: every Codex subagent failed with EXECUTOR_TURN_FAILED and an empty
 * summary. Codex used the model the user's own `~/.codex/config.toml` named
 * (`gpt-6.1-sol`, set by the Codex desktop app), which the account's model
 * list does not offer, so each turn ended at once with a 400.
 *
 * When nobody in Emperor chose a model, Codex runs on its ChatGPT login and
 * its own default is not in the list its process offers, the run uses the
 * list's default instead, and says so. A model chosen in Emperor is used as
 * is. Without a list — or with an API key, whose models Codex's list does
 * not decide — nothing is switched: a refusal refreshes the list and
 * retries once.
 * (Why a failed turn failed: service-failure.test.ts.)
 *
 * The Codex runs go through the real adapter against the fake app-server
 * (testing.ts); nothing here runs the real codex or writes ~/.codex.
 */
import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fixture, spec } from './service-test-fixture'
import { CodexExecutorAdapter } from './adapters/codex'
import {
  fakeCodexProcesses,
  fakeCodexRequests,
  type FakeCodexOptions,
} from './testing'
import type { DelegationStart, NormalizedExecutorEvent } from './types'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const REASON =
  'Codex 不支持模型 gpt-6.1-sol（ChatGPT 账号登录）。请在「设置 › 子智能体 › Codex › 默认模型」里换一个可用的模型。'
/** The account's list as Emperor cached it for the user. */
const ACCOUNT_MODELS = [
  { id: 'gpt-6-astra' },
  { id: 'gpt-5.6-sol', isDefault: true },
  { id: 'gpt-5.6-terra' },
  { id: 'gpt-5.6-luna' },
]

/**
 * The service with the real Codex adapter on the fake app-server, signed in
 * with a ChatGPT login (the isolated auth.json links to a fixture's file),
 * or with an API key.
 */
function withFakeCodex(
  options: FakeCodexOptions,
  login: 'chatgpt' | 'api-key' = 'chatgpt',
) {
  const f = fixture()
  f.options.adapters.set(
    'codex',
    new CodexExecutorAdapter({ processes: fakeCodexProcesses(options) }),
  )
  if (login === 'chatgpt') {
    const home = join(f.root, 'user-home', '.codex'),
      source = join(home, 'auth.json')
    mkdirSync(home, { recursive: true })
    writeFileSync(
      source,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'a', refresh_token: 'r', account_id: 'x' },
      }),
      { mode: 0o600 },
    )
    const prepare = f.options.runtime
    f.options.runtime = async (profile, id) => {
      const runtime = await prepare(profile, id)
      return {
        ...runtime,
        codexAuth: { source, isolated: join(runtime.runtimeRoot, 'auth.json') },
      }
    }
  }
  cleanups.push(async () => {
    await f.service.shutdown()
    f.cleanup()
  })
  return f
}

async function settle(
  f: ReturnType<typeof fixture>,
  start: Partial<DelegationStart> = {},
) {
  const record = await f.service.start(f.owner, { ...spec, ...start })
  const run = await f.service.wait(record.id, record.currentRunId!)
  const state = f.service.inspect(record.id)
  return {
    record: state.record!,
    run,
    state,
    notice: Object.values(state.outbox).find((n) => n.runId === run.id),
    requests: fakeCodexRequests(join(f.root, 'runtime', record.id, 'tmp')),
    transcript: readFileSync(
      join(f.root, 'conversations', record.id, 'runs', run.id + '.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NormalizedExecutorEvent),
  }
}

const turnStarts = (requests: ReturnType<typeof fakeCodexRequests>) =>
  requests.filter((r) => r.method === 'turn/start')

it('FIX-16 · 3 · Codex’s own default is not offered to this login: the run uses the list’s default, and says so', async () => {
  const f = withFakeCodex({
    defaultModel: 'gpt-6.1-sol',
    models: ACCOUNT_MODELS,
    rejectModel: 'gpt-6.1-sol',
  })
  const { run, requests, notice } = await settle(f)
  expect(run).toMatchObject({
    phase: 'completed',
    summary: 'done (gpt-5.6-sol)',
    modelChoice: {
      configured: 'gpt-6.1-sol',
      used: 'gpt-5.6-sol',
      reason: 'default-unavailable',
    },
  })
  expect(requests.find((r) => r.method === 'thread/start')?.model).toBeNull()
  expect(requests.filter((r) => r.method === 'model/list')).toEqual([
    { method: 'model/list', model: null, includeHidden: true },
  ])
  expect(turnStarts(requests).map((r) => r.model)).toEqual(['gpt-5.6-sol'])
  expect(notice?.text).toContain('gpt-6.1-sol')
  expect(notice?.text).toContain('gpt-5.6-sol')
})

it('FIX-16 · 3 · a list without a default flag gives its first model', async () => {
  const f = withFakeCodex({
    defaultModel: 'gpt-6.1-sol',
    models: ACCOUNT_MODELS.map(({ id }) => ({ id })),
    rejectModel: 'gpt-6.1-sol',
  })
  const { run, requests } = await settle(f)
  expect(run.phase).toBe('completed')
  expect(run.modelChoice?.used).toBe('gpt-6-astra')
  expect(turnStarts(requests).map((r) => r.model)).toEqual(['gpt-6-astra'])
})

it('FIX-16 · 3 · a default the list offers, even hidden from the picker, is used as it is', async () => {
  const f = withFakeCodex({
    defaultModel: 'gpt-5.5-legacy',
    models: [...ACCOUNT_MODELS, { id: 'gpt-5.5-legacy', hidden: true }],
  })
  const { run, requests } = await settle(f)
  expect(run).toMatchObject({
    phase: 'completed',
    summary: 'done (gpt-5.5-legacy)',
  })
  expect(run.modelChoice).toBeUndefined()
  expect(turnStarts(requests).map((r) => r.model)).toEqual([null])
})

it.each([
  ['the task', { model: 'gpt-6.1-sol' }, undefined],
  ['设置 › 子智能体 › Codex › 默认模型', {}, 'gpt-6.1-sol'],
] as const)(
  'FIX-16 · 4 · a model chosen in %s is used as is: no list, no switch, no retry',
  async (_where, start, defaultModel) => {
    const f = withFakeCodex({
      defaultModel: 'gpt-5.6-sol',
      models: ACCOUNT_MODELS,
      rejectModel: 'gpt-6.1-sol',
    })
    if (defaultModel) f.config.profiles[1]!.defaultModel = defaultModel
    const { run, requests } = await settle(f, start)
    expect(run).toMatchObject({
      phase: 'failed',
      failureCode: 'EXECUTOR_MODEL_UNSUPPORTED',
      summary: REASON,
    })
    expect(run.modelChoice).toBeUndefined()
    expect(requests.find((r) => r.method === 'thread/start')?.model).toBe(
      'gpt-6.1-sol',
    )
    expect(requests.some((r) => r.method === 'model/list')).toBe(false)
    expect(turnStarts(requests)).toHaveLength(1)
  },
)

it('FIX-16 · 4 · a chosen model the list does not offer, but the account accepts, just runs', async () => {
  const f = withFakeCodex({
    defaultModel: 'gpt-6.1-sol',
    models: ACCOUNT_MODELS,
  })
  f.config.profiles[1]!.defaultModel = 'team/coder-v2'
  const { run, requests } = await settle(f)
  expect(run).toMatchObject({
    phase: 'completed',
    summary: 'done (team/coder-v2)',
  })
  expect(run.modelChoice).toBeUndefined()
  expect(requests.some((r) => r.method === 'model/list')).toBe(false)
})

it('FIX-16 · 4 · with an API key the configured default is used as is: Codex’s list does not decide which models it can run', async () => {
  const f = withFakeCodex(
    { defaultModel: 'gpt-4.1', models: ACCOUNT_MODELS },
    'api-key',
  )
  const { run, requests } = await settle(f)
  expect(run).toMatchObject({ phase: 'completed', summary: 'done (gpt-4.1)' })
  expect(run.modelChoice).toBeUndefined()
  expect(requests.some((r) => r.method === 'model/list')).toBe(false)
})

it('FIX-16 · 5 · with an API key a refused default is still retried once on a model the list offers', async () => {
  const f = withFakeCodex(
    {
      defaultModel: 'gpt-6.1-sol',
      models: ACCOUNT_MODELS,
      rejectModel: 'gpt-6.1-sol',
    },
    'api-key',
  )
  const { run, requests } = await settle(f)
  expect(turnStarts(requests).map((r) => r.model)).toEqual([
    null,
    'gpt-5.6-sol',
  ])
  expect(run).toMatchObject({
    phase: 'completed',
    modelChoice: { used: 'gpt-5.6-sol', reason: 'retried' },
  })
})

it('FIX-16 · 5 · without a list nothing is switched; the refusal refreshes the list and retries once', async () => {
  const f = withFakeCodex({
    defaultModel: 'gpt-6.1-sol',
    models: ACCOUNT_MODELS,
    rejectModel: 'gpt-6.1-sol',
    modelListFailures: 1,
  })
  const { run, requests, transcript, record } = await settle(f)
  expect(turnStarts(requests).map((r) => r.model)).toEqual([
    null,
    'gpt-5.6-sol',
  ])
  expect(requests.filter((r) => r.method === 'model/list')).toHaveLength(2)
  expect(run).toMatchObject({
    phase: 'completed',
    summary: 'done (gpt-5.6-sol)',
    modelChoice: {
      configured: 'gpt-6.1-sol',
      used: 'gpt-5.6-sol',
      reason: 'retried',
    },
  })
  expect(run.failureCode).toBeUndefined()
  // The refused turn stays in the run's history, then the retried one.
  expect(
    transcript
      .filter((e) => e.type === 'turn_finished')
      .map((e) => (e as { status: string }).status),
  ).toEqual(['failed', 'completed'])
  expect(run.providerTurnId).toBe('turn-2')
  expect(record.providerSessionId).toBe('thread-fake')
})

it('FIX-16 · 5 · when the list stays unknown the refusal stands, with its reason, after one turn', async () => {
  const f = withFakeCodex({
    defaultModel: 'gpt-6.1-sol',
    models: ACCOUNT_MODELS,
    rejectModel: 'gpt-6.1-sol',
    modelListFailures: 99,
  })
  const { run, requests } = await settle(f)
  expect(turnStarts(requests).map((r) => r.model)).toEqual([null])
  expect(requests.filter((r) => r.method === 'model/list')).toHaveLength(2)
  expect(run).toMatchObject({
    phase: 'failed',
    failureCode: 'EXECUTOR_MODEL_UNSUPPORTED',
    summary: REASON,
  })
  expect(run.modelChoice).toBeUndefined()
})

// AGT-13: the same rules on Codex 0.163, whose fake app-server speaks the
// 0.163 protocol (its user agent, rootTurnId, partial answers).
it('AGT-13 · on Codex 0.163 the user’s own default, when the login offers it, runs as is', async () => {
  const f = withFakeCodex({
    version: '0.163.0',
    defaultModel: 'gpt-6.1-sol',
    models: [{ id: 'gpt-6.1-sol', isDefault: true }, ...ACCOUNT_MODELS],
  })
  const { run, requests } = await settle(f)
  expect(run).toMatchObject({
    phase: 'completed',
    summary: 'done (gpt-6.1-sol)',
  })
  expect(run.modelChoice).toBeUndefined()
  expect(requests.filter((r) => r.method === 'model/list')).toHaveLength(1)
  expect(turnStarts(requests).map((r) => r.model)).toEqual([null])
})

it('AGT-13 · on Codex 0.163 a default the login does not offer still gives way to the list’s default', async () => {
  const f = withFakeCodex({
    version: '0.163.0',
    defaultModel: 'gpt-6.1-sol',
    models: ACCOUNT_MODELS,
    rejectModel: 'gpt-6.1-sol',
  })
  const { run, requests } = await settle(f)
  expect(run).toMatchObject({
    phase: 'completed',
    summary: 'done (gpt-5.6-sol)',
    modelChoice: { configured: 'gpt-6.1-sol', used: 'gpt-5.6-sol' },
  })
  expect(turnStarts(requests).map((r) => r.model)).toEqual(['gpt-5.6-sol'])
})

it('AGT-13 · on Codex 0.163 an answer split into partial answers is the run’s whole summary', async () => {
  const f = withFakeCodex({
    version: '0.163.0',
    defaultModel: 'gpt-6.1-sol',
    models: [{ id: 'gpt-6.1-sol', isDefault: true }],
    answer: [
      { text: 'Reading the parser first.', phase: 'commentary' },
      { text: 'The parser drops trailing commas.', phase: 'partial_answer' },
      { text: 'Fixed; all 42 tests pass.', phase: 'final_answer' },
    ],
  })
  const { run } = await settle(f)
  expect(run).toMatchObject({
    phase: 'completed',
    summary: 'The parser drops trailing commas.\n\nFixed; all 42 tests pass.',
  })
})
