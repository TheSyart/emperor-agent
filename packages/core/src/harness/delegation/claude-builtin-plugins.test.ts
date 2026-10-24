/**
 * VER-02: since Claude Code 2.1.308 the CLI ships its own plugin,
 * `cc-plugin-plugin-authoring@builtin`, and every Claude subtask failed at
 * the init gate (EXECUTOR_INCOMPATIBLE). Emperor now turns off whatever
 * builtin plugin a claude reports, before the first prompt, and remembers
 * it in `<delegations>/claude-code/builtin-plugins.json`; anything else a
 * claude loads (a plugin from disk, an MCP server) is still refused.
 *
 * Here: the ledger, what counts as builtin, the Chinese reasons, and the
 * run as the service records it (the notice, the reason in the summary).
 * The adapter's preflight: adapters/claude.test.ts. The real binaries
 * (2.1.281, 2.1.308, 2.1.310), offline: scripts/claude-init-handshake.mjs
 * and VER-01's fixtures in __golden__/claude-handshake-*.json.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_PLUGIN_LEDGER_FILE,
  BuiltinPluginLedger,
  SEED_BUILTIN_PLUGINS,
  isBuiltinPlugin,
} from './claude-builtin-plugins'
import { describeUnapprovedExtensions } from './failure'
import { ClaudeExecutorAdapter } from './adapters/claude'
import { fixture, spec } from './service-test-fixture'
import { delegationTestDirectory, fakeClaudeSdk } from './testing'
import golden2281 from './__golden__/claude-handshake-2.1.281.json'
import golden2308 from './__golden__/claude-handshake-2.1.308.json'
import golden2310 from './__golden__/claude-handshake-2.1.310.json'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function directory() {
  const d = delegationTestDirectory()
  cleanups.push(d.cleanup)
  return d.root
}
const authoring = {
  name: 'cc-plugin-plugin-authoring',
  path: 'builtin',
  source: 'cc-plugin-plugin-authoring@builtin',
}
const novel = { name: 'x', path: 'builtin', source: 'x@builtin' }

it('1 · the seed turns off the three known builtins, 2.1.308’s among them, all false', () => {
  expect([...SEED_BUILTIN_PLUGINS].sort()).toEqual([
    'agents-md@builtin',
    'cc-plugin-plugin-authoring@builtin',
    'telemetry@builtin',
  ])
  const ledger = new BuiltinPluginLedger(directory())
  expect(ledger.disabled()).toEqual([...SEED_BUILTIN_PLUGINS].sort())
  const setting = ledger.enabledPluginsSetting()
  expect(Object.keys(setting).sort()).toEqual([...SEED_BUILTIN_PLUGINS].sort())
  // Emperor only ever turns plugins off.
  expect(Object.values(setting).every((v) => v === false)).toBe(true)
})

it('the seed matches what VER-01 measured on the real binaries', () => {
  // 2.1.281 loads none; 2.1.308 and 2.1.310 load exactly the one seeded.
  expect(golden2281.promptless.reload.plugins).toEqual([])
  for (const golden of [golden2308, golden2310]) {
    expect(golden.promptless.reload.plugins).toEqual([authoring])
    expect(golden.promptless.afterFlagSettings?.plugins).toEqual([])
    expect(golden.withSeed?.initPlugins).toEqual([])
  }
  for (const golden of [golden2281, golden2308, golden2310]) {
    expect(golden.promptless.hooksApplied).toBe(true)
    expect(golden.promptless.mcpStatus).toEqual([])
    expect(golden.modelCalls).toBe(0)
    for (const plugin of golden.promptless.reload.plugins)
      expect(isBuiltinPlugin(plugin)).toBe(true)
  }
})

it('9 · only a plugin the binary ships is builtin: path builtin and source <name>@builtin', () => {
  expect(isBuiltinPlugin(authoring)).toBe(true)
  expect(isBuiltinPlugin(novel)).toBe(true)
  // A marketplace plugin, even claiming path builtin.
  expect(
    isBuiltinPlugin({ name: 'foo', path: 'builtin', source: 'foo@market' }),
  ).toBe(false)
  expect(isBuiltinPlugin({ name: 'foo', path: 'builtin' })).toBe(false)
  expect(
    isBuiltinPlugin({ name: 'x', path: 'builtin', source: 'y@builtin' }),
  ).toBe(false)
  expect(
    isBuiltinPlugin({
      name: 'foo',
      path: '/Users/ada/.claude/plugins/foo',
      source: 'foo@builtin',
    }),
  ).toBe(false)
})

it('3 · a learned builtin is written down and turned off from then on; learning again is idempotent', () => {
  const root = directory()
  const ledger = new BuiltinPluginLedger(root, { now: () => 1_000 })
  expect(ledger.learn([novel], '2.1.312')).toEqual(['x@builtin'])
  expect(ledger.disabled()).toContain('x@builtin')
  expect(ledger.enabledPluginsSetting()['x@builtin']).toBe(false)
  const file = JSON.parse(
    readFileSync(join(root, BUILTIN_PLUGIN_LEDGER_FILE), 'utf8'),
  )
  expect(file).toEqual({
    schemaVersion: 1,
    plugins: {
      'x@builtin': {
        name: 'x',
        firstSeenVersion: '2.1.312',
        lastSeenVersion: '2.1.312',
        learnedAt: 1_000,
      },
    },
  })
  // Seen again on a later claude: nothing new, the last version moves on.
  expect(ledger.learn([novel], '2.1.315')).toEqual([])
  // Another run's ledger (a second instance) reads it back.
  const again = new BuiltinPluginLedger(root)
  expect(again.disabled()).toContain('x@builtin')
  expect(
    JSON.parse(readFileSync(join(root, BUILTIN_PLUGIN_LEDGER_FILE), 'utf8'))
      .plugins['x@builtin'],
  ).toMatchObject({ firstSeenVersion: '2.1.312', lastSeenVersion: '2.1.315' })
})

it('two runs learning at once merge: neither loses the other’s plugin', () => {
  const root = directory()
  const a = new BuiltinPluginLedger(root),
    b = new BuiltinPluginLedger(root)
  a.learn([novel], '2.1.312')
  b.learn([{ name: 'y', path: 'builtin', source: 'y@builtin' }], '2.1.312')
  const written = JSON.parse(
    readFileSync(join(root, BUILTIN_PLUGIN_LEDGER_FILE), 'utf8'),
  )
  expect(Object.keys(written.plugins).sort()).toEqual([
    'x@builtin',
    'y@builtin',
  ])
  expect(b.learn([novel], '2.1.312')).toEqual([])
})

it('4 · 9 · the ledger never holds a plugin that is not builtin', () => {
  const root = directory()
  const ledger = new BuiltinPluginLedger(root)
  expect(
    ledger.learn(
      [
        { name: 'foo', path: '/Users/ada/foo', source: 'foo@local' },
        { name: 'foo', path: 'builtin', source: 'foo@market' },
      ],
      '2.1.312',
    ),
  ).toEqual([])
  expect(existsSync(join(root, BUILTIN_PLUGIN_LEDGER_FILE))).toBe(false)
  expect(ledger.disabled()).toEqual([...SEED_BUILTIN_PLUGINS].sort())
})

it('8 · a damaged ledger (bad JSON, unknown schema): the seed only, the file left as it was', () => {
  for (const body of [
    '{ not json',
    JSON.stringify({ schemaVersion: 2, plugins: {} }),
    JSON.stringify({ schemaVersion: 1, plugins: { 'x@builtin': 'nope' } }),
  ]) {
    const root = directory()
    writeFileSync(join(root, BUILTIN_PLUGIN_LEDGER_FILE), body)
    const ledger = new BuiltinPluginLedger(root)
    expect(ledger.damaged).toBe(true)
    expect(ledger.disabled()).toEqual([...SEED_BUILTIN_PLUGINS].sort())
    // Still turned off for this process, never written over the file.
    expect(ledger.learn([novel], '2.1.312')).toEqual(['x@builtin'])
    expect(ledger.disabled()).toContain('x@builtin')
    expect(readFileSync(join(root, BUILTIN_PLUGIN_LEDGER_FILE), 'utf8')).toBe(
      body,
    )
  }
})

it('a ledger without a folder (tests, tools) keeps what it learns in memory', () => {
  const ledger = new BuiltinPluginLedger()
  expect(ledger.learn([novel], '2.1.312')).toEqual(['x@builtin'])
  expect(ledger.disabled()).toContain('x@builtin')
})

it('the reasons, in Chinese: a plugin from disk, a builtin that stays on, MCP, plugin errors', () => {
  expect(
    describeUnapprovedExtensions({
      kind: 'foreign',
      claudeVersion: '2.1.310',
      plugins: [{ name: 'foo', path: join(homedir(), '.claude/plugins/foo') }],
    }),
  ).toBe(
    'Claude Code 2.1.310 加载了未批准的扩展：插件 foo（来自 ~/.claude/plugins/foo）。Emperor 只允许它自带的内置插件，并会自动关闭它们。',
  )
  expect(
    describeUnapprovedExtensions({
      kind: 'foreign',
      claudeVersion: '2.1.310',
      plugins: [{ name: 'foo', path: 'builtin', source: 'foo@market' }],
    }),
  ).toBe(
    'Claude Code 2.1.310 加载了未批准的扩展：插件 foo@market。Emperor 只允许它自带的内置插件，并会自动关闭它们。',
  )
  expect(
    describeUnapprovedExtensions({
      kind: 'stuck',
      claudeVersion: '2.1.310',
      plugins: ['x@builtin'],
    }),
  ).toBe(
    'Claude Code 2.1.310 的内置插件 x 关闭后仍在加载，可能是新版本改了开关。可以在 设置 › 子智能体 退回上一个正常版本。',
  )
  expect(
    describeUnapprovedExtensions({ kind: 'mcp', servers: ['a', 'b'] }),
  ).toBe('Claude Code 加载了 MCP server：a、b。子智能体不允许使用 MCP。')
  expect(
    describeUnapprovedExtensions({
      kind: 'errors',
      claudeVersion: '2.1.310',
      errorCount: 2,
    }),
  ).toBe(
    'Claude Code 2.1.310 加载插件时报告了 2 个错误，Emperor 无法确认它加载了哪些扩展，没有启动这次任务。',
  )
  // Without a version, and a long list bounded.
  const many = Array.from({ length: 9 }, (_, i) => `s${i}`)
  const text = describeUnapprovedExtensions({ kind: 'mcp', servers: many })
  expect(text).toContain('s0、s1、s2、s3、s4 等 9 个')
})

/** The service with the real Claude adapter on the fake SDK. */
function withFakeClaude(
  sdk: ReturnType<typeof fakeClaudeSdk>,
  ledger: BuiltinPluginLedger,
) {
  const f = fixture()
  vi.mocked(f.registry.requireAvailable).mockImplementation(async (p) => ({
    status: 'available',
    executableVersion: '2.1.312',
    checkedAt: Date.now(),
    authVerified: false,
    capabilities: f.registry.capabilities(p.backend),
  }))
  f.options.adapters.set(
    'claude-code',
    new ClaudeExecutorAdapter({ startup: sdk.startup, ledger }),
  )
  cleanups.push(async () => {
    await f.service.shutdown()
    f.cleanup()
  })
  return f
}
async function settle(f: ReturnType<typeof withFakeClaude>, request = 'start') {
  const record = await f.service.start(f.owner, {
    ...spec,
    backend: 'claude-code',
    profileId: 'claude-default',
    clientRequestId: request,
  })
  const run = await f.service.wait(record.id, record.currentRunId!)
  return { run, notice: Object.values(f.service.inspect(record.id).outbox)[0] }
}

it('2 · 3 · the run says once that Emperor turned off a new builtin; the next run does not', async () => {
  const root = directory()
  const ledger = new BuiltinPluginLedger(join(root, 'claude-code'))
  const sdk = fakeClaudeSdk({ version: '2.1.312', plugins: [novel] })
  const f = withFakeClaude(sdk, ledger)
  const first = await settle(f)
  expect(first.run).toMatchObject({
    phase: 'completed',
    notices: [
      {
        kind: 'builtin_plugins_disabled',
        plugins: ['x@builtin'],
        claudeVersion: '2.1.312',
      },
    ],
  })
  expect(ledger.disabled()).toContain('x@builtin')
  const second = await settle(f, 'start-again')
  expect(second.run.id).not.toBe(first.run.id)
  expect(second.run.phase).toBe('completed')
  expect(second.run.notices).toBeUndefined()
})

it('4 · a plugin from disk fails the run with the Chinese reason in its summary, the ledger unchanged', async () => {
  const root = directory()
  mkdirSync(join(root, 'claude-code'))
  const ledger = new BuiltinPluginLedger(join(root, 'claude-code'))
  const sdk = fakeClaudeSdk({
    plugins: [{ name: 'foo', path: '/opt/plugins/foo', source: 'foo@local' }],
  })
  const { run, notice } = await settle(withFakeClaude(sdk, ledger))
  expect(run).toMatchObject({
    phase: 'failed',
    failureCode: 'EXECUTOR_INCOMPATIBLE',
  })
  expect(run.summary).toBe(
    'Claude Code 2.1.312 加载了未批准的扩展：插件 foo@local（来自 /opt/plugins/foo）。Emperor 只允许它自带的内置插件，并会自动关闭它们。',
  )
  // The parent hears the same reason.
  expect(notice?.text).toContain('未批准的扩展')
  expect(sdk.modelCalls).toBe(0)
  expect(
    existsSync(join(root, 'claude-code', BUILTIN_PLUGIN_LEDGER_FILE)),
  ).toBe(false)
})
