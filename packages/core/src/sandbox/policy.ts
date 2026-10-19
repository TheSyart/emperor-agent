/**
 * One process containment for every process Emperor starts on the user's
 * behalf (SEC-08): the Shell (`bash`), MCP stdio servers, plugin hooks and
 * the managed environment installer.
 *
 * A {@link ContainmentPolicy} says what a process may read, write and reach;
 * one generator turns it into a Seatbelt profile (macOS) or bwrap arguments
 * (Linux). {@link ContainmentBackend} picks the runner, wraps argv and
 * returns a {@link ContainmentReceipt}. When no sandbox can run it refuses —
 * or, for a policy whose fallback is `ask-user`, runs unconfined only after
 * the user agreed. There is no silent unsandboxed fallback.
 *
 * Seatbelt evaluates the last matching rule, so the profile is written in
 * tiers: broad allows, then carve-outs (`deny`), then grants inside the
 * carve-outs, then the protected-path table (protected-state.ts), which no
 * grant opens.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { canonicalPath } from '../harness/sandbox/policy'
import {
  protectedAncestors,
  protectedEntries,
  type ProtectedEntry,
  type ProtectedPathScope,
} from '../harness/sandbox/protected-state'

export type ContainmentRunner = 'seatbelt' | 'bwrap'
export type ContainmentDecision =
  'contained' | 'refused' | 'user-allowed-unsandboxed'

export interface ContainmentPolicy {
  /** `all`: everything except `deny` (Shell). A list: deny-by-default. */
  read: { allow: 'all' | string[]; deny: string[] }
  /** `all`: the full-access guard only. A list: deny-by-default. */
  write: { allow: 'all' | string[]; deny: string[] }
  network: 'allow' | 'deny'
  /** TMPDIR (and TMP, TEMP) of the process; writable through `write.allow`. */
  tempDir: string
  /** node / python / Homebrew prefixes and PATH folders, readable only. */
  toolchainReadOnly: string[]
  /** lstat the ancestors of every readable folder (realpath, npx, uv). */
  ancestorsMetadata: boolean
  /** What happens when no sandbox can run: never a silent unsandboxed start. */
  fallback: 'refuse' | 'ask-user'
  /** The protected-path table (SEC-06): Emperor's private state and settings, the user's credentials. */
  protectedPaths:
    (ProtectedPathScope & { credentialReads: 'deny' | 'allow' }) | null
  /**
   * Host-only single files a runtime may rewrite in place (AGT-03, the
   * user's Codex auth.json); opened again after the credential rules.
   */
  grantedFiles?: string[]
  /** Apple Events and the window server (E-M13). */
  desktop: 'allow' | 'deny'
  /** Unix-socket folders the process may not connect into (Emperor's helpers). */
  deniedSocketDirs: string[]
  /** Unforgeable host nonce carried by an inherited Seatbelt policy (AGT-04). */
  boundaryTag?: string
}

export interface ContainmentReceipt {
  backend: ContainmentRunner | 'none'
  decision: ContainmentDecision
  policyHash: string
  /** Why a start was refused or ran outside the sandbox; empty when contained. */
  reason: string
}

/** OS folders a deny-by-default reader still needs (dyld, frameworks, /etc). */
export const SYSTEM_READ_ROOTS: readonly string[] = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/Library',
  '/Applications',
  '/private/etc',
  '/private/var/select',
  '/private/var/db',
  '/dev',
]

const LINUX_SYSTEM_READ_ROOTS: readonly string[] = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/etc',
]

const GIT_HOOK_RULES = [
  // Hooks run when the user's own git commits or checks out: a contained
  // process may not plant one. Samples from git init / clone stay writable.
  '(deny file-write* (regex #"/\\.git/(modules/.+/)?hooks/[^/]+$"))',
  '(allow file-write* (regex #"/\\.git/(modules/.+/)?hooks/[^/]+\\.sample$"))',
]

const DESKTOP_RULES = [
  // E-M13: checked against a real sandbox-exec child.
  '(deny appleevent-send)',
  '(deny mach-lookup (global-name "com.apple.windowserver.active"))',
  '(deny mach-lookup (global-name "com.apple.windowserver"))',
]

function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

function escapeSbplRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pathPrefixRegex(path: string): string {
  return `^${escapeSbplRegex(path)}/`
}

function sbplFilter(entry: ProtectedEntry): string {
  switch (entry.match) {
    case 'subtree':
      return `(subpath ${sbplString(entry.path)})`
    case 'exact':
      return `(literal ${sbplString(entry.path)})`
    case 'prefix':
      return `(regex ${sbplString(
        `^${escapeSbplRegex(entry.path)}/(${entry.names.map(escapeSbplRegex).join('|')})`,
      )})`
  }
}

function subpaths(roots: readonly string[]): string {
  return roots.map((root) => `(subpath ${sbplString(root)})`).join(' ')
}

function within(path: string, root: string): boolean {
  return (
    path === root ||
    path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  )
}

function insideAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => within(path, root))
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(Boolean))]
}

function ancestorsOf(path: string): string[] {
  const out: string[] = []
  let current = dirname(path)
  while (current !== dirname(current)) {
    out.push(current)
    current = dirname(current)
  }
  return out
}

/**
 * Real path of `path`, or of its nearest existing ancestor plus the rest:
 * Seatbelt matches real paths, and a folder a process will create (an
 * install target) must be spelled the way it will exist.
 */
export function canonicalContainmentPath(path: string): string {
  return canonical(path)
}

function canonical(path: string): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    const resolved = canonicalPath(current)
    if (resolved !== current || existsSync(current))
      return missing.length ? join(resolved, ...missing) : resolved
    const parent = dirname(current)
    if (parent === current) return path
    missing.unshift(basename(current))
    current = parent
  }
}

/** The policy with canonical paths (Seatbelt matches real paths). */
export function normalizeContainmentPolicy(
  policy: ContainmentPolicy,
): ContainmentPolicy {
  const list = (value: 'all' | string[]) =>
    value === 'all' ? 'all' : unique(value.map(canonical))
  return {
    read: {
      allow: list(policy.read.allow),
      deny: unique(policy.read.deny.map(canonical)),
    },
    write: {
      allow: list(policy.write.allow),
      deny: unique(policy.write.deny.map(canonical)),
    },
    network: policy.network,
    tempDir: canonical(policy.tempDir),
    toolchainReadOnly: unique(policy.toolchainReadOnly.map(canonical)),
    ancestorsMetadata: policy.ancestorsMetadata,
    fallback: policy.fallback,
    protectedPaths: policy.protectedPaths ? { ...policy.protectedPaths } : null,
    ...(policy.grantedFiles?.length
      ? { grantedFiles: unique(policy.grantedFiles.map(canonical)) }
      : {}),
    desktop: policy.desktop,
    deniedSocketDirs: unique(policy.deniedSocketDirs),
    ...(policy.boundaryTag ? { boundaryTag: policy.boundaryTag } : {}),
  }
}

/** Stable digest of what a policy allows (array order does not matter). */
export function containmentPolicyHash(policy: ContainmentPolicy): string {
  const p = normalizeContainmentPolicy(policy)
  const sorted = (value: 'all' | string[]) =>
    value === 'all' ? 'all' : [...value].sort()
  return createHash('sha256')
    .update(
      JSON.stringify({
        read: { allow: sorted(p.read.allow), deny: sorted(p.read.deny) },
        write: { allow: sorted(p.write.allow), deny: sorted(p.write.deny) },
        network: p.network,
        tempDir: p.tempDir,
        toolchainReadOnly: sorted(p.toolchainReadOnly),
        ancestorsMetadata: p.ancestorsMetadata,
        fallback: p.fallback,
        protectedPaths: p.protectedPaths,
        grantedFiles: sorted(p.grantedFiles ?? []),
        desktop: p.desktop,
        deniedSocketDirs: sorted(p.deniedSocketDirs),
        boundaryTag: p.boundaryTag ?? null,
      }),
    )
    .digest('hex')
}

/**
 * Emperor's own unix-socket folders: the run folder in the default home,
 * the per-user temp folder, and the run folder of a custom Emperor Home
 * (the Computer Use helper socket follows EMPEROR_CONFIG_DIR).
 */
export function emperorSocketDirectories(stateRoot?: string | null): string[] {
  const child = (root: string, ...parts: string[]) =>
    parts.reduce(
      (current, part) => canonical(join(current, part)),
      canonical(root),
    )
  return unique([
    child(homedir(), '.emperor', 'run'),
    child(tmpdir(), `emperor-${process.getuid?.() ?? 0}`),
    ...(stateRoot ? [child(stateRoot, 'run')] : []),
  ])
}

/**
 * The protected-path table as Seatbelt rules, after every allow so it wins:
 * `state` and `config` are never read or written; `credential` paths are
 * never written and, with `credentialReads: 'deny'`, never read — except
 * single files the host granted to a runtime it launches. Renaming Emperor
 * Home or a credential path's parents is refused too.
 */
function protectedPathRules(
  scope: ProtectedPathScope,
  credentialReads: 'deny' | 'allow',
  hostGrantedFiles: readonly string[],
): string[] {
  const entries = protectedEntries(scope)
  const forms: string[] = []
  for (const entry of entries)
    if (entry.class === 'credential')
      forms.push(
        `(deny ${credentialReads === 'deny' ? 'file-read* ' : ''}file-write* ${sbplFilter(entry)})`,
      )
  for (const file of hostGrantedFiles)
    forms.push(`(allow file-read* file-write* (literal ${sbplString(file)}))`)
  for (const entry of entries)
    if (entry.class !== 'credential')
      forms.push(`(deny file-read* file-write* ${sbplFilter(entry)})`)
  for (const directory of protectedAncestors(scope))
    forms.push(`(deny file-write* (literal ${sbplString(directory)}))`)
  return forms
}

/** Everything a deny-by-default reader may read, in tier order. */
function readRoots(p: ContainmentPolicy, platform: string): string[] {
  const writes = p.write.allow === 'all' ? [] : p.write.allow
  const system =
    platform === 'linux' ? LINUX_SYSTEM_READ_ROOTS : SYSTEM_READ_ROOTS
  return unique([
    ...system,
    ...p.toolchainReadOnly,
    ...(p.read.allow === 'all' ? [] : p.read.allow),
    ...writes,
    p.tempDir,
  ])
}

/** The one Seatbelt (SBPL) generator. */
export function seatbeltProfile(policy: ContainmentPolicy): string {
  const p = normalizeContainmentPolicy(policy)
  const forms = ['(version 1)', '(allow default)']
  if (p.read.allow === 'all') {
    if (p.read.deny.length)
      forms.push(`(deny file-read* ${subpaths(p.read.deny)})`)
  } else {
    forms.push('(deny file-read*)', '(import "system.sb")')
    const roots = readRoots(p, 'darwin')
    const broad = roots.filter((root) => !insideAny(root, p.read.deny))
    const granted = roots.filter((root) => insideAny(root, p.read.deny))
    if (broad.length) forms.push(`(allow file-read* ${subpaths(broad)})`)
    if (p.read.deny.length)
      forms.push(`(deny file-read* ${subpaths(p.read.deny)})`)
    if (granted.length) forms.push(`(allow file-read* ${subpaths(granted)})`)
    if (p.ancestorsMetadata) {
      // A folder reached through a symlink (a PATH entry, a linked
      // node_modules) is looked up by its spelling first: its own node and
      // its ancestors need lstat too.
      const spelled = readRoots(policy, 'darwin').filter(
        (path) => isAbsolute(path) && canonical(path) !== path,
      )
      const ancestors = unique([
        ...roots.flatMap(ancestorsOf),
        ...spelled,
        ...spelled.flatMap(ancestorsOf),
      ])
        .filter(
          (path) => !(insideAny(path, broad) && !insideAny(path, p.read.deny)),
        )
        .sort()
      if (ancestors.length)
        forms.push(
          `(allow file-read-metadata ${ancestors.map((path) => `(literal ${sbplString(path)})`).join(' ')})`,
        )
    }
  }
  if (p.write.allow !== 'all') {
    forms.push(
      '(deny file-write*)',
      `(allow file-write* (literal ${sbplString('/dev/null')}))`,
    )
    if (p.boundaryTag) {
      const root = `/private/tmp/emperor-boundary-${p.boundaryTag}`
      forms.push(
        `(deny file-read-data (literal ${sbplString(`${root}-denied`)}))`,
      )
      forms.push(
        `(allow file-read-data (literal ${sbplString(`${root}-allowed`)}))`,
      )
    }
    const broad = p.write.allow.filter((root) => !insideAny(root, p.write.deny))
    const granted = p.write.allow.filter((root) =>
      insideAny(root, p.write.deny),
    )
    if (broad.length) forms.push(`(allow file-write* ${subpaths(broad)})`)
    // Exact files only: rewritten in place, nothing created beside them.
    for (const file of p.grantedFiles ?? [])
      forms.push(`(allow file-write* (literal ${sbplString(file)}))`)
    for (const root of p.write.deny)
      forms.push(`(deny file-write* (subpath ${sbplString(root)}))`)
    if (granted.length) forms.push(`(allow file-write* ${subpaths(granted)})`)
    forms.push(...GIT_HOOK_RULES)
  } else {
    for (const root of p.write.deny)
      forms.push(`(deny file-write* (subpath ${sbplString(root)}))`)
  }
  if (p.network === 'deny') forms.push('(deny network*)')
  if (p.desktop === 'deny') forms.push(...DESKTOP_RULES)
  for (const directory of p.deniedSocketDirs)
    forms.push(
      `(deny network-outbound (remote unix-socket (path-regex ${sbplString(pathPrefixRegex(directory))})))`,
    )
  if (p.protectedPaths)
    forms.push(
      ...protectedPathRules(
        p.protectedPaths,
        p.protectedPaths.credentialReads,
        p.grantedFiles ?? [],
      ),
    )
  return forms.join(' ')
}

/**
 * The one bubblewrap generator (Linux is not a supported platform; kept so
 * the Shell keeps its runner there). Reads `all`: the host root read-only,
 * write roots bound back; a read list: only those folders are mounted.
 */
export function bwrapArgs(policy: ContainmentPolicy): string[] {
  const p = normalizeContainmentPolicy(policy)
  const platformTemp = new Set(['/tmp', canonical(tmpdir())])
  const writes = p.write.allow === 'all' ? [] : p.write.allow
  if (p.read.allow === 'all') {
    const args = [
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--unshare-pid',
      '--proc',
      '/proc',
      '--die-with-parent',
    ]
    if (p.network === 'deny') args.push('--unshare-net')
    if (writes.length > 0) {
      args.push('--tmpfs', '/tmp')
      for (const root of writes)
        if (!platformTemp.has(root)) args.push('--bind', root, root)
      for (const file of p.grantedFiles ?? []) args.push('--bind', file, file)
      for (const root of p.write.deny) args.push('--ro-bind', root, root)
    }
    return args
  }
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
  ]
  if (p.network === 'deny') args.push('--unshare-net')
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
  const mounts: Array<[string, string]> = []
  for (const root of readRoots(p, 'linux'))
    if (
      !insideAny(root, writes) &&
      !insideAny(root, p.read.deny) &&
      existsSync(root)
    )
      mounts.push(['--ro-bind', root])
  for (const root of p.read.deny)
    if (existsSync(root)) mounts.push(['--tmpfs', root])
  for (const root of readRoots(p, 'linux'))
    if (
      !insideAny(root, writes) &&
      insideAny(root, p.read.deny) &&
      existsSync(root)
    )
      mounts.push(['--ro-bind', root])
  for (const root of writes) if (existsSync(root)) mounts.push(['--bind', root])
  for (const [flag, root] of mounts.sort(
    (left, right) => left[1].split(sep).length - right[1].split(sep).length,
  ))
    args.push(flag, ...(flag === '--tmpfs' ? [root] : [root, root]))
  return args
}

export interface ContainmentProbeResult {
  ok: boolean
  detail: string
}

export interface ContainmentCapability {
  platform: string
  runner: ContainmentRunner | null
  available: boolean
  reason: string
}

export interface ContainmentBackendOptions {
  platform?: NodeJS.Platform | string
  /** Test hook: replace the sandbox-exec executable. */
  seatbeltExec?: string
  /** Test hook: replace the functional probe of whichever runner applies. */
  probe?: () => ContainmentProbeResult
  /** Test hook: replace the functional bwrap probe (LocalSandbox's old option). */
  probeBwrap?: () => boolean
  probeTimeoutMs?: number
}

/** The user's answer for one unconfined start (fallback `ask-user`). */
export interface UnsandboxedConsent {
  decide(reason: string): Promise<boolean> | boolean
}

export interface PreparedContainment {
  /** Wrapped argv; null when refused. */
  argv: string[] | null
  /** TMPDIR, TMP and TEMP of the process. */
  env: Record<string, string>
  receipt: ContainmentReceipt
  runner: ContainmentRunner | null
}

const SEATBELT_EXEC = '/usr/bin/sandbox-exec'

export class ContainmentBackend {
  private cached: ContainmentCapability | undefined

  constructor(private readonly options: ContainmentBackendOptions = {}) {}

  get platform(): string {
    return this.options.platform ?? process.platform
  }

  /** The host OS's own binary: a sandbox-exec first on PATH would run commands unconfined. */
  get seatbeltExec(): string {
    return this.options.seatbeltExec ?? SEATBELT_EXEC
  }

  capability(): ContainmentCapability {
    this.cached ??= this.probeCapability()
    return { ...this.cached }
  }

  /** Wrap argv for `runner`; the caller checked availability. */
  wrap(
    argv: readonly string[],
    policy: ContainmentPolicy,
    runner: ContainmentRunner,
  ): string[] {
    return runner === 'seatbelt'
      ? [this.seatbeltExec, '-p', seatbeltProfile(policy), '--', ...argv]
      : ['bwrap', ...bwrapArgs(policy), '--', ...argv]
  }

  /** Synchronous decision without asking anyone (an `ask-user` policy is refused). */
  prepare(
    argv: readonly string[],
    policy: ContainmentPolicy,
  ): PreparedContainment {
    const capability = this.capability()
    const policyHash = containmentPolicyHash(policy)
    const env = tempEnv(policy.tempDir)
    if (capability.available && capability.runner)
      return {
        argv: this.wrap(argv, policy, capability.runner),
        env,
        runner: capability.runner,
        receipt: {
          backend: capability.runner,
          decision: 'contained',
          policyHash,
          reason: '',
        },
      }
    return {
      argv: null,
      env,
      runner: null,
      receipt: {
        backend: 'none',
        decision: 'refused',
        policyHash,
        reason:
          policy.fallback === 'ask-user'
            ? `${unavailableReason(capability)}；需要用户同意才能在沙箱外运行`
            : unavailableReason(capability),
      },
    }
  }

  /** Contain, or with no sandbox refuse — or ask, when the policy allows asking. */
  async contain(
    argv: readonly string[],
    policy: ContainmentPolicy,
    consent?: UnsandboxedConsent | null,
  ): Promise<PreparedContainment> {
    const prepared = this.prepare(argv, policy)
    if (prepared.argv !== null || policy.fallback !== 'ask-user' || !consent)
      return prepared
    const reason = unavailableReason(this.capability())
    let allowed = false
    try {
      allowed = (await consent.decide(reason)) === true
    } catch {
      allowed = false
    }
    if (!allowed)
      return {
        ...prepared,
        receipt: {
          ...prepared.receipt,
          reason: `${reason}；用户没有同意在沙箱外运行`,
        },
      }
    return {
      argv: [...argv],
      env: prepared.env,
      runner: null,
      receipt: {
        backend: 'none',
        decision: 'user-allowed-unsandboxed',
        policyHash: prepared.receipt.policyHash,
        reason: `${reason}；用户同意在沙箱外运行`,
      },
    }
  }

  private probeCapability(): ContainmentCapability {
    const platform = this.platform
    if (platform === 'darwin') {
      if (this.options.probe)
        return capabilityFrom(platform, 'seatbelt', this.options.probe())
      if (!existsSync(this.seatbeltExec))
        return capabilityFrom(platform, 'seatbelt', {
          ok: false,
          detail: 'sandbox-exec is missing from the host OS.',
        })
      return capabilityFrom(
        platform,
        'seatbelt',
        runProbe(
          this.seatbeltExec,
          ['-p', '(version 1) (allow default)', '/usr/bin/true'],
          this.options.probeTimeoutMs,
        ),
      )
    }
    if (platform === 'linux') {
      if (this.options.probe)
        return capabilityFrom(platform, 'bwrap', this.options.probe())
      if (this.options.probeBwrap)
        return capabilityFrom(platform, 'bwrap', {
          ok: this.options.probeBwrap(),
          detail: 'bubblewrap probe',
        })
      return capabilityFrom(
        platform,
        'bwrap',
        runProbe(
          'bwrap',
          [
            '--ro-bind',
            '/',
            '/',
            '--dev',
            '/dev',
            '--unshare-pid',
            '--proc',
            '/proc',
            '--die-with-parent',
            '--',
            'true',
          ],
          this.options.probeTimeoutMs,
        ),
      )
    }
    return {
      platform,
      runner: null,
      available: false,
      reason: `No process sandbox is implemented for ${platform}.`,
    }
  }
}

function tempEnv(tempDir: string): Record<string, string> {
  return tempDir ? { TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir } : {}
}

function unavailableReason(capability: ContainmentCapability): string {
  return `进程沙箱不可用：${capability.reason || 'unknown'}`
}

function capabilityFrom(
  platform: string,
  runner: ContainmentRunner,
  result: ContainmentProbeResult,
): ContainmentCapability {
  return {
    platform,
    runner: result.ok ? runner : null,
    available: result.ok,
    reason: result.detail,
  }
}

function runProbe(
  executable: string,
  args: string[],
  timeoutMs = 5_000,
): ContainmentProbeResult {
  try {
    const result = spawnSync(executable, args, {
      shell: false,
      stdio: 'pipe',
      timeout: timeoutMs,
      encoding: 'utf8',
    })
    const detail = String(result.stderr || result.error?.message || '')
      .trim()
      .slice(0, 300)
    return {
      ok: result.status === 0 && !result.error,
      detail:
        detail ||
        (result.status === 0
          ? 'probe passed'
          : `exit ${String(result.status ?? 'unknown')}`),
    }
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof Error ? error.message.slice(0, 300) : 'probe failed',
    }
  }
}
