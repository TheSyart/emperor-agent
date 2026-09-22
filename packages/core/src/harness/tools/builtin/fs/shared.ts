/**
 * Shared plumbing for the fs tools: the factory-owned state, session cwd
 * resolution, sandbox policy/escalation, the in-process write fence, and
 * model-facing remediation of guarded-mutation failures.
 */

import {
  canonicalPath,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
  writableRoots,
  WIDER_MODES,
  type SandboxExecutionPolicy,
} from '../../../sandbox/policy'
import { approveEscalation } from '../../../sandbox/escalation'
import type { ToolRunContext } from '../../definition'
import type { ToolServices } from '../../services'
import {
  FsError,
  isPathUnder,
  resolveTarget,
  type FsTarget,
  TargetLocks,
} from './fsio'
import type { FsObservations } from './observations'

/** State shared by the three tools of one {@link createFsTools} call. */
export interface FsToolState {
  readonly services: ToolServices
  readonly observations: FsObservations
  readonly locks: TargetLocks
}

export interface FsEscalationArgs {
  sandbox_permissions?: string | undefined
  justification?: string | undefined
}

const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

/** The calling session's id (observation owner), if any. */
export function sessionIdOf(context: ToolRunContext): string | undefined {
  return context.agent?.session.id
}

/**
 * The directory a relative path resolves against: the session cwd
 * (canonicalized when parent traversal makes symlink identity observable),
 * else the sandbox service's fallback workspace root.
 */
export function sessionCwd(
  state: FsToolState,
  context: ToolRunContext,
  requestedPath: string,
): string {
  const cwd = context.agent?.session.header.cwd
  if (cwd === undefined) return state.services.sandbox.workspaceRoot
  if (
    !PARENT_PATH_SEGMENT.test(cwd) &&
    !PARENT_PATH_SEGMENT.test(requestedPath)
  )
    return cwd
  return canonicalPath(cwd)
}

/**
 * The policy for one mutation: the session's standing policy, or — when the
 * call carries `sandbox_permissions` + `justification` — the approved wider
 * mode for this call only (approval asked before anything executes).
 */
export async function resolveMutationPolicy(
  state: FsToolState,
  toolName: 'write' | 'edit',
  args: FsEscalationArgs,
  context: ToolRunContext,
): Promise<SandboxExecutionPolicy> {
  validateEscalationArgs(args.sandbox_permissions, args.justification)
  const session = context.agent?.session
  const standing = state.services.sandbox.resolve(
    session === undefined ? {} : { session },
  )
  if (
    args.sandbox_permissions === undefined ||
    args.justification === undefined
  )
    return standing
  const mode = await approveEscalation(
    {
      requestedMode: args.sandbox_permissions,
      justification: args.justification,
      effectiveMode: standing.mode,
      subject: toolName,
    },
    {
      service: state.services.approval,
      agent: context.agent,
      callId: context.callId,
      toolName,
      signal: context.signal,
    },
  )
  return state.services.sandbox.resolve({
    ...(session === undefined ? {} : { session }),
    mode,
  })
}

function sandboxDenied(
  policy: SandboxExecutionPolicy,
  toolName: 'write' | 'edit',
  target: FsTarget,
): FsError {
  const hint =
    (WIDER_MODES[policy.mode] ?? []).length > 0
      ? `\n${escalationHintMarker(toolName)}`
      : ''
  const cause = new Error(
    `cannot write "${target.displayPath}": file access denied under ${policy.mode} mode`,
  )
  return new FsError(
    `${sandboxDenialMarker(policy.mode)}${hint}`,
    'FS_SANDBOX_DENIED',
    { cause },
  )
}

/**
 * Enforce the per-call policy on `target` and return the exact target the
 * mutation must use: `read-only` denies; `workspace-write` re-canonicalizes
 * now (a swapped symlink ancestor is seen) and requires containment under a
 * writable root; `danger-full-access` is unfenced.
 */
export async function fenceTarget(
  target: FsTarget,
  policy: SandboxExecutionPolicy,
  toolName: 'write' | 'edit',
): Promise<FsTarget> {
  if (policy.mode === 'danger-full-access') return target
  if (policy.mode === 'read-only') throw sandboxDenied(policy, toolName, target)
  const fresh = await resolveTarget(policy.workspaceRoot, target.displayPath)
  for (const root of writableRoots(policy)) {
    if (await isPathUnder(fresh.targetKey, root)) return fresh
  }
  throw sandboxDenied(policy, toolName, target)
}

const REMEDIES: Partial<Record<string, string>> = {
  FS_STALE_VERSION: 're-read the file, then retry',
  FS_NOT_OBSERVED: 'read the file, then retry',
}

/** Append the only correct recovery to stale/not-observed failures (code preserved). */
export function remediate(error: unknown): unknown {
  if (!(error instanceof FsError)) return error
  const remedy = REMEDIES[error.fsCode]
  if (remedy === undefined) return error
  return new FsError(`${error.message} — ${remedy}`, error.fsCode, {
    cause: error,
  })
}
