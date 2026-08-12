import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface SkillPluginSemanticsMigrationReceiptV1 {
  readonly schemaVersion: 1
  readonly migration: 'skill-plugin-semantics'
  readonly completedAt: string
  readonly discoveredSkillDirectories: number
  readonly legacyRegistryEntries: number
  readonly staleLegacyRegistryEntries: number
  readonly legacyRegistryIsAuthoritative: false
  readonly externalAgentHomesScanned: false
}

export function migrateSkillPluginSemantics(opts: {
  emperorHome: string
  now?: () => string
}): SkillPluginSemanticsMigrationReceiptV1 {
  const emperorHome = resolve(opts.emperorHome)
  const receiptPath = join(
    emperorHome,
    'migrations',
    'skill-plugin-semantics.v1.json',
  )
  const existing = readReceipt(receiptPath)
  if (existing) return existing

  const skillsRoot = join(emperorHome, 'skills')
  const discovered = discoverSkillNames(skillsRoot)
  const legacyNames = readLegacyRegistryNames(
    join(skillsRoot, 'installed.v1.json'),
  )
  const receipt: SkillPluginSemanticsMigrationReceiptV1 = {
    schemaVersion: 1,
    migration: 'skill-plugin-semantics',
    completedAt: (opts.now ?? (() => new Date().toISOString()))(),
    discoveredSkillDirectories: discovered.size,
    legacyRegistryEntries: legacyNames.size,
    staleLegacyRegistryEntries: [...legacyNames].filter(
      (name) => !discovered.has(name),
    ).length,
    legacyRegistryIsAuthoritative: false,
    externalAgentHomesScanned: false,
  }
  writePrivateJsonAtomic(receiptPath, receipt)
  return receipt
}

function discoverSkillNames(skillsRoot: string): Set<string> {
  const names = new Set<string>()
  if (!isDirectory(skillsRoot)) return names
  for (const name of readdirSync(skillsRoot)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue
    const root = join(skillsRoot, name)
    const skill = join(root, 'SKILL.md')
    if (!isDirectory(root) || !isRegularFile(skill)) continue
    names.add(name)
  }
  return names
}

function readLegacyRegistryNames(path: string): Set<string> {
  if (!isRegularFile(path)) return new Set()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      unknown
    >
    const skills = raw.skills
    if (!skills || typeof skills !== 'object' || Array.isArray(skills))
      return new Set()
    return new Set(
      Object.keys(skills as Record<string, unknown>).filter((name) =>
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name),
      ),
    )
  } catch {
    return new Set()
  }
}

function readReceipt(
  path: string,
): SkillPluginSemanticsMigrationReceiptV1 | null {
  if (!isRegularFile(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      unknown
    >
    if (
      raw.schemaVersion !== 1 ||
      raw.migration !== 'skill-plugin-semantics' ||
      raw.legacyRegistryIsAuthoritative !== false ||
      raw.externalAgentHomesScanned !== false
    )
      return null
    return raw as unknown as SkillPluginSemanticsMigrationReceiptV1
  } catch {
    return null
  }
}

function isDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function writePrivateJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
}
