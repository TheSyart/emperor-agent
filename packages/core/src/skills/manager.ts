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
import { parseDocument } from 'yaml'
import { isSkillBlocked } from '../runtime/resources'

const RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const
const MAX_SKILL_FILES = 1_000
const MAX_SKILL_FILE_BYTES = 20 * 1024 * 1024
const MAX_SKILL_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_SKILL_ENTRIES = 2_000
const MAX_SKILL_DEPTH = 32
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type SkillResourceDirectory = (typeof RESOURCE_DIRS)[number]
export type SkillSource = 'builtin' | 'user' | 'project'
export type SkillStatus = 'active' | 'blocked_pending_review' | 'invalid'

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

export interface SkillPackageInput {
  name: string
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

export interface SkillPackageResult {
  name: string
  path: string
  sha256: string
  size: number
  files: string[]
}

interface ParsedSkillMetadata {
  data: Record<string, unknown>
  errors: string[]
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
    const safe = safeRuntimeSkillName(name)
    if (!safe) return null
    return (
      this.recordAt(this.userSkillsDir, safe) ??
      this.recordAt(this.builtinSkillsDir, safe)
    )
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

  validateRecord(record: SkillRecord): SkillValidationResult {
    const contentResult = validateSkillContent(
      record.name,
      readFileSync(record.skillFile, 'utf8'),
    )
    const collected = collectSkillFiles(record.root, record.name)
    const errors = [...contentResult.errors, ...collected.errors]
    if (record.status === 'blocked_pending_review')
      errors.push('Skill is blocked pending review')
    const valid = errors.length === 0 && record.status === 'active'
    return {
      ...contentResult,
      valid,
      source: record.source,
      status: valid
        ? 'active'
        : record.status === 'active'
          ? 'invalid'
          : record.status,
      readOnly: record.readOnly,
      errors,
      files: collected.files.map((file) => file.relativePath),
    }
  }

  package(input: SkillPackageInput): SkillPackageResult {
    const name = assertCreatorSkillName(input.name)
    const record = this.resolve(name)
    if (!record) throw new Error(`Skill not found: ${name}`)
    if (record.status !== 'active')
      throw new Error(`Skill validation failed: Skill is ${record.status}`)

    const collected = collectSkillFiles(record.root, name, {
      readContents: true,
    })
    if (collected.errors.length)
      throw new Error(`Skill validation failed: ${collected.errors.join('; ')}`)
    const skillEntry = collected.files.find(
      (file) => file.relativePath === `${name}/SKILL.md`,
    )
    const snapshotValidation = this.validate({
      name,
      content: skillEntry?.data?.toString('utf8') ?? '',
    })
    if (!snapshotValidation.valid)
      throw new Error(
        `Skill validation failed: ${snapshotValidation.errors.join('; ')}`,
      )
    const entries = collected.files.map((file) => ({
      name: file.relativePath,
      data: file.data!,
    }))
    const archive = createDeterministicZip(entries)
    const path = join(
      this.managedDirectory('skill-packages', true),
      `${name}.skill`,
    )
    atomicWriteBuffer(path, archive)
    return {
      name,
      path,
      sha256: createHash('sha256').update(archive).digest('hex'),
      size: archive.byteLength,
      files: entries.map((entry) => entry.name),
    }
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
      status:
        source === 'user' && isSkillBlocked(root)
          ? 'blocked_pending_review'
          : 'active',
      readOnly: source === 'builtin',
    }
  }

  userSkillPath(name: string): string {
    return join(this.managedDirectory('skills', false), name)
  }

  packageOutputDir(): string {
    return this.managedDirectory('skill-packages', false)
  }

  private managedDirectory(
    name: 'skills' | 'skill-packages',
    create: boolean,
  ): string {
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
    ...parsed,
    requirements: requirementsFromMetadata(parsed.data.metadata),
  }
}

function validateSkillContent(
  requestedName: string,
  content: string,
): SkillValidationResult {
  const parsed = parseSkillFrontmatter(content)
  const errors = [...parsed.errors]
  const nameError = creatorSkillNameError(requestedName)
  if (nameError) errors.unshift(nameError)
  const declaredName = stringValue(parsed.data.name)
  const description = stringValue(parsed.data.description)
  if (!declaredName) errors.push('Frontmatter field "name" is required')
  else if (declaredName !== requestedName)
    errors.push(
      `Frontmatter name must match directory name: expected ${requestedName}, got ${declaredName}`,
    )
  if (!description) errors.push('Frontmatter field "description" is required')
  else if (description.length > 1_024)
    errors.push('Frontmatter description must be at most 1024 characters')
  return {
    name: requestedName,
    valid: errors.length === 0,
    source: 'virtual',
    status: errors.length === 0 ? 'active' : 'invalid',
    readOnly: false,
    errors,
    warnings: [],
    files: [`${requestedName}/SKILL.md`],
    requirements: requirementsFromMetadata(parsed.data.metadata),
  }
}

function parseSkillFrontmatter(content: string): ParsedSkillMetadata {
  const normalized = String(content)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n'))
    return { data: {}, errors: ['SKILL.md must start with YAML frontmatter'] }
  const end = normalized.indexOf('\n---\n', 4)
  const terminalEnd = normalized.endsWith('\n---') ? normalized.length - 4 : -1
  const boundary = end >= 0 ? end : terminalEnd
  if (boundary < 0)
    return { data: {}, errors: ['SKILL.md frontmatter is not closed'] }

  const document = parseDocument(normalized.slice(4, boundary), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  })
  if (document.errors.length) {
    return {
      data: {},
      errors: document.errors.map(
        (error) => `Invalid YAML frontmatter: ${error.message}`,
      ),
    }
  }
  const value = document.toJS() as unknown
  if (!isRecord(value))
    return { data: {}, errors: ['YAML frontmatter must be an object'] }
  return { data: value, errors: [] }
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
        const supported =
          entry === 'SKILL.md' ||
          RESOURCE_DIRS.includes(entry as SkillResourceDirectory)
        if (!supported) {
          addError(`Unsupported top-level entry: ${entry}`)
          continue
        }
        if (entry === 'SKILL.md' && !stat.isFile()) {
          addError('SKILL.md must be a regular file')
          continue
        }
        if (entry !== 'SKILL.md' && !stat.isDirectory()) {
          addError(`Resource entry must be a directory: ${entry}`)
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

function createDeterministicZip(
  entries: Array<{ name: string; data: Buffer }>,
): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x0021, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.byteLength, 18)
    local.writeUInt32LE(entry.data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x0021, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.byteLength, 20)
    central.writeUInt32LE(entry.data.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.byteLength + name.byteLength + entry.data.byteLength
  }

  const centralSize = centralParts.reduce(
    (size, part) => size + part.byteLength,
    0,
  )
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(localOffset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, ...centralParts, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function atomicWriteBuffer(path: string, content: Buffer): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(temp, content, { flag: 'wx' })
    replaceFileAtomic(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
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
  if (!name) return 'Skill name is required'
  if (name.length > 64) return 'Skill name must be at most 64 characters'
  if (!SKILL_NAME_PATTERN.test(name))
    return 'Skill name must use lowercase letters, digits, and single hyphens'
  return ''
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
