/**
 * What each Claude Code / Codex version did on this Mac (VER-03).
 *
 * Claude Code ships a release every day or two, and four times in a month
 * a normal change of an external CLI stopped a whole kind of Emperor's
 * work. So Emperor remembers, per executor profile, the last version a
 * task ran on (`lastGood`) and the version failures of each version; when
 * the installed version failed for its version and an earlier one worked,
 * 设置 › 子智能体 offers 退回 to it (`rollbackOffer`), through the same
 * install channel as 升级 (upgrade-service.ts). A version the user went
 * back from is skipped by 升级 until a newer one is published.
 *
 * Kept in `<delegations>/executor-health.json`. DelegationService writes it
 * as runs settle; nothing in it comes from a CLI's output beyond the
 * version its probe read and one bounded line of the failure's reason.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableReplaceSync, quarantineFileSync } from '../../store/persistence'
import { logger } from '../../util/log'
import type { ExecutorProbe } from './types'

const log = logger.child({ component: 'executors' })

export const EXECUTOR_HEALTH_FILE = 'executor-health.json'

/** One finding of the offline self-check (VER-04 runs it). */
export interface SelfCheckIssue {
  code:
    | 'unapproved_plugin'
    | 'mcp_server'
    | 'hooks_not_applied'
    | 'protocol_unknown'
    | 'feature_default_on'
    | 'builtin_not_disabled'
    | 'start_failed'
    | 'timeout'
  /** One Chinese line. */
  detail: string
  /** true: the version is incompatible. */
  blocking: boolean
}

/** The offline self-check of one version (VER-04 writes it here). */
export interface SelfCheckResult {
  backend: 'claude-code' | 'codex'
  version: string
  checkedAt: number
  status: 'ok' | 'adapted' | 'incompatible' | 'error'
  adapted?: { builtinPluginsDisabled: string[] }
  issues: SelfCheckIssue[]
  modelCalls: 0
}

export interface ExecutorVersionHealth {
  firstSeenAt: number
  successes: number
  lastSuccessAt?: number
  versionFailures: number
  lastFailure?: { code: string; reason: string; at: number; runId: string }
  /** Went back from this version: 升级 skips it until a newer one comes. */
  rolledBackFrom?: number
  selfCheck?: SelfCheckResult
}

export interface ExecutorProfileHealth {
  /** Only a run that finished with a final text writes it. */
  lastGood?: { version: string; at: number; runId: string }
  /** The version the last probe found (noteVersion). */
  lastSeenVersion?: string
  versions: Record<string /* version */, ExecutorVersionHealth>
}

/** `<delegations>/executor-health.json` */
export interface ExecutorHealthFile {
  schemaVersion: 1
  profiles: Record<string /* profileId */, ExecutorProfileHealth>
}

/**
 * The failure codes about a CLI's version; VER-06's version notice reads
 * only this set too (the codes are DelegationError's).
 */
export const VERSION_FAILURE_CODES: ReadonlySet<string> = new Set([
  'EXECUTOR_INCOMPATIBLE',
  // VER-04: the self-check found the version incompatible.
  'EXECUTOR_SELF_CHECK_FAILED',
])

/**
 * A failure that says something about the CLI's version. A Codex whose
 * protocol digest is not a verified one (`compatibility: 'unverified'`,
 * registry.ts) counts its start and turn failures as well: they are the
 * likely way an unverified protocol breaks.
 */
export function isVersionFailure(
  code: string,
  probe?: Pick<ExecutorProbe, 'compatibility'>,
): boolean {
  if (VERSION_FAILURE_CODES.has(code)) return true
  return (
    probe?.compatibility === 'unverified' &&
    (code === 'EXECUTOR_START_FAILED' || code === 'EXECUTOR_TURN_FAILED')
  )
}

const RELEASE = /^\d+\.\d+\.\d+$/
const REASON_MAX = 300
const optional = (value: unknown, type: 'number' | 'string') =>
  value === undefined || typeof value === type
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function validVersion(value: unknown): boolean {
  if (!isRecord(value)) return false
  const failure = value.lastFailure
  const check = value.selfCheck
  return (
    typeof value.firstSeenAt === 'number' &&
    typeof value.successes === 'number' &&
    typeof value.versionFailures === 'number' &&
    optional(value.lastSuccessAt, 'number') &&
    optional(value.rolledBackFrom, 'number') &&
    (failure === undefined ||
      (isRecord(failure) &&
        typeof failure.code === 'string' &&
        typeof failure.reason === 'string' &&
        typeof failure.at === 'number' &&
        typeof failure.runId === 'string')) &&
    (check === undefined ||
      (isRecord(check) &&
        typeof check.status === 'string' &&
        Array.isArray(check.issues)))
  )
}

function validProfile(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.versions)) return false
  const good = value.lastGood
  return (
    optional(value.lastSeenVersion, 'string') &&
    (good === undefined ||
      (isRecord(good) &&
        typeof good.version === 'string' &&
        typeof good.at === 'number' &&
        typeof good.runId === 'string')) &&
    Object.values(value.versions).every(validVersion)
  )
}

/** Why 退回 is offered, for the confirmation (「2.1.310 上有 2 次任务…」). */
function because(version: string, health: ExecutorVersionHealth): string {
  if (health.versionFailures > 0)
    return `${version} 上有 ${health.versionFailures} 次任务因版本不兼容失败`
  const issue = health.selfCheck?.issues.find((i) => i.blocking)
  return issue
    ? `${version} 自检不兼容：${issue.detail}`
    : `${version} 自检不兼容`
}

/**
 * Core owns this store under the desktop lifetime state-root writer lock:
 * one instance, every change synchronous, so writes never interleave.
 * Without a folder it keeps everything in memory. A damaged file counts as
 * empty and is renamed `.damaged-<ts>` just before the next write; a file
 * a newer Emperor wrote (schemaVersion above 1) is never moved or
 * rewritten, and this process keeps its own changes in memory. A write
 * that fails is logged and never fails the run or the rollback.
 */
export class ExecutorHealthStore {
  readonly file: string | undefined
  private data: ExecutorHealthFile = { schemaVersion: 1, profiles: {} }
  /** The file on disk is damaged: renamed before the next write. */
  private damaged = false
  /** A newer Emperor's file: read-only here. */
  private newer = false
  private readonly now: () => number
  constructor(root?: string, options: { now?: () => number } = {}) {
    this.file = root ? join(root, EXECUTOR_HEALTH_FILE) : undefined
    this.now = options.now ?? Date.now
    if (!this.file || !existsSync(this.file)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (
        isRecord(raw) &&
        typeof raw.schemaVersion === 'number' &&
        raw.schemaVersion > 1
      ) {
        this.newer = true
        log.warn('executor health written by a newer Emperor; read-only', {
          file: this.file,
        })
        return
      }
      if (
        !isRecord(raw) ||
        raw.schemaVersion !== 1 ||
        !isRecord(raw.profiles) ||
        !Object.values(raw.profiles).every(validProfile)
      )
        throw new Error('unsupported executor health')
      this.data = raw as unknown as ExecutorHealthFile
    } catch (error) {
      this.damaged = true
      log.warn('executor health unreadable; starting empty', {
        file: this.file,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private profile(profileId: string): ExecutorProfileHealth {
    return (this.data.profiles[profileId] ??= { versions: {} })
  }

  private version(profileId: string, version: string): ExecutorVersionHealth {
    return (this.profile(profileId).versions[version] ??= {
      firstSeenAt: this.now(),
      successes: 0,
      versionFailures: 0,
    })
  }

  private save() {
    if (!this.file || this.newer) return
    try {
      if (this.damaged) {
        try {
          quarantineFileSync(
            this.file,
            {},
            `${this.file}.damaged-${this.now()}`,
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        this.damaged = false
      }
      durableReplaceSync(this.file, JSON.stringify(this.data, null, 2) + '\n')
    } catch (error) {
      log.warn('executor health not saved', {
        file: this.file,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * A run on `version` finished with a final text: the last good version.
   * True when that is another version than before (退回 may change).
   */
  recordSuccess(profileId: string, version: string, runId: string): boolean {
    if (!RELEASE.test(version)) return false
    const entry = this.version(profileId, version)
    const profile = this.profile(profileId)
    const moved = profile.lastGood?.version !== version
    const at = this.now()
    entry.successes += 1
    entry.lastSuccessAt = at
    profile.lastGood = { version, at, runId }
    this.save()
    return moved
  }

  /** A run on `version` failed for its version (isVersionFailure). */
  recordFailure(
    profileId: string,
    version: string,
    failure: { code: string; reason: string; runId: string },
  ): void {
    if (!RELEASE.test(version)) return
    const entry = this.version(profileId, version)
    entry.versionFailures += 1
    entry.lastFailure = {
      code: failure.code,
      reason: (failure.reason.split('\n')[0] ?? '').slice(0, REASON_MAX),
      at: this.now(),
      runId: failure.runId,
    }
    this.save()
  }

  /** The version a probe found; `changed` when it is not the last one seen. */
  noteVersion(
    profileId: string,
    version: string,
  ): { changed: boolean; previous?: string } {
    if (!RELEASE.test(version)) return { changed: false }
    const profile = this.profile(profileId)
    const previous = profile.lastSeenVersion
    const known = version in profile.versions
    this.version(profileId, version)
    profile.lastSeenVersion = version
    if (previous !== version || !known) this.save()
    return {
      changed: previous !== version,
      ...(previous !== undefined ? { previous } : {}),
    }
  }

  /**
   * 退回: the last good version, when the installed one is another and it
   * failed for its version or the self-check found it incompatible.
   */
  rollbackOffer(
    profileId: string,
    installed: string | null,
  ): { target: string; because: string } | null {
    const health = this.data.profiles[profileId]
    if (!health?.lastGood || !installed) return null
    if (health.lastGood.version === installed) return null
    const entry = health.versions[installed]
    const bad =
      (entry?.versionFailures ?? 0) > 0 ||
      entry?.selfCheck?.status === 'incompatible'
    return bad && entry
      ? { target: health.lastGood.version, because: because(installed, entry) }
      : null
  }

  /** The rollback away from `fromVersion` succeeded. */
  markRolledBack(profileId: string, fromVersion: string): void {
    if (!RELEASE.test(fromVersion)) return
    this.version(profileId, fromVersion).rolledBackFrom = this.now()
    this.save()
  }

  /** The versions 升级 does not offer: the ones the user went back from. */
  skipped(profileId: string): Set<string> {
    const versions = this.data.profiles[profileId]?.versions ?? {}
    return new Set(
      Object.entries(versions)
        .filter(([, v]) => v.rolledBackFrom !== undefined)
        .map(([version]) => version),
    )
  }
}
