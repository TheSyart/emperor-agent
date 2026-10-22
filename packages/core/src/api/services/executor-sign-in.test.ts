import { afterEach, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { makeApi, passthroughBackend, tmp, waitFor } from '../test-helpers'
import { invokeCoreOperation } from '../operations'
import { createLocalKeySealer } from '../../security/secret-sealer'
import type { CoreApi } from '../core-api'
import {
  FAKE_LOGIN_CODE,
  FAKE_LOGIN_LINK,
  fakeClaude,
  fakeClaudeCalls,
  fakeLoginProcess,
  processAlive,
} from '../../harness/delegation/testing'
import { setCoreLogSink, type LogLine } from '../../util/log'

/**
 * AGT-12 · 设置 › 子智能体 › Claude Code: the sign-in is claude's own.
 * The settings probe runs `claude auth status` in the run's environment;
 * 退出登录 runs `claude auth logout`; only an API key is ever saved in
 * Emperor. FIX-11 · 登录 Claude Code: Core runs the installed claude's own
 * `claude auth login` itself (no Terminal), pushes `executor_sign_in` as it
 * goes, and never reads what claude prints. A fake claude and a temporary
 * home stand in for the real ones.
 */
const VIEW = { view: { sessionId: null } }
const API_KEY = 'sk-ant-api03-fixture-settings-key-7f3e'
const cores: CoreApi[] = []
afterEach(async () => {
  setCoreLogSink(null)
  vi.restoreAllMocks()
  for (const core of cores.splice(0)) await core.close()
})

async function api(
  options: {
    version?: string
    before?: (root: string) => void
    environment?: Record<string, string>
    signInTimeoutMs?: number
  } = {},
) {
  const root = tmp('emperor-agt12-')
  const home = join(root, 'executor-home'),
    bin = join(root, 'executor-bin')
  mkdirSync(home, { recursive: true })
  const executable = fakeClaude(bin, {
    ...(options.version ? { version: options.version } : {}),
  })
  options.before?.(root)
  const confined: string[][] = []
  const { api, events } = await makeApi({
    root,
    extra: {
      // Records what goes through the sandbox: the sign-in must not.
      sandboxBackend: {
        confine: (argv, policy) => {
          confined.push([...argv])
          return passthroughBackend.confine(argv, policy)
        },
      },
      executorHome: {
        home,
        environment: { PATH: `${bin}:/usr/bin:/bin`, ...options.environment },
        loginShell: { read: async () => ({}) },
        ...(options.signInTimeoutMs
          ? { signInTimeoutMs: options.signInTimeoutMs }
          : {}),
      },
    },
  })
  cores.push(api)
  const config = join(api.paths.delegationsRoot, 'claude-code', 'config')
  const signIns = () =>
    events
      .filter((event) => event.event === 'executor_sign_in')
      .map(
        (event) =>
          event as unknown as {
            signIn: Record<string, unknown>
            probe?: Record<string, unknown>
          },
      )
  /** The first pushed sign-in in `state` (and with `reason`, if given). */
  const ended = async (state: string, reason?: string) => {
    const match = (event: ReturnType<typeof signIns>[number]) =>
      event.signIn.state === state &&
      (reason === undefined || event.signIn.reason === reason)
    await waitFor(() => signIns().some(match), 10_000)
    return signIns().find(match)!
  }
  return {
    core: api,
    root,
    executable,
    config,
    events,
    signIns,
    ended,
    confined,
  }
}

const logins = (config: string) =>
  fakeClaudeCalls(config).filter((call) => call.args.startsWith('auth login'))

async function gone(pids: Array<number | undefined>, ms = 3000) {
  const until = Date.now() + ms
  while (pids.some((pid) => pid && processAlive(pid)) && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 25))
  return pids.every((pid) => !pid || !processAlive(pid))
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

it('5 · 退出登录 runs claude auth logout; Codex keeps its own login', async () => {
  const { core, config } = await api()
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'fake-signed-in'), 'claude.ai')
  await expect(
    invokeCoreOperation(core, 'executors.signOut', [
      { profileId: 'claude-default' },
    ]),
  ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
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
  for (const operation of [
    'executors.signIn',
    'executors.cancelSignIn',
  ] as const)
    await expect(
      invokeCoreOperation(
        core,
        operation,
        [
          operation === 'executors.signIn'
            ? { profileId: 'codex-default', method: 'claude-ai' }
            : ({ profileId: 'codex-default' } as never),
        ] as never,
        VIEW,
      ),
    ).rejects.toThrow('UNSUPPORTED')
})

it('FIX-11 · 1 · 登录 Claude Code starts claude auth login from Core: the dedicated folders, no credentials, no sandbox, no Terminal', async () => {
  const { core, executable, config, confined, ended } = await api({
    environment: {
      ANTHROPIC_AUTH_TOKEN: 'ambient-gateway-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-ambient-must-not-cross',
    },
  })
  await invokeCoreOperation(
    core,
    'executors.setCredential',
    [{ profileId: 'claude-default', kind: 'api-key', token: API_KEY }],
    VIEW,
  )
  // A renderer call without a view is refused like any other change.
  await expect(
    invokeCoreOperation(core, 'executors.signIn', [
      { profileId: 'claude-default', method: 'claude-ai' },
    ]),
  ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
  await expect(
    invokeCoreOperation(core, 'executors.cancelSignIn', [
      { profileId: 'claude-default' },
    ]),
  ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' })
  confined.length = 0
  const started = await invokeCoreOperation(
    core,
    'executors.signIn',
    [{ profileId: 'claude-default', method: 'claude-ai' }],
    VIEW,
  )
  expect(started).toMatchObject({
    signIn: {
      profileId: 'claude-default',
      method: 'claude-ai',
      state: 'running',
    },
  })
  await ended('signed-in')
  const [login] = logins(config)
  expect(login!.args).toBe('auth login')
  expect(login!.env).toMatchObject({
    CLAUDE_CONFIG_DIR: config,
    HOME: join(core.paths.delegationsRoot, 'claude-code', 'home'),
    XDG_CONFIG_HOME: join(
      core.paths.delegationsRoot,
      'claude-code',
      'home',
      '.config',
    ),
  })
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ])
    expect(login!.env[key], key).toBeUndefined()
  // The installed claude, as the leader of its own process group, outside
  // the sandbox (it opens the browser and listens on localhost)…
  const { pid, pgid } = fakeLoginProcess(config)
  expect(pgid).toBe(pid)
  expect(confined.some((argv) => argv.includes('login'))).toBe(false)
  expect(confined.some((argv) => argv.includes(executable))).toBe(true)
  // …and nothing for Terminal: no script, no folder for one.
  expect(
    existsSync(join(core.paths.delegationsRoot, 'claude-code', 'sign-in')),
  ).toBe(false)
  // Console (API billing).
  writeFileSync(join(config, 'fake-signed-in'), '')
  await invokeCoreOperation(
    core,
    'executors.signIn',
    [{ profileId: 'claude-default', method: 'console' }],
    VIEW,
  )
  await waitFor(() => logins(config).length === 2, 10_000)
  expect(logins(config)[1]!.args).toBe('auth login --console')
})

it('FIX-11 · 2 · when claude auth login exits 0, Core checks again and pushes the signed-in state', async () => {
  const { core, signIns, ended } = await api()
  expect(
    await core.executors.probe({ profileId: 'claude-default' }),
  ).toMatchObject({ status: 'needs_auth' })
  await invokeCoreOperation(
    core,
    'executors.signIn',
    [{ profileId: 'claude-default', method: 'claude-ai' }],
    VIEW,
  )
  expect(signIns()[0]).toMatchObject({ signIn: { state: 'running' } })
  expect(core.executors.list()).toMatchObject({
    signIn: { state: 'running', profileId: 'claude-default' },
  })
  const done = await ended('signed-in')
  expect(done.signIn).toMatchObject({
    profileId: 'claude-default',
    method: 'claude-ai',
  })
  expect(done.signIn.command).toBeUndefined()
  // The new state comes with it: no 重新检测 needed.
  expect(done.probe).toMatchObject({
    status: 'available',
    auth: { method: 'claude.ai', email: 'ada@example.com' },
  })
  expect(core.executors.list()).toMatchObject({ signIn: null })
  expect(
    core.executors
      .list()
      .profiles.find((p) => p.profile.id === 'claude-default')?.probe,
  ).toMatchObject({ status: 'available' })
})

it('FIX-11 · 3 · a failed or timed-out sign-in says why and offers the same sign-in as one Terminal command', async () => {
  const { core, executable, config, ended } = await api()
  await core.executors.probe({ profileId: 'claude-default' })
  writeFileSync(join(config, 'fake-login-mode'), 'fail')
  await invokeCoreOperation(
    core,
    'executors.signIn',
    [{ profileId: 'claude-default', method: 'claude-ai' }],
    VIEW,
  )
  const failed = await ended('failed')
  expect(failed.signIn).toMatchObject({ reason: 'exit', exitCode: 3 })
  const command = failed.signIn.command as string
  expect(
    command.startsWith(
      'env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN ' +
        `CLAUDE_CONFIG_DIR='${config}' ` +
        `HOME='${join(core.paths.delegationsRoot, 'claude-code', 'home')}' ` +
        `XDG_CONFIG_HOME='${join(core.paths.delegationsRoot, 'claude-code', 'home', '.config')}' ` +
        `XDG_CACHE_HOME='${join(core.paths.delegationsRoot, 'claude-code', 'home', '.cache')}' ` +
        // FIX-19: Emperor's security first on the PATH claude gets.
        `PATH='${join(core.paths.delegationsRoot, 'claude-code', 'bin')}:`,
    ),
  ).toBe(true)
  expect(command.endsWith(`' '${executable}' auth login`)).toBe(true)
  expect(core.executors.list()).toMatchObject({ signIn: null })

  // claude ended without an error but is still not signed in.
  writeFileSync(join(config, 'fake-login-mode'), 'signed-out')
  await invokeCoreOperation(
    core,
    'executors.signIn',
    [{ profileId: 'claude-default', method: 'console' }],
    VIEW,
  )
  const signedOut = await ended('failed', 'not-signed-in')
  expect(signedOut.signIn).toMatchObject({ method: 'console', exitCode: 0 })
  expect(signedOut.signIn.command).toMatch(/ auth login --console$/)
  expect(signedOut.probe).toMatchObject({ status: 'needs_auth' })
})

it('FIX-11 · 3 · ten minutes (here: a moment) without a sign-in stop claude and show the fallback', async () => {
  const { core, config, ended } = await api({ signInTimeoutMs: 1500 })
  await core.executors.probe({ profileId: 'claude-default' })
  writeFileSync(join(config, 'fake-login-mode'), 'hang')
  await invokeCoreOperation(
    core,
    'executors.signIn',
    [{ profileId: 'claude-default', method: 'claude-ai' }],
    VIEW,
  )
  await waitFor(() => !!fakeLoginProcess(config).child, 5000)
  const { pid, child } = fakeLoginProcess(config)
  const timedOut = await ended('failed')
  expect(timedOut.signIn).toMatchObject({ reason: 'timeout' })
  expect(timedOut.signIn.command).toMatch(/ auth login$/)
  expect(await gone([pid, child])).toBe(true)
})

it('FIX-11 · 4 · 取消 ends claude’s process group and says so', async () => {
  const { core, config, ended } = await api()
  await core.executors.probe({ profileId: 'claude-default' })
  writeFileSync(join(config, 'fake-login-mode'), 'hang')
  await invokeCoreOperation(
    core,
    'executors.signIn',
    [{ profileId: 'claude-default', method: 'claude-ai' }],
    VIEW,
  )
  await waitFor(() => !!fakeLoginProcess(config).child, 5000)
  const { pid, child } = fakeLoginProcess(config)
  expect(processAlive(child!)).toBe(true)
  const out = await invokeCoreOperation(
    core,
    'executors.cancelSignIn',
    [{ profileId: 'claude-default' }],
    VIEW,
  )
  expect(out).toMatchObject({
    signIn: { state: 'cancelled', profileId: 'claude-default' },
  })
  await ended('cancelled')
  expect(await gone([pid, child])).toBe(true)
  expect(core.executors.list()).toMatchObject({ signIn: null })
  // Nothing running: 取消 does nothing.
  expect(
    await invokeCoreOperation(
      core,
      'executors.cancelSignIn',
      [{ profileId: 'claude-default' }],
      VIEW,
    ),
  ).toEqual({ signIn: null })
})

it('FIX-11 · 4 · quitting Emperor ends a sign-in that is still waiting', async () => {
  const { core, config } = await api()
  await core.executors.probe({ profileId: 'claude-default' })
  writeFileSync(join(config, 'fake-login-mode'), 'hang')
  await invokeCoreOperation(
    core,
    'executors.signIn',
    [{ profileId: 'claude-default', method: 'claude-ai' }],
    VIEW,
  )
  await waitFor(() => !!fakeLoginProcess(config).child, 5000)
  const { pid, child } = fakeLoginProcess(config)
  await core.close()
  expect(await gone([pid, child])).toBe(true)
})

it('FIX-11 · 5 · clicking again while it runs starts no second claude', async () => {
  const { core, config, ended } = await api()
  await core.executors.probe({ profileId: 'claude-default' })
  writeFileSync(join(config, 'fake-login-mode'), 'hang')
  const clicks = await Promise.all([
    invokeCoreOperation(
      core,
      'executors.signIn',
      [{ profileId: 'claude-default', method: 'claude-ai' }],
      VIEW,
    ),
    invokeCoreOperation(
      core,
      'executors.signIn',
      [{ profileId: 'claude-default', method: 'claude-ai' }],
      VIEW,
    ),
    invokeCoreOperation(
      core,
      'executors.signIn',
      [{ profileId: 'claude-default', method: 'console' }],
      VIEW,
    ),
  ])
  const started = new Set(clicks.map((click) => click.signIn.startedAt))
  expect(started.size).toBe(1)
  for (const click of clicks)
    expect(click.signIn).toMatchObject({
      state: 'running',
      method: 'claude-ai',
    })
  // A later click joins the same one.
  expect(
    await invokeCoreOperation(
      core,
      'executors.signIn',
      [{ profileId: 'claude-default', method: 'claude-ai' }],
      VIEW,
    ),
  ).toMatchObject({ signIn: { startedAt: [...started][0] } })
  await waitFor(() => !!fakeLoginProcess(config).child, 5000)
  expect(logins(config)).toHaveLength(1)
  await invokeCoreOperation(
    core,
    'executors.cancelSignIn',
    [{ profileId: 'claude-default' }],
    VIEW,
  )
  await ended('cancelled')
  expect(logins(config)).toHaveLength(1)
})

it('FIX-11 · 6 · the Terminal scripts an earlier build left behind are deleted at start', async () => {
  let folder = ''
  const { core } = await api({
    before: (root) => {
      folder = join(root, 'home', 'delegations', 'claude-code', 'sign-in')
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      for (const id of ['0a1b2c3d', '4e5f6a7b', '8c9d0e1f'])
        writeFileSync(
          join(folder, `claude-sign-in-${id}.command`),
          '#!/bin/bash\n',
          { mode: 0o700 },
        )
    },
  })
  expect(folder.startsWith(core.paths.delegationsRoot)).toBe(true)
  expect(existsSync(folder)).toBe(false)
})

it('FIX-11 · 7 · what claude prints never reaches Emperor’s logs, events, replies or files', async () => {
  const lines: LogLine[] = []
  setCoreLogSink((line) => lines.push(line))
  const printed: unknown[] = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args)
    })
  const { core, config, events, ended } = await api()
  mkdirSync(config, { recursive: true })
  const replies: unknown[] = []
  for (const mode of ['fail', '']) {
    writeFileSync(join(config, 'fake-login-mode'), mode)
    replies.push(
      await invokeCoreOperation(
        core,
        'executors.signIn',
        [{ profileId: 'claude-default', method: 'claude-ai' }],
        VIEW,
      ),
    )
    await ended(mode === 'fail' ? 'failed' : 'signed-in')
    replies.push(core.executors.list())
  }
  // claude did print them: they are in what it was given to print to.
  expect(logins(config)).toHaveLength(2)
  const seen = JSON.stringify({ lines, printed, events, replies })
  expect(seen).toContain('executor_sign_in')
  for (const secret of [FAKE_LOGIN_LINK, 'FAKE-STATE-0f1e2d', FAKE_LOGIN_CODE])
    expect(seen).not.toContain(secret)
  // Nor any file under Emperor Home.
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? walk(path) : [path]
    })
  for (const file of walk(core.paths.stateRoot)) {
    const text = readFileSync(file, 'latin1')
    expect(text.includes('FAKE-STATE-0f1e2d'), file).toBe(false)
    expect(text.includes(FAKE_LOGIN_CODE), file).toBe(false)
  }
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
