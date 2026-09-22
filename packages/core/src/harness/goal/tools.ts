/**
 * Model-facing `get_goal`, `create_goal`, and `update_goal` (ported from
 * dsh-tool-goal). Results are dsh's compact JSON; `meta.goal` carries the
 * full {@link GoalView} (or `null`) for the host UI.
 */

import { z } from 'zod'
import { contextMessage } from '../../llm/message'
import type { Agent } from '../agent/agent'
import {
  defineTool,
  type ToolDefinition,
  type ToolReturn,
  type ToolRunContext,
} from '../tools/definition'
import { goalToolExecution } from './authority'
import { renderWrapupContext } from './prompt'
import type { GoalService } from './service'
import type { GoalUpdateAction, GoalView } from './types'

export const GET_GOAL = 'get_goal'
export const CREATE_GOAL = 'create_goal'
export const UPDATE_GOAL = 'update_goal'

const UPDATE_ACTIONS = [
  'edit',
  'pause',
  'resume',
  'complete',
  'blocked',
] as const satisfies readonly GoalUpdateAction[]

const GET_DESCRIPTION =
  'Read the current same-session goal, including its exact id/revision, objective, phase, completed ' +
  'continuation rounds, round limit, blocker reason when present, and whether another continuation is armed. ' +
  'Call this before updating a goal.'

const CREATE_DESCRIPTION =
  'Create one persisted same-session completion goal when the current direct human request ' +
  'is a long-running objective that should continue across autonomous goal rounds. You may ' +
  'infer that intent without requiring the user to say "create a goal". Do not use this for ' +
  'trivial single-turn work. Execution rejects non-human and subagent authority.'

const UPDATE_DESCRIPTION =
  'Update the exact current goal revision. edit, pause, and resume require a direct ' +
  'top-level human request. During an automatic continuation of the current goal, complete ' +
  'and blocked are also allowed. blocked is rejected before the configured minimum round count; the model remains ' +
  'responsible for judging that the same condition persisted across those rounds and must explain it in blocked_reason.'

/** dsh's canonical compact goal-tool value. */
export type GoalToolValue =
  | { goal: null }
  | {
      goal: {
        id: string
        revision: number
        objective: string
        phase: GoalView['phase']
        roundsStarted: number
        maxGoalRounds: number
        blockedReason?: { code: string; message: string }
      }
      activation: GoalView['activation']
    }

export function goalToolValue(goal: GoalView | undefined): GoalToolValue {
  if (goal === undefined) return { goal: null }
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined
        ? {}
        : {
            blockedReason: {
              code: goal.blockedReason.code,
              message: goal.blockedReason.message,
            },
          }),
    },
    activation: goal.activation,
  }
}

function result(goal: GoalView | undefined): ToolReturn {
  return {
    content: JSON.stringify(goalToolValue(goal)),
    meta: { goal: goal ?? null },
  }
}

const getInput = z.object({})

const createInput = z.object({
  objective: z
    .string()
    .describe(
      'The concrete completion objective inferred from the direct human request.',
    ),
  max_goal_rounds: z
    .number()
    .describe(
      'Optional positive safe-integer limit on automatic continuation rounds.',
    )
    .optional(),
})

const updateInput = z.object({
  goal_id: z.string().describe('Exact id returned by get_goal.'),
  revision: z
    .number()
    .describe('Exact positive revision returned by get_goal.'),
  action: z
    .enum(UPDATE_ACTIONS)
    .describe('edit | pause | resume | complete | blocked'),
  objective: z
    .string()
    .describe('Replacement objective; valid only with action edit.')
    .optional(),
  max_goal_rounds: z
    .number()
    .describe('Replacement cap; valid only with action edit.')
    .optional(),
  blocked_reason: z
    .string()
    .describe('Concrete blocking condition; required only with action blocked.')
    .optional(),
})

/** dsh runs every goal tool inside the authenticated calling agent's open turn. */
function callingAgent(context: ToolRunContext): Agent {
  return goalToolExecution(context.agent).agent
}

/** The three goal tools over one service. */
export function createGoalTools(service: GoalService): ToolDefinition[] {
  const getGoal = defineTool({
    name: GET_GOAL,
    description: GET_DESCRIPTION,
    input: getInput,
    async execute(_args, context) {
      return result(service.get(callingAgent(context)))
    },
  })

  const createGoal = defineTool({
    name: CREATE_GOAL,
    description: CREATE_DESCRIPTION,
    input: createInput,
    async execute(args, context) {
      const goal = service.create(
        callingAgent(context),
        {
          objective: args.objective,
          ...(args.max_goal_rounds === undefined
            ? {}
            : { maxGoalRounds: args.max_goal_rounds }),
        },
        'model',
      )
      return result(goal)
    },
  })

  const updateGoal = defineTool({
    name: UPDATE_GOAL,
    description: UPDATE_DESCRIPTION,
    input: updateInput,
    async execute(args, context) {
      const { goal, authority } = service.updateDetailed(
        callingAgent(context),
        {
          goalId: args.goal_id,
          revision: args.revision,
          action: args.action,
          ...(args.objective === undefined
            ? {}
            : { objective: args.objective }),
          ...(args.max_goal_rounds === undefined
            ? {}
            : { maxGoalRounds: args.max_goal_rounds }),
          ...(args.blocked_reason === undefined
            ? {}
            : { blockedReason: args.blocked_reason }),
        },
        'model',
      )
      if (authority.kind === 'goal-round') {
        context.deferContext(
          contextMessage(
            'tool-goal',
            args.action === 'complete'
              ? renderWrapupContext(goal.objective)
              : renderWrapupContext(
                  goal.objective,
                  args.blocked_reason as string,
                ),
            { form: 'notice', summary: `${args.action}: ${goal.objective}` },
          ),
        )
      }
      return result(goal)
    },
  })

  return [getGoal, createGoal, updateGoal] as ToolDefinition[]
}
