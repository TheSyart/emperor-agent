/**
 * Execution-time authority checks for model-originated goal mutations
 * (ported from dsh-tool-goal authority.ts, without the agent registry: a
 * "root" is an agent with no owner at delegation depth 0).
 */

import type { SessionEvent } from '../../session-log/types'
import type { Agent } from '../agent/agent'
import { GoalToolError } from './errors'
import type { GoalView } from './types'

/** The calling agent and the events accepted inside its open turn. */
export interface GoalToolExecution {
  readonly agent: Agent
  readonly events: readonly SessionEvent[]
}

/** Hard authority granted to one model-originated terminal call. */
export type GoalToolAuthority =
  | { readonly kind: 'direct-human' }
  | { readonly kind: 'goal-round'; readonly goal: GoalView }

function reject(message: string, code = 'GOAL_TOOL_AUTHORITY_REQUIRED'): never {
  throw new GoalToolError(message, code)
}

function openTurnEvents(agent: Agent): readonly SessionEvent[] {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const boundary = events[index]
    if (boundary?.type === 'turn/end')
      reject(
        'goal tools require an open model turn',
        'GOAL_TOOL_DRIVER_REQUIRED',
      )
    if (boundary?.type === 'turn/start') return events.slice(index + 1)
  }
  return reject(
    'goal tools require an open model turn',
    'GOAL_TOOL_DRIVER_REQUIRED',
  )
}

/** Authenticate the calling agent and resolve its current turn window. */
export function goalToolExecution(agent: Agent | undefined): GoalToolExecution {
  if (agent === undefined)
    return reject(
      'goal tools require a calling agent',
      'GOAL_TOOL_AGENT_REQUIRED',
    )
  if (agent.status !== 'running') {
    return reject(
      'goal tools require the exact live calling agent inside its active driver',
      'GOAL_TOOL_DRIVER_REQUIRED',
    )
  }
  return { agent, events: openTurnEvents(agent) }
}

/** Whether the agent is a runtime root (not a delegated child). */
function isRoot(agent: Agent): boolean {
  return agent.owner === undefined && agent.depth === 0
}

/**
 * Whether host-attested human input (`source.kind === 'user'`) was accepted
 * in the current root-agent turn. Goal rounds and harness context carry
 * `context` sources and never inherit this authority.
 */
function hasDirectHumanInput(execution: GoalToolExecution): boolean {
  if (!isRoot(execution.agent)) return false
  return execution.events.some(
    (event) =>
      event.type === 'user/message' && event.data.source.kind === 'user',
  )
}

/** Whether this turn admitted the current goal's exact latest round. */
function isMatchingGoalRound(
  execution: GoalToolExecution,
  goal: GoalView,
): boolean {
  const admitted = new Set<string>()
  for (const event of execution.events) {
    if (event.type === 'user/message') admitted.add(event.data.id)
  }
  if (admitted.size === 0) return false
  return execution.agent.session.events.some(
    (event) =>
      event.type === 'goal/round' &&
      admitted.has(event.data.messageId) &&
      event.data.goalId === goal.id &&
      event.data.revision === goal.revision &&
      event.data.round === goal.roundsStarted,
  )
}

/** Require authority originating in a human message accepted by a runtime root. */
export function requireDirectHuman(execution: GoalToolExecution): void {
  if (hasDirectHumanInput(execution)) return
  reject(
    'this goal operation requires a direct human turn on a top-level agent',
  )
}

/** Resolve completion authority from direct human input or the exact goal round. */
export function completionAuthority(
  execution: GoalToolExecution,
  goal: GoalView | undefined,
): GoalToolAuthority {
  if (hasDirectHumanInput(execution)) return { kind: 'direct-human' }
  if (goal !== undefined && isMatchingGoalRound(execution, goal))
    return { kind: 'goal-round', goal }
  return reject(
    'complete and blocked require a direct human turn or the current goal round',
  )
}
