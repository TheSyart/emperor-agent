import { afterEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { makeApi, tmp } from '../test-helpers'
import { invokeCoreOperation } from '../operations'
import { createLocalKeySealer } from '../../security/secret-sealer'
import type { CoreApi } from '../core-api'
import { fakeClaude, fakeClaudeCalls } from '../../harness/delegation/testing'

/**
 * AGT-12 · 设置 › 子智能体 › Claude Code: the sign-in is claude's own.
 * The settings probe runs `claude auth status` in the run's environment;
 * 登录 Claude Code opens macOS Terminal on `claude auth login`; 退出登录
 * runs `claude auth logout`; only an API key is ever saved in Emperor. A
 * fake claude and a temporary home stand in for the real ones.
 */
const VIEW = { view: { sessionId: null } }
const API_KEY = 'sk-ant-api03-fixture-settings-key-7f3e'
const opened: string[] = []
const cores: CoreApi[] = []
afterEach(async () => {
  opened.length = 0
  for (const core of cores.splice(0)) await core.close()
})

async function api(
  options: { version?: string; before?: (root: string) => void } = {},
) {
  const root = tmp('emperor-agt12-')
  const home = join(root, 'executor-home'),
    bin = join(root, 'executor-bin')
  mkdirSync(home, { recursive: true })
  const executable = fakeClaude(bin, {
    ...(options.version ? { version: options.version } : {}),
  })
  options.before?.(root)
  const { api } = await makeApi({
    root,
    extra: {
      executorHome: {
        home,
        environment: { PATH: `${bin}:/usr/bin:/bin` },
        loginShell: { read: async () => ({}) },
        openTerminal: async (script: string) => {
          opened.push(script)
        },
      },
    },
  })
  cores.push(api)
  const config = join(api.paths.delegationsRoot, 'claude-code', 'config')
  return { core: api, root, executable, config }
}

it('4 · the settings probe says what claude auth status says, in the run’s own folder', async () => {
  const { core, config } = await api()
  // Signed out: 需要登录, with claude's own words.
  expect(
    await core.executors.probe({ profileId: 'claude-default' }),
  ).toMatchObject({
    status: 'needs_auth',
    diagnostic: 'AUTH_REQUIRED',
    localAuthChecked: false,
    auth: { method: 'none', source: null },
  })
  const status = fakeClaudeCalls(config).at(-1)!
  expect(status.args).toBe('auth status')
  expect(status.env.CLAUDE_CONFIG_DIR).toBe(config)
  // Signed in (as `claude auth login` leaves it).
  writeFileSync(join(config, 'fake-signed-in'), 'claude.ai')
  const signedIn = await core.executors.probe({ profileId: 'claude-default' })
  expect(signedIn).toMatchObject({
    status: 'available',
    localAuthChecked: true,
    auth: {
      method: 'claude.ai',
      email: 'ada@example.com',
      organization: 'Ada Lab',
    },
  })
  expect(JSON.stringify(signedIn)).not.toMatch(/sk-ant|orgId|1111-2222/)
  // An API key outranks it; the probe says which one is in effect.
  await invokeCoreOperation(
    core,
    'executors.setCredential',
    [{ profileId: 'claude-default', kind: 'api-key', token: API_KEY }],
    VIEW,
  )
  expect(
    await core.executors.probe({ profileId: 'claude-default' }),
  ).toMatchObject({
    status: 'available',
    auth: { method: 'api_key', source: 'emperor', last4: '7f3e' },
  })
  // A claude too old for auth status.
  const old = await api({ version: '2.1.40' })
  expect(
    await old.core.executors.probe({ profileId: 'claude-default' }),
  ).toMatchObject({ status: 'incompatible', requiredVersion: '>= 2.1.79' })
})

it('5 · 登录 Claude Code opens macOS Terminal on claude auth login; 退出登录 runs claude auth logout', async () => {
  const { core, executable, config } = await api()
  // A renderer call without a view is refused like any other change.
  await expect(
    invokeCoreOperation(core, 'executors.signIn', [
      { profileId: 'claude-default', method: 'claude-ai' },
    ]),
  ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
  expect(
    await invokeCoreOperation(
      core,
      'executors.signIn',
      [{ profileId: 'claude-default', method: 'claude-ai' }],
      VIEW,
    ),
  ).toEqual({ opened: true })
  expect(opened).toHaveLength(1)
  const script = readFileSync(opened[0]!, 'utf8')
  expect(script).toContain(`export CLAUDE_CONFIG_DIR='${config}'`)
  expect(script).toContain(`'${executable}' auth login`)
  // What Terminal runs: claude signs in, and the next check sees it.
  await promisify(execFile)('/bin/bash', [opened[0]!], {
    env: { PATH: '/usr/bin:/bin' },
  })
  expect(
    await core.executors.probe({ profileId: 'claude-default' }),
  ).toMatchObject({ status: 'available', auth: { method: 'claude.ai' } })
  // Console (API billing).
  await invokeCoreOperation(
    core,
    'executors.signIn',
    [{ profileId: 'claude-default', method: 'console' }],
    VIEW,
  )
  expect(readFileSync(opened[1]!, 'utf8')).toContain(
    `'${executable}' auth login --console`,
  )
  // 退出登录.
  const out = await invokeCoreOperation(
    core,
    'executors.signOut',
    [{ profileId: 'claude-default' }],
    VIEW,
  )
  expect(out).toMatchObject({
    probe: { status: 'needs_auth', auth: { method: 'none' } },
  })
  expect(fakeClaudeCalls(config).map((c) => c.args)).toContain('auth logout')
  // Codex keeps its own login.
  await expect(
    invokeCoreOperation(
      core,
      'executors.signIn',
      [{ profileId: 'codex-default', method: 'claude-ai' }],
      VIEW,
    ),
  ).rejects.toThrow('UNSUPPORTED')
})

it('使用 API Key: sealed, shown only as 末 4 位; a subscription token is refused', async () => {
  const { core } = await api()
  await expect(
    invokeCoreOperation(core, 'executors.setCredential', [
      { profileId: 'claude-default', kind: 'api-key', token: API_KEY },
    ]),
  ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
  const saved = await invokeCoreOperation(
    core,
    'executors.setCredential',
    [{ profileId: 'claude-default', kind: 'api-key', token: API_KEY }],
    VIEW,
  )
  expect(JSON.stringify(saved)).not.toContain(API_KEY)
  expect(JSON.stringify(core.executors.list())).not.toContain(API_KEY)
  const file = join(core.paths.delegationsRoot, 'credentials.json')
  expect(readFileSync(file, 'utf8')).toContain('el1:')
  expect(readFileSync(file, 'utf8')).not.toContain(API_KEY)
  // No more 订阅令牌: the old kind and a Claude.ai token are refused.
  await expect(
    invokeCoreOperation(
      core,
      'executors.setCredential',
      [
        {
          profileId: 'claude-default',
          kind: 'oauth-token',
          token: 'sk-ant-oat01-a-subscription-token',
        },
      ],
      VIEW,
    ),
  ).rejects.toThrow()
  await expect(
    invokeCoreOperation(
      core,
      'executors.setCredential',
      [
        {
          profileId: 'claude-default',
          kind: 'api-key',
          token: 'sk-ant-oat01-a-subscription-token',
        },
      ],
      VIEW,
    ),
  ).rejects.toThrow('UNSUPPORTED')
  // Removing it goes back to claude's own sign-in (here: none).
  const cleared = await invokeCoreOperation(
    core,
    'executors.clearCredential',
    [{ profileId: 'claude-default' }],
    VIEW,
  )
  expect(cleared).toMatchObject({
    probe: { status: 'needs_auth', auth: { source: null, method: 'none' } },
  })
  expect(readFileSync(file, 'utf8')).not.toContain('claude-default')
})

it('6 · an upgrade deletes the stored Claude OAuth token and the settings page says so once', async () => {
  const { core } = await api({
    before: (root) => {
      const delegations = join(root, 'home', 'delegations')
      mkdirSync(delegations, { recursive: true })
      // An earlier build's sealed 设置令牌, under the same local key.
      const sealer = createLocalKeySealer(join(root, 'home'))
      writeFileSync(
        join(delegations, 'credentials.json'),
        JSON.stringify({
          schemaVersion: 1,
          tokens: {
            'claude-default': {
              kind: 'oauth-token',
              value: sealer.seal(
                'sk-ant-oat01-saved-by-0-2-preview',
                'delegations/credentials.json#claude-default.oauth-token',
              ),
              last4: 'view',
            },
          },
        }),
      )
    },
  })
  const file = join(core.paths.delegationsRoot, 'credentials.json')
  expect(readFileSync(file, 'utf8')).not.toContain('claude-default')
  expect(readFileSync(file, 'utf8')).not.toContain('el1:')
  expect(core.executors.list()).toMatchObject({ signInNotice: true })
  await expect(
    invokeCoreOperation(core, 'executors.dismissNotice', [
      { notice: 'claude-sign-in' },
    ]),
  ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
  await invokeCoreOperation(
    core,
    'executors.dismissNotice',
    [{ notice: 'claude-sign-in' }],
    VIEW,
  )
  expect(core.executors.list()).toMatchObject({ signInNotice: false })
})
