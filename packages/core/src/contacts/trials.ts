/**
 * 试用台 (GRP-04): one run of the editor's unsaved draft on a sample task,
 * in a hidden session (`surface: 'trial'`) that no list, search or event
 * stream shows. The session runs as the draft — its role card, tools, model
 * and permission — through a draft override of the contact runtime, so the
 * saved contact and its own sessions are never touched. The result comes
 * back with what it cost; trial sessions are removed after 24 hours.
 *
 * The user starts a trial with a button. Closing the editor while it runs
 * stops it (`stop`). Questions and approvals have nobody to answer them, so
 * they are refused for the run.
 */
import type { TurnResult } from '../harness/host/scope'
import type { TokenUsage } from '../llm/types'
import type { SessionEvent } from '../session-log/types'
import { logger } from '../util/log'
import { ContactTrialRunningError } from './errors'
import type { Contact, ContactTrialResult } from './types'

/** How long a trial session is kept (for a look at its log), then removed. */
export const TRIAL_RETENTION_MS = 24 * 60 * 60 * 1000
/** A trial that runs longer is stopped. */
export const TRIAL_TIMEOUT_MS = 10 * 60_000
/** Characters of a sample task. */
export const TRIAL_TASK_LIMIT = 4000

export interface ContactTrialsDeps {
  /** A new hidden session (`surface: 'trial'`) that runs as `contactId`. */
  createSession(title: string, contactId: string): { id: string }
  /** One turn on `task`; aborted with `signal`. */
  runTurn(
    sessionId: string,
    task: string,
    signal: AbortSignal,
  ): Promise<{ content: string; result: TurnResult }>
  /** The session's log as it is now. */
  events(sessionId: string): readonly SessionEvent[]
  /** One call's price in USD (null: unknown). */
  costOf(routeId: string, usage: TokenUsage): number | null
  /** Every trial session there is. */
  trialSessions(): Array<{ id: string; created_at: string }>
  /** Removes a session for good (log, snapshots and all). */
  removeSession(sessionId: string): Promise<void>
  /** Lets go of a session's agent once its run is over. */
  unload(sessionId: string): void
  now?: () => number
}

const BLOCKED_TEXT: Readonly<Record<string, string>> = {
  'cost-cap': '到了费用上限，试用停下了。',
  'step-limit': '工具调用次数到了上限，试用停下了。',
  'interaction-rejected':
    '试用里没有人能批准操作或回答问题，相关的操作都被拒绝了。',
  'interaction-timeout': '试用在等人回答，已停止。',
  'plan-mode': '试用里没有人能确认计划，已停止。',
  'prompt-rejected': '这条任务被拦下了，没有运行。',
}

export class ContactTrials {
  /** The draft each running trial session runs as. */
  private readonly drafts = new Map<string, Contact>()
  /** Running trials by the editor's trial id. */
  private readonly running = new Map<string, AbortController>()
  private readonly now: () => number

  constructor(private readonly deps: ContactTrialsDeps) {
    this.now = deps.now ?? Date.now
  }

  /** The draft a trial session runs as (null: not a running trial). */
  draft(sessionId: string): Contact | null {
    const draft = this.drafts.get(sessionId)
    return draft === undefined ? null : structuredClone(draft)
  }

  /** Runs `draft` once on `task`; resolves when the run is over. */
  async run(
    draft: Contact,
    task: string,
    trialId: string,
  ): Promise<ContactTrialResult> {
    if (this.running.has(trialId)) throw new ContactTrialRunningError()
    const controller = new AbortController()
    this.running.set(trialId, controller)
    const started = this.now()
    void this.purgeExpired(started).catch((error: unknown) =>
      logger.warn('contacts: clearing old trial sessions failed', {
        error: String(error),
      }),
    )
    try {
      const session = this.deps.createSession(`试用 · ${draft.name}`, draft.id)
      this.drafts.set(session.id, structuredClone(draft))
      try {
        const outcome = await this.deps.runTurn(
          session.id,
          task,
          controller.signal,
        )
        return this.result(
          trialId,
          outcome,
          this.deps.events(session.id),
          controller.signal.aborted,
          started,
        )
      } finally {
        this.drafts.delete(session.id)
        this.deps.unload(session.id)
      }
    } finally {
      this.running.delete(trialId)
    }
  }

  /** Stops a running trial (the editor closed); false when none runs. */
  stop(trialId: string): { stopped: boolean } {
    const controller = this.running.get(trialId)
    controller?.abort()
    return { stopped: controller !== undefined }
  }

  /** Removes the trial sessions older than 24 hours; returns their ids. */
  async purgeExpired(now = this.now()): Promise<string[]> {
    const removed: string[] = []
    for (const session of this.deps.trialSessions()) {
      if (this.drafts.has(session.id)) continue
      const created = Date.parse(session.created_at)
      if (!Number.isFinite(created) || now - created <= TRIAL_RETENTION_MS)
        continue
      try {
        await this.deps.removeSession(session.id)
        removed.push(session.id)
      } catch (error) {
        logger.warn('contacts: could not remove a trial session', {
          id: session.id,
          error: String(error),
        })
      }
    }
    return removed
  }

  private result(
    trialId: string,
    outcome: { content: string; result: TurnResult },
    events: readonly SessionEvent[],
    stopped: boolean,
    started: number,
  ): ContactTrialResult {
    const usage = { inputTokens: 0, outputTokens: 0 }
    let costUsd: number | null = 0
    for (const event of events) {
      const call =
        event.type === 'assistant/message' && event.data.usage !== undefined
          ? {
              usage: event.data.usage,
              routeId: event.data.message.source.provider,
            }
          : event.type === 'compaction/summary' &&
              event.data.usage !== undefined
            ? { usage: event.data.usage, routeId: event.data.provider }
            : null
      if (call === null) continue
      usage.inputTokens +=
        call.usage.inputTokens +
        (call.usage.cacheReadTokens ?? 0) +
        (call.usage.cacheWriteTokens ?? 0)
      usage.outputTokens += call.usage.outputTokens
      const cost = this.deps.costOf(call.routeId, call.usage)
      costUsd = cost === null || costUsd === null ? null : costUsd + cost
    }
    const at = this.now()
    const base = { trialId, costUsd, usage, durationMs: at - started, at }
    const result = outcome.result
    if (stopped) return { ...base, status: 'stopped', text: '' }
    switch (result.kind) {
      case 'completed':
        return { ...base, status: 'completed', text: result.content.trim() }
      case 'aborted':
        return {
          ...base,
          status: 'failed',
          text:
            result.by === 'timeout'
              ? `试用超过 ${TRIAL_TIMEOUT_MS / 60_000} 分钟，已停止。`
              : '试用被中断了。',
        }
      case 'error':
        return {
          ...base,
          status: 'failed',
          text: `试用没能完成：${result.message}`,
        }
      case 'blocked': {
        const reason = BLOCKED_TEXT[result.reason] ?? '试用没能完成。'
        const text = result.detail ? `${reason}（${result.detail}）` : reason
        return { ...base, status: 'failed', text }
      }
      case 'not-consumed':
        return { ...base, status: 'failed', text: '这条任务没有运行。' }
    }
  }
}
