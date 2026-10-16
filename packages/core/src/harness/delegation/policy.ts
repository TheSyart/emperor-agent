import type { SandboxExecutionPolicy } from '../sandbox/policy'
import type { DelegationOwner, DelegationStart } from './types'
import { DelegationError } from './types'
export interface DelegationParentContext {
  cwd: string
  policy: SandboxExecutionPolicy
  planMode?: boolean
}
export class DelegationPolicy {
  resolve(
    parent: DelegationParentContext,
    request: DelegationStart,
    owner: DelegationOwner,
    maxDepth: number,
  ): SandboxExecutionPolicy {
    if (owner.depth < 1 || owner.depth > maxDepth)
      throw new DelegationError(
        'DEPTH_LIMIT',
        'delegation nesting limit exceeded',
      )
    if (parent.planMode)
      throw new DelegationError(
        'PLAN_MODE_UNSUPPORTED',
        'external execution is unavailable in parent Plan mode',
      )
    if (
      parent.policy.mode === 'read-only' &&
      (request.workspace !== 'shared-readonly' || request.base === 'snapshot')
    )
      throw new DelegationError(
        'PERMISSION_DENIED',
        'readonly parent cannot authorize workspace or Git metadata writes',
      )
    if (request.workspace === 'shared-readonly' && request.base === 'snapshot')
      throw new DelegationError(
        'PERMISSION_DENIED',
        'readonly source cannot create a Git snapshot',
      )
    return {
      ...parent.policy,
      mode:
        request.workspace === 'shared-readonly'
          ? 'read-only'
          : parent.policy.mode,
      workspaceRoot: parent.cwd,
    }
  }
}
