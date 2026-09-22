// Shell tool semantics (ports key dsh tool-bash / bash-local / bash-sandbox specs).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userText } from '../../../../llm/message'
import { ApprovalService } from '../../../approval/service'
import {
  LocalSandbox,
  type ConfinedArgv,
  type SandboxBackend,
} from '../../../sandbox/backend'
import {
  SandboxPolicyService,
  SandboxUnavailableError,
  type SandboxMode,
  type SandboxPolicy,
} from '../../../sandbox/policy'
import { createTestHarness, type ScriptedReply } from '../../../testing'
import { textOf, type ToolExecutionResult } from '../../definition'
import { ToolRegistry } from '../../registry'
import type { ToolServices } from '../../services'
import { buildShellEnv } from './env'
import { parseExitStatus } from './render'
import {
  createShellTool,
  installShellPromptSection,
  type ShellToolOptions,
} from './tool'
import { SystemPromptAssembler } from '../../../prompt/assembler'

const posix = process.platform !== 'win32'

let root: string
let workspace: string
let spillRoot: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-shell-')))
  workspace = join(root, 'ws')
  spillRoot = join(root, 'spill')
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A backend that confines by passing argv through, recording calls. */
class PassthroughSandbox implements SandboxBackend {
  readonly calls: SandboxPolicy[] = []
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    this.calls.push(policy)
    return {
      argv: [...argv],
      enforcement: 'full',
      denialSignatures: ['operation not permitted'],
      runnerFailureRules: [{ fatalSignatures: ['runner: '] }],
    }
  }
}

class UnavailableSandbox implements SandboxBackend {
  confine(_argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    throw new SandboxUnavailableError(policy.mode)
  }
}

function services(
  mode: SandboxMode,
  backend: SandboxBackend = new PassthroughSandbox(),
  approval = new ApprovalService(),
): ToolServices {
  return {
    sandbox: new SandboxPolicyService({
      defaultMode: mode,
      workspaceRoot: workspace,
    }),
    sandboxBackend: backend,
    approval,
    spillRoot,
  }
}

async function run(
  args: Record<string, unknown>,
  svc: ToolServices = services('danger-full-access'),
  options: ShellToolOptions = {},
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const tools = new ToolRegistry()
  tools.register(
    createShellTool(svc, { platform: 'linux', ...options }) as never,
  )
  return tools.execute({
    callId: 'c1',
    name: 'bash',
    arguments: { description: 'Run a test command', ...args },
    signal: signal ?? new AbortController().signal,
  })
}

function meta(result: ToolExecutionResult): Record<string, unknown> {
  return result.meta as Record<string, unknown>
}

describe.skipIf(!posix)('bash tool', () => {
  it('runs a command and reports clean exits without a marker', async () => {
    const result = await run({ command: 'echo hello' })
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toBe('hello\n')
    expect(meta(result)).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      stdoutTruncated: false,
      sandbox: { mode: 'danger-full-access', escalated: false },
    })
    expect(typeof meta(result)['durationMs']).toBe('number')
  })

  it('reports non-zero exits with the stderr section and the exit marker last', async () => {
    const result = await run({ command: 'echo out; echo oops >&2; exit 3' })
    expect(result.isError).toBe(false)
    const text = textOf(result.content)
    expect(text).toBe('out\n[stderr]\noops\n[exit code: 3]')
    expect(parseExitStatus(text)).toEqual({
      body: 'out\n[stderr]\noops',
      exitCode: 3,
    })
    expect(meta(result)['exitCode']).toBe(3)
  })

  it('renders (no output) for silent commands', async () => {
    expect(textOf((await run({ command: 'true' })).content)).toBe('(no output)')
  })

  it('kills the whole process group on timeout', async () => {
    const pidFile = join(root, 'child.pid')
    const started = Date.now()
    const result = await run(
      { command: `sleep 30 & echo $! > ${pidFile}; wait`, timeoutMs: 300 },
      undefined,
      { graceMs: 200 },
    )
    expect(Date.now() - started).toBeLessThan(5_000)
    const text = textOf(result.content)
    expect(text).toContain('[timed out after 300ms]')
    expect(text).toMatch(/\[killed by signal: SIG(TERM|KILL)\]$/)
    expect(meta(result)['timedOut']).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('escalates SIGTERM to SIGKILL for a TERM-trapping command', async () => {
    const result = await run(
      { command: 'trap "" TERM; sleep 5', timeoutMs: 200 },
      undefined,
      { graceMs: 200 },
    )
    expect(textOf(result.content)).toContain('[timed out after 200ms]')
    expect(meta(result)['timedOut']).toBe(true)
  })

  it('aborting the call kills the command and yields an aborted result', async () => {
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 150)
    const result = await run(
      { command: 'sleep 30' },
      undefined,
      { graceMs: 200 },
      controller.signal,
    )
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('ABORTED')
  })

  it('caps output to its tail and spills the full stream to a file', async () => {
    const result = await run(
      {
        command:
          'printf "HEAD"; head -c 5000 /dev/zero | tr "\\0" a; printf "TAIL"',
      },
      undefined,
      { maxOutputBytes: 1000 },
    )
    const text = textOf(result.content)
    const m = meta(result)
    expect(m['stdoutTruncated']).toBe(true)
    const spillPath = m['spillPath'] as string
    expect(spillPath.startsWith(spillRoot)).toBe(true)
    expect(text).toContain(`[output truncated; full output: ${spillPath}]`)
    const body = text.split('\n')[0]!
    expect(body).toHaveLength(1000)
    expect(body.endsWith('TAIL')).toBe(true)
    const full = readFileSync(spillPath, 'utf8')
    expect(full).toHaveLength(5008)
    expect(full.startsWith('HEAD')).toBe(true)
  })

  it('resolves workdir against the session workspace and rejects missing directories', async () => {
    mkdirSync(join(workspace, 'sub'))
    expect(textOf((await run({ command: 'pwd' })).content)).toBe(
      `${workspace}\n`,
    )
    expect(
      textOf((await run({ command: 'pwd', workdir: 'sub' })).content),
    ).toBe(`${join(workspace, 'sub')}\n`)
    expect(textOf((await run({ command: 'pwd', workdir: root })).content)).toBe(
      `${root}\n`,
    )
    const missing = await run({ command: 'pwd', workdir: 'nope' })
    expect(missing.isError).toBe(true)
    expect(textOf(missing.content)).toContain('workdir does not exist')
  })

  it('exposes managed EMPEROR_* variables and model-friendly terminal settings', async () => {
    const result = await run({
      command: 'echo "$EMPEROR_SHELL|$EMPEROR_WORKSPACE|$TERM|$PAGER"',
    })
    expect(textOf(result.content)).toBe(`1|${workspace}|dumb|cat\n`)
    const env = buildShellEnv(
      {
        PATH: '/bin',
        OPENAI_API_KEY: 'x',
        GH_TOKEN: 'y',
        EMPEROR_SESSION_ID: 'stale',
        EMPEROR_CONFIG_DIR: '/c',
      },
      { workspaceRoot: '/w' },
    )
    expect(env).toMatchObject({
      PATH: '/bin',
      EMPEROR_CONFIG_DIR: '/c',
      EMPEROR_SHELL: '1',
      EMPEROR_WORKSPACE: '/w',
    })
    expect(env['OPENAI_API_KEY']).toBeUndefined()
    expect(env['GH_TOKEN']).toBeUndefined()
    expect(env['EMPEROR_SESSION_ID']).toBeUndefined()
  })

  it('validates arguments', async () => {
    expect((await run({ command: '  ' })).isError).toBe(true)
    expect(
      textOf(
        (
          await run({
            command: 'true',
            sandbox_permissions: 'danger-full-access',
          })
        ).content,
      ),
    ).toContain('requires a justification')
    const noJobs = await run({ command: 'true', run_in_background: true })
    expect(textOf(noJobs.content)).toContain('background jobs unavailable')
  })

  it('fails closed when the sandbox is unavailable: the command never runs', async () => {
    const marker = join(workspace, 'ran')
    const result = await run(
      { command: `touch ${marker}` },
      services('workspace-write', new UnavailableSandbox()),
    )
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('SANDBOX_UNAVAILABLE')
    expect(textOf(result.content)).toContain(
      'refusing to run the command unconfined',
    )
    expect(existsSync(marker)).toBe(false)
  })

  it('runs danger-full-access unconfined (the backend is never consulted)', async () => {
    const marker = join(workspace, 'ran')
    const result = await run(
      { command: `touch ${marker}` },
      services('danger-full-access', new UnavailableSandbox()),
    )
    expect(result.isError).toBe(false)
    expect(existsSync(marker)).toBe(true)
  })

  it('confines read-only / workspace-write and appends the denial marker + escalation hint', async () => {
    const backend = new PassthroughSandbox()
    const result = await run(
      { command: 'echo "touch: x: Operation not permitted" >&2; exit 1' },
      services('read-only', backend),
    )
    expect(backend.calls).toEqual([
      { mode: 'read-only', workspaceRoot: workspace },
    ])
    const text = textOf(result.content)
    expect(text).toBe(
      [
        '[stderr]',
        'touch: x: Operation not permitted',
        '[sandbox: file access denied under read-only mode]',
        '[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
        '[exit code: 1]',
      ].join('\n'),
    )
    expect(meta(result)['sandbox']).toEqual({
      mode: 'read-only',
      escalated: false,
      denied: true,
    })
  })

  it('treats a runner failure as SANDBOX_UNAVAILABLE', async () => {
    const result = await run(
      { command: 'echo "runner: cannot set up" >&2; exit 1' },
      services('read-only'),
    )
    expect(result.error?.info?.code).toBe('SANDBOX_UNAVAILABLE')
    expect(textOf(result.content)).toContain(
      'Runner failure: runner: cannot set up',
    )
  })

  it('installs the order-105 prompt section', () => {
    const prompt = new SystemPromptAssembler()
    installShellPromptSection(prompt, { platform: 'linux' })
    const section = prompt.assemble().sections[0]!
    expect(section.name).toBe('tool:bash')
    expect(section.text).toContain('[exit code: N] marker on every bash result')
    expect(section.text).toContain('`workdir`')
  })

  it('names the tool pwsh on win32', () => {
    const tool = createShellTool(services('danger-full-access'), {
      platform: 'win32',
    })
    expect(tool.name).toBe('pwsh')
    expect(tool.description).toContain('pwsh -NoProfile -Command')
  })
})

describe.skipIf(!posix)('bash tool with an agent', () => {
  function harnessWith(svc: ToolServices, replies: ScriptedReply[]) {
    const h = createTestHarness({ replies })
    h.tools.register(createShellTool(svc, { platform: 'linux' }) as never)
    h.sessions.create({ id: 's1', cwd: workspace })
    return { h, agent: h.agent('s1') }
  }

  it('runs an approved escalation once in the wider mode', async () => {
    const backend = new PassthroughSandbox()
    const approval = new ApprovalService()
    const asked: string[] = []
    approval.setAnswerer(async (request) => {
      asked.push(request.reason ?? '')
      return 'allowed-once'
    })
    const svc = services('read-only', backend, approval)
    const { agent } = harnessWith(svc, [
      {
        tools: [
          {
            id: 'c1',
            name: 'bash',
            args: {
              command: 'echo $EMPEROR_SESSION_ID',
              description: 'Print session id',
              sandbox_permissions: 'danger-full-access',
              justification: 'Needs full access.',
            },
          },
        ],
      },
      {
        tools: [
          {
            id: 'c2',
            name: 'bash',
            args: { command: 'echo again', description: 'Print again' },
          },
        ],
      },
      { text: 'done' },
    ])
    agent.followup(userText('go'))
    await agent.whenIdle()
    expect(asked).toEqual([
      'escalate sandbox to danger-full-access: Needs full access.',
    ])
    const results = agent.session.events.filter((e) => e.type === 'tool/result')
    const first = results[0]!
    expect(
      first.type === 'tool/result' &&
        textOf(first.data.message.content[0].content),
    ).toBe('s1\n')
    expect(first.type === 'tool/result' && first.data.meta).toMatchObject({
      sandbox: { mode: 'danger-full-access', escalated: true },
    })
    // The grant never outlives the call: the next command is confined again.
    expect(backend.calls.map((call) => call.mode)).toEqual(['read-only'])
  })

  it('reports a rejected escalation as an error and does not run the command', async () => {
    const approval = new ApprovalService()
    approval.setAnswerer(async () => 'rejected')
    const marker = join(workspace, 'ran')
    const { agent } = harnessWith(
      services('read-only', new PassthroughSandbox(), approval),
      [
        {
          tools: [
            {
              id: 'c1',
              name: 'bash',
              args: {
                command: `touch ${marker}`,
                description: 'Touch a marker',
                sandbox_permissions: 'workspace-write',
                justification: 'Needs to write.',
              },
            },
          ],
        },
        { text: 'ok' },
      ],
    )
    agent.followup(userText('go'))
    await agent.whenIdle()
    const result = agent.session.lastOf('tool/result')!
    expect(textOf(result.data.message.content[0].content)).toContain(
      'the user rejected escalating this command to "workspace-write"',
    )
    expect(existsSync(marker)).toBe(false)
  })
})

describe.skipIf(!new LocalSandbox().available())(
  'bash tool under the real local sandbox',
  () => {
    it('denies writes under read-only with the sandbox marker', async () => {
      const target = join(workspace, 'denied.txt')
      const result = await run(
        { command: `echo x > ${target}` },
        services('read-only', new LocalSandbox()),
      )
      const text = textOf(result.content)
      expect(text).toContain(
        '[sandbox: file access denied under read-only mode]',
      )
      expect(text).toContain('[sandbox: escalation available')
      expect(text).toMatch(/\[exit code: \d+\]$/)
      expect(existsSync(target)).toBe(false)
    })

    it('allows writes inside the workspace under workspace-write', async () => {
      const target = join(workspace, 'allowed.txt')
      const result = await run(
        { command: `echo x > ${target}` },
        services('workspace-write', new LocalSandbox()),
      )
      expect(result.isError).toBe(false)
      expect(readFileSync(target, 'utf8')).toBe('x\n')
    })

    it('denies writes outside the workspace under workspace-write', async () => {
      const outside = mkdtempSync(
        join(process.env['HOME'] ?? '/', '.emperor-sandbox-test-'),
      )
      try {
        const target = join(outside, 'escaped.txt')
        const result = await run(
          { command: `echo x > ${target}` },
          services('workspace-write', new LocalSandbox()),
        )
        expect(textOf(result.content)).toContain(
          '[sandbox: file access denied under workspace-write mode]',
        )
        expect(existsSync(target)).toBe(false)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  },
)
