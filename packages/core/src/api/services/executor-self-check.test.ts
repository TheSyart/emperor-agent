import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { makeApi, tmp, waitFor } from '../test-helpers'
import { invokeCoreOperation } from '../operations'
import type { CoreApi } from '../core-api'
import { fakeClaudeSdk, fakeNpmPrefix } from '../../harness/delegation/testing'
import { EXECUTOR_HEALTH_FILE } from '../../harness/delegation/executor-health'
import type { ExecutorVersionsView } from '../../harness/delegation/types'

/**
 * VER-04 · the offline self-check through Core: 重新检测 (executors.probe)
 * notes the installed version and, when it is new, checks it in the
 * background (once in 30 s); 重新检查 (executors.selfCheck) checks now. The
 * versions carry the result. Claude Code is a fake npm install and the
 * fake SDK; nothing real runs.
 */
const VIEW = { view: { sessionId: null } }
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})

async function api(sdk: ReturnType<typeof fakeClaudeSdk>) {
  const root = realpathSync(tmp('emperor-ver04-'))
  const machine = fakeNpmPrefix(root, {
    'claude-code': '2.1.310',
    codex: '0.163.0',
  })
  const home = join(root, 'executor-home')
  mkdirSync(home, { recursive: true })
  const { api, events } = await makeApi({
    root,
    extra: {
      executorHome: {
        home,
        environment: { PATH: `${machine.prefix}/bin:/usr/bin:/bin` },
        loginShell: { read: async () => ({}) },
      },
      executorVersions: { registry: null, automatic: false },
      executorSelfCheck: { automatic: true, claudeStartup: sdk.startup },
    },
  })
  cleanup.push(() => api.close())
  return { api, events, delegations: join(root, 'home', 'delegations') }
}

const enable = async (core: CoreApi) => {
  const { config } = core.executors.list()
  await invokeCoreOperation(
    core,
    'executors.configure',
    [
      {
        expectedRevision: config!.revision,
        config: {
          ...config,
          profiles: config!.profiles.map((p) => ({ ...p, enabled: true })),
        },
      },
    ],
    VIEW,
  )
}

it('9 · 重新检测 notes a new version and checks it once in the background; 重新检查 checks now', async () => {
  const sdk = fakeClaudeSdk({
    version: '2.1.310',
    plugins: [
      {
        name: 'cc-plugin-plugin-authoring',
        path: 'builtin',
        source: 'cc-plugin-plugin-authoring@builtin',
      },
    ],
  })
  const { api: core, events, delegations } = await api(sdk)
  await enable(core)
  await invokeCoreOperation(core, 'executors.probe', [
    { profileId: 'claude-default' },
  ])
  const stored = () => {
    try {
      return JSON.parse(
        readFileSync(join(delegations, EXECUTOR_HEALTH_FILE), 'utf8'),
      ).profiles['claude-default']
    } catch {
      return undefined
    }
  }
  await waitFor(() => !!stored()?.versions?.['2.1.310']?.selfCheck, 15_000)
  expect(stored()).toMatchObject({
    lastSeenVersion: '2.1.310',
    versions: {
      '2.1.310': { selfCheck: { status: 'adapted', modelCalls: 0 } },
    },
  })
  expect(sdk.launches).toHaveLength(1)
  // The settings page hears of it.
  await waitFor(
    () =>
      events.some(
        (e) =>
          e.event === 'executor_upgrade' &&
          (e.versions as ExecutorVersionsView | undefined)?.executors.some(
            (v) => v.profileId === 'claude-default' && v.selfCheck,
          ),
      ),
    10_000,
  )
  // The same version again: nothing new to check.
  await invokeCoreOperation(core, 'executors.probe', [
    { profileId: 'claude-default' },
  ])
  await new Promise((r) => setTimeout(r, 200))
  expect(sdk.launches).toHaveLength(1)

  // 重新检查: a change, so it needs the caller's view; checks now.
  await expect(
    invokeCoreOperation(core, 'executors.selfCheck', [
      { profileId: 'claude-default' },
    ]),
  ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
  await expect(
    invokeCoreOperation(
      core,
      'executors.selfCheck',
      [{ profileId: 'claude-default', reason: 'manual' }],
      VIEW,
    ),
  ).rejects.toMatchObject({ code: 'invalid_core_arguments' })
  const { selfCheck } = (await invokeCoreOperation(
    core,
    'executors.selfCheck',
    [{ profileId: 'claude-default' }],
    VIEW,
  )) as { selfCheck: { status: string; version: string } }
  expect(selfCheck).toMatchObject({ status: 'adapted', version: '2.1.310' })
  expect(sdk.launches).toHaveLength(2)
  expect(sdk.modelCalls).toBe(0)
  const versions = (await invokeCoreOperation(core, 'executors.versions', [
    {},
  ])) as ExecutorVersionsView
  expect(
    versions.executors.find((e) => e.profileId === 'claude-default'),
  ).toMatchObject({
    installed: '2.1.310',
    selfCheck: { status: 'adapted' },
    selfChecking: false,
  })
})
