/**
 * Scheduler job execution on the new kernel. `agent_turn` jobs submit one
 * prompt to their session (or the active one) and resolve with the turn's
 * reply; `system_event` jobs run system handlers (watchlist-check turns
 * into an agent turn when due). Team wake jobs are retired with Team.
 */

import type { SchedulerJob } from '../../scheduler/models'
import { schedulerPayloadSessionId } from '../../scheduler/models'
import type { SchedulerRunContext } from '../../scheduler/service'

export interface SchedulerTurnRequest {
  sessionId: string | null
  content: string
  displayContent: string
  clientMessageId: string
  deliver: boolean
  scheduler: Record<string, unknown>
  signal: AbortSignal
}

export interface SchedulerExecutorDeps {
  submitTurn(request: SchedulerTurnRequest): Promise<string>
  hasPendingInteraction(sessionId: string | null): boolean
  watchlistCheck?(
    signal: AbortSignal,
  ): Promise<{ action: string; reason: string; message: string }>
}

export function schedulerTurnContent(
  job: SchedulerJob,
  message = job.payload.message.trim(),
): string {
  return [
    '[SCHEDULER_TRIGGER]',
    `job_id: ${job.id}`,
    `job_name: ${job.name}`,
    `payload_kind: ${job.payload.kind}`,
    '',
    '用户预先登记的本地长期任务现在触发。请把它当作一次主动 turn 处理；完成后给出简洁结果。',
    '',
    '## Scheduled Task',
    message,
  ].join('\n')
}

export function createSchedulerExecutor(
  deps: SchedulerExecutorDeps,
): (job: SchedulerJob, context: SchedulerRunContext) => Promise<string> {
  const runTurn = async (
    job: SchedulerJob,
    context: SchedulerRunContext,
    message: string,
  ): Promise<string> => {
    if (!message)
      throw new Error('agent_turn scheduler job requires payload.message')
    const sessionId = schedulerPayloadSessionId(job.payload) || null
    if (deps.hasPendingInteraction(sessionId))
      throw new Error(
        'cannot run scheduler agent_turn while a question or approval is pending',
      )
    return deps.submitTurn({
      sessionId,
      content: schedulerTurnContent(job, message),
      displayContent: `定时任务触发 · ${job.name}\n\n${message}`,
      clientMessageId: `scheduler:${context.runId}`,
      deliver: Boolean(job.payload.deliver),
      scheduler: {
        jobId: job.id,
        jobName: job.name,
        runId: context.runId,
        taskId: context.taskId,
        scheduledForMs: context.scheduledForMs,
        trigger: context.trigger,
      },
      signal: context.signal,
    })
  }
  return async (job, context) => {
    switch (job.payload.kind) {
      case 'agent_turn':
        return runTurn(job, context, job.payload.message.trim())
      case 'team_wake':
        throw new Error(
          'team_wake jobs are no longer supported (Team was removed); delete this job or convert it to an agent_turn',
        )
      case 'system_event': {
        const eventName = String(
          job.payload.meta.system_event || job.payload.message || job.id,
        )
        if (eventName !== 'watchlist-check')
          return `system_event acknowledged: ${eventName}`
        if (deps.watchlistCheck === undefined)
          return 'watchlist-check skipped: watchlist service unavailable'
        const decision = await deps.watchlistCheck(context.signal)
        if (decision.action !== 'run')
          return `watchlist-check skipped: ${decision.reason}`
        return runTurn(
          job,
          context,
          `[WATCHLIST_TRIGGER]\nreason: ${decision.reason}\n\n${decision.message}`,
        )
      }
      default:
        throw new Error(
          `unsupported scheduler payload kind: ${String(job.payload.kind)}`,
        )
    }
  }
}
