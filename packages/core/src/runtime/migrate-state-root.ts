import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'
import type { RuntimePaths } from './paths'

const LEGACY_MEMORY_STATE_PREFIXES = ['control', 'scheduler', 'tasks', 'external']
const LEGACY_DOTEMPEROR_STATE_PREFIXES = LEGACY_MEMORY_STATE_PREFIXES.map((name) => `memory/${name}`)

export interface LegacyStateMigrationEntry {
  ts: string
  action: 'copied' | 'skipped_corrupt_json'
  legacy:
    | 'memory'
    | 'sessions'
    | '.team'
    | 'control'
    | 'memory-control'
    | 'scheduler'
    | 'memory-scheduler'
    | 'tasks'
    | 'memory-tasks'
    | 'external'
    | 'memory-external'
    | 'tokens'
    | 'config'
    | 'projects-index'
    | 'emperor-state-root'
    | 'user-profile-path'
  rel_path: string
  source: string
  dest: string | null
  reason?: string
}

export interface LegacyStateRootInfo {
  path: string
  kind: 'ancient-bare-runtime-root' | 'previous-dotemperor-root'
  existed: boolean
}

export interface LegacyStateMigrationResult {
  copied: number
  skipped: number
  logPath: string
  reportPath: string
  entries: LegacyStateMigrationEntry[]
  legacyStateRoots: LegacyStateRootInfo[]
}

/** Legacy layout evolution:
 * 1. Ancient: memory/sessions/.team lived directly under runtimeRoot (pre-`.emperor` nesting).
 * 2. Previous default (before this global-store migration): stateRoot defaulted to
 *    `runtimeRoot/.emperor`, so an entire private-state tree lives there.
 * Both are detected and migrated (non-destructively) into the new stateRoot. */
export function migrateLegacyStateRoot(paths: RuntimePaths): LegacyStateMigrationResult {
  mkdirSync(paths.stateRoot, { recursive: true })
  const logPath = join(paths.stateRoot, 'migration-log.jsonl')
  const reportPath = join(paths.stateRoot, 'migrations', 'state-root-migration.json')
  const logged = readLoggedKeys(logPath)
  const result: LegacyStateMigrationResult = { copied: 0, skipped: 0, logPath, reportPath, entries: [], legacyStateRoots: [] }

  const ancientRoots: Array<{ path: string; legacy: LegacyStateMigrationEntry['legacy']; to: string }> = [
    { path: join(paths.runtimeRoot, 'memory'), legacy: 'memory', to: paths.memoryRoot },
    { path: join(paths.runtimeRoot, 'sessions'), legacy: 'sessions', to: paths.sessionsRoot },
    { path: join(paths.runtimeRoot, '.team'), legacy: '.team', to: paths.teamRoot },
    { path: join(paths.runtimeRoot, 'control'), legacy: 'control', to: paths.controlRoot },
    { path: join(paths.runtimeRoot, 'scheduler'), legacy: 'scheduler', to: paths.schedulerRoot },
    { path: join(paths.runtimeRoot, 'tasks'), legacy: 'tasks', to: paths.tasksRoot },
    { path: join(paths.runtimeRoot, 'external'), legacy: 'external', to: paths.externalRoot },
    { path: join(paths.runtimeRoot, 'tokens'), legacy: 'tokens', to: join(paths.stateRoot, 'tokens') },
  ]
  for (const root of ancientRoots) {
    result.legacyStateRoots.push({ path: root.path, kind: 'ancient-bare-runtime-root', existed: existsSync(root.path) })
    copyTree({
      legacy: root.legacy,
      from: root.path,
      to: root.to,
      logPath,
      logged,
      result,
      excludeRelPrefixes: root.legacy === 'memory' ? LEGACY_MEMORY_STATE_PREFIXES : undefined,
    })
  }
  migrateLegacyStateSubdirsFromMemory(paths.runtimeRoot, paths, logPath, logged, result, 'ancient-bare-runtime-root')
  copyLegacyRootConfigFiles(paths, logPath, logged, result)
  migrateLegacyProjectIndex(paths, logPath, logged, result)

  const previousStateRoot = join(paths.runtimeRoot, '.emperor')
  result.legacyStateRoots.push({ path: previousStateRoot, kind: 'previous-dotemperor-root', existed: existsSync(previousStateRoot) })
  // `templates/` is excluded: under the previous layout it only ever held USER.local.md,
  // which moves to a new relative path (memory/profile/) below, not a straight tree copy.
  copyTree({
    legacy: 'emperor-state-root',
    from: previousStateRoot,
    to: paths.stateRoot,
    logPath,
    logged,
    result,
    excludeTopLevelDirs: ['templates'],
    excludeRelPrefixes: LEGACY_DOTEMPEROR_STATE_PREFIXES,
  })
  migrateLegacyStateSubdirsFromMemory(previousStateRoot, paths, logPath, logged, result, 'previous-dotemperor-root')
  migrateLegacyUserProfilePath(previousStateRoot, paths.stateRoot, logPath, logged, result)

  writeMigrationReport(paths, result)
  return result
}

function migrateLegacyStateSubdirsFromMemory(
  legacyRoot: string,
  paths: RuntimePaths,
  logPath: string,
  logged: Set<string>,
  result: LegacyStateMigrationResult,
  kind: LegacyStateRootInfo['kind'],
): void {
  const memoryRoot = join(legacyRoot, 'memory')
  result.legacyStateRoots.push({ path: join(memoryRoot, 'control'), kind, existed: existsSync(join(memoryRoot, 'control')) })
  result.legacyStateRoots.push({ path: join(memoryRoot, 'scheduler'), kind, existed: existsSync(join(memoryRoot, 'scheduler')) })
  result.legacyStateRoots.push({ path: join(memoryRoot, 'tasks'), kind, existed: existsSync(join(memoryRoot, 'tasks')) })
  result.legacyStateRoots.push({ path: join(memoryRoot, 'external'), kind, existed: existsSync(join(memoryRoot, 'external')) })
  const mappings: Array<{ legacy: LegacyStateMigrationEntry['legacy']; from: string; to: string }> = [
    { legacy: 'memory-control', from: join(memoryRoot, 'control'), to: paths.controlRoot },
    { legacy: 'memory-scheduler', from: join(memoryRoot, 'scheduler'), to: paths.schedulerRoot },
    { legacy: 'memory-tasks', from: join(memoryRoot, 'tasks'), to: paths.tasksRoot },
    { legacy: 'memory-external', from: join(memoryRoot, 'external'), to: paths.externalRoot },
  ]
  for (const mapping of mappings) {
    copyTree({ legacy: mapping.legacy, from: mapping.from, to: mapping.to, logPath, logged, result })
  }
}

function copyLegacyRootConfigFiles(
  paths: RuntimePaths,
  logPath: string,
  logged: Set<string>,
  result: LegacyStateMigrationResult,
): void {
  for (const name of ['emperor.local.json', 'model_config.json', 'mcp_config.json']) {
    const source = join(paths.runtimeRoot, name)
    const dest = join(paths.stateRoot, name)
    if (!existsSync(source) || existsSync(dest)) continue
    if (!isValidJson(source)) {
      appendLog({ legacy: 'config', logPath, logged, result }, {
        action: 'skipped_corrupt_json',
        rel_path: name,
        source,
        dest: null,
        reason: 'invalid json',
      })
      result.skipped += 1
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(source, dest)
    appendLog({ legacy: 'config', logPath, logged, result }, {
      action: 'copied',
      rel_path: name,
      source,
      dest,
    })
    result.copied += 1
  }
}

function copyTree(opts: {
  legacy: LegacyStateMigrationEntry['legacy']
  from: string
  to: string
  logPath: string
  logged: Set<string>
  result: LegacyStateMigrationResult
  excludeTopLevelDirs?: string[]
  excludeRelPrefixes?: string[]
}): void {
  if (!existsSync(opts.from)) return
  const excluded = new Set(opts.excludeTopLevelDirs ?? [])
  const excludedPrefixes = opts.excludeRelPrefixes ?? []
  for (const path of walkFiles(opts.from)) {
    const relPath = slash(relative(opts.from, path))
    if (excluded.has(relPath.split('/')[0] ?? '')) continue
    if (excludedPrefixes.some((prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`))) continue
    const dest = join(opts.to, relPath)
    if (existsSync(dest)) continue
    if (shouldValidateJson(relPath) && !isValidJson(path)) {
      appendLog(opts, {
        action: 'skipped_corrupt_json',
        rel_path: `${opts.legacy}/${relPath}`,
        source: path,
        dest: null,
        reason: 'invalid json',
      })
      opts.result.skipped += 1
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(path, dest)
    appendLog(opts, {
      action: 'copied',
      rel_path: `${opts.legacy}/${relPath}`,
      source: path,
      dest,
    })
    opts.result.copied += 1
  }
}

/** One-time path-rename migration: `USER.local.md` moved from `<stateRoot>/templates/` to
 * `<stateRoot>/memory/profile/` (see Task 3). Not a straight tree copy since the relative
 * path itself changed, so `copyTree`'s `excludeTopLevelDirs: ['templates']` skips it and
 * this handles it as a single targeted file move instead. */
function migrateLegacyUserProfilePath(
  previousStateRoot: string,
  newStateRoot: string,
  logPath: string,
  logged: Set<string>,
  result: LegacyStateMigrationResult,
): void {
  const source = join(previousStateRoot, 'templates', 'USER.local.md')
  const dest = join(newStateRoot, 'memory', 'profile', 'USER.local.md')
  const opts = { legacy: 'user-profile-path' as const, logPath, logged, result }
  if (!existsSync(source) || existsSync(dest)) return
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(source, dest)
  appendLog(opts, {
    action: 'copied',
    rel_path: 'templates/USER.local.md -> memory/profile/USER.local.md',
    source,
    dest,
  })
  result.copied += 1
}

function migrateLegacyProjectIndex(
  paths: RuntimePaths,
  logPath: string,
  logged: Set<string>,
  result: LegacyStateMigrationResult,
): void {
  const source = join(paths.runtimeRoot, 'memory', 'projects', 'index.json')
  const dest = join(paths.projectsRoot, 'index.json')
  if (!existsSync(source) || existsSync(dest)) return
  if (!isValidJson(source)) {
    appendLog({ legacy: 'projects-index', logPath, logged, result }, {
      action: 'skipped_corrupt_json',
      rel_path: 'memory/projects/index.json',
      source,
      dest: null,
      reason: 'invalid json',
    })
    result.skipped += 1
    return
  }
  mkdirSync(dirname(dest), { recursive: true })
  const raw = JSON.parse(readFileSync(source, 'utf8') || '[]')
  const items = Array.isArray(raw) ? raw.map((item) => normalizeLegacyProject(item, paths.projectsRoot)).filter(Boolean) : []
  writeFileSync(dest, JSON.stringify(items, null, 2) + '\n', 'utf8')
  appendLog({ legacy: 'projects-index', logPath, logged, result }, {
    action: 'copied',
    rel_path: 'memory/projects/index.json',
    source,
    dest,
  })
  result.copied += 1
}

function normalizeLegacyProject(raw: unknown, projectsRoot: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const projectId = String(item.project_id ?? '')
  if (!projectId) return null
  return {
    ...item,
    agents_path: join(projectsRoot, projectId, 'AGENTS.local.md'),
  }
}

function appendLog(
  opts: {
    legacy: LegacyStateMigrationEntry['legacy']
    logPath: string
    logged: Set<string>
    result: LegacyStateMigrationResult
  },
  entry: Omit<LegacyStateMigrationEntry, 'ts' | 'legacy'>,
): void {
  const key = `${entry.action}:${entry.rel_path}`
  if (opts.logged.has(key)) return
  opts.logged.add(key)
  const full: LegacyStateMigrationEntry = {
    ts: new Date().toISOString(),
    legacy: opts.legacy,
    ...entry,
  }
  appendFileSync(opts.logPath, JSON.stringify(full) + '\n', 'utf8')
  opts.result.entries.push(full)
}

function readLoggedKeys(logPath: string): Set<string> {
  const keys = new Set<string>()
  if (!existsSync(logPath)) return keys
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const item = JSON.parse(trimmed)
      if (item?.action && item?.rel_path) keys.add(`${item.action}:${item.rel_path}`)
    } catch {
      // Ignore corrupt log rows; future migrations can still append valid rows.
    }
  }
  return keys
}

function writeMigrationReport(paths: RuntimePaths, result: LegacyStateMigrationResult): void {
  const allEntries = readLogEntries(result.logPath)
  const copied = allEntries.filter((entry) => entry.action === 'copied').length
  const skipped = allEntries.filter((entry) => entry.action === 'skipped_corrupt_json').length
  mkdirSync(dirname(result.reportPath), { recursive: true })
  writeFileSync(result.reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    runtimeRoot: paths.runtimeRoot,
    stateRoot: paths.stateRoot,
    copied,
    skipped,
    logPath: result.logPath,
    legacyStateRoots: result.legacyStateRoots,
    entries: allEntries,
  }, null, 2) + '\n', 'utf8')
}

function readLogEntries(logPath: string): LegacyStateMigrationEntry[] {
  if (!existsSync(logPath)) return []
  const out: LegacyStateMigrationEntry[] = []
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const item = JSON.parse(trimmed)
      if (item?.action && item?.legacy && item?.rel_path) out.push(item as LegacyStateMigrationEntry)
    } catch {
      // Ignore corrupt log rows in the summary report; the JSONL log remains authoritative.
    }
  }
  return out
}

function walkFiles(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = statSync(path)
      if (stat.isDirectory()) stack.push(path)
      else if (stat.isFile()) out.push(path)
    }
  }
  return out.sort()
}

function shouldValidateJson(relPath: string): boolean {
  return extname(relPath) === '.json'
}

function isValidJson(path: string): boolean {
  try {
    JSON.parse(readFileSync(path, 'utf8') || 'null')
    return true
  } catch {
    return false
  }
}

function slash(path: string): string {
  return path.split(sep).join('/')
}
