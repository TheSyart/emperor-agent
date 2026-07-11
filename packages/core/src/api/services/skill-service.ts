import { inflateRawSync } from 'node:zlib'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { ToolRegistry } from '../../tools/registry'
import {
  SkillManager,
  parseSkillMetadata,
  type SkillCreateInput,
  type SkillCreateResult,
  type SkillPackageInput,
  type SkillPackageResult,
  type SkillRequirements,
  type SkillSource,
  type SkillStatus,
  type SkillValidateInput,
  type SkillValidationResult,
} from '../../skills/manager'

type Dict = Record<string, unknown>

export interface CoreSkillServiceDeps {
  runtimeRoot?: string
  manager?: SkillManager
  registry?: ToolRegistry
  refreshRuntimeContext?: () => void
}

export interface SkillInfoPayload {
  name: string
  description: string
  path: string
  tags: string
  always: boolean
  source: SkillSource
  status: SkillStatus
  readOnly: boolean
  requirements: SkillRequirements
}

export interface SkillDetailPayload extends SkillInfoPayload {
  content: string
}

export interface ToolInfoPayload {
  name: string
  description: string
  parameters: Record<string, unknown>
  read_only: boolean
  exclusive: boolean
  concurrency_safe: boolean
  source: 'builtin' | 'mcp'
  server: string
}

export interface SkillDeletePayload {
  deleted: string
}

export interface SkillImportPayload {
  imported: string
}

export class CoreSkillService {
  readonly root: string
  readonly skillsDir: string
  readonly manager: SkillManager
  private readonly deps: CoreSkillServiceDeps

  constructor(root: string, deps: CoreSkillServiceDeps = {}) {
    this.root = resolve(root)
    this.skillsDir = join(this.root, 'skills')
    this.deps = deps
    this.manager =
      deps.manager ??
      new SkillManager({
        stateRoot: this.root,
        runtimeRoot: deps.runtimeRoot ?? this.root,
      })
  }

  tools(): ToolInfoPayload[] {
    return (this.deps.registry?.getDefinitions() ?? []).map((definition) => {
      const tool = this.deps.registry?.get(definition.name)
      const isMcp = definition.name.startsWith('mcp_')
      return {
        name: definition.name,
        description: definition.description,
        parameters: { ...definition.input_schema },
        read_only: Boolean(tool?.readOnly),
        exclusive: Boolean(tool?.exclusive),
        concurrency_safe: Boolean(tool?.concurrencySafe),
        source: isMcp ? 'mcp' : 'builtin',
        server: isMcp ? (definition.name.split('_', 3)[1] ?? '') : '',
      }
    })
  }

  list(): SkillInfoPayload[] {
    return this.manager.listRecords().map((record) => this.info(record.name))
  }

  get(name: string): SkillDetailPayload {
    const safe = safeSkillName(name)
    if (!safe) throw new Error('Invalid skill name')
    const path = this.skillPath(safe)
    if (!path) throw new Error(`Skill not found: ${safe}`)
    return { ...this.info(safe), content: readFileSync(path, 'utf8') }
  }

  save(name: string, content: string): SkillDetailPayload {
    const safe = safeSkillName(name)
    if (!safe) throw new Error('Skill name must be a safe directory name')
    assertWritableSkillPath(this.skillsDir, safe)
    const path = join(this.skillsDir, safe, 'SKILL.md')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${String(content || '').trimEnd()}\n`, 'utf8')
    this.deps.refreshRuntimeContext?.()
    return this.get(safe)
  }

  delete(name: string): SkillDeletePayload {
    const safe = safeSkillName(name)
    if (!safe) throw new Error('Invalid skill name')
    const dir = join(this.skillsDir, safe)
    if (!existsSync(dir)) {
      const record = this.manager.resolve(safe)
      if (record?.readOnly)
        throw new Error(`Built-in Skill is read-only: ${safe}`)
      throw new Error(`Skill not found: ${safe}`)
    }
    rmSync(dir, { recursive: true, force: true })
    this.deps.refreshRuntimeContext?.()
    return { deleted: safe }
  }

  importArchive(input: unknown): SkillImportPayload {
    const result = installSkillArchive(this.root, input)
    this.deps.refreshRuntimeContext?.()
    return result
  }

  create(input: SkillCreateInput): SkillCreateResult {
    const result = this.manager.create(input)
    this.deps.refreshRuntimeContext?.()
    return result
  }

  validate(input: SkillValidateInput): SkillValidationResult {
    return this.manager.validate(input)
  }

  package(input: SkillPackageInput): SkillPackageResult {
    return this.manager.package(input)
  }

  private info(name: string): SkillInfoPayload {
    const record = this.manager.resolve(name)
    if (!record) throw new Error(`Skill not found: ${name}`)
    const content = readFileSync(record.skillFile, 'utf8')
    const meta = parseSkillMetadata(content)
    const validation = this.manager.validate({ name })
    return {
      name,
      description: String(meta.data.description ?? ''),
      path: relative(
        record.source === 'user' ? this.root : this.manager.runtimeRoot,
        record.skillFile,
      ).replace(/\\/g, '/'),
      tags: String(meta.data.tags ?? ''),
      always: boolMeta(meta.data.always),
      source: record.source,
      status:
        record.status !== 'active'
          ? record.status
          : !validation.valid
            ? 'invalid'
            : 'active',
      readOnly: record.readOnly,
      requirements: validation.requirements,
    }
  }

  private skillPath(name: string): string | null {
    return this.manager.resolve(name)?.skillFile ?? null
  }
}

function boolMeta(value: unknown): boolean {
  return (
    String(value ?? '')
      .trim()
      .toLowerCase() === 'true'
  )
}

function safeSkillName(name: string): string {
  const safe = String(name || '').trim()
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(safe) ? safe : ''
}

function assertWritableSkillPath(skillsDir: string, name: string): void {
  if (existsSync(skillsDir) && lstatSync(skillsDir).isSymbolicLink())
    throw new Error('User Skills directory must not be a symbolic link')
  const dir = join(skillsDir, name)
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
    throw new Error(`Skill directory must not be a symbolic link: ${name}`)
  const skillFile = join(dir, 'SKILL.md')
  if (existsSync(skillFile) && lstatSync(skillFile).isSymbolicLink())
    throw new Error(`SKILL.md must not be a symbolic link: ${name}`)
}

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

function installSkillArchive(root: string, input: unknown): SkillImportPayload {
  const archive = archiveBufferFromInput(input)
  const entries = readZipEntries(archive)
  if (!entries.length) throw new Error('Empty zip file')
  const roots = new Set(entries.map((entry) => entry.name.split('/')[0] || ''))
  if (roots.size !== 1)
    throw new Error('Skill archive must contain a single root directory')
  const rootName = [...roots][0]!
  if (!safeSkillName(rootName))
    throw new Error(`Invalid skill root directory: ${rootName}`)
  if (!entries.some((entry) => entry.name === `${rootName}/SKILL.md`)) {
    throw new Error(`Missing SKILL.md in zip root (${rootName})`)
  }

  const skillsDir = join(root, 'skills')
  const stage = join(
    skillsDir,
    `.skill-import-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  mkdirSync(stage, { recursive: true })
  try {
    for (const entry of entries) {
      const data = extractZipEntry(archive, entry)
      const target = join(stage, entry.name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data)
    }
    const target = join(skillsDir, rootName)
    const backup = existsSync(target)
      ? join(
          skillsDir,
          `.${rootName}.bak-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        )
      : ''
    if (backup) renameSync(target, backup)
    try {
      renameSync(join(stage, rootName), target)
      if (backup) rmSync(backup, { recursive: true, force: true })
    } catch (error) {
      if (backup && !existsSync(target) && existsSync(backup))
        renameSync(backup, target)
      throw error
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
  return { imported: rootName }
}

function archiveBufferFromInput(input: unknown): Buffer {
  if (typeof input === 'string') return readFileSync(input)
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const raw = (input as Dict).raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (raw instanceof ArrayBuffer) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw as number[])
  }
  throw new Error('Expected skill archive bytes')
}

function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf)
  const entryCount = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < entryCount; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('Invalid zip central directory')
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const rawName = buf
      .subarray(offset + 46, offset + 46 + nameLen)
      .toString('utf8')
    const name = normalizeZipMember(rawName)
    if (name && !rawName.endsWith('/'))
      entries.push({ name, method, compressedSize, localOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_557)
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('Invalid zip file')
}

function normalizeZipMember(raw: string): string {
  const clean = raw.replace(/\\/g, '/').trim().replace(/\/+$/, '')
  if (!clean) return ''
  const parts = clean.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error(`unsafe path in skill zip: ${raw}`)
  return parts.join('/')
}

function extractZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localOffset
  if (buf.readUInt32LE(offset) !== 0x04034b50)
    throw new Error('Invalid zip local header')
  const nameLen = buf.readUInt16LE(offset + 26)
  const extraLen = buf.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLen + extraLen
  const compressed = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(compressed)
  if (entry.method === 8) return inflateRawSync(compressed)
  throw new Error(`Unsupported zip compression method: ${entry.method}`)
}
