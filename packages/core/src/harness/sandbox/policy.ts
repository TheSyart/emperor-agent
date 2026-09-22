/**
 * Sandbox policy (ported from dsh-sandbox + dsh-sandbox-policy).
 *
 * Three file-effect modes:
 * - `read-only`: confined operations cannot modify files.
 * - `workspace-write`: writes allowed under the session workspace (and temp).
 * - `danger-full-access`: no file-effect confinement.
 *
 * The session log is the store: the last `sandbox/mode` event is the
 * session override, else the host default. A tool call may carry an
 * approved one-shot escalation that outranks both.
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { HarnessError } from '../../llm/error'
import type { Session } from '../../session-log/session'
import type { SessionEvent } from '../../session-log/types'
import type { SystemPromptAssembler } from '../prompt/assembler'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>

export const SANDBOX_MODES: readonly SandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

declare module '../../session-log/types' {
  interface SessionEventMap {
    /** The session's sandbox mode was switched (log-only; last one wins). */
    'sandbox/mode': { mode: SandboxMode; source?: 'delegation' }
  }
}

export interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string
  sessionId?: string
}

export interface SandboxPolicy extends SandboxExecutionPolicy {
  mode: ConfinedSandboxMode
}

/** Modes strictly wider than each confined mode (escalation targets). */
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

export const ESCALATION_TARGETS: readonly SandboxMode[] = [
  'workspace-write',
  'danger-full-access',
]

export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

export class SandboxUnavailableError extends HarnessError {
  constructor(mode: ConfinedSandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; ` +
        'refusing to run the command unconfined. Install bubblewrap (Linux) or ensure sandbox-exec is usable (macOS); ' +
        'on other platforms switch the session to danger-full-access.' +
        (detail === undefined ? '' : ` Runner failure: ${detail}`),
      SANDBOX_UNAVAILABLE,
    )
    this.name = 'SandboxUnavailableError'
  }
}

/** Resolve symlinks (best effort) so containment checks compare real paths. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Writable roots for one policy (workspace + temp under workspace-write; none otherwise). */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [
    ...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath)),
  ]
}

export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/** Validate the paired escalation arguments of one call. */
export function validateEscalationArgs(
  sandboxPermissions: string | undefined,
  justification: string | undefined,
): void {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error(
      'invalid escalation: sandbox_permissions requires a justification',
    )
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error(
      'invalid escalation: justification is only valid together with sandbox_permissions',
    )
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
}

/** The session override: the last `sandbox/mode` event, if any. */
export function effectiveSandboxMode(
  events: readonly SessionEvent[],
): SandboxMode | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'sandbox/mode') return event.data.mode
  }
  return undefined
}

function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current file policy: read-only. Sandboxed operations cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write':
      return `Current file policy: workspace-write. Sandboxed operations may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
    case 'danger-full-access':
      return 'Current file policy: danger-full-access. The file sandbox does not restrict file modifications.'
  }
}

export interface SandboxPolicyOptions {
  defaultMode: SandboxMode
  /** Fallback root for sessions without a cwd. */
  workspaceRoot?: string
}

export class SandboxPolicyService {
  readonly defaultMode: SandboxMode
  readonly workspaceRoot: string

  constructor(options: SandboxPolicyOptions) {
    this.defaultMode = options.defaultMode
    this.workspaceRoot = resolvePath(
      canonicalPath(options.workspaceRoot ?? process.cwd()),
    )
  }

  /** Contribute the `sandbox:policy` runtime context (order 110). */
  install(prompt: SystemPromptAssembler): () => void {
    return prompt.context({
      name: 'sandbox:policy',
      order: 110,
      text: ({ agent }) =>
        agent === undefined
          ? ''
          : renderPolicyContext(this.resolve({ session: agent.session })),
    })
  }

  /** Approved escalation > session override > host default; root = session cwd. */
  resolve(
    request: { session?: Session; mode?: SandboxMode } = {},
  ): SandboxExecutionPolicy {
    const { session } = request
    return {
      mode:
        request.mode ??
        (session === undefined ? undefined : this.overrideOf(session)) ??
        this.defaultMode,
      workspaceRoot: resolvePath(
        canonicalPath(session?.header.cwd ?? this.workspaceRoot),
      ),
      ...(session === undefined ? {} : { sessionId: session.id }),
    }
  }

  overrideOf(session: Session): SandboxMode | undefined {
    return effectiveSandboxMode(session.events)
  }

  /** Record a switch; takes effect on the session's next confined call. */
  set(session: Session, mode: SandboxMode, source?: 'delegation'): void {
    if (!SANDBOX_MODES.includes(mode))
      throw new TypeError(`unknown sandbox mode "${mode}"`)
    session.append('sandbox/mode', {
      mode,
      ...(source === undefined ? {} : { source }),
    })
  }
}
