import { AsyncLocalStorage } from 'node:async_hooks'
import { Tool } from '../tools/base'
import { B, I, S, toolParamsSchema, type ParamSchema } from '../tools/schema'
import { SchedulerPayload, SchedulerSchedule } from './models'
import { SchedulerService } from './service'

const schedulerRun = new AsyncLocalStorage<boolean>()

export function inSchedulerRun(): boolean {
  return schedulerRun.getStore() === true
}
export function runInSchedulerRun<T>(execute: () => T): T {
  return schedulerRun.run(true, execute)
}
export function setSchedulerRun(value: boolean): boolean {
  schedulerRun.enterWith(Boolean(value))
  return Boolean(value)
}
export function resetSchedulerRun(_token?: unknown): void {
  schedulerRun.enterWith(false)
}

export class SchedulerTool extends Tool {
  readonly service: SchedulerService
  constructor(service: SchedulerService) {
    super()
    this.service = service
  }
  override name = 'scheduler'
  override description =
    '管理本地持久定时任务：查看、创建、更新、暂停、恢复、删除或手动运行。只读检查使用 list；只有用户明确要求长期、未来或周期性自动执行时，才使用 add/update/remove/run。不要把一次性普通任务伪装成定时任务；调度器失败时报告调度器错误，不要改用系统 cron 或 crontab。'
  override requiresRuntimeContext = true
  override evidencePolicy = 'forbidden' as const
  override parameters = toolParamsSchema(
    {
      action: {
        ...S('要执行的调度动作。'),
        enum: ['add', 'list', 'update', 'remove', 'pause', 'resume', 'run'],
      } as ParamSchema,
      job_id: S('已有定时任务 id，用于 update/remove/pause/resume/run。'),
      name: S('创建或更新时使用的任务名称。'),
      payload_kind: {
        ...S('任务触发后要执行的载荷类型；system_event 仅供系统内部使用。'),
        enum: ['agent_turn', 'team_wake'],
      } as ParamSchema,
      message: S('agent_turn 的提示词，或 team_wake 发送给队友的消息。'),
      target: S('team_wake 任务的目标队友名称。'),
      project_id: S('team_wake 任务关联的项目 id。'),
      deliver: B('执行结果是否显示到本地运行界面。'),
      at: S('一次性任务的 ISO 时间，例如 2026-05-20T09:30:00+08:00。'),
      every_seconds: {
        ...I('循环任务的间隔秒数。'),
        minimum: 1,
      } as ParamSchema,
      cron_expr: S('循环任务使用的 cron 表达式。'),
      tz: S('cron 任务使用的 IANA 时区，例如 Asia/Shanghai。'),
      delete_after_run: B('一次性任务运行后是否自动删除。'),
    },
    ['action'],
  )

  override isReadOnly(args: Record<string, unknown>): boolean {
    return String(args.action || '').toLowerCase() === 'list'
  }

  override async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action || '')
      .trim()
      .toLowerCase()
    if (action === 'list') return this.formatJobs()
    if (action === 'add') {
      if (inSchedulerRun())
        return 'Error: scheduler jobs cannot create new scheduler jobs while running.'
      return this.addJob(args)
    }
    if (action === 'update') {
      if (!args.job_id) return 'Error: action=update requires job_id.'
      return this.updateJob(String(args.job_id), args)
    }
    if (['remove', 'pause', 'resume', 'run'].includes(action)) {
      if (!args.job_id) return `Error: action=${action} requires job_id.`
      if (action === 'remove') return this.removeJob(String(args.job_id))
      if (action === 'pause') return this.enableJob(String(args.job_id), false)
      if (action === 'resume') return this.enableJob(String(args.job_id), true)
      return this.runJob(String(args.job_id))
    }
    return `Error: unsupported scheduler action '${action}'.`
  }

  private addJob(args: Record<string, unknown>): string {
    try {
      const schedule = scheduleFromFields(args)
      const payload = payloadFromFields(args)
      const job = this.service.addJob({
        name: String(args.name || '') || defaultName(payload),
        schedule,
        payload,
        deleteAfterRun: Boolean(args.delete_after_run ?? false),
      })
      return `Scheduler job created: ${job.name} (${job.id}). Next run: ${formatMs(job.state.next_run_at_ms)}.`
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : error}`
    }
  }

  private updateJob(jobId: string, args: Record<string, unknown>): string {
    try {
      const schedule =
        args.at || args.every_seconds !== undefined || args.cron_expr
          ? scheduleFromFields(args)
          : null
      let payload: SchedulerPayload | null = null
      if (
        args.payload_kind ||
        args.message !== undefined ||
        args.target !== undefined ||
        args.project_id !== undefined
      ) {
        const current = this.service.getJob(jobId)
        if (!current) return `Error: scheduler job not found: ${jobId}`
        payload = payloadFromFields({
          payload_kind: args.payload_kind || current.payload.kind,
          message: args.message ?? current.payload.message,
          target: args.target ?? current.payload.target,
          project_id: args.project_id ?? current.payload.project_id,
          deliver: args.deliver ?? current.payload.deliver,
        })
      }
      const result = this.service.updateJob(jobId, {
        name: args.name as string | null | undefined,
        schedule,
        payload,
        deleteAfterRun: args.delete_after_run as boolean | null | undefined,
      })
      if (result === 'not_found')
        return `Error: scheduler job not found: ${jobId}`
      if (result === 'protected')
        return `Error: scheduler job is protected and cannot be updated: ${jobId}`
      return `Scheduler job updated: ${result.name} (${result.id}). Next run: ${formatMs(result.state.next_run_at_ms)}.`
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : error}`
    }
  }

  private removeJob(jobId: string): string {
    const result = this.service.removeJob(jobId)
    if (result === 'not_found')
      return `Error: scheduler job not found: ${jobId}`
    if (result === 'protected')
      return `Error: scheduler job is protected and cannot be removed: ${jobId}`
    if (result === 'active')
      return `Error: scheduler job is active and cannot be removed: ${jobId}`
    return `Scheduler job removed: ${result.name} (${result.id}).`
  }

  private enableJob(jobId: string, enabled: boolean): string {
    const result = this.service.enableJob(jobId, enabled)
    if (result === 'not_found')
      return `Error: scheduler job not found: ${jobId}`
    return `Scheduler job ${enabled ? 'resumed' : 'paused'}: ${result.name} (${result.id}). Next run: ${formatMs(result.state.next_run_at_ms)}.`
  }

  private async runJob(jobId: string): Promise<string> {
    const ok = await this.service.runJob(jobId, { force: true })
    if (!ok) return `Error: scheduler job not found or disabled: ${jobId}`
    const job = this.service.getJob(jobId)
    const label = job ? `${job.name} (${job.id})` : jobId
    return `Scheduler job run finished: ${label}.`
  }

  private formatJobs(): string {
    const jobs = this.service.listJobs({ includeDisabled: true })
    if (!jobs.length) return 'No scheduler jobs configured.'
    const lines = ['Scheduler jobs:']
    for (const job of jobs) {
      let status = job.enabled ? 'enabled' : 'paused'
      if (job.protected) status += ', protected'
      lines.push(
        `- ${job.id} · ${job.name} · ${status} · ${job.schedule.kind} · next=${formatMs(job.state.next_run_at_ms)} · last=${job.state.last_status || '-'}`,
      )
      lines.push(
        `  payload: ${job.payload.kind} message=${trim(job.payload.message)}`,
      )
    }
    return lines.join('\n')
  }
}

function scheduleFromFields(args: Record<string, unknown>): SchedulerSchedule {
  const filled = [
    Boolean(args.at),
    args.every_seconds !== undefined && args.every_seconds !== null,
    Boolean(args.cron_expr),
  ].filter(Boolean).length
  if (filled !== 1)
    throw new Error(
      'provide exactly one schedule: at, every_seconds, or cron_expr.',
    )
  if (args.at)
    return new SchedulerSchedule({
      kind: 'at',
      at_ms: parseDatetimeMs(String(args.at)),
    })
  if (args.every_seconds !== undefined && args.every_seconds !== null) {
    const seconds = Number(args.every_seconds)
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new Error('every_seconds must be greater than 0.')
    return new SchedulerSchedule({
      kind: 'every',
      every_ms: Math.trunc(seconds) * 1000,
    })
  }
  return new SchedulerSchedule({
    kind: 'cron',
    expr: String(args.cron_expr || '').trim(),
    tz: String(args.tz || '') || null,
  })
}

function payloadFromFields(args: Record<string, unknown>): SchedulerPayload {
  const kind = String(args.payload_kind || 'agent_turn')
  if (kind === 'system_event')
    throw new Error(
      'system_event jobs are internal and cannot be created from the scheduler tool.',
    )
  if (!['agent_turn', 'team_wake'].includes(kind))
    throw new Error('payload_kind must be agent_turn or team_wake.')
  const message = String(args.message || '').trim()
  if (!message) throw new Error('message is required.')
  if (kind === 'team_wake' && !String(args.target || '').trim())
    throw new Error('target teammate is required for team_wake jobs.')
  if (kind === 'team_wake' && !String(args.project_id || '').trim())
    throw new Error('project_id is required for team_wake jobs.')
  return new SchedulerPayload({
    kind: kind as 'agent_turn' | 'team_wake',
    message,
    target: String(args.target || '').trim() || null,
    project_id: String(args.project_id || '').trim() || null,
    deliver: args.deliver === undefined ? true : Boolean(args.deliver),
  })
}

function parseDatetimeMs(value: string): number {
  const raw = value.trim().replace(/Z$/, '+00:00')
  if (!raw) throw new Error('at requires an ISO datetime.')
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms))
    throw new Error(
      'at must be an ISO datetime, for example 2026-05-20T09:30:00+08:00.',
    )
  return ms
}

function defaultName(payload: SchedulerPayload): string {
  return `${payload.kind === 'team_wake' ? 'Team wake' : 'Agent turn'}: ${trim(payload.message, 48)}`
}
function trim(text: string, limit = 80): string {
  const s = String(text || '')
    .split(/\s+/)
    .join(' ')
  return s.length <= limit ? s : `${s.slice(0, limit - 1)}…`
}
function formatMs(value: number | null): string {
  return value ? new Date(value).toISOString() : '-'
}
