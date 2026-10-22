/**
 * FIX-16: the user's report through the composed Core. Every Codex subagent
 * failed with EXECUTOR_TURN_FAILED and an empty summary: Codex ran on the
 * model the user's own ~/.codex/config.toml names (`gpt-6.1-sol`), which
 * this login is not offered, and the empty text hid the 400.
 *
 * The real Codex adapter runs against the fake app-server (testing.ts),
 * which reports `gpt-6.1-sol` as its configured model, lists the account's
 * four models and refuses `gpt-6.1-sol` with the exact payload. Nothing
 * here runs the real codex or touches ~/.codex.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeApi, waitFor } from '../test-helpers'
import { CodexExecutorAdapter } from '../../harness/delegation/adapters/codex'
import { fakeCodexProcesses } from '../../harness/delegation/testing'
import type { DelegationServiceOptions } from '../../harness/delegation/service'

const VIEW = { sessionId: null }
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

const REASON =
  'Codex 不支持模型 gpt-6.1-sol（ChatGPT 账号登录）。请在「设置 › 子智能体 › Codex › 默认模型」里换一个可用的模型。'

async function scenario(defaultModel?: string) {
  const project = mkdtempSync(join(tmpdir(), 'fix16-project-'))
  const runtimes = mkdtempSync(join(tmpdir(), 'fix16-runtime-'))
  cleanups.push(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(runtimes, { recursive: true, force: true })
  })
  const { api, root } = await makeApi()
  cleanups.push(async () => {
    await api.close()
    rmSync(root, { recursive: true, force: true })
  })
  const config = api.executorConfig.read()
  for (const profile of config.profiles) {
    profile.enabled = true
    if (profile.backend === 'codex' && defaultModel)
      profile.defaultModel = defaultModel
  }
  await api.executors.configure({ expectedRevision: 0, config }, VIEW)
  for (const profile of config.profiles)
    api.host.delegationConsent.store?.grant(profile.id)
  vi.spyOn(api.executorRegistry, 'requireAvailable').mockImplementation(
    async (profile) => ({
      status: 'available',
      checkedAt: Date.now(),
      authVerified: true,
      capabilities: api.executorRegistry.capabilities(profile.backend),
    }),
  )
  const options = (
    api.delegationRuntime as unknown as { options: DelegationServiceOptions }
  ).options
  options.checkAuth = undefined
  // Signed in with a ChatGPT login, like the user: a fixture's auth.json
  // the isolated one links to (never ~/.codex).
  const login = join(runtimes, 'user-codex', 'auth.json')
  mkdirSync(join(runtimes, 'user-codex'))
  writeFileSync(
    login,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'a', refresh_token: 'r', account_id: 'x' },
    }),
    { mode: 0o600 },
  )
  options.runtime = async (_profile, id) => {
    const runtimeRoot = join(runtimes, id),
      tempRoot = join(runtimeRoot, 'tmp')
    mkdirSync(tempRoot, { recursive: true })
    return {
      runtimeRoot,
      tempRoot,
      environment: { PATH: process.env.PATH ?? '' },
      codexAuth: { source: login, isolated: join(runtimeRoot, 'auth.json') },
      billing: 'subscription' as const,
    }
  }
  options.adapters.set(
    'codex',
    new CodexExecutorAdapter({
      processes: fakeCodexProcesses({
        defaultModel: 'gpt-6.1-sol',
        models: [
          { id: 'gpt-6-astra' },
          { id: 'gpt-5.6-sol', isDefault: true },
          { id: 'gpt-5.6-terra' },
          { id: 'gpt-5.6-luna' },
        ],
        rejectModel: 'gpt-6.1-sol',
        reply: 'reviewed',
      }),
    }),
  )
  const sessionId = String(
    api.sessions.create({ title: 'p', mode: 'build', project_path: project })
      .id,
  )
  api.sessions.activate(sessionId)
  api.control.setPermissionMode('danger-full-access', sessionId)
  const record = await api.delegationRuntime.start(
    {
      rootSessionId: sessionId,
      parentAgentId: sessionId,
      taskScopeId: 'message:fix16',
      requiredForGoal: false,
      depth: 1,
      source: 'human',
    },
    {
      backend: 'codex',
      description: '审查 parser',
      prompt: 'review the parser',
      context: 'isolated',
      workspace: 'shared-readonly',
      base: 'committed',
      runInBackground: true,
      clientRequestId: 'fix16',
    },
  )
  const run = await api.delegationRuntime.wait(record.id, record.currentRunId!)
  const log = () => api.host.sessionLog(sessionId)?.events ?? []
  return { api, run, log }
}

it('FIX-16 · 3 · following the CLI, a Codex subagent runs on the model this login offers and says which', async () => {
  const { run, log } = await scenario()
  expect(run).toMatchObject({
    phase: 'completed',
    summary: 'reviewed (gpt-5.6-sol)',
    modelChoice: {
      configured: 'gpt-6.1-sol',
      used: 'gpt-5.6-sol',
      reason: 'default-unavailable',
    },
  })
  await waitFor(() =>
    JSON.stringify(log()).includes(
      "Codex's own default model gpt-6.1-sol is not available to this login; this run used gpt-5.6-sol.",
    ),
  )
}, 60_000)

it('FIX-16 · 2 · 4 · 7 · a model chosen in 设置 is used as is; its refusal says why on the row and in the parent’s notice', async () => {
  const { run, log } = await scenario('gpt-6.1-sol')
  expect(run).toMatchObject({
    phase: 'failed',
    failureCode: 'EXECUTOR_MODEL_UNSUPPORTED',
    summary: REASON,
  })
  expect(run.modelChoice).toBeUndefined()
  await waitFor(() =>
    log().some(
      (event) =>
        event.type === 'delegation/projection' &&
        (event.data as { task?: { detail?: string } }).task?.detail === REASON,
    ),
  )
  await waitFor(() => {
    const text = JSON.stringify(log())
    return (
      text.includes('execution=failed (EXECUTOR_MODEL_UNSUPPORTED)') &&
      text.includes(REASON)
    )
  })
}, 60_000)
