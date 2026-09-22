import { createHash, randomBytes } from 'node:crypto'
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type BigIntStats,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { LEGACY_SKILL_STATE_FILE } from '../runtime/resources'
import {
  ConfigResolver,
  defineConfigKey,
  type Resolved,
} from '../config/resolver'
import { skillNameError } from './name'
import {
  checkSkillContent,
  checkSkillFolder,
  parseSkillFrontmatter,
} from './validate'

const RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const
const MAX_SKILL_FILES = 1_000
const MAX_SKILL_FILE_BYTES = 20 * 1024 * 1024
const MAX_SKILL_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_SKILL_ENTRIES = 2_000
const MAX_SKILL_DEPTH = 32

export type SkillResourceDirectory = (typeof RESOURCE_DIRS)[number]
export type SkillSource =
  'builtin' | 'plugin' | 'verified_plugin' | 'user' | 'project'
export type SkillStatus =
  'active' | 'blocked' | 'blocked_pending_review' | 'invalid'

export interface SkillRequirements {
  bins: string[]
  runtimes: string[]
  env: string[]
}

export interface SkillManagerOptions {
  runtimeRoot: string
  stateRoot: string
}

export interface SkillCreateInput {
  name: string
  description: string
  resources?: SkillResourceDirectory[]
}

export interface SkillValidateInput {
  name: string
  content?: string
}

export interface SkillRecord {
  name: string
  root: string
  skillFile: string
  source: SkillSource
  status: SkillStatus
  readOnly: boolean
}

export interface SkillValidationResult {
  name: string
  valid: boolean
  source: SkillSource | 'virtual'
  status: SkillStatus
  readOnly: boolean
  errors: string[]
  warnings: string[]
  files: string[]
  requirements: SkillRequirements
}

export interface SkillCreateResult extends SkillValidationResult {
  path: string
}

export interface SkillDirectorySnapshot {
  name: string
  valid: boolean
  errors: string[]
  warnings: string[]
  requirements: SkillRequirements
  digest: string
  totalBytes: number
  files: Array<{ path: string; data: Buffer }>
}

interface CollectedSkillFiles {
  files: Array<{
    relativePath: string
    absolutePath: string
    size: number
    data?: Buffer
  }>
  errors: string[]
}

export interface ReplaceFileAtomicOptions {
  platform?: NodeJS.Platform
  rename?: typeof renameSync
}

export class SkillManager {
  readonly runtimeRoot: string
  readonly stateRoot: string
  readonly builtinSkillsDir: string
  readonly userSkillsDir: string

  constructor(opts: SkillManagerOptions) {
    this.runtimeRoot = resolve(opts.runtimeRoot)
    this.stateRoot = resolve(opts.stateRoot)
    this.builtinSkillsDir = join(this.runtimeRoot, 'skills')
    this.userSkillsDir = join(this.stateRoot, 'skills')
  }

  listRecords(): SkillRecord[] {
    const names = new Set<string>()
    for (const base of [this.userSkillsDir, this.builtinSkillsDir]) {
      if (!isRegularDirectory(base)) continue
      for (const name of boundedDirectoryEntries(base)) {
        if (safeRuntimeSkillName(name) && this.recordAt(base, name))
          names.add(name)
      }
    }
    return [...names]
      .sort()
      .map((name) => this.resolve(name))
      .filter((record): record is SkillRecord => Boolean(record))
  }

  resolve(name: string): SkillRecord | null {
    return this.resolveWithProvenance(name).value
  }

  resolveWithProvenance(name: string): Resolved<SkillRecord | null> {
    const safe = safeRuntimeSkillName(name)
    const key = defineConfigKey<SkillRecord | null>({
      id: `skills.${safe || 'invalid'}`,
      builtin: safe ? this.recordAt(this.builtinSkillsDir, safe) : null,
    })
    const user = safe ? this.recordAt(this.userSkillsDir, safe) : null
    return new ConfigResolver().resolve(key, {
      candidates: user
        ? [
            {
              source: {
                kind: 'user',
                id: `skill:${safe}`,
                trust: 'trusted',
              },
              value: user,
            },
          ]
        : [],
    })
  }

  create(input: SkillCreateInput): SkillCreateResult {
    const name = assertCreatorSkillName(input.name)
    const description = String(input.description ?? '').trim()
    if (!description) throw new Error('Skill description is required')
    if (description.length > 1_024)
      throw new Error('Skill description must be at most 1024 characters')
    const resources = normalizeResources(input.resources ?? [])
    const userSkillsDir = this.managedDirectory('skills', true)
    const target = join(userSkillsDir, name)
    if (existsSync(target)) throw new Error(`Skill already exists: ${name}`)

    const stage = join(
      userSkillsDir,
      `.skill-create-${process.pid}-${randomBytes(6).toString('hex')}`,
    )
    try {
      mkdirSync(stage, { recursive: false })
      writeFileSync(
        join(stage, 'SKILL.md'),
        skillTemplate(name, description),
        'utf8',
      )
      for (const resource of resources) {
        const resourceDir = join(stage, resource)
        mkdirSync(resourceDir)
        writeFileSync(join(resourceDir, '.gitkeep'), '', 'utf8')
      }
      renameSync(stage, target)
    } catch (error) {
      rmSync(stage, { recursive: true, force: true })
      throw error
    }

    const validation = this.validate({ name })
    if (!validation.valid) {
      rmSync(target, { recursive: true, force: true })
      throw new Error(
        `Created Skill failed validation: ${validation.errors.join('; ')}`,
      )
    }
    return { ...validation, path: target }
  }

  validate(input: SkillValidateInput): SkillValidationResult {
    const requestedName = String(input.name ?? '').trim()
    const nameError = creatorSkillNameError(requestedName)
    if (nameError) {
      return {
        name: requestedName,
        valid: false,
        source: input.content === undefined ? 'user' : 'virtual',
        status: 'invalid',
        readOnly: false,
        errors: [nameError],
        warnings: [],
        files: [],
        requirements: emptySkillRequirements(),
      }
    }
    if (input.content !== undefined)
      return validateSkillContent(requestedName, String(input.content))
    const record = this.resolve(requestedName)
    if (!record) {
      return {
        name: requestedName,
        valid: false,
        source: 'user',
        status: 'invalid',
        readOnly: false,
        errors: [`Skill not found: ${requestedName}`],
        warnings: [],
        files: [],
        requirements: emptySkillRequirements(),
      }
    }
    return this.validateRecord(record)
  }

  /** Relaxed folder validation (see `validate.ts`); the folder name only warns on mismatch. */
  validateRecord(record: SkillRecord): SkillValidationResult {
    const check = checkSkillFolder(record.root, { folderName: record.name })
    const errors = [...check.errors]
    if (record.status === 'blocked_pending_review')
      errors.push('Skill is blocked pending review')
    if (record.status === 'blocked')
      errors.push('Skill is blocked by missing requirements')
    const valid = errors.length === 0 && record.status === 'active'
    return {
      name: check.name || record.name,
      valid,
      source: record.source,
      status: valid
        ? 'active'
        : record.status === 'active'
          ? 'invalid'
          : record.status,
      readOnly: record.readOnly,
      errors,
      warnings: check.warnings,
      files: [
        `${record.name}/SKILL.md`,
        ...check.references.map((ref) => `${record.name}/${ref}`),
      ],
      requirements: requirementsFromMetadata(check.frontmatter.metadata),
    }
  }

  snapshotDirectory(root: string, name: string): SkillDirectorySnapshot {
    const safeName = assertCreatorSkillName(name)
    const resolvedRoot = resolve(root)
    const collected = collectSkillFiles(resolvedRoot, safeName, {
      readContents: true,
    })
    const skillFile = collected.files.find(
      (file) => file.relativePath === `${safeName}/SKILL.md`,
    )
    const validation = validateSkillContent(
      safeName,
      skillFile?.data?.toString('utf8') ?? '',
    )
    const errors = [...validation.errors, ...collected.errors]
    const files = collected.files.map((file) => ({
      path: file.relativePath.slice(safeName.length + 1),
      data: file.data!,
    }))
    const digest = createHash('sha256')
    for (const file of files) {
      digest.update(file.path, 'utf8')
      digest.update('\0')
      digest.update(String(file.data.byteLength), 'utf8')
      digest.update('\0')
      digest.update(file.data)
      digest.update('\n')
    }
    return {
      name: safeName,
      valid: errors.length === 0,
      errors,
      warnings: validation.warnings,
      requirements: validation.requirements,
      digest: digest.digest('hex'),
      totalBytes: files.reduce(
        (total, file) => total + file.data.byteLength,
        0,
      ),
      files,
    }
  }

  ensureUserSkillsDirectory(): string {
    return this.managedDirectory('skills', true)
  }

  userSkillsDirectory(): string {
    return this.managedDirectory('skills', false)
  }

  private recordAt(base: string, name: string): SkillRecord | null {
    if (!isRegularDirectory(base)) return null
    const root = join(base, name)
    const skillFile = join(root, 'SKILL.md')
    if (!isRegularDirectory(root) || !isRegularFile(skillFile)) return null
    const source: SkillSource = base === this.userSkillsDir ? 'user' : 'builtin'
    return {
      name,
      root,
      skillFile,
      source,
      status: 'active',
      readOnly: source === 'builtin',
    }
  }

  userSkillPath(name: string): string {
    return join(this.managedDirectory('skills', false), name)
  }

  private managedDirectory(name: 'skills', create: boolean): string {
    if (create) mkdirSync(this.stateRoot, { recursive: true })
    if (!existsSync(this.stateRoot)) return join(this.stateRoot, name)
    const stateStat = lstatSync(this.stateRoot)
    if (!stateStat.isDirectory() && !stateStat.isSymbolicLink())
      throw new Error('Skill state root must be a directory')
    const canonicalStateRoot = realpathSync(this.stateRoot)
    const candidate = join(this.stateRoot, name)
    if (existsSync(candidate)) {
      const stat = lstatSync(candidate)
      if (stat.isSymbolicLink())
        throw new Error(
          `Managed directory must not be a symbolic link: ${name}`,
        )
      if (!stat.isDirectory())
        throw new Error(`Managed Skill path must be a directory: ${name}`)
    } else if (create) {
      mkdirSync(candidate)
    } else {
      return join(canonicalStateRoot, name)
    }
    const canonicalCandidate = realpathSync(candidate)
    if (!isPathInside(canonicalStateRoot, canonicalCandidate))
      throw new Error(`Managed directory escapes state root: ${name}`)
    return canonicalCandidate
  }
}

export function parseSkillMetadata(content: string): {
  data: Record<string, unknown>
  requirements: SkillRequirements
  errors: string[]
} {
  const parsed = parseSkillFrontmatter(content)
  return {
    data: parsed.data,
    errors: parsed.errors,
    requirements: requirementsFromMetadata(parsed.data.metadata),
  }
}

function validateSkillContent(
  requestedName: string,
  content: string,
): SkillValidationResult {
  const check = checkSkillContent(content, { folderName: requestedName })
  const errors = [...check.errors]
  const nameError = skillNameError(requestedName)
  if (nameError && !check.name) errors.unshift(nameError)
  return {
    name: check.name || requestedName,
    valid: errors.length === 0,
    source: 'virtual',
    status: errors.length === 0 ? 'active' : 'invalid',
    readOnly: false,
    errors,
    warnings: check.warnings,
    files: [`${check.name || requestedName}/SKILL.md`],
    requirements: requirementsFromMetadata(check.frontmatter.metadata),
  }
}

function requirementsFromMetadata(metadata: unknown): SkillRequirements {
  const root = isRecord(metadata) ? metadata : {}
  const emperor = isRecord(root.emperor) ? root.emperor : {}
  const nanobot = isRecord(root.nanobot) ? root.nanobot : {}
  const preferred = isRecord(emperor.requires)
    ? emperor.requires
    : isRecord(nanobot.requires)
      ? nanobot.requires
      : {}
  return {
    bins: normalizedStringList(preferred.bins),
    runtimes: normalizedStringList(preferred.runtimes),
    env: normalizedStringList(preferred.env),
  }
}

function collectSkillFiles(
  root: string,
  name: string,
  opts: { readContents?: boolean } = {},
): CollectedSkillFiles {
  const files: CollectedSkillFiles['files'] = []
  const errors: string[] = []
  let totalBytes = 0
  let entryCount = 0
  let stopped = false
  const canonicalRoot = isRegularDirectory(root) ? realpathSync(root) : ''

  if (!isRegularDirectory(root))
    return { files, errors: [`Skill root is not a regular directory: ${name}`] }

  const addError = (message: string): void => {
    if (!errors.includes(message)) errors.push(message)
  }
  const walk = (directory: string, depth: number): void => {
    if (stopped) return
    if (depth > MAX_SKILL_DEPTH) {
      addError(`Skill directory depth exceeds ${MAX_SKILL_DEPTH}`)
      return
    }
    for (const entry of boundedDirectoryEntries(directory)) {
      entryCount += 1
      if (entryCount > MAX_SKILL_ENTRIES) {
        addError(`Skill contains more than ${MAX_SKILL_ENTRIES} entries`)
        stopped = true
        return
      }
      const absolutePath = join(directory, entry)
      const relFromRoot = relative(root, absolutePath).replace(/\\/g, '/')
      const stat = lstatSync(absolutePath)
      if (stat.isSymbolicLink()) {
        addError(`Symbolic links are not allowed: ${relFromRoot}`)
        continue
      }
      if (depth === 0) {
        if (entry === LEGACY_SKILL_STATE_FILE) continue
        if (entry === 'SKILL.md' && !stat.isFile()) {
          addError('SKILL.md must be a regular file')
          continue
        }
      }
      if (stat.isDirectory()) {
        walk(absolutePath, depth + 1)
        continue
      }
      if (!stat.isFile()) {
        addError(`Only regular files are allowed: ${relFromRoot}`)
        continue
      }
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        addError(`Skill file exceeds 20 MiB: ${relFromRoot}`)
        continue
      }
      if (files.length >= MAX_SKILL_FILES) {
        addError(`Skill contains more than ${MAX_SKILL_FILES} files`)
        stopped = true
        return
      }
      let data: Buffer | undefined
      if (opts.readContents) {
        try {
          data = readValidatedSkillFile(
            canonicalRoot,
            absolutePath,
            lstatSync(absolutePath, { bigint: true }),
          )
        } catch (error) {
          addError(
            `Skill file changed or became unsafe: ${relFromRoot}: ${errorMessage(error)}`,
          )
          continue
        }
      }
      const size = data?.byteLength ?? stat.size
      if (size > MAX_SKILL_FILE_BYTES) {
        addError(`Skill file exceeds 20 MiB: ${relFromRoot}`)
        continue
      }
      totalBytes += size
      if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
        addError('Skill exceeds 100 MiB unpacked size')
        stopped = true
        return
      }
      files.push({
        relativePath: `${name}/${relFromRoot}`,
        absolutePath,
        size,
        ...(data ? { data } : {}),
      })
    }
  }
  walk(root, 0)

  if (!files.some((file) => file.relativePath === `${name}/SKILL.md`))
    errors.push('SKILL.md is missing')
  return {
    files: files.sort((left, right) =>
      left.relativePath < right.relativePath
        ? -1
        : left.relativePath > right.relativePath
          ? 1
          : 0,
    ),
    errors,
  }
}

function boundedDirectoryEntries(directory: string): string[] {
  const handle = opendirSync(directory)
  const entries: string[] = []
  try {
    while (entries.length <= MAX_SKILL_ENTRIES) {
      const entry = handle.readSync()
      if (!entry) break
      entries.push(entry.name)
    }
  } finally {
    handle.closeSync()
  }
  return entries.sort()
}

function readValidatedSkillFile(
  canonicalRoot: string,
  path: string,
  expected: BigIntStats,
): Buffer {
  const canonicalBefore = realpathSync(path)
  if (!isPathInside(canonicalRoot, canonicalBefore))
    throw new Error('canonical path escapes Skill root')
  const noFollow =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const before = fstatSync(descriptor, { bigint: true })
    if (!before.isFile()) throw new Error('not a regular file')
    if (!sameFileIdentity(expected, before))
      throw new Error('file identity changed before read')
    if (before.size > BigInt(MAX_SKILL_FILE_BYTES))
      throw new Error('file exceeds 20 MiB before read')
    const data = readFileSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    if (!sameFileIdentity(before, after) || after.size !== BigInt(data.length))
      throw new Error('file changed while reading')
    const canonicalAfter = realpathSync(path)
    if (
      canonicalAfter !== canonicalBefore ||
      !isPathInside(canonicalRoot, canonicalAfter)
    )
      throw new Error('canonical path changed while reading')
    return data
  } finally {
    closeSync(descriptor)
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  )
}

export function replaceFileAtomic(
  temp: string,
  target: string,
  opts: ReplaceFileAtomicOptions = {},
): void {
  const platform = opts.platform ?? process.platform
  const rename = opts.rename ?? renameSync
  const backup = `${target}.replace-backup`
  if (existsSync(backup)) {
    if (existsSync(target)) rmSync(backup, { force: true })
    else rename(backup, target)
  }
  try {
    rename(temp, target)
    return
  } catch (error) {
    if (
      platform !== 'win32' ||
      !existsSync(target) ||
      !isWindowsReplaceConflict(error)
    )
      throw error
  }
  rename(target, backup)
  try {
    rename(temp, target)
    rmSync(backup, { force: true })
  } catch (error) {
    if (!existsSync(target) && existsSync(backup)) rename(backup, target)
    throw error
  }
}

function isWindowsReplaceConflict(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : ''
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES'
}

function skillTemplate(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    `# ${name}`,
    '',
    'Describe the workflow, constraints, and reusable resources for this Skill.',
    '',
  ].join('\n')
}

function normalizeResources(
  resources: SkillResourceDirectory[],
): SkillResourceDirectory[] {
  const normalized = [...new Set(resources)]
  for (const resource of normalized) {
    if (!RESOURCE_DIRS.includes(resource))
      throw new Error(`Unsupported Skill resource directory: ${resource}`)
  }
  return normalized.sort()
}

function assertCreatorSkillName(name: string): string {
  const normalized = String(name ?? '').trim()
  const error = creatorSkillNameError(normalized)
  if (error) throw new Error(error)
  return normalized
}

function creatorSkillNameError(name: string): string {
  return skillNameError(name)
}

function safeRuntimeSkillName(name: string): string {
  const safe = String(name ?? '').trim()
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(safe) ? safe : ''
}

function normalizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(stringValue).filter(Boolean))].sort()
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function emptySkillRequirements(): SkillRequirements {
  return { bins: [], runtimes: [], env: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isRegularDirectory(path: string): boolean {
  if (!existsSync(path)) return false
  const stat = lstatSync(path)
  return !stat.isSymbolicLink() && stat.isDirectory()
}

function isRegularFile(path: string): boolean {
  if (!existsSync(path)) return false
  const stat = lstatSync(path)
  return !stat.isSymbolicLink() && stat.isFile()
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
