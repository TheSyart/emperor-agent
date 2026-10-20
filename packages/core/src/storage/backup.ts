/**
 * 备份与恢复 of an Emperor Home (REL-03), the folder side: main zips the
 * folder `stageHomeBackup` writes (`ditto`), unzips a backup into
 * `<home>/migrations/` and asks `scheduleHomeRestore`; the next start
 * calls `applyPendingRestore` before anything opens the home.
 *
 * A backup folder: `emperor-backup.json` (the manifest), `home/` (the
 * files, at their paths in the Emperor Home), and with a passphrase
 * `credentials.emperor-vault` (SEC-09's sealed vault and local key; main
 * imports it, Core never reads it).
 *
 * What a backup holds, by category: 设置与配置, 记忆, Skills、插件与智能体,
 * 项目与定时任务, and optionally 会话. Never: installation.json, the local
 * key and the vault (only sealed, above), browser profiles and downloads,
 * logs, the managed environment, the runtime and temp folders, delegation
 * homes, earlier migration backups. Plain API keys and MCP secrets are
 * sealed with the local key in the copy (dropped when it cannot seal).
 * Files sealed with the local key that hold credentials of their own
 * (`delegations/credentials.json`, AGT-02's Claude token) go in only with
 * the vault, and come back only when the vault was imported.
 *
 * A restore replaces only the categories the backup has: what is there now
 * moves to `<home>/migrations/backup-<ts>/` first (same paths), then the
 * backup's files move in; a failure moves everything back. Either way the
 * run is a line in `migrations/log.jsonl`. Loaded on demand only.
 */
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { modelApiKeyContext } from '../config/model-config'
import { EmperorError } from '../errors'
import { sealMcpSecrets } from '../mcp/config'
import {
  appendMigrationLog,
  createBackupFolder,
  setDataVersion,
} from '../migrations/runner'
import { readInstalledDataVersion } from '../runtime/data-version'
import {
  SECRET_FIELD_NAME,
  isSealedSecret,
  type SecretSealer,
} from '../security/secret-sealer'

export const BACKUP_FORMAT = 'emperor-backup'
export const BACKUP_VERSION = 1
export const BACKUP_MANIFEST = 'emperor-backup.json'
export const BACKUP_CREDENTIALS = 'credentials.emperor-vault'
export const BACKUP_EXTENSION = '.emperor-backup.zip'

const PENDING = join('migrations', 'restore-pending')
const PENDING_MARKER = 'restore.json'

export type BackupCategoryId =
  'config' | 'memory' | 'extensions' | 'projects' | 'sessions' | 'credentials'

interface Root {
  /** Relative to the Emperor Home (`/`-separated). */
  path: string
  /** Children of a folder root left where they are. */
  exclude?: readonly string[]
}

interface Category {
  id: BackupCategoryId
  title: string
  description: string
  optional: boolean
  roots: readonly Root[]
}

const files = (...paths: string[]): Root[] => paths.map((path) => ({ path }))

const CATEGORIES: readonly Category[] = [
  {
    id: 'config',
    title: '设置与配置',
    description: '设置、模型、MCP、Hooks 与子智能体设置',
    optional: false,
    roots: files(
      'settings.json',
      'model_config.json',
      'mcp_config.json',
      'hooks.json',
      'onboarding.json',
      'delegations/config.json',
      'delegations/consent.json',
    ),
  },
  {
    id: 'memory',
    title: '记忆',
    description: '长期记忆、用户档案与版本历史',
    optional: false,
    roots: [{ path: 'memory', exclude: ['attachments', 'media'] }],
  },
  {
    id: 'extensions',
    title: 'Skills、插件与智能体',
    description: '你安装和编写的 Skills、插件与自定义智能体',
    optional: false,
    roots: [
      { path: 'skills', exclude: ['.staging'] },
      { path: 'agents' },
      { path: 'plugins', exclude: ['staging'] },
    ],
  },
  {
    id: 'projects',
    title: '项目与定时任务',
    description: '项目设置和定时任务',
    optional: false,
    roots: [
      { path: 'projects' },
      { path: 'scheduler', exclude: ['scheduler.lock'] },
    ],
  },
  {
    id: 'sessions',
    title: '会话',
    description: '会话记录、附件与用量记录',
    optional: true,
    roots: [
      { path: 'sessions', exclude: ['.scratch'] },
      ...files('memory/attachments', 'memory/media', 'tokens'),
    ],
  },
  {
    // Only with the vault, under SEC-09's passphrase: sealed with the
    // local key, which a plain backup never holds. Not listed on its own.
    id: 'credentials',
    title: '子智能体的登录凭据',
    description: '与密码管理器一起，用备份口令加密',
    optional: true,
    roots: files('delegations/credentials.json'),
  },
]

/** What a backup never holds, for the dialog. */
export const BACKUP_EXCLUDED = [
  '浏览器登录资料与缓存',
  'Agent 下载的文件',
  '日志',
  '受管环境工具',
  '运行时与临时文件',
  '子智能体的运行目录',
]

/** Left out at any depth: locks, half-written and set-aside copies. */
function junk(name: string): boolean {
  return (
    name === '.DS_Store' ||
    name.endsWith('.lock') ||
    /\.tmp(-|$)/.test(name) ||
    name.includes('.corrupt-')
  )
}

export class HomeBackupError extends EmperorError {
  constructor(message: string) {
    super(message, 'home_backup_invalid')
  }
}

const NOT_A_BACKUP = '这个文件不是 Emperor 备份，或已经损坏。'

export interface HomeBackupManifest {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: string
  appVersion: string
  dataVersion: number
  categories: BackupCategoryId[]
  credentials: boolean
  files: number
  bytes: number
}

export interface BackupPlanCategory {
  id: BackupCategoryId
  title: string
  description: string
  optional: boolean
  files: number
  bytes: number
}

export interface BackupPlan {
  categories: BackupPlanCategory[]
  excluded: string[]
}

interface Tally {
  files: number
  bytes: number
}

/** Walk `from` (a file or folder); `copyTo` copies it as it goes. */
function walk(
  from: string,
  tally: Tally,
  copyTo: string | null,
  exclude: readonly string[] = [],
): void {
  let info
  try {
    info = lstatSync(from)
  } catch {
    return
  }
  if (info.isFile()) {
    tally.files += 1
    tally.bytes += info.size
    if (copyTo !== null) {
      mkdirSync(dirname(copyTo), { recursive: true, mode: 0o700 })
      copyFileSync(from, copyTo, constants.COPYFILE_FICLONE)
      chmodSync(copyTo, 0o600)
    }
    return
  }
  // Links, sockets and pipes are never part of a backup.
  if (!info.isDirectory()) return
  if (copyTo !== null) mkdirSync(copyTo, { recursive: true, mode: 0o700 })
  for (const name of readdirSync(from)) {
    if (exclude.includes(name) || junk(name)) continue
    walk(join(from, name), tally, copyTo === null ? null : join(copyTo, name))
  }
}

function chosen(includeSessions: boolean, credentials: boolean): Category[] {
  return CATEGORIES.filter(
    (category) =>
      (includeSessions || category.id !== 'sessions') &&
      (credentials || category.id !== 'credentials'),
  )
}

/** What a backup of `home` would hold now, by category. */
export function planHomeBackup(home: string): BackupPlan {
  return {
    categories: chosen(true, false).map((category) => {
      const tally = { files: 0, bytes: 0 }
      for (const root of category.roots)
        walk(join(home, root.path), tally, null, root.exclude)
      return {
        id: category.id,
        title: category.title,
        description: category.description,
        optional: category.optional,
        ...tally,
      }
    }),
    excluded: [...BACKUP_EXCLUDED],
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/** Plain secrets in the copied configs: sealed, or dropped when it cannot. */
function sealCopies(home: string, sealer: SecretSealer | null): void {
  const usable = sealer?.available ? sealer : null
  const models = readJson(join(home, 'model_config.json'))
  if (models && Array.isArray(models.models)) {
    models.models = models.models.map((entry: unknown) => {
      const record = entry as Record<string, unknown>
      const key = record?.apiKey
      if (typeof key !== 'string' || !key || isSealedSecret(key)) return entry
      let sealed: string | null = null
      try {
        sealed = usable
          ? usable.seal(key, modelApiKeyContext(String(record.entryId)))
          : null
      } catch {
        sealed = null
      }
      return { ...record, apiKey: sealed }
    })
    writeJson(join(home, 'model_config.json'), models)
  }
  const mcp = readJson(join(home, 'mcp_config.json'))
  if (!mcp) return
  let raw = mcp
  if (usable)
    try {
      raw = sealMcpSecrets(mcp, usable).raw
    } catch {
      raw = mcp
    }
  for (const config of Object.values(
    (raw.servers as Record<string, Record<string, unknown>>) ?? {},
  ))
    for (const field of ['headers', 'env'] as const) {
      const values = config?.[field] as Record<string, unknown> | undefined
      if (!values || typeof values !== 'object') continue
      for (const [name, value] of Object.entries(values))
        if (
          typeof value === 'string' &&
          SECRET_FIELD_NAME.test(name) &&
          !isSealedSecret(value) &&
          !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)
        )
          delete values[name]
    }
  writeJson(join(home, 'mcp_config.json'), raw)
}

/** Copy the backup scope of `home` into `folder` (created) with its manifest. */
export async function stageHomeBackup(opts: {
  home: string
  folder: string
  includeSessions: boolean
  appVersion: string
  now?: () => Date
  /** SEC-09's sealed vault and local key; only with a passphrase. */
  credentials?: Buffer | null
  sealer?: SecretSealer | null
}): Promise<HomeBackupManifest> {
  const target = join(opts.folder, 'home')
  mkdirSync(target, { recursive: true, mode: 0o700 })
  chmodSync(opts.folder, 0o700)
  const tally = { files: 0, bytes: 0 }
  const categories = chosen(opts.includeSessions, Boolean(opts.credentials))
  for (const category of categories)
    for (const root of category.roots)
      walk(
        join(opts.home, root.path),
        tally,
        join(target, root.path),
        root.exclude,
      )
  sealCopies(target, opts.sealer ?? null)
  if (opts.credentials)
    writeFileSync(join(opts.folder, BACKUP_CREDENTIALS), opts.credentials, {
      mode: 0o600,
    })
  const manifest: HomeBackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: (opts.now ?? (() => new Date()))().toISOString(),
    appVersion: opts.appVersion,
    dataVersion: readInstalledDataVersion(opts.home),
    categories: categories.map((category) => category.id),
    credentials: Boolean(opts.credentials),
    ...tally,
  }
  writeJson(join(opts.folder, BACKUP_MANIFEST), manifest)
  return manifest
}

function allowed(
  path: string,
  categories: readonly BackupCategoryId[],
): boolean {
  return CATEGORIES.some(
    (category) =>
      categories.includes(category.id) &&
      category.roots.some((root) => {
        if (path === root.path) return true
        if (!path.startsWith(`${root.path}/`)) return false
        const child = path.slice(root.path.length + 1).split('/')[0]!
        return !root.exclude?.includes(child)
      }),
  )
}

/** Every file and folder under `root`, `/`-separated; links refused. */
function entriesOf(root: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name
    const info = lstatSync(join(root, rel))
    if (info.isDirectory()) out.push(...entriesOf(root, rel))
    else if (info.isFile()) out.push(rel)
    else throw new HomeBackupError('备份里有符号链接或特殊文件，无法恢复。')
  }
  return out
}

/** The manifest of a backup folder, once everything in it checks out. */
export function readHomeBackup(folder: string): {
  manifest: HomeBackupManifest
} {
  const manifest = readJson(join(folder, BACKUP_MANIFEST))
  if (!manifest || manifest.format !== BACKUP_FORMAT)
    throw new HomeBackupError(NOT_A_BACKUP)
  if (Number(manifest.version) > BACKUP_VERSION)
    throw new HomeBackupError(
      '这个备份来自更新版本的 Emperor，请先升级 Emperor 再恢复。',
    )
  const categories = manifest.categories
  if (
    manifest.version !== BACKUP_VERSION ||
    !Array.isArray(categories) ||
    !categories.every((id) => CATEGORIES.some((item) => item.id === id)) ||
    typeof manifest.createdAt !== 'string' ||
    typeof manifest.appVersion !== 'string'
  )
    throw new HomeBackupError(NOT_A_BACKUP)
  const home = join(folder, 'home')
  if (!existsSync(home) || !lstatSync(home).isDirectory())
    throw new HomeBackupError(NOT_A_BACKUP)
  for (const path of entriesOf(home))
    if (!allowed(path, categories as BackupCategoryId[]))
      throw new HomeBackupError(`备份里有不该恢复的文件：${path}`)
  return { manifest: manifest as unknown as HomeBackupManifest }
}

export function pendingRestoreExists(home: string): boolean {
  return existsSync(join(home, PENDING, PENDING_MARKER))
}

function moveFolder(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    cpSync(from, to, { recursive: true, verbatimSymlinks: true })
    rmSync(from, { recursive: true, force: true })
  }
}

/**
 * Put a checked backup folder in place for the next start (an earlier
 * scheduled one is replaced). The sealed vault is not kept: main imports
 * it before this.
 */
export function scheduleHomeRestore(opts: {
  home: string
  folder: string
  /** The vault was imported: its companion credential files come back too. */
  withCredentials?: boolean
}): void {
  const { manifest } = readHomeBackup(opts.folder)
  const pending = join(opts.home, PENDING)
  rmSync(pending, { recursive: true, force: true })
  mkdirSync(dirname(pending), { recursive: true, mode: 0o700 })
  moveFolder(opts.folder, pending)
  rmSync(join(pending, BACKUP_CREDENTIALS), { force: true })
  const scheduled = {
    ...manifest,
    categories: manifest.categories.filter(
      (id) => opts.withCredentials || id !== 'credentials',
    ),
  }
  if (!opts.withCredentials)
    for (const root of CATEGORIES.find((item) => item.id === 'credentials')!
      .roots)
      rmSync(join(pending, 'home', root.path), { recursive: true, force: true })
  writeJson(join(pending, BACKUP_MANIFEST), scheduled)
  writeJson(join(pending, PENDING_MARKER), {
    ...scheduled,
    scheduledAt: new Date().toISOString(),
  })
}

export interface RestoreResult {
  status: 'applied' | 'rolled_back'
  /** `migrations/backup-<ts>`: the data the restore replaced. */
  backup: string | null
  categories: BackupCategoryId[]
  backupCreatedAt: string | null
  error?: string
}

/** The paths that move for `root`: itself, or its children but excluded. */
function unitsOf(base: string, root: Root): string[] {
  const path = join(base, root.path)
  let info
  try {
    info = lstatSync(path)
  } catch {
    return []
  }
  if (!root.exclude) return [root.path]
  if (!info.isDirectory()) return []
  return readdirSync(path)
    .filter((name) => !root.exclude!.includes(name) && !junk(name))
    .map((name) => `${root.path}/${name}`)
}

/** Apply the restore `scheduleHomeRestore` left; null when there is none. */
export function applyPendingRestore(opts: {
  home: string
  now?: () => Date
  /** Tests: called before each move (a throw fails the restore there). */
  beforeMove?: (from: string, to: string) => void
}): RestoreResult | null {
  const { home } = opts
  const pending = join(home, PENDING)
  if (!existsSync(join(pending, PENDING_MARKER))) {
    rmSync(pending, { recursive: true, force: true })
    return null
  }
  const at = (opts.now ?? (() => new Date()))()
  const moves: Array<[string, string]> = []
  let backup: string | null = null
  let manifest: HomeBackupManifest | null = null
  const move = (from: string, to: string): void => {
    opts.beforeMove?.(from, to)
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    renameSync(from, to)
    moves.push([from, to])
  }
  try {
    manifest = readHomeBackup(pending).manifest
    backup = createBackupFolder(home, at)
    const categories = CATEGORIES.filter((category) =>
      manifest!.categories.includes(category.id),
    )
    for (const category of categories)
      for (const root of category.roots)
        for (const unit of unitsOf(home, root))
          move(join(home, unit), join(home, backup, unit))
    for (const category of categories)
      for (const root of category.roots)
        for (const unit of unitsOf(join(pending, 'home'), root))
          move(join(pending, 'home', unit), join(home, unit))
    setDataVersion(home, manifest.dataVersion)
    rmSync(pending, { recursive: true, force: true })
    const result: RestoreResult = {
      status: 'applied',
      backup,
      categories: manifest.categories,
      backupCreatedAt: manifest.createdAt,
    }
    appendMigrationLog(home, {
      at: at.toISOString(),
      kind: 'restore',
      status: 'applied',
      backup,
      categories: manifest.categories,
      backupCreatedAt: manifest.createdAt,
      backupAppVersion: manifest.appVersion,
    })
    return result
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    let rolledBack = true
    for (const [from, to] of moves.reverse())
      try {
        mkdirSync(dirname(from), { recursive: true, mode: 0o700 })
        renameSync(to, from)
      } catch {
        rolledBack = false
      }
    // Kept for a person to look at; never tried again at every start.
    const failed = join(
      home,
      'migrations',
      `restore-failed-${at.toISOString().replace(/[:.]/g, '-')}`,
    )
    try {
      moveFolder(pending, failed)
    } catch {
      rmSync(pending, { recursive: true, force: true })
    }
    appendMigrationLog(home, {
      at: at.toISOString(),
      kind: 'restore',
      status: rolledBack ? 'rolled_back' : 'rollback_failed',
      backup,
      error,
      failed: relative(home, failed).split(sep).join('/'),
    })
    return {
      status: 'rolled_back',
      backup,
      categories: manifest?.categories ?? [],
      backupCreatedAt: manifest?.createdAt ?? null,
      error,
    }
  }
}
