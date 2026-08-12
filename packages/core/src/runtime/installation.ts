import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
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
  let lockFd: number | null = null
  try {
    try {
      lockFd = openSync(lockPath, 'wx', 0o600)
      writeFileSync(
        lockFd,
        JSON.stringify({ pid: process.pid, emperorHome, startedAt: now() }) +
          '\n',
      )
      fsyncSync(lockFd)
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error
      throw new InstallationBootstrapError(
        'installation_lock_busy',
        `Emperor Home bootstrap lock is unavailable: ${lockPath}`,
        error,
      )
    }

    return bootstrapWhileLocked({
      ...opts,
      emperorHome,
      legacyHome,
      now,
    })
  } catch (error) {
    if (error instanceof InstallationBootstrapError) throw error
    throw new InstallationBootstrapError(
      'installation_io',
      `Failed to initialize Emperor Home: ${emperorHome}`,
      error,
    )
  } finally {
    if (lockFd !== null) closeSync(lockFd)
    if (lockFd !== null) rmSync(lockPath, { force: true })
  }
}

function bootstrapWhileLocked(
  opts: Omit<BootstrapEmperorHomeOptions, 'now' | 'legacyHome'> & {
    emperorHome: string
    legacyHome: string | null
    now: () => string
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
  migrateSkillPluginSemantics({
    emperorHome: opts.emperorHome,
    now: opts.now,
  })
  cleanupExpiredSkillPreviews(opts.emperorHome, opts.now())
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
