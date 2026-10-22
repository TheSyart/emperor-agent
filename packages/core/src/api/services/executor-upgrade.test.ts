import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { makeApi, tmp, waitFor } from '../test-helpers'
import { invokeCoreOperation } from '../operations'
import type { CoreApi } from '../core-api'
import { fakeNpmPrefix } from '../../harness/delegation/testing'
import type {
  ExecutorUpgradeView,
  ExecutorVersionsView,
} from '../../harness/delegation/types'

/**
 * AGT-13 · 设置 › 子智能体 › 版本 through Core's operations: Claude Code
 * installed with a fake npm in a temp prefix, npm's registry played by a
 * server on 127.0.0.1 (EMPEROR_EXECUTOR_REGISTRY_URL), `executors.upgrade`
 * after the confirmation, pushed as `executor_upgrade`, and the next
 * `executors.list` showing the new version.
 */
const VIEW = { view: { sessionId: null } }
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})

async function registry() {
  const server = createServer((req, res) => {
    if (req.url === '/@anthropic-ai/claude-code/latest') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ version: '2.1.308' }))
    }
    if (req.url === '/@openai/codex') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          'dist-tags': { latest: '0.163.0' },
          versions: { '0.153.4': {}, '0.163.0': {} },
        }),
      )
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  )
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
}

async function api(registryUrl: string | null) {
  const root = realpathSync(tmp('emperor-agt13-'))
  const machine = fakeNpmPrefix(root)
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
      executorVersions: { registry: registryUrl, automatic: false },
    },
  })
  cleanup.push(() => api.close())
  return { api, events, root, machine }
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

it('checks npm, upgrades Claude Code with its own npm and shows the new version', async () => {
  const { api: core, events, root } = await api(await registry())
  await enable(core)
  await invokeCoreOperation(core, 'executors.probe', [
    { profileId: 'claude-default' },
  ])
  const versions = (await invokeCoreOperation(core, 'executors.versions', [
    { refresh: true },
  ])) as ExecutorVersionsView
  expect(versions.error).toBeNull()
  expect(
    versions.executors.find((e) => e.profileId === 'claude-default'),
  ).toMatchObject({
    installed: '2.1.281',
    install: { kind: 'npm' },
    latest: '2.1.308',
    target: '2.1.308',
    upgrade: {
      oneClick: true,
      command: 'npm install -g @anthropic-ai/claude-code@2.1.308',
    },
  })
  // Starting it is a change: the caller's view is required.
  await expect(
    invokeCoreOperation(core, 'executors.upgrade', [
      { profileId: 'claude-default', target: '2.1.308' },
    ]),
  ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
  await invokeCoreOperation(
    core,
    'executors.upgrade',
    [{ profileId: 'claude-default', target: '2.1.308' }],
    VIEW,
  )
  let done: ExecutorUpgradeView | undefined
  await waitFor(() => {
    done = events
      .filter((e) => e.event === 'executor_upgrade' && e.upgrade)
      .map((e) => e.upgrade as ExecutorUpgradeView)
      .find((u) => u.state !== 'waiting' && u.state !== 'running')
    return !!done
  }, 15_000)
  expect(done).toMatchObject({ state: 'succeeded', installed: '2.1.308' })
  expect(
    core.executors
      .list()
      .profiles.find((p) => p.profile.id === 'claude-default')?.probe
      ?.executableVersion,
  ).toBe('2.1.308')
  expect(readFileSync(join(root, 'npm-calls'), 'utf8').trim()).toBe(
    'install -g @anthropic-ai/claude-code@2.1.308',
  )
  // Only the version offered: another release is refused.
  await expect(
    invokeCoreOperation(
      core,
      'executors.upgrade',
      [{ profileId: 'codex-default', target: '0.160.0' }],
      VIEW,
    ),
  ).rejects.toMatchObject({ code: 'EXECUTOR_UPGRADE_UNAVAILABLE' })
  await expect(
    invokeCoreOperation(
      core,
      'executors.upgrade',
      [{ profileId: 'claude-default', target: 'latest' }],
      VIEW,
    ),
  ).rejects.toThrow()
})

it('Codex 0.153.4 is offered 0.163.0, the highest release Emperor verified, and upgrades to it', async () => {
  const { api: core, events } = await api(await registry())
  await enable(core)
  await invokeCoreOperation(core, 'executors.probe', [
    { profileId: 'codex-default' },
  ])
  const versions = (await invokeCoreOperation(core, 'executors.versions', [
    { refresh: true },
  ])) as ExecutorVersionsView
  expect(
    versions.executors.find((e) => e.profileId === 'codex-default'),
  ).toMatchObject({
    installed: '0.153.4',
    latest: '0.163.0',
    verified: ['0.153', '0.163'],
    target: '0.163.0',
    unverified: null,
    upgrade: {
      oneClick: true,
      command: 'npm install -g @openai/codex@0.163.0',
    },
  })
  await invokeCoreOperation(
    core,
    'executors.upgrade',
    [{ profileId: 'codex-default', target: '0.163.0' }],
    VIEW,
  )
  let done: ExecutorUpgradeView | undefined
  await waitFor(() => {
    done = events
      .filter((e) => e.event === 'executor_upgrade' && e.upgrade)
      .map((e) => e.upgrade as ExecutorUpgradeView)
      .find((u) => u.state !== 'waiting' && u.state !== 'running')
    return !!done
  }, 15_000)
  expect(done).toMatchObject({ state: 'succeeded', installed: '0.163.0' })
})

it('offline: the versions stay unknown and nothing breaks', async () => {
  const { api: core } = await api('http://127.0.0.1:9/')
  await enable(core)
  await invokeCoreOperation(core, 'executors.probe', [
    { profileId: 'claude-default' },
  ])
  const versions = (await invokeCoreOperation(core, 'executors.versions', [
    { refresh: true },
  ])) as ExecutorVersionsView
  expect(versions.error).toBe('offline')
  expect(versions.checkedAt).toBeNull()
  expect(
    versions.executors.find((e) => e.profileId === 'claude-default'),
  ).toMatchObject({ installed: '2.1.281', latest: null, target: null })
})
