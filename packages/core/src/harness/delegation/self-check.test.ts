/**
 * VER-04: the offline self-check of an installed Claude Code or Codex. A
 * private folder under `<delegations>/self-check/`, a dummy key, the
 * Messages API on a stand-in on 127.0.0.1, no prompt: only what the CLI
 * reports at startup (plugins, MCP servers, hooks; Codex's protocol and
 * default features). Claude is the fake SDK (testing.ts), Codex fake
 * runners; nothing real runs.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuiltinPluginLedger } from './claude-builtin-plugins'
import { CODEX_FEATURES } from './adapters/codex'
import { defaultExecutorConfig } from './config'
import { EXECUTOR_HEALTH_FILE, ExecutorHealthStore } from './executor-health'
import {
  ExecutorSelfCheck,
  SELF_CHECK_DEDUPE_MS,
  type ExecutorSelfCheckOptions,
} from './self-check'
import { delegationTestDirectory, fakeClaudeSdk } from './testing'
import type {
  ExecutorOpenInput,
  ExecutorProbe,
  ExecutorProfile,
  ExecutorSession,
} from './types'
import codex01630 from './protocol/codex-0.163.0/features.json'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})
const LOADED = { timeout: 10_000 }

const claudeProfile = (): ExecutorProfile => ({
  ...defaultExecutorConfig().profiles.find((p) => p.backend === 'claude-code')!,
  enabled: true,
})
const codexProfile = (): ExecutorProfile => ({
  ...defaultExecutorConfig().profiles.find((p) => p.backend === 'codex')!,
  enabled: true,
})

function probeOf(over: Partial<ExecutorProbe> = {}): ExecutorProbe {
  return {
    status: 'available',
    checkedAt: 1,
    authVerified: false,
    capabilities: {} as ExecutorProbe['capabilities'],
    executableVersion: '2.1.310',
    ...over,
  }
}

/** A codex that never starts here: the adapter's open is faked. */
function codexOpen(fail?: Error) {
  const opened: ExecutorOpenInput[] = []
  return {
    opened,
    adapter: {
      backend: 'codex' as const,
      open: async (input: ExecutorOpenInput) => {
        opened.push(input)
        if (fail) throw fail
        return {
          close: async () => ({ quiescent: true }),
        } as unknown as ExecutorSession
      },
    },
  }
}

/** `codex features list` with Emperor's overrides, from a recording. */
function featureList(extraOn: string[] = []) {
  const recorded = (
    codex01630 as { features: Record<string, { enabled: boolean }> }
  ).features
  const effective = Object.fromEntries(
    Object.entries(recorded).map(([name, f]) => [
      name,
      name in CODEX_FEATURES ? CODEX_FEATURES[name]! : f.enabled,
    ]),
  )
  for (const name of extraOn) effective[name] = true
  return Object.entries(effective)
    .map(([name, on]) => `${name}  stable  ${on}`)
    .join('\n')
}

function setup(over: Partial<ExecutorSelfCheckOptions> = {}) {
  const d = delegationTestDirectory()
  cleanup.push(d.cleanup)
  const root = join(d.root, 'delegations')
  mkdirSync(root, { recursive: true })
  const health = new ExecutorHealthStore(root)
  const ledger = new BuiltinPluginLedger(join(root, 'claude-code'))
  const probes: Record<string, ExecutorProbe> = {
    'claude-code': probeOf(),
    codex: probeOf({
      executableVersion: '0.163.0',
      compatibility: 'verified',
      protocolVersion: '0.163.0',
    }),
  }
  const changed = vi.fn()
  const check = new ExecutorSelfCheck({
    root,
    registry: {
      probe: async (profile) => probes[profile.backend]!,
      locate: async () => '/opt/fake/bin/claude',
    },
    environment: () => ({ PATH: '/usr/bin:/bin', HOME: join(d.root, 'user') }),
    health,
    ledger,
    changed,
    codexFeatures: async () => featureList(),
    codexAdapter: codexOpen().adapter,
    ...over,
  })
  cleanup.push(() => check.close())
  return { root, health, ledger, probes, changed, check, dir: d.root }
}

const healthFile = (root: string) =>
  JSON.parse(readFileSync(join(root, EXECUTOR_HEALTH_FILE), 'utf8'))

describe('Claude Code', () => {
  it('4 · a builtin the CLI ships is turned off and verified: adapted, learned, no prompt', async () => {
    const sdk = fakeClaudeSdk({
      version: '2.1.310',
      plugins: [
        {
          name: 'cc-plugin-plugin-authoring',
          path: 'builtin',
          source: 'cc-plugin-plugin-authoring@builtin',
        },
        { name: 'x', path: 'builtin', source: 'x@builtin' },
      ],
    })
    const s = setup({ claudeStartup: sdk.startup })
    const result = await s.check.run(claudeProfile(), 'manual')
    expect(result).toMatchObject({
      backend: 'claude-code',
      version: '2.1.310',
      status: 'adapted',
      issues: [],
      modelCalls: 0,
      adapted: {
        builtinPluginsDisabled: [
          'cc-plugin-plugin-authoring@builtin',
          'x@builtin',
        ],
        // When each first came: the verified list, then this version.
        since: {
          'cc-plugin-plugin-authoring@builtin': '2.1.308',
          'x@builtin': '2.1.310',
        },
      },
    })
    // Started raw (nothing off), then turned them off in the process and
    // checked again: the mechanism a run relies on works on this version.
    expect(sdk.launches).toHaveLength(1)
    expect(sdk.launches[0]!.settings).toMatchObject({ enabledPlugins: {} })
    expect(sdk.controlRequests.map((r) => r.subtype)).toEqual([
      'reload_plugins',
      'apply_flag_settings',
      'reload_plugins',
      'mcp_server_status',
    ])
    expect(sdk.modelCalls).toBe(0)
    // The new builtin is in Emperor's ledger for the next run.
    expect(s.ledger.disabled()).toContain('x@builtin')
    // And in the health record of that version.
    expect(
      healthFile(s.root).profiles['claude-default'].versions['2.1.310']
        .selfCheck,
    ).toMatchObject({ status: 'adapted', modelCalls: 0 })
    expect(s.changed).toHaveBeenCalledWith('claude-default')
  })

  it('nothing to turn off: ok', async () => {
    const sdk = fakeClaudeSdk({ version: '2.1.281' })
    const s = setup({ claudeStartup: sdk.startup })
    s.probes['claude-code'] = probeOf({ executableVersion: '2.1.281' })
    expect(await s.check.run(claudeProfile(), 'manual')).toMatchObject({
      status: 'ok',
      issues: [],
    })
  })

  it('5 · an MCP server: incompatible, blocking, with the Chinese reason', async () => {
    const sdk = fakeClaudeSdk({ mcpServers: ['x'] })
    const s = setup({ claudeStartup: sdk.startup })
    const result = await s.check.run(claudeProfile(), 'manual')
    expect(result).toMatchObject({
      status: 'incompatible',
      issues: [
        {
          code: 'mcp_server',
          detail: 'Claude Code 加载了 MCP server：x。子智能体不允许使用 MCP。',
          blocking: true,
        },
      ],
    })
    expect(sdk.modelCalls).toBe(0)
  })

  it('a plugin from disk, a builtin that stays on, hooks not applied: each blocking', async () => {
    const foreign = fakeClaudeSdk({
      plugins: [{ name: 'foo', path: '/Users/ada/foo', source: 'foo@market' }],
    })
    expect(
      (
        await setup({ claudeStartup: foreign.startup }).check.run(
          claudeProfile(),
          'manual',
        )
      ).issues,
    ).toMatchObject([{ code: 'unapproved_plugin', blocking: true }])
    const stuck = fakeClaudeSdk({
      plugins: [{ name: 'x', path: 'builtin', source: 'x@builtin' }],
      honoursFlagSettings: false,
    })
    expect(
      (
        await setup({ claudeStartup: stuck.startup }).check.run(
          claudeProfile(),
          'manual',
        )
      ).issues,
    ).toMatchObject([{ code: 'builtin_not_disabled', blocking: true }])
    const hooks = fakeClaudeSdk({ hooksApplied: false })
    const result = await setup({ claudeStartup: hooks.startup }).check.run(
      claudeProfile(),
      'manual',
    )
    expect(result.status).toBe('incompatible')
    expect(result.issues).toMatchObject([
      { code: 'hooks_not_applied', blocking: true },
    ])
  })

  it('12 · its own folder under <delegations>/self-check, removed afterwards; never the user’s HOME', async () => {
    const sdk = fakeClaudeSdk()
    const s = setup({ claudeStartup: sdk.startup })
    const userHome = join(s.dir, 'user')
    mkdirSync(userHome)
    chmodSync(userHome, 0o555)
    cleanup.unshift(() => chmodSync(userHome, 0o755))
    await s.check.run(claudeProfile(), 'manual')
    const env = sdk.launches[0]!.env as Record<string, string>
    const own = join(s.root, 'self-check')
    expect(env.HOME!.startsWith(own)).toBe(true)
    expect(env.CLAUDE_CONFIG_DIR!.startsWith(own)).toBe(true)
    expect(Object.values(env).some((v) => v.includes(userHome))).toBe(false)
    // A dummy key and the Messages API on 127.0.0.1: no model is reachable.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-offline-probe')
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(env).toMatchObject({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    })
    // Its keychain lookups get the stand-in `security` (FIX-19).
    expect(env.PATH!.split(':')[0]!.startsWith(own)).toBe(true)
    expect(readdirSync(own)).toEqual([])
    expect(existsSync(join(userHome, '.claude'))).toBe(false)
  })

  it('a check that does not finish in time is an error, never a block', async () => {
    const s = setup({
      claudeStartup: () => new Promise<never>(() => {}),
      timeoutMs: 150,
    })
    const result = await s.check.run(claudeProfile(), 'manual')
    expect(result).toMatchObject({
      status: 'error',
      issues: [{ code: 'timeout', blocking: false }],
    })
    expect(readdirSync(join(s.root, 'self-check'))).toEqual([])
  })

  it('a CLI that cannot start is an error; a version it cannot read is not checked at all', async () => {
    const s = setup({
      claudeStartup: async () => {
        throw new Error('spawn ENOENT')
      },
    })
    expect(await s.check.run(claudeProfile(), 'manual')).toMatchObject({
      status: 'error',
      issues: [{ code: 'start_failed', blocking: false }],
    })
    s.probes['claude-code'] = probeOf({ executableVersion: undefined })
    const unknown = await s.check.run(claudeProfile(), 'manual')
    expect(unknown.status).toBe('error')
    expect(
      Object.keys(healthFile(s.root).profiles['claude-default'].versions),
    ).toEqual(['2.1.310'])
  })
})

describe('Codex', () => {
  it('6 · a protocol digest Emperor did not verify: protocol_unknown, blocking', async () => {
    const s = setup()
    s.probes.codex = probeOf({
      executableVersion: '0.163.2',
      compatibility: 'unverified',
      protocolVersion: '0.163.0',
      protocolCheck: 'differs',
    })
    const result = await s.check.run(codexProfile(), 'manual')
    expect(result).toMatchObject({
      backend: 'codex',
      version: '0.163.2',
      status: 'incompatible',
    })
    expect(result.issues).toMatchObject([
      { code: 'protocol_unknown', blocking: true },
    ])
    expect(result.issues[0]!.detail).toContain('0.163.0')
  })

  it('a schema it could not generate is an error, not a block', async () => {
    const s = setup()
    s.probes.codex = probeOf({
      executableVersion: '0.163.0',
      compatibility: 'unverified',
      protocolVersion: '0.163.0',
      protocolCheck: 'unreadable',
    })
    expect(await s.check.run(codexProfile(), 'manual')).toMatchObject({
      status: 'error',
      issues: [{ code: 'start_failed', blocking: false }],
    })
  })

  it('7 · a feature on by default that Emperor never reviewed: feature_default_on, not blocking, ok', async () => {
    const open = codexOpen()
    const s = setup({
      codexFeatures: async () => featureList(['shiny_new_mode']),
      codexAdapter: open.adapter,
    })
    const result = await s.check.run(codexProfile(), 'manual')
    expect(result).toMatchObject({
      status: 'ok',
      issues: [{ code: 'feature_default_on', blocking: false }],
    })
    expect(result.issues[0]!.detail).toContain('shiny_new_mode')
    // The app-server was opened the way a run opens it, in the private
    // folder, and closed; no turn.
    expect(open.opened).toHaveLength(1)
    expect(
      open.opened[0]!.environment.CODEX_HOME!.startsWith(
        join(s.root, 'self-check'),
      ),
    ).toBe(true)
  })

  it('the defaults as recorded: ok with no issue; a Codex without `features list` skips that check', async () => {
    expect(await setup().check.run(codexProfile(), 'manual')).toMatchObject({
      status: 'ok',
      issues: [],
    })
    const old = setup({
      codexFeatures: async () => {
        throw new Error("error: unrecognized subcommand 'features'")
      },
    })
    old.probes.codex = probeOf({
      executableVersion: '0.153.4',
      compatibility: 'verified',
      protocolVersion: '0.153.4',
    })
    expect(await old.check.run(codexProfile(), 'manual')).toMatchObject({
      status: 'ok',
      issues: [],
    })
  })

  it('an app-server that refuses the handshake is blocking; one that will not start is an error', async () => {
    const { DelegationError } = await import('./types')
    const refused = setup({
      codexAdapter: codexOpen(
        new DelegationError('EXECUTOR_INCOMPATIBLE', 'unknown user agent'),
      ).adapter,
    })
    expect(
      (await refused.check.run(codexProfile(), 'manual')).issues,
    ).toMatchObject([{ code: 'protocol_unknown', blocking: true }])
    const broken = setup({
      codexAdapter: codexOpen(new Error('spawn EACCES')).adapter,
    })
    expect(await broken.check.run(codexProfile(), 'manual')).toMatchObject({
      status: 'error',
      issues: [{ code: 'start_failed', blocking: false }],
    })
  })
})

describe('when it runs', () => {
  it('9 · a version change starts one check in the background; again within 30 s does nothing', async () => {
    let now = 1_000_000
    const sdk = fakeClaudeSdk()
    const s = setup({ claudeStartup: sdk.startup, now: () => now })
    s.check.background(claudeProfile(), 'version_changed')
    s.check.background(claudeProfile(), 'version_changed')
    await vi.waitFor(() => expect(s.changed).toHaveBeenCalled(), LOADED)
    await s.check.idle()
    expect(sdk.launches).toHaveLength(1)
    now += SELF_CHECK_DEDUPE_MS - 1
    s.check.background(claudeProfile(), 'version_changed')
    await s.check.idle()
    expect(sdk.launches).toHaveLength(1)
    now += 2
    s.check.background(claudeProfile(), 'version_changed')
    await s.check.idle()
    expect(sdk.launches).toHaveLength(2)
  })

  it('two at once share one check; running() says so meanwhile', async () => {
    const sdk = fakeClaudeSdk()
    const s = setup({ claudeStartup: sdk.startup })
    const a = s.check.run(claudeProfile(), 'manual')
    expect(s.check.running('claude-default')).toBe(true)
    const b = s.check.run(claudeProfile(), 'manual')
    expect(await a).toEqual(await b)
    expect(sdk.launches).toHaveLength(1)
    expect(s.check.running('claude-default')).toBe(false)
  })

  it('gate: a stored result is used as it is; without one it checks now, up to the limit', async () => {
    const sdk = fakeClaudeSdk({ mcpServers: ['x'] })
    const s = setup({ claudeStartup: sdk.startup })
    // No result yet: checked now.
    const first = await s.check.gate(claudeProfile(), '2.1.310')
    expect(first?.status).toBe('incompatible')
    // Stored: not started again.
    expect((await s.check.gate(claudeProfile(), '2.1.310'))?.status).toBe(
      'incompatible',
    )
    expect(sdk.launches).toHaveLength(1)
    // No version: nothing to check.
    expect(await s.check.gate(claudeProfile(), undefined)).toBeNull()
  })

  it('11 · gate: a check that takes too long lets the task go on (null) and finishes later', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    const sdk = fakeClaudeSdk()
    const s = setup({
      claudeStartup: async (options) => {
        await held
        return sdk.startup(options)
      },
      gateTimeoutMs: 100,
    })
    const started = Date.now()
    expect(await s.check.gate(claudeProfile(), '2.1.310')).toBeNull()
    expect(Date.now() - started).toBeLessThan(5_000)
    release()
    await s.check.idle()
    expect(
      healthFile(s.root).profiles['claude-default'].versions['2.1.310']
        .selfCheck.status,
    ).toBe('ok')
  })
})
