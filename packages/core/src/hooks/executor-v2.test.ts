import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { defaultHooksConfigV2 } from './schema'
import { ExecutionEnvironment } from '../environment/snapshot'

type Dict = Record<string, unknown>
type Result = {
  outcome: 'completed' | 'failed' | 'timeout' | 'cancelled'
  output: Dict | null
  reason: string
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
}
type Registry = {
  register(executor: unknown): void
  execute(handler: Dict, input: Dict, context: Dict): Promise<Result>
}

async function executorApi(): Promise<{
  registry(): Registry
  command(): unknown
}> {
  const module = (await import('./executor')) as unknown as Record<
    string,
    new (...args: unknown[]) => unknown
  >
  expect(module.HookExecutorRegistry).toBeTypeOf('function')
  expect(module.CommandHookExecutor).toBeTypeOf('function')
  const HookExecutorRegistry = module.HookExecutorRegistry!
  const CommandHookExecutor = module.CommandHookExecutor!
  return {
    registry: () => new HookExecutorRegistry() as Registry,
    command: () => new CommandHookExecutor(),
  }
}

function command(overrides: Dict = {}): Dict {
  return {
    id: 'command-test',
    type: 'command',
    enabled: true,
    command: process.execPath,
    args: [],
    shell: 'none',
    timeoutMs: 1_000,
    statusMessage: '',
    once: false,
    allowedEnv: [],
    async: false,
    asyncRewake: false,
    ...overrides,
  }
}

function input(): Dict {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: process.cwd(),
    state_root: '/state',
    tool_name: 'write_file',
    tool_input: { path: 'README.md' },
    tool_use_id: 'call-1',
  }
}

function context(overrides: Dict = {}): Dict {
  return {
    eventName: 'PreToolUse',
    cwd: process.cwd(),
    policy: defaultHooksConfigV2().policy,
    ...overrides,
  }
}

async function registry(): Promise<Registry> {
  const api = await executorApi()
  const registry = api.registry()
  registry.register(api.command())
  return registry
}

describe('hooks v2 command executor', () => {
  it('routes by handler type and parses event JSON from stdout', async () => {
    const run = await registry()
    const result = await run.execute(
      command({
        args: [
          '-e',
          'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const i=JSON.parse(s);process.stdout.write(JSON.stringify({decision:"deny",reason:i.tool_name}))})',
        ],
      }),
      input(),
      context(),
    )

    expect(result).toMatchObject({
      outcome: 'completed',
      output: { decision: 'deny', reason: 'write_file' },
    })
  })

  it('rejects shell execution unless the global policy enables it', async () => {
    const run = await registry()
    const result = await run.execute(
      command({ command: 'printf shell', shell: 'bash' }),
      input(),
      context(),
    )

    expect(result).toMatchObject({ outcome: 'failed', output: null })
    expect(result.reason).toMatch(/shell.*disabled/i)
  })

  it('exposes only the intersection of handler and policy environment allowlists', async () => {
    const previous = process.env.HOOK_EXECUTOR_SECRET
    const executionEnvironment = new ExecutionEnvironment(
      {
        revision: 'a'.repeat(64),
        catalogRevision: 'b'.repeat(64),
        projectFingerprint: 'c'.repeat(64),
        createdAt: '2026-07-11T02:00:00.000Z',
        platform: 'darwin',
        pathEntries: ['/usr/bin', '/bin'],
        env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
        toolPaths: {},
      },
      { HOOK_EXECUTOR_SECRET: 'captured' },
    )
    process.env.HOOK_EXECUTOR_SECRET = 'changed-after-snapshot'
    try {
      const run = await registry()
      const policy = defaultHooksConfigV2().policy
      policy.command.allowedEnv = ['HOOK_EXECUTOR_SECRET']
      const visible = await run.execute(
        command({
          allowedEnv: ['HOOK_EXECUTOR_SECRET'],
          args: [
            '-e',
            'process.stdout.write(JSON.stringify({reason:process.env.HOOK_EXECUTOR_SECRET||"missing"}))',
          ],
        }),
        input(),
        context({ policy, executionEnvironment }),
      )
      const hidden = await run.execute(
        command({
          allowedEnv: [],
          args: [
            '-e',
            'process.stdout.write(JSON.stringify({reason:process.env.HOOK_EXECUTOR_SECRET||"missing"}))',
          ],
        }),
        input(),
        context({ policy, executionEnvironment }),
      )

      expect(visible.output).toMatchObject({ reason: 'captured' })
      expect(hidden.output).toMatchObject({ reason: 'missing' })
    } finally {
      if (previous === undefined) delete process.env.HOOK_EXECUTOR_SECRET
      else process.env.HOOK_EXECUTOR_SECRET = previous
    }
  })

  it('treats exit 2 as deny and never lets nonzero JSON grant allow', async () => {
    const run = await registry()
    const denied = await run.execute(
      command({
        args: ['-e', 'process.stderr.write("blocked");process.exit(2)'],
      }),
      input(),
      context(),
    )
    const failed = await run.execute(
      command({
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({decision:"allow"}));process.exit(3)',
        ],
      }),
      input(),
      context(),
    )

    expect(denied).toMatchObject({
      outcome: 'completed',
      output: { decision: 'deny', reason: 'blocked' },
    })
    expect(failed).toMatchObject({ outcome: 'failed', output: null })
  })

  it('fails malformed JSON instead of silently passing through', async () => {
    const run = await registry()
    const result = await run.execute(
      command({ args: ['-e', 'process.stdout.write("{bad")'] }),
      input(),
      context(),
    )

    expect(result).toMatchObject({ outcome: 'failed', output: null })
    expect(result.reason).toMatch(/json/i)
  })

  it('distinguishes timeout from caller cancellation', async () => {
    const run = await registry()
    const timedOut = await run.execute(
      command({
        timeoutMs: 20,
        args: ['-e', 'setTimeout(()=>{},5000)'],
      }),
      input(),
      context(),
    )
    const controller = new AbortController()
    const cancelling = run.execute(
      command({
        timeoutMs: 5_000,
        args: ['-e', 'setTimeout(()=>{},5000)'],
      }),
      input(),
      context({ signal: controller.signal }),
    )
    controller.abort()
    const cancelled = await cancelling

    expect(timedOut.outcome).toBe('timeout')
    expect(cancelled.outcome).toBe('cancelled')
  })

  it('uses byte-counted tail buffers and reports truncation', async () => {
    const run = await registry()
    const policy = defaultHooksConfigV2().policy
    policy.command.maxOutputBytes = 32
    const result = await run.execute(
      command({
        args: ['-e', 'process.stdout.write("x".repeat(100)+"TAIL")'],
      }),
      input(),
      context({ policy }),
    )

    expect(result.outcome).toBe('completed')
    expect(result.stdoutBytes).toBe(104)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stdout.endsWith('TAIL')).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(32)
  })

  it('fails before spawning when cwd does not exist', async () => {
    const run = await registry()
    const result = await run.execute(
      command(),
      input(),
      context({ cwd: join(tmpdir(), 'missing-hooks-cwd') }),
    )

    expect(result).toMatchObject({ outcome: 'failed', output: null })
    expect(result.reason).toMatch(/cwd/i)
  })

  it.skipIf(process.platform === 'win32')(
    'kills descendant processes on timeout',
    async () => {
      const run = await registry()
      const root = mkdtempSync(join(tmpdir(), 'hooks-process-tree-'))
      const sentinel = join(root, 'descendant-finished')
      const childScript = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'done'),1000)`
      const parentScript = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}]);setTimeout(()=>{},5000)`
      const result = await run.execute(
        command({ timeoutMs: 50, args: ['-e', parentScript] }),
        input(),
        context(),
      )
      await delay(1250)

      expect(result.outcome).toBe('timeout')
      expect(existsSync(sentinel)).toBe(false)
    },
  )
})
