/**
 * `computerUseGate` (spec 00 §6.2): the `tools.preExecute` middleware for
 * every `ui_*` / `browser_*` / `desktop_*` call. It resolves the caller,
 * classifies the call into a concrete requirement, and either allows it
 * (covering grant, or persistent GUI auto-approval), refuses it, or shows a grant card
 * and waits — itself, never by returning `ask`, because `ApprovalService`
 * rejects every ask under the Shell full-access preset.
 *
 * The decision is stored as a ticket keyed by agent + call id (the context
 * object is copied for tools with a timeout); the tool body must present it
 * and the kernel re-validates it before anything reaches a driver. Any
 * error in the gate is a denial (fail closed).
 *
 * `planModeGuard` repeats the Plan-mode refusal synchronously in
 * `tools.guards` (defense in depth).
 */

import type { Session } from '../../session-log/session'
import type { Agent } from '../agent/agent'
import type {
  PreExecuteMiddleware,
  ToolCallInfo,
  ToolGuard,
  ToolResultObserver,
} from '../tools/registry'
import { asUiError, UiError, uiErrorLine } from './errors'
import type { GrantAskService } from './grants/ask'
import { grantCovers } from './grants/match'
import type { GrantStore } from './grants/store'
import type { UiCallerIdentity } from './identity'
import type { AskPlan, UiActionPolicy, UiRequirement } from './policy'
import type { HighImpactClassifier } from './risk'
import type { ComputerUseService, GateTicket } from './service/service'
import { GUI_TOOL_CATALOG, isGuiToolName } from './tools/catalog'
import type { UiGrant } from './types'

export interface GateDeps {
  readonly service: ComputerUseService
  readonly policy: UiActionPolicy
  readonly grants: GrantStore
  readonly ask: GrantAskService
  identity(agent: Agent | undefined): UiCallerIdentity
  /** Plan mode is on (or about to be) for the caller's root session. */
  planActive(agent: Agent): boolean
  rootSession(agent: Agent): Session
  readonly highImpact: HighImpactClassifier
  now(): Date
}

type Decision = Awaited<ReturnType<PreExecuteMiddleware>>

function deny(error: unknown): Decision {
  return {
    kind: 'deny',
    reason: uiErrorLine(asUiError(error, 'PERMISSION_DENIED')),
  }
}

const ALWAYS_ALLOWED_WHEN_STOPPED = new Set([
  'ui_get_capabilities',
  'ui_list_targets',
  'ui_action_status',
  'ui_release_control',
  'ui_cancel_action',
  'browser_tab_list',
  'browser_close',
])

function argsOf(call: ToolCallInfo): Record<string, unknown> {
  return typeof call.arguments === 'object' && call.arguments !== null
    ? (call.arguments as Record<string, unknown>)
    : {}
}

export function createComputerUseGate(deps: GateDeps): PreExecuteMiddleware {
  return async (call) => {
    if (!isGuiToolName(call.name)) return undefined
    const entry = GUI_TOOL_CATALOG[call.name]
    if (entry === undefined)
      return deny(
        new UiError('CAPABILITY_DISABLED', `unknown GUI tool ${call.name}`),
      )
    try {
      const identity = deps.identity(call.agent)
      const agent = call.agent!
      if (!entry.planSafe && deps.planActive(agent))
        throw new UiError(
          'PLAN_MODE_ACTION_DENIED',
          'plan mode is on; GUI actions are not allowed while planning',
        )
      if (deps.service.stopped && !ALWAYS_ALLOWED_WHEN_STOPPED.has(call.name))
        throw new UiError(
          'PERMISSION_DENIED',
          'computer use is stopped; the user must resume it',
          {
            reason: 'emergency-stop',
          },
        )
      if (entry.kind !== 'target' || entry.classify === undefined) {
        deps.service.issueTicket(agent.id, call.callId, { kind: 'control' })
        return { kind: 'allow' }
      }
      const { requirement, target } = entry.classify({
        args: argsOf(call),
        identity,
        service: deps.service,
        highImpact: deps.highImpact,
        callId: call.callId,
        toolName: call.name,
      })
      const verdict = deps.policy.evaluate(identity, requirement)
      const base = {
        requirement,
        actionClass: deps.policy.effectiveClass(requirement),
        ...(target === undefined
          ? {}
          : { targetId: target.targetId, generation: target.generation }),
      }
      const ticketFor = (grant: UiGrant): GateTicket => ({
        kind: 'grant',
        grantId: grant.grantId,
        grantRevision: grant.revision,
        ...base,
      })
      switch (verdict.kind) {
        case 'deny':
          throw verdict.error
        case 'allow':
          deps.service.issueTicket(
            agent.id,
            call.callId,
            verdict.via === 'grant'
              ? ticketFor(verdict.grant)
              : { kind: 'auto', ...base },
          )
          return { kind: 'allow' }
        case 'ask': {
          const grant = await requestGrant(deps, {
            identity,
            agent,
            requirement,
            plan: verdict.plan,
            callId: call.callId,
            toolName: call.name,
            signal: call.signal,
          })
          if (!grantCovers(grant, requirement, identity, deps.now()))
            throw new UiError(
              'PERMISSION_DENIED',
              'the granted scope does not cover this action',
              {
                reason: 'grant-mismatch',
              },
            )
          deps.service.issueTicket(agent.id, call.callId, ticketFor(grant))
          return { kind: 'allow' }
        }
      }
    } catch (error) {
      return deny(error)
    }
  }
}

export interface GrantRequestInput {
  readonly identity: UiCallerIdentity
  readonly agent: Agent
  readonly requirement: UiRequirement
  readonly plan: AskPlan
  readonly callId: string
  readonly toolName: string
  readonly signal: AbortSignal
}

/**
 * Show a grant card and issue the chosen grant. A refusal is remembered for
 * the rest of the task; any non-grant outcome throws `PERMISSION_DENIED`.
 */
export async function requestGrant(
  deps: Pick<GateDeps, 'ask' | 'grants' | 'policy' | 'rootSession' | 'now'>,
  input: GrantRequestInput,
): Promise<UiGrant> {
  const { identity, requirement, plan } = input
  const outcome = await deps.ask.request(
    {
      session: deps.rootSession(input.agent),
      subject: identity.subject,
      driver: requirement.driver,
      targetScope: plan.targetScope,
      actions: plan.actions,
      allowedScopes: plan.allowedScopes,
      callId: input.callId,
      toolName: input.toolName,
      ...(requirement.reason === undefined
        ? {}
        : { reason: requirement.reason }),
      ...(requirement.display === undefined
        ? {}
        : { display: requirement.display }),
      ...(requirement.highImpact === true ? { highImpact: true } : {}),
      ...(requirement.highRiskApp === true ? { highRiskApp: true } : {}),
      background: plan.background,
      signal: input.signal,
    },
    (answer) => {
      if (answer.decision === 'denied') throw new Error('denied')
      const now = deps.now()
      return deps.grants.issue({
        subject: identity.subject,
        ownerSessionId: identity.ownerSessionId,
        driver: requirement.driver,
        targetScope: plan.targetScope,
        allowedActions: plan.actions,
        scope: answer.decision,
        backgroundAllowed: answer.backgroundAllowed,
        ...(answer.decision === 'task' ? { taskId: identity.taskId } : {}),
        ...(answer.decision === 'once' ? { callId: input.callId } : {}),
        ...(answer.decision === 'timed'
          ? {
              expiresAt: new Date(
                now.getTime() + (answer.minutes ?? 15) * 60_000,
              ).toISOString(),
            }
          : {}),
      })
    },
  )
  if (outcome.grant === undefined) {
    if (outcome.cause === 'user')
      deps.policy.rememberDenial(identity, requirement)
    throw new UiError(
      'PERMISSION_DENIED',
      outcome.cause === 'user'
        ? 'the user refused this action'
        : `no decision was made (${outcome.cause})`,
      { reason: outcome.cause === 'user' ? 'user-denied' : outcome.cause },
    )
  }
  return outcome.grant
}

/** Synchronous Plan-mode refusal for mutating GUI tools (defense in depth). */
export function createPlanModeGuard(
  planActive: (agent: Agent) => boolean,
): ToolGuard {
  return (call) => {
    if (!isGuiToolName(call.name) || call.agent === undefined) return undefined
    const entry = GUI_TOOL_CATALOG[call.name]
    if (entry === undefined || entry.planSafe) return undefined
    if (!planActive(call.agent)) return undefined
    return uiErrorLine(
      new UiError(
        'PLAN_MODE_ACTION_DENIED',
        'plan mode is on; GUI actions are not allowed',
      ),
    )
  }
}

/** Drop any unused ticket once a GUI call has produced its result. */
export function createTicketCleanup(
  service: ComputerUseService,
): ToolResultObserver {
  return (call) => {
    if (call.agent !== undefined && isGuiToolName(call.name))
      service.dropTicket(call.agent.id, call.callId)
  }
}
