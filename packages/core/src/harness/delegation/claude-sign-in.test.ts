import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile, type spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { promisify } from 'node:util'
import { createLocalKeySealer } from '../../security/secret-sealer'
import {
  CLAUDE_SHELL_KEYS,
  CLAUDE_SIGN_IN_TIMEOUT_MS,
  ClaudeKeyStore,
  checkClaudeSignIn,
  claudeDirectories,
  claudeSignInCommand,
  claudeSignInEnvironment,
  parseClaudeAuthStatus,
  prepareClaudeDirectories,
  removeSignInScripts,
  signOutClaude,
  startClaudeLogin,
} from './claude-sign-in'
import { defaultExecutorConfig } from './config'
import { ManagedAgentProcess } from './process'
import { ExecutorRegistry } from './registry'
import { ExecutorRuntimeService } from './runtime'
import type { SandboxBackend } from '../sandbox/backend'
import {
  delegationTestDirectory,
  fakeClaude,
  fakeClaudeCalls,
  fakeLoginProcess,
  processAlive,
} from './testing'

/**
 * AGT-12 · Claude Code signs in through its own, unmodified login. Every
 * run, status check and sign-in uses one dedicated CLAUDE_CONFIG_DIR and
 * HOME under Emperor Home; Emperor never reads, stores or forwards a
 * Claude.ai token. A fake `claude` stands in for the installed one; the
 * user's ~/.claude is a temporary folder.
 */
const API_KEY = 'sk-ant-api03-fixture-console-key-c3d4'
const run = promisify(execFile)
/** Commands run unconfined here; the Seatbelt profile has its own golden. */
const passthrough: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: [],
    runnerFailureRules: [],
  }),
}
const claude = () => ({
  ...defaultExecutorConfig().profiles[0]!,
  enabled: true,
  authRef: { kind: 'managed-cli-login' as const },
})
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((c) => c()))

function setup(
  options: {
    environment?: NodeJS.ProcessEnv
    shell?: Record<string, string>
    version?: string
    status?: 'fail' | 'garbage'
  } = {},
) {
  const f = delegationTestDirectory()
  cleanups.push(f.cleanup)
  const home = join(f.root, 'user-home'),
    root = join(f.root, 'delegations'),
    bin = join(f.root, 'bin')
  mkdirSync(home, { recursive: true })
  const executable = fakeClaude(bin, {
    ...(options.version ? { version: options.version } : {}),
    ...(options.status ? { status: options.status } : {}),
  })
  const sealer = createLocalKeySealer(join(f.root, 'state'))
  const keys = new ClaudeKeyStore({ root, sealer })
  const loginShell = {
    read: vi.fn(async (names: readonly string[]) =>
      Object.fromEntries(
        Object.entries(options.shell ?? {}).filter(([k]) => names.includes(k)),
      ),
    ),
  }
  const environment = {
    PATH: `${bin}:/usr/bin:/bin`,
    ...options.environment,
  }
  const runtime = new ExecutorRuntimeService({
    root,
    home,
    environment,
    loginShell,
    claudeKeys: { root, sealer },
  })
  const processes = new ManagedAgentProcess({ sandbox: passthrough })
  const writeClaude = (file: string, value: unknown) => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', file), JSON.stringify(value))
  }
  return {
    ...f,
    home,
    root,
    bin,
    executable,
    sealer,
    keys,
    runtime,
    processes,
    loginShell,
    environment,
    writeClaude,
    dirs: claudeDirectories(root),
  }
}

describe('AGT-12 · Claude Code’s own sign-in in a dedicated folder', () => {
  it('1 · runs, the status check and 登录 share one CLAUDE_CONFIG_DIR and HOME', async () => {
    const s = setup()
    expect(s.dirs.config).toBe(join(s.root, 'claude-code', 'config'))
    expect(s.dirs.home).toBe(join(s.root, 'claude-code', 'home'))
    const a = await s.runtime.prepare(claude(), 'dlg-a')
    const b = await s.runtime.prepare(claude(), 'dlg-b')
    const probe = await s.runtime.probe(claude())
    for (const r of [a, b, probe]) {
      expect(r.environment).toMatchObject({
        CLAUDE_CONFIG_DIR: s.dirs.config,
        HOME: s.dirs.home,
        XDG_CONFIG_HOME: join(s.dirs.home, '.config'),
        XDG_CACHE_HOME: join(s.dirs.home, '.cache'),
      })
      // Seatbelt lets the run write its own login and home, nothing else.
      expect(r.stateRoots).toEqual(
        expect.arrayContaining([r.runtimeRoot, s.dirs.config, s.dirs.home]),
      )
    }
    // Temp folders stay per run.
    expect(a.tempRoot).not.toBe(b.tempRoot)
    expect(a.environment.TMPDIR).toBe(a.tempRoot)
    expect(a.environment.CLAUDE_CODE_TMPDIR).toBe(a.tempRoot)
    for (const dir of [s.dirs.root, s.dirs.config, s.dirs.home])
      expect(statSync(dir).mode & 0o777).toBe(0o700)

    // The status check runs claude with exactly that environment.
    await checkClaudeSignIn({
      executable: s.executable,
      runtime: probe,
      processes: s.processes,
    }).catch(() => undefined)
    const status = fakeClaudeCalls(s.dirs.config).at(-1)!
    expect(status.args).toBe('auth status')
    expect(status.env).toMatchObject({
      CLAUDE_CONFIG_DIR: s.dirs.config,
      HOME: s.dirs.home,
      XDG_CONFIG_HOME: join(s.dirs.home, '.config'),
    })

    // 登录 runs the same claude with the same folders, then the check sees it.
    const started = await startClaudeLogin({
      executable: s.executable,
      environment: probe.environment,
      cwd: s.dirs.home,
      console: false,
    })
    expect(await started.done).toEqual({ ended: 'exit', exitCode: 0 })
    const login = fakeClaudeCalls(s.dirs.config).at(-1)!
    expect(login.args).toBe('auth login')
    expect(login.env).toMatchObject({
      CLAUDE_CONFIG_DIR: s.dirs.config,
      HOME: s.dirs.home,
      XDG_CONFIG_HOME: join(s.dirs.home, '.config'),
      XDG_CACHE_HOME: join(s.dirs.home, '.cache'),
    })
    expect(
      await checkClaudeSignIn({
        executable: s.executable,
        runtime: await s.runtime.probe(claude()),
        processes: s.processes,
      }),
    ).toMatchObject({ method: 'claude.ai', email: 'ada@example.com' })

    // Resume: a session an earlier build kept in the run's own folder moves
    // into the dedicated one, where claude --resume looks for it.
    const legacy = join(
      s.root,
      'runtime',
      'claude-default',
      'dlg-old',
      'claude',
      'projects',
      '-work-repo',
    )
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'sess-1.jsonl'), '{"type":"user"}\n')
    const old = await s.runtime.prepare(claude(), 'dlg-old')
    expect(old.environment.CLAUDE_CONFIG_DIR).toBe(s.dirs.config)
    expect(
      readFileSync(
        join(s.dirs.config, 'projects', '-work-repo', 'sess-1.jsonl'),
        'utf8',
      ),
    ).toBe('{"type":"user"}\n')
  })

  it('2 · no Claude.ai OAuth token reaches claude, from any source', async () => {
    const leaked = (where: string) => `sk-ant-oat01-${where}-must-not-cross`
    const s = setup({
      environment: {
        CLAUDE_CODE_OAUTH_TOKEN: leaked('ambient'),
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'sk-ant-ort01-ambient-refresh',
      },
      shell: { CLAUDE_CODE_OAUTH_TOKEN: leaked('zshrc') },
    })
    // ~/.claude/settings.json env, and the user's own CLI login file.
    s.writeClaude('settings.json', {
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: leaked('settings'),
        ANTHROPIC_AUTH_TOKEN: leaked('settings-bearer'),
      },
    })
    s.writeClaude('.credentials.json', {
      claudeAiOauth: {
        accessToken: leaked('credentials-file'),
        refreshToken: 'sk-ant-ort01-file-refresh',
        expiresAt: Date.now() + 3_600_000,
      },
    })
    // A token an earlier build sealed in Emperor's store.
    mkdirSync(s.root, { recursive: true })
    writeFileSync(
      join(s.root, 'credentials.json'),
      JSON.stringify({
        schemaVersion: 1,
        tokens: {
          'claude-default': {
            kind: 'oauth-token',
            value: s.sealer.seal(
              leaked('emperor-store'),
              'delegations/credentials.json#claude-default.oauth-token',
            ),
            last4: 'ross',
          },
        },
      }),
    )
    const prepared = await s.runtime.prepare(claude(), 'dlg-no-oauth')
    const probe = await s.runtime.probe(claude())
    for (const r of [prepared, probe]) {
      expect(JSON.stringify(r.environment)).not.toMatch(/sk-ant-o[ar]t/)
      expect(
        Object.keys(r.environment).filter((k) =>
          k.startsWith('CLAUDE_CODE_OAUTH'),
        ),
      ).toEqual([])
      expect(r.auth).toMatchObject({ source: null })
    }
    // And what the claude process itself sees.
    await checkClaudeSignIn({
      executable: s.executable,
      runtime: probe,
      processes: s.processes,
    }).catch(() => undefined)
    const seen = fakeClaudeCalls(s.dirs.config).at(-1)!
    expect(JSON.stringify(seen.env)).not.toMatch(/sk-ant-o[ar]t/)
    expect(seen.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    // The token store hands out API keys only.
    expect(s.keys.read('claude-default')).toBeNull()
    // The login shell is asked for API credentials only.
    expect(CLAUDE_SHELL_KEYS).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
    for (const call of s.loginShell.read.mock.calls)
      expect(call[0]).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('3 · the user’s own API key and third-party endpoint still reach claude', async () => {
    // An API key saved in Emperor (使用 API Key), sealed.
    const s = setup()
    s.keys.set('claude-default', API_KEY)
    const raw = readFileSync(join(s.root, 'credentials.json'), 'utf8')
    expect(raw).not.toContain(API_KEY)
    expect(raw).toContain('el1:')
    expect(statSync(join(s.root, 'credentials.json')).mode & 0o777).toBe(0o600)
    const keyed = await s.runtime.prepare(claude(), 'dlg-key')
    expect(keyed.environment.ANTHROPIC_API_KEY).toBe(API_KEY)
    expect(keyed.secretValues).toContain(API_KEY)
    expect(keyed.billing).toBe('api')
    expect(keyed.auth).toMatchObject({
      source: 'emperor',
      kind: 'api-key',
      last4: 'c3d4',
    })
    // claude says which credential is in effect.
    expect(
      await checkClaudeSignIn({
        executable: s.executable,
        runtime: keyed,
        processes: s.processes,
      }),
    ).toMatchObject({ method: 'api_key', source: 'emperor', last4: 'c3d4' })
    s.keys.clear('claude-default')

    // A third-party endpoint in ~/.claude/settings.json (DeepSeek's
    // Anthropic-compatible API), with its token and model.
    s.writeClaude('settings.json', {
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-fixture-token',
        ANTHROPIC_MODEL: 'deepseek-chat',
      },
    })
    const endpoint = await s.runtime.prepare(claude(), 'dlg-endpoint')
    expect(endpoint.environment).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-deepseek-fixture-token',
      ANTHROPIC_MODEL: 'deepseek-chat',
    })
    expect(endpoint.auth).toMatchObject({
      source: 'settings',
      kind: 'auth-token',
      endpoint: 'api.deepseek.com',
    })
    expect(
      await checkClaudeSignIn({
        executable: s.executable,
        runtime: endpoint,
        processes: s.processes,
      }),
    ).toMatchObject({
      method: 'oauth_token',
      source: 'settings',
      endpoint: 'api.deepseek.com',
    })
    s.writeClaude('settings.json', {})

    // ANTHROPIC_API_KEY from the environment Emperor started with…
    const ambient = setup({ environment: { ANTHROPIC_API_KEY: 'ambient-key' } })
    const fromEnv = await ambient.runtime.prepare(claude(), 'dlg-env')
    expect(fromEnv.environment.ANTHROPIC_API_KEY).toBe('ambient-key')
    expect(fromEnv.auth).toMatchObject({ source: 'environment' })
    // …or from the login shell (a Dock launch).
    const shell = setup({ shell: { ANTHROPIC_API_KEY: 'zshrc-key' } })
    const fromShell = await shell.runtime.prepare(claude(), 'dlg-shell')
    expect(fromShell.environment.ANTHROPIC_API_KEY).toBe('zshrc-key')
    expect(fromShell.auth).toMatchObject({ source: 'login-shell' })
  })

  it('4 · claude auth status: signed in, signed out, a failed command, a claude too old to have it', async () => {
    const signedIn = parseClaudeAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        configDirectory: '/x/claude-code/config',
        email: 'ada@example.com',
        orgId: '11111111-2222-3333-4444-555555555555',
        orgName: 'Ada Lab',
        subscriptionType: 'max',
        // Never copied, whatever a future CLI prints.
        accessToken: 'sk-ant-oat01-from-a-future-cli',
      }),
      0,
    )
    expect(signedIn).toEqual({
      loggedIn: true,
      method: 'claude.ai',
      provider: 'firstParty',
      configDirectory: '/x/claude-code/config',
      email: 'ada@example.com',
      organization: 'Ada Lab',
      subscription: 'max',
    })
    expect(JSON.stringify(signedIn)).not.toMatch(/sk-ant|1111-2222/)
    expect(
      parseClaudeAuthStatus(
        '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}\n',
        1,
      ),
    ).toMatchObject({ loggedIn: false, method: 'none' })
    for (const [stdout, code] of [
      ['Not logged in. Run claude auth login to authenticate.', 1],
      ['', 0],
      ['{"authMethod": 7}', 0],
    ] as const)
      expect(() => parseClaudeAuthStatus(stdout, code)).toThrow(
        /AUTH_STATUS_FAILED/,
      )

    // Through the CLI: signed out is AUTH_REQUIRED with what claude said.
    const s = setup()
    const probe = await s.runtime.probe(claude())
    await expect(
      checkClaudeSignIn({
        executable: s.executable,
        runtime: probe,
        processes: s.processes,
      }),
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      auth: { method: 'none', source: null },
    })
    // Signed in.
    writeFileSync(join(s.dirs.config, 'fake-signed-in'), 'claude.ai')
    expect(
      await checkClaudeSignIn({
        executable: s.executable,
        runtime: probe,
        processes: s.processes,
      }),
    ).toEqual({
      source: null,
      method: 'claude.ai',
      email: 'ada@example.com',
      organization: 'Ada Lab',
      subscription: 'max',
    })
    // 退出登录 runs claude auth logout in the same folders.
    await signOutClaude({
      executable: s.executable,
      runtime: probe,
      processes: s.processes,
    })
    expect(fakeClaudeCalls(s.dirs.config).at(-1)).toMatchObject({
      args: 'auth logout',
      env: { CLAUDE_CONFIG_DIR: s.dirs.config, HOME: s.dirs.home },
    })
    expect(existsSync(join(s.dirs.config, 'fake-signed-in'))).toBe(false)

    // A command that fails, or prints something else, is not a sign-in.
    for (const status of ['fail', 'garbage'] as const) {
      const broken = setup({ status })
      await expect(
        checkClaudeSignIn({
          executable: broken.executable,
          runtime: await broken.runtime.probe(claude()),
          processes: broken.processes,
        }),
      ).rejects.toMatchObject({
        code: 'AUTH_STATUS_FAILED',
        auth: { problem: 'status-failed' },
      })
    }

    // auth status arrived in 2.1.41 and auth login --console in 2.1.79.
    const old = setup({ version: '2.1.40' })
    const registry = new ExecutorRegistry({
      home: old.home,
      environment: old.environment,
    })
    expect(await registry.probe(claude())).toMatchObject({
      status: 'incompatible',
      executableVersion: '2.1.40',
      requiredVersion: '>= 2.1.79',
    })
    const ok = setup({ version: '2.1.79' })
    expect(
      await new ExecutorRegistry({
        home: ok.home,
        environment: ok.environment,
      }).probe(claude()),
    ).toMatchObject({ status: 'available', executableVersion: '2.1.79' })
  })

  it('6 · an upgrade deletes a Claude OAuth token an earlier build saved, and says so once', () => {
    const s = setup()
    mkdirSync(s.root, { recursive: true })
    const file = join(s.root, 'credentials.json')
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        tokens: {
          'claude-default': {
            kind: 'oauth-token',
            value: s.sealer.seal(
              'sk-ant-oat01-old-token',
              'delegations/credentials.json#claude-default.oauth-token',
            ),
            last4: 'oken',
          },
          'claude-work': {
            kind: 'api-key',
            value: s.sealer.seal(
              API_KEY,
              'delegations/credentials.json#claude-work.api-key',
            ),
            last4: 'c3d4',
          },
        },
      }),
    )
    expect(s.keys.migrate()).toBe(true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(after.tokens)).toEqual(['claude-work'])
    expect(readFileSync(file, 'utf8')).not.toContain('oauth-token')
    expect(s.keys.read('claude-work')).toEqual({
      token: API_KEY,
      last4: 'c3d4',
    })
    expect(s.keys.noticePending()).toBe(true)
    // Running again changes nothing; the notice stays until it is seen.
    expect(s.keys.migrate()).toBe(false)
    expect(s.keys.noticePending()).toBe(true)
    s.keys.dismissNotice()
    expect(s.keys.noticePending()).toBe(false)
    // Nothing to migrate: no notice.
    const fresh = setup()
    expect(fresh.keys.migrate()).toBe(false)
    expect(fresh.keys.noticePending()).toBe(false)
  })
})

/** A spawned child Node would hand back, for checking how Core starts it. */
function childDouble() {
  const writes: Buffer[] = []
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new Writable({
      write(chunk: Buffer, _encoding, done) {
        writes.push(chunk)
        done()
      },
    }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  const exit = (code: number) => {
    child.exitCode = code
    child.emit('exit', code, null)
    child.emit('close', code, null)
  }
  return { child, writes, exit }
}

async function gone(pids: Array<number | undefined>, ms = 3000) {
  const until = Date.now() + ms
  while (pids.some((pid) => pid && processAlive(pid)) && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 25))
  return pids.every((pid) => !pid || !processAlive(pid))
}

describe('FIX-11 · 登录 Claude Code: Core runs claude auth login itself', () => {
  it('1 · claude auth login [--console] with the dedicated folders, no credentials, its own process group, stdin a pipe never written, output drained', async () => {
    const s = setup({
      environment: {
        ANTHROPIC_AUTH_TOKEN: 'ambient-gateway-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-ambient-must-not-cross',
        ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      },
    })
    s.keys.set('claude-default', API_KEY)
    const probe = await s.runtime.probe(claude())
    // The run's own environment carries the user's API credential…
    expect(probe.environment.ANTHROPIC_API_KEY).toBe(API_KEY)
    // …the sign-in's does not: claude would sign in with it instead.
    const env = claudeSignInEnvironment(probe.environment)
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
    ])
      expect(env[key], key).toBeUndefined()
    expect(env).toMatchObject({
      CLAUDE_CONFIG_DIR: s.dirs.config,
      HOME: s.dirs.home,
      XDG_CONFIG_HOME: join(s.dirs.home, '.config'),
      XDG_CACHE_HOME: join(s.dirs.home, '.cache'),
      PATH: probe.environment.PATH,
    })

    const { child, writes, exit } = childDouble()
    const spawnDouble = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    const login = await startClaudeLogin({
      executable: s.executable,
      environment: probe.environment,
      cwd: s.dirs.home,
      console: true,
      spawn: spawnDouble as unknown as typeof spawn,
    })
    expect(login.started).toBe(true)
    expect(spawnDouble).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawnDouble.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ]
    // The installed claude itself: no shell, no Terminal, no sandbox-exec.
    expect(command).toBe(s.executable)
    expect(args).toEqual(['auth', 'login', '--console'])
    expect(options).toMatchObject({
      cwd: s.dirs.home,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // A process group of its own: 取消 and the time limit stop all of it.
      detached: true,
    })
    // claude waits on stdin for a code it may ask for: nothing is written,
    // and it is not closed while claude runs.
    child.stdout.write('visit: https://claude.com/cai/oauth/authorize?x=1\n')
    child.stderr.write('Paste code here if prompted >')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(writes).toEqual([])
    expect(child.stdin.writableEnded).toBe(false)
    // Its output is drained and dropped, never read into Emperor.
    expect(child.stdout.readableFlowing).toBe(true)
    expect(child.stderr.readableFlowing).toBe(true)
    exit(0)
    expect(await login.done).toEqual({ ended: 'exit', exitCode: 0 })
    expect(child.stdout.destroyed && child.stdin.destroyed).toBe(true)

    // Without --console for a Claude account; a real run of the fake claude
    // sees the same folders and is the leader of its own process group.
    const real = await startClaudeLogin({
      executable: s.executable,
      environment: probe.environment,
      cwd: s.dirs.home,
      console: false,
    })
    expect(await real.done).toEqual({ ended: 'exit', exitCode: 0 })
    const call = fakeClaudeCalls(s.dirs.config).at(-1)!
    expect(call.args).toBe('auth login')
    expect(call.env).toMatchObject({
      CLAUDE_CONFIG_DIR: s.dirs.config,
      HOME: s.dirs.home,
    })
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(call.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    const { pid, pgid } = fakeLoginProcess(s.dirs.config)
    expect(pid).toBeGreaterThan(0)
    expect(pgid).toBe(pid)
    expect(existsSync(join(s.dirs.root, 'sign-in'))).toBe(false)
    expect(CLAUDE_SIGN_IN_TIMEOUT_MS).toBe(10 * 60_000)
  })

  it('3 · the fallback is the same sign-in on one line for the user’s own Terminal, safely quoted', async () => {
    const s = setup()
    const environment = {
      ...(await s.runtime.probe(claude())).environment,
      CLAUDE_CONFIG_DIR: "/Users/a b/it's/config",
    }
    const command = claudeSignInCommand({
      executable: s.executable,
      environment,
      console: false,
    })
    expect(command).toBe(
      'env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN ' +
        `CLAUDE_CONFIG_DIR='/Users/a b/it'\\''s/config' ` +
        `HOME='${s.dirs.home}' ` +
        `XDG_CONFIG_HOME='${join(s.dirs.home, '.config')}' ` +
        `XDG_CACHE_HOME='${join(s.dirs.home, '.cache')}' ` +
        `'${s.executable}' auth login`,
    )
    expect(command).not.toContain('\n')
    expect(
      claudeSignInCommand({
        executable: s.executable,
        environment,
        console: true,
      }).endsWith(' auth login --console'),
    ).toBe(true)
    // Pasted into a shell that exports credentials: claude still sees none,
    // and signs in in the dedicated folder.
    const ok = claudeSignInCommand({
      executable: s.executable,
      environment: (await s.runtime.probe(claude())).environment,
      console: false,
    })
    await run('/bin/sh', ['-c', ok], {
      env: {
        PATH: '/usr/bin:/bin',
        ANTHROPIC_API_KEY: 'shell-key',
        ANTHROPIC_AUTH_TOKEN: 'shell-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-shell',
      },
    })
    const call = fakeClaudeCalls(s.dirs.config).at(-1)!
    expect(call.args).toBe('auth login')
    expect(call.env.CLAUDE_CONFIG_DIR).toBe(s.dirs.config)
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(call.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('3 · a login that does not finish in time is stopped with its whole process group', async () => {
    const s = setup()
    const probe = await s.runtime.probe(claude())
    writeFileSync(join(s.dirs.config, 'fake-login-mode'), 'hang')
    const login = await startClaudeLogin({
      executable: s.executable,
      environment: probe.environment,
      cwd: s.dirs.home,
      console: false,
      timeoutMs: 1500,
      graceMs: 200,
    })
    expect(login.started).toBe(true)
    const until = Date.now() + 3000
    while (!fakeLoginProcess(s.dirs.config).child && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 20))
    const { pid, child } = fakeLoginProcess(s.dirs.config)
    expect(child).toBeGreaterThan(0)
    const outcome = await login.done
    expect(outcome.ended).toBe('timeout')
    expect(await gone([pid, child])).toBe(true)
  })

  it('3 · a claude that cannot start says so at once', async () => {
    const s = setup()
    const probe = await s.runtime.probe(claude())
    const login = await startClaudeLogin({
      executable: join(s.bin, 'no-such-claude'),
      environment: probe.environment,
      cwd: s.dirs.home,
      console: false,
    })
    expect(login.started).toBe(false)
    expect(await login.done).toEqual({ ended: 'start', exitCode: null })
  })

  it('4 · 取消 stops claude and everything it started', async () => {
    const s = setup()
    const probe = await s.runtime.probe(claude())
    writeFileSync(join(s.dirs.config, 'fake-login-mode'), 'hang')
    const login = await startClaudeLogin({
      executable: s.executable,
      environment: probe.environment,
      cwd: s.dirs.home,
      console: false,
      graceMs: 500,
    })
    const until = Date.now() + 3000
    while (!fakeLoginProcess(s.dirs.config).child && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 20))
    const { pid, child } = fakeLoginProcess(s.dirs.config)
    expect(child).toBeGreaterThan(0)
    expect(processAlive(child!)).toBe(true)
    expect(await login.cancel()).toMatchObject({ ended: 'cancelled' })
    expect(await gone([pid, child])).toBe(true)
    // Cancelling again, or after it ended, changes nothing.
    expect(await login.cancel()).toMatchObject({ ended: 'cancelled' })
  })

  it('6 · the scripts an earlier build left for Terminal are deleted, then their folder', () => {
    const s = setup()
    const dirs = prepareClaudeDirectories(s.root)
    const folder = join(dirs.root, 'sign-in')
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    for (const id of ['1a2b3c4d', '5e6f7a8b', '9c0d1e2f'])
      writeFileSync(
        join(folder, `claude-sign-in-${id}.command`),
        '#!/bin/bash\n',
        { mode: 0o700 },
      )
    removeSignInScripts(s.root)
    expect(existsSync(folder)).toBe(false)
    // The login itself is untouched.
    expect(existsSync(dirs.config)).toBe(true)
    // Nothing left: nothing to do.
    expect(() => removeSignInScripts(s.root)).not.toThrow()
  })
})

describe('a newer Emperor’s key file (REL-03 × AGT-02)', () => {
  it('is never replaced: saving a key refuses and leaves the bytes as they were', () => {
    const s = setup()
    mkdirSync(s.root, { recursive: true })
    const file = join(s.root, 'credentials.json')
    const newer = JSON.stringify({ schemaVersion: 9, tokens: { future: true } })
    writeFileSync(file, newer)
    expect(() => s.keys.set('claude-default', API_KEY)).toThrow(
      /更新版本的 Emperor|data_file_newer/,
    )
    expect(readFileSync(file, 'utf8')).toBe(newer)
  })
})
