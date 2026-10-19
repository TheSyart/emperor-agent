/**
 * The Shell's process sandbox (ported from dsh-sandbox-local), an adapter
 * over the one containment backend (`sandbox/policy.ts`, SEC-08).
 *
 * Platform chain: macOS → Seatbelt (`sandbox-exec`), Linux → bubblewrap
 * (each functionally probed once). Every other platform has no backend and
 * fails closed: confined modes throw SANDBOX_UNAVAILABLE and the command
 * never runs unconfined.
 */

import { homedir, tmpdir } from 'node:os'
import {
  bwrapArgs,
  ContainmentBackend,
  emperorSocketDirectories,
  seatbeltProfile,
  type ContainmentPolicy,
  type ContainmentRunner,
} from '../../sandbox/policy'
import {
  canonicalPath,
  SandboxUnavailableError,
  writableRoots,
  type ConfinedSandboxMode,
  type SandboxPolicy,
} from './policy'
import {
  protectedPathSpellings,
  type ProtectedPathScope,
} from './protected-state'

export type SandboxEnforcement = 'full' | 'partial'

export interface RunnerFailureRule {
  allowedExitCodes?: readonly number[]
  fatalSignatures: readonly string[]
}

export interface ConfinedArgv {
  argv: string[]
  enforcement: SandboxEnforcement
  /** Case-insensitive stderr substrings a denied file effect produces. */
  denialSignatures: readonly string[]
  /** Runner-owned fatal diagnostics (the command did not run). */
  runnerFailureRules: readonly RunnerFailureRule[]
  /**
   * The full-access guard only: a denial counts when its stderr line also
   * names one of these (lowercase) paths, so an unrelated "Operation not
   * permitted" (privacy-protected folders, root-owned files) is not
   * reported as a protected-path denial.
   */
  denialPaths?: readonly string[]
}

export interface SandboxBackend {
  /** Wrap argv for one confined policy; throws SANDBOX_UNAVAILABLE when no runner is usable. */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
  /**
   * danger-full-access: wrap argv so the protected paths (protected-state.ts)
   * stay out of reach and nothing else is confined. Null: this host has no
   * guard and the command runs unwrapped (tests, Linux, no protected root).
   */
  guard?(argv: readonly string[]): ConfinedArgv | null
}

const DENIAL_SIGNATURES: Record<ContainmentRunner, readonly string[]> = {
  bwrap: ['read-only file system'],
  seatbelt: ['operation not permitted'],
}

const RUNNER_FAILURE_RULES: Record<
  ContainmentRunner,
  readonly RunnerFailureRule[]
> = {
  bwrap: [{ fatalSignatures: ['bwrap: '] }],
  seatbelt: [{ fatalSignatures: ['sandbox-exec: '] }],
}

function protectedScope(
  stateRoot: string | undefined,
  home: string | undefined,
): ProtectedPathScope | null {
  return stateRoot === undefined ? null : { stateRoot, home: home ?? homedir() }
}

/**
 * A confined Shell mode as a ContainmentPolicy: every file readable except
 * the protected-path table, writes only under the mode's writable roots
 * (and host-granted single files), no Apple Events or window server, none
 * of Emperor's helper sockets. `protectedHome` defaults to the user's home.
 */
export function shellContainmentPolicy(
  policy: SandboxPolicy,
  protectedStateRoot?: string,
  protectedHome?: string,
): ContainmentPolicy {
  const scope = protectedScope(protectedStateRoot, protectedHome)
  return {
    read: { allow: 'all', deny: [] },
    write: {
      allow: writableRoots(policy),
      deny: (policy.readOnlyRoots ?? []).map(canonicalPath),
    },
    network: 'allow',
    tempDir: policy.privateTempRoot ?? tmpdir(),
    toolchainReadOnly: [],
    ancestorsMetadata: true,
    fallback: 'refuse',
    protectedPaths:
      scope === null ? null : { ...scope, credentialReads: 'deny' },
    ...(policy.writableFiles?.length
      ? { grantedFiles: policy.writableFiles.map(canonicalPath) }
      : {}),
    desktop: 'deny',
    deniedSocketDirs: emperorSocketDirectories(protectedStateRoot),
    ...(policy.processBoundaryTag
      ? { boundaryTag: policy.processBoundaryTag }
      : {}),
  }
}

/**
 * danger-full-access Shell: nothing is confined except the protected-path
 * table, so an approved escalation never opens Emperor's private state or
 * config files, and no mode writes the user's credentials.
 */
export function shellGuardPolicy(
  protectedStateRoot: string,
  protectedHome?: string,
): ContainmentPolicy {
  return {
    read: { allow: 'all', deny: [] },
    write: { allow: 'all', deny: [] },
    network: 'allow',
    tempDir: tmpdir(),
    toolchainReadOnly: [],
    ancestorsMetadata: true,
    fallback: 'refuse',
    protectedPaths: {
      ...protectedScope(protectedStateRoot, protectedHome)!,
      credentialReads: 'allow',
    },
    desktop: 'allow',
    deniedSocketDirs: [],
  }
}

/** bwrap arguments of one confined Shell mode (shared generator). */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  return bwrapArgs(shellContainmentPolicy(policy))
}

/** Seatbelt arguments of one confined Shell mode (shared generator). */
export function seatbeltProfileArgs(
  policy: SandboxPolicy,
  protectedStateRoot?: string,
  protectedHome?: string,
): string[] {
  return [
    '-p',
    seatbeltProfile(
      shellContainmentPolicy(policy, protectedStateRoot, protectedHome),
    ),
  ]
}

/** Seatbelt arguments of the danger-full-access guard (shared generator). */
export function seatbeltGuardArgs(
  protectedStateRoot: string,
  protectedHome?: string,
): string[] {
  return [
    '-p',
    seatbeltProfile(shellGuardPolicy(protectedStateRoot, protectedHome)),
  ]
}

export interface LocalSandboxOptions {
  platform?: string
  probeTimeoutMs?: number
  /** Test hook: replace the functional bwrap probe. */
  probeBwrap?: () => boolean
  /** Test hook: replace the sandbox-exec executable. */
  seatbeltExec?: string
  /** Emperor Home: Shell must not reach the protected-path table (protected-state.ts). */
  protectedStateRoot?: string
  /** The home folder the credential paths hang off; defaults to the user's. */
  protectedHome?: string
  /** The shared containment backend (SEC-08); one is made from the options above when absent. */
  backend?: ContainmentBackend
}

/**
 * The Shell's adapter over the shared containment backend: it turns a
 * sandbox mode into a ContainmentPolicy and keeps the Shell's own error
 * vocabulary (SANDBOX_UNAVAILABLE, denial signatures, runner failures).
 */
export class LocalSandbox implements SandboxBackend {
  private readonly backend: ContainmentBackend

  constructor(private readonly options: LocalSandboxOptions = {}) {
    this.backend =
      options.backend ??
      new ContainmentBackend({
        ...(options.platform === undefined
          ? {}
          : { platform: options.platform }),
        ...(options.seatbeltExec === undefined
          ? {}
          : { seatbeltExec: options.seatbeltExec }),
        ...(options.probeBwrap === undefined
          ? {}
          : { probeBwrap: options.probeBwrap }),
        ...(options.probeTimeoutMs === undefined
          ? {}
          : { probeTimeoutMs: options.probeTimeoutMs }),
      })
  }

  /** Whether confined modes can run on this host. */
  available(): boolean {
    return this.backend.capability().available
  }

  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    const runner = this.select(policy.mode)
    return {
      argv: this.backend.wrap(
        argv,
        shellContainmentPolicy(
          policy,
          this.options.protectedStateRoot,
          this.options.protectedHome,
        ),
        runner,
      ),
      enforcement: 'full',
      denialSignatures: DENIAL_SIGNATURES[runner],
      runnerFailureRules: RUNNER_FAILURE_RULES[runner],
    }
  }

  guard(argv: readonly string[]): ConfinedArgv | null {
    const stateRoot = this.options.protectedStateRoot
    if (stateRoot === undefined) return null
    // Only Seatbelt has a guard; elsewhere full access runs unwrapped.
    if (this.backend.platform !== 'darwin') return null
    const capability = this.backend.capability()
    if (!capability.available || capability.runner !== 'seatbelt')
      throw new SandboxUnavailableError('danger-full-access', capability.reason)
    return {
      argv: this.backend.wrap(
        argv,
        shellGuardPolicy(stateRoot, this.options.protectedHome),
        'seatbelt',
      ),
      enforcement: 'partial',
      denialSignatures: DENIAL_SIGNATURES.seatbelt,
      runnerFailureRules: RUNNER_FAILURE_RULES.seatbelt,
      denialPaths: protectedPathSpellings({
        stateRoot,
        home: this.options.protectedHome ?? homedir(),
      }),
    }
  }

  private select(mode: ConfinedSandboxMode): ContainmentRunner {
    const capability = this.backend.capability()
    if (!capability.available || capability.runner === null)
      throw new SandboxUnavailableError(mode)
    return capability.runner
  }
}

/** Classify a confined run's stderr: denial and/or runner failure. */
export function classifyConfinedStderr(
  confined: ConfinedArgv,
  stderr: string,
  exitCode: number | null,
): { denied: boolean; runnerFailed: boolean } {
  const lower = stderr.toLowerCase()
  const paths = confined.denialPaths
  const denied =
    paths === undefined
      ? confined.denialSignatures.some((signature) => lower.includes(signature))
      : lower
          .split('\n')
          .some(
            (line) =>
              confined.denialSignatures.some((signature) =>
                line.includes(signature),
              ) && paths.some((path) => line.includes(path)),
          )
  const runnerFailed = confined.runnerFailureRules.some(
    (rule) =>
      (rule.allowedExitCodes === undefined ||
        (exitCode !== null && rule.allowedExitCodes.includes(exitCode))) &&
      rule.fatalSignatures.some((signature) =>
        lower
          .split('\n')
          .some((line) => line.startsWith(signature.toLowerCase())),
      ),
  )
  return { denied, runnerFailed }
}
