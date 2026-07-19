import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActiveTaskRegistry, CancelledTaskError } from '../runtime/active'
import { TaskManager } from '../tasks/manager'
import { TaskStatus } from '../tasks/models'
import { TaskOutputStore, TaskRuntimeRegistry } from '../tasks/runtime'
import { WatchlistDecision } from '../watchlist/models'
import {
  SchedulerJob,
  SchedulerMisfirePolicy,
  SchedulerPayload,
  SchedulerRunTrigger,
  SchedulerSchedule,
  SCHEDULER_TARGET_SESSION_METADATA_KEY,
} from './models'
import {
  SchedulerJobExecutor,
  type SchedulerAgentTurnPayload,
} from './executor'
import type { SchedulerRunContext } from './service'
import { inSchedulerRun } from './tool'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makeJob(
  kind: 'agent_turn' | 'team_wake' | 'system_event',
  opts: Partial<{
    message: string
    target: string
    project_id: string
    deliver: boolean
    meta: Record<string, unknown>
  }> = {},
): SchedulerJob {
  return SchedulerJob.create({
    jobId: `${kind}-job`,
    name: `${kind} job`,
    schedule: new SchedulerSchedule({ kind: 'every', every_ms: 60_000 }),
    payload: new SchedulerPayload({
      kind,
      message: opts.message ?? 'do work',
      target: opts.target ?? null,
      project_id: opts.project_id ?? null,
      deliver: opts.deliver ?? true,
      meta: opts.meta ?? {},
    }),
    now: 1_700_000_000_000,
  })
}

function runContext(
  token = 'a',
  signal: AbortSignal = new AbortController().signal,
): SchedulerRunContext {
  return {
    runId: `schrun_${token.repeat(32)}`,
    taskId: `scheduler_run_${token.repeat(32)}`,
    trigger: SchedulerRunTrigger.TIMER,
    scheduledForMs: 1_700_000_000_000,
    misfirePolicy: SchedulerMisfirePolicy.SKIP,
    missedCount: 1,
    countCapped: false,
    signal,
  }
}

function runtime(root: string, opts: { outputMaxBytes?: number } = {}) {
  const taskManager = new TaskManager(root)
  const taskRuntime = new TaskRuntimeRegistry(taskManager, opts)
  return { taskManager, taskRuntime }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('SchedulerJobExecutor TaskRuntime authority', () => {
  it('uses exact run/task identities, one Scheduler ActiveTask, and bounded Task output', async () => {
    const root = tmp('emperor-scheduler-executor-agent-')
    const { taskManager, taskRuntime } = runtime(root)
    const activeTasks = new ActiveTaskRegistry()
    const submitted: SchedulerAgentTurnPayload[] = []
    const activeSnapshots: ReturnType<ActiveTaskRegistry['list']>[] = []
    const context = runContext()
    const executor = new SchedulerJobExecutor({
      activeTasks,
      taskManager,
      taskRuntime,
      submitAgentTurn: async (payload) => {
        expect(inSchedulerRun()).toBe(true)
        activeSnapshots.push(activeTasks.list())
        submitted.push(payload)
        return 'agent_turn completed'
      },
    })

    const result = await executor.run(
      makeJob('agent_turn', {
        deliver: false,
        meta: { [SCHEDULER_TARGET_SESSION_METADATA_KEY]: 'sess_sched' },
      }),
      context,
    )

    expect(result).toBe('agent_turn completed')
    expect(submitted[0]).toMatchObject({
      taskId: context.taskId,
      clientMessageId: `scheduler:${context.runId}`,
      useActiveTask: false,
      deliver: false,
      scheduler: {
        jobId: 'agent_turn-job',
        runId: context.runId,
        taskId: context.taskId,
        scheduledForMs: context.scheduledForMs,
        trigger: context.trigger,
      },
    })
    expect(submitted[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(activeSnapshots).toEqual([
      [
        expect.objectContaining({
          id: context.runId,
          kind: 'scheduler',
          job_id: 'agent_turn-job',
          session_id: 'sess_sched',
        }),
      ],
    ])
    expect(activeTasks.list()).toEqual([])
    expect(taskRuntime.list()).toEqual([])
    expect(taskManager.store.get(context.taskId)).toMatchObject({
      id: context.taskId,
      status: TaskStatus.COMPLETED,
      job_id: 'agent_turn-job',
      session_id: 'sess_sched',
      metadata: {
        runtime_managed: true,
        scheduler_run_id: context.runId,
        scheduler_trigger: context.trigger,
      },
    })
    expect(new TaskOutputStore(root, context.taskId).read().content).toBe(
      'agent_turn completed',
    )
    expect(inSchedulerRun()).toBe(false)
  })

  it('does not create a second Task or dispatch for a duplicate run identity', async () => {
    const root = tmp('emperor-scheduler-executor-duplicate-')
    const { taskManager, taskRuntime } = runtime(root)
    const activeTasks = new ActiveTaskRegistry()
    const work = deferred<string>()
    let dispatches = 0
    const executor = new SchedulerJobExecutor({
      activeTasks,
      taskManager,
      taskRuntime,
      submitAgentTurn: async () => {
        dispatches += 1
        return await work.promise
      },
    })
    const job = makeJob('agent_turn')
    const context = runContext()
    const first = executor.run(job, context)
    await new Promise<void>((resolve) => setImmediate(resolve))

    await expect(executor.run(job, context)).rejects.toThrow()
    work.resolve('done')
    await expect(first).resolves.toBe('done')
    expect(dispatches).toBe(1)
    expect(taskManager.store.list()).toHaveLength(1)
  })

  it('propagates Scheduler parent cancellation into Agent turn and Task terminal', async () => {
    const root = tmp('emperor-scheduler-executor-parent-cancel-')
    const { taskManager, taskRuntime } = runtime(root)
    const parent = new AbortController()
    const observed: { signal: AbortSignal | null } = { signal: null }
    const executor = new SchedulerJobExecutor({
      taskManager,
      taskRuntime,
      submitAgentTurn: async (payload) => {
        observed.signal = payload.signal
        return await new Promise<string>((_resolve, reject) => {
          payload.signal.addEventListener(
            'abort',
            () => reject(payload.signal.reason),
            { once: true },
          )
        })
      },
    })
    const context = runContext('b', parent.signal)
    const running = executor.run(makeJob('agent_turn'), context)
    await new Promise<void>((resolve) => setImmediate(resolve))

    parent.abort('scheduler shutdown')
    await expect(running).rejects.toMatchObject({ name: 'CancelledTaskError' })
    expect(observed.signal?.aborted).toBe(true)
    expect(taskManager.store.get(context.taskId)).toMatchObject({
      status: TaskStatus.CANCELLED,
      progress: { reason: 'scheduler shutdown' },
    })
  })

  it('lets TaskManager cancellation abort the live Scheduler execution and reject late completion', async () => {
    const root = tmp('emperor-scheduler-executor-task-cancel-')
    const { taskManager, taskRuntime } = runtime(root)
    const work = deferred<string>()
    const observed: { signal: AbortSignal | null } = { signal: null }
    const context = runContext('c')
    const executor = new SchedulerJobExecutor({
      taskManager,
      taskRuntime,
      submitAgentTurn: async (payload) => {
        observed.signal = payload.signal
        return await work.promise
      },
    })
    const running = executor.run(makeJob('agent_turn'), context)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const handle = taskRuntime.get(context.taskId)!

    taskManager.cancelTask(context.taskId, { reason: 'user cancelled task' })
    await expect(running).rejects.toMatchObject({ name: 'CancelledTaskError' })
    expect(observed.signal?.aborted).toBe(true)
    work.resolve('late success')
    await handle.settled
    expect(handle.lateResultRejected).toBe(true)
    expect(taskManager.store.get(context.taskId)?.status).toBe(
      TaskStatus.CANCELLED,
    )
  })

  it('records thrown execution failure as a failed runtime-managed Task', async () => {
    const root = tmp('emperor-scheduler-executor-failure-')
    const { taskManager, taskRuntime } = runtime(root)
    const context = runContext('d')
    const executor = new SchedulerJobExecutor({
      taskManager,
      taskRuntime,
      submitAgentTurn: async () => {
        throw new Error('provider failed')
      },
    })

    await expect(executor.run(makeJob('agent_turn'), context)).rejects.toThrow(
      /provider failed/,
    )
    expect(taskManager.store.get(context.taskId)).toMatchObject({
      status: TaskStatus.FAILED,
      progress: { error: expect.stringContaining('provider failed') },
    })
  })

  it('records an adapter CancelledTaskError as cancelled instead of failed', async () => {
    const root = tmp('emperor-scheduler-executor-cancelled-error-')
    const { taskManager, taskRuntime } = runtime(root)
    const context = runContext('5')
    const executor = new SchedulerJobExecutor({
      taskManager,
      taskRuntime,
      submitAgentTurn: async () => {
        throw new CancelledTaskError(context.runId)
      },
    })

    await expect(
      executor.run(makeJob('agent_turn'), context),
    ).rejects.toMatchObject({ name: 'CancelledTaskError' })
    expect(taskManager.store.get(context.taskId)?.status).toBe(
      TaskStatus.CANCELLED,
    )
  })

  it('bounds persisted output without truncating the returned runtime value', async () => {
    const root = tmp('emperor-scheduler-executor-output-')
    const { taskManager, taskRuntime } = runtime(root, { outputMaxBytes: 8 })
    const context = runContext('e')
    const executor = new SchedulerJobExecutor({
      taskManager,
      taskRuntime,
      submitAgentTurn: async () => 'abcdefghijkl',
    })

    await expect(executor.run(makeJob('agent_turn'), context)).resolves.toBe(
      'abcdefghijkl',
    )
    expect(
      new TaskOutputStore(root, context.taskId, { maxBytes: 8 }).read(),
    ).toMatchObject({
      content: 'abcdefgh',
      truncated: true,
      truncation: { droppedBytes: 4 },
    })
  })

  it('passes the runtime signal through Team wake and system handlers', async () => {
    const root = tmp('emperor-scheduler-executor-adapters-')
    const { taskManager, taskRuntime } = runtime(root)
    const signals: AbortSignal[] = []
    const executor = new SchedulerJobExecutor({
      taskManager,
      taskRuntime,
      submitAgentTurn: async () => 'unused',
      teamManagerForProject: () => ({
        sendMessage: async (payload) => {
          signals.push(payload.signal!)
          return 'team wake done'
        },
      }),
      systemHandlers: {
        'memory-maintenance': async (_job, context) => {
          signals.push(context.signal)
          return 'memory ok'
        },
      },
    })

    await expect(
      executor.run(
        makeJob('team_wake', {
          target: 'alice',
          project_id: 'project-1',
          message: 'wake up',
        }),
        runContext('f'),
      ),
    ).resolves.toBe('team wake done')
    await expect(
      executor.run(
        makeJob('system_event', {
          meta: { system_event: 'memory-maintenance' },
        }),
        runContext('1'),
      ),
    ).resolves.toBe('memory ok')
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
  })

  it('keeps Scheduler run identity when watchlist promotes to an Agent turn', async () => {
    const root = tmp('emperor-scheduler-executor-watchlist-')
    const { taskManager, taskRuntime } = runtime(root)
    const submitted: SchedulerAgentTurnPayload[] = []
    const context = runContext('2')
    const executor = new SchedulerJobExecutor({
      taskManager,
      taskRuntime,
      submitAgentTurn: async (payload) => {
        submitted.push(payload)
        return 'watchlist turn done'
      },
      watchlistService: {
        check: async () =>
          new WatchlistDecision({
            action: 'run',
            reason: 'timely',
            message: 'Check issue queue',
          }),
      },
    })

    await expect(
      executor.run(
        makeJob('system_event', { meta: { system_event: 'watchlist-check' } }),
        context,
      ),
    ).resolves.toBe('watchlist turn done')
    expect(submitted[0]).toMatchObject({
      taskId: context.taskId,
      scheduler: { runId: context.runId, taskId: context.taskId },
    })
    expect(submitted[0]!.content).toContain('[WATCHLIST_TRIGGER]')
  })

  it('rejects unsafe control/model conditions before adapter effects', async () => {
    const firstRoot = tmp('emperor-scheduler-executor-control-')
    const first = runtime(firstRoot)
    const blockedTurn = new SchedulerJobExecutor({
      ...first,
      controlPending: () => true,
      submitAgentTurn: async () => 'never',
    })
    await expect(
      blockedTurn.run(makeJob('agent_turn'), runContext('3')),
    ).rejects.toThrow(/Ask \/ Plan/)

    const secondRoot = tmp('emperor-scheduler-executor-model-')
    const second = runtime(secondRoot)
    let sends = 0
    const blockedTeam = new SchedulerJobExecutor({
      ...second,
      submitAgentTurn: async () => 'unused',
      toolCallingAvailable: () => false,
      teamManagerForProject: () => ({
        sendMessage: async () => {
          sends += 1
          return 'should not run'
        },
      }),
    })
    await expect(
      blockedTeam.run(
        makeJob('team_wake', {
          target: 'alice',
          project_id: 'project-1',
          message: 'wake up',
        }),
        runContext('4'),
      ),
    ).rejects.toMatchObject({ code: 'model_configuration_required' })
    expect(sends).toBe(0)
  })
})
