/**
 * `UiActionPolicy` (spec 00 §6.3): decides, for one GUI action, whether an
 * existing grant covers it, whether the persistent Computer Use setting
 * auto-approves it, whether to show a grant card, or refuse.
 *
 * Order (the first rule that applies wins):
 * 1. protected target → `TARGET_FORBIDDEN`, whatever the preset;
 * 2. grants suspended (emergency stop, corrupt store) → `PERMISSION_DENIED`;
 * 3. the user already refused the same thing in this task → deny (no
 *    retrying around a refusal);
 * 4. a covering grant → allow;
 * 5. full GUI access + ordinary action (including transfer and terminal
 *    input), except high-impact or credential confirmation → auto-allow;
 * 6. the caller cannot ask (subagent) → `PERMISSION_REQUIRED`;
 * 7. otherwise → ask, with scopes limited by the action's risk.
 */

import type { UiCallerIdentity } from './identity'
import { UiError } from './errors'
import type { GrantStore } from './grants/store'
import {
  findCoveringGrant,
  normalizeOrigin,
  type GrantRequirement,
} from './grants/match'
import type {
  GrantDisplayInput,
  UiActionClass,
  UiGrant,
  UiGrantScope,
  UiTargetScope,
} from './types'

/** The unrestricted GUI mode covers these classes. */
export const AUTO_APPROVED_CLASSES: readonly UiActionClass[] = [
  'observe',
  'interact',
  'navigate',
  'transfer',
]

export interface UiRequirement extends GrantRequirement {
  /** Classes to request on the card (default: the action's class + observe). */
  readonly askActions?: readonly UiActionClass[]
  /** Set when the target is on the protection list (§6.5). */
  readonly protectedReason?: string
  /** What the card shows. */
  readonly display?: {
    url?: string
    title?: string
    appName?: string
    /** The page embedding the cross-origin frame the action targets. */
    embeddedIn?: string
    /**
     * The keyboard input a desktop action sends. A per-input confirmation
     * (§6.5) is only informed when the card shows exactly what is sent.
     */
    input?: GrantDisplayInput
  }
  /**
   * The action targets an element inside a cross-origin frame; `origin` is
   * that frame's origin and is kept when the ticket is rechecked.
   */
  readonly inFrame?: boolean
  readonly toolName?: string
  /** Agent-supplied reason, shown as unverified. */
  readonly reason?: string
  /**
   * Always ask for this call, whatever broader grants or mode exist.
   * All credential fills use this even for legacy entries marked "auto".
   */
  readonly confirmEachTime?: boolean
}

export interface AskPlan {
  readonly targetScope: UiTargetScope
  readonly actions: readonly UiActionClass[]
  readonly allowedScopes: readonly UiGrantScope[]
  readonly background: boolean
}

export type PolicyVerdict =
  | { readonly kind: 'allow'; readonly via: 'grant'; readonly grant: UiGrant }
  | {
      readonly kind: 'allow'
      readonly via: 'auto'
      readonly actionClass: UiActionClass
    }
  | { readonly kind: 'ask'; readonly plan: AskPlan }
  | { readonly kind: 'deny'; readonly error: UiError }

export interface UiActionPolicyOptions {
  readonly grants: GrantStore
  readonly now?: () => Date
}

const DENIAL_MEMO_LIMIT = 500

export class UiActionPolicy {
  private readonly grants: GrantStore
  private readonly now: () => Date
  /** `taskId|driver|target|class` → refused by the user in that task. */
  private readonly denials = new Map<string, true>()

  constructor(options: UiActionPolicyOptions) {
    this.grants = options.grants
    this.now = options.now ?? (() => new Date())
  }

  /** The class the action is judged as (high-impact escalates). */
  effectiveClass(requirement: GrantRequirement): UiActionClass {
    return requirement.highImpact === true
      ? 'high-impact'
      : requirement.actionClass
  }

  evaluate(
    identity: UiCallerIdentity,
    requirement: UiRequirement,
  ): PolicyVerdict {
    if (requirement.protectedReason !== undefined)
      return deny(
        new UiError(
          'TARGET_FORBIDDEN',
          'this target is protected and cannot be controlled by the agent',
          { reason: requirement.protectedReason },
        ),
      )
    const suspended = this.grants.suspended
    if (suspended !== null)
      return deny(
        new UiError(
          'PERMISSION_DENIED',
          suspended.by === 'kill-switch'
            ? 'computer use is stopped; the user must resume it'
            : 'the grant store was unreadable; the user must review grants',
          {
            reason:
              suspended.by === 'kill-switch'
                ? 'emergency-stop'
                : 'grant-store-corrupt',
          },
        ),
      )

    const actionClass = this.effectiveClass(requirement)
    const confirmEachTime =
      requirement.confirmEachTime === true || actionClass === 'high-impact'
    if (this.denials.has(this.denialKey(identity, requirement)))
      return deny(
        new UiError(
          'PERMISSION_DENIED',
          'the user refused this action earlier in this task',
          { reason: 'denied-earlier' },
        ),
      )

    const grant = findCoveringGrant(
      this.grants.list(),
      requirement,
      identity,
      this.now(),
    )
    if (
      grant !== undefined &&
      (!confirmEachTime || grant.callId === requirement.callId)
    )
      return { kind: 'allow', via: 'grant', grant }

    if (
      !confirmEachTime &&
      identity.fullAccess &&
      AUTO_APPROVED_CLASSES.includes(actionClass)
    )
      return { kind: 'allow', via: 'auto', actionClass }

    if (!identity.canAsk)
      return deny(
        new UiError(
          'PERMISSION_REQUIRED',
          'a subagent cannot ask the user for GUI access',
          {
            reason: 'subagent-cannot-ask',
            hint: 'Report back to the parent task, which can request access.',
          },
        ),
      )

    const plan = this.askPlan(identity, requirement)
    if (plan === null)
      return deny(
        new UiError('INVALID_REQUEST', 'the target has no grantable identity', {
          reason: 'no-target-scope',
        }),
      )
    return { kind: 'ask', plan }
  }

  /** Record a user refusal so the task cannot route around it. */
  rememberDenial(identity: UiCallerIdentity, requirement: UiRequirement): void {
    if (this.denials.size >= DENIAL_MEMO_LIMIT) {
      const oldest = this.denials.keys().next().value
      if (oldest !== undefined) this.denials.delete(oldest)
    }
    this.denials.set(this.denialKey(identity, requirement), true)
  }

  private denialKey(
    identity: UiCallerIdentity,
    requirement: UiRequirement,
  ): string {
    const target =
      requirement.origin === undefined
        ? (requirement.appId ?? '')
        : (normalizeOrigin(requirement.origin) ?? requirement.origin)
    // A refused confirm-each-time card (a credential fill) blocks that kind
    // of call only, not every ordinary action on the site.
    const kind =
      requirement.confirmEachTime === true
        ? `${this.effectiveClass(requirement)}:${requirement.toolName ?? 'confirm'}`
        : this.effectiveClass(requirement)
    return [identity.taskId, requirement.driver, target, kind].join('|')
  }

  private askPlan(
    identity: UiCallerIdentity,
    requirement: UiRequirement,
  ): AskPlan | null {
    const actionClass = this.effectiveClass(requirement)
    let targetScope: UiTargetScope
    if (requirement.driver === 'desktop') {
      if (requirement.appId === undefined) return null
      targetScope = {
        kind: 'desktop',
        appId: requirement.appId,
        ...(requirement.windowRef === undefined
          ? {}
          : { windowRef: requirement.windowRef }),
      }
    } else {
      const origin =
        requirement.origin === undefined
          ? null
          : normalizeOrigin(requirement.origin)
      if (origin === null || requirement.profileId === undefined) return null
      targetScope = {
        kind: 'browser',
        profileId: requirement.profileId,
        origins: [origin],
      }
    }
    const risky =
      actionClass === 'transfer' ||
      actionClass === 'high-impact' ||
      requirement.confirmEachTime === true
    const actions: UiActionClass[] = risky
      ? [actionClass]
      : [
          ...new Set([
            ...(requirement.askActions ?? []),
            actionClass,
            'observe' as const,
          ]),
        ].filter((action) => action !== 'transfer' && action !== 'high-impact')
    const allowedScopes: UiGrantScope[] = risky
      ? ['once']
      : requirement.highRiskApp === true
        ? ['once', 'task']
        : ['once', 'task', 'session', 'timed']
    return {
      targetScope,
      actions,
      allowedScopes,
      background: identity.background,
    }
  }
}

function deny(error: UiError): PolicyVerdict {
  return { kind: 'deny', error }
}
