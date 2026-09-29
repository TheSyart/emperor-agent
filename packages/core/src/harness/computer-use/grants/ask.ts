/**
 * Grant cards (spec 00 §6.2): the Computer Use gate asks the user itself
 * instead of returning `ask` to the tool registry, because `ApprovalService`
 * rejects every ask under the Shell full-access preset's `never` policy.
 *
 * Every request is audited on the root session log as a
 * `ui/grant-requested` + `ui/grant-decided` pair. Fail closed: no answerer,
 * an abort, a session stop, a malformed answer or a crash all decide
 * `denied`.
 */

import { randomUUID } from 'node:crypto'
import type { Session } from '../../../session-log/session'
import type { GrantDecision, GrantDecisionCause } from '../events'
import type {
  DriverKind,
  GrantDisplayInput,
  UiActionClass,
  UiGrant,
  UiGrantScope,
  UiTargetScope,
} from '../types'
import type { GrantAnswer } from './answer'

export interface GrantAskRequest {
  /** Root session: where the card is shown and the request is logged. */
  readonly session: Session
  readonly subject: string
  readonly driver: DriverKind
  readonly targetScope: UiTargetScope
  readonly actions: readonly UiActionClass[]
  readonly allowedScopes: readonly UiGrantScope[]
  readonly callId?: string
  readonly toolName?: string
  /** Agent-supplied, shown as unverified. */
  readonly reason?: string
  readonly display?: {
    url?: string
    title?: string
    appName?: string
    embeddedIn?: string
    input?: GrantDisplayInput
  }
  readonly highImpact?: boolean
  readonly highRiskApp?: boolean
  /** Offer the "allow in background" checkbox. */
  readonly background?: boolean
  readonly signal?: AbortSignal
}

/** Host-side answerer (the UI through `PendingInteractions`). */
export type GrantAnswerer = (
  request: GrantAskRequest & { readonly id: string },
) => Promise<GrantAnswer>

export interface GrantAskOutcome {
  readonly requestId: string
  readonly decision: GrantDecision
  readonly cause: GrantDecisionCause
  readonly grant?: UiGrant
}

/** Turns an accepted answer into a stored grant. */
export type GrantIssuer = (answer: GrantAnswer) => UiGrant

export class GrantAskService {
  private answerer: GrantAnswerer | undefined

  setAnswerer(answerer: GrantAnswerer | undefined): void {
    this.answerer = answerer
  }

  get available(): boolean {
    return this.answerer !== undefined
  }

  async request(
    request: GrantAskRequest,
    issue: GrantIssuer,
  ): Promise<GrantAskOutcome> {
    const id = `g${randomUUID().replaceAll('-', '').slice(0, 20)}`
    request.session.append('ui/grant-requested', {
      requestId: id,
      subject: request.subject,
      driver: request.driver,
      targetScope: request.targetScope,
      actions: [...request.actions],
      allowedScopes: [...request.allowedScopes],
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.toolName === undefined ? {} : { toolName: request.toolName }),
      ...(request.display === undefined ? {} : { display: request.display }),
      ...(request.highImpact === true ? { highImpact: true } : {}),
      ...(request.highRiskApp === true ? { highRiskApp: true } : {}),
      ...(request.background === true ? { background: true } : {}),
    })

    // Read live: the signal may abort while the card is waiting.
    const aborted = (): boolean => request.signal?.aborted === true
    let answer: GrantAnswer
    let cause: GrantDecisionCause = 'user'
    const answerer = this.answerer
    if (answerer === undefined) {
      answer = { decision: 'denied', backgroundAllowed: false }
      cause = 'unavailable'
    } else if (aborted()) {
      answer = { decision: 'denied', backgroundAllowed: false }
      cause = 'cancelled'
    } else {
      try {
        answer = await answerer({ ...request, id })
        if (answer.cancelled === true) cause = 'cancelled'
        else if (answer.invalid !== undefined) cause = 'invalid'
      } catch {
        answer = { decision: 'denied', backgroundAllowed: false }
        cause = aborted() ? 'cancelled' : 'unavailable'
      }
    }
    if (aborted() && answer.decision !== 'denied') {
      answer = { decision: 'denied', backgroundAllowed: false }
      cause = 'cancelled'
    }

    let grant: UiGrant | undefined
    if (answer.decision !== 'denied') {
      try {
        grant = issue(answer)
      } catch {
        answer = { decision: 'denied', backgroundAllowed: false }
        cause = 'invalid'
      }
    }
    request.session.append('ui/grant-decided', {
      requestId: id,
      decision: answer.decision,
      cause,
      ...(grant === undefined ? {} : { grantId: grant.grantId }),
      ...(grant?.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
      ...(grant === undefined || answer.minutes === undefined
        ? {}
        : { minutes: answer.minutes }),
      ...(grant === undefined
        ? {}
        : { backgroundAllowed: grant.backgroundAllowed }),
    })
    return {
      requestId: id,
      decision: answer.decision,
      cause,
      ...(grant === undefined ? {} : { grant }),
    }
  }
}
