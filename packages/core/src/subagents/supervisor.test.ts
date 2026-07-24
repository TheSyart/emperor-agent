import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskManager } from '../tasks/manager'
import { TaskStatus } from '../tasks/models'
import { TaskRuntimeRegistry } from '../tasks/runtime'
import type { EnvironmentProcessRunner } from '../environment/process-runner'
import {
  GitWorktreeSubagentWorkspaceProvider,
  SubagentCapacityError,
  SubagentDepthError,
  SubagentSupervisor,
  type SubagentLaunchInput,
  type SubagentLaunchResult,
  type SubagentWorkspaceProvider,
} from './supervisor'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fixture(
  opts: ConstructorParameters<typeof SubagentSupervisor>[2] = {},
) {
  const root = tmp('emperor-subagent-supervisor-')
  const manager = new TaskManager(root)
  const runtime = new TaskRuntimeRegistry(manager)
  const supervisor = new SubagentSupervisor(manager, runtime, opts)
  return { root, manager, runtime, supervisor }
}

function launchInput(
  execute: SubagentLaunchInput<string>['execute'],
  overrides: Partial<SubagentLaunchInput<string>> = {},
): SubagentLaunchInput<string> {
  return {
    title: 'inspect project',
    sessionId: 'session_1',
    agentType: 'sili_suitang',
    agentId: 'agent_1',
    turnId: 'turn_1',
    parentTaskId: 'turn:parent',
    parentDepth: 0,
    mode: 'foreground',
    ttlMs: 60_000,
    workspace: { mode: 'shared', root: '/workspace' },
    metadata: {},
    execute,
    ...overrides,
  }
}

describe('SubagentSupervisor', () => {
  it('creates detached Git worktrees with fixed argv and removes the exact lease', async () => {
    const worktreeRoot = tmp('emperor-subagent-worktrees-')
    const calls: Array<{ executable: string; args: string[]; cwd?: string }> =
      []
    const runner: EnvironmentProcessRunner = {
      async run(request) {
        calls.push({
          executable: request.executable,
          args: [...request.args],
          ...(request.cwd ? { cwd: request.cwd } : {}),
        })
        return {
          status: 'completed',
          exitCode: 0,
          stdout: request.args.includes('rev-parse') ? '/repo\n' : '',
          stderr: '',
          durationMs: 1,
          error: null,
        }
      },
    }
    const provider = new GitWorktreeSubagentWorkspaceProvider({
      worktreeRoot,
      runner,
      resolveRuntime: async () => ({
        executable: '/usr/bin/git',
        env: { PATH: '/usr/bin' },
      }),
    })
    const expectedTarget = join(realpathSync(worktreeRoot), 'subagent_123')

    const lease = await provider.acquire({
      taskId: 'subagent_123',
      sessionId: 'session_1',
      sourceRoot: '/repo',
      mode: 'worktree',
    })
    await lease.cleanup()

    expect(lease.mode).toBe('worktree')
    expect(lease.root).toBe(expectedTarget)
    expect(
      calls
        .filter((call) => call.args.includes('worktree'))
        .map((call) => ({
          cwd: call.cwd,
          args: call.args.slice(call.args.indexOf('worktree')),
        })),
    ).toEqual([
      {
        cwd: '/repo',
        args: ['worktree', 'add', '--detach', expectedTarget, 'HEAD'],
      },
      {
        cwd: '/repo',
        args: ['worktree', 'remove', '--force', expectedTarget],
      },
      {
        cwd: '/repo',
        args: ['worktree', 'prune'],
      },
    ])
  })

  it('durably reconciles a Git worktree lease left by a crashed process', async () => {
    const worktreeRoot = tmp('emperor-subagent-worktree-reconcile-')
    const calls: string[][] = []
    const runner: EnvironmentProcessRunner = {
      async run(request) {
        calls.push([...request.args])
        return {
          status: 'completed',
          exitCode: 0,
          stdout: request.args.includes('rev-parse') ? '/repo\n' : '',
          stderr: '',
          durationMs: 1,
          error: null,
        }
      },
    }
    const options = {
      worktreeRoot,
      runner,
      resolveRuntime: async () => ({
        executable: '/usr/bin/git',
        env: { PATH: '/usr/bin' },
      }),
    }
    const first = new GitWorktreeSubagentWorkspaceProvider(options)
    const expectedTarget = join(realpathSync(worktreeRoot), 'subagent_crashed')
    await first.acquire({
      taskId: 'subagent_crashed',
      sessionId: 'session_1',
      sourceRoot: '/repo',
      mode: 'worktree',
    })

    const restarted = new GitWorktreeSubagentWorkspaceProvider(options)
    await restarted.reconcile()

    expect(
      calls.slice(-2).map((args) => args.slice(args.indexOf('worktree'))),
    ).toEqual([
      ['worktree', 'remove', '--force', expectedTarget],
      ['worktree', 'prune'],
    ])
    expect(JSON.parse(readFileSync(restarted.manifestPath, 'utf8'))).toEqual({
      version: 1,
      leases: {},
    })
  })

  it('cascades parent cancellation only to foreground and closes background by owner session', async () => {
    const { manager, supervisor } = fixture()
    const parent = new AbortController()
    const foregroundWork = deferred<string>()
    const backgroundWork = deferred<string>()
    const foreground = await supervisor.launch(
      launchInput(() => foregroundWork.promise, {
        agentId: 'foreground',
        parentSignal: parent.signal,
      }),
    )
    const background = await supervisor.launch(
      launchInput(() => backgroundWork.promise, {
        agentId: 'background',
        turnId: 'turn_2',
        mode: 'background',
        parentSignal: parent.signal,
      }),
    )

    parent.abort('parent stopped')
    await expect(foreground.handle.wait()).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
    })
    expect(manager.store.get(background.task.id)?.status).toBe(
      TaskStatus.RUNNING,
    )

    await supervisor.closeSession('session_1', 'session closed')
    await expect(background.handle.wait()).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      reason: 'session closed',
    })
    expect(supervisor.snapshot().active).toBe(0)
  })

  it('enforces depth one plus global and per-session concurrency before task creation', async () => {
    const { manager, supervisor } = fixture({
      maxGlobal: 2,
      maxPerSession: 1,
    })
    const workA = deferred<string>()
    const workB = deferred<string>()
    const first = await supervisor.launch(launchInput(() => workA.promise))

    await expect(
      supervisor.launch(
        launchInput(() => workB.promise, {
          agentId: 'same-session',
          turnId: 'turn_2',
        }),
      ),
    ).rejects.toBeInstanceOf(SubagentCapacityError)
    await expect(
      supervisor.launch(
        launchInput(() => workB.promise, {
          sessionId: 'session_2',
          agentId: 'nested',
          turnId: 'turn_3',
          parentDepth: 1,
        }),
      ),
    ).rejects.toBeInstanceOf(SubagentDepthError)
    const second = await supervisor.launch(
      launchInput(() => workB.promise, {
        sessionId: 'session_2',
        agentId: 'second-session',
        turnId: 'turn_4',
      }),
    )
    expect(manager.store.list()).toHaveLength(2)

    await supervisor.cancel(first.task.id, 'cleanup')
    await supervisor.cancel(second.task.id, 'cleanup')
  })

  it('expires background work by TTL and emits exactly one terminal notification', async () => {
    const notifications: Array<Record<string, unknown>> = []
    const { supervisor } = fixture({ defaultTtlMs: 20, maxTtlMs: 100 })
    const work = deferred<string>()
    const launched = await supervisor.launch(
      launchInput(() => work.promise, {
        mode: 'background',
        ttlMs: 20,
        notify: (event) => {
          notifications.push(event)
        },
      }),
    )

    await expect(
      supervisor.wait(launched.task.id, { timeoutMs: 250 }),
    ).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      reason: 'subagent_ttl_expired',
    })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      event: 'task_cancelled',
      task: { id: launched.task.id, status: TaskStatus.CANCELLED },
    })
  })

  it('supports timeout wait, bounded output read, cancel, and explicit resume metadata', async () => {
    const { manager, supervisor } = fixture()
    const firstWork = deferred<string>()
    const launch = async (
      resumedFromTaskId: string | null = null,
    ): Promise<SubagentLaunchResult<string>> =>
      await supervisor.launch(
        launchInput(
          resumedFromTaskId
            ? async () => 'resumed result'
            : () => firstWork.promise,
          {
            agentId: resumedFromTaskId ? 'agent_resumed' : 'agent_initial',
            turnId: resumedFromTaskId ? 'turn_resumed' : 'turn_initial',
            mode: 'background',
            ...(resumedFromTaskId ? { resumedFromTaskId } : {}),
            resume: async (source) => await launch(source.id),
          },
        ),
      )
    const initial = await launch()

    await expect(
      supervisor.wait(initial.task.id, { timeoutMs: 5 }),
    ).resolves.toBeUndefined()
    await supervisor.cancel(initial.task.id, 'user requested stop')
    await expect(supervisor.wait(initial.task.id)).resolves.toMatchObject({
      status: TaskStatus.CANCELLED,
      reason: 'user requested stop',
    })

    const resumed = await supervisor.resume(initial.task.id)
    await expect(supervisor.wait(resumed.task.id)).resolves.toMatchObject({
      status: TaskStatus.COMPLETED,
    })
    await expect(supervisor.readOutput(resumed.task.id)).resolves.toMatchObject(
      { content: 'resumed result', eof: true },
    )
    expect(manager.store.get(resumed.task.id)?.metadata).toMatchObject({
      resumed_from_task_id: initial.task.id,
      resume_generation: 1,
      owner_session_id: 'session_1',
    })
  })

  it('uses an optional worktree lease and always cleans it after terminal', async () => {
    const acquired: string[] = []
    const cleaned: string[] = []
    const workspaceProvider: SubagentWorkspaceProvider = {
      async acquire(input) {
        acquired.push(`${input.taskId}:${input.sourceRoot}`)
        return {
          mode: 'worktree',
          root: `/tmp/worktrees/${input.taskId}`,
          async cleanup() {
            cleaned.push(input.taskId)
          },
        }
      },
    }
    const { supervisor } = fixture({ workspaceProvider })
    let executionRoot = ''
    const launched = await supervisor.launch(
      launchInput(
        async ({ workspaceRoot }) => {
          executionRoot = workspaceRoot
          return 'done'
        },
        { workspace: { mode: 'worktree', root: '/repo' } },
      ),
    )

    await launched.handle.settled
    expect(executionRoot).toBe(`/tmp/worktrees/${launched.task.id}`)
    expect(acquired).toEqual([`${launched.task.id}:/repo`])
    expect(cleaned).toEqual([launched.task.id])
  })
})
