import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { ToolRegistry } from '../../tools/registry'
import { EmperorError } from '../../errors'
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
import {
  SkillInstallService,
  type SkillConfirmInstallInput,
  type SkillInstallPreview,
  type SkillInstallResult,
  type SkillInstallSourceInput,
  type SkillMissingRequirements,
} from '../../skills/install'

export interface CoreSkillServiceDeps {
  runtimeRoot?: string
  manager?: SkillManager
  registry?: ToolRegistry
  refreshRuntimeContext?: () => void
  installService?: SkillInstallService
  resolveMissing?: (
    requirements: SkillRequirements,
  ) => Promise<SkillMissingRequirements>
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

export class CoreSkillService {
  readonly root: string
  readonly skillsDir: string
  readonly manager: SkillManager
  readonly installService: SkillInstallService
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
    this.installService =
      deps.installService ??
      new SkillInstallService({
        manager: this.manager,
        stateRoot: this.root,
        ...(deps.resolveMissing ? { resolveMissing: deps.resolveMissing } : {}),
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

  async previewInstall(input: {
    source: SkillInstallSourceInput
  }): Promise<SkillInstallPreview> {
    try {
      return await this.installService.previewInstall(input)
    } catch (error) {
      throw safeSkillInstallError('preview', error)
    }
  }

  async confirmInstall(
    input: SkillConfirmInstallInput,
  ): Promise<SkillInstallResult> {
    try {
      const result = await this.installService.confirmInstall(input)
      this.deps.refreshRuntimeContext?.()
      return result
    } catch (error) {
      throw safeSkillInstallError('confirm', error)
    }
  }

  async reconcileBlocked(): Promise<{
    activated: string[]
    blocked: string[]
  }> {
    const results = await this.installService.reconcileBlocked()
    if (results.activated.length) this.deps.refreshRuntimeContext?.()
    return results
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

function safeSkillInstallError(
  phase: 'preview' | 'confirm',
  cause: unknown,
): EmperorError {
  if (cause instanceof EmperorError) return cause
  return new EmperorError(
    phase === 'preview'
      ? 'Skill 安装预览失败，请检查来源和压缩包后重试。'
      : 'Skill 安装确认失败，预览可能已过期或内容发生变化。',
    phase === 'preview' ? 'skill_preview_failed' : 'skill_install_failed',
    {
      ...(cause instanceof Error ? { cause } : {}),
      action: 'review_skill_install',
    },
  )
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
