/**
 * Scheduler job execution on the new kernel. `agent_turn` jobs run one
 * background turn in their session (KRN-01: never the session in view) and
 * map its typed result onto the run record: completed → OK, error → Failed
 * with the error code, aborted → Cancelled, blocked → Blocked, a prompt no
 * turn took → Failed. `system_event` jobs run system handlers
 * (watchlist-check turns into an agent turn when due). Team wake jobs are
 * retired with Team.
 */

import type { SchedulerJob } from '../../scheduler/models'
import {
  SchedulerStatus,
  schedulerPayloadSessionId,
} from '../../scheduler/models'
import {
  SchedulerRunFailure,
  type SchedulerRunContext,
} from '../../scheduler/service'
import type { TurnResult } from './scope'

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
  /** Run the job's turn in the background and say how it ended. */
  runTurn(request: SchedulerTurnRequest): Promise<{ result: TurnResult }>
  /** The limit runTurn applies, for the record's wording (default 30 minutes). */
  timeoutMs?: number
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
    const { result } = await deps.runTurn({
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
    // The scheduler stopped the run itself (paused, removed, shutting down).
    if (context.signal.aborted) throw context.signal.reason
    return schedulerRunResult(result, deps.timeoutMs)
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

/**
 * The record of one scheduled turn: its reply when it completed, otherwise a
 * `SchedulerRunFailure` with the status and note the job history shows.
 */
export function schedulerRunResult(
  result: TurnResult,
  timeoutMs = 30 * 60_000,
): string {
  switch (result.kind) {
    case 'completed':
      return result.content
    case 'error':
      throw new SchedulerRunFailure(
        SchedulerStatus.ERROR,
        result.message || `the scheduled turn failed (${result.code})`,
        result.code,
      )
    case 'aborted':
      throw new SchedulerRunFailure(
        SchedulerStatus.CANCELLED,
        result.by === 'timeout'
          ? `运行超过 ${Math.round(timeoutMs / 60_000)} 分钟，已停止（timeout）`
          : result.by === 'user'
            ? '已被用户停止'
            : '已被系统停止',
        result.by === 'timeout' ? 'TIMEOUT' : null,
      )
    case 'blocked':
      throw new SchedulerRunFailure(
        SchedulerStatus.BLOCKED,
        blockedNote(result.reason, result.detail),
        'BLOCKED',
      )
    case 'not-consumed':
      throw new SchedulerRunFailure(
        SchedulerStatus.ERROR,
        `定时任务的消息没有发出（${result.reason}），仍在会话的队列里待发送`,
        'NOT_CONSUMED',
      )
  }
}

function blockedNote(
  reason: Extract<TurnResult, { kind: 'blocked' }>['reason'],
  detail: string | undefined,
): string {
  const suffix = detail ? `：${detail}` : ''
  switch (reason) {
    case 'interaction-rejected':
      return `需要审批或回答的操作已自动拒绝（定时任务无人应答）${suffix}`
    case 'plan-mode':
      return `会话处于计划模式，计划审阅已自动拒绝${suffix}`
    case 'interaction-timeout':
      return `等待审批或回答超时${suffix}`
    case 'cost-cap':
      return '达到任务费用上限，已停止'
    case 'step-limit':
      return '达到单轮步数上限，已停止'
    case 'prompt-rejected':
      return 'UserPromptSubmit Hook 拒绝了这条消息'
  }
}
