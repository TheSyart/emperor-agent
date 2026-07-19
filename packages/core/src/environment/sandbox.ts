import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { canonicalizeExistingPath, isPathWithin } from '../util/paths'

export type ProcessContainmentMode = 'required' | 'preferred'
export type ProcessNetworkPolicy = 'deny' | 'allow'
export type ProcessSandboxBackend =
  | 'macos-seatbelt'
  | 'linux-bwrap'
  | 'windows-unsupported'
  | 'unsupported'
  | 'none'
export type ProcessSandboxCapabilityStatus =
  'available' | 'unavailable' | 'unsupported' | 'error'

export interface ProcessSandboxCapability {
  platform: NodeJS.Platform
  backend: ProcessSandboxBackend
  status: ProcessSandboxCapabilityStatus
  filesystem: 'workspace-write' | 'unavailable'
  network: 'policy-controlled' | 'unavailable'
  processTree: boolean
  reason: string
}

export interface ProcessContainmentPolicy {
  mode: ProcessContainmentMode
  workspaceRoot: string
  stateRoot: string | null
  tempRoot: string
  readOnlyRoots: string[]
  network: ProcessNetworkPolicy
}

export interface ProcessContainmentReceipt {
  decision: 'sandboxed' | 'unsandboxed' | 'denied'
  backend: ProcessSandboxBackend
  capabilityStatus: ProcessSandboxCapabilityStatus
  filesystem: 'workspace-write' | 'unrestricted' | 'unavailable'
  network: 'denied' | 'allowed' | 'unrestricted' | 'unavailable'
  processTree: boolean
  policyHash: string
  reason: string
}

export interface PreparedContainedProcess {
  executable: string | null
  args: string[]
  receipt: ProcessContainmentReceipt
}

export interface ProcessContainmentController {
  capability(): ProcessSandboxCapability
  prepare(
    executable: string,
    args: string[],
    policy: ProcessContainmentPolicy,
  ): PreparedContainedProcess
}

interface ProbeResult {
  ok: boolean
  detail: string
}

export interface OsSandboxControllerOptions {
  platform?: NodeJS.Platform
  pathExists?: (path: string) => boolean
  probeProcess?: (executable: string, args: string[]) => ProbeResult
}

const MACOS_SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const LINUX_BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap'] as const

const MACOS_SYSTEM_READ_ROOTS = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/Library',
  '/Applications',
  '/opt/homebrew',
  '/opt/local',
  '/usr/local',
  '/private/etc',
  '/private/var/select',
  '/private/var/db',
] as const

const LINUX_SYSTEM_READ_ROOTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/etc',
] as const

/**
 * OS sandbox capability and command preparation. A permission decision says
 * whether Emperor may attempt an effect; this controller separately records
 * whether the host can actually contain the process that performs it.
 */
export class OsSandboxController implements ProcessContainmentController {
  private readonly platform: NodeJS.Platform
  private readonly pathExists: (path: string) => boolean
  private readonly probeProcess: (
    executable: string,
    args: string[],
  ) => ProbeResult
  private cachedCapability: ProcessSandboxCapability | null = null
  private helperPath: string | null = null

  constructor(opts: OsSandboxControllerOptions = {}) {
    this.platform = opts.platform ?? process.platform
    this.pathExists = opts.pathExists ?? existsSync
    this.probeProcess = opts.probeProcess ?? defaultProbeProcess
  }

  capability(): ProcessSandboxCapability {
    if (this.cachedCapability) return { ...this.cachedCapability }
    const capability = this.probeCapability()
    this.cachedCapability = capability
    return { ...capability }
  }

  prepare(
    executable: string,
    args: string[],
    rawPolicy: ProcessContainmentPolicy,
  ): PreparedContainedProcess {
    const policy = normalizePolicy(rawPolicy)
    const capability = this.capability()
    const policyHash = containmentPolicyHash(policy)
    if (capability.status !== 'available') {
      if (policy.mode === 'preferred') {
        return {
          executable,
          args: [...args],
          receipt: {
            decision: 'unsandboxed',
            backend: 'none',
            capabilityStatus: capability.status,
            filesystem: 'unrestricted',
            network: 'unrestricted',
            processTree: false,
            policyHash,
            reason: capability.reason,
          },
        }
      }
      return {
        executable: null,
        args: [],
        receipt: {
          decision: 'denied',
          backend: capability.backend,
          capabilityStatus: capability.status,
          filesystem:
            capability.filesystem === 'workspace-write'
              ? 'workspace-write'
              : 'unavailable',
          network:
            policy.network === 'deny' &&
            capability.network === 'policy-controlled'
              ? 'denied'
              : 'unavailable',
          processTree: capability.processTree,
          policyHash,
          reason: capability.reason,
        },
      }
    }

    if (capability.backend === 'macos-seatbelt') {
      return {
        executable: this.helperPath ?? MACOS_SANDBOX_EXEC,
        args: [
          '-p',
          macosSeatbeltProfile(policy, this.pathExists),
          executable,
          ...args,
        ],
        receipt: sandboxedReceipt(capability, policy, policyHash),
      }
    }
    if (capability.backend === 'linux-bwrap') {
      return {
        executable: this.helperPath,
        args: linuxBwrapArgs(executable, args, policy, this.pathExists),
        receipt: sandboxedReceipt(capability, policy, policyHash),
      }
    }
    return {
      executable: null,
      args: [],
      receipt: {
        decision: 'denied',
        backend: capability.backend,
        capabilityStatus: 'error',
        filesystem: 'unavailable',
        network: 'unavailable',
        processTree: false,
        policyHash,
        reason: 'sandbox capability and preparation backend disagree',
      },
    }
  }

  private probeCapability(): ProcessSandboxCapability {
    if (this.platform === 'darwin') return this.probeMacos()
    if (this.platform === 'linux') return this.probeLinux()
    if (this.platform === 'win32')
      return unavailableCapability(
        this.platform,
        'windows-unsupported',
        'Windows Job Object plus ACL containment is not implemented; mutating shell commands fail closed.',
        'unsupported',
      )
    return unavailableCapability(
      this.platform,
      'unsupported',
      `No OS sandbox backend is implemented for ${this.platform}.`,
      'unsupported',
    )
  }

  private probeMacos(): ProcessSandboxCapability {
    if (!this.pathExists(MACOS_SANDBOX_EXEC))
      return unavailableCapability(
        this.platform,
        'macos-seatbelt',
        'sandbox-exec is missing from the host OS.',
      )
    const result = this.probeProcess(MACOS_SANDBOX_EXEC, [
      '-p',
      '(version 1) (allow default)',
      '/usr/bin/true',
    ])
    if (!result.ok)
      return unavailableCapability(
        this.platform,
        'macos-seatbelt',
        `Seatbelt probe failed: ${result.detail}`,
        'error',
      )
    this.helperPath = MACOS_SANDBOX_EXEC
    return availableCapability(this.platform, 'macos-seatbelt', result.detail)
  }

  private probeLinux(): ProcessSandboxCapability {
    const helper = LINUX_BWRAP_CANDIDATES.find(this.pathExists) ?? null
    if (!helper)
      return unavailableCapability(
        this.platform,
        'linux-bwrap',
        'bubblewrap is not installed.',
      )
    const result = this.probeProcess(helper, [
      '--die-with-parent',
      '--new-session',
      '--unshare-net',
      '--ro-bind',
      '/',
      '/',
      '--',
      '/bin/true',
    ])
    if (!result.ok)
      return unavailableCapability(
        this.platform,
        'linux-bwrap',
        `bubblewrap probe failed (user namespaces may be disabled): ${result.detail}`,
        'error',
      )
    this.helperPath = helper
    return availableCapability(this.platform, 'linux-bwrap', result.detail)
  }
}

function availableCapability(
  platform: NodeJS.Platform,
  backend: ProcessSandboxBackend,
  reason: string,
): ProcessSandboxCapability {
  return {
    platform,
    backend,
    status: 'available',
    filesystem: 'workspace-write',
    network: 'policy-controlled',
    processTree: true,
    reason,
  }
}

function unavailableCapability(
  platform: NodeJS.Platform,
  backend: ProcessSandboxBackend,
  reason: string,
  status: ProcessSandboxCapabilityStatus = 'unavailable',
): ProcessSandboxCapability {
  return {
    platform,
    backend,
    status,
    filesystem: 'unavailable',
    network: 'unavailable',
    processTree: false,
    reason,
  }
}

function sandboxedReceipt(
  capability: ProcessSandboxCapability,
  policy: ProcessContainmentPolicy,
  policyHash: string,
): ProcessContainmentReceipt {
  return {
    decision: 'sandboxed',
    backend: capability.backend,
    capabilityStatus: capability.status,
    filesystem: 'workspace-write',
    network: policy.network === 'deny' ? 'denied' : 'allowed',
    processTree: true,
    policyHash,
    reason: '',
  }
}

function normalizePolicy(
  policy: ProcessContainmentPolicy,
): ProcessContainmentPolicy {
  const workspaceRoot = canonicalRoot(policy.workspaceRoot)
  const stateRoot = policy.stateRoot ? canonicalRoot(policy.stateRoot) : null
  const tempRoot = canonicalRoot(policy.tempRoot)
  const readOnlyRoots = uniqueRoots(
    policy.readOnlyRoots.map(canonicalRoot),
  ).filter(
    (root) =>
      !isPathWithin(workspaceRoot, root) &&
      !(stateRoot && isPathWithin(root, stateRoot)),
  )
  return {
    mode: policy.mode,
    workspaceRoot,
    stateRoot,
    tempRoot,
    readOnlyRoots,
    network: policy.network,
  }
}

function canonicalRoot(path: string): string {
  return canonicalizeExistingPath(resolve(path))
}

function macosSeatbeltProfile(
  policy: ProcessContainmentPolicy,
  pathExists: (path: string) => boolean,
): string {
  const readRoots = uniqueRoots([
    ...MACOS_SYSTEM_READ_ROOTS.filter(pathExists).map(canonicalRoot),
    ...policy.readOnlyRoots,
  ])
  const workspaceFilter = seatbeltRootFilter(
    policy.workspaceRoot,
    policy.stateRoot,
  )
  const tempFilter = seatbeltRootFilter(policy.tempRoot, policy.stateRoot)
  const rules = [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    '(allow signal (target same-sandbox))',
    ...readRoots.map(
      (root) =>
        `(allow file-read* ${seatbeltRootFilter(root, policy.stateRoot)})`,
    ),
    `(allow file-read* ${workspaceFilter} ${tempFilter})`,
    `(allow file-write* ${workspaceFilter} ${tempFilter} (literal "/dev/null"))`,
    policy.network === 'allow' ? '(allow network*)' : '(deny network*)',
  ]
  return rules.join(' ')
}

function linuxBwrapArgs(
  executable: string,
  args: string[],
  policy: ProcessContainmentPolicy,
  pathExists: (path: string) => boolean,
): string[] {
  const out = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
  ]
  if (policy.network === 'deny') out.push('--unshare-net')
  out.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
  const executableRoot = canonicalRoot(dirname(executable))
  const readRoots = uniqueRoots([
    ...LINUX_SYSTEM_READ_ROOTS.filter(pathExists).map(canonicalRoot),
    ...policy.readOnlyRoots,
    executableRoot,
  ]).filter(
    (root) =>
      !isPathWithin(policy.workspaceRoot, root) &&
      !isPathWithin(root, policy.workspaceRoot),
  )
  for (const root of readRoots) out.push('--ro-bind', root, root)
  out.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  if (!isPathWithin(policy.tempRoot, policy.workspaceRoot))
    out.push('--bind', policy.tempRoot, policy.tempRoot)
  if (policy.stateRoot && pathExists(policy.stateRoot))
    out.push('--tmpfs', policy.stateRoot)
  out.push('--chdir', policy.workspaceRoot, '--', executable, ...args)
  return out
}

function containmentPolicyHash(policy: ProcessContainmentPolicy): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        mode: policy.mode,
        workspaceRoot: policy.workspaceRoot,
        stateRoot: policy.stateRoot,
        tempRoot: policy.tempRoot,
        readOnlyRoots: [...policy.readOnlyRoots].sort(),
        network: policy.network,
      }),
    )
    .digest('hex')
}

function uniqueRoots(roots: string[]): string[] {
  return [...new Set(roots.filter(Boolean))].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  )
}

function seatbeltString(value: string): string {
  return JSON.stringify(value)
}

function seatbeltRootFilter(root: string, stateRoot: string | null): string {
  if (!stateRoot || !isPathWithin(stateRoot, root))
    return `(subpath ${seatbeltString(root)})`
  return `(require-all (subpath ${seatbeltString(root)}) (require-not (subpath ${seatbeltString(stateRoot)})))`
}

function defaultProbeProcess(executable: string, args: string[]): ProbeResult {
  try {
    const result = spawnSync(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
      timeout: 3_000,
      encoding: 'utf8',
    })
    const detail = String(result.stderr || result.error?.message || '')
      .trim()
      .slice(0, 300)
    return {
      ok: result.status === 0 && !result.error,
      detail: detail || `exit ${String(result.status ?? 'unknown')}`,
    }
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof Error ? error.message.slice(0, 300) : 'probe failed',
    }
  }
}
