/**
 * Permission presets (ported from dsh-permission-presets): one user-facing
 * selector bundling the sandbox mode with the approval policy.
 *
 * `set()` logs the chosen `permission/preset` first, then only the knob
 * events whose value actually changes; `current()` prefers a logged choice
 * that still matches the knobs, else the first matching table entry, else
 * `custom` (shown, never selectable).
 */

import type { Session } from '../../session-log/session'
import type { SessionEvent } from '../../session-log/types'
import type { Agent } from '../agent/agent'
import type { SandboxMode, SandboxPolicyService } from '../sandbox/policy'
import type { ApprovalPolicy, ApprovalService } from './service'

declare module '../../session-log/types' {
  interface SessionEventMap {
    'permission/preset': { preset: string }
  }
}

export interface PresetSpec {
  sandbox: SandboxMode
  approval: ApprovalPolicy
  name: string
  description: string
}

export const CUSTOM_PRESET = 'custom'

export const DEFAULT_PRESETS: Readonly<Record<string, PresetSpec>> =
  Object.freeze({
    'read-only': {
      sandbox: 'read-only',
      approval: 'ask',
      name: '只读',
      description:
        'Read anything; every modification needs an approved escalation.',
    },
    'workspace-write': {
      sandbox: 'workspace-write',
      approval: 'ask',
      name: '工作区可写',
      description:
        'Write inside the workspace and temporary directories; wider retries require approval.',
    },
    'danger-full-access': {
      sandbox: 'danger-full-access',
      approval: 'never',
      name: '完全访问',
      description: 'Full file access without approval prompts.',
    },
  })

export interface KnobState {
  preset: string | null
  sandbox: SandboxMode | null
  approval: ApprovalPolicy | null
}

const EMPTY_KNOBS: KnobState = { preset: null, sandbox: null, approval: null }

export function applyKnobEvent(
  state: KnobState,
  event: SessionEvent,
): KnobState {
  switch (event.type) {
    case 'permission/preset':
      return { ...state, preset: event.data.preset }
    case 'sandbox/mode':
      return { ...state, sandbox: event.data.mode }
    case 'approval/policy':
      return { ...state, approval: event.data.policy }
    default:
      return state
  }
}

export function foldKnobs(events: readonly SessionEvent[]): KnobState {
  let state = EMPTY_KNOBS
  for (const event of events) state = applyKnobEvent(state, event)
  return state
}

export interface PresetOption {
  value: string
  name: string
  description?: string
}

export class PermissionPresetService {
  constructor(
    private readonly sandbox: SandboxPolicyService,
    private readonly approval: ApprovalService,
    private readonly presets: Readonly<
      Record<string, PresetSpec>
    > = DEFAULT_PRESETS,
    private readonly approvalDefault: ApprovalPolicy = 'ask',
  ) {
    if (CUSTOM_PRESET in presets)
      throw new Error(`"${CUSTOM_PRESET}" is reserved and cannot name a preset`)
  }

  get names(): readonly string[] {
    return Object.keys(this.presets)
  }

  options(): PresetOption[] {
    return this.names.map((value) => ({
      value,
      name: this.presets[value]!.name,
      description: this.presets[value]!.description,
    }))
  }

  spec(name: string): PresetSpec {
    const spec = this.presets[name]
    if (spec === undefined)
      throw new Error(
        `unknown permission preset "${name}" (available: ${this.names.join(', ')})`,
      )
    return spec
  }

  /** The preset the host defaults (derived from the default knobs). */
  defaultPreset(): string {
    return this.derive(EMPTY_KNOBS)
  }

  current(events: readonly SessionEvent[]): string {
    return this.derive(foldKnobs(events))
  }

  private derive(state: KnobState): string {
    const sandbox = state.sandbox ?? this.sandbox.defaultMode
    const approval = state.approval ?? this.approvalDefault
    const matches = (spec: PresetSpec): boolean =>
      spec.sandbox === sandbox && spec.approval === approval
    if (state.preset !== null) {
      const spec = this.presets[state.preset]
      if (spec !== undefined && matches(spec)) return state.preset
    }
    for (const [name, spec] of Object.entries(this.presets)) {
      if (matches(spec)) return name
    }
    return CUSTOM_PRESET
  }

  /** Pin a new session to a preset without model notices (creation-time fact). */
  pin(session: Session, name: string): void {
    const spec = this.spec(name)
    session.append('permission/preset', { preset: name })
    this.sandbox.set(session, spec.sandbox)
    this.approval.record(session, spec.approval)
  }

  /**
   * Switch a live agent's preset: log the selection, then each changed knob.
   * The approval change is announced to the model; the sandbox change is
   * visible through the next runtime-context snapshot.
   */
  set(agent: Agent, name: string): boolean {
    const spec = this.spec(name)
    const session = agent.session
    const knobs = foldKnobs(session.events)
    const sandbox = knobs.sandbox ?? this.sandbox.defaultMode
    const approval = this.approval.effectivePolicy(session)
    if (
      this.current(session.events) === name &&
      sandbox === spec.sandbox &&
      approval === spec.approval
    )
      return false
    session.append('permission/preset', { preset: name })
    if (sandbox !== spec.sandbox) this.sandbox.set(session, spec.sandbox)
    if (approval !== spec.approval)
      this.approval.setPolicy(agent, spec.approval)
    return true
  }
}
