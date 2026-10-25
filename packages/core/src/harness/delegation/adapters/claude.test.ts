import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Options,
  Query,
  SDKUserMessage,
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk'
import { ClaudeExecutorAdapter } from './claude'
import { ManagedAgentProcess, type ManagedProcessHandle } from '../process'
import { defaultExecutorConfig } from '../config'
import { delegationTestDirectory, fakeClaudeSdk } from '../testing'
import { BuiltinPluginLedger } from '../claude-builtin-plugins'
import type {
  ExecutorOpenInput,
  ExecutorSession,
  NormalizedExecutorEvent,
} from '../types'

/** Waits on work that runs processes, Git or the file system: room for a
 * loaded CI runner instead of the 1 s default (FIX-17). */
const LOADED = { timeout: 10_000 }

function fixture(
  ask = false,
  processes?: ManagedAgentProcess,
  keepAlive = false,
  extra: {
    init?: Record<string, unknown>
  } = {},
) {
  const f = delegationTestDirectory(),
    runtimeRoot = join(f.root, 'runtime')
  mkdirSync(runtimeRoot)
  let options: Options | undefined
  let answered = false
  let interrupted = false
  const start = vi.fn(
    async (opts: Options): Promise<Pick<WarmQuery, 'query' | 'close'>> => {
      options = opts
      const proc = opts.spawnClaudeCodeProcess!({
        command: process.execPath,
        args: [
          '-e',
          keepAlive
            ? 'process.stdin.resume();setInterval(()=>{},1000)'
            : 'process.stdin.resume()',
        ],
        cwd: f.root,
        env: {},
        signal: new AbortController().signal,
      })
      return {
        close: () => proc.stdin.end(),
        query: (prompts: string | AsyncIterable<SDKUserMessage>) => {
          const messages = (async function* () {
            if (typeof prompts === 'string') throw new Error('must stream')
            for await (const _prompt of prompts) {
              yield {
                type: 'system',
                subtype: 'init',
                session_id: opts.resume ?? opts.sessionId,
                tools: ['Read'],
                plugins: [],
                mcp_servers: [],
                claude_code_version: '2.1.300',
                ...extra.init,
              }
              if (ask) {
                const decision = await opts.canUseTool!(
                  'AskUserQuestion',
                  {
                    questions: [
                      {
                        question: 'Which file?',
                        header: 'File',
                        options: [{ label: 'a.txt' }],
                      },
                    ],
                  },
                  {
                    signal: new AbortController().signal,
                    toolUseID: 'tool-question',
                    requestId: 'sdk-request',
                  },
                )
                answered = decision?.behavior === 'allow'
              }
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text: 'mapped text' },
                },
              }
              yield {
                type: 'result',
                subtype: 'success',
                result: 'done',
                usage: { input_tokens: 2, output_tokens: 3 },
                total_cost_usd: 0.001,
              }
            }
          })()
          return Object.assign(messages, {
            initializationResult: async () => ({ hooks_applied: true }),
            interrupt: async () => {
              interrupted = true
              return undefined
            },
            close: () => proc.stdin.end(),
          }) as unknown as Query
        },
      }
    },
  )
  const input: ExecutorOpenInput = {
    delegationId: 'dlg-fixture',
    profile: { ...defaultExecutorConfig().profiles[0]!, enabled: true },
    cwd: f.root,
    environment: {
      PATH: process.env.PATH ?? '',
      HOME: runtimeRoot,
      CLAUDE_CONFIG_DIR: runtimeRoot,
    },
    runtimeRoot,
    policy: {
      mode: 'workspace-write',
      workspaceRoot: f.root,
      runtimeStateRoots: [runtimeRoot],
      privateTempRoot: runtimeRoot,
    },
    boundaryReceiptId: 'boundary',
    generation: 1,
    signal: new AbortController().signal,
  }
  return {
    ...f,
    input,
    start,
    getOptions: () => options!,
    wasAnswered: () => answered,
    wasInterrupted: () => interrupted,
    adapter: new ClaudeExecutorAdapter({
      startup: start,
      processes,
    }),
  }
}
it('uses managed spawn, isolated settings and exact resume; steer is unsupported', async () => {
  const f = fixture()
  const session = await f.adapter.open({
    ...f.input,
    resumeSessionId: '34e4f6da-4e43-46ee-bbfe-2fe1d039fc08',
  })
  const submit = session.submit({
    runId: 'dgr-one',
    messageId: 'dgm-one',
    text: 'fixture',
  })
  const events: NormalizedExecutorEvent[] = []
  for await (const event of session.events) {
    events.push(event)
    if (event.type === 'turn_finished') break
  }
  await submit
  expect(events.map((e) => e.type)).toContain('text_delta')
  expect(f.getOptions().systemPrompt).toMatchObject({
    type: 'preset',
    preset: 'claude_code',
    append: expect.stringContaining('parent agent in Emperor Agent'),
  })
  expect(JSON.stringify(f.getOptions().systemPrompt)).toContain('Verification')
  expect(JSON.stringify(f.getOptions().systemPrompt)).toContain('Open items')
  expect(JSON.stringify(f.getOptions().systemPrompt)).toContain(
    'public final response',
  )
  expect(f.getOptions().settingSources).toEqual([])
  expect(f.getOptions().resume).toBe('34e4f6da-4e43-46ee-bbfe-2fe1d039fc08')
  expect(f.getOptions().sessionId).toBeUndefined()
  expect(f.getOptions().tools).not.toContain('Agent')
  expect(f.getOptions().disallowedTools).toContain('Agent')
  await expect(
    session.steer({
      providerTurnId: 'turn',
      messageId: 'dgm-steer',
      text: 'steer',
    }),
  ).rejects.toThrow('UNSUPPORTED_OPTION')
  expect((await session.close()).quiescent).toBe(true)
  f.cleanup()
})
it('keeps the SDK question callback pending until a generation-matching answer arrives', async () => {
  const f = fixture(true)
  const session = await f.adapter.open(f.input)
  const submit = session.submit({
    runId: 'dgr-question',
    messageId: 'dgm-question',
    text: 'ask',
  })
  const iterator = session.events[Symbol.asyncIterator]()
  let requestId = ''
  while (true) {
    const row = await iterator.next()
    if (row.done) throw new Error('no question')
    if (row.value.type === 'question') {
      requestId = row.value.requestId
      break
    }
  }
  expect(f.wasAnswered()).toBe(false)
  await expect(
    session.answer({
      requestId,
      generation: 2,
      kind: 'question',
      answers: { 'q-0': 'a.txt' },
    }),
  ).rejects.toThrow('STALE_RUN')
  await session.answer({
    requestId,
    generation: 1,
    kind: 'question',
    answers: { 'q-0': 'a.txt' },
  })
  await vi.waitFor(() => expect(f.wasAnswered()).toBe(true), LOADED)
  await submit
  await session.close()
  f.cleanup()
})
it('interrupt uses the SDK control channel and close proves managed process quiescence', async () => {
  const f = fixture()
  const session = await f.adapter.open(f.input)
  await session.submit({
    runId: 'dgr-stop',
    messageId: 'dgm-stop',
    text: 'fixture',
  })
  await session.interrupt('turn')
  expect(f.wasInterrupted()).toBe(true)
  expect((await session.close()).quiescent).toBe(true)
  f.cleanup()
})
it('startup failure is explicit rather than an empty successful session', async () => {
  const f = fixture()
  const adapter = new ClaudeExecutorAdapter({
    startup: async () => {
      throw new Error('fixture startup failure')
    },
  })
  await expect(adapter.open(f.input)).rejects.toThrow('EXECUTOR_START_FAILED')
  f.cleanup()
})
it('close returns unknown within a bounded interval when process identity cannot be proved', async () => {
  const processes = new ManagedAgentProcess({ identityMatches: () => false })
  const spawn = processes.spawn.bind(processes)
  let handle: ManagedProcessHandle | undefined
  vi.spyOn(processes, 'spawn').mockImplementation((spec) => {
    handle = spawn(spec)
    return handle
  })
  const f = fixture(false, processes, true)
  const session = await f.adapter.open(f.input)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const receipt = await Promise.race([
      session.close(),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('close remained blocked after ownership failure')),
          3500,
        )
      }),
    ])
    expect(receipt.quiescent).toBe(false)
  } finally {
    if (timer) clearTimeout(timer)
    handle?.child.kill('SIGTERM')
    await handle?.closed
    f.cleanup()
  }
})
it('pre-tool guard denies native delegation even if the model invents a hidden tool call', async () => {
  const f = fixture()
  const session = await f.adapter.open(f.input)
  const hook = f.getOptions().hooks!.PreToolUse![0]!.hooks[0]!
  const result = await hook(
    {
      hook_event_name: 'PreToolUse',
      session_id: 'fixture',
      cwd: f.root,
      transcript_path: 'fixture',
      tool_name: 'Agent',
      tool_input: { prompt: 'nested' },
      tool_use_id: 'nested',
    },
    'nested',
    { signal: new AbortController().signal },
  )
  expect(result).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'deny' },
  })
  await session.close()
  f.cleanup()
})

it('launches the installed claude found on the run’s PATH, or the path the profile names (AGT-12)', async () => {
  const onPath = fixture()
  const bin = join(onPath.root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
  await (
    await onPath.adapter.open({
      ...onPath.input,
      environment: { ...onPath.input.environment, PATH: `${bin}:/usr/bin` },
    })
  ).close()
  expect(onPath.getOptions().pathToClaudeCodeExecutable).toBe(
    join(bin, 'claude'),
  )
  onPath.cleanup()
  const named = fixture()
  await (
    await named.adapter.open({
      ...named.input,
      profile: {
        ...named.input.profile,
        executablePath: '/opt/homebrew/bin/claude',
      },
    })
  ).close()
  expect(named.getOptions().pathToClaudeCodeExecutable).toBe(
    '/opt/homebrew/bin/claude',
  )
  named.cleanup()
})
it.each([
  [{ claude_code_version: '2.0.9' }, />= 2\.1\.79/],
  [{ claude_code_version: undefined }, /did not report its version/],
  [
    { claude_code_version: '2.1.290', permissionMode: 'bypassPermissions' },
    /permission mode/,
  ],
])(
  'checks an installed claude against the init capabilities %j',
  async (init, reason) => {
    const f = fixture(false, undefined, false, { init })
    const session = await f.adapter.open(f.input)
    const submit = session.submit({
      runId: 'dgr-init',
      messageId: 'dgm-init',
      text: 'fixture',
    })
    await expect(submit).rejects.toThrow(/EXECUTOR_INCOMPATIBLE/)
    await expect(submit).rejects.toThrow(reason)
    await session.close()
    f.cleanup()
  },
)
it('caps an API-billed run with the SDK maxBudgetUsd and leaves a subscription uncapped (AGT-07)', async () => {
  for (const budgetUsd of [3.5, undefined]) {
    const f = fixture()
    const session = await f.adapter.open({
      ...f.input,
      ...(budgetUsd === undefined ? {} : { budgetUsd }),
    })
    const submit = session.submit({
      runId: 'dgr-budget',
      messageId: 'dgm-budget',
      text: 'fixture',
    })
    for await (const event of session.events)
      if (event.type === 'turn_finished') break
    await submit
    expect(f.getOptions().maxBudgetUsd).toBe(budgetUsd)
    await session.close()
    f.cleanup()
  }
})

it('6 · a Claude task reads the repository’s CLAUDE.md, without loading its settings (AGT-08)', async () => {
  const f = fixture()
  writeFileSync(
    join(f.root, 'CLAUDE.md'),
    '# House rules\nAlways run pnpm test.\n',
  )
  const session = await f.adapter.open(f.input)
  const submit = session.submit({
    runId: 'dgr-claude-md',
    messageId: 'dgm-claude-md',
    text: 'fixture',
  })
  for await (const event of session.events)
    if (event.type === 'turn_finished') break
  await submit
  const append = JSON.stringify(f.getOptions().systemPrompt)
  expect(append).toContain('CLAUDE.md')
  expect(append).toContain('Always run pnpm test.')
  // Project settings (hooks, permission rules) stay out: only the text.
  expect(f.getOptions().settingSources).toEqual([])
  await session.close()
  f.cleanup()
})

/**
 * VER-02: a claude that loads its own builtin plugin (2.1.308+) gets it
 * turned off before the first prompt, in the same process (VER-01: E1, E2
 * pass on the real binaries); anything else stays refused. The fake SDK
 * answers reloadPlugins / applyFlagSettings from the launch's options.
 */
describe('VER-02 · builtin plugins are turned off before the first prompt', () => {
  const novel = { name: 'x', path: 'builtin', source: 'x@builtin' }
  const SEED = {
    'agents-md@builtin': false,
    'cc-plugin-agents-md@builtin': false,
    'cc-plugin-plugin-authoring@builtin': false,
    'telemetry@builtin': false,
  }
  function preflight(
    sdk: ReturnType<typeof fakeClaudeSdk>,
    ledger = new BuiltinPluginLedger(),
  ) {
    const f = fixture()
    const adapter = new ClaudeExecutorAdapter({
      startup: sdk.startup,
      ledger,
      preflightTimeoutMs: 200,
    })
    const input: ExecutorOpenInput = {
      ...f.input,
      executableVersion: '2.1.312',
    }
    return { ...f, adapter, input, ledger }
  }
  async function run(session: ExecutorSession, id = 'dgr-plugins') {
    const events: NormalizedExecutorEvent[] = []
    const submit = session.submit({
      runId: id,
      messageId: 'dgm-' + id,
      text: 'fixture',
    })
    for await (const event of session.events) {
      events.push(event)
      if (event.type === 'turn_finished') break
    }
    await submit
    return events
  }
  const disabledNotice = (events: NormalizedExecutorEvent[]) =>
    events.flatMap((e) =>
      e.type === 'runtime_metadata' && e.builtinPluginsDisabled
        ? [e.builtinPluginsDisabled]
        : [],
    )

  it('1 · the seed’s three builtins are false in settings.enabledPlugins', async () => {
    const sdk = fakeClaudeSdk()
    const f = preflight(sdk)
    await (await f.adapter.open(f.input)).close()
    expect(
      (sdk.launches[0]!.settings as { enabledPlugins: unknown }).enabledPlugins,
    ).toEqual(SEED)
    f.cleanup()
  })

  it('2 · 10 · a new x@builtin is turned off in the running process; no prompt before, no restart', async () => {
    const sdk = fakeClaudeSdk({ version: '2.1.312', plugins: [novel] })
    const f = preflight(sdk)
    const session = await f.adapter.open(f.input)
    expect(sdk.controlRequests.map((r) => r.subtype)).toEqual([
      'reload_plugins',
      'apply_flag_settings',
      'reload_plugins',
    ])
    expect(sdk.controlRequests.every((r) => r.modelCallsBefore === 0)).toBe(
      true,
    )
    expect(sdk.controlRequests[1]!.settings).toEqual({
      enabledPlugins: { ...SEED, 'x@builtin': false },
    })
    const events = await run(session)
    expect(events.at(-1)).toMatchObject({
      type: 'turn_finished',
      status: 'completed',
    })
    expect(disabledNotice(events)).toEqual([
      { plugins: ['x@builtin'], claudeVersion: '2.1.312' },
    ])
    expect(sdk.launches).toHaveLength(1)
    expect(sdk.modelCalls).toBe(1)
    await session.close()
    f.cleanup()
  })

  it('3 · the learned plugin is off from launch in the next run: no applyFlagSettings, no notice', async () => {
    const d = delegationTestDirectory()
    const ledger = new BuiltinPluginLedger(d.root)
    const sdk = fakeClaudeSdk({ version: '2.1.312', plugins: [novel] })
    const f = preflight(sdk, ledger)
    await run(await f.adapter.open(f.input), 'dgr-first')
    const next = preflight(sdk, new BuiltinPluginLedger(d.root))
    const session = await next.adapter.open(next.input)
    expect(
      (sdk.launches[1]!.settings as { enabledPlugins: unknown }).enabledPlugins,
    ).toEqual({ ...SEED, 'x@builtin': false })
    expect(
      sdk.controlRequests.filter((r) => r.launch === 1).map((r) => r.subtype),
    ).toEqual(['reload_plugins'])
    expect(disabledNotice(await run(session, 'dgr-second'))).toEqual([])
    await session.close()
    f.cleanup()
    next.cleanup()
    d.cleanup()
  })

  it.each([
    [
      '4 · a plugin from disk',
      { plugins: [{ name: 'foo', path: '/Users/ada/plugins/foo' }] },
      /EXECUTOR_INCOMPATIBLE.*未批准的扩展：插件 foo（来自 /,
    ],
    [
      '9 · path builtin but a marketplace source',
      { plugins: [{ name: 'foo', path: 'builtin', source: 'foo@market' }] },
      /EXECUTOR_INCOMPATIBLE.*未批准的扩展：插件 foo@market/,
    ],
    [
      '5 · an MCP server',
      { mcpServers: ['a'] },
      /EXECUTOR_INCOMPATIBLE.*MCP server：a。子智能体不允许使用 MCP/,
    ],
    [
      '5 · a builtin that brings an MCP server',
      { plugins: [novel], mcpServers: ['plugin:x:docs'] },
      /EXECUTOR_INCOMPATIBLE.*MCP server：plugin:x:docs/,
    ],
    [
      'plugin errors',
      { plugins: [novel], errorCount: 1 },
      /EXECUTOR_INCOMPATIBLE.*报告了 1 个错误/,
    ],
    [
      '6 · a builtin still loaded after it was turned off',
      { plugins: [novel], honoursFlagSettings: false },
      /EXECUTOR_INCOMPATIBLE.*内置插件 x 关闭后仍在加载.*退回上一个正常版本/,
    ],
  ])(
    '%s: refused before any prompt, nothing learned',
    async (_name, options, reason) => {
      const d = delegationTestDirectory()
      const ledger = new BuiltinPluginLedger(d.root)
      const sdk = fakeClaudeSdk({ version: '2.1.312', ...options })
      const f = preflight(sdk, ledger)
      await expect(f.adapter.open(f.input)).rejects.toThrow(reason)
      expect(sdk.modelCalls).toBe(0)
      expect(ledger.disabled()).toEqual(Object.keys(SEED).sort())
      expect(readdirSync(d.root)).toEqual([])
      f.cleanup()
      d.cleanup()
    },
  )

  it('7 · a claude without reloadPlugins skips the preflight; the init gate decides', async () => {
    // Nothing loaded: the run goes on.
    const clean = fakeClaudeSdk({ supportsReload: false })
    const a = preflight(clean)
    const session = await a.adapter.open(a.input)
    expect((await run(session)).at(-1)).toMatchObject({ status: 'completed' })
    expect(clean.controlRequests.map((r) => r.subtype)).toEqual([
      'reload_plugins',
    ])
    await session.close()
    a.cleanup()
    // A builtin it could not be asked about: refused at init, no restart.
    const loaded = fakeClaudeSdk({ supportsReload: false, plugins: [novel] })
    const b = preflight(loaded)
    const refused = await b.adapter.open(b.input)
    await expect(
      refused.submit({ runId: 'dgr-gate', messageId: 'dgm-gate', text: 'x' }),
    ).rejects.toThrow(/EXECUTOR_INCOMPATIBLE.*内置插件 x/)
    expect(loaded.launches).toHaveLength(1)
    await refused.close()
    b.cleanup()
  })

  it('7 · a preflight that times out counts as unsupported, not as a failure', async () => {
    const sdk = fakeClaudeSdk({ supportsReload: 'hang' })
    const f = preflight(sdk)
    const started = Date.now()
    const session = await f.adapter.open(f.input)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect((await run(session)).at(-1)).toMatchObject({ status: 'completed' })
    await session.close()
    f.cleanup()
  })

  it('a resumed conversation is checked the same way', async () => {
    const sdk = fakeClaudeSdk({ plugins: [novel] })
    const f = preflight(sdk)
    const session = await f.adapter.open({
      ...f.input,
      resumeSessionId: '34e4f6da-4e43-46ee-bbfe-2fe1d039fc08',
    })
    expect(sdk.controlRequests.map((r) => r.subtype)).toContain(
      'apply_flag_settings',
    )
    await session.close()
    f.cleanup()
  })
})

it('10 · the claude Emperor starts never updates itself: DISABLE_AUTOUPDATER=1 in its environment (VER-03)', async () => {
  const processes = new ManagedAgentProcess()
  const spawn = vi.spyOn(processes, 'spawn')
  const f = fixture(false, processes)
  const session = await f.adapter.open({
    ...f.input,
    // Whatever the run's environment says.
    environment: { ...f.input.environment, DISABLE_AUTOUPDATER: '0' },
  })
  try {
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![0].env).toMatchObject({
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    })
  } finally {
    await session.close()
    f.cleanup()
  }
})
