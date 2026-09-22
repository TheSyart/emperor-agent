// Background jobs (ports key dsh jobs-local / tool-jobs specs).
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { messageText, userText } from '../../llm/message'
import { ApprovalService } from '../approval/service'
import { SystemPromptAssembler } from '../prompt/assembler'
import { LocalSandbox } from '../sandbox/backend'
import { SandboxPolicyService } from '../sandbox/policy'
import { createTestHarness } from '../testing'
import { createShellTool } from '../tools/builtin/shell/tool'
import { textOf } from '../tools/definition'
import { ToolRegistry } from '../tools/registry'
import type { ToolServices } from '../tools/services'
import { JobRegistry, type JobOutcome } from './registry'
import { createJobTools, installJobsPromptSection } from './tools'

const posix = process.platform !== 'win32'

let root: string
let workspace: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-jobs-')))
  workspace = join(root, 'ws')
  mkdirSync(workspace)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function services(): ToolServices {
  return {
    sandbox: new SandboxPolicyService({
      defaultMode: 'danger-full-access',
      workspaceRoot: workspace,
    }),
    sandboxBackend: new LocalSandbox(),
    approval: new ApprovalService(),
    spillRoot: join(root, 'spill'),
  }
}

function hostTools(
  jobs: JobRegistry,
): (name: string, args: Record<string, unknown>) => Promise<string> {
  const tools = new ToolRegistry()
  tools.register(
    createShellTool(services(), {
      platform: 'linux',
      jobs,
      graceMs: 200,
    }) as never,
  )
  for (const tool of createJobTools(jobs)) tools.register(tool)
  let n = 0
  return async (name, args) => {
    const result = await tools.execute({
      callId: `c${++n}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
    })
    return textOf(result.content)
  }
}

async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs)
      throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A controllable fake producer. */
function fakeJob() {
  let finish!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => {
    finish = resolve
  })
  const cancels: Array<string | undefined> = []
  return {
    hooks: {
      cancel: (reason?: string) => {
        cancels.push(reason)
        finish({ status: 'killed', detail: 'killed before exit' })
      },
      done,
      readOutput: () => '',
    },
    finish,
    cancels,
  }
}

describe.skipIf(!posix)('background bash jobs', () => {
  it('starts a background job and collects it with job_output wait', async () => {
    const jobs = new JobRegistry()
    const call = hostTools(jobs)
    expect(
      await call('bash', {
        command: 'echo hi; echo err >&2',
        description: 'Say hi',
        run_in_background: true,
      }),
    ).toBe('started background job bash-1')
    expect(await call('job_output', { job_id: 'bash-1', wait: true })).toBe(
      'hi\n[stderr]\nerr\n[status: completed, exit code: 0]',
    )
    expect(jobs.get('bash-1')).toMatchObject({
      status: 'completed',
      exitCode: 0,
      reported: true,
    })
  })

  it('returns only new output per read and ends every response with a status line', async () => {
    const jobs = new JobRegistry()
    const call = hostTools(jobs)
    const gate = join(root, 'go')
    await call('bash', {
      command: `echo a; while [ ! -f ${gate} ]; do sleep 0.02; done; echo b; exit 4`,
      description: 'Gated output',
      run_in_background: true,
    })
    let first = ''
    // Poll until the first line is visible.
    const start = Date.now()
    while (!first.startsWith('a')) {
      first = await call('job_output', { job_id: 'bash-1' })
      if (first.startsWith('(no new output)')) first = ''
      if (Date.now() - start > 5_000) throw new Error('no first output')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(first).toBe('a\n[status: running]')
    expect(await call('job_output', { job_id: 'bash-1' })).toBe(
      '(no new output)\n[status: running]',
    )
    // A timed-out wait leaves the job alive.
    expect(
      await call('job_output', {
        job_id: 'bash-1',
        wait: true,
        timeout_ms: 50,
      }),
    ).toBe('(no new output)\n[status: running]')
    writeFileSync(gate, '')
    expect(await call('job_output', { job_id: 'bash-1', wait: true })).toBe(
      'b\n[status: completed, exit code: 4]',
    )
    expect(await call('job_output', { job_id: 'bash-1' })).toBe(
      '(no new output)\n[status: completed, exit code: 4]',
    )
    expect(await call('job_list', {})).toBe(
      `bash-1 [bash] completed — echo a; while [ ! -f ${gate} ]; do sleep 0.02; done; echo b; exit 4`,
    )
  })

  it('job_kill stops the process group and settles as killed', async () => {
    const jobs = new JobRegistry()
    const call = hostTools(jobs)
    await call('bash', {
      command: 'sleep 30',
      description: 'Sleep a while',
      run_in_background: true,
    })
    expect(
      await call('job_kill', { job_id: 'bash-1', reason: 'no longer needed' }),
    ).toBe('requested cancellation of job bash-1')
    expect(await call('job_output', { job_id: 'bash-1', wait: true })).toBe(
      '(no new output)\n[status: killed, signal: SIGTERM]',
    )
    expect(await call('job_kill', { job_id: 'bash-1' })).toBe(
      'job bash-1 had already finished [status: killed, signal: SIGTERM]',
    )
    expect(await call('job_output', { job_id: 'nope' })).toContain(
      'unknown job nope',
    )
  })

  it('wakes an idle owner with a completion notice and logs job events', async () => {
    const gate = join(root, 'go')
    const h = createTestHarness({
      replies: [
        {
          tools: [
            {
              id: 'c1',
              name: 'bash',
              args: {
                command: `while [ ! -f ${gate} ]; do sleep 0.02; done; echo hi`,
                description: 'Wait then greet',
                run_in_background: true,
              },
            },
          ],
        },
        { text: 'started it' },
        { text: 'noticed' },
      ],
    })
    const jobs = new JobRegistry()
    h.tools.register(
      createShellTool(services(), { platform: 'linux', jobs }) as never,
    )
    for (const tool of createJobTools(jobs)) h.tools.register(tool)
    h.sessions.create({ id: 's1', cwd: workspace })
    const agent = h.agent('s1')
    agent.followup(userText('run it in the background'))
    await agent.whenIdle()
    expect(agent.session.lastOf('job/started')?.data).toMatchObject({
      jobId: 'bash-1',
      kind: 'bash',
      description: 'Wait then greet',
    })
    writeFileSync(gate, '')
    await until(() => h.adapter.requests.length === 3)
    await agent.whenIdle()
    const last = h.adapter.requests[2]!.messages.at(-1)!
    expect(messageText(last)).toBe(
      `background job bash-1 (bash: while [ ! -f ${gate} ]; do sleep 0.02; done; echo hi) finished [status: completed, exit code: 0]. Read its output with job_output.`,
    )
    expect(last.source).toMatchObject({
      kind: 'context',
      producer: 'jobs',
      form: 'notice',
    })
    expect(agent.session.lastOf('job/finished')?.data).toEqual({
      jobId: 'bash-1',
      kind: 'bash',
      command: `while [ ! -f ${gate} ]; do sleep 0.02; done; echo hi`,
      status: 'completed',
      exitCode: 0,
      detail: 'exit code: 0',
    })
  })
})

describe('JobRegistry', () => {
  it('enforces the per-owner concurrency limit', () => {
    const h = createTestHarness()
    const a = h.agent()
    const b = h.agent()
    const jobs = new JobRegistry()
    for (let i = 0; i < 10; i++)
      jobs.start({
        kind: 'bash',
        label: `job ${i}`,
        owner: a,
        run: () => fakeJob().hooks,
      })
    expect(() =>
      jobs.start({
        kind: 'bash',
        label: 'one too many',
        owner: a,
        run: () => fakeJob().hooks,
      }),
    ).toThrow(/limit reached for this owner \(limit: 10\)/)
    expect(() =>
      jobs.start({
        kind: 'bash',
        label: 'other owner',
        owner: b,
        run: () => fakeJob().hooks,
      }),
    ).not.toThrow()
  })

  it('fences owned jobs by agent id', () => {
    const h = createTestHarness()
    const a = h.agent()
    const b = h.agent()
    const jobs = new JobRegistry()
    const id = jobs.start({
      kind: 'bash',
      label: 'mine',
      owner: a,
      run: () => fakeJob().hooks,
    })
    expect(jobs.list(b)).toEqual([])
    expect(() => jobs.get(id, b)).toThrow('belongs to another session')
    expect(jobs.list(a).map((job) => job.id)).toEqual([id])
  })

  it("disposeOwner cancels, awaits, and drops the owner's jobs without a notice", async () => {
    const h = createTestHarness()
    const a = h.agent()
    const jobs = new JobRegistry()
    const job = fakeJob()
    jobs.start({ kind: 'bash', label: 'long', owner: a, run: () => job.hooks })
    await jobs.disposeOwner(a.id)
    expect(job.cancels).toEqual(['owner disposed'])
    expect(jobs.list(a)).toEqual([])
    expect(a.inbox.hasPending).toBe(false)
    expect(a.session.lastOf('job/finished')?.data.status).toBe('killed')
  })

  it('injects into a running owner instead of waking it', async () => {
    const h = createTestHarness()
    const a = h.agent()
    const jobs = new JobRegistry()
    const job = fakeJob()
    jobs.start({ kind: 'bash', label: 'x', owner: a, run: () => job.hooks })
    // Simulate a busy owner by making the notice arrive while status is running.
    Object.defineProperty(a, 'status', {
      get: () => 'running',
      configurable: true,
    })
    job.finish({ status: 'completed', detail: 'exit code: 0', exitCode: 0 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(a.inbox.nextStep).toHaveLength(1)
    expect(a.inbox.nextTurn).toHaveLength(0)
  })

  it('caps consecutive completion wakes at 3 until user input arrives', async () => {
    const h = createTestHarness({
      replies: [
        { text: 'w1' },
        { text: 'w2' },
        { text: 'w3' },
        { text: 'user' },
        { text: 'w4' },
      ],
    })
    const a = h.agent()
    const jobs = new JobRegistry()
    const complete = async (): Promise<void> => {
      const job = fakeJob()
      jobs.start({
        kind: 'bash',
        label: 'quick',
        owner: a,
        run: () => job.hooks,
      })
      job.finish({ status: 'completed', detail: 'exit code: 0', exitCode: 0 })
      await new Promise((resolve) => setTimeout(resolve, 5))
      await a.whenIdle()
    }
    await complete()
    await complete()
    await complete()
    expect(h.adapter.requests).toHaveLength(3)
    await complete()
    // Budget spent: the fourth notice is injected and waits for the next step.
    expect(h.adapter.requests).toHaveLength(3)
    expect(a.inbox.nextStep).toHaveLength(1)
    a.followup(userText('hello'))
    await a.whenIdle()
    expect(h.adapter.requests).toHaveLength(4)
    await complete()
    expect(h.adapter.requests).toHaveLength(5)
  })

  it('does not notify when a kill or live wait already reported the outcome', async () => {
    const h = createTestHarness()
    const a = h.agent()
    const jobs = new JobRegistry()
    const job = fakeJob()
    const id = jobs.start({
      kind: 'bash',
      label: 'x',
      owner: a,
      run: () => job.hooks,
    })
    const waited = jobs.wait(id, 1_000, a)
    job.finish({ status: 'completed', detail: 'exit code: 0', exitCode: 0 })
    expect((await waited).status).toBe('completed')
    expect(a.inbox.hasPending).toBe(false)
    expect(h.adapter.requests).toHaveLength(0)
  })

  it('installs the order-106 prompt section', () => {
    const prompt = new SystemPromptAssembler()
    installJobsPromptSection(prompt)
    expect(prompt.assemble().sections[0]).toMatchObject({ name: 'tool:jobs' })
    expect(prompt.assemble().sections[0]!.text).toContain(
      'Track every background job id you start.',
    )
  })
})
