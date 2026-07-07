import { ActiveTaskRegistry } from '../runtime/active'
import { TaskManager } from '../tasks/manager'
import { TaskKind } from '../tasks/models'
import type { WatchlistDecision } from '../watchlist/models'
import { SchedulerJob, SchedulerPayload, schedulerPayloadSessionId } from './models'
import { resetSchedulerRun, setSchedulerRun } from './tool'

export interface SchedulerAgentTurnPayload {
  job: SchedulerJob
  content: string
  displayContent: string
  deliver: boolean
  clientMessageId: string
  source: 'scheduler'
  scheduler: { jobId: string; jobName: string }
  taskId: string | null
  sessionId?: string | null
}

export interface TeamWakeManager {
  sendMessage(payload: { to: string; content: string; wake: boolean; type: string }): string | Promise<string>
}

export interface WatchlistServiceLike {
  check(): Promise<WatchlistDecision>
}

export type SchedulerSystemHandler = (job: SchedulerJob) => string | Promise<string>

export class SchedulerJobExecutor {
  private readonly activeTasks: ActiveTaskRegistry | null
  private readonly taskManager: TaskManager | null
  private readonly submitAgentTurn: (payload: SchedulerAgentTurnPayload) => Promise<string>
  private readonly teamManagerForProject: ((projectId: string) => TeamWakeManager) | null
  private readonly controlPending: () => boolean
  private readonly systemHandlers: Record<string, SchedulerSystemHandler>
  private readonly watchlistService: WatchlistServiceLike | null

  constructor(opts: {
    activeTasks?: ActiveTaskRegistry | null
    taskManager?: TaskManager | null
    submitAgentTurn: (payload: SchedulerAgentTurnPayload) => Promise<string>
    teamManagerForProject?: ((projectId: string) => TeamWakeManager) | null
    controlPending?: (() => boolean) | null
    systemHandlers?: Record<string, SchedulerSystemHandler>
    watchlistService?: WatchlistServiceLike | null
  }) {
    this.activeTasks = opts.activeTasks ?? null
    this.taskManager = opts.taskManager ?? null
    this.submitAgentTurn = opts.submitAgentTurn
    this.teamManagerForProject = opts.teamManagerForProject ?? null
    this.controlPending = opts.controlPending ?? (() => false)
    this.systemHandlers = opts.systemHandlers ?? {}
    this.watchlistService = opts.watchlistService ?? null
  }

  async run(job: SchedulerJob): Promise<string> {
    const token = setSchedulerRun(true)
    const taskRecord = this.taskManager?.startTask({
      kind: TaskKind.SCHEDULER_RUN,
      title: `Scheduler job: ${job.name}`,
      source: 'scheduler',
      jobId: job.id,
      sessionId: schedulerPayloadSessionId(job.payload),
      metadata: { job_name: job.name, payload_kind: job.payload.kind, deliver: Boolean(job.payload.deliver) },
    }) ?? null
    try {
      const taskId = `scheduler:${job.id}`
      const sessionId = schedulerPayloadSessionId(job.payload) || null
      const awaitable = Promise.resolve().then(() => this.dispatch(job, { taskId: taskRecord?.id ?? null }))
      const result = this.activeTasks
        ? await this.activeTasks.run({ taskId, kind: 'scheduler', label: `Scheduler job: ${job.name}`, awaitable, jobId: job.id, sessionId })
        : await awaitable
      if (taskRecord) this.taskManager?.completeTask(taskRecord.id, { summary: String(result || '') })
      return result
    } catch (error) {
      if (taskRecord) {
        if (error instanceof Error && error.name === 'CancelledTaskError') this.taskManager?.cancelTask(taskRecord.id)
        else this.taskManager?.failTask(taskRecord.id, { error: error instanceof Error ? error.message : String(error) })
      }
      throw error
    } finally {
      resetSchedulerRun(token)
    }
  }

  private async dispatch(job: SchedulerJob, opts: { taskId: string | null }): Promise<string> {
    if (job.payload.kind === 'agent_turn') return this.runAgentTurn(job, opts)
    if (job.payload.kind === 'team_wake') return this.runTeamWake(job)
    if (job.payload.kind === 'system_event') return this.runSystemEvent(job, opts)
    throw new Error(`unsupported scheduler payload kind: ${job.payload.kind}`)
  }

  private async runAgentTurn(job: SchedulerJob, opts: { taskId: string | null }): Promise<string> {
    const message = job.payload.message.trim()
    if (!message) throw new Error('agent_turn scheduler job requires payload.message')
    if (this.controlPending()) throw new Error('cannot run scheduler agent_turn while Ask / Plan is pending')
    return this.submitAgentTurn({
      job,
      content: SchedulerJobExecutor.agentTurnContent(job),
      displayContent: `定时任务触发 · ${job.name}\n\n${message}`,
      deliver: Boolean(job.payload.deliver),
      clientMessageId: `scheduler:${job.id}`,
      source: 'scheduler',
      scheduler: { jobId: job.id, jobName: job.name },
      taskId: opts.taskId,
      sessionId: schedulerPayloadSessionId(job.payload) || null,
    })
  }

  private async runTeamWake(job: SchedulerJob): Promise<string> {
    const target = String(job.payload.target || '').trim()
    const message = job.payload.message.trim()
    const projectId = String(job.payload.project_id || '').trim()
    if (!target) throw new Error('team_wake scheduler job requires payload.target')
    if (!message) throw new Error('team_wake scheduler job requires payload.message')
    if (!projectId) throw new Error('team_wake scheduler job requires payload.project_id')
    if (!this.teamManagerForProject) throw new Error('team manager lookup is unavailable')
    const manager = this.teamManagerForProject(projectId)
    return String(await manager.sendMessage({ to: target, content: message, wake: true, type: 'task' }))
  }

  private async runSystemEvent(job: SchedulerJob, opts: { taskId: string | null }): Promise<string> {
    const eventName = String(job.payload.meta.system_event || job.payload.message || job.id)
    if (eventName === 'watchlist-check') {
      if (!this.watchlistService) return 'watchlist-check skipped: watchlist service unavailable'
      const decision = await this.watchlistService.check()
      if (decision.action !== 'run') return `watchlist-check skipped: ${decision.reason}`
      const proactive = cloneJobWithPayload(job, new SchedulerPayload({
        kind: 'agent_turn',
        message: `[WATCHLIST_TRIGGER]\nreason: ${decision.reason}\n\n${decision.message}`,
        deliver: job.payload.deliver,
        meta: job.payload.meta,
      }))
      return this.runAgentTurn(proactive, opts)
    }
    const handler = this.systemHandlers[eventName]
    if (handler) return String(await handler(job))
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

function cloneJobWithPayload(job: SchedulerJob, payload: SchedulerPayload): SchedulerJob {
  return SchedulerJob.fromDict({ ...job.toDict(), payload: payload.toDict() })
}
