import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCodeHooks } from '../../harness/hooks/claude-code'
import {
  CLAUDE_HOOK_EVENTS,
  defaultHookConfigPaths,
} from '../../harness/hooks/config'
import type { SessionEvent } from '../../session-log/types'
import { CoreHooksService } from './hooks-service'

const roots: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function fixture(options: { project?: boolean; events?: SessionEvent[] } = {}) {
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-service-')))
  roots.push(stateRoot)
  let projectDir: string | null = null
  if (options.project) {
    projectDir = join(stateRoot, 'project')
    mkdirSync(join(projectDir, '.claude'), { recursive: true })
  }
  const hooks = new ClaudeCodeHooks({
    configPaths: defaultHookConfigPaths({
      stateRoot,
      ...(projectDir ? { projectDir } : {}),
    }),
    logger: silent as never,
  })
  disposers.push(() => hooks.dispose())
  const assertMutation = vi.fn()
  const service = new CoreHooksService({
    stateRoot,
    hooks,
    activeProjectRoot: () => projectDir,
    assertMutation,
    sessionEvents: () => options.events ?? [],
  })
  return { stateRoot, projectDir, hooks, service, assertMutation }
}

const config = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash|Write',
        hooks: [{ type: 'command', command: 'echo pre' }],
      },
      {
        matcher: 'mcp__.*',
        hooks: [{ type: 'command', command: 'echo mcp', timeout: 5 }],
      },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
  },
}

describe('CoreHooksService', () => {
  it('reports an empty config before hooks.json exists', async () => {
    const f = fixture()
    await expect(f.service.getConfig()).resolves.toEqual({
      path: join(f.stateRoot, 'hooks.json'),
      content: '',
      files: [],
      events: {},
      errors: [],
      supportedEvents: [...CLAUDE_HOOK_EVENTS],
    })
  })

  it('saves raw JSON atomically, reloads the bridge, and returns the new config', async () => {
    const f = fixture()
    const text = JSON.stringify(config, null, 2)
    const saved = await f.service.saveConfig(text)
    expect(f.assertMutation).toHaveBeenCalledWith('hooks', 'saveConfig')
    expect(readFileSync(join(f.stateRoot, 'hooks.json'), 'utf8')).toBe(
      `${text}\n`,
    )
    expect(saved).toMatchObject({
      content: `${text}\n`,
      files: [join(f.stateRoot, 'hooks.json')],
      events: { PreToolUse: 2, Stop: 1 },
      errors: [],
    })
    expect(f.hooks.has('PreToolUse')).toBe(true)
  })

  it('accepts object / { content } envelopes on save', async () => {
    const f = fixture()
    await f.service.saveConfig({ config })
    expect(
      JSON.parse(readFileSync(join(f.stateRoot, 'hooks.json'), 'utf8')),
    ).toEqual(config)
    await f.service.saveConfig({ content: '{"hooks":{}}' })
    expect((await f.service.getConfig()).events).toEqual({})
  })

  it('rejects invalid JSON and invalid matchers without touching the file', async () => {
    const f = fixture()
    await f.service.saveConfig(config)
    const before = readFileSync(join(f.stateRoot, 'hooks.json'), 'utf8')
    await expect(f.service.saveConfig('{not json')).rejects.toMatchObject({
      code: 'validation_error',
    })
    await expect(
      f.service.saveConfig({
        hooks: {
          PreToolUse: [
            { matcher: '(', hooks: [{ type: 'command', command: 'x' }] },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_error' })
    await expect(
      f.service.saveConfig({ hooks: { Stop: {} } }),
    ).rejects.toMatchObject({ code: 'validation_error' })
    expect(readFileSync(join(f.stateRoot, 'hooks.json'), 'utf8')).toBe(before)
  })

  it('validates candidates and reports skipped handler types and unknown events', () => {
    const f = fixture()
    const result = f.service.validateConfig({
      config: {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: 'prompt', prompt: 'x' },
                { type: 'command', command: 'ok' },
              ],
            },
          ],
          Notification: [],
        },
      },
    })
    expect(result).toEqual({
      valid: true,
      events: { PreToolUse: 1 },
      skipped: [{ event: 'PreToolUse', type: 'prompt' }],
      unknownEvents: ['Notification'],
      errors: [],
    })
    expect(f.service.validateConfig({ content: '[]' })).toMatchObject({
      valid: false,
    })
  })

  it('describes command-only metadata', () => {
    const f = fixture()
    const metadata = f.service.getMetadata()
    expect(metadata.handlerTypes).toEqual(['command'])
    expect(metadata.events.map((event) => event.eventName)).toEqual([
      ...CLAUDE_HOOK_EVENTS,
    ])
    expect(
      metadata.events.find((event) => event.eventName === 'PreToolUse')
        ?.matcher,
    ).toBe('tool_name')
  })

  it('matches loaded hooks with Claude Code matcher semantics across global and project files', async () => {
    const f = fixture({ project: true })
    await f.service.saveConfig(config)
    writeFileSync(
      join(f.projectDir!, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                { command: 'echo $CLAUDE_PROJECT_DIR ${CLAUDE_PROJECT_DIR}' },
              ],
            },
          ],
        },
      }),
    )
    f.hooks.reload()

    const bash = await f.service.testMatch({
      eventName: 'PreToolUse',
      toolName: 'Bash',
    })
    expect(bash.items.map((item) => item.command)).toEqual([
      'echo pre',
      `echo $CLAUDE_PROJECT_DIR ${f.projectDir}`,
    ])
    const mcp = await f.service.testMatch({
      eventName: 'PreToolUse',
      query: 'mcp__fs__read',
    })
    expect(mcp.items).toMatchObject([
      { index: 0, command: 'echo mcp', timeoutSec: 5, matcher: 'mcp__.*' },
      { index: 1 },
    ])
    const bashy = await f.service.testMatch({
      eventName: 'PreToolUse',
      toolName: 'Bashy',
    })
    expect(bashy.items.map((item) => item.command)).toEqual([
      `echo $CLAUDE_PROJECT_DIR ${f.projectDir}`,
    ])
    await expect(
      f.service.testMatch({ eventName: 'Nope' }),
    ).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('test-runs one command hook with a sample payload on stdin', async () => {
    const f = fixture()
    await f.service.saveConfig({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                command: `cat; echo '{"decision":"block","reason":"nope"}' >&2; exit 2`,
              },
            ],
          },
        ],
      },
    })
    await expect(
      f.service.testRun({ eventName: 'PreToolUse', toolName: 'Bash' }),
    ).rejects.toMatchObject({
      code: 'validation_error',
    })
    const result = await f.service.testRun({
      eventName: 'PreToolUse',
      toolName: 'Bash',
      confirmExecution: true,
    })
    expect(f.assertMutation).toHaveBeenCalledWith('hooks', 'testRun')
    expect(result).toMatchObject({
      eventName: 'PreToolUse',
      exitCode: 2,
      decision: 'block',
    })
    expect(JSON.parse(result.stdout)).toMatchObject({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: f.stateRoot,
    })

    const direct = await f.service.testRun({
      eventName: 'Stop',
      command: 'echo hi',
      confirmExecution: true,
    })
    expect(direct).toMatchObject({ exitCode: 0, stdout: 'hi' })
    await expect(
      f.service.testRun({
        eventName: 'PreToolUse',
        toolName: 'Write',
        confirmExecution: true,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('enforces the test-run timeout', async () => {
    const f = fixture()
    const result = await f.service.testRun({
      eventName: 'Stop',
      command: 'sleep 5',
      timeoutMs: 100,
      confirmExecution: true,
    })
    expect(result.exitCode).toBeNull()
    expect(result.stderr).toContain('timed out')
  })

  it('derives the audit from hook/* events of the active session, newest first', async () => {
    const events = [
      {
        type: 'hook/invoked',
        seq: 1,
        time: 100,
        data: {
          turn: 1,
          point: 'PreToolUse',
          dialect: 'claude-code',
          matcher: 'Bash',
          handlerId: 'h1',
        },
      },
      {
        type: 'hook/result',
        seq: 2,
        time: 110,
        data: {
          turn: 1,
          point: 'PreToolUse',
          handlerId: 'h1',
          decision: 'block',
          exitCode: 2,
          stderrSummary: 'no',
          durationMs: 10,
        },
      },
      {
        type: 'hook/invoked',
        seq: 3,
        time: 200,
        data: {
          turn: 1,
          point: 'Stop',
          dialect: 'claude-code',
          handlerId: 'h2',
        },
      },
      {
        type: 'hook/result',
        seq: 4,
        time: 205,
        data: {
          turn: 1,
          point: 'Stop',
          handlerId: 'h2',
          decision: 'pass',
          exitCode: 0,
          durationMs: 5,
        },
      },
    ] as unknown as SessionEvent[]
    const f = fixture({ events })
    const audit = await f.service.getAudit()
    expect(audit.total).toBe(2)
    expect(audit.records.map((record) => record.handlerId)).toEqual([
      'h2',
      'h1',
    ])
    expect(audit.records[1]).toEqual({
      handlerId: 'h1',
      eventName: 'PreToolUse',
      turn: 1,
      dialect: 'claude-code',
      matcher: 'Bash',
      outcome: 'block',
      exitCode: 2,
      stderrSummary: 'no',
      durationMs: 10,
      invokedAt: 100,
      completedAt: 110,
    })
    expect(
      (await f.service.getAudit({ outcome: 'block' })).records,
    ).toHaveLength(1)
    expect(await f.service.getAudit({ limit: 1 })).toMatchObject({
      cursor: '0',
      nextCursor: '1',
      total: 2,
    })
  })

  it('retires project trust and run cancellation; config-change authorization is a no-op', async () => {
    const f = fixture()
    await expect(f.service.setProjectTrust({})).rejects.toMatchObject({
      code: 'operation_retired',
    })
    await expect(f.service.cancelRun({ runId: 'x' })).rejects.toMatchObject({
      code: 'operation_retired',
    })
    await expect(
      f.service.authorizeConfigChange('config.save', {}),
    ).resolves.toBeUndefined()
  })
})
