/**
 * Process containment for owned processes (MCP stdio servers, plugin hooks,
 * the managed environment installer): an adapter over the one containment
 * backend (`sandbox/policy.ts`, SEC-08). It keeps the capability report the
 * diagnostics page reads and hands owned processes a wrapped argv, the
 * environment the policy sets (TMPDIR) and a ContainmentReceipt.
 *
 * A permission decision says whether Emperor may attempt an effect; this
 * controller separately records whether the host can actually contain the
 * process that performs it. With no sandbox a start is refused, or — for a
 * policy whose fallback is `ask-user` — run unconfined only after the user
 * agreed. Nothing falls back silently.
 */

import {
  ContainmentBackend,
  type ContainmentPolicy,
  type ContainmentReceipt,
  type UnsandboxedConsent,
} from '../sandbox/policy'

export type ProcessSandboxBackend =
  | 'macos-seatbelt'
  | 'linux-bwrap'
  | 'windows-unsupported'
  | 'unsupported'
  | 'none'
export type ProcessSandboxCapabilityStatus =
  'available' | 'unavailable' | 'unsupported' | 'error' | 'not_required'

export interface ProcessSandboxCapability {
  platform: NodeJS.Platform
  backend: ProcessSandboxBackend
  status: ProcessSandboxCapabilityStatus
  filesystem: 'workspace-write' | 'unavailable'
  network: 'policy-controlled' | 'unavailable'
  processTree: boolean
  reason: string
}

export type ProcessContainmentReceipt = ContainmentReceipt

export interface PreparedContainedProcess {
  /** Null when the start is refused. */
  executable: string | null
  args: string[]
  /** What the policy sets in the process environment (TMPDIR). */
  env: Record<string, string>
  receipt: ContainmentReceipt
}

export interface ProcessContainmentController {
  capability(): ProcessSandboxCapability
  contain(
    executable: string,
    args: string[],
    policy: ContainmentPolicy,
    consent?: UnsandboxedConsent | null,
  ): Promise<PreparedContainedProcess>
}

export interface OsSandboxControllerOptions {
  platform?: NodeJS.Platform
  /** The shared backend; one is made for `platform` when absent. */
  backend?: ContainmentBackend
}

export class OsSandboxController implements ProcessContainmentController {
  readonly backend: ContainmentBackend

  constructor(options: OsSandboxControllerOptions = {}) {
    this.backend =
      options.backend ??
      new ContainmentBackend(
        options.platform === undefined ? {} : { platform: options.platform },
      )
  }

  capability(): ProcessSandboxCapability {
    const capability = this.backend.capability()
    const platform = capability.platform as NodeJS.Platform
    const backend: ProcessSandboxBackend =
      platform === 'darwin'
        ? 'macos-seatbelt'
        : platform === 'linux'
          ? 'linux-bwrap'
          : platform === 'win32'
            ? 'windows-unsupported'
            : 'unsupported'
    return {
      platform,
      backend,
      status: capability.available
        ? 'available'
        : backend === 'macos-seatbelt' || backend === 'linux-bwrap'
          ? 'unavailable'
          : 'unsupported',
      filesystem: capability.available ? 'workspace-write' : 'unavailable',
      network: capability.available ? 'policy-controlled' : 'unavailable',
      processTree: capability.available,
      reason: capability.reason,
    }
  }

  async contain(
    executable: string,
    args: string[],
    policy: ContainmentPolicy,
    consent?: UnsandboxedConsent | null,
  ): Promise<PreparedContainedProcess> {
    const prepared = await this.backend.contain(
      [executable, ...args],
      policy,
      consent,
    )
    if (prepared.argv === null)
      return {
        executable: null,
        args: [],
        env: prepared.env,
        receipt: prepared.receipt,
      }
    const [first, ...rest] = prepared.argv
    return {
      executable: first!,
      args: rest,
      env: prepared.env,
      receipt: prepared.receipt,
    }
  }
}
