/**
 * Model-visible goal text, verbatim from dsh: the `tool:goal` policy section
 * (dsh-tool-goal, order 114), the `<goal_round>` continuation prompt
 * (dsh-goal-round-driver), and the terminal wrap-up notices (dsh-tool-goal).
 */

import type { GoalView } from './types'

export const GOAL_SECTION_NAME = 'tool:goal'
export const GOAL_SECTION_ORDER = 114

/** Policy guidance with the configured blocked threshold. */
export function renderGoalGuidance(blockedAfter: number): string {
  return (
    'Use goal tools for one long-running completion objective in the current session. ' +
    'create_goal may infer goal intent from a direct human request in any language; do not ' +
    'create a goal for routine single-turn work. Call get_goal before update_goal and copy its ' +
    'exact goal_id and revision. After session resume or fork, an active goal is disarmed: when ' +
    'a human asks to continue or resume in any wording or language, use update_goal action ' +
    'resume to rearm it. Mark complete only when the objective is actually achieved. Mark ' +
    `blocked only after the same blocking condition persists for at least ${blockedAfter} ` +
    'consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, ' +
    'or useful remaining work is not blocked.'
  )
}

/** The complete goal-round instruction retained in session history. */
export function renderGoalRoundPrompt(
  goal: Pick<GoalView, 'objective' | 'maxGoalRounds'>,
  round: number,
): string {
  return (
    '<goal_round>\n' +
    `Objective: ${JSON.stringify(goal.objective)}\n` +
    `Round: ${round}/${goal.maxGoalRounds}\n\n` +
    'Continue working toward the objective in this same session. Treat the current workspace, ' +
    'tool results, and durable session state as authoritative; inspect them instead of assuming ' +
    'earlier narration is still current. Make concrete progress and verify the result. Before ' +
    'claiming completion, gather evidence that the whole objective is achieved, read the current ' +
    'goal, and mark it complete. If work remains, leave the goal active for the next round. Follow ' +
    'the configured goal-tool policy before reporting a blocker.\n' +
    '</goal_round>'
  )
}

const GROUNDING =
  'Report only what earlier rounds and tool results in this session actually establish; ' +
  'when a detail is not in the session, say so instead of inventing it. '

/**
 * The closing-message instruction deferred after an autonomous goal round
 * reports `complete` or `blocked`.
 */
export function renderWrapupContext(
  objective: string,
  blockedReason?: string,
): string {
  const heading = `Objective: ${JSON.stringify(objective)}\n`
  return blockedReason === undefined
    ? '<goal_complete>\n' +
        heading +
        'The goal is marked complete and this autonomous run is ending. Write the closing ' +
        'message to the user now: state the outcome, summarize what was done and how it was ' +
        'verified, and point to the concrete results (files, commits, or other artifacts). ' +
        GROUNDING +
        'Note anything the user should review or do next. Address the user directly. Do not ' +
        "call any more tools in this run; further work waits for the user's next instruction.\n" +
        '</goal_complete>'
    : '<goal_blocked>\n' +
        heading +
        `Blocked: ${JSON.stringify(blockedReason)}\n` +
        'The goal is marked blocked and this autonomous run is ending. Write the closing ' +
        'message to the user now: state what has been completed so far, describe the concrete ' +
        'blocking condition and what you tried, and say exactly what you need from the user to ' +
        'continue. ' +
        GROUNDING +
        'Address the user directly. Do not call any more tools in this run; further work ' +
        "waits for the user's next instruction.\n" +
        '</goal_blocked>'
}
