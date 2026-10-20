// SEC-07 tests 1–5: a plugin's hooks run in the process containment with a
// narrowed environment (the safe keys plus what its manifest's `env` names)
// and a short timeout (30 s by default, at most 120 s); a failure is kept
// with its reason and the variables the hook may need, for the plugin's
// detail page. The user's own hooks.json hooks are user-trusted and keep
// running as before.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { userText } from '../../llm/message'
import { OsSandboxController } from '../../environment/sandbox'
import { OwnedProcessRuntime } from '../../processes/runtime'
import { SAFE_ENV_KEYS } from '../../mcp/connection'
import { createTestHarness } from '../testing'
import { defineTool } from '../tools/definition'
import { ClaudeCodeHooks } from './claude-code'
import {
  containedPluginHookRunner,
  PLUGIN_HOOK_DEFAULT_TIMEOUT_MS,
  PLUGIN_HOOK_MAX_TIMEOUT_MS,
  pluginHookTimeoutMs,
} from './contained'
import { hookVariables, PluginHookHealth } from './plugin-health'
import { DEFAULT_HOOK_TIMEOUT_MS } from './runner'
import type { CommandHook } from './types'

/** Credentials the Emperor process may carry; a plugin hook must see none. */
const SECRETS = {
  OPENAI_API_KEY: 'sk-openai-sec07',
  ANTHROPIC_API_KEY: 'sk-ant-sec07',
  DEEPSEEK_API_KEY: 'sk-deepseek-sec07',
  GITHUB_TOKEN: 'ghp_sec07',
  AWS_SECRET_ACCESS_KEY: 'aws-sec07',
}

/** What `/bin/sh` sets on its own. */
const SHELL_SET = ['PWD', 'SHLVL', '_', 'OLDPWD']

const disposers: Array<() => Promise<void>> = []
beforeEach(() => {
  for (const [key, value] of Object.entries(SECRETS)) vi.stubEnv(key, value)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  while (disposers.length > 0) await disposers.pop()!()
})

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

interface Setup {
  /** The plugin hook's command (PreToolUse on `echo`). */
  command: string
  timeoutSec?: number
  /** Names the plugin's manifest lists in `env`. */
  allowedEnv?: string[]
  /** A hook in the user's own hooks.json (PreToolUse on `echo`). */
  userCommand?: string
  /** A runtime other than the real one (to read what the runner asks for). */
  runtime?: OwnedProcessRuntime
  /** Files in the plugin's package. */
  files?: Record<string, string>
}

function setup(options: Setup) {
  const root = tmp('emperor-sec07-hooks-')
  const home = join(root, 'home')
  const stateRoot = join(home, '.emperor')
  const workspace = join(root, 'project')
  const pluginRoot = join(stateRoot, 'plugins', 'cache', 'kit')
  const pluginData = join(stateRoot, 'plugins', 'data', 'kit')
  for (const dir of [workspace, pluginRoot, pluginData])
    mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(options.files ?? {})) {
    mkdirSync(join(pluginRoot, name, '..'), { recursive: true })
    writeFileSync(join(pluginRoot, name), content)
  }
  // The hook's `~` is this test's home, never the real one.
  vi.stubEnv('HOME', home)
  writeFileSync(join(stateRoot, 'model_config.json'), 'MODEL-CONFIG-SECRET')
  const userHooks = join(stateRoot, 'hooks.json')
  writeFileSync(
    userHooks,
    JSON.stringify({
      hooks: options.userCommand
        ? {
            PreToolUse: [
              {
                matcher: 'echo',
                hooks: [{ type: 'command', command: options.userCommand }],
              },
            ],
          }
        : {},
    }),
  )
  const runtime =
    options.runtime ??
    new OwnedProcessRuntime(stateRoot, { sandbox: new OsSandboxController() })
  const health = new PluginHookHealth()
  const bridge = new ClaudeCodeHooks({
    configPaths: [userHooks],
    pluginHookRunner: containedPluginHookRunner({
      runtime,
      stateRoot,
      home,
      health,
    }),
  })
  disposers.push(() => bridge.dispose())
  const hook: CommandHook = {
    id: 'PreToolUse#1',
    command: options.command,
    ...(options.timeoutSec !== undefined
      ? { timeoutSec: options.timeoutSec }
      : {}),
  }
  bridge.setPluginHooks([
    {
      id: 'kit@user',
      pluginId: 'kit',
      allowedEnv: options.allowedEnv ?? [],
      env: {
        PLUGIN_ROOT: pluginRoot,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        PLUGIN_DATA: pluginData,
        CLAUDE_PLUGIN_DATA: pluginData,
      },
      config: { PreToolUse: [{ matcher: 'echo', hooks: [hook] }] },
    },
  ])
  const calls: string[] = []
  const h = createTestHarness({
    replies: [
      { tools: [{ id: 'c1', name: 'echo', args: { value: 'x' } }] },
      { text: 'done' },
    ],
  })
  bridge.install(h.middleware, h.tools)
  h.tools.register(
    defineTool({
      name: 'echo',
      description: 'Echo the input.',
      input: z.object({ value: z.string() }),
      async execute(args) {
        calls.push(args.value)
        return `echo:${args.value}`
      },
    }),
  )
  h.sessions.create({ id: 'hooked', cwd: workspace })
  const agent = h.agent('hooked')
  const run = async () => {
    agent.followup(userText('go'))
    await agent.whenIdle()
  }
  const data = (name: string) =>
    readFileSync(join(pluginData, name), 'utf8').trim()
  return {
    home,
    stateRoot,
    workspace,
    pluginRoot,
    pluginData,
    agent,
    calls,
    health,
    run,
    data,
  }
}

function receipts(stateRoot: string): Array<Record<string, any>> {
  const file = join(stateRoot, 'processes', 'receipts.v1.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
}

function envKeys(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.slice(0, line.indexOf('=')))
    .filter(Boolean)
}

const darwin = process.platform === 'darwin'

describe('plugin hooks: containment and environment (SEC-07)', () => {
  it.runIf(darwin)(
    '1: a plugin hook cannot read ~/.emperor/model_config.json',
    async () => {
      const f = setup({
        command: [
          `cat "$HOME/.emperor/model_config.json" > "$PLUGIN_DATA/config.txt" 2>/dev/null || echo denied > "$PLUGIN_DATA/config.txt"`,
          // The sandbox is not simply broken: its own package and data work.
          `echo ok > "$PLUGIN_DATA/own.txt"`,
        ].join('; '),
      })
      await f.run()
      expect(f.calls).toEqual(['x'])
      expect(f.data('config.txt')).toBe('denied')
      expect(f.data('own.txt')).toBe('ok')
      expect(
        receipts(f.stateRoot).find((item) => item.owner.kind === 'hook'),
      ).toMatchObject({
        owner: { kind: 'hook', id: 'kit' },
        containment: { backend: 'seatbelt', decision: 'contained' },
      })
    },
    30_000,
  )

  it.runIf(darwin)(
    '2: a plugin hook sees no OPENAI_API_KEY or other credentials, only the safe keys and its own variables',
    async () => {
      vi.stubEnv('SEC07_UNLISTED', 'not-for-plugins')
      const f = setup({ command: 'env > "$PLUGIN_DATA/env.txt"' })
      await f.run()
      const text = readFileSync(join(f.pluginData, 'env.txt'), 'utf8')
      for (const [key, value] of Object.entries(SECRETS)) {
        expect(text).not.toContain(`${key}=`)
        expect(text).not.toContain(value)
      }
      expect(text).not.toContain('SEC07_UNLISTED')
      const allowed = new Set([
        ...SAFE_ENV_KEYS,
        ...SHELL_SET,
        'PLUGIN_ROOT',
        'PLUGIN_DATA',
        'CLAUDE_PLUGIN_ROOT',
        'CLAUDE_PLUGIN_DATA',
        'CLAUDE_PROJECT_DIR',
      ])
      expect(envKeys(text).filter((key) => !allowed.has(key))).toEqual([])
      // Still a working environment: a PATH, the home, its own variables.
      expect(envKeys(text)).toEqual(
        expect.arrayContaining(['PATH', 'HOME', 'PLUGIN_ROOT', 'PLUGIN_DATA']),
      )
      expect(text).toContain(
        `TMPDIR=${join(f.stateRoot, 'plugins', 'tmp', 'kit')}`,
      )
    },
    30_000,
  )

  it.runIf(darwin)(
    '3: a variable the manifest declares in env is visible, the rest still are not',
    async () => {
      vi.stubEnv('ACME_TOKEN', 'acme-visible')
      const f = setup({
        command: 'env > "$PLUGIN_DATA/env.txt"',
        // NOT_SET is declared but Emperor's environment has no value for it.
        allowedEnv: ['ACME_TOKEN', 'NOT_SET'],
      })
      await f.run()
      const text = readFileSync(join(f.pluginData, 'env.txt'), 'utf8')
      expect(text).toContain('ACME_TOKEN=acme-visible')
      expect(envKeys(text)).not.toContain('NOT_SET')
      expect(text).not.toContain('OPENAI_API_KEY=')
      expect(f.health.failure('kit', 'PreToolUse#1')).toBeNull()
    },
    30_000,
  )

  it.runIf(darwin)(
    '5: the user’s own hooks.json hook keeps the full environment, a writable workspace and no containment',
    async () => {
      const f = setup({
        command: 'env > "$PLUGIN_DATA/env.txt"',
        userCommand: 'env > user-env.txt; echo user > user-hook.txt',
      })
      await f.run()
      expect(f.calls).toEqual(['x'])
      // The user's hook ran in the workspace as before, with everything.
      const userEnv = readFileSync(join(f.workspace, 'user-env.txt'), 'utf8')
      expect(userEnv).toContain(`OPENAI_API_KEY=${SECRETS.OPENAI_API_KEY}`)
      expect(userEnv).toContain(`GITHUB_TOKEN=${SECRETS.GITHUB_TOKEN}`)
      expect(readFileSync(join(f.workspace, 'user-hook.txt'), 'utf8')).toBe(
        'user\n',
      )
      // Only the plugin hook left a containment receipt.
      expect(
        receipts(f.stateRoot)
          .filter((item) => item.owner.kind === 'hook')
          .map((item) => item.owner.id),
      ).toEqual(['kit'])
      // The plugin hook, in the same turn, did not get them.
      expect(readFileSync(join(f.pluginData, 'env.txt'), 'utf8')).not.toContain(
        'OPENAI_API_KEY=',
      )
      // The user's hooks keep the 10-minute default.
      expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(600_000)
    },
    30_000,
  )
})

describe('plugin hooks: timeout (SEC-07 test 4)', () => {
  it('defaults to 30 seconds and caps what a hook asks for at 120 seconds', () => {
    expect(PLUGIN_HOOK_DEFAULT_TIMEOUT_MS).toBe(30_000)
    expect(PLUGIN_HOOK_MAX_TIMEOUT_MS).toBe(120_000)
    expect(pluginHookTimeoutMs({ command: 'x' })).toBe(30_000)
    expect(pluginHookTimeoutMs({ command: 'x', timeoutSec: 5 })).toBe(5_000)
    expect(pluginHookTimeoutMs({ command: 'x', timeoutSec: 600 })).toBe(120_000)
  })

  it('asks the runtime for 30 seconds even though the bridge’s default is 10 minutes', async () => {
    const asked: number[] = []
    const fake = {
      run: async (request: { timeoutMs?: number }) => {
        asked.push(request.timeoutMs ?? -1)
        return {
          status: 'completed',
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
          containment: {
            backend: 'seatbelt',
            decision: 'contained',
            policyHash: 'x',
            reason: '',
          },
        }
      },
    } as unknown as OwnedProcessRuntime
    const plain = setup({ command: 'true', runtime: fake })
    await plain.run()
    const long = setup({ command: 'true', timeoutSec: 600, runtime: fake })
    await long.run()
    expect(asked).toEqual([30_000, 120_000])
  })

  it.runIf(darwin)(
    '4: a hook past its timeout is stopped and the tool call goes on as after a hook failure',
    async () => {
      const f = setup({
        command: 'sleep 20; echo late > "$PLUGIN_DATA/late.txt"',
        timeoutSec: 1,
      })
      const started = Date.now()
      await f.run()
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(f.calls).toEqual(['x'])
      expect(existsSync(join(f.pluginData, 'late.txt'))).toBe(false)
      const result = f.agent.session.lastOf('hook/result')!.data
      expect(result.exitCode).toBeUndefined()
      expect(result.stderrSummary).toContain('timed out')
      expect(f.health.failure('kit', 'PreToolUse#1')).toMatchObject({
        reason: expect.stringContaining('超过 1 秒'),
      })
    },
    30_000,
  )
})

describe('plugin hooks: failures for the detail page (SEC-07)', () => {
  it.runIf(darwin)(
    'keeps the reason and the variables a failed hook may need, and clears them once it works',
    async () => {
      vi.stubEnv('ACME_KEY', 'present-in-emperor')
      const command =
        'test -n "$ACME_KEY" || { echo "ACME_KEY is not set" >&2; exit 1; }'
      const undeclared = setup({ command })
      const changes: number[] = []
      undeclared.health.onChange(() => changes.push(1))
      await undeclared.run()
      expect(undeclared.calls).toEqual(['x'])
      expect(undeclared.health.failure('kit', 'PreToolUse#1')).toEqual({
        reason: '最近一次运行失败（退出码 1）：ACME_KEY is not set',
        variables: [{ name: 'ACME_KEY', state: 'undeclared' }],
        at: expect.any(Number),
      })
      expect(changes).toHaveLength(1)

      vi.stubEnv('ACME_KEY', undefined)
      const unset = setup({ command, allowedEnv: ['ACME_KEY'] })
      await unset.run()
      expect(unset.health.failure('kit', 'PreToolUse#1')?.variables).toEqual([
        { name: 'ACME_KEY', state: 'unset' },
      ])

      vi.stubEnv('ACME_KEY', 'present-in-emperor')
      const fixed = setup({ command, allowedEnv: ['ACME_KEY'] })
      fixed.health.record('kit', 'PreToolUse#1', {
        reason: 'old',
        variables: [],
        at: 1,
      })
      await fixed.run()
      expect(fixed.health.failure('kit', 'PreToolUse#1')).toBeNull()
    },
    60_000,
  )

  it('reads the variables a script in the package uses, not the ones it sets itself', () => {
    const root = tmp('emperor-sec07-scan-')
    mkdirSync(join(root, 'hooks'), { recursive: true })
    writeFileSync(
      join(root, 'hooks', 'guard.sh'),
      [
        '#!/bin/sh',
        'DIR=$(dirname "$0")',
        'curl -H "Authorization: Bearer $OPENAI_API_KEY" "$ENDPOINT_URL"',
        'echo "$DIR $HOME $PLUGIN_DATA $1"',
      ].join('\n'),
    )
    writeFileSync(
      join(root, 'hooks', 'guard.py'),
      'import os\nkey = os.environ["SERVICE_TOKEN"]\nurl = os.getenv("SERVICE_URL")\n',
    )
    expect(
      hookVariables({
        command: 'sh "$PLUGIN_ROOT/hooks/guard.sh"',
        pluginRoot: root,
        allowedEnv: ['ENDPOINT_URL'],
        env: {},
      }),
    ).toEqual([
      { name: 'ENDPOINT_URL', state: 'unset' },
      { name: 'OPENAI_API_KEY', state: 'undeclared' },
    ])
    expect(
      hookVariables({
        command: `python3 "\${CLAUDE_PLUGIN_ROOT}/hooks/guard.py"`,
        pluginRoot: root,
        allowedEnv: ['SERVICE_URL'],
        env: { SERVICE_URL: 'https://x' },
      }),
    ).toEqual([{ name: 'SERVICE_TOKEN', state: 'undeclared' }])
    // Outside the package, nothing is read.
    expect(
      hookVariables({
        command: 'sh /etc/profile',
        pluginRoot: root,
        allowedEnv: [],
        env: {},
      }),
    ).toEqual([])
  })
})
