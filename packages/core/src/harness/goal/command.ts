/**
 * Human-facing `/goal` command (ported from dsh-command-goal) as a plain
 * function (`rawInput` may be the text after `/goal` or the whole line). Grammar: `/goal` (show), `/goal <objective>` (create),
 * `/goal edit <objective>`, `/goal pause`, `/goal resume`, `/goal clear`.
 * Control words are case-insensitive only when they are the whole input;
 * any other suffix is a literal objective. Mutations use host (`user`)
 * authority.
 */

import { createUserMessage } from '../../llm/message'
import type { ContentBlock } from '../../llm/types'
import type { Agent } from '../agent/agent'
import { GoalError } from './errors'
import type { GoalService } from './service'
import type { GoalRef, GoalView } from './types'

export const GOAL_COMMAND_USAGE =
  'Usage: /goal [<objective>|clear|edit <objective>|pause|resume]'
export const GOAL_COMMAND_DESCRIPTION =
  'set or view the goal for a long-running task'
export const GOAL_COMMAND_HINT =
  '[<objective>|clear|edit <objective>|pause|resume]'

export interface GoalCommandResult {
  kind: 'success' | 'error'
  text: string
}

export interface GoalCommandOptions {
  /** Composer image blocks; they accompany only a create or edit objective. */
  attachments?: readonly ContentBlock[]
}

type GoalCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'create'; readonly objective: string }
  | { readonly kind: 'edit'; readonly objective: string }
  | { readonly kind: 'invalid-edit' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'clear' }

/** Parse only `/goal`'s own grammar; arbitrary other input is an objective. */
export function parseGoalCommand(rawInput: string): GoalCommand {
  // Accept the full `/goal …` line as well as the text after the command name.
  const input = rawInput
    .trim()
    .replace(/^\/goal(?=\s|$)/iu, '')
    .trim()
  if (input.length === 0) return { kind: 'show' }
  const control = input.toLowerCase()
  if (control === 'clear') return { kind: 'clear' }
  if (control === 'pause') return { kind: 'pause' }
  if (control === 'resume') return { kind: 'resume' }
  if (control === 'edit') return { kind: 'invalid-edit' }
  if (/^edit(?=\s)/iu.test(input))
    return { kind: 'edit', objective: input.slice(4).trim() }
  return { kind: 'create', objective: input }
}

function commandHint(goal: GoalView): string {
  switch (goal.phase) {
    case 'active':
      return goal.activation === 'armed'
        ? '/goal edit <objective>, /goal pause, /goal clear'
        : '/goal edit <objective>, /goal resume, /goal clear'
    case 'paused':
    case 'blocked':
      return '/goal edit <objective>, /goal resume, /goal clear'
    case 'complete':
      return '/goal <objective>, /goal clear'
  }
}

/** Render direct UI output without exposing compare-and-set internals. */
export function renderGoalStatus(title: string, goal: GoalView): string {
  const reason = goal.phase === 'blocked' ? goal.blockedReason : undefined
  const blocker =
    reason === undefined ? [] : [`Blocker: ${reason.code}: ${reason.message}`]
  return [
    title,
    `Status: ${goal.phase}`,
    ...blocker,
    `Objective: ${goal.objective}`,
    `Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
    `Activation: ${goal.activation}`,
    '',
    `Commands: ${commandHint(goal)}`,
  ].join('\n')
}

function success(title: string, goal: GoalView): GoalCommandResult {
  return { kind: 'success', text: renderGoalStatus(title, goal) }
}

function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

function missingGoal(action: string): GoalCommandResult {
  return {
    kind: 'error',
    text: `No goal is currently set; /goal ${action} requires one. ${GOAL_COMMAND_USAGE}`,
  }
}

function submitObjectiveAttachments(
  agent: Agent,
  attachments: readonly ContentBlock[],
): void {
  if (attachments.length === 0) return
  agent.followup(
    createUserMessage({
      content: [
        ...attachments,
        { type: 'text', text: 'Reference images for the goal objective.' },
      ],
      source: { kind: 'user' },
    }),
  )
}

/**
 * Execute one `/goal` invocation (`rawInput` is the text after `/goal`).
 * Expected domain rejections become a stable error result; unexpected
 * failures throw.
 */
export function runGoalCommand(
  service: GoalService,
  agent: Agent,
  rawInput: string,
  options: GoalCommandOptions = {},
): GoalCommandResult {
  const command = parseGoalCommand(rawInput)
  const attachments = options.attachments ?? []
  if (
    attachments.length > 0 &&
    command.kind !== 'create' &&
    command.kind !== 'edit'
  ) {
    return {
      kind: 'error',
      text: 'Image attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.',
    }
  }
  try {
    const current = service.get(agent)
    switch (command.kind) {
      case 'show':
        return current === undefined
          ? {
              kind: 'success',
              text: `No goal is currently set.\n${GOAL_COMMAND_USAGE}`,
            }
          : success('Goal', current)
      case 'invalid-edit':
        return {
          kind: 'error',
          text: `Goal editing requires a replacement objective.\n${GOAL_COMMAND_USAGE}`,
        }
      case 'create': {
        if (current !== undefined && current.phase !== 'complete') {
          return {
            kind: 'error',
            text: `A goal is already ${current.phase}. Use /goal edit <objective> to change it or /goal clear before replacing it.`,
          }
        }
        const created = service.create(
          agent,
          { objective: command.objective },
          'user',
        )
        submitObjectiveAttachments(agent, attachments)
        return success('Goal created', created)
      }
      case 'edit': {
        if (current === undefined) return missingGoal('edit')
        if (current.phase === 'complete') {
          const replaced = service.create(
            agent,
            { objective: command.objective },
            'user',
          )
          submitObjectiveAttachments(agent, attachments)
          return success('Goal created', replaced)
        }
        const edited = service.edit(agent, goalRef(current), {
          objective: command.objective,
        })
        submitObjectiveAttachments(agent, attachments)
        return success('Goal updated', edited)
      }
      case 'pause':
        if (current === undefined) return missingGoal('pause')
        return success('Goal paused', service.pause(agent, goalRef(current)))
      case 'resume':
        if (current === undefined) return missingGoal('resume')
        return success('Goal resumed', service.resume(agent, goalRef(current)))
      case 'clear':
        if (current === undefined)
          return { kind: 'success', text: 'No goal to clear.' }
        service.clear(agent, goalRef(current))
        return { kind: 'success', text: 'Goal cleared.' }
    }
  } catch (error: unknown) {
    if (error instanceof GoalError) {
      return {
        kind: 'error',
        text: 'The goal command is not valid for the current state. Run /goal to view available commands.',
      }
    }
    throw error
  }
}
