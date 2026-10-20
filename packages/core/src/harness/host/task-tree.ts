/**
 * Task tree (KRN-03): one root session owns the work it starts — every
 * subagent it and its subagents started, their child sessions, their
 * background jobs, and the host's projector and subscription for each —
 * and one budget bounds all of it.
 *
 * Lifecycle: the host adopts each child agent it attaches. Disposing a
 * child (the root stopped, a workflow collected it) tears its jobs down at
 * once and drops it from the host's tables once its driver is idle;
 * `disposeAll` does that for the whole tree when the root session goes.
 *
 * Budget: a task begins with each message the user (or a scheduler) sends
 * the root, and lasts until the next one.
 * - Steps: a turn takes at most `maxSteps` steps (`maxBackgroundSteps` in
 *   a scheduled run or a goal round); the next step ends it.
 * - Cost: every request's usage, failed attempts included, is priced and
 *   summed over the root and all children. Once the sum reaches the model
 *   policy's cap (or usage cannot be priced while a cap is set) every agent
 *   of the tree stops at its next step, no new subagent starts, and nothing
 *   wakes the root again until the user's next message.
 * - Pool: at most `maxActiveAgents` subagents run at once; one that would
 *   start waits (parked) for a free slot. A parent waiting for a child in
 *   the foreground lends the child its slot.
 * - Total: one task starts at most `maxTotalAgents` subagents; the next is
 *   refused with AGENT_BUDGET_EXCEEDED.
 * - Result wakes: subagent results wake an idle parent at most
 *   `maxNoticeWakes` times per task; later results wait for its next step,
 *   and the first refusal leaves a notice in the parent's log saying why.
 *
 * Budget state lives in memory: after a restart every task starts afresh.
 */

import type { TaskBudgetSettings } from '../../config/local-config'
import type { ModelPricing } from '../../config/model-config'
import { HarnessError } from '../../llm/error'
import { contextMessage, type UserMessage } from '../../llm/message'
import type { TokenUsage } from '../../llm/types'
import { calculateUsageCost, usdToNanos } from '../../model/execution-policy'
import type { SessionEvent, TurnBudgetReason } from '../../session-log/types'
import { logger } from '../../util/log'
import type { Agent, AgentAdmission } from '../agent/agent'
import type { BudgetStop } from '../agent/middleware'
import type { SubagentBudget } from '../subagent/manager'

/** Context producer of the budget's notices to the model. */
export const TASK_BUDGET_PRODUCER = 'task-budget'

/** A task may not start another subagent. */
export const AGENT_BUDGET_EXCEEDED = 'AGENT_BUDGET_EXCEEDED'

/** One task's budget: the settings plus the model policy's cost cap. */
export interface TaskBudget extends TaskBudgetSettings {
  /** The most one task may spend (root, children, failed attempts); none: no cap. */
  maxCostUsd?: number
}

export type BudgetVerdict =
  | { kind: 'ok'; spentUsdNanos: number }
  | {
      kind: 'exceeded'
      spentUsdNanos: number
      capUsdNanos: number
      /** Routes whose usage could not be priced. */
      unpricedRoutes: string[]
    }

/** A refused subagent start (the tool result carries the code). */
export class AgentBudgetError extends HarnessError {
  constructor(message: string) {
    super(`${AGENT_BUDGET_EXCEEDED}: ${message}`, AGENT_BUDGET_EXCEEDED)
  }
}

export interface TaskTreeDeps {
  /** The budget now, read at every decision (settings can change any time). */
  budget(): TaskBudget
  /** The configured price of one route (model entry id). */
  pricing(routeId: string): ModelPricing | undefined
  /** Whether the root's current turn is a scheduled run or a goal round. */
  background(root: Agent): boolean
  /** Cancel, await and drop every background job of one agent. */
  disposeJobs(agentId: string, reason: string): Promise<void>
  /** Stop and dispose every subagent of the root (the subagent manager). */
  disposeChildren(rootId: string): void
  /** The task's cost budget has just been spent. */
  exhausted?(): void
}

/** One adopted child. */
export interface TaskTreeChild {
  readonly sessionId: string
  readonly agent: Agent
  /** Drop the child from the host's tables (agents, projectors, subscriptions). */
  detach(): void
}

interface Member {
  readonly agent: Agent
  readonly detach: () => void
  readonly unobserve: () => void
  /** Foreground waits for its own children in progress (its slot is lent). */
  waiting: number
}

interface TaskWindow {
  spentUsdNanos: number
  failedUsdNanos: number
  readonly unpriced: Set<string>
  started: number
  /** Result wakes per parent agent. */
  readonly wakes: Map<string, number>
  /** Parents already told their results no longer wake them. */
  readonly hinted: Set<string>
  /** Agents already told the cost cap stopped them. */
  readonly costNoticed: Set<string>
  exceeded: boolean
}

function freshWindow(): TaskWindow {
  return {
    spentUsdNanos: 0,
    failedUsdNanos: 0,
    unpriced: new Set(),
    started: 0,
    wakes: new Map(),
    hinted: new Set(),
    costNoticed: new Set(),
    exceeded: false,
  }
}

/** `$1.20`; four decimals under a cent. */
export function formatUsdNanos(nanos: number): string {
  return `$${(nanos / 1e9).toFixed(nanos >= 10_000_000 ? 2 : 4)}`
}

export class TaskTree implements SubagentBudget {
  private root: Agent | undefined
  private readonly members = new Map<string, Member>()
  /** Agents refused a start, in the order they asked. */
  private readonly parked = new Set<string>()
  private readonly detaching = new Set<Promise<void>>()
  private window = freshWindow()
  private disposed = false

  /** The gate every agent of this tree starts through (`AgentOptions.admission`). */
  readonly gate: AgentAdmission = {
    admit: (agent) => this.admit(agent),
  }

  constructor(
    readonly rootSessionId: string,
    private readonly deps: TaskTreeDeps,
  ) {}

  /** The root agent (created after the tree, with `gate`). */
  setRoot(agent: Agent): void {
    this.root = agent
  }

  /** Track one child the host attached. */
  adopt(child: TaskTreeChild): void {
    const unobserve = child.agent.observe({
      status: (_agent, status) => {
        if (status === 'idle') this.pump()
      },
    })
    this.members.set(child.sessionId, {
      agent: child.agent,
      detach: () => child.detach(),
      unobserve,
      waiting: 0,
    })
  }

  /** The root and every child, by session id. */
  agentIds(): Set<string> {
    return new Set([this.rootSessionId, ...this.members.keys()])
  }

  /** Whether a subagent runs or waits for a slot. */
  childrenActive(): boolean {
    for (const [id, member] of this.members)
      if (member.agent.status === 'running' || this.parked.has(id)) return true
    return false
  }

  /**
   * A child was disposed: its jobs are torn down now; once its driver is
   * idle it leaves the host's tables. Resolves when both are done.
   */
  disposeChild(sessionId: string): Promise<void> {
    const member = this.members.get(sessionId)
    if (member === undefined) return Promise.resolve()
    this.members.delete(sessionId)
    this.parked.delete(sessionId)
    member.unobserve()
    const done = (async () => {
      await this.deps
        .disposeJobs(sessionId, 'subagent disposed')
        .catch(() => undefined)
      await member.agent.whenIdle().catch(() => undefined)
      try {
        member.detach()
      } catch (error: unknown) {
        logger.warn('task tree: detaching a subagent failed', {
          session: sessionId,
          error: String(error),
        })
      }
    })()
    this.detaching.add(done)
    void done.finally(() => this.detaching.delete(done))
    this.pump()
    return done
  }

  /** The root session goes: every child and every job of the tree. */
  async disposeAll(reason: string): Promise<void> {
    this.deps.disposeChildren(this.rootSessionId)
    for (const id of [...this.members.keys()]) void this.disposeChild(id)
    await this.deps
      .disposeJobs(this.rootSessionId, reason)
      .catch(() => undefined)
    await Promise.all([...this.detaching])
    this.disposed = true
    this.parked.clear()
  }

  // ── budget ───────────────────────────────────────────────────────────

  /** The user (or a scheduler) sent the root a message: a new task begins. */
  beginTask(): void {
    this.window = freshWindow()
    this.pump()
  }

  /** Where the task's spend stands against its cap. */
  verdict(): BudgetVerdict {
    const spentUsdNanos = this.window.spentUsdNanos
    const cap = this.deps.budget().maxCostUsd
    if (cap === undefined) return { kind: 'ok', spentUsdNanos }
    const capUsdNanos = usdToNanos(cap)
    if (spentUsdNanos < capUsdNanos && this.window.unpriced.size === 0)
      return { kind: 'ok', spentUsdNanos }
    return {
      kind: 'exceeded',
      spentUsdNanos,
      capUsdNanos,
      unpricedRoutes: [...this.window.unpriced],
    }
  }

  /** Charge one request's usage (after every request, failed attempts too). */
  charge(
    request: { routeId: string; usage: TokenUsage | undefined },
    attempt: 'ok' | 'failed',
  ): BudgetVerdict {
    const { usage, routeId } = request
    if (usage !== undefined) {
      const cost = calculateUsageCost(
        {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cache_read: usage.cacheReadTokens ?? 0,
          cache_create: usage.cacheWriteTokens ?? 0,
        },
        this.deps.pricing(routeId),
      )
      if (cost.costUsdNanos === null) this.window.unpriced.add(routeId)
      else {
        this.window.spentUsdNanos += cost.costUsdNanos
        if (attempt === 'failed')
          this.window.failedUsdNanos += cost.costUsdNanos
      }
    }
    const verdict = this.verdict()
    if (verdict.kind === 'exceeded' && !this.window.exceeded) {
      this.window.exceeded = true
      try {
        this.deps.exhausted?.()
      } catch (error: unknown) {
        logger.warn('task tree: budget exhaustion hook failed', {
          error: String(error),
        })
      }
    }
    return verdict
  }

  /** The budget that ends `agent`'s turn before `step`, if one is spent. */
  check(agent: Agent, step: number): BudgetStop | undefined {
    const verdict = this.verdict()
    if (verdict.kind === 'exceeded') {
      const reason: TurnBudgetReason = {
        kind: 'budget',
        limit: 'cost',
        capUsdNanos: verdict.capUsdNanos,
        spentUsdNanos: verdict.spentUsdNanos,
        ...(verdict.unpricedRoutes.length === 0
          ? {}
          : { unpricedRoutes: verdict.unpricedRoutes }),
      }
      // Told once per task: an agent woken again stops without a new notice.
      if (this.window.costNoticed.has(agent.id)) return { reason }
      this.window.costNoticed.add(agent.id)
      return { reason, notice: this.costNotice(verdict) }
    }
    const budget = this.deps.budget()
    const maxSteps = this.deps.background(this.root ?? agent)
      ? budget.maxBackgroundSteps
      : budget.maxSteps
    if (step <= maxSteps) return undefined
    return {
      reason: { kind: 'budget', limit: 'steps', maxSteps },
      notice: contextMessage(
        TASK_BUDGET_PRODUCER,
        `This turn stopped before step ${maxSteps + 1}: one turn takes at most ${maxSteps} steps (Settings › Advanced › Task budget). The work may be unfinished; check where it stands before you go on, and go on only when the user asks.`,
        { form: 'notice', summary: `本轮已达 ${maxSteps} 步上限，已停止` },
      ),
    }
  }

  // ── SubagentBudget ───────────────────────────────────────────────────

  reserve(_parent: Agent): void {
    const verdict = this.verdict()
    if (verdict.kind === 'exceeded')
      throw new AgentBudgetError(
        `this task's cost budget is spent (${formatUsdNanos(verdict.spentUsdNanos)} of ${formatUsdNanos(verdict.capUsdNanos)}), so no subagent can start before the user's next message.`,
      )
    const max = this.deps.budget().maxTotalAgents
    if (this.window.started >= max)
      throw new AgentBudgetError(
        `this task already started ${max} subagents, the most one task may start (Settings › Advanced › Task budget). Do the remaining work yourself, or report where it stands and let the user decide.`,
      )
    this.window.started += 1
  }

  admission(_parent: Agent): AgentAdmission {
    return this.gate
  }

  waiting(parent: Agent, delta: 1 | -1): void {
    const member = this.members.get(parent.id)
    if (member === undefined) return
    member.waiting = Math.max(0, member.waiting + delta)
    this.pump()
  }

  takeWake(parent: Agent): boolean {
    const max = this.deps.budget().maxNoticeWakes
    const spent = this.window.wakes.get(parent.id) ?? 0
    if (spent < max) {
      this.window.wakes.set(parent.id, spent + 1)
      return true
    }
    if (!this.window.hinted.has(parent.id)) {
      this.window.hinted.add(parent.id)
      try {
        // In the log at once: the user sees it, the model reads it next.
        parent.session.append('user/message', wakeHint(max), {
          surfaceOp: 'append',
        })
      } catch (error: unknown) {
        logger.warn('task tree: the result-wake notice was not logged', {
          session: parent.id,
          error: String(error),
        })
      }
    }
    return false
  }

  // ── pool ─────────────────────────────────────────────────────────────

  /** Re-check parked agents (the budget settings changed). */
  wake(): void {
    this.pump()
  }

  private admit(agent: Agent): boolean {
    if (this.disposed) return true
    const allowed =
      agent.id === this.rootSessionId
        ? // A spent task wakes the root only for the user's next message.
          this.verdict().kind !== 'exceeded'
        : this.runningChildren(agent) < this.deps.budget().maxActiveAgents
    if (allowed) this.parked.delete(agent.id)
    else this.parked.add(agent.id)
    return allowed
  }

  /** Children holding a slot: running, and not waiting for a child of their own. */
  private runningChildren(except: Agent): number {
    let count = 0
    for (const [id, member] of this.members)
      if (
        id !== except.id &&
        member.agent.status === 'running' &&
        member.waiting === 0
      )
        count += 1
    return count
  }

  /** Start parked agents, oldest first, while they may run. */
  private pump(): void {
    if (this.disposed) return
    for (const id of [...this.parked]) {
      const agent =
        id === this.rootSessionId ? this.root : this.members.get(id)?.agent
      if (agent === undefined) {
        this.parked.delete(id)
        continue
      }
      if (!this.admit(agent)) continue
      try {
        agent.wakeInbox()
      } catch (error: unknown) {
        logger.warn('task tree: a parked agent could not start', {
          session: id,
          error: String(error),
        })
      }
    }
  }

  private costNotice(
    verdict: Extract<BudgetVerdict, { kind: 'exceeded' }>,
  ): UserMessage {
    const spent = formatUsdNanos(verdict.spentUsdNanos)
    const cap = formatUsdNanos(verdict.capUsdNanos)
    const failed =
      this.window.failedUsdNanos > 0
        ? `, ${formatUsdNanos(this.window.failedUsdNanos)} of it on failed attempts`
        : ''
    const why =
      verdict.unpricedRoutes.length > 0
        ? `Usage of ${verdict.unpricedRoutes.join(', ')} has no price, so the cost cap of ${cap} cannot be kept.`
        : `It has spent ${spent} of its ${cap} cap (the main conversation and every subagent count${failed}).`
    return contextMessage(
      TASK_BUDGET_PRODUCER,
      `This task stopped at its cost budget. ${why} Nothing more runs before the user's next message; when they come back, tell them where the work stands.`,
      {
        form: 'notice',
        summary:
          verdict.unpricedRoutes.length > 0
            ? '模型缺少单价，无法执行费用上限，已停止'
            : `任务费用已达上限（${spent} / ${cap}），已停止`,
      },
    )
  }
}

/** Session ids the subagent manager mints (`sub-<uuid>`): nothing else is deleted. */
const SUBAGENT_SESSION_ID = /^sub-[A-Za-z0-9-]+$/

/**
 * Every subagent session a root recorded (`subagent/started`), and theirs,
 * read from the logs: live or not, from this run or an earlier one.
 */
export function recordedDescendants(
  rootEvents: readonly SessionEvent[],
  read: (sessionId: string) => readonly SessionEvent[],
): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const visit = (events: readonly SessionEvent[]): void => {
    for (const event of events) {
      if (event.type !== 'subagent/started') continue
      const id = event.data.subagentId
      if (seen.has(id) || !SUBAGENT_SESSION_ID.test(id)) continue
      seen.add(id)
      found.push(id)
      visit(read(id))
    }
  }
  visit(rootEvents)
  return found
}

function wakeHint(max: number): UserMessage {
  return contextMessage(
    TASK_BUDGET_PRODUCER,
    `Subagent results no longer wake you in this task: they already woke you ${max} times, the limit (Settings › Advanced › Task budget). Later results wait here and reach you with your next step.`,
    {
      form: 'notice',
      summary: `子智能体结果已唤醒 ${max} 次，之后的结果等下一步再读`,
    },
  )
}
