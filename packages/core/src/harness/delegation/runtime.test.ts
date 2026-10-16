import { expect, it } from 'vitest'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ExecutorRuntimeService } from './runtime'
import { delegationTestDirectory } from './testing'
import { defaultExecutorConfig } from './config'
import { readFileSync, statSync } from 'node:fs'
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
