import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { logger as defaultLogger, type Logger } from '../util/log'
import { pidIsAlive } from '../util/stable-process-identity'
import type { StateRootSource } from './paths'
import { migrateSkillPluginSemantics } from './migrate-skill-plugin-semantics'

export const CURRENT_STATE_LAYOUT_VERSION = 1 as const
export type StateLayoutVersion = typeof CURRENT_STATE_LAYOUT_VERSION

export interface InstallationStateV1 {
  schemaVersion: 1
  stateLayoutVersion: StateLayoutVersion
  appVersion: string
  runtimeRevision: string
  initializedAt: string
  updatedAt: string
  emperorHomeSource: StateRootSource
  migration: 'fresh' | 'existing' | 'renamed_legacy' | 'legacy_conflict'
}

export type InstallationBootstrapErrorCode =
  | 'installation_layout_newer'
  | 'installation_lock_busy'
  | 'installation_invalid_state'
  | 'installation_io'

export class InstallationBootstrapError extends Error {
  readonly code: InstallationBootstrapErrorCode
  override readonly cause?: unknown

  constructor(
    code: InstallationBootstrapErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'InstallationBootstrapError'
    this.code = code
    this.cause = cause
  }
}

export interface BootstrapEmperorHomeOptions {
  emperorHome: string
  source: StateRootSource
  legacyHome?: string | null
  appVersion: string
  runtimeRevision: string
  now?: () => string
  /** Liveness probe for the recorded lock holder; injected by tests. */
  pidAlive?: (pid: number) => boolean
  /** Sink for the stale-lock takeover warning; defaults to the process logger. */
  logger?: Logger
}

export interface BootstrapEmperorHomeResult {
  status: 'ready'
  emperorHome: string
  legacyHome: string | null
  migration: InstallationStateV1['migration']
  installation: InstallationStateV1
}

const PRIVATE_DIRS = [
  'skills',
  'memory',
  'memory/profile',
  'sessions',
  'migrations',
  'environment',
  'environment/bin',
  'plugins',
  'plugins/cache',
  'plugins/data',
  'plugins/staging',
  'plugins/marketplaces',
]

const PRIVATE_FILES = [
  'installation.json',
  'settings.json',
  'model_config.json',
  'mcp_config.json',
  'hooks_config.json',
  'onboarding.json',
  'skills/installed.v1.json',
  'environment/registry.v1.json',
  'plugins/known_marketplaces.json',
  'plugins/installed_plugins.json',
]

const PATH_MIGRATION_FILES = [
  'projects/index.json',
  'skills/installed.v1.json',
  'environment/registry.v1.json',
  'plugins/installed_plugins.json',
]

const SKILL_PREVIEW_ID_PATTERN = /^preview_[a-f0-9]{24}$/
const MAX_STAGING_ENTRIES = 1_000
const MAX_PREVIEW_STATE_BYTES = 1024 * 1024

const LOCK_SCHEMA_VERSION = 1
/** A holder that cannot be proven alive here is abandoned once this old. */
const LOCK_STALE_MS = 60_000
/**
 * Even a live pid loses the lock this long after its last heartbeat: after a
 * hard kill or a power loss the recorded pid can belong to an unrelated
 * process, and a bootstrap that never finishes must not strand every launch.
 */
const LOCK_LIVE_HOLDER_STALE_MS = 15 * 60_000

export function bootstrapEmperorHome(
  opts: BootstrapEmperorHomeOptions,
): BootstrapEmperorHomeResult {
  const emperorHome = resolve(opts.emperorHome)
  const legacyHome = opts.legacyHome ? resolve(opts.legacyHome) : null
  const now = opts.now ?? (() => new Date().toISOString())
  mkdirSync(dirname(emperorHome), { recursive: true })
  const lockPath = join(
    dirname(emperorHome),
    `.${basename(emperorHome).replace(/^\./, '')}.bootstrap.lock`,
  )
  let lock: BootstrapLock | null = null
  try {
    lock = acquireBootstrapLock(lockPath, {
      emperorHome,
      now,
      pidAlive: opts.pidAlive ?? pidIsAlive,
      logger: opts.logger ?? defaultLogger,
    })
    const held = lock
    return bootstrapWhileLocked({
      ...opts,
      emperorHome,
      legacyHome,
      now,
      heartbeat: () => held.heartbeat(),
    })
  } catch (error) {
    if (error instanceof InstallationBootstrapError) throw error
    throw new InstallationBootstrapError(
      'installation_io',
      `Failed to initialize Emperor Home: ${emperorHome}`,
      error,
    )
  } finally {
    lock?.release()
  }
}

interface BootstrapLock {
  /** Re-stamp the held lock so a long bootstrap never looks abandoned. */
  heartbeat(): void
  release(): void
}

interface BootstrapLockOptions {
  emperorHome: string
  now: () => string
  pidAlive: (pid: number) => boolean
  logger: Logger
}

interface BootstrapLockOwner {
  pid: number | null
  host: string | null
  token: string | null
  heartbeatAt: string | null
}

interface BootstrapLockSnapshot {
  raw: string
  dev: number
  ino: number
  size: number
  mtimeMs: number
  owner: BootstrapLockOwner | null
}

/**
 * Take the bootstrap lock, reclaiming it from a holder that a crash or a power
 * loss left behind. Only a holder that is provably alive here and still
 * refreshing its heartbeat keeps the lock.
 */
function acquireBootstrapLock(
  lockPath: string,
  opts: BootstrapLockOptions,
): BootstrapLock {
  const token = randomUUID()
  const created = createBootstrapLock(lockPath, token, opts)
  if (created !== null) return created
  const snapshot = readBootstrapLock(lockPath)
  if (snapshot !== null) {
    const holder = classifyBootstrapLockHolder(snapshot, opts)
    if (
      holder.state === 'held' ||
      !removeStaleBootstrapLock(lockPath, snapshot)
    )
      throw new InstallationBootstrapError(
        'installation_lock_busy',
        `Emperor Home bootstrap lock is held by ${holder.description}: ${lockPath}`,
      )
    opts.logger.warn('Reclaimed an abandoned Emperor Home bootstrap lock', {
      lockPath,
      holder: holder.description,
      reason: holder.reason,
    })
  }
  const reclaimed = createBootstrapLock(lockPath, token, opts)
  if (reclaimed !== null) return reclaimed
  throw new InstallationBootstrapError(
    'installation_lock_busy',
    `Emperor Home bootstrap lock is unavailable: ${lockPath}`,
  )
}

/** Create the lock exclusively, or `null` when another holder already has it. */
function createBootstrapLock(
  lockPath: string,
  token: string,
  opts: BootstrapLockOptions,
): BootstrapLock | null {
  let fd: number
  try {
    fd = openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if (isAlreadyExistsError(error)) return null
    throw error
  }
  const startedAt = opts.now()
  const stamp = (): void => {
    const payload = Buffer.from(
      `${JSON.stringify({
        schemaVersion: LOCK_SCHEMA_VERSION,
        pid: process.pid,
        host: hostname(),
        token,
        emperorHome: opts.emperorHome,
        startedAt,
        heartbeatAt: opts.now(),
      })}\n`,
      'utf8',
    )
    writeSync(fd, payload, 0, payload.length, 0)
    ftruncateSync(fd, payload.length)
    fsyncSync(fd)
  }
  try {
    stamp()
  } catch (error) {
    closeSync(fd)
    rmSync(lockPath, { force: true })
    throw error
  }
  return {
    heartbeat() {
      try {
        stamp()
      } catch {
        // The held descriptor stays authoritative until release.
      }
    },
    release() {
      try {
        closeSync(fd)
      } catch {
        // A descriptor that is already gone cannot leak.
      }
      try {
        const current = JSON.parse(readFileSync(lockPath, 'utf8')) as {
          token?: unknown
        }
        if (current.token === token) rmSync(lockPath, { force: true })
      } catch {
        // Never remove a lock whose ownership cannot be proven.
      }
    },
  }
}

function readBootstrapLock(lockPath: string): BootstrapLockSnapshot | null {
  try {
    const info = lstatSync(lockPath)
    if (!info.isFile()) return null
    const raw = readFileSync(lockPath, 'utf8')
    return {
      raw,
      dev: Number(info.dev),
      ino: Number(info.ino),
      size: info.size,
      mtimeMs: info.mtimeMs,
      owner: parseBootstrapLockOwner(raw),
    }
  } catch {
    return null
  }
}

function parseBootstrapLockOwner(raw: string): BootstrapLockOwner | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const pid = record.pid
  return {
    pid:
      typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null,
    host: typeof record.host === 'string' ? record.host : null,
    token: typeof record.token === 'string' ? record.token : null,
    heartbeatAt:
      typeof record.heartbeatAt === 'string' ? record.heartbeatAt : null,
  }
}

function classifyBootstrapLockHolder(
  snapshot: BootstrapLockSnapshot,
  opts: BootstrapLockOptions,
): { state: 'held' | 'stale'; reason: string; description: string } {
  const description = describeBootstrapLockHolder(snapshot)
  const owner = snapshot.owner
  const heartbeatMs = owner?.heartbeatAt
    ? Date.parse(owner.heartbeatAt)
    : Number.NaN
  const age =
    clockMs(opts.now) -
    (Number.isFinite(heartbeatMs) ? heartbeatMs : snapshot.mtimeMs)
  const sameHost = owner?.host === hostname()
  if (owner?.pid != null && sameHost) {
    if (!opts.pidAlive(owner.pid))
      return { state: 'stale', reason: 'holder process is gone', description }
    return age > LOCK_LIVE_HOLDER_STALE_MS
      ? { state: 'stale', reason: 'holder stopped refreshing', description }
      : { state: 'held', reason: 'holder is alive', description }
  }
  // Unreadable contents, or a holder on another host: a pid means nothing
  // here, so only the heartbeat age can tell an owner from residue.
  return age > LOCK_STALE_MS
    ? { state: 'stale', reason: 'lock stopped being refreshed', description }
    : { state: 'held', reason: 'lock was refreshed recently', description }
}

function describeBootstrapLockHolder(snapshot: BootstrapLockSnapshot): string {
  const owner = snapshot.owner
  if (owner === null) return 'an unreadable lock'
  const who =
    owner.pid === null
      ? 'an unidentified process'
      : `pid ${owner.pid}${owner.host === null ? '' : ` on ${owner.host}`}`
  return owner.heartbeatAt === null
    ? who
    : `${who} (heartbeat ${owner.heartbeatAt})`
}

/** Remove the lock only while it is byte-for-byte the residue we inspected. */
function removeStaleBootstrapLock(
  lockPath: string,
  snapshot: BootstrapLockSnapshot,
): boolean {
  try {
    const current = lstatSync(lockPath)
    if (
      !current.isFile() ||
      Number(current.dev) !== snapshot.dev ||
      Number(current.ino) !== snapshot.ino ||
      current.size !== snapshot.size ||
      current.mtimeMs !== snapshot.mtimeMs ||
      readFileSync(lockPath, 'utf8') !== snapshot.raw
    )
      return false
    rmSync(lockPath, { force: true })
    return true
  } catch {
    return false
  }
}

function clockMs(now: () => string): number {
  const parsed = Date.parse(now())
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function bootstrapWhileLocked(
  opts: Omit<BootstrapEmperorHomeOptions, 'now' | 'legacyHome'> & {
    emperorHome: string
    legacyHome: string | null
    now: () => string
    heartbeat: () => void
  },
): BootstrapEmperorHomeResult {
  const hadNewRoot = existsSync(opts.emperorHome)
  const hadLegacyRoot = Boolean(
    opts.source === 'default' && opts.legacyHome && existsSync(opts.legacyHome),
  )
  let migration: InstallationStateV1['migration'] = hadNewRoot
    ? 'existing'
    : 'fresh'

  if (hadNewRoot) assertWritableLayout(opts.emperorHome)

  if (hadNewRoot && hadLegacyRoot) {
    migration = 'legacy_conflict'
  } else if (!hadNewRoot && hadLegacyRoot && opts.legacyHome) {
    writeMigrationReceipt(
      opts.legacyHome,
      'prepared',
      opts.legacyHome,
      opts.emperorHome,
      opts.now(),
    )
    renameSync(opts.legacyHome, opts.emperorHome)
    fsyncDirectory(dirname(opts.emperorHome))
    migration = 'renamed_legacy'
  } else if (!hadNewRoot) {
    mkdirPrivate(opts.emperorHome)
  }

  assertWritableLayout(opts.emperorHome)
  migrateSettingsFile(opts.emperorHome, opts.now())
  createBootstrapSkeleton(opts.emperorHome)
  // The bootstrap is synchronous, so the heartbeat is refreshed at the phase
  // boundaries rather than by a timer that could never fire here.
  opts.heartbeat()
  migrateSkillPluginSemantics({
    emperorHome: opts.emperorHome,
    now: opts.now,
  })
  opts.heartbeat()
  cleanupExpiredSkillPreviews(opts.emperorHome, opts.now())
  opts.heartbeat()
  if (migration === 'renamed_legacy' && opts.legacyHome) {
    migrateKnownAbsolutePaths(
      opts.emperorHome,
      opts.legacyHome,
      opts.emperorHome,
    )
    writeMigrationReceipt(
      opts.emperorHome,
      'applied',
      opts.legacyHome,
      opts.emperorHome,
      opts.now(),
    )
  }

  const timestamp = opts.now()
  const existing = readInstallationState(opts.emperorHome)
  const installation: InstallationStateV1 = {
    schemaVersion: 1,
    stateLayoutVersion: CURRENT_STATE_LAYOUT_VERSION,
    appVersion: opts.appVersion,
    runtimeRevision: opts.runtimeRevision,
    initializedAt: existing?.initializedAt || timestamp,
    updatedAt: timestamp,
    emperorHomeSource: opts.source,
    migration,
  }
  writePrivateJsonAtomic(
    join(opts.emperorHome, 'installation.json'),
    installation,
  )
  normalizeBootstrapPermissions(opts.emperorHome)
  return {
    status: 'ready',
    emperorHome: opts.emperorHome,
    legacyHome: hadLegacyRoot ? opts.legacyHome : null,
    migration,
    installation,
  }
}

function cleanupExpiredSkillPreviews(
  emperorHome: string,
  timestamp: string,
): void {
  const staging = join(emperorHome, 'skills', '.staging')
  if (!existsSync(staging)) return
  const stagingStat = lstatSync(staging)
  if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory())
    throw new InstallationBootstrapError(
      'installation_invalid_state',
      `Skill staging root is unsafe: ${staging}`,
    )
  const now = Date.parse(timestamp)
  if (!Number.isFinite(now)) return
  for (const name of readdirSync(staging)
    .sort()
    .slice(0, MAX_STAGING_ENTRIES)) {
    if (!SKILL_PREVIEW_ID_PATTERN.test(name)) continue
    const previewRoot = join(staging, name)
    try {
      const rootStat = lstatSync(previewRoot)
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) continue
      const previewFile = join(previewRoot, 'preview.json')
      const previewStat = lstatSync(previewFile)
      if (
        previewStat.isSymbolicLink() ||
        !previewStat.isFile() ||
        previewStat.size > MAX_PREVIEW_STATE_BYTES
      )
        continue
      const value = JSON.parse(readFileSync(previewFile, 'utf8')) as {
        expiresAt?: unknown
      }
      const expiresAt =
        typeof value.expiresAt === 'string'
          ? Date.parse(value.expiresAt)
          : Number.NaN
      if (Number.isFinite(expiresAt) && now >= expiresAt)
        rmSync(previewRoot, { recursive: true, force: true })
    } catch {
      // Invalid previews stay isolated for Diagnostics and are never executed.
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  )
}

function assertWritableLayout(emperorHome: string): void {
  const file = join(emperorHome, 'installation.json')
  if (!existsSync(file)) return
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new InstallationBootstrapError(
      'installation_invalid_state',
      `installation.json is invalid: ${file}`,
      error,
    )
  }
  const version = Number(
    raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>).stateLayoutVersion
      : Number.NaN,
  )
  if (Number.isFinite(version) && version > CURRENT_STATE_LAYOUT_VERSION)
    throw new InstallationBootstrapError(
      'installation_layout_newer',
      `Emperor Home layout ${version} is newer than supported layout ${CURRENT_STATE_LAYOUT_VERSION}`,
    )
}

function readInstallationState(
  emperorHome: string,
): InstallationStateV1 | null {
  const file = join(emperorHome, 'installation.json')
  if (!existsSync(file)) return null
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as InstallationStateV1
    return typeof value.initializedAt === 'string' ? value : null
  } catch {
    return null
  }
}

function createBootstrapSkeleton(emperorHome: string): void {
  mkdirPrivate(emperorHome)
  for (const relative of PRIVATE_DIRS) mkdirPrivate(join(emperorHome, relative))
  ensurePrivateJson(join(emperorHome, 'settings.json'), {})
  ensurePrivateJson(join(emperorHome, 'environment', 'registry.v1.json'), {
    schemaVersion: 1,
    tools: {},
  })
  ensurePrivateJson(join(emperorHome, 'plugins', 'known_marketplaces.json'), {
    schemaVersion: 1,
    marketplaces: {},
  })
  ensurePrivateJson(join(emperorHome, 'plugins', 'installed_plugins.json'), {
    schemaVersion: 1,
    plugins: {},
  })
}

function migrateSettingsFile(emperorHome: string, timestamp: string): void {
  const canonical = join(emperorHome, 'settings.json')
  const legacy = join(emperorHome, 'emperor.local.json')
  if (!existsSync(legacy)) return
  if (!existsSync(canonical)) {
    renameSync(legacy, canonical)
    fsyncDirectory(emperorHome)
    return
  }
  const conflicts = join(emperorHome, 'migrations', 'conflicts')
  mkdirPrivate(conflicts)
  const safeTimestamp = timestamp.replace(/[:.]/g, '-')
  renameSync(legacy, join(conflicts, `emperor.local.${safeTimestamp}.json`))
  fsyncDirectory(conflicts)
}

function migrateKnownAbsolutePaths(
  emperorHome: string,
  oldRoot: string,
  newRoot: string,
): void {
  for (const relative of PATH_MIGRATION_FILES) {
    const file = join(emperorHome, relative)
    if (!existsSync(file)) continue
    let value: unknown
    try {
      value = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const migrated = replaceRootStrings(value, oldRoot, newRoot)
    if (migrated.changed) writePrivateJsonAtomic(file, migrated.value)
  }
}

function replaceRootStrings(
  input: unknown,
  oldRoot: string,
  newRoot: string,
): { value: unknown; changed: boolean } {
  if (typeof input === 'string') {
    if (input === oldRoot || input.startsWith(`${oldRoot}/`))
      return {
        value: `${newRoot}${input.slice(oldRoot.length)}`,
        changed: true,
      }
    return { value: input, changed: false }
  }
  if (Array.isArray(input)) {
    let changed = false
    const value = input.map((item) => {
      const next = replaceRootStrings(item, oldRoot, newRoot)
      changed ||= next.changed
      return next.value
    })
    return { value, changed }
  }
  if (input && typeof input === 'object') {
    let changed = false
    const value: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(input)) {
      const next = replaceRootStrings(item, oldRoot, newRoot)
      changed ||= next.changed
      value[key] = next.value
    }
    return { value, changed }
  }
  return { value: input, changed: false }
}

function writeMigrationReceipt(
  root: string,
  phase: 'prepared' | 'applied',
  oldRoot: string,
  newRoot: string,
  timestamp: string,
): void {
  const migrations = join(root, 'migrations')
  mkdirPrivate(migrations)
  writePrivateJsonAtomic(join(migrations, `home-layout-v1.${phase}.json`), {
    schemaVersion: 1,
    phase,
    oldRoot,
    newRoot,
    timestamp,
  })
}

function ensurePrivateJson(path: string, value: unknown): void {
  if (existsSync(path)) return
  writePrivateJsonAtomic(path, value)
}

function writePrivateJsonAtomic(path: string, value: unknown): void {
  mkdirPrivate(dirname(path))
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  fsyncDirectory(dirname(path))
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(path, 0o700)
}

function normalizeBootstrapPermissions(emperorHome: string): void {
  if (process.platform === 'win32') return
  mkdirPrivate(emperorHome)
  for (const relative of [...PRIVATE_DIRS, 'skills/.staging']) {
    const path = join(emperorHome, relative)
    if (existsSync(path) && statSync(path).isDirectory()) chmodSync(path, 0o700)
  }
  for (const relative of PRIVATE_FILES) {
    const path = join(emperorHome, relative)
    if (existsSync(path) && statSync(path).isFile()) chmodSync(path, 0o600)
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
