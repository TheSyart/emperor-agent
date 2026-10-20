import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLocalKeySealer } from '../../security/secret-sealer'
import { CLAUDE_SHELL_KEYS, ClaudeTokenStore } from './claude-auth'
import { createLoginShellEnvironment } from './login-shell'
import { defaultExecutorConfig } from './config'
import { ExecutorRuntimeService } from './runtime'
import { DelegationService } from './service'
import { fixture, spec } from './service-test-fixture'
import { FakeExecutorAdapter, delegationTestDirectory } from './testing'
import type { ExecutorOpenInput } from './types'

/**
 * AGT-02 · where Claude Code's sign-in comes from: ① a token pasted into
 * Emperor, ② ~/.claude/settings.json `env`, ③ `.credentials.json` (with
 * its expiry), ④ the environment, then the login shell. Every test runs
 * on a temporary home; the login shell is a fake.
 */
const OAUTH = 'sk-ant-oat01-fixture-subscription-token-a1b2'
const API_KEY = 'sk-ant-api03-fixture-api-key-c3d4'
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
  } = {},
) {
  const f = delegationTestDirectory()
  cleanups.push(f.cleanup)
  const home = join(f.root, 'home'),
    root = join(f.root, 'delegations')
  mkdirSync(home, { recursive: true })
  const vault = { root, sealer: createLocalKeySealer(join(f.root, 'state')) }
  const tokens = new ClaudeTokenStore(vault)
  const shellReads: string[][] = []
  const loginShell = {
    read: vi.fn(async (names: readonly string[]) => {
      shellReads.push([...names])
      return Object.fromEntries(
        Object.entries(options.shell ?? {}).filter(([k]) => names.includes(k)),
      )
    }),
  }
  const runtime = new ExecutorRuntimeService({
    root,
    home,
    environment: options.environment ?? { PATH: '/usr/bin:/bin' },
    loginShell,
    claudeTokens: vault,
  })
  const writeClaude = (file: string, value: unknown) => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', file), JSON.stringify(value))
  }
  return {
    ...f,
    home,
    root,
    tokens,
    runtime,
    loginShell,
    shellReads,
    writeClaude,
  }
}

describe('AGT-02 · Claude Code sign-in sources', () => {
  it('1 · runs with only a token pasted into Emperor, sealed on disk', async () => {
    const s = setup()
    expect(s.tokens.read('claude-default')).toBeNull()
    s.tokens.set('claude-default', 'oauth-token', OAUTH)
    const file = join(s.root, 'credentials.json'),
      raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(OAUTH)
    expect(raw).toContain('el1:')
    expect(raw).toContain('"last4": "a1b2"')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(s.tokens.read('claude-default')).toEqual({
      kind: 'oauth-token',
      token: OAUTH,
      last4: 'a1b2',
    })

    const runtime = await s.runtime.prepare(claude(), 'dlg-vault')
    expect(runtime.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH)
    expect(runtime.environment.ANTHROPIC_API_KEY).toBeUndefined()
    expect(runtime.billing).toBe('subscription')
    expect(runtime.secretValues).toContain(OAUTH)
    expect(runtime).toMatchObject({
      auth: { source: 'emperor', kind: 'oauth-token', last4: 'a1b2' },
    })
    // Nothing else was consulted.
    expect(s.loginShell.read).not.toHaveBeenCalled()

    // The run itself: the executor gets exactly that credential.
    const f = fixture()
    cleanups.push(f.cleanup)
    const opened: ExecutorOpenInput[] = []
    const adapter = new FakeExecutorAdapter('claude-code', async function* (
      turn,
      open,
    ) {
      opened.push(open)
      yield {
        type: 'turn_finished',
        status: 'completed',
        text: 'done',
        delegationId: open.delegationId,
        runId: turn.runId,
        generation: open.generation,
      }
    })
    const service = new DelegationService({
      ...f.options,
      adapters: new Map([['claude-code', adapter]]),
      runtime: (profile, id) => s.runtime.prepare(profile, id),
    })
    const record = await service.start(f.owner, {
      ...spec,
      backend: 'claude-code',
      profileId: 'claude-default',
    })
    const run = await service.wait(record.id, record.currentRunId!)
    expect(run.phase).toBe('completed')
    expect(opened[0]!.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH)
    await service.shutdown()

    // An API key pasted the same way is an API key.
    s.tokens.set('claude-default', 'api-key', API_KEY)
    const api = await s.runtime.prepare(claude(), 'dlg-vault-key')
    expect(api.environment.ANTHROPIC_API_KEY).toBe(API_KEY)
    expect(api.environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(api.billing).toBe('api')
    s.tokens.clear('claude-default')
    expect(s.tokens.read('claude-default')).toBeNull()
    expect(readFileSync(file, 'utf8')).not.toContain('el1:')
    // A value sealed under another key reads as unreadable, not as a token.
    s.tokens.set('claude-default', 'oauth-token', OAUTH)
    const moved = new ExecutorRuntimeService({
      root: s.root,
      home: s.home,
      environment: { PATH: '/usr/bin:/bin' },
      claudeTokens: {
        root: s.root,
        sealer: createLocalKeySealer(join(s.root, 'another-state')),
      },
    })
    await expect(
      moved.prepare(claude(), 'dlg-other-key'),
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      auth: { source: null, problem: 'unreadable' },
    })
  })

  it('2 · runs with only a token in ~/.claude/settings.json env', async () => {
    const s = setup()
    s.writeClaude('settings.json', {
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'settings-oauth-token' },
    })
    const runtime = await s.runtime.prepare(claude(), 'dlg-settings')
    expect(runtime.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      'settings-oauth-token',
    )
    expect(runtime).toMatchObject({
      auth: { source: 'settings', kind: 'oauth-token' },
    })
    s.writeClaude('settings.json', {
      env: { ANTHROPIC_API_KEY: 'settings-api-key' },
    })
    const key = await s.runtime.prepare(claude(), 'dlg-settings-key')
    expect(key.environment.ANTHROPIC_API_KEY).toBe('settings-api-key')
    expect(key).toMatchObject({ auth: { source: 'settings', kind: 'api-key' } })
    expect(s.loginShell.read).not.toHaveBeenCalled()
  })

  it('reads the sources in order and takes the credential from the first one that has it', async () => {
    const s = setup({
      environment: {
        PATH: '/usr/bin:/bin',
        ANTHROPIC_API_KEY: 'ambient-api-key',
      },
      shell: { CLAUDE_CODE_OAUTH_TOKEN: 'shell-token' },
    })
    s.tokens.set('claude-default', 'oauth-token', OAUTH)
    s.writeClaude('settings.json', {
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'settings-oauth-token' },
    })
    s.writeClaude('.credentials.json', {
      claudeAiOauth: {
        accessToken: 'file-access-token',
        refreshToken: 'file-refresh-token',
        expiresAt: Date.now() + 3_600_000,
      },
    })
    const sources: string[] = []
    const take = async (id: string) => {
      const r = (await s.runtime.prepare(claude(), id)) as unknown as {
        environment: Record<string, string>
        auth: { source: string }
      }
      sources.push(r.auth.source)
      return r.environment
    }
    // ① Emperor's token: no ambient key rides along with it.
    expect(await take('dlg-1')).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
    })
    expect((await take('dlg-1b')).ANTHROPIC_API_KEY).toBeUndefined()
    s.tokens.clear('claude-default')
    // ② settings.json beats the process environment.
    expect((await take('dlg-2')).CLAUDE_CODE_OAUTH_TOKEN).toBe(
      'settings-oauth-token',
    )
    s.writeClaude('settings.json', { env: {} })
    // ③ .credentials.json: the access token only, never the refresh token.
    const file = await take('dlg-3')
    expect(file.CLAUDE_CODE_OAUTH_TOKEN).toBe('file-access-token')
    expect(JSON.stringify(file)).not.toContain('file-refresh-token')
    s.writeClaude('.credentials.json', {})
    // ④ the environment Emperor was started with, then the login shell.
    expect((await take('dlg-4')).ANTHROPIC_API_KEY).toBe('ambient-api-key')
    expect(s.loginShell.read).not.toHaveBeenCalled()
    expect(sources).toEqual([
      'emperor',
      'emperor',
      'settings',
      'credentials-file',
      'environment',
    ])
  })

  it('3 · an expired .credentials.json reads 令牌已过期, and one about to expire warns', async () => {
    const s = setup()
    const expiresAt = Date.now() - 60_000
    s.writeClaude('.credentials.json', {
      claudeAiOauth: { accessToken: 'expired-access', expiresAt },
    })
    const error = await s.runtime
      .prepare(claude(), 'dlg-expired')
      .then(() => null)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'AUTH_EXPIRED',
      auth: { source: null, problem: 'expired', expiresAt },
    })
    // The settings check and the model catalog may still read the profile.
    const probe = await s.runtime.prepare(claude(), 'dlg-expired-config', {
      allowUnauthenticatedConfig: true,
    })
    expect(probe.authenticationAvailable).toBe(false)
    expect(probe.environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()

    // Ten minutes before it expires: usable, with a warning.
    s.writeClaude('.credentials.json', {
      claudeAiOauth: {
        accessToken: 'soon-access',
        expiresAt: Date.now() + 5 * 60_000,
      },
    })
    const soon = await s.runtime.prepare(claude(), 'dlg-soon')
    expect(soon.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe('soon-access')
    expect(soon).toMatchObject({
      auth: { source: 'credentials-file', expiresSoon: true },
    })
    s.writeClaude('.credentials.json', {
      claudeAiOauth: {
        accessToken: 'later-access',
        expiresAt: Date.now() + 30 * 60_000,
      },
    })
    expect(await s.runtime.prepare(claude(), 'dlg-later')).toMatchObject({
      auth: { source: 'credentials-file', expiresSoon: false },
    })
  })

  it('4 · imports a token exported in the login shell, asking only for the whitelisted names', async () => {
    const s = setup({
      shell: {
        CLAUDE_CODE_OAUTH_TOKEN: 'zshrc-token',
        ANTHROPIC_BASE_URL: 'https://gateway.invalid',
        UNRELATED_SECRET: 'never',
      },
    })
    const runtime = await s.runtime.prepare(claude(), 'dlg-shell')
    expect(runtime.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe('zshrc-token')
    expect(runtime.environment.ANTHROPIC_BASE_URL).toBe(
      'https://gateway.invalid',
    )
    expect(runtime.environment.UNRELATED_SECRET).toBeUndefined()
    expect(runtime).toMatchObject({
      auth: { source: 'login-shell', kind: 'oauth-token' },
    })
    expect(s.shellReads).toEqual([[...CLAUDE_SHELL_KEYS]])
    expect([...CLAUDE_SHELL_KEYS].sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_MODEL',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ].sort(),
    )
  })

  it('4 · the login shell (a fake zsh) runs once, with a timeout, for every Claude run', async () => {
    const f = delegationTestDirectory()
    cleanups.push(f.cleanup)
    const counter = join(f.root, 'count'),
      zsh = join(f.root, 'fake-zsh')
    // Stands in for `zsh -ilc <command>`: rc-file noise, exports, the command.
    writeFileSync(
      zsh,
      '#!/bin/sh\n' +
        `echo x >> ${JSON.stringify(counter)}\n` +
        'echo "Welcome back"\nexport CLAUDE_CODE_OAUTH_TOKEN=exported-in-zshrc\n' +
        'export UNRELATED_SECRET=never\nexec /bin/sh -c "$2"\n',
      { mode: 0o700 },
    )
    const runtime = new ExecutorRuntimeService({
      root: join(f.root, 'delegations'),
      home: join(f.root, 'empty-home'),
      environment: { PATH: '/usr/bin:/bin' },
      loginShell: createLoginShellEnvironment({
        shell: zsh,
        environment: { PATH: '/usr/bin:/bin' },
        timeoutMs: 3000,
      }),
    })
    const a = await runtime.prepare(claude(), 'dlg-zsh-a')
    const b = await runtime.prepare(claude(), 'dlg-zsh-b')
    expect(a.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe('exported-in-zshrc')
    expect(b.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe('exported-in-zshrc')
    expect(a.environment.UNRELATED_SECRET).toBeUndefined()
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('5 · with no credential the probe says unavailable, and so does the model context', async () => {
    const s = setup()
    const f = fixture()
    cleanups.push(f.cleanup)
    const consent = vi.fn(async () => true)
    const service = new DelegationService({
      ...f.options,
      consent,
      checkAuth: async (profile) => (await s.runtime.probe(profile)).auth,
    })
    await service.probeProfiles()
    const context = service.executorContext()
    const line = context
      .split('\n')
      .find((l) => l.startsWith('- claude-default (claude-code)'))!
    expect(line).toContain('status=unavailable')
    expect(line).toMatch(/not signed in/)
    // Codex is unaffected by Claude's sign-in.
    expect(context).toContain('- codex-default (codex): status=available')
    // Dispatching to it fails at once, before the user is asked.
    await expect(
      service.start(f.owner, {
        ...spec,
        backend: 'claude-code',
        profileId: 'claude-default',
        clientRequestId: 'no-auth',
      }),
    ).rejects.toThrow('AUTH_REQUIRED')
    expect(consent).not.toHaveBeenCalled()

    // A pasted token makes it available on the next check.
    s.tokens.set('claude-default', 'oauth-token', OAUTH)
    await service.probeProfiles()
    expect(service.executorContext()).toContain(
      '- claude-default (claude-code): status=available',
    )
    await service.shutdown()
  })
})

describe('a newer Emperor’s token file (REL-03 × AGT-02)', () => {
  it('is never replaced: setting a token refuses and leaves the bytes as they were', () => {
    const f = fixture()
    const root = join(f.root, 'delegations')
    mkdirSync(root, { recursive: true })
    const file = join(root, 'credentials.json')
    const newer = JSON.stringify({ schemaVersion: 9, tokens: { future: true } })
    writeFileSync(file, newer)
    const tokens = new ClaudeTokenStore({
      root,
      sealer: createLocalKeySealer(join(f.root, 'state')),
    })
    expect(() =>
      tokens.set('claude', 'oauth-token', 'sk-ant-oat01-abcdefghijklmnop'),
    ).toThrow(/更新版本的 Emperor|data_file_newer/)
    expect(readFileSync(file, 'utf8')).toBe(newer)
  })
})
