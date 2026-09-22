/**
 * Same-session goal subsystem (ported from dsh goal, tool-goal,
 * goal-round-driver, command-goal) as plain code.
 *
 * Host wiring:
 *
 *   const goals = new GoalService()
 *   const { driver } = installGoal({ prompt, middleware, tools }, goals)
 *   const detach = driver.attach(agent)          // per live agent
 *   goals.onChange(({ agent, change }) => ui.emit(...))
 *   runGoalCommand(goals, agent, '/goal ship it') // `/goal` slash command
 */

import type { AgentMiddleware } from '../agent/middleware'
import type { SystemPromptAssembler } from '../prompt/assembler'
import type { ToolRegistry } from '../tools/registry'
import {
  GOAL_SECTION_NAME,
  GOAL_SECTION_ORDER,
  renderGoalGuidance,
} from './prompt'
import { GoalRoundDriver, type GoalRoundDriverOptions } from './round-driver'
import type { GoalService } from './service'
import { createGoalTools } from './tools'

export * from './types'
export * from './errors'
export * from './fold'
export * from './authority'
export * from './service'
export * from './prompt'
export * from './tools'
export * from './round-driver'
export * from './command'

export interface GoalHost {
  prompt: SystemPromptAssembler
  middleware: AgentMiddleware
  /** When given, the three goal tools are registered too. */
  tools?: ToolRegistry
}

export interface InstallGoalOptions {
  /** Reuse an existing driver instead of creating one. */
  driver?: GoalRoundDriver
  driverOptions?: GoalRoundDriverOptions
}

export interface InstalledGoal {
  readonly driver: GoalRoundDriver
  dispose(): void
}

/**
 * Register the `tool:goal` policy section (order 114), the round driver's
 * pre-step gate, and (optionally) the goal tools. Attach agents with
 * `driver.attach(agent)`.
 */
export function installGoal(
  host: GoalHost,
  service: GoalService,
  options: InstallGoalOptions = {},
): InstalledGoal {
  const driver =
    options.driver ?? new GoalRoundDriver(service, options.driverOptions)
  const disposers: Array<() => void> = []
  disposers.push(
    host.prompt.section({
      name: GOAL_SECTION_NAME,
      order: GOAL_SECTION_ORDER,
      text: renderGoalGuidance(service.blockedAfterConsecutiveRounds),
    }),
  )
  host.middleware.preStep.push(driver.preStep)
  disposers.push(() => {
    const index = host.middleware.preStep.indexOf(driver.preStep)
    if (index >= 0) host.middleware.preStep.splice(index, 1)
  })
  if (host.tools !== undefined) {
    for (const tool of createGoalTools(service))
      disposers.push(host.tools.register(tool))
  }
  return {
    driver,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}
