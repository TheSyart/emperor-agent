import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

export const RUNTIME_MANIFEST_FILE = 'runtime-manifest.json'
export const LEGACY_SKILL_STATE_FILE = '.emperor-skill-state.json'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const safeSkillNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/)
const runtimeFileSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    size: z.number().int().nonnegative(),
  })
  .strict()
const runtimeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    appVersion: z.string().min(1),
    runtimeRevision: sha256Schema,
    builtInSkills: z.array(safeSkillNameSchema),
    files: z.array(runtimeFileSchema),
  })
  .strict()

export type RuntimeManifest = z.infer<typeof runtimeManifestSchema>

export interface ValidateRuntimeManifestOptions {
  expectedAppVersion?: string | null
}

export function validateRuntimeManifest(
  runtimeRoot: string,
  opts: ValidateRuntimeManifestOptions = {},
): RuntimeManifest {
  const root = resolve(runtimeRoot)
  const manifestPath = join(root, RUNTIME_MANIFEST_FILE)
  if (!existsSync(manifestPath))
    throw new Error(`runtime manifest is missing: ${manifestPath}`)
  if (lstatSync(manifestPath).isSymbolicLink())
    throw new Error('runtime manifest must not be a symlink')

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`runtime manifest is invalid: ${errorMessage(error)}`)
  }
  const parsed = runtimeManifestSchema.safeParse(raw)
  if (!parsed.success)
    throw new Error(
      `runtime manifest schema is invalid: ${parsed.error.message}`,
    )
  const manifest = parsed.data

  if (
    opts.expectedAppVersion &&
    manifest.appVersion !== opts.expectedAppVersion
  ) {
    throw new Error(
      `runtime manifest app version mismatch: expected ${opts.expectedAppVersion}, got ${manifest.appVersion}`,
    )
  }

  const declared = new Map<string, RuntimeManifest['files'][number]>()
  for (const file of manifest.files) {
    const relativePath = assertRuntimeRelativePath(file.path)
    if (relativePath === RUNTIME_MANIFEST_FILE)
      throw new Error('runtime manifest cannot list itself')
    if (declared.has(relativePath))
      throw new Error(`duplicate runtime manifest path: ${relativePath}`)
    declared.set(relativePath, file)
  }
  const sortedDeclared = [...declared.keys()].sort()
  if (
    manifest.files.some((file, index) => file.path !== sortedDeclared[index])
  ) {
    throw new Error('runtime manifest files must be sorted by path')
  }

  const actualPaths = walkRegularFiles(root, {
    exclude: new Set([RUNTIME_MANIFEST_FILE]),
  })
  for (const actualPath of actualPaths) {
    if (!declared.has(actualPath))
      throw new Error(`unexpected runtime resource: ${actualPath}`)
  }
  for (const [relativePath, expected] of declared) {
    if (!actualPaths.includes(relativePath))
      throw new Error(`runtime resource is missing: ${relativePath}`)
    const content = readFileSync(join(root, ...relativePath.split('/')))
    if (content.byteLength !== expected.size)
      throw new Error(`runtime resource size mismatch: ${relativePath}`)
    if (sha256(content) !== expected.sha256)
      throw new Error(`runtime resource SHA-256 mismatch: ${relativePath}`)
  }

  const revision = runtimeRevision(manifest.files)
  if (revision !== manifest.runtimeRevision)
    throw new Error('runtime manifest revision mismatch')
  const inferredSkills = inferBuiltInSkills(sortedDeclared)
  const declaredSkills = manifest.builtInSkills
  const normalizedSkills = [...new Set(declaredSkills)].sort()
  if (
    declaredSkills.length !== normalizedSkills.length ||
    declaredSkills.some((name, index) => name !== normalizedSkills[index])
  ) {
    throw new Error('runtime manifest builtInSkills must be unique and sorted')
  }
  if (
    inferredSkills.length !== declaredSkills.length ||
    inferredSkills.some((name, index) => name !== declaredSkills[index])
  ) {
    throw new Error('runtime manifest builtInSkills does not match files')
  }
  return manifest
}

export type LegacySkillMigrationAction =
  | 'copied_blocked'
  | 'already_migrated'
  | 'skipped_builtin'
  | 'skipped_collision'
  | 'skipped_invalid'
  | 'skipped_unsafe'

export interface LegacySkillMigrationEntry {
  name: string
  action: LegacySkillMigrationAction
  source: string
  destination: string | null
  digest?: string
  status?: 'blocked_pending_review'
  reason?: string
}

export interface LegacySkillMigrationReceipt {
  schemaVersion: 1
  generatedAt: string
  legacyRuntimeRoot: string
  stateRoot: string
  runtimeRevision: string
  entries: LegacySkillMigrationEntry[]
}

export interface MigrateLegacyRuntimeSkillsOptions {
  legacyRuntimeRoot: string
  stateRoot: string
  builtInSkills: string[]
  runtimeRevision: string
  now?: () => string
}

export interface LegacySkillMigrationResult extends LegacySkillMigrationReceipt {
  receiptPath: string
  quarantinedReceiptPath: string | null
}

const legacySkillMigrationEntrySchema = z
  .object({
    name: z.string().min(1),
    action: z.enum([
      'copied_blocked',
      'already_migrated',
      'skipped_builtin',
      'skipped_collision',
      'skipped_invalid',
      'skipped_unsafe',
    ]),
    source: z.string().min(1),
    destination: z.string().nullable(),
    digest: z.string().optional(),
    status: z.literal('blocked_pending_review').optional(),
    reason: z.string().optional(),
  })
  .strict()
const legacySkillMigrationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().min(1),
    legacyRuntimeRoot: z.string().min(1),
    stateRoot: z.string().min(1),
    runtimeRevision: z.string().min(1),
    entries: z.array(legacySkillMigrationEntrySchema),
  })
  .strict()

export function migrateLegacyRuntimeSkills(
  opts: MigrateLegacyRuntimeSkillsOptions,
): LegacySkillMigrationResult {
  const now = opts.now ?? (() => new Date().toISOString())
  const generatedAt = now()
  const legacyRuntimeRoot = resolve(opts.legacyRuntimeRoot)
  const stateRoot = resolve(opts.stateRoot)
  const receiptPath = join(
    stateRoot,
    'migrations',
    'legacy-runtime-skills.json',
  )
  const quarantinedReceiptPath = quarantineCorruptReceipt(
    receiptPath,
    generatedAt,
    { legacyRuntimeRoot, stateRoot, runtimeRevision: opts.runtimeRevision },
  )
  const entries: LegacySkillMigrationEntry[] = []
  const sourceSkillsRoots = [
    join(legacyRuntimeRoot, '.emperor', 'skills'),
    join(legacyRuntimeRoot, 'skills'),
  ]
  const destinationSkillsRoot = join(stateRoot, 'skills')
  const builtInSkills = new Set(opts.builtInSkills)
  const seenNames = new Set<string>()

  for (const sourceSkillsRoot of sourceSkillsRoots) {
    if (!existsSync(sourceSkillsRoot)) continue
    const sourceRootStat = lstatSync(sourceSkillsRoot)
    if (sourceRootStat.isSymbolicLink() || !sourceRootStat.isDirectory()) {
      entries.push({
        name: '<skills-root>',
        action: 'skipped_unsafe',
        source: sourceSkillsRoot,
        destination: null,
        reason: 'skills root is not a regular directory',
      })
      continue
    }
    for (const name of readdirSync(sourceSkillsRoot).sort()) {
      if (seenNames.has(name)) continue
      seenNames.add(name)
      const source = join(sourceSkillsRoot, name)
      const destination = join(destinationSkillsRoot, name)
      if (!safeSkillNameSchema.safeParse(name).success) {
        entries.push({
          name,
          action: 'skipped_unsafe',
          source,
          destination: null,
          reason: 'unsafe skill name',
        })
        continue
      }
      const sourceStat = lstatSync(source)
      if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
        entries.push({
          name,
          action: 'skipped_unsafe',
          source,
          destination: null,
          reason: 'skill root is not a regular directory',
        })
        continue
      }
      const skillFile = join(source, 'SKILL.md')
      if (
        !existsSync(skillFile) ||
        lstatSync(skillFile).isSymbolicLink() ||
        !lstatSync(skillFile).isFile()
      ) {
        entries.push({
          name,
          action: 'skipped_invalid',
          source,
          destination: null,
          reason: 'missing regular SKILL.md',
        })
        continue
      }
      if (builtInSkills.has(name)) {
        entries.push({
          name,
          action: 'skipped_builtin',
          source,
          destination: null,
        })
        continue
      }
      if (existsSync(destination)) {
        entries.push({
          name,
          action: isLegacyMigratedSkill(destination)
            ? 'already_migrated'
            : 'skipped_collision',
          source,
          destination,
          ...(isLegacyMigratedSkill(destination)
            ? { status: 'blocked_pending_review' as const }
            : {}),
        })
        continue
      }

      let digest = ''
      try {
        digest = legacySkillDigest(source)
        copyLegacySkillBlocked({
          source,
          destination,
          name,
          digest,
          runtimeRevision: opts.runtimeRevision,
          migratedAt: generatedAt,
        })
        entries.push({
          name,
          action: 'copied_blocked',
          source,
          destination,
          digest,
          status: 'blocked_pending_review',
        })
      } catch (error) {
        entries.push({
          name,
          action: 'skipped_unsafe',
          source,
          destination: null,
          reason: errorMessage(error),
        })
      }
    }
  }

  const receipt: LegacySkillMigrationReceipt = {
    schemaVersion: 1,
    generatedAt,
    legacyRuntimeRoot,
    stateRoot,
    runtimeRevision: opts.runtimeRevision,
    entries,
  }
  atomicWriteJson(receiptPath, receipt)
  return { ...receipt, receiptPath, quarantinedReceiptPath }
}

export function isSkillBlocked(skillRoot: string): boolean {
  const markerPath = join(skillRoot, LEGACY_SKILL_STATE_FILE)
  let markerStat
  try {
    markerStat = lstatSync(markerPath)
  } catch (error) {
    if (isMissingPathError(error)) return false
    return true
  }
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) return true
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8'))
    return raw?.status === 'blocked_pending_review'
  } catch {
    return true
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

export function runtimeRevision(
  files: Array<{ path: string; sha256: string; size: number }>,
): string {
  return sha256(
    files
      .map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`)
      .join(''),
  )
}

function copyLegacySkillBlocked(opts: {
  source: string
  destination: string
  name: string
  digest: string
  runtimeRevision: string
  migratedAt: string
}): void {
  const parent = dirname(opts.destination)
  mkdirSync(parent, { recursive: true })
  const stage = join(
    parent,
    `.legacy-skill-${opts.name}-${process.pid}-${randomBytes(4).toString('hex')}`,
  )
  try {
    copyRegularTree(opts.source, stage)
    atomicWriteJson(join(stage, LEGACY_SKILL_STATE_FILE), {
      schemaVersion: 1,
      name: opts.name,
      status: 'blocked_pending_review',
      source: 'legacy_runtime',
      sourcePath: opts.source,
      digest: opts.digest,
      runtimeRevision: opts.runtimeRevision,
      migratedAt: opts.migratedAt,
    })
    renameSync(stage, opts.destination)
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

function copyRegularTree(sourceRoot: string, destinationRoot: string): void {
  mkdirSync(destinationRoot, { recursive: true })
  for (const name of readdirSync(sourceRoot).sort()) {
    const source = join(sourceRoot, name)
    const destination = join(destinationRoot, name)
    const stat = lstatSync(source)
    if (stat.isSymbolicLink())
      throw new Error(`legacy Skill contains symlink: ${name}`)
    if (stat.isDirectory()) copyRegularTree(source, destination)
    else if (stat.isFile()) copyFileSync(source, destination)
    else throw new Error(`legacy Skill contains non-regular file: ${name}`)
  }
}

function legacySkillDigest(root: string): string {
  const files = walkRegularFiles(root)
  const hash = createHash('sha256')
  for (const relativePath of files) {
    const content = readFileSync(join(root, ...relativePath.split('/')))
    hash.update(relativePath, 'utf8')
    hash.update('\0')
    hash.update(String(content.byteLength), 'utf8')
    hash.update('\0')
    hash.update(content)
    hash.update('\n')
  }
  return hash.digest('hex')
}

function isLegacyMigratedSkill(skillRoot: string): boolean {
  const markerPath = join(skillRoot, LEGACY_SKILL_STATE_FILE)
  if (!existsSync(markerPath)) return false
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8'))
    return (
      raw?.source === 'legacy_runtime' &&
      raw?.status === 'blocked_pending_review'
    )
  } catch {
    return false
  }
}

function quarantineCorruptReceipt(
  receiptPath: string,
  timestamp: string,
  expected: {
    legacyRuntimeRoot: string
    stateRoot: string
    runtimeRevision: string
  },
): string | null {
  if (!existsSync(receiptPath)) return null
  try {
    const parsed = legacySkillMigrationReceiptSchema.safeParse(
      JSON.parse(readFileSync(receiptPath, 'utf8')),
    )
    if (
      parsed.success &&
      parsed.data.legacyRuntimeRoot === expected.legacyRuntimeRoot &&
      parsed.data.stateRoot === expected.stateRoot &&
      parsed.data.runtimeRevision === expected.runtimeRevision
    )
      return null
  } catch {
    // Quarantine below.
  }
  const suffix = timestamp.replace(/[^0-9A-Za-z-]/g, '-')
  let backup = `${receiptPath}.corrupt-${suffix}`
  if (existsSync(backup)) backup = `${backup}-${randomBytes(3).toString('hex')}`
  renameSync(receiptPath, backup)
  return backup
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function walkRegularFiles(
  root: string,
  opts: { exclude?: Set<string> } = {},
): string[] {
  const base = resolve(root)
  const out: string[] = []
  const stack = [base]
  while (stack.length) {
    const current = stack.pop()!
    for (const name of readdirSync(current).sort().reverse()) {
      const path = join(current, name)
      const stat = lstatSync(path)
      const relativePath = slash(relative(base, path))
      if (opts.exclude?.has(relativePath)) continue
      assertRuntimeRelativePath(relativePath)
      if (stat.isSymbolicLink())
        throw new Error(
          `runtime resource must not be a symlink: ${relativePath}`,
        )
      if (stat.isDirectory()) stack.push(path)
      else if (stat.isFile()) out.push(relativePath)
      else
        throw new Error(
          `runtime resource is not a regular file: ${relativePath}`,
        )
    }
  }
  return out.sort()
}

function assertRuntimeRelativePath(value: string): string {
  const path = String(value)
  if (
    !path ||
    path.includes('\\') ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe runtime manifest path: ${value}`)
  }
  return path
}

function inferBuiltInSkills(paths: string[]): string[] {
  const names = new Set<string>()
  for (const path of paths) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path)
    if (match) names.add(match[1]!)
  }
  return [...names].sort()
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function slash(path: string): string {
  return path.split(sep).join('/')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
