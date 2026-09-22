/**
 * One-shot sandbox escalation (ported from dsh-sandbox escalation.ts).
 *
 * A confined tool (bash, write, edit) exposes optional
 * `sandbox_permissions` + `justification`. When set, the requested mode must
 * be strictly wider than the call's effective mode; the user is asked once
 * through the approval service and only `allowed-once` runs the call wider.
 * The grant never outlives the call.
 */

import { z } from 'zod'
import type { Agent } from '../agent/agent'
import type { ApprovalService } from '../approval/service'
import { ESCALATION_TARGETS, WIDER_MODES, type SandboxMode } from './policy'

/** Zod fields a confined tool adds to its input schema. */
export const escalationFields = {
  sandbox_permissions: z
    .enum(ESCALATION_TARGETS as [SandboxMode, ...SandboxMode[]])
    .optional()
    .describe(
      'Request a wider sandbox mode for this one call (requires user approval). Use only after a sandbox denial.',
    ),
  justification: z
    .string()
    .optional()
    .describe(
      'One sentence telling the user why this call needs the wider mode. Required with sandbox_permissions.',
    ),
}

export interface EscalationRequest {
  requestedMode: string
  justification: string
  effectiveMode: SandboxMode
  /** e.g. "command" or "write" — used in messages. */
  subject: string
}

export async function approveEscalation(
  request: EscalationRequest,
  approval: {
    service: ApprovalService | undefined
    agent: Agent | undefined
    callId: string
    toolName: string
    signal?: AbortSignal
  },
): Promise<SandboxMode> {
  const { requestedMode: mode, effectiveMode, justification, subject } = request
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
    throw new Error(
      `sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`,
    )
  }
  if (approval.service === undefined)
    throw new Error(
      `sandbox escalation to "${mode}" requires approval, but no approval service is composed`,
    )
  if (approval.agent === undefined)
    throw new Error(
      `sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`,
    )
  const outcome = await approval.service.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    ...(approval.signal === undefined ? {} : { signal: approval.signal }),
  })
  switch (outcome) {
    case 'allowed-once':
      return mode as SandboxMode
    case 'rejected':
      throw new Error(
        `the user rejected escalating this ${subject} to "${mode}"`,
      )
    case 'cancelled':
      throw new Error(`approval for escalating to "${mode}" was cancelled`)
    case 'unavailable':
      throw new Error(
        `sandbox escalation to "${mode}" requires approval, but no approval channel is available`,
      )
  }
}
