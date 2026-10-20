/**
 * Shared plumbing for the fs tools: the factory-owned state, session cwd
 * resolution, sandbox policy/escalation, the in-process write fence, the
 * protected-path table (Emperor's private state and config files, the
 * user's credential files), and model-facing remediation of
 * guarded-mutation failures.
 */

import { homedir } from 'node:os'
import {
  canonicalPath,
  escalationHintMarker,
  isGitControlPath,
  sandboxDenialMarker,
  validateEscalationArgs,
  writableRoots,
  WIDER_MODES,
  type SandboxExecutionPolicy,
} from '../../../sandbox/policy'
import { approveEscalation } from '../../../sandbox/escalation'
import {
  classifyProtectedPath,
  homeDisplayPath,
  PROTECTED_CONFIG_REASON,
  PROTECTED_CREDENTIAL_READ_REASON,
  PROTECTED_CREDENTIAL_WRITE_REASON,
  PROTECTED_STATE_REASON,
  type ProtectedPathClass,
  type ProtectedPathScope,
} from '../../../sandbox/protected-state'
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
  const cwd = context.agent?.session.cwd
  if (cwd === undefined) return state.services.sandbox.workspaceRoot
  if (
    !PARENT_PATH_SEGMENT.test(cwd) &&
    !PARENT_PATH_SEGMENT.test(requestedPath)
  )
    return cwd
  return canonicalPath(cwd)
}

/**
 * The policy and target for one mutation: the session's standing policy,
 * or — when the call carries `sandbox_permissions` + `justification` — the
 * approved wider mode for this call only (approval asked before anything
 * executes). A protected path is refused first, before anyone is asked.
 */
export async function resolveMutationPolicy(
  state: FsToolState,
  toolName: 'write' | 'edit',
  args: FsEscalationArgs,
  context: ToolRunContext,
  filePath: string,
): Promise<{ policy: SandboxExecutionPolicy; resolved: FsTarget }> {
  validateEscalationArgs(args.sandbox_permissions, args.justification)
  const session = context.agent?.session
  const standing = state.services.sandbox.resolve(
    session === undefined ? {} : { session },
  )
  const resolved = await resolveTarget(standing.workspaceRoot, filePath)
  await refuseProtected(state, resolved, toolName)
  if (
    args.sandbox_permissions === undefined ||
    args.justification === undefined
  )
    return { policy: standing, resolved }
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
  const policy = state.services.sandbox.resolve({
    ...(session === undefined ? {} : { session }),
    mode,
  })
  if (policy.workspaceRoot === standing.workspaceRoot)
    return { policy, resolved }
  const wider = await resolveTarget(policy.workspaceRoot, filePath)
  await refuseProtected(state, wider, toolName)
  return { policy, resolved: wider }
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
  // Git config and hooks can make the user's own git run programs: changing
  // one is an escalation even inside the workspace.
  if (isGitControlPath(fresh.targetKey))
    throw sandboxDenied(policy, toolName, target)
  for (const root of writableRoots(policy)) {
    if (await isPathUnder(fresh.targetKey, root)) return fresh
  }
  throw sandboxDenied(policy, toolName, target)
}

function protectedScope(state: FsToolState): ProtectedPathScope | null {
  const stateRoot = state.services.protectedStateRoot
  if (stateRoot === undefined) return null
  return { stateRoot, home: state.services.protectedHome ?? homedir() }
}

const REFUSAL_REASONS: Record<ProtectedPathClass, string> = {
  state: PROTECTED_STATE_REASON,
  config: PROTECTED_CONFIG_REASON,
  credential: PROTECTED_CREDENTIAL_WRITE_REASON,
}

/**
 * Refuse the protected-path table (sandbox/protected-state.ts) for a write
 * or an edit, by real path, in every sandbox mode: Emperor's private state
 * and config files, and the user's credential files. No escalation is
 * offered; a wider mode would not change the answer.
 */
export async function refuseProtected(
  state: FsToolState,
  target: FsTarget,
  verb: 'write' | 'edit',
): Promise<void> {
  const scope = protectedScope(state)
  if (scope === null) return
  const found = await classifyProtectedPath(target.targetKey, scope)
  if (found !== null)
    throw new FsError(
      `cannot ${verb} "${target.displayPath}": ${REFUSAL_REASONS[found]}`,
      'FS_PROTECTED_PATH',
    )
}

/**
 * `read` of a protected path: Emperor's private state and config files are
 * refused in every mode; a credential file is read under danger-full-access
 * only, a standing one or one escalation the user approves for this call,
 * whose prompt names the file.
 */
export async function authorizeRead(
  state: FsToolState,
  target: FsTarget,
  args: FsEscalationArgs,
  context: ToolRunContext,
): Promise<void> {
  validateEscalationArgs(args.sandbox_permissions, args.justification)
  const scope = protectedScope(state)
  if (scope === null) return
  const found = await classifyProtectedPath(target.targetKey, scope)
  if (found === null) return
  if (found !== 'credential')
    throw new FsError(
      `cannot read "${target.displayPath}": ${REFUSAL_REASONS[found]}`,
      'FS_PROTECTED_PATH',
    )
  const session = context.agent?.session
  const standing = state.services.sandbox.resolve(
    session === undefined ? {} : { session },
  )
  if (standing.mode === 'danger-full-access') return
  if (
    args.sandbox_permissions === undefined ||
    args.justification === undefined
  )
    throw new FsError(
      `${sandboxDenialMarker(standing.mode)}\ncannot read "${target.displayPath}": ${PROTECTED_CREDENTIAL_READ_REASON}`,
      'FS_SANDBOX_DENIED',
    )
  if (args.sandbox_permissions !== 'danger-full-access')
    throw new FsError(
      `cannot read "${target.displayPath}": reading credentials needs sandbox_permissions="danger-full-access"`,
      'FS_SANDBOX_DENIED',
    )
  const shown = homeDisplayPath(target.displayPath, scope.home)
  await approveEscalation(
    {
      requestedMode: args.sandbox_permissions,
      justification: args.justification,
      effectiveMode: standing.mode,
      subject: 'read',
      reads:
        shown === target.displayPath
          ? homeDisplayPath(target.targetKey, scope.home)
          : shown,
    },
    {
      service: state.services.approval,
      agent: context.agent,
      callId: context.callId,
      toolName: 'read',
      signal: context.signal,
    },
  )
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
