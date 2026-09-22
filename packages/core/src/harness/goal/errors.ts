import { HarnessError } from '../../llm/error'
import type { GoalErrorCode } from './types'

/** Version of the durable `goal/change` payload. */
export const GOAL_CHANGE_VERSION = 1

/** Rejection raised by the goal domain boundary. */
export class GoalError extends HarnessError {
  declare readonly code: GoalErrorCode

  constructor(message: string, code: GoalErrorCode) {
    super(message, code)
  }
}

/** Tool-policy rejection (authority, arguments, thresholds); dsh-tool-goal codes. */
export class GoalToolError extends HarnessError {}
