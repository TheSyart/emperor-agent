/**
 * `scheduler`: model-facing management of Emperor's durable local jobs
 * (list / add / update / remove / pause / resume / run). Jobs created here
 * are bound to the calling session, so their `agent_turn` runs land back in
 * it. Runs requested by the model are triggered, not awaited: a run submits
 * a turn to the same session, which would otherwise wait on this very tool.
 */

import { z } from 'zod'
import {
  SchedulerPayload,
  SchedulerSchedule,
  schedulerPayloadSessionId,
  withSchedulerPayloadSession,
  type SchedulerJob,
} from '../../../scheduler/models'
import type { SchedulerService } from '../../../scheduler/service'
import type { Agent } from '../../agent/agent'
import { defineTool, ToolError, type ToolDefinition } from '../definition'

export interface SchedulerToolDeps {
  service: SchedulerService
  /** Session index id that owns the calling agent (root of its owner chain). */
  sessionIdOf(agent: Agent | undefined): string | null
  /** True while the calling agent's current turn was started by a scheduler run. */
  inSchedulerRun(agent: Agent | undefined): boolean
}

const DESCRIPTION =
  '管理本地持久定时任务：查看、创建、更新、暂停、恢复、删除或手动运行。只读检查使用 list；' +
  '只有用户明确要求长期、未来或周期性自动执行时，才使用 add/update/remove/run。' +
  '不要把一次性普通任务伪装成定时任务；调度器失败时报告调度器错误，不要改用系统 cron 或 crontab。' +
  '新任务绑定到当前会话，触发时在本会话内作为一次新的 turn 执行。'

const schedulerInput = z.object({
  action: z
    .enum(['add', 'list', 'update', 'remove', 'pause', 'resume', 'run'])
    .describe('要执行的调度动作。'),
  job_id: z
    .string()
    .optional()
    .describe('已有定时任务 id，用于 update/remove/pause/resume/run。'),
  name: z.string().optional().describe('创建或更新时使用的任务名称。'),
  message: z.string().optional().describe('任务触发时交给 Agent 的提示词。'),
  deliver: z
    .boolean()
    .optional()
    .describe('执行结果是否显示到本地运行界面（默认显示）。'),
  at: z
    .string()
    .optional()
    .describe('一次性任务的 ISO 时间，例如 2026-05-20T09:30:00+08:00。'),
  every_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('循环任务的间隔秒数。'),
  cron_expr: z.string().optional().describe('循环任务使用的 cron 表达式。'),
  tz: z
    .string()
    .optional()
    .describe('cron 任务使用的 IANA 时区，例如 Asia/Shanghai。'),
  delete_after_run: z
    .boolean()
    .optional()
    .describe('一次性任务运行后是否自动删除。'),
})

type SchedulerArgs = z.output<typeof schedulerInput>

export function createSchedulerTool(
  deps: SchedulerToolDeps,
): ToolDefinition<SchedulerArgs> {
  const { service } = deps
  return defineTool({
    name: 'scheduler',
    description: DESCRIPTION,
    input: schedulerInput,
    isConcurrencySafe: (args) => args.action === 'list',
    async execute(args, context) {
      const jobId = args.job_id?.trim() ?? ''
      const needsJob = (): string => {
        if (!jobId)
          throw new ToolError(
            `action=${args.action} requires job_id`,
            'INVALID_ARGUMENT',
          )
        return jobId
      }
      switch (args.action) {
        case 'list':
          return formatJobs(service.listJobs({ includeDisabled: true }))
        case 'add': {
          if (deps.inSchedulerRun(context.agent))
            throw new ToolError(
              'scheduler jobs cannot create new scheduler jobs while running',
              'SCHEDULER_NESTED',
            )
          const payload = withSchedulerPayloadSession(
            payloadFromFields(args),
            deps.sessionIdOf(context.agent),
          )
          const job = service.addJob({
            name:
              args.name?.trim() || `Agent turn: ${trim(payload.message, 48)}`,
            schedule: scheduleFromFields(args),
            payload,
            deleteAfterRun: args.delete_after_run ?? false,
          })
          return `Scheduler job created: ${job.name} (${job.id}). Next run: ${formatMs(job.state.next_run_at_ms)}.`
        }
        case 'update': {
          const id = needsJob()
          const current = service.getJob(id)
          if (!current)
            throw new ToolError(`scheduler job not found: ${id}`, 'NOT_FOUND')
          const schedule =
            args.at !== undefined ||
            args.every_seconds !== undefined ||
            args.cron_expr !== undefined
              ? scheduleFromFields(args)
              : null
          const payload =
            args.message !== undefined || args.deliver !== undefined
              ? withSchedulerPayloadSession(
                  payloadFromFields({
                    ...args,
                    message: args.message ?? current.payload.message,
                    deliver: args.deliver ?? current.payload.deliver,
                  }),
                  schedulerPayloadSessionId(current.payload) ||
                    deps.sessionIdOf(context.agent),
                )
              : null
          const result = service.updateJob(id, {
            name: args.name,
            schedule,
            payload,
            deleteAfterRun: args.delete_after_run,
          })
          if (result === 'not_found')
            throw new ToolError(`scheduler job not found: ${id}`, 'NOT_FOUND')
          if (result === 'protected')
            throw new ToolError(
              `scheduler job is protected and cannot be updated: ${id}`,
              'PROTECTED',
            )
          return `Scheduler job updated: ${result.name} (${result.id}). Next run: ${formatMs(result.state.next_run_at_ms)}.`
        }
        case 'remove': {
          const id = needsJob()
          const result = service.removeJob(id)
          if (result === 'not_found')
            throw new ToolError(`scheduler job not found: ${id}`, 'NOT_FOUND')
          if (result === 'protected')
            throw new ToolError(
              `scheduler job is protected and cannot be removed: ${id}`,
              'PROTECTED',
            )
          if (result === 'active')
            throw new ToolError(
              `scheduler job is active and cannot be removed: ${id}`,
              'ACTIVE',
            )
          return `Scheduler job removed: ${result.name} (${result.id}).`
        }
        case 'pause':
        case 'resume': {
          const id = needsJob()
          const enabled = args.action === 'resume'
          const result = service.enableJob(id, enabled)
          if (result === 'not_found')
            throw new ToolError(`scheduler job not found: ${id}`, 'NOT_FOUND')
          return `Scheduler job ${enabled ? 'resumed' : 'paused'}: ${result.name} (${result.id}). Next run: ${formatMs(result.state.next_run_at_ms)}.`
        }
        case 'run': {
          const id = needsJob()
          const job = service.getJob(id)
          if (!job)
            throw new ToolError(`scheduler job not found: ${id}`, 'NOT_FOUND')
          if (deps.inSchedulerRun(context.agent))
            throw new ToolError(
              'scheduler jobs cannot trigger scheduler runs while running',
              'SCHEDULER_NESTED',
            )
          void service.runJob(id, { force: true }).catch(() => undefined)
          return `Scheduler job run triggered: ${job.name} (${job.id}). Its turn runs after the current one; results appear in the run history.`
        }
      }
    },
  })
}

function scheduleFromFields(args: SchedulerArgs): SchedulerSchedule {
  const filled = [
    args.at !== undefined,
    args.every_seconds !== undefined,
    args.cron_expr !== undefined,
  ].filter(Boolean).length
  if (filled !== 1)
    throw new ToolError(
      'provide exactly one schedule: at, every_seconds, or cron_expr',
      'INVALID_ARGUMENT',
    )
  if (args.at !== undefined)
    return new SchedulerSchedule({
      kind: 'at',
      at_ms: parseDatetimeMs(args.at),
    })
  if (args.every_seconds !== undefined)
    return new SchedulerSchedule({
      kind: 'every',
      every_ms: args.every_seconds * 1000,
    })
  return new SchedulerSchedule({
    kind: 'cron',
    expr: String(args.cron_expr ?? '').trim(),
    tz: args.tz?.trim() || null,
  })
}

function payloadFromFields(
  args: Pick<SchedulerArgs, 'message' | 'deliver'>,
): SchedulerPayload {
  const message = String(args.message ?? '').trim()
  if (!message) throw new ToolError('message is required', 'INVALID_ARGUMENT')
  return new SchedulerPayload({
    kind: 'agent_turn',
    message,
    deliver: args.deliver ?? true,
  })
}

function parseDatetimeMs(value: string): number {
  const raw = value.trim().replace(/Z$/, '+00:00')
  const ms = Date.parse(raw)
  if (!raw || !Number.isFinite(ms))
    throw new ToolError(
      'at must be an ISO datetime, for example 2026-05-20T09:30:00+08:00',
      'INVALID_ARGUMENT',
    )
  return ms
}

function formatJobs(jobs: SchedulerJob[]): string {
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

function trim(text: string, limit = 80): string {
  const s = String(text || '')
    .split(/\s+/)
    .join(' ')
  return s.length <= limit ? s : `${s.slice(0, limit - 1)}…`
}

function formatMs(value: number | null): string {
  return value ? new Date(value).toISOString() : '-'
}
