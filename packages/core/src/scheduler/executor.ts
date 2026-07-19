import { ModelConfigurationError } from '../errors'
import { ActiveTaskRegistry, CancelledTaskError } from '../runtime/active'
import { TaskManager } from '../tasks/manager'
import { TaskKind, TaskStatus } from '../tasks/models'
import {
  TaskRuntimeHandle,
  TaskRuntimeRegistry,
  type TaskRuntimeExecution,
} from '../tasks/runtime'
import type { WatchlistDecision } from '../watchlist/models'
import {
  SchedulerJob,
  SchedulerPayload,
  schedulerPayloadSessionId,
} from './models'
import type { SchedulerRunContext } from './service'
import { runInSchedulerRun } from './tool'

export interface SchedulerAgentTurnPayload {
  job: SchedulerJob
  content: string
  displayContent: string
  deliver: boolean
  clientMessageId: string
  source: 'scheduler'
  scheduler: {
    jobId: string
    jobName: string
    runId: string
    taskId: string
    scheduledForMs: number
    trigger: string
  }
  taskId: string
  signal: AbortSignal
  useActiveTask: false
  sessionId?: string | null
}

export interface TeamWakeManager {
  sendMessage(payload: {
    to: string
    content: string
    wake: boolean
    type: string
    signal?: AbortSignal
  }): string | Promise<string>
}

export interface WatchlistServiceLike {
  check(signal?: AbortSignal): Promise<WatchlistDecision>
}

export type SchedulerSystemHandler = (
  job: SchedulerJob,
  context: SchedulerRunContext,
) => string | Promise<string>

export class SchedulerJobExecutor {
  private readonly activeTasks: ActiveTaskRegistry | null
  private readonly taskManager: TaskManager
  private readonly taskRuntime: TaskRuntimeRegistry
  private readonly submitAgentTurn: (
    payload: SchedulerAgentTurnPayload,
  ) => Promise<string>
  private readonly teamManagerForProject:
    ((projectId: string) => TeamWakeManager) | null
  private readonly controlPending: () => boolean
  private readonly toolCallingAvailable: () => boolean
  private readonly systemHandlers: Record<string, SchedulerSystemHandler>
  private readonly watchlistService: WatchlistServiceLike | null

  constructor(opts: {
    activeTasks?: ActiveTaskRegistry | null
    taskManager: TaskManager
    taskRuntime: TaskRuntimeRegistry
    submitAgentTurn: (payload: SchedulerAgentTurnPayload) => Promise<string>
    teamManagerForProject?: ((projectId: string) => TeamWakeManager) | null
    controlPending?: (() => boolean) | null
    toolCallingAvailable?: (() => boolean) | null
    systemHandlers?: Record<string, SchedulerSystemHandler>
    watchlistService?: WatchlistServiceLike | null
  }) {
    this.activeTasks = opts.activeTasks ?? null
    this.taskManager = opts.taskManager
    this.taskRuntime = opts.taskRuntime
    this.submitAgentTurn = opts.submitAgentTurn
    this.teamManagerForProject = opts.teamManagerForProject ?? null
    this.controlPending = opts.controlPending ?? (() => false)
    this.toolCallingAvailable = opts.toolCallingAvailable ?? (() => true)
    this.systemHandlers = opts.systemHandlers ?? {}
    this.watchlistService = opts.watchlistService ?? null
  }

  async run(job: SchedulerJob, context: SchedulerRunContext): Promise<string> {
    return await runInSchedulerRun(
      async () => await this.runTracked(job, context),
    )
  }

  private async runTracked(
    job: SchedulerJob,
    context: SchedulerRunContext,
  ): Promise<string> {
    const sessionId = schedulerPayloadSessionId(job.payload) || null
    const task = this.taskManager.startTask({
      taskId: context.taskId,
      kind: TaskKind.SCHEDULER_RUN,
      title: `Scheduler job: ${job.name}`,
      source: 'scheduler',
      jobId: job.id,
      sessionId,
      metadata: {
        job_name: job.name,
        payload_kind: job.payload.kind,
        deliver: Boolean(job.payload.deliver),
        scheduler_run_id: context.runId,
        scheduler_trigger: context.trigger,
        scheduled_for_ms: context.scheduledForMs,
        misfire_policy: context.misfirePolicy,
        missed_count: context.missedCount,
        count_capped: context.countCapped,
      },
    })
    const handleRef: { value: TaskRuntimeHandle<string> | null } = {
      value: null,
    }
    let executionError: unknown = null
    const handle = this.taskRuntime.launch({
      task,
      parentSignal: context.signal,
      execute: async (runtime) => {
        try {
          return await this.runWithActiveProjection(
            job,
            context,
            runtime,
            () => {
              if (!handleRef.value)
                throw new Error('scheduler TaskRuntime handle is unavailable')
              return handleRef.value
            },
          )
        } catch (error) {
          executionError = error
          throw error
        }
      },
      fail: (error, expectedRevision) =>
        error instanceof Error && error.name === 'CancelledTaskError'
          ? this.taskManager.cancelTask(task.id, {
              reason: error.message,
              expectedRevision,
            })
          : this.taskManager.failTask(task.id, {
              error: error instanceof Error ? error.message : String(error),
              expectedRevision,
            }),
    })
    handleRef.value = handle
    const terminal = await handle.wait()
    if (!terminal) throw new Error(`scheduler Task did not settle: ${task.id}`)
    if (terminal.status === TaskStatus.COMPLETED)
      return String(terminal.value ?? terminal.record.progress.summary ?? '')
    if (terminal.status === TaskStatus.CANCELLED)
      throw new CancelledTaskError(context.runId)
    if (terminal.status === TaskStatus.INTERRUPTED) {
      const error = new Error(
        terminal.error || `scheduler Task interrupted: ${task.id}`,
      )
      error.name = 'InterruptedTaskError'
      throw error
    }
    if (executionError instanceof Error) throw executionError
    throw new Error(
      terminal.error || `scheduler Task failed with status ${terminal.status}`,
    )
  }

  private async runWithActiveProjection(
    job: SchedulerJob,
    context: SchedulerRunContext,
    runtime: TaskRuntimeExecution,
    handle: () => TaskRuntimeHandle<string>,
  ): Promise<string> {
    const execute = async () =>
      await this.dispatch(job, { ...context, signal: runtime.signal })
    if (!this.activeTasks) return await execute()
    return await this.activeTasks.run({
      taskId: context.runId,
      kind: 'scheduler',
      label: `Scheduler job: ${job.name}`,
      execute,
      jobId: job.id,
      sessionId: schedulerPayloadSessionId(job.payload) || null,
      abort: () => {
        void handle().cancel('active Scheduler run cancelled')
      },
    })
  }

  private async dispatch(
    job: SchedulerJob,
    context: SchedulerRunContext,
  ): Promise<string> {
    if (job.payload.kind === 'agent_turn')
      return this.runAgentTurn(job, context)
    if (job.payload.kind === 'team_wake') return this.runTeamWake(job, context)
    if (job.payload.kind === 'system_event')
      return this.runSystemEvent(job, context)
    throw new Error(`unsupported scheduler payload kind: ${job.payload.kind}`)
  }

  private async runAgentTurn(
    job: SchedulerJob,
    context: SchedulerRunContext,
  ): Promise<string> {
    const message = job.payload.message.trim()
    if (!message)
      throw new Error('agent_turn scheduler job requires payload.message')
    if (this.controlPending())
      throw new Error(
        'cannot run scheduler agent_turn while Ask / Plan is pending',
      )
    return this.submitAgentTurn({
      job,
      content: SchedulerJobExecutor.agentTurnContent(job),
      displayContent: `定时任务触发 · ${job.name}\n\n${message}`,
      deliver: Boolean(job.payload.deliver),
      clientMessageId: `scheduler:${context.runId}`,
      source: 'scheduler',
      scheduler: {
        jobId: job.id,
        jobName: job.name,
        runId: context.runId,
        taskId: context.taskId,
        scheduledForMs: context.scheduledForMs,
        trigger: context.trigger,
      },
      taskId: context.taskId,
      signal: context.signal,
      useActiveTask: false,
      sessionId: schedulerPayloadSessionId(job.payload) || null,
    })
  }

  private async runTeamWake(
    job: SchedulerJob,
    context: SchedulerRunContext,
  ): Promise<string> {
    const target = String(job.payload.target || '').trim()
    const message = job.payload.message.trim()
    const projectId = String(job.payload.project_id || '').trim()
    if (!target)
      throw new Error('team_wake scheduler job requires payload.target')
    if (!message)
      throw new Error('team_wake scheduler job requires payload.message')
    if (!projectId)
      throw new Error('team_wake scheduler job requires payload.project_id')
    if (!this.toolCallingAvailable()) {
      throw new ModelConfigurationError(
        '当前激活模型不支持工具调用，无法执行自动 Team 唤醒。请切换支持工具调用的模型。',
      )
    }
    if (!this.teamManagerForProject)
      throw new Error('team manager lookup is unavailable')
    const manager = this.teamManagerForProject(projectId)
    return String(
      await manager.sendMessage({
        to: target,
        content: message,
        wake: true,
        type: 'task',
        signal: context.signal,
      }),
    )
  }

  private async runSystemEvent(
    job: SchedulerJob,
    context: SchedulerRunContext,
  ): Promise<string> {
    const eventName = String(
      job.payload.meta.system_event || job.payload.message || job.id,
    )
    if (eventName === 'watchlist-check') {
      if (!this.watchlistService)
        return 'watchlist-check skipped: watchlist service unavailable'
      const decision = await this.watchlistService.check(context.signal)
      if (decision.action !== 'run')
        return `watchlist-check skipped: ${decision.reason}`
      const proactive = cloneJobWithPayload(
        job,
        new SchedulerPayload({
          kind: 'agent_turn',
          message: `[WATCHLIST_TRIGGER]\nreason: ${decision.reason}\n\n${decision.message}`,
          deliver: job.payload.deliver,
          meta: job.payload.meta,
        }),
      )
      return this.runAgentTurn(proactive, context)
    }
    const handler = this.systemHandlers[eventName]
    if (handler) return String(await handler(job, context))
    return `system_event acknowledged: ${eventName}`
  }

  static agentTurnContent(job: SchedulerJob): string {
    return [
      '[SCHEDULER_TRIGGER]',
      `job_id: ${job.id}`,
      `job_name: ${job.name}`,
      `payload_kind: ${job.payload.kind}`,
      '',
      '用户预先登记的本地长期任务现在触发。请把它当作一次主动 turn 处理；完成后给出简洁结果。',
      '',
      '## Scheduled Task',
      job.payload.message.trim(),
    ].join('\n')
  }
}

function cloneJobWithPayload(
  job: SchedulerJob,
  payload: SchedulerPayload,
): SchedulerJob {
  return SchedulerJob.fromDict({ ...job.toDict(), payload: payload.toDict() })
}
