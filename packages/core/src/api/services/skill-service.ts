import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { WebFetchClient } from '../../network/web-fetch-client'
import {
  SkillLoaders,
  type InvalidSkill,
  type ResolvedSkill,
  type SkillSourceKind,
} from '../../skills/file-loader'
import { SkillError } from '../../skills/errors'
import type { SkillImportResult, SkillImportSource } from '../../skills/import'
import { SkillLibrary, type SkillScope } from '../../skills/library'
import {
  SkillManager,
  parseSkillMetadata,
  type SkillCreateInput,
  type SkillCreateResult,
  type SkillRequirements,
  type SkillSource,
  type SkillStatus,
} from '../../skills/manager'
import { checkSkillContent, checkSkillFolder } from '../../skills/validate'
import {
  SkillInstallService,
  type SkillMissingRequirements,
} from '../../skills/install'
import type {
  CommandArgumentSpec,
  CommandInvocationSource,
  SkillCommandMetadata,
} from '../../commands/types'

export interface CoreSkillServiceDeps {
  runtimeRoot?: string
  manager?: SkillManager
  /** Kernel tool catalog (HarnessHost ToolRegistry.schemas()). */
  toolNames?: () => SkillServiceToolEntry[]
  refreshRuntimeContext?: () => void
  installService?: SkillInstallService
  resolveMissing?: (
    requirements: SkillRequirements,
  ) => Promise<SkillMissingRequirements>
  /** Shared Skill library (per-project loaders + writes); a private one otherwise. */
  library?: SkillLibrary
  /** Project root whose Skills a session sees (null for chat / unknown sessions). */
  projectRootFor?: (sessionId: string | null | undefined) => string | null
  /** Public-HTTPS client for URL imports of a private library. */
  webFetchClient?: WebFetchClient | null
}

/** Minimal tool catalog entry; optional fields default to conservative values. */
export interface SkillServiceToolEntry {
  name: string
  description: string
  parameters?: Record<string, unknown>
  readOnly?: boolean
  exclusive?: boolean
  concurrencySafe?: boolean
  /** MCP server name from the tool's adapter (`MCPToolAdapter.mcpServerName`); absent for builtins. */
  mcpServer?: string
}

export interface SkillInfoPayload {
  name: string
  description: string
  /** Display path of SKILL.md (relative to its home for user/builtin/project Skills). */
  path: string
  /** Absolute Skill folder (the source folder for a single-file Skill). */
  root: string
  /** Absolute SKILL.md (or `<name>.md`) path. */
  skillFile: string
  tags: string
  always: boolean
  /** `project` | `user` | `plugin` | `builtin` (legacy payloads may carry `verified_plugin`). */
  source: SkillSource
  status: SkillStatus
  /** Builtin and Plugin Skills are read-only (use `skills.copyToUser`). */
  readOnly: boolean
  /** A single `<name>.md` file instead of a Skill folder. */
  flat: boolean
  requirements: SkillRequirements
  command: SkillCommandMetadata | null
  warnings: string[]
}

export interface SkillDetailPayload extends SkillInfoPayload {
  content: string
}

export interface InvalidSkillPayload {
  /** Absolute path of the rejected Skill folder or file. */
  path: string
  source: SkillSourceKind
  /** Declared frontmatter name, else the folder name. */
  name: string
  reason: string
  errors: string[]
  warnings: string[]
}

export interface SkillListPayload {
  skills: SkillInfoPayload[]
  invalid: InvalidSkillPayload[]
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
  scope: SkillScope
  path: string
}

export interface SkillValidationPayload {
  name: string
  valid: boolean
  errors: string[]
  warnings: string[]
  /** `virtual` for pasted content; otherwise where the checked Skill lives. */
  source: SkillSourceKind | 'virtual'
  path: string | null
}

export type SkillImportPayload = SkillImportResult

export interface SkillSessionScope {
  sessionId?: string | null
}

export class CoreSkillService {
  readonly root: string
  readonly manager: SkillManager
  readonly installService: SkillInstallService
  readonly library: SkillLibrary
  private readonly deps: CoreSkillServiceDeps

  constructor(root: string, deps: CoreSkillServiceDeps = {}) {
    this.root = resolve(root)
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
    this.library =
      deps.library ??
      new SkillLibrary({
        loaders: new SkillLoaders({
          runtimeRoot: deps.runtimeRoot ?? this.root,
          stateRoot: this.root,
        }),
        fetchClient: () => deps.webFetchClient ?? null,
      })
  }

  tools(): ToolInfoPayload[] {
    return (this.deps.toolNames?.() ?? []).map((tool) => {
      // Server names may contain `_`, and builtins such as `mcp_config` share
      // the prefix: only the adapter-provided server name marks an MCP tool.
      const server = tool.mcpServer ?? ''
      const isMcp = server !== ''
      return {
        name: tool.name,
        description: tool.description,
        parameters: { ...(tool.parameters ?? {}) },
        read_only: Boolean(tool.readOnly),
        exclusive: Boolean(tool.exclusive),
        concurrency_safe: Boolean(tool.concurrencySafe),
        source: isMcp ? 'mcp' : 'builtin',
        server,
      }
    })
  }

  /** Effective Skills of a session plus invalid Skills with reasons. */
  list(opts: SkillSessionScope = {}): SkillListPayload {
    const projectRoot = this.projectRoot(opts.sessionId)
    const scan = this.library.list(projectRoot)
    return {
      skills: scan.skills.map((skill) => this.describe(skill, projectRoot)),
      invalid: scan.invalid.map(invalidPayload),
    }
  }

  get(name: string, opts: SkillSessionScope = {}): SkillDetailPayload {
    const projectRoot = this.projectRoot(opts.sessionId)
    const skill = this.library.require(projectRoot, name)
    return { ...this.describe(skill, projectRoot), content: skill.content }
  }

  /** Save SKILL.md of the effective Skill in place (new names become personal Skills). */
  save(
    name: string,
    content: string,
    opts: SkillSessionScope = {},
  ): SkillDetailPayload {
    const projectRoot = this.projectRoot(opts.sessionId)
    const result = this.library.save(projectRoot, name, content)
    this.changed()
    const skill =
      this.library.findInScope(projectRoot, result.name, result.scope) ??
      this.library.require(projectRoot, result.name)
    return { ...this.describe(skill, projectRoot), content: skill.content }
  }

  delete(
    name: string,
    opts: SkillSessionScope & { scope?: SkillScope | null } = {},
  ): SkillDeletePayload {
    const projectRoot = this.projectRoot(opts.sessionId)
    const result = this.library.delete(projectRoot, name, opts.scope ?? null)
    if (result.scope === 'user') {
      try {
        // Legacy installer receipt; best effort (invalid folders have none).
        this.installService.removeInstallationRecord(name)
      } catch {
        // ignore
      }
    }
    this.changed()
    return { deleted: name, scope: result.scope, path: result.path }
  }

  /** Copy a builtin, Plugin, or project Skill into the personal Skills folder. */
  copyToUser(
    input: SkillSessionScope & { name: string; overwrite?: boolean },
  ): SkillDetailPayload {
    const projectRoot = this.projectRoot(input.sessionId)
    this.library.copyToUser(projectRoot, input.name, {
      overwrite: input.overwrite === true,
    })
    this.changed()
    const skill =
      this.library.findInScope(projectRoot, input.name, 'user') ??
      this.library.require(projectRoot, input.name)
    return { ...this.describe(skill, projectRoot), content: skill.content }
  }

  async import(
    input: SkillSessionScope & {
      source: SkillImportSource
      scope: SkillScope
      overwrite?: boolean
    },
  ): Promise<SkillImportPayload> {
    const result = await this.library.import(
      this.projectRoot(input.sessionId),
      {
        source: input.source,
        scope: input.scope,
        overwrite: input.overwrite === true,
      },
    )
    if (result.imported.length) this.changed()
    return result
  }

  /**
   * Electron main-only: the Skills folder of a scope. The user folder lives in
   * Emperor Home and is ours to create; a project folder belongs to the user's
   * repository, so it appears only once a project Skill is saved there.
   */
  folderPath(input: SkillSessionScope & { scope: SkillScope }): string {
    const create = input.scope === 'user'
    const dir = this.library.scopeDir(
      input.scope,
      this.projectRoot(input.sessionId),
      { create },
    )
    if (!create && !existsSync(dir))
      throw new SkillError(
        `Project Skills folder does not exist yet: ${dir}`,
        'skill_scope_unavailable',
      )
    return dir
  }

  async reconcileBlocked(): Promise<{
    activated: string[]
    blocked: string[]
  }> {
    const results = await this.installService.reconcileBlocked()
    if (results.activated.length) this.changed()
    return results
  }

  create(input: SkillCreateInput): SkillCreateResult {
    const result = this.manager.create(input)
    this.changed()
    return result
  }

  /** Validate pasted SKILL.md text (`content`) or an installed Skill (`name`). */
  validate(
    input: SkillSessionScope & {
      name?: string | null
      content?: string | null
    },
  ): SkillValidationPayload {
    const name = String(input.name ?? '').trim()
    if (typeof input.content === 'string') {
      const check = checkSkillContent(input.content, {
        folderName: name || null,
      })
      return {
        name: check.name || name,
        valid: check.errors.length === 0,
        errors: check.errors,
        warnings: check.warnings,
        source: 'virtual',
        path: null,
      }
    }
    const projectRoot = this.projectRoot(input.sessionId)
    const skill = this.library.find(projectRoot, name)
    if (skill !== null) {
      const check = skill.flat
        ? checkSkillContent(skill.content)
        : checkSkillFolder(skill.root)
      return {
        name,
        valid: check.errors.length === 0,
        errors: check.errors,
        warnings: skill.warnings,
        source: skill.source,
        path: skill.flat ? skill.skillFile : skill.root,
      }
    }
    const invalid = this.library
      .list(projectRoot)
      .invalid.find((entry) => entry.name === name)
    return invalid
      ? {
          name,
          valid: false,
          errors: invalid.errors,
          warnings: invalid.warnings,
          source: invalid.source,
          path: invalid.path,
        }
      : {
          name,
          valid: false,
          errors: [`Skill not found: ${name}`],
          warnings: [],
          source: 'virtual',
          path: null,
        }
  }

  private describe(
    skill: ResolvedSkill,
    projectRoot: string | null,
  ): SkillInfoPayload {
    const meta = parseSkillMetadata(skill.content)
    return {
      name: skill.name,
      description: skill.description,
      path: this.displayPath(skill, projectRoot),
      root: skill.root,
      skillFile: skill.skillFile,
      tags: String(skill.frontmatter.tags ?? ''),
      always: boolMeta(skill.frontmatter.always),
      source: skill.source,
      status: 'active',
      readOnly: skill.readOnly,
      flat: skill.flat,
      requirements: meta.requirements,
      command: commandMetadata(skill.frontmatter),
      warnings: skill.warnings,
    }
  }

  private displayPath(
    skill: ResolvedSkill,
    projectRoot: string | null,
  ): string {
    const loaders = this.library.loaders
    const base =
      skill.source === 'user'
        ? loaders.stateRoot
        : skill.source === 'builtin'
          ? loaders.runtimeRoot
          : skill.source === 'project'
            ? projectRoot
            : null
    return base === null
      ? skill.skillFile
      : relative(base, skill.skillFile).replace(/\\/g, '/')
  }

  private projectRoot(sessionId: string | null | undefined): string | null {
    return this.deps.projectRootFor?.(sessionId) ?? null
  }

  private changed(): void {
    this.deps.refreshRuntimeContext?.()
  }
}

function invalidPayload(skill: InvalidSkill): InvalidSkillPayload {
  return {
    path: skill.path,
    source: skill.source,
    name: skill.name,
    reason: skill.reason,
    errors: skill.errors,
    warnings: skill.warnings,
  }
}

function commandMetadata(frontmatter: unknown): SkillCommandMetadata | null {
  const top = record(frontmatter)
  const metadata = record(top.metadata)
  const emperor = record(metadata.emperor)
  const nested = record(emperor.command)
  const hasTopLevelCommand = [
    'user-invocable',
    'user_invocable',
    'argument-hint',
    'argument_hint',
    'allowed-tools',
    'allowed_tools',
    'context',
  ].some((key) => Object.prototype.hasOwnProperty.call(top, key))
  const command = Object.keys(nested).length
    ? nested
    : hasTopLevelCommand
      ? top
      : {}
  if (!Object.keys(command).length) return null
  const context = stringValue(command.context) === 'fork' ? 'fork' : 'inline'
  const rawSources = stringList(
    command.invocation_sources ?? command.invocationSources,
  )
  const invocationSources = rawSources.filter(
    (source): source is CommandInvocationSource =>
      source === 'desktop' || source === 'automation' || source === 'acp',
  )
  return {
    userInvocable: boolMeta(
      command['user-invocable'] ??
        command.user_invocable ??
        command.userInvocable ??
        true,
    ),
    name: nullableString(command.name),
    aliases: stringList(command.aliases),
    argumentHint: stringValue(
      command['argument-hint'] ??
        command.argument_hint ??
        command.argumentHint ??
        '[task]',
    ),
    arguments: argumentSpecs(command.arguments),
    context,
    agent: nullableString(command.agent),
    allowedTools: stringList(
      command['allowed-tools'] ?? command.allowed_tools ?? command.allowedTools,
    ),
    effort: nullableString(command.effort),
    invocationSources: invocationSources.length
      ? invocationSources
      : ['desktop'],
    sensitiveArguments: stringList(
      command.sensitive_arguments ?? command.sensitiveArguments,
    ),
  }
}

function argumentSpecs(value: unknown): CommandArgumentSpec[] {
  if (!Array.isArray(value)) return []
  const out: CommandArgumentSpec[] = []
  for (const item of value) {
    const input = record(item)
    const name = stringValue(input.name)
    const type = stringValue(input.type)
    if (
      !name ||
      !['string', 'boolean', 'enum', 'id', 'relative_path'].includes(type)
    )
      continue
    out.push({
      name,
      type: type as CommandArgumentSpec['type'],
      required: boolMeta(input.required),
      positional:
        input.positional === undefined ? true : boolMeta(input.positional),
      values: stringList(input.values),
      description: stringValue(input.description) || undefined,
      variadic: boolMeta(input.variadic),
    })
  }
  return out
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function nullableString(value: unknown): string | null {
  return stringValue(value) || null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(stringValue).filter(Boolean))]
    : []
}

function boolMeta(value: unknown): boolean {
  return (
    String(value ?? '')
      .trim()
      .toLowerCase() === 'true'
  )
}
