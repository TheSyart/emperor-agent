import { expect, it } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { ExecutorRuntimeService } from './runtime'
import { delegationTestDirectory } from './testing'
import { defaultExecutorConfig } from './config'
import { readFileSync, statSync } from 'node:fs'
it('runs an env-node CLI from a GUI PATH while keeping the isolated HOME and auth allowlist', async () => {
  const f = delegationTestDirectory()
  try {
    const bin = join(f.root, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(process.execPath, join(bin, 'emperor-fixture-node'))
    const executablePath = join(f.root, 'cli')
    writeFileSync(
      executablePath,
      '#!/usr/bin/env emperor-fixture-node\nconsole.log(JSON.stringify({home:process.env.HOME,secret:process.env.UNRELATED_SECRET}))\n',
      { mode: 0o700 },
    )
    const runtime = await new ExecutorRuntimeService({
      root: f.root,
      home: f.root,
      environment: { PATH: '/usr/bin:/bin', UNRELATED_SECRET: 'omit' },
      resolveRoute: async () => ({ apiKey: 'fixture-key' }),
    }).prepare(
      {
        ...defaultExecutorConfig().profiles[1]!,
        authRef: { kind: 'model-route', routeId: 'fixture' },
      },
      'dlg-gui-path',
    )
    const { stdout } = await promisify(execFile)(executablePath, [], {
      env: runtime.environment,
      timeout: 5000,
    })
    expect(JSON.parse(stdout)).toEqual({
      home: join(runtime.runtimeRoot, 'home'),
    })
    expect(runtime.environment.PATH?.split(':')).toContain(bin)
  } finally {
    f.cleanup()
  }
})
it('reuses explicit local CLI authentication directories without importing their settings or plugins', async () => {
  const f = delegationTestDirectory()
  try {
    const claude = join(f.root, 'custom-claude'),
      codex = join(f.root, 'custom-codex')
    mkdirSync(claude)
    mkdirSync(codex)
    writeFileSync(
      join(claude, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'custom-claude-token' } }),
    )
    writeFileSync(
      join(codex, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'custom-codex-key' }),
    )
    const service = new ExecutorRuntimeService({
      root: f.root,
      home: join(f.root, 'unused-home'),
      environment: {
        PATH: '/fixture',
        CLAUDE_CONFIG_DIR: claude,
        CODEX_HOME: codex,
      },
    })
    const a = await service.prepare(
      {
        ...defaultExecutorConfig().profiles[0]!,
        authRef: { kind: 'managed-cli-login' },
      },
      'dlg-custom-claude',
    )
    const b = await service.prepare(
      {
        ...defaultExecutorConfig().profiles[1]!,
        authRef: { kind: 'managed-cli-login' },
      },
      'dlg-custom-codex',
    )
    expect(a.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe('custom-claude-token')
    expect(b.environment.OPENAI_API_KEY).toBe('custom-codex-key')
    expect(a.environment.CLAUDE_CONFIG_DIR).not.toBe(claude)
    expect(b.environment.CODEX_HOME).not.toBe(codex)
    expect(
      existsSync(join(a.environment.CLAUDE_CONFIG_DIR!, 'settings.json')),
    ).toBe(false)
  } finally {
    f.cleanup()
  }
})
it('stages only explicit managed Codex auth fields into a private per-conversation home', async () => {
  const f = delegationTestDirectory(),
    home = join(f.root, 'host-home')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'fixture-access',
        refresh_token: 'fixture-refresh',
        id_token: 'fixture-id',
        account_id: 'fixture-account',
        unrelated: 'omit',
      },
      last_refresh: '2026-10-16T00:00:00Z',
      otherSecret: 'omit',
    }),
  )
  const runtime = await new ExecutorRuntimeService({
    root: f.root,
    home,
    environment: { PATH: '/fixture' },
  }).prepare(
    {
      ...defaultExecutorConfig().profiles[1]!,
      authRef: { kind: 'managed-cli-login' },
    },
    'dlg-codex',
  )
  const path = join(runtime.environment.CODEX_HOME!, 'auth.json'),
    auth = JSON.parse(readFileSync(path, 'utf8'))
  expect(auth.tokens.access_token).toBe('fixture-access')
  expect(auth.tokens.unrelated).toBeUndefined()
  expect(auth.otherSecret).toBeUndefined()
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(runtime.secretValues).toContain('fixture-access')
  auth.tokens.access_token = 'refreshed-fixture'
  writeFileSync(path, JSON.stringify(auth))
  await new ExecutorRuntimeService({
    root: f.root,
    home,
    environment: { PATH: '/fixture' },
  }).prepare(
    {
      ...defaultExecutorConfig().profiles[1]!,
      authRef: { kind: 'managed-cli-login' },
    },
    'dlg-codex',
  )
  expect(JSON.parse(readFileSync(path, 'utf8')).tokens.access_token).toBe(
    'refreshed-fixture',
  )
  expect(existsSync(join(runtime.environment.CODEX_HOME!, 'config.toml'))).toBe(
    false,
  )
  f.cleanup()
})
it('imports only explicit managed credential/env keys into per-conversation runtime, without copying settings or plugins', async () => {
  const f = delegationTestDirectory()
  const home = join(f.root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'fixture-secret',
        ANTHROPIC_BASE_URL: 'https://fixture.invalid',
        ANTHROPIC_MODEL: 'fixture-model',
        INJECTED_SECRET: 'never-import',
      },
      enabledPlugins: { bad: true },
    }),
  )
  const profile = {
    ...defaultExecutorConfig().profiles[0]!,
    authRef: { kind: 'managed-cli-login' as const },
  }
  const service = new ExecutorRuntimeService({
    root: f.root,
    home,
    environment: { PATH: '/fixture/bin', UNRELATED_SECRET: 'omit' },
  })
  const a = await service.prepare(profile, 'dlg-a'),
    b = await service.prepare(profile, 'dlg-b')
  expect(a.runtimeRoot).not.toBe(b.runtimeRoot)
  expect(a.environment.ANTHROPIC_AUTH_TOKEN).toBe('fixture-secret')
  expect(a.environment.ANTHROPIC_MODEL).toBe('fixture-model')
  expect(a.environment.INJECTED_SECRET).toBeUndefined()
  expect(a.environment.UNRELATED_SECRET).toBeUndefined()
  expect(a.secretValues).toContain('fixture-secret')
  expect(a.environment.CLAUDE_CONFIG_DIR).not.toBe(join(home, '.claude'))
  expect(a.environment.CLAUDE_CODE_TMPDIR).toBe(a.tempRoot)
  expect(
    existsSync(join(a.environment.CLAUDE_CONFIG_DIR!, 'settings.json')),
  ).toBe(false)
  f.cleanup()
})
it('model-route credential resolution does not silently use ambient login', async () => {
  const f = delegationTestDirectory()
  const service = new ExecutorRuntimeService({
    root: f.root,
    home: f.root,
    environment: { ANTHROPIC_API_KEY: 'ambient' },
    resolveRoute: async () => ({
      apiKey: 'route-fixture',
      baseUrl: 'https://fixture.invalid',
    }),
  })
  const runtime = await service.prepare(
    {
      ...defaultExecutorConfig().profiles[0]!,
      authRef: { kind: 'model-route', routeId: 'selected-route' },
    },
    'dlg-route',
  )
  expect(runtime.environment.ANTHROPIC_API_KEY).toBe('route-fixture')
  expect(runtime.secretValues).not.toContain('ambient')
  await expect(
    service.prepare(
      {
        ...defaultExecutorConfig().profiles[0]!,
        authRef: { kind: 'model-route', routeId: '' },
      },
      'dlg-invalid',
    ),
  ).rejects.toThrow('AUTH_REQUIRED')
  f.cleanup()
})
