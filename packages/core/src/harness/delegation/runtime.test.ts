import { expect, it } from 'vitest'
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  readFileSync,
  lstatSync,
  readlinkSync,
  readdirSync,
} from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { ExecutorRuntimeService } from './runtime'
import { delegationTestDirectory } from './testing'
import { defaultExecutorConfig } from './config'
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
it('links the managed Codex login into the private home instead of forking the refresh token', async () => {
  const f = delegationTestDirectory(),
    home = join(f.root, 'host-home')
  mkdirSync(join(home, '.codex'), { recursive: true })
  const source = join(home, '.codex', 'auth.json')
  writeFileSync(
    source,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'fixture-access',
        refresh_token: 'fixture-refresh',
        id_token: 'fixture-id',
        account_id: 'fixture-account',
      },
      last_refresh: '2026-10-16T00:00:00Z',
    }),
  )
  const service = new ExecutorRuntimeService({
    root: f.root,
    home,
    environment: { PATH: '/fixture' },
  })
  const runtime = await service.prepare(
    {
      ...defaultExecutorConfig().profiles[1]!,
      authRef: { kind: 'managed-cli-login' },
    },
    'dlg-codex',
  )
  const path = join(runtime.environment.CODEX_HOME!, 'auth.json')
  expect(lstatSync(path).isSymbolicLink()).toBe(true)
  expect(readlinkSync(path)).toBe(source)
  expect(runtime.codexAuth).toEqual({ source, isolated: path })
  expect(runtime.secretValues).toContain('fixture-refresh')
  // No file under the runtime root holds the refresh token.
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : entry.isFile()
          ? [join(dir, entry.name)]
          : [],
    )
  for (const file of files(runtime.runtimeRoot))
    expect(readFileSync(file, 'utf8')).not.toContain('fixture-refresh')
  // Preparing the same conversation again keeps the link.
  await service.prepare(
    {
      ...defaultExecutorConfig().profiles[1]!,
      authRef: { kind: 'managed-cli-login' },
    },
    'dlg-codex',
  )
  expect(readlinkSync(path)).toBe(source)
  expect(existsSync(join(runtime.environment.CODEX_HOME!, 'config.toml'))).toBe(
    false,
  )
  f.cleanup()
})
it('API key mode passes only OPENAI_API_KEY and leaves no auth.json in the private home', async () => {
  const f = delegationTestDirectory(),
    home = join(f.root, 'host-home')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-key' }),
  )
  const service = new ExecutorRuntimeService({
    root: f.root,
    home,
    environment: { PATH: '/fixture' },
  })
  const profile = {
    ...defaultExecutorConfig().profiles[1]!,
    authRef: { kind: 'managed-cli-login' as const },
  }
  const first = await service.prepare(profile, 'dlg-api-key')
  // A copy forked by an older build is removed, not reused.
  writeFileSync(
    join(first.environment.CODEX_HOME!, 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'old' } }),
  )
  const runtime = await service.prepare(profile, 'dlg-api-key')
  expect(runtime.environment.OPENAI_API_KEY).toBe('fixture-key')
  expect(runtime.codexAuth).toBeUndefined()
  expect(existsSync(join(runtime.environment.CODEX_HOME!, 'auth.json'))).toBe(
    false,
  )
  f.cleanup()
})
it('probes reuse one long-lived private directory and sweep the old per-probe copies', async () => {
  const f = delegationTestDirectory(),
    home = join(f.root, 'host-home')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'a', refresh_token: 'r', account_id: 'x' },
    }),
  )
  const profile = defaultExecutorConfig().profiles[1]!
  const legacy = join(
    f.root,
    'runtime',
    profile.stateDirectoryId,
    'dlg-probe-0b6ad0c3-legacy',
  )
  mkdirSync(join(legacy, 'codex'), { recursive: true })
  writeFileSync(join(legacy, 'codex', 'auth.json'), '{"tokens":{}}')
  const service = new ExecutorRuntimeService({
    root: f.root,
    home,
    environment: { PATH: '/fixture' },
  })
  const a = await service.probe(profile),
    b = await service.probe(profile)
  expect(a.runtimeRoot).toBe(b.runtimeRoot)
  const entries = readdirSync(join(f.root, 'runtime', profile.stateDirectoryId))
  expect(entries.filter((name) => name.startsWith('dlg-probe-'))).toEqual([])
  expect(entries).toHaveLength(1)
  f.cleanup()
})
it('keeps an Azure provider query_params, such as api-version', async () => {
  const f = delegationTestDirectory(),
    home = join(f.root, 'host-home')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    'model = "gpt-5-codex"\nmodel_provider = "azure"\n[model_providers.azure]\nname = "Azure"\nbase_url = "https://fixture.openai.azure.com/openai"\nenv_key = "AZURE_OPENAI_API_KEY"\nwire_api = "responses"\nquery_params = { api-version = "2025-04-01-preview" }\n',
  )
  try {
    const runtime = await new ExecutorRuntimeService({
      root: f.root,
      home,
      environment: { PATH: '/fixture', AZURE_OPENAI_API_KEY: 'fixture-azure' },
    }).prepare(defaultExecutorConfig().profiles[1]!, 'dlg-azure')
    const { parse } = await import('smol-toml')
    const config = parse(
      readFileSync(
        join(runtime.environment.CODEX_HOME!, 'config.toml'),
        'utf8',
      ),
    ) as any
    expect(config.model_providers.azure.query_params).toEqual({
      'api-version': '2025-04-01-preview',
    })
    expect(runtime.environment.EMPEROR_CODEX_PROVIDER_TOKEN).toBe(
      'fixture-azure',
    )
  } finally {
    f.cleanup()
  }
})
it('reads a provider env_key from the login shell when started from the Dock', async () => {
  const f = delegationTestDirectory(),
    home = join(f.root, 'host-home')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    'model_provider = "team"\n[model_providers.team]\nname = "Team"\nbase_url = "https://gateway.example/v1"\nenv_key = "TEAM_TOKEN"\nwire_api = "responses"\n[model_providers.team.env_http_headers]\nX-Team = "TEAM_HEADER"\n',
  )
  const asked: string[][] = []
  try {
    const service = new ExecutorRuntimeService({
      root: f.root,
      home,
      // A Dock launch: the process has none of the shell exports.
      environment: { PATH: '/usr/bin:/bin' },
      loginShell: {
        read: async (names) => {
          asked.push([...names])
          return { TEAM_TOKEN: 'from-zshrc', TEAM_HEADER: 'header-from-zshrc' }
        },
      },
    })
    const runtime = await service.prepare(
      defaultExecutorConfig().profiles[1]!,
      'dlg-dock',
    )
    expect(runtime.environment.EMPEROR_CODEX_PROVIDER_TOKEN).toBe('from-zshrc')
    expect(Object.values(runtime.environment)).toContain('header-from-zshrc')
    expect(runtime.secretValues).toContain('from-zshrc')
    // Only the variables the provider names are asked for.
    expect(asked).toEqual([['TEAM_HEADER', 'TEAM_TOKEN']])
    // The login shell wins over a stale process value; the process env is the fallback.
    const fallback = await new ExecutorRuntimeService({
      root: f.root,
      home,
      environment: { PATH: '/fixture', TEAM_TOKEN: 'from-process' },
      loginShell: { read: async () => ({}) },
    }).prepare(defaultExecutorConfig().profiles[1]!, 'dlg-terminal')
    expect(fallback.environment.EMPEROR_CODEX_PROVIDER_TOKEN).toBe(
      'from-process',
    )
  } finally {
    f.cleanup()
  }
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

it('inherits the selected Codex model/provider without importing hooks, MCP, permissions or credential commands', async () => {
  const f = delegationTestDirectory(),
    home = join(f.root, 'host-home')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    `model = "gateway-coder"\nmodel_provider = "gateway"\nnotify = ["do-not-run"]\napproval_policy = "never"\n[model_providers.gateway]\nname = "Team gateway"\nbase_url = "https://gateway.example/v1"\nwire_api = "responses"\nenv_key = "TEAM_TOKEN"\nrequires_openai_auth = false\n[mcp_servers.bad]\ncommand = "do-not-run"\n`,
  )
  try {
    const service = new ExecutorRuntimeService({
      root: f.root,
      home,
      environment: { PATH: '/fixture', TEAM_TOKEN: 'fixture-private-token' },
    })
    const runtime = await service.prepare(
      defaultExecutorConfig().profiles[1]!,
      'dlg-provider-config',
    )
    const { parse } = await import('smol-toml')
    const config = parse(
      readFileSync(
        join(runtime.environment.CODEX_HOME!, 'config.toml'),
        'utf8',
      ),
    ) as any
    expect(config).toMatchObject({
      model: 'gateway-coder',
      model_provider: 'gateway',
      model_providers: {
        gateway: {
          base_url: 'https://gateway.example/v1',
          wire_api: 'responses',
          requires_openai_auth: false,
        },
      },
    })
    expect(runtime.environment[config.model_providers.gateway.env_key]).toBe(
      'fixture-private-token',
    )
    expect(runtime.secretValues).toContain('fixture-private-token')
    expect(config.notify).toBeUndefined()
    expect(config.approval_policy).toBeUndefined()
    expect(config.mcp_servers).toBeUndefined()
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain(
      'do-not-run',
    )
  } finally {
    f.cleanup()
  }
})
it('inherits Claude model selections and restrictions, while explicit profile model wins and hooks stay excluded', async () => {
  const f = delegationTestDirectory(),
    home = join(f.root, 'host-home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'team-coder',
      availableModels: ['team-coder', 'sonnet'],
      hooks: { bad: ['do-not-run'] },
      env: {
        ANTHROPIC_AUTH_TOKEN: 'fixture-key',
        ANTHROPIC_BASE_URL: 'https://gateway.example',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'team-coder',
      },
    }),
  )
  try {
    const service = new ExecutorRuntimeService({
      root: f.root,
      home,
      environment: { PATH: '/fixture' },
    })
    const runtime = await service.prepare(
      defaultExecutorConfig().profiles[0]!,
      'dlg-claude-model',
    )
    expect(runtime.environment.ANTHROPIC_MODEL).toBe('team-coder')
    expect(runtime.environment.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      'team-coder',
    )
    const config = JSON.parse(
      readFileSync(
        join(runtime.environment.CLAUDE_CONFIG_DIR!, 'settings.json'),
        'utf8',
      ),
    )
    expect(config).toEqual({
      model: 'team-coder',
      availableModels: ['team-coder', 'sonnet'],
    })
    const overridden = await service.prepare(
      {
        ...defaultExecutorConfig().profiles[0]!,
        defaultModel: 'explicit-coder',
      },
      'dlg-claude-explicit',
    )
    expect(overridden.environment.ANTHROPIC_MODEL).toBe('explicit-coder')
  } finally {
    f.cleanup()
  }
})
it('keeps an environment-configured Codex endpoint paired with its API key', async () => {
  const f = delegationTestDirectory()
  try {
    const runtime = await new ExecutorRuntimeService({
      root: f.root,
      home: join(f.root, 'empty'),
      environment: {
        PATH: '/fixture',
        OPENAI_API_KEY: 'fixture-gateway-key',
        OPENAI_BASE_URL: 'https://gateway.example/v1',
      },
    }).prepare(defaultExecutorConfig().profiles[1]!, 'dlg-env-provider')
    expect(runtime.environment.OPENAI_BASE_URL).toBe(
      'https://gateway.example/v1',
    )
    const { parse } = await import('smol-toml')
    const config = parse(
      readFileSync(
        join(runtime.environment.CODEX_HOME!, 'config.toml'),
        'utf8',
      ),
    ) as any
    expect(config.model_providers[config.model_provider].base_url).toBe(
      'https://gateway.example/v1',
    )
  } finally {
    f.cleanup()
  }
})
it('preserves Claude model picker and provider model ID mappings without unrelated settings', async () => {
  const f = delegationTestDirectory(),
    home = join(f.root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  const fields = {
    modelOverrides: { 'claude-sonnet': 'gateway/coder' },
    modelPicker: {
      replaceBuiltInOptions: true,
      options: [
        {
          model: 'gateway/coder',
          label: 'Team Coder',
          behavesAs: 'claude-sonnet',
        },
      ],
    },
  }
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      ...fields,
      hooks: { bad: 'do-not-import' },
      env: { ANTHROPIC_API_KEY: 'fixture-key' },
    }),
  )
  try {
    const runtime = await new ExecutorRuntimeService({
      root: f.root,
      home,
      environment: { PATH: '/fixture' },
    }).prepare(defaultExecutorConfig().profiles[0]!, 'dlg-picker')
    expect(
      JSON.parse(
        readFileSync(
          join(runtime.environment.CLAUDE_CONFIG_DIR!, 'settings.json'),
          'utf8',
        ),
      ),
    ).toEqual(fields)
  } finally {
    f.cleanup()
  }
})

it('inherits Claude model alias mappings from the process environment', async () => {
  const f = delegationTestDirectory()
  try {
    const runtime = await new ExecutorRuntimeService({
      root: f.root,
      home: join(f.root, 'empty'),
      environment: {
        PATH: '/fixture',
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'team-coder',
        ANTHROPIC_CUSTOM_MODEL_OPTION: 'team-custom',
      },
    }).prepare(defaultExecutorConfig().profiles[0]!, 'dlg-env-aliases')
    expect(runtime.environment.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      'team-coder',
    )
    expect(runtime.environment.ANTHROPIC_CUSTOM_MODEL_OPTION).toBe(
      'team-custom',
    )
  } finally {
    f.cleanup()
  }
})

it('AGT-08 · the task environment follows the 开发环境 switches; gh sign-in survives Claude’s credential scrub as a private hosts.yml', async () => {
  const f = delegationTestDirectory()
  try {
    let settings = {
      gitIdentity: true,
      proxy: true,
      sshAgent: false,
      toolchains: false,
      github: true,
    }
    const service = new ExecutorRuntimeService({
      root: f.root,
      home: f.root,
      environment: {
        PATH: '/usr/bin:/bin',
        HTTPS_PROXY: 'http://proxy.example:8080',
      },
      resolveRoute: async () => ({ apiKey: 'fixture-key' }),
      developmentEnvironment: () => settings,
      readGitIdentity: async () => ({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      }),
      readGhToken: async () => 'gho_fixture_token_value',
    })
    const profile = {
      ...defaultExecutorConfig().profiles[0]!,
      authRef: { kind: 'model-route' as const, routeId: 'fixture' },
    }
    const runtime = await service.prepare(profile, 'dlg-dev-env')
    expect(runtime.environment).toMatchObject({
      GIT_AUTHOR_NAME: 'Ada Lovelace',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      HTTPS_PROXY: 'http://proxy.example:8080',
      GH_TOKEN: 'gho_fixture_token_value',
    })
    expect(runtime.secretValues).toContain('gho_fixture_token_value')
    const hosts = join(runtime.environment.XDG_CONFIG_HOME!, 'gh', 'hosts.yml')
    expect(readFileSync(hosts, 'utf8')).toContain(
      'oauth_token: gho_fixture_token_value',
    )
    expect(lstatSync(hosts).mode & 0o777).toBe(0o600)

    // GitHub and the proxy off: no token anywhere, no proxy variable.
    settings = { ...settings, github: false, proxy: false }
    const again = await service.prepare(profile, 'dlg-dev-env')
    expect(again.environment.GH_TOKEN).toBeUndefined()
    expect(again.environment.HTTPS_PROXY).toBeUndefined()
    expect(existsSync(hosts)).toBe(false)

    // The login probe lists models only: none of this is prepared for it.
    const probe = await service.probe(profile)
    expect(probe.environment.GIT_AUTHOR_NAME).toBeUndefined()
  } finally {
    f.cleanup()
  }
})
