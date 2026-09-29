/**
 * Caller identity for Computer Use (spec 00 §6.8). Every GUI tool call is
 * attributed to an unforgeable subject derived from the calling agent — never
 * from tool arguments:
 *
 * - root session agent → `session:<rootId>`
 * - subagent / workflow child → `subagent:<agentId>` (cannot ask the user)
 * - scheduler turn → `scheduler:<jobId>` (background)
 * - goal round → `session:<rootId>` (background)
 *
 * GUI full access follows the persisted Computer Use setting. It is independent
 * of the Shell sandbox and applies to child agents too; sensitive actions
 * still require a fresh per-action confirmation.
 */

import type { Agent } from '../agent/agent'
import { currentTurnInfo } from '../host/turn-source'
import { UiError } from './errors'

export type UiSubjectKind = 'session' | 'subagent' | 'scheduler'

export interface UiCallerIdentity {
  readonly subject: string
  readonly kind: UiSubjectKind
  /** Root session that owns targets, leases and grant cards. */
  readonly ownerSessionId: string
  /** The calling agent's own session (journals `ui/action-*`). */
  readonly callerSessionId: string
  /** One user request's worth of work: `<rootId>:<turn>`. */
  readonly taskId: string
  readonly turn?: number
  /** Scheduler and goal rounds run without the user watching. */
  readonly background: boolean
  /** Whether a grant card may be shown for this caller. */
  readonly canAsk: boolean
  readonly fullAccess: boolean
}

export interface IdentityDeps {
  rootOf(agent: Agent): Agent
  authorizationMode(): 'unrestricted' | 'scoped'
}

export function resolveIdentity(
  agent: Agent | undefined,
  deps: IdentityDeps,
): UiCallerIdentity {
  if (agent === undefined)
    throw new UiError(
      'PERMISSION_DENIED',
      'GUI tools need a calling agent; host-initiated calls are refused',
      { reason: 'no-agent' },
    )
  const root = deps.rootOf(agent)
  const turn = currentTurnInfo(root.session.events)
  const turnKey = turn.turn === undefined ? '0' : String(turn.turn)
  const fullAccess = deps.authorizationMode() === 'unrestricted'
  const base = {
    ownerSessionId: root.id,
    callerSessionId: agent.id,
    taskId: `${root.id}:${turnKey}`,
    ...(turn.turn === undefined ? {} : { turn: turn.turn }),
    fullAccess,
  }
  if (agent.owner !== undefined)
    return {
      ...base,
      subject: `subagent:${agent.id}`,
      kind: 'subagent',
      background: true,
      canAsk: false,
    }
  if (turn.source === 'scheduler')
    return {
      ...base,
      subject: `scheduler:${turn.schedulerJobId ?? root.id}`,
      kind: 'scheduler',
      background: true,
      canAsk: true,
    }
  return {
    ...base,
    subject: `session:${root.id}`,
    kind: 'session',
    background: turn.goalRound,
    canAsk: true,
  }
}
