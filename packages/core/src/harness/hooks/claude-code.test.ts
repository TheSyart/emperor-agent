// Bridge specs: real tiny shell hooks in tmp dirs driven end-to-end
// through the scripted-model test harness.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { messageText, userText } from '../../llm/message'
import type { Message } from '../../llm/types'
import {
  createTestHarness,
  type ScriptedReply,
  type TestHarness,
} from '../testing'
import { defineTool } from '../tools/definition'
import { ClaudeCodeHooks, type ClaudeCodeHooksOptions } from './claude-code'
import { defaultHookConfigPaths, parseClaudeCodeConfig } from './config'

type Hooks = Record<
  string,
  Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>
>

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!()
})

function tmp(prefix = 'emperor-hooks-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

function writeJson(path: string, value: unknown): string {
  writeFileSync(path, JSON.stringify(value))
  return path
}

function setup(
  hooks: Hooks,
  options: {
    replies?: ScriptedReply[]
    bridge?: Partial<ClaudeCodeHooksOptions>
  } = {},
) {
  const dir = tmp()
  const config = writeJson(join(dir, 'hooks.json'), { hooks })
  const bridge = new ClaudeCodeHooks({
    configPaths: [config],
    ...options.bridge,
  })
  disposers.push(() => bridge.dispose())
  const h: TestHarness = createTestHarness({ replies: options.replies ?? [] })
  bridge.install(h.middleware, h.tools)
  h.sessions.create({ id: 'hooked', cwd: dir })
  const agent = h.agent('hooked')
  return { dir, bridge, h, agent }
}

function command(
  cmd: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: 'command', command: cmd, ...extra }
}

function echoTool(calls: string[]) {
  return defineTool({
    name: 'echo',
    description: 'Echo the input.',
    input: z.object({ value: z.string() }),
    async execute(args) {
      calls.push(args.value)
      return `echo:${args.value}`
    },
  })
}

function texts(messages: readonly Message[]): string[] {
  return messages.map((message) => messageText(message))
}

function payloads(
  dir: string,
  file = 'payloads.jsonl',
): Array<Record<string, unknown>> {
  return readFileSync(join(dir, file), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('config parsing and discovery', () => {
  it('parses settings or bare maps, substitutes roots, skips non-command hooks and drops Stop matchers', () => {
    const parsed = parseClaudeCodeConfig(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Edit|Write',
              hooks: [
                command('${CLAUDE_PLUGIN_ROOT}/a.sh ${CLAUDE_PROJECT_DIR}', {
                  timeout: 5,
                }),
                { type: 'prompt', prompt: 'x' },
              ],
            },
          ],
          Stop: [{ matcher: 'ignored', hooks: [command('stop.sh')] }],
          Notification: [{ hooks: [command('unsupported.sh')] }],
        },
      },
      { pluginRoot: '/plug', projectDir: '/proj' },
    )
    expect(parsed.config.PreToolUse).toEqual([
      {
        matcher: 'Edit|Write',
        hooks: [{ command: '/plug/a.sh /proj', timeoutSec: 5 }],
      },
    ])
    expect(parsed.config.Stop).toEqual([{ hooks: [{ command: 'stop.sh' }] }])
    expect(parsed.skipped).toEqual([{ event: 'PreToolUse', type: 'prompt' }])
    expect(
      parseClaudeCodeConfig({ PostToolUse: [{ hooks: [command('p.sh')] }] })
        .config.PostToolUse,
    ).toHaveLength(1)
    expect(() =>
      parseClaudeCodeConfig({
        PreToolUse: [{ matcher: '(', hooks: [command('x')] }],
      }),
    ).toThrow(/invalid claude-code regex matcher "\(" on event "PreToolUse"/)
  })

  it('discovers the default paths in order and isolates per-file errors on reload', () => {
    const stateRoot = tmp()
    const projectDir = tmp()
    const paths = defaultHookConfigPaths({ stateRoot, projectDir })
    expect(paths).toEqual([
      join(stateRoot, 'hooks.json'),
      join(projectDir, '.claude', 'settings.json'),
      join(projectDir, '.claude', 'settings.local.json'),
    ])
    writeJson(paths[0]!, { PreToolUse: [{ hooks: [command('a')] }] })
    mkdirSync(join(projectDir, '.claude'))
    writeFileSync(paths[1]!, '{ broken')
    const bridge = new ClaudeCodeHooks({ configPaths: paths })
    expect(bridge.describe()).toEqual({
      events: { PreToolUse: 1 },
      files: [paths[0]],
      errors: [expect.stringContaining(paths[1]!)],
    })
    expect(bridge.lastError).toContain(paths[1]!)

    writeJson(paths[1]!, {
      hooks: {
        PreToolUse: [{ hooks: [command('b')] }],
        Stop: [{ hooks: [command('c')] }],
      },
    })
    writeJson(paths[2]!, {
      hooks: { PreToolUse: [{ matcher: '[', hooks: [command('bad')] }] },
    })
    bridge.reload()
    const description = bridge.describe()
    expect(description.events).toEqual({ PreToolUse: 2, Stop: 1 })
    expect(description.files).toEqual([paths[0], paths[1]])
    expect(description.errors).toEqual([
      expect.stringContaining('invalid claude-code regex matcher'),
    ])
  })
})

describe.skipIf(process.platform === 'win32')(
  'ClaudeCodeHooks end to end',
  () => {
    it('PreToolUse deny (exit 2) blocks the tool and logs the invoked/result pair', async () => {
      const calls: string[] = []
      const { h, agent, dir } = setup(
        {
          PreToolUse: [
            { matcher: 'other', hooks: [command('exit 2')] },
            {
              matcher: 'echo',
              hooks: [
                command(
                  'cat >> payloads.jsonl; echo "no echo allowed" >&2; exit 2',
                ),
              ],
            },
          ],
        },
        {
          replies: [
            { tools: [{ id: 'c1', name: 'echo', args: { value: 'x' } }] },
            { text: 'ok' },
          ],
          bridge: {
            transcriptPath: (session) => `/transcripts/${session.id}.jsonl`,
          },
        },
      )
      h.tools.register(echoTool(calls))
      agent.followup(userText('go'))
      await agent.whenIdle()
      expect(calls).toEqual([])
      const result = agent.session.lastOf('tool/result')!
      expect(result.data.message.content[0]).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'Error: no echo allowed' }],
      })
      const [payload] = payloads(dir)
      expect(payload).toEqual({
        session_id: 'hooked',
        transcript_path: '/transcripts/hooked.jsonl',
        cwd: dir,
        hook_event_name: 'PreToolUse',
        tool_name: 'echo',
        tool_input: { value: 'x' },
        tool_use_id: 'c1',
      })
      const invoked = agent.session.events.filter(
        (event) => event.type === 'hook/invoked',
      )
      const results = agent.session.events.filter(
        (event) => event.type === 'hook/result',
      )
      expect(invoked.map((event) => event.data)).toEqual([
        {
          turn: 1,
          point: 'PreToolUse',
          dialect: 'claude-code',
          matcher: 'echo',
          handlerId: expect.any(String),
        },
      ])
      expect(results.map((event) => event.data)).toEqual([
        {
          turn: 1,
          point: 'PreToolUse',
          handlerId: invoked[0]!.data.handlerId,
          decision: 'block',
          exitCode: 2,
          stderrSummary: 'no echo allowed',
          durationMs: expect.any(Number),
        },
      ])
      expect(invoked[0]!.seq).toBeLessThan(results[0]!.seq)
    })

    it('PreToolUse ask routes through the approval channel', async () => {
      const calls: string[] = []
      const json = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'confirm echo',
        },
      })
      const { h, agent } = setup(
        { PreToolUse: [{ hooks: [command(`printf '%s' '${json}'`)] }] },
        {
          replies: [
            { tools: [{ id: 'c1', name: 'echo', args: { value: 'y' } }] },
            { text: 'ok' },
          ],
        },
      )
      h.tools.register(echoTool(calls))
      const reasons: Array<string | undefined> = []
      h.tools.setApprovalHandler(async (request) => {
        reasons.push(request.reason)
        return 'allowed-once'
      })
      agent.followup(userText('go'))
      await agent.whenIdle()
      expect(reasons).toEqual(['confirm echo'])
      expect(calls).toEqual(['y'])
    })

    it('PostToolUse additionalContext reaches the next request; block replaces the result', async () => {
      const calls: string[] = []
      const json = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'remember the echo',
        },
      })
      const { h, agent, dir } = setup(
        {
          PostToolUse: [
            {
              matcher: 'echo',
              hooks: [command(`cat >> payloads.jsonl; printf '%s' '${json}'`)],
            },
          ],
        },
        {
          replies: [
            { tools: [{ id: 'c1', name: 'echo', args: { value: 'z' } }] },
            { text: 'done' },
          ],
        },
      )
      h.tools.register(echoTool(calls))
      agent.followup(userText('go'))
      await agent.whenIdle()
      expect(calls).toEqual(['z'])
      const second = h.adapter.requests[1]!
      expect(texts(second.messages)).toContain('remember the echo')
      const context = second.messages.find(
        (message) => messageText(message) === 'remember the echo',
      )!
      expect(context.source).toEqual({ kind: 'context', producer: 'hooks' })
      expect(payloads(dir)[0]).toMatchObject({
        hook_event_name: 'PostToolUse',
        tool_name: 'echo',
        tool_response: 'echo:z',
        transcript_path: '',
      })

      const blocked = setup(
        {
          PostToolUse: [
            {
              hooks: [
                command(
                  `printf '%s' '${JSON.stringify({ decision: 'block', reason: 'output rejected' })}'`,
                ),
              ],
            },
          ],
        },
        {
          replies: [
            { tools: [{ id: 'c2', name: 'echo', args: { value: 'w' } }] },
            { text: 'done' },
          ],
        },
      )
      blocked.h.tools.register(echoTool([]))
      blocked.agent.followup(userText('go'))
      await blocked.agent.whenIdle()
      expect(
        blocked.agent.session.lastOf('tool/result')!.data.message.content[0],
      ).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'output rejected' }],
      })
    })

    it('UserPromptSubmit deny blocks the turn before any model request', async () => {
      const { h, agent, dir } = setup({
        UserPromptSubmit: [
          {
            hooks: [
              command(
                'cat >> payloads.jsonl; echo "prompt rejected" >&2; exit 2',
              ),
            ],
          },
        ],
      })
      agent.followup(userText('do something bad'))
      await agent.whenIdle()
      expect(h.adapter.requests).toHaveLength(0)
      expect(agent.session.lastOf('turn/end')!.data.reason).toEqual({
        kind: 'blocked',
      })
      expect(payloads(dir)[0]).toMatchObject({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'do something bad',
        session_id: 'hooked',
        cwd: dir,
      })
      expect(agent.session.lastOf('hook/result')!.data).toMatchObject({
        point: 'UserPromptSubmit',
        decision: 'block',
        stderrSummary: 'prompt rejected',
      })
    })

    it('UserPromptSubmit additionalContext enters after the prompt, only on step 1', async () => {
      const json = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: 'prompt context',
        },
      })
      const { h, agent } = setup(
        { UserPromptSubmit: [{ hooks: [command(`printf '%s' '${json}'`)] }] },
        {
          replies: [
            { tools: [{ id: 'c1', name: 'echo', args: { value: 'a' } }] },
            { text: 'done' },
          ],
        },
      )
      h.tools.register(echoTool([]))
      agent.followup(userText('hello'))
      await agent.whenIdle()
      expect(texts(h.adapter.requests[0]!.messages)).toEqual([
        'hello',
        'prompt context',
      ])
      expect(
        agent.session.events.filter((event) => event.type === 'hook/invoked'),
      ).toHaveLength(1)
    })

    it('Stop block forces one more step with the reason steered in', async () => {
      const { h, agent, dir } = setup(
        {
          Stop: [
            {
              hooks: [
                command(
                  'cat >> payloads.jsonl; if [ -f stopped ]; then exit 0; fi; touch stopped; echo "keep going" >&2; exit 2',
                ),
              ],
            },
          ],
        },
        { replies: [{ text: 'first' }, { text: 'second' }] },
      )
      agent.followup(userText('work'))
      await agent.whenIdle()
      expect(h.adapter.requests).toHaveLength(2)
      const steered = h.adapter.requests[1]!.messages.at(-1)!
      expect(messageText(steered)).toBe('keep going')
      expect(steered.source).toEqual({ kind: 'context', producer: 'hooks' })
      expect(agent.session.lastOf('turn/end')!.data.reason).toEqual({
        kind: 'completed',
      })
      expect(
        payloads(dir).map((p) => [p.hook_event_name, p.stop_hook_active]),
      ).toEqual([
        ['Stop', false],
        ['Stop', true],
      ])
    })

    it('caps a looping Stop hook at 3 consecutive forced continuations', async () => {
      const { h, agent } = setup(
        { Stop: [{ hooks: [command('exit 2')] }] },
        {
          replies: [{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }],
        },
      )
      agent.followup(userText('loop'))
      await agent.whenIdle()
      expect(h.adapter.requests).toHaveLength(4)
      expect(messageText(h.adapter.requests[1]!.messages.at(-1)!)).toBe(
        'continue: blocked by Stop hook',
      )
      expect(agent.session.lastOf('turn/end')!.data.reason).toEqual({
        kind: 'completed',
      })
      expect(
        agent.session.events
          .filter((event) => event.type === 'hook/result')
          .map((event) => event.data.point),
      ).toEqual(['Stop', 'Stop', 'Stop', 'Stop'])
    })

    it('caps the persisted stderr summary at 500 characters', async () => {
      const { agent } = setup(
        { Stop: [{ hooks: [command(`printf '%0600d' 0 >&2; exit 1`)] }] },
        { replies: [{ text: 'ok' }] },
      )
      agent.followup(userText('hi'))
      await agent.whenIdle()
      const result = agent.session.lastOf('hook/result')!.data
      expect(result).toMatchObject({ decision: 'pass', exitCode: 1 })
      expect(result.stderrSummary).toHaveLength(501)
    })

    it('SessionStart and SubagentStart run detached and inject context without logging hook events', async () => {
      const start = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'session context',
        },
      })
      const sub = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: 'child context',
        },
      })
      const { bridge, h, agent, dir } = setup({
        SessionStart: [
          { matcher: 'resume', hooks: [command('exit 2')] },
          {
            matcher: 'startup',
            hooks: [command(`cat >> payloads.jsonl; printf '%s' '${start}'`)],
          },
        ],
        SubagentStart: [
          {
            matcher: '*',
            hooks: [command(`cat >> sub.jsonl; printf '%s' '${sub}'`)],
          },
        ],
        SubagentStop: [{ hooks: [command('cat >> sub.jsonl')] }],
      })
      bridge.sessionStarted(agent, 'startup')
      await vi.waitFor(() => {
        expect(agent.inbox.nextStep.map((m) => messageText(m))).toEqual([
          'session context',
        ])
      })
      expect(payloads(dir)[0]).toMatchObject({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'hooked',
      })

      h.sessions.create({
        id: 'child',
        cwd: dir,
        parentSession: 'hooked',
        origin: 'subagent',
        delegationDepth: 1,
      })
      const child = h.agent('child')
      bridge.subagentStarted(child)
      await vi.waitFor(() => {
        expect(child.inbox.nextStep.map((m) => messageText(m))).toEqual([
          'child context',
        ])
      })
      bridge.subagentStopped(child)
      await vi.waitFor(() => {
        expect(payloads(dir, 'sub.jsonl')).toHaveLength(2)
      })
      expect(
        payloads(dir, 'sub.jsonl').map((p) => [
          p.hook_event_name,
          p.agent_id,
          p.agent_type,
          p.stop_hook_active,
        ]),
      ).toEqual([
        ['SubagentStart', 'child', 'general-purpose', undefined],
        ['SubagentStop', 'child', 'general-purpose', false],
      ])
      expect(
        agent.session.events.some((event) => event.type.startsWith('hook/')),
      ).toBe(false)
    })

    it('exports CLAUDE_PROJECT_DIR (session cwd by default) and substitutes CLAUDE_PLUGIN_ROOT', async () => {
      const plugin = tmp('emperor-plugin-')
      writeFileSync(
        join(plugin, 'hook.sh'),
        'printf "%s|%s" "$CLAUDE_PROJECT_DIR" "$CLAUDE_PLUGIN_ROOT" > env.txt\n',
      )
      const { agent, dir } = setup(
        { Stop: [{ hooks: [command('sh ${CLAUDE_PLUGIN_ROOT}/hook.sh')] }] },
        {
          replies: [{ text: 'ok' }],
          bridge: { pluginRoot: plugin },
        },
      )
      agent.followup(userText('hi'))
      await agent.whenIdle()
      expect(readFileSync(join(dir, 'env.txt'), 'utf8')).toBe(
        `${dir}|${plugin}`,
      )
    })

    it('dispose aborts a running detached hook', async () => {
      const { bridge, agent } = setup({
        SessionStart: [{ hooks: [command('sleep 30')] }],
      })
      bridge.sessionStarted(agent, 'startup')
      const started = Date.now()
      await bridge.dispose()
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(agent.inbox.nextStep).toHaveLength(0)
    })

    it('uninstall removes every registered handler', () => {
      const h = createTestHarness()
      const bridge = new ClaudeCodeHooks({ configPaths: [] })
      const before = [
        h.middleware.preStep.length,
        h.middleware.turnStopping.length,
        h.tools.preExecute.length,
        h.tools.postExecute.length,
      ]
      const uninstall = bridge.install(h.middleware, h.tools)
      expect(h.tools.preExecute.length).toBe(before[2]! + 1)
      uninstall()
      expect([
        h.middleware.preStep.length,
        h.middleware.turnStopping.length,
        h.tools.preExecute.length,
        h.tools.postExecute.length,
      ]).toEqual(before)
    })
  },
)
