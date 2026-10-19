/**
 * Local process sandbox (ported from dsh-sandbox-local).
 *
 * Platform chain: macOS → Seatbelt (`sandbox-exec`), Linux → bubblewrap
 * (functionally probed once). Every other platform has no backend and fails
 * closed: confined modes throw SANDBOX_UNAVAILABLE and the command never
 * runs unconfined.
 */

import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalPath,
  SandboxUnavailableError,
  writableRoots,
  type ConfinedSandboxMode,
  type SandboxPolicy,
} from './policy'
import {
  protectedAncestors,
  protectedEntries,
  protectedPathSpellings,
  type ProtectedEntry,
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

type Runner = 'bwrap' | 'seatbelt'

const PLATFORM_CHAINS: Record<string, readonly Runner[]> = {
  linux: ['bwrap'],
  darwin: ['seatbelt'],
}

const DENIAL_SIGNATURES: Record<Runner, readonly string[]> = {
  bwrap: ['read-only file system'],
  seatbelt: ['operation not permitted'],
}

const RUNNER_FAILURE_RULES: Record<Runner, readonly RunnerFailureRule[]> = {
  bwrap: [{ fatalSignatures: ['bwrap: '] }],
  seatbelt: [{ fatalSignatures: ['sandbox-exec: '] }],
}

/** bwrap mounts: read-only root; workspace-write binds the workspace and a private /tmp. */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
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
  if (policy.privateTempRoot !== undefined) {
    args.push('--tmpfs', '/tmp')
    for (const root of writableRoots(policy)) args.push('--bind', root, root)
    for (const file of policy.writableFiles ?? [])
      args.push('--bind', file, file)
    for (const root of policy.readOnlyRoots ?? [])
      args.push('--ro-bind', root, root)
  } else if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

function canonicalChild(root: string, ...parts: string[]): string {
  return parts.reduce(
    (current, part) => canonicalPath(join(current, part)),
    canonicalPath(root),
  )
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

/**
 * The protected-path table (protected-state.ts) as Seatbelt rules, appended
 * after every allow so it wins: `state` and `config` are never read or
 * written; `credential` paths are never written and, in confined modes,
 * never read, except single files the host granted to an external runtime
 * it launches (Codex's own auth.json, AGT-03). Renaming Emperor Home or a
 * credential path's parents is refused too, so nothing moves out from under
 * the rules.
 */
function protectedPathRules(
  scope: ProtectedPathScope,
  confined: boolean,
  hostGrantedFiles: readonly string[],
): string[] {
  const entries = protectedEntries(scope)
  const forms: string[] = []
  for (const entry of entries)
    if (entry.class === 'credential')
      forms.push(
        `(deny ${confined ? 'file-read* ' : ''}file-write* ${sbplFilter(entry)})`,
      )
  for (const file of hostGrantedFiles)
    forms.push(
      `(allow file-read* file-write* (literal ${sbplString(canonicalPath(file))}))`,
    )
  for (const entry of entries)
    if (entry.class !== 'credential')
      forms.push(`(deny file-read* file-write* ${sbplFilter(entry)})`)
  for (const directory of protectedAncestors(scope))
    forms.push(`(deny file-write* (literal ${sbplString(directory)}))`)
  return forms
}

function protectedScope(
  stateRoot: string | undefined,
  home: string | undefined,
): ProtectedPathScope | null {
  return stateRoot === undefined ? null : { stateRoot, home: home ?? homedir() }
}

/**
 * Seatbelt SBPL profile: allow default, deny file writes except /dev/null
 * and writable roots; with a protected Emperor Home, the protected-path
 * table on top (`protectedHome` defaults to the user's home folder).
 */
export function seatbeltProfileArgs(
  policy: SandboxPolicy,
  protectedStateRoot?: string,
  protectedHome?: string,
): string[] {
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal ${sbplString('/dev/null')}))`,
  ]
  if (policy.processBoundaryTag) {
    const root = '/private/tmp/emperor-boundary-' + policy.processBoundaryTag
    forms.push(
      `(deny file-read-data (literal ${sbplString(root + '-denied')}))`,
    )
    forms.push(
      `(allow file-read-data (literal ${sbplString(root + '-allowed')}))`,
    )
  }
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(
      `(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(' ')})`,
    )
  }
  // Exact files only: the holder may rewrite them in place, but cannot
  // create, rename or delete anything beside them.
  for (const file of policy.writableFiles ?? [])
    forms.push(
      `(allow file-write* (literal ${sbplString(canonicalPath(file))}))`,
    )
  for (const root of policy.readOnlyRoots ?? [])
    forms.push(
      `(deny file-write* (subpath ${sbplString(canonicalPath(root))}))`,
    )
  // Hooks run when the user's own git commits or checks out: a confined
  // Shell may not plant one. Samples from git init / clone stay writable.
  forms.push(
    '(deny file-write* (regex #"/\\.git/(modules/.+/)?hooks/[^/]+$"))',
    '(allow file-write* (regex #"/\\.git/(modules/.+/)?hooks/[^/]+\\.sample$"))',
  )
  // E-M13: these operations were checked against a real sandbox-exec child.
  // They apply only to confined Shell modes, never danger-full-access.
  forms.push(
    '(deny appleevent-send)',
    '(deny mach-lookup (global-name "com.apple.windowserver.active"))',
    '(deny mach-lookup (global-name "com.apple.windowserver"))',
  )
  const socketDirectories = new Set([
    canonicalChild(homedir(), '.emperor', 'run'),
    canonicalChild(tmpdir(), `emperor-${process.getuid?.() ?? 0}`),
    // The Computer Use helper socket follows EMPEROR_CONFIG_DIR.
    ...(protectedStateRoot === undefined
      ? []
      : [canonicalChild(protectedStateRoot, 'run')]),
  ])
  for (const directory of socketDirectories)
    forms.push(
      `(deny network-outbound (remote unix-socket (path-regex ${sbplString(pathPrefixRegex(directory))})))`,
    )
  const scope = protectedScope(protectedStateRoot, protectedHome)
  // Computer Use and browser state, Emperor's config files and the user's
  // credentials: the table the file and search tools refuse too.
  if (scope !== null)
    forms.push(...protectedPathRules(scope, true, policy.writableFiles ?? []))
  return ['-p', forms.join(' ')]
}

/**
 * danger-full-access Shell: nothing is confined except the protected-path
 * table, so an approved escalation never opens Emperor's private state or
 * config files, and no mode writes the user's credentials.
 */
export function seatbeltGuardArgs(
  protectedStateRoot: string,
  protectedHome?: string,
): string[] {
  const scope = protectedScope(protectedStateRoot, protectedHome)!
  return [
    '-p',
    [
      '(version 1)',
      '(allow default)',
      ...protectedPathRules(scope, false, []),
    ].join(' '),
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
}

export class LocalSandbox implements SandboxBackend {
  private selected: Runner | 'unavailable' | undefined

  constructor(private readonly options: LocalSandboxOptions = {}) {}

  /** Whether confined modes can run on this host. */
  available(): boolean {
    this.selected ??= this.chainVerdict()
    return this.selected !== 'unavailable'
  }

  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    const runner = this.select(policy.mode)
    const runnerArgv =
      runner === 'bwrap'
        ? ['bwrap', ...bwrapProfileArgs(policy)]
        : [
            this.options.seatbeltExec ?? 'sandbox-exec',
            ...seatbeltProfileArgs(
              policy,
              this.options.protectedStateRoot,
              this.options.protectedHome,
            ),
          ]
    return {
      argv: [...runnerArgv, '--', ...argv],
      enforcement: 'full',
      denialSignatures: DENIAL_SIGNATURES[runner],
      runnerFailureRules: RUNNER_FAILURE_RULES[runner],
    }
  }

  guard(argv: readonly string[]): ConfinedArgv | null {
    const stateRoot = this.options.protectedStateRoot
    if (stateRoot === undefined) return null
    this.selected ??= this.chainVerdict()
    if (this.selected !== 'seatbelt') return null
    return {
      argv: [
        this.options.seatbeltExec ?? 'sandbox-exec',
        ...seatbeltGuardArgs(stateRoot, this.options.protectedHome),
        '--',
        ...argv,
      ],
      enforcement: 'partial',
      denialSignatures: DENIAL_SIGNATURES.seatbelt,
      runnerFailureRules: RUNNER_FAILURE_RULES.seatbelt,
      denialPaths: protectedPathSpellings({
        stateRoot,
        home: this.options.protectedHome ?? homedir(),
      }),
    }
  }

  private select(mode: ConfinedSandboxMode): Runner {
    this.selected ??= this.chainVerdict()
    if (this.selected === 'unavailable') throw new SandboxUnavailableError(mode)
    return this.selected
  }

  private chainVerdict(): Runner | 'unavailable' {
    const chain =
      PLATFORM_CHAINS[this.options.platform ?? process.platform] ?? []
    for (const runner of chain) {
      if (runner === 'seatbelt') return runner
      const probe =
        this.options.probeBwrap ??
        (() =>
          spawnSync(
            'bwrap',
            [
              ...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }),
              '--',
              'true',
            ],
            { timeout: this.options.probeTimeoutMs ?? 5_000, stdio: 'ignore' },
          ).status === 0)
      if (probe()) return runner
    }
    return 'unavailable'
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
