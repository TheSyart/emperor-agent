import { afterEach, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExecutorModelCatalogService } from './models'
import { ExecutorRuntimeService } from './runtime'
import { ExecutorFactsStore } from './facts'
import type { NormalizedExecutorEvent } from './types'
import { defaultExecutorConfig } from './config'
import { acquireCodexAuth } from './codex-auth'
import { readNativeModels } from './native-models'
import { ManagedAgentProcess } from './process'
const roots: string[] = []
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'executor-models-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'fixture-private-key' }),
  )
  const runtime = new ExecutorRuntimeService({
    root,
    home,
    environment: { PATH: '/fixture' },
  })
  return { root, home, runtime, profile: defaultExecutorConfig().profiles[1]! }
}
it('deduplicates native, configured and custom models without certifying tool availability', async () => {
  const f = fixture(),
    readNative = vi.fn(async () => [
      { id: 'native-model', name: 'Native Model' },
    ])
  const service = new ExecutorModelCatalogService({ ...f, readNative })
  const value = await service.list({
    ...f.profile,
    defaultModel: 'configured-model',
    customModels: ['native-model', 'team/remote'],
  })
  expect(value.models.filter((x) => x.id === 'native-model')).toHaveLength(1)
  expect(value.models).toContainEqual(
    expect.objectContaining({ id: 'team/remote', source: 'custom' }),
  )
  expect(value.models).toContainEqual(
    expect.objectContaining({
      id: 'configured-model',
      source: 'configuration',
    }),
  )
  expect(JSON.stringify(value)).not.toContain('fixture-private-key')
  expect(value.models.every((x) => !('available' in x))).toBe(true)
})
it('reuses a same-context cache across restart and preserves it on forced refresh failure', async () => {
  const f = fixture(),
    readNative = vi.fn(async () => [{ id: 'native-model' }])
  const first = new ExecutorModelCatalogService({ ...f, readNative })
  await first.list(f.profile)
  const failed = vi.fn(async () => {
    throw Error('network')
  })
  const second = new ExecutorModelCatalogService({ ...f, readNative: failed })
  const cached = await second.list(f.profile)
  expect(failed).not.toHaveBeenCalled()
  expect(cached.models).toContainEqual(
    expect.objectContaining({ id: 'native-model', source: 'cache' }),
  )
  const refreshed = await second.list(f.profile, true)
  expect(failed).toHaveBeenCalledOnce()
  expect(refreshed.models).toContainEqual(
    expect.objectContaining({ id: 'native-model', source: 'cache' }),
  )
  expect(refreshed.diagnostic).toBeTruthy()
})
it('isolates provider/identity changes and avoids offering native fallback models for an unknown gateway', async () => {
  const f = fixture(),
    readNative = vi.fn(async () => [{ id: 'original-model' }])
  const service = new ExecutorModelCatalogService({ ...f, readNative })
  await service.list(f.profile)
  writeFileSync(
    join(f.home, '.codex', 'config.toml'),
    'model="gateway-model"\nmodel_provider="gateway"\n[model_providers.gateway]\nname="Gateway"\nbase_url="http://127.0.0.1:12345/v1"\nwire_api="responses"\nrequires_openai_auth=false\n',
  )
  readNative.mockRejectedValueOnce(Error('offline'))
  const value = await service.list(f.profile)
  expect(readNative).toHaveBeenCalledTimes(2)
  expect(value.models.map((x) => x.id)).toContain('gateway-model')
  expect(value.models.map((x) => x.id)).not.toContain('original-model')
  expect(value.models.some((x) => x.source === 'builtin')).toBe(false)
})
it('refreshes discovery credentials after local re-login, matching a fresh execution runtime', async () => {
  const f = fixture(),
    accounts: string[] = []
  const login = (account: string) =>
    writeFileSync(
      join(f.home, '.codex', 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          account_id: account,
          access_token: account + '-access',
          refresh_token: account + '-refresh',
        },
      }),
    )
  login('account-A')
  const service = new ExecutorModelCatalogService({
    ...f,
    readNative: async (_profile, runtime) => {
      accounts.push(
        JSON.parse(
          readFileSync(
            join(runtime.environment.CODEX_HOME!, 'auth.json'),
            'utf8',
          ),
        ).tokens.account_id,
      )
      return [{ id: 'model-' + accounts.length }]
    },
  })
  await service.list(f.profile, true)
  login('account-B')
  await service.list(f.profile, true)
  expect(accounts).toEqual(['account-A', 'account-B'])
})
it('does not present bundled OpenAI rows as discovered gateway models when provider id remains openai', async () => {
  const f = fixture()
  writeFileSync(
    join(f.home, '.codex', 'config.toml'),
    'model="team-coder"\nmodel_provider="openai"\n[model_providers.openai]\nname="Gateway"\nbase_url="https://gateway.example/v1"\nwire_api="responses"\nrequires_openai_auth=false\n',
  )
  const service = new ExecutorModelCatalogService({
    ...f,
    readNative: async () => [{ id: 'openai-only-model' }],
  })
  const value = await service.list(f.profile, true)
  expect(value.models.map((m) => m.id)).toEqual(['team-coder'])
})
it('awaits in-flight model discovery cleanup on close', async () => {
  const f = fixture()
  let release!: () => void, started!: () => void
  const ready = new Promise<void>((r) => (started = r)),
    gate = new Promise<void>((r) => (release = r))
  const service = new ExecutorModelCatalogService({
    ...f,
    readNative: async () => {
      started()
      await gate
      return []
    },
  })
  const pending = service.list(f.profile, true)
  await ready
  const closing = service.close()
  try {
    expect(closing).toBeInstanceOf(Promise)
  } finally {
    release()
    await pending
    await closing
  }
})

it('rebinding model discovery after account changes makes old verified evidence stale', async () => {
  const f = fixture(),
    facts = new ExecutorFactsStore(f.root)
  const context = {
    cwd: f.root,
    runId: 'dgr-model-facts',
    delegationId: 'dlg-model-facts',
    permissionMode: 'workspace-write' as const,
  }
  const prepared = await f.runtime.prepare(f.profile, context.delegationId)
  facts.bind(f.profile, prepared.environment, context.runId)
  const emit = (event: Record<string, unknown>) =>
    facts.observe(f.profile, context, {
      ...context,
      generation: 1,
      ...event,
    } as unknown as NormalizedExecutorEvent)
  emit({
    type: 'runtime_metadata',
    model: 'native-model',
    provider: 'openai',
    source: 'initialization',
    advertisedTools: [],
    searchMode: 'live',
  })
  for (const action of ['search', 'fetch'])
    emit({
      type: 'tool_finished',
      id: action,
      status: 'completed',
      evidence: {
        kind: 'search',
        action,
        success: true,
        references: ['https://example.com'],
        searchMode: 'live',
      },
    })
  expect(facts.view(f.profile).nativeCapabilities.search.status).toBe(
    'available',
  )
  writeFileSync(
    join(f.home, '.codex', 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'new-fixture-account' }),
  )
  const service = new ExecutorModelCatalogService({
    ...f,
    readNative: async () => [],
    onPrepared: (profile, runtime) => facts.bind(profile, runtime.environment),
  })
  await service.list(f.profile, true)
  expect(facts.view(f.profile).nativeCapabilities.search.status).toBe('stale')
})

it('keeps configured and native fallback choices without login and never starts a claude that is not signed in', async () => {
  const f = fixture(),
    home = join(f.root, 'unauthenticated-home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ model: 'opus' }),
  )
  const runtime = new ExecutorRuntimeService({
      root: f.root,
      home,
      environment: { PATH: '/fixture' },
    }),
    readNative = vi.fn(async () => [])
  // The last 设置 check: claude auth status said it is not signed in.
  const service = new ExecutorModelCatalogService({
    ...f,
    runtime,
    readNative,
    signedIn: () => false,
  })
  const value = await service.list(defaultExecutorConfig().profiles[0]!, true)
  expect(value.configuredModel).toBe('opus')
  expect(value.models.map((m) => m.id)).toEqual(
    expect.arrayContaining(['opus', 'sonnet', 'haiku']),
  )
  expect(value.diagnostic).toContain('还没有登录')
  expect(readNative).not.toHaveBeenCalled()
  // Whether it is signed in is claude's to say (AGT-12): the runtime
  // prepares without a credential of Emperor's.
  const prepared = await runtime.prepare(
    defaultExecutorConfig().profiles[0]!,
    'dlg-own-login',
  )
  expect(prepared.auth).toEqual({ source: null })
})

it('reads a Codex model without login while keeping ordinary execution authentication strict', async () => {
  const f = fixture(),
    home = join(f.root, 'no-codex-login')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    'model="configured-coder"\n',
  )
  const runtime = new ExecutorRuntimeService({
      root: f.root,
      home,
      environment: { PATH: '/fixture' },
    }),
    readNative = vi.fn(async () => [])
  const service = new ExecutorModelCatalogService({ ...f, runtime, readNative })
  const value = await service.list(f.profile, true)
  expect(value.configuredModel).toBe('configured-coder')
  expect(value.models.some((m) => m.source === 'builtin')).toBe(true)
  expect(readNative).not.toHaveBeenCalled()
  await expect(
    runtime.prepare(f.profile, 'dlg-requires-codex-login'),
  ).rejects.toThrow('AUTH_REQUIRED')
})

it('never waits behind a running Codex task to list models, and never starts a second process on the login', async () => {
  const f = fixture()
  writeFileSync(
    join(f.home, '.codex', 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'a', refresh_token: 'r', account_id: 'x' },
    }),
  )
  const runtime = await f.runtime.prepare(f.profile, 'dlg-models-busy')
  expect(runtime.codexAuth).toBeDefined()
  const running = (await acquireCodexAuth(runtime.codexAuth!))!
  const processes = new ManagedAgentProcess()
  const spawn = vi.spyOn(processes, 'spawn')
  await expect(
    readNativeModels(
      f.profile,
      runtime,
      processes,
      new AbortController().signal,
    ),
  ).rejects.toThrow('another Codex process')
  expect(spawn).not.toHaveBeenCalled()
  await running.release()
})

/** A ChatGPT login: the one whose model list is the account's own. */
function chatGptLogin(home: string) {
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'a', refresh_token: 'r', account_id: 'x' },
    }),
  )
}

it('FIX-16 · 6 · the catalog says when Codex’s own default is not in the list this login offers, and what a run uses instead', async () => {
  const f = fixture()
  chatGptLogin(f.home)
  writeFileSync(join(f.home, '.codex', 'config.toml'), 'model="gpt-6.1-sol"\n')
  const offered = [
    { id: 'gpt-6-astra' },
    { id: 'gpt-5.6-sol', isDefault: true },
    { id: 'gpt-5.6-terra' },
    { id: 'gpt-5.5-legacy', hidden: true },
  ]
  const service = new ExecutorModelCatalogService({
    ...f,
    readNative: async () => offered,
  })
  const value = await service.list(f.profile, true)
  expect(value.defaultUnavailable).toEqual({
    model: 'gpt-6.1-sol',
    replacement: 'gpt-5.6-sol',
  })
  // A model hidden from the picker is not offered there.
  expect(value.models.map((m) => m.id)).not.toContain('gpt-5.5-legacy')
  // From the cache too, after a restart.
  const again = new ExecutorModelCatalogService({
    ...f,
    readNative: async () => {
      throw Error('not asked')
    },
  })
  expect((await again.list(f.profile)).defaultUnavailable).toEqual({
    model: 'gpt-6.1-sol',
    replacement: 'gpt-5.6-sol',
  })
  // The user's own configuration file is only read.
  expect(readFileSync(join(f.home, '.codex', 'config.toml'), 'utf8')).toBe(
    'model="gpt-6.1-sol"\n',
  )
})

it('FIX-16 · 6 · no hint for a default the list offers (hidden included), without a list, or with an API key', async () => {
  const f = fixture()
  chatGptLogin(f.home)
  writeFileSync(
    join(f.home, '.codex', 'config.toml'),
    'model="gpt-5.5-legacy"\n',
  )
  const offered = new ExecutorModelCatalogService({
    ...f,
    readNative: async () => [
      { id: 'gpt-5.6-sol', isDefault: true },
      { id: 'gpt-5.5-legacy', hidden: true },
    ],
  })
  expect((await offered.list(f.profile, true)).defaultUnavailable).toBeNull()
  const g = fixture()
  chatGptLogin(g.home)
  writeFileSync(join(g.home, '.codex', 'config.toml'), 'model="gpt-6.1-sol"\n')
  const unknown = new ExecutorModelCatalogService({
    ...g,
    readNative: async () => {
      throw Error('offline')
    },
  })
  const value = await unknown.list(g.profile, true)
  expect(value.models.some((m) => m.source === 'builtin')).toBe(true)
  expect(value.defaultUnavailable).toBeNull()
  // An API key's models are not decided by Codex's list.
  const k = fixture()
  writeFileSync(join(k.home, '.codex', 'config.toml'), 'model="gpt-4.1"\n')
  const apiKey = new ExecutorModelCatalogService({
    ...k,
    readNative: async () => [{ id: 'gpt-5.6-sol', isDefault: true }],
  })
  expect((await apiKey.list(k.profile, true)).defaultUnavailable).toBeNull()
})

it('FIX-16 · the model list asks Codex for hidden models too and keeps its default and hidden flags', async () => {
  const f = fixture()
  const runtime = await f.runtime.prepare(f.profile, 'dlg-models-flags')
  const { fakeCodexProcesses, fakeCodexRequests } = await import('./testing')
  const rows = await readNativeModels(
    f.profile,
    runtime,
    fakeCodexProcesses({
      defaultModel: 'gpt-6.1-sol',
      models: [
        { id: 'gpt-6-astra' },
        { id: 'gpt-5.6-sol', isDefault: true },
        { id: 'gpt-5.5-legacy', hidden: true },
      ],
    }),
    new AbortController().signal,
  )
  expect(rows).toEqual([
    { id: 'gpt-6-astra', name: 'gpt-6-astra' },
    { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', isDefault: true },
    { id: 'gpt-5.5-legacy', name: 'gpt-5.5-legacy', hidden: true },
  ])
  expect(
    fakeCodexRequests(runtime.tempRoot).find((r) => r.method === 'model/list')
      ?.includeHidden,
  ).toBe(true)
})

it('AGT-13 · the model list starts Codex with the same feature overrides as a run', async () => {
  const f = fixture()
  const runtime = await f.runtime.prepare(f.profile, 'dlg-models-features')
  const { fakeCodexProcesses } = await import('./testing')
  const { codexAppServerArgs } = await import('./adapters/codex')
  const processes = fakeCodexProcesses({ models: [{ id: 'gpt-6.1-sol' }] })
  const spawn = vi.spyOn(processes, 'spawn')
  await readNativeModels(
    f.profile,
    runtime,
    processes,
    new AbortController().signal,
  )
  expect(spawn.mock.calls[0]![0].args).toEqual(codexAppServerArgs())
  expect(spawn.mock.calls[0]![0].args.join(' ')).toContain(
    'features.daemon_auto_start=false',
  )
})

it('VER-04 · the Claude model list launches with the ledger’s builtins off, not a list of its own', async () => {
  const f = fixture()
  const claude = defaultExecutorConfig().profiles[0]!
  const runtime = await f.runtime.prepare(claude, 'dlg-models-claude')
  const { BuiltinPluginLedger } = await import('./claude-builtin-plugins')
  const ledger = new BuiltinPluginLedger()
  ledger.learn([{ name: 'x', path: 'builtin', source: 'x@builtin' }], '2.1.312')
  let settings: Record<string, unknown> | undefined
  const rows = await readNativeModels(
    claude,
    runtime,
    new ManagedAgentProcess(),
    new AbortController().signal,
    {
      ledger,
      startup: async (options) => {
        settings = options.settings as Record<string, unknown>
        return {
          close: () => undefined,
          query: () =>
            ({
              supportedModels: async () => [
                { value: 'opus', displayName: 'Opus' },
              ],
              close: () => undefined,
            }) as never,
        }
      },
    },
  )
  expect(rows).toEqual([{ id: 'opus', name: 'Opus' }])
  expect(settings?.enabledPlugins).toEqual({
    'agents-md@builtin': false,
    'cc-plugin-agents-md@builtin': false,
    'cc-plugin-plugin-authoring@builtin': false,
    'telemetry@builtin': false,
    'x@builtin': false,
  })
})
