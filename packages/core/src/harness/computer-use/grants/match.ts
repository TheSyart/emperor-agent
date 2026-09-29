/**
 * Whether an existing grant covers one GUI action (spec 00 §6.1, §6.3).
 * A grant binds subject, driver, target identity, action class and time all
 * at once; any mismatch means "not covered", and the gate then asks or
 * denies. Matching never widens: origins compare exactly, a `once` grant
 * covers only its own call, and transfer / high-impact actions are only ever
 * covered by a `once` grant.
 */

import type { UiCallerIdentity } from '../identity'
import type { DriverKind, UiActionClass, UiGrant } from '../types'

export interface GrantRequirement {
  readonly driver: DriverKind
  readonly actionClass: UiActionClass
  /** Browser targets: profile and exact origin the action touches. */
  readonly profileId?: string
  readonly origin?: string
  /** Desktop targets: app identity and optional window. */
  readonly appId?: string
  readonly windowRef?: string
  readonly callId: string
  /** Escalated by the high-impact classifier (payments, deletion, sending…). */
  readonly highImpact?: boolean
  /** Terminal / script host (desktop): only once or task grants apply. */
  readonly highRiskApp?: boolean
}

type Caller = Pick<
  UiCallerIdentity,
  'subject' | 'ownerSessionId' | 'taskId' | 'background'
>

/** Normalize an origin string for exact comparison. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

function requiresOnce(requirement: GrantRequirement): boolean {
  return (
    requirement.actionClass === 'transfer' ||
    requirement.actionClass === 'high-impact' ||
    requirement.highImpact === true
  )
}

export function grantCovers(
  grant: UiGrant,
  requirement: GrantRequirement,
  caller: Caller,
  now: Date,
): boolean {
  if (grant.subject !== caller.subject) return false
  if (grant.driver !== requirement.driver) return false
  if (
    grant.expiresAt !== undefined &&
    Date.parse(grant.expiresAt) <= now.getTime()
  )
    return false
  const actionClass =
    requirement.highImpact === true ? 'high-impact' : requirement.actionClass
  if (!grant.allowedActions.includes(actionClass)) return false
  if (caller.background && !grant.backgroundAllowed) return false

  switch (grant.scope) {
    case 'once':
      if (grant.callId !== requirement.callId) return false
      break
    case 'task':
      if (grant.taskId !== caller.taskId) return false
      break
    case 'session':
    case 'timed':
      if (
        grant.ownerSessionId !== undefined &&
        grant.ownerSessionId !== caller.ownerSessionId
      )
        return false
      break
  }
  if (requiresOnce(requirement) && grant.scope !== 'once') return false
  if (
    requirement.highRiskApp === true &&
    grant.scope !== 'once' &&
    grant.scope !== 'task'
  )
    return false

  const scope = grant.targetScope
  if (scope.kind === 'browser') {
    if (requirement.origin === undefined || requirement.profileId === undefined)
      return false
    if (scope.profileId !== requirement.profileId) return false
    const origin = normalizeOrigin(requirement.origin)
    if (origin === null) return false
    return scope.origins.some((allowed) => normalizeOrigin(allowed) === origin)
  }
  if (requirement.appId === undefined || scope.appId !== requirement.appId)
    return false
  return (
    scope.windowRef === undefined || scope.windowRef === requirement.windowRef
  )
}

/** The first grant covering the requirement, preferring the narrowest scope. */
export function findCoveringGrant(
  grants: readonly UiGrant[],
  requirement: GrantRequirement,
  caller: Caller,
  now: Date,
): UiGrant | undefined {
  const order: Record<UiGrant['scope'], number> = {
    once: 0,
    task: 1,
    session: 2,
    timed: 3,
  }
  return [...grants]
    .filter((grant) => grantCovers(grant, requirement, caller, now))
    .sort((left, right) => order[left.scope] - order[right.scope])[0]
}
