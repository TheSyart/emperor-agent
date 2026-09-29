/** Shared plumbing for GUI tool bodies: identity, gate ticket, errors. */

import type { Agent } from '../../agent/agent'
import type { ToolReturn, ToolRunContext } from '../../tools/definition'
import { asUiError, UiError } from '../errors'
import type { GateDeps } from '../gate'
import type { UiCallerIdentity } from '../identity'
import type { ComputerUseService, OpContext } from '../service/service'
import { uiErrorResult } from './result'

export interface ToolRuntime {
  readonly service: ComputerUseService
  readonly gate: GateDeps
  identity(agent: Agent | undefined): UiCallerIdentity
  /** The route serving this agent can see images. */
  vision(agent: Agent): boolean
  isDirectChild(parentSessionId: string, childId: string): boolean
}

/**
 * Run a GUI tool body with its gate ticket. Every failure becomes a
 * structured error result (code, retryable, hint) instead of a bare string.
 */
export async function runGuiTool(
  runtime: ToolRuntime,
  toolName: string,
  context: ToolRunContext,
  body: (op: OpContext) => Promise<ToolReturn>,
): Promise<ToolReturn> {
  try {
    const identity = runtime.identity(context.agent)
    const agent = context.agent!
    const ticket = runtime.service.takeTicket(agent.id, context.callId)
    return await body({
      identity,
      callId: context.callId,
      toolName,
      signal: context.signal,
      ticket,
      vision: runtime.vision(agent),
    })
  } catch (error) {
    const uiError = asUiError(error, 'DRIVER_UNAVAILABLE')
    if (toolName === 'desktop_observe' && uiError.code === 'STALE_TARGET') {
      return uiErrorResult(
        toolName,
        new UiError('STALE_TARGET', uiError.message, {
          hint: 'Re-list and rebind once, then observe. If observation itself is still STALE_TARGET, stop and report; do not loop or use coordinates.',
          ...(uiError.reason === undefined ? {} : { reason: uiError.reason }),
          cause: uiError,
        }),
      )
    }
    return uiErrorResult(toolName, uiError)
  }
}
