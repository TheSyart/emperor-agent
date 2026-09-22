/**
 * Plan mode (ported from dsh-plan-mode). Prompt-only by design: the tool
 * catalog never changes (request-cache stability), no guard blocks mutating
 * tools; the `plan:policy` system section (order 50) carries the rules.
 *
 * Enter with `/plan [message]`, leave with `/plan off` or an approved
 * `exit_plan_mode`. A switch requested inside an open turn is queued and
 * lands as one `plan/mode` event at the next step boundary; the model is
 * told of user-initiated switches by a notice.
 */

import { z } from 'zod'
import { contextMessage, type UserMessage } from '../../llm/message'
import type { Session } from '../../session-log/session'
import type { SessionEvent } from '../../session-log/types'
import type { Agent } from '../agent/agent'
import type { AgentMiddleware } from '../agent/middleware'
import type { SystemPromptAssembler } from '../prompt/assembler'
import { defineTool, ToolError, type ToolDefinition } from '../tools/definition'

declare module '../../session-log/types' {
  interface SessionEventMap {
    'plan/mode': { active: boolean }
  }
}

export const EXIT_PLAN_MODE = 'exit_plan_mode'

/** The standard preset's plan-mode section, verbatim. */
export const PLAN_MODE_SECTION = `You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`

const EXIT_DESCRIPTION =
  "Use only in plan mode. Present your plan for the user's review and, on approval, leave plan mode. " +
  'Send the COMPLETE plan as markdown, starting with a # heading that names it. ' +
  'The user may approve (carry out the plan from your next step) or keep ' +
  'planning — their feedback comes back in the tool result; revise and present again.'

export type PlanReviewOutcome =
  | { kind: 'approved' }
  | { kind: 'keep-planning'; feedback?: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' }

/** Presents a plan to the user (host wires this to the question service). */
export type PlanReviewer = (request: {
  agent: Agent
  callId: string
  plan: string
  title: string | undefined
  signal: AbortSignal
}) => Promise<PlanReviewOutcome>

export function firstHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

export function foldPlanMode(
  events: readonly SessionEvent[],
  end = events.length,
): boolean {
  let active = false
  for (let index = 0; index < Math.min(end, events.length); index++) {
    const event = events[index]!
    if (event.type === 'plan/mode') active = event.data.active
  }
  return active
}

/** Plan mode as the model last saw it (at the latest request header), if any. */
function planModeAtLastHeader(
  events: readonly SessionEvent[],
): boolean | undefined {
  let lastHeader = -1
  for (let index = 0; index < events.length; index++) {
    if (events[index]!.type === 'request/header') lastHeader = index
  }
  return lastHeader < 0 ? undefined : foldPlanMode(events, lastHeader + 1)
}

export type PlanSwitchOutcome = 'committed' | 'queued' | 'cancelled' | 'noop'

export class PlanModeController {
  private readonly pending = new WeakMap<
    Session,
    { active: boolean; narrate: boolean }
  >()
  private reviewer: PlanReviewer | undefined

  constructor(private readonly section: string = PLAN_MODE_SECTION) {}

  setReviewer(reviewer: PlanReviewer | undefined): void {
    this.reviewer = reviewer
  }

  install(prompt: SystemPromptAssembler, middleware: AgentMiddleware): void {
    prompt.section({
      name: 'plan:policy',
      order: 50,
      text: ({ agent }) => {
        if (agent === undefined) return ''
        const pending = this.pending.get(agent.session)
        return (pending?.active ?? foldPlanMode(agent.session.events))
          ? this.section
          : ''
      },
    })
    middleware.preStep.push(({ agent, messages }) => {
      const pending = this.pending.get(agent.session)
      if (pending === undefined) return undefined
      const narration = this.narration(agent.session, pending.active)
      this.onBoundary(agent.session)
      return !pending.narrate || narration === undefined
        ? undefined
        : { kind: 'enter', messages: [...messages, narration] }
    })
  }

  /** Current mode plus a queued (not yet landed) switch, if any. */
  get(session: Session): { active: boolean; pending?: boolean } {
    const active = foldPlanMode(session.events)
    const pending = this.pending.get(session)
    return pending === undefined
      ? { active }
      : { active, pending: pending.active }
  }

  /** User-initiated switch (`/plan`, `/plan off`, UI mode picker). */
  set(agent: Agent, active: boolean): PlanSwitchOutcome {
    const session = agent.session
    const pending = this.pending.get(session)
    const target = pending?.active ?? foldPlanMode(session.events)
    if (active === target) return 'noop'
    if (session.hasOpenTurn()) {
      this.pending.set(session, { active, narrate: true })
      return foldPlanMode(session.events) === active ? 'cancelled' : 'queued'
    }
    if (active === foldPlanMode(session.events)) {
      this.pending.delete(session)
      return 'cancelled'
    }
    session.append('plan/mode', { active })
    this.pending.delete(session)
    const narration = this.narration(session, active)
    if (narration !== undefined) agent.inject(narration)
    return 'committed'
  }

  private onBoundary(session: Session): void {
    const pending = this.pending.get(session)
    if (pending === undefined) return
    this.pending.delete(session)
    if (pending.active !== foldPlanMode(session.events))
      session.append('plan/mode', { active: pending.active })
  }

  private narration(
    session: Session,
    target: boolean,
  ): UserMessage | undefined {
    const told = planModeAtLastHeader(session.events)
    if (told === undefined || told === target) return undefined
    const text = target
      ? 'The user switched this session to plan mode.'
      : 'The user switched this session back to the default mode.'
    return contextMessage('plan-mode', text, { form: 'notice', summary: text })
  }

  /** The `exit_plan_mode` tool. */
  tool(): ToolDefinition {
    return defineTool({
      name: EXIT_PLAN_MODE,
      description: EXIT_DESCRIPTION,
      input: z.object({
        plan: z
          .string()
          .describe(
            'The complete plan, as markdown, starting with a # heading that names it.',
          ),
      }),
      execute: async ({ plan }, context) => {
        const agent = context.agent
        if (agent === undefined)
          throw new ToolError(
            `${EXIT_PLAN_MODE} requires a calling agent (no session to switch)`,
          )
        if (!foldPlanMode(agent.session.events))
          throw new ToolError(
            `${EXIT_PLAN_MODE} is only available in plan mode`,
          )
        if (!/^#\s+\S/.test(plan.trim()))
          throw new ToolError(
            `${EXIT_PLAN_MODE} requires a non-empty markdown plan starting with a # heading`,
          )
        const reviewer = this.reviewer
        if (reviewer === undefined) {
          throw new ToolError(
            'no review channel is available to review the plan; ask the user to switch the session mode instead',
          )
        }
        const title = firstHeading(plan)
        const outcome = await reviewer({
          agent,
          callId: context.callId,
          plan,
          title,
          signal: context.signal,
        })
        switch (outcome.kind) {
          case 'approved':
            this.pending.set(agent.session, { active: false, narrate: false })
            return {
              content:
                'Plan approved — plan mode exited; carry out the plan starting with your next step.',
              meta: { approved: true, title: title ?? null },
            }
          case 'keep-planning':
            throw new ToolError(
              outcome.feedback === undefined || outcome.feedback === ''
                ? 'The user chose to keep planning; revise the plan and present it again.'
                : `The user chose to keep planning; their feedback: ${outcome.feedback}`,
              'PLAN_REJECTED',
            )
          case 'cancelled':
            throw new ToolError(
              'The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.',
              'PLAN_REVIEW_CANCELLED',
            )
          case 'unavailable':
            throw new ToolError(
              'no review channel is available to review the plan; ask the user to switch the session mode instead',
              'PLAN_REVIEW_UNAVAILABLE',
            )
        }
      },
    })
  }
}
