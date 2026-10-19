// SEC-08 test 8 (with SEC-07): a plugin's hooks run through the same process
// containment as the Shell and MCP servers — the workspace read-only, the
// plugin's own data folder writable, Emperor's settings and the user's
// credentials closed — and leave a receipt. The user's own hooks.json hooks
// are trusted and run as before. With no sandbox, a plugin hook does not run.
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
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { userText } from '../../llm/message'
import { OsSandboxController } from '../../environment/sandbox'
import { OwnedProcessRuntime } from '../../processes/runtime'
import { ContainmentBackend } from '../../sandbox/policy'
import { createTestHarness } from '../testing'
import { defineTool } from '../tools/definition'
import { ClaudeCodeHooks } from './claude-code'
import { containedPluginHookRunner } from './contained'

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!()
})

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

function setup(backend?: ContainmentBackend) {
  const root = tmp('emperor-sec08-hooks-')
  const stateRoot = join(root, 'home', '.emperor')
  const workspace = join(root, 'project')
  const pluginRoot = join(stateRoot, 'plugins', 'cache', 'kit')
  const pluginData = join(stateRoot, 'plugins', 'data', 'kit')
  for (const dir of [workspace, pluginRoot, pluginData])
    mkdirSync(dir, { recursive: true })
  writeFileSync(join(stateRoot, 'model_config.json'), 'MODEL-CONFIG-SECRET')
  writeFileSync(join(pluginRoot, 'note.txt'), 'PLUGIN-PACKAGE')
  const userHooks = join(stateRoot, 'hooks.json')
  writeFileSync(
    userHooks,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'echo',
            hooks: [{ type: 'command', command: 'echo user > user-hook.txt' }],
          },
        ],
      },
    }),
  )
  const runtime = new OwnedProcessRuntime(stateRoot, {
    sandbox: new OsSandboxController(backend ? { backend } : {}),
  })
  const bridge = new ClaudeCodeHooks({
    configPaths: [userHooks],
    pluginHookRunner: containedPluginHookRunner({
      runtime,
      stateRoot,
      home: join(root, 'home'),
    }),
  })
  disposers.push(() => bridge.dispose())
  const probe = [
    `cat "${join(stateRoot, 'model_config.json')}" > "$PLUGIN_DATA/config.txt" 2>/dev/null || echo denied > "$PLUGIN_DATA/config.txt"`,
    `echo tampered > "${join(workspace, 'plugin-wrote.txt')}" 2>/dev/null || true`,
    `cat "$PLUGIN_ROOT/note.txt" > "$PLUGIN_DATA/package.txt"`,
    `echo "$TMPDIR" > "$PLUGIN_DATA/tmpdir.txt"`,
  ].join('; ')
  bridge.setPluginHooks([
    {
      id: 'kit@user',
      pluginId: 'kit',
      env: {
        PLUGIN_ROOT: pluginRoot,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        PLUGIN_DATA: pluginData,
        CLAUDE_PLUGIN_DATA: pluginData,
      },
      config: {
        PreToolUse: [{ matcher: 'echo', hooks: [{ command: probe }] }],
      },
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
  return { root, stateRoot, workspace, pluginData, agent, calls }
}

function receipts(stateRoot: string): Array<Record<string, any>> {
  const file = join(stateRoot, 'processes', 'receipts.v1.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
}

describe('plugin hooks in the process sandbox (SEC-08 test 8)', () => {
  it.runIf(process.platform === 'darwin')(
    'runs a plugin hook contained and the user hook as before',
    async () => {
      const f = setup()
      f.agent.followup(userText('go'))
      await f.agent.whenIdle()
      expect(f.calls).toEqual(['x'])
      // The user's own hook ran in the workspace as before.
      expect(readFileSync(join(f.workspace, 'user-hook.txt'), 'utf8')).toBe(
        'user\n',
      )
      const data = (name: string) =>
        readFileSync(join(f.pluginData, name), 'utf8').trim()
      expect(data('config.txt')).toBe('denied')
      expect(data('package.txt')).toBe('PLUGIN-PACKAGE')
      expect(data('tmpdir.txt')).toBe(
        join(f.stateRoot, 'plugins', 'tmp', 'kit'),
      )
      expect(existsSync(join(f.workspace, 'plugin-wrote.txt'))).toBe(false)
      expect(
        receipts(f.stateRoot).find((item) => item.owner.kind === 'hook'),
      ).toMatchObject({
        owner: { kind: 'hook', id: 'kit', sessionId: 'hooked' },
        containment: { backend: 'seatbelt', decision: 'contained' },
      })
    },
    30_000,
  )

  it('does not run a plugin hook when the sandbox is unavailable; the tool call goes on', async () => {
    const f = setup(
      new ContainmentBackend({
        platform: 'darwin',
        probe: () => ({ ok: false, detail: 'mock: no sandbox' }),
      }),
    )
    f.agent.followup(userText('go'))
    await f.agent.whenIdle()
    expect(f.calls).toEqual(['x'])
    expect(existsSync(join(f.pluginData, 'config.txt'))).toBe(false)
    expect(
      receipts(f.stateRoot).find((item) => item.owner.kind === 'hook'),
    ).toMatchObject({
      status: 'refused',
      containment: { decision: 'refused' },
    })
  })
})
