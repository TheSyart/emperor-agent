import bundledCatalogJson from './tool-catalog.json'
import { isIP } from 'node:net'
import { z } from 'zod'
import { EnvironmentError } from './errors'
import {
  environmentArchSchema,
  environmentPlatformSchema,
  environmentToolIdSchema,
  sha256Schema,
  stableEnvironmentHash,
} from './models'
import { versionSatisfies } from './version'

const safeExecutableSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isSafeExecutable, 'executable: unsafe executable or shell')
const safeArgumentSchema = z
  .string()
  .max(1_024)
  .refine(isSafeProcessField, 'argument: unsafe argument')
const safeHttpsUrlSchema = z
  .string()
  .max(2_048)
  .refine(isSafeCatalogUrl, 'url: expected a public HTTPS URL')
const exactVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/,
    'version: expected a concrete numeric release',
  )
const versionRequirementSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidVersionRequirement, {
    message: 'version: expected a valid numeric comparator range',
  })

export const toolTargetSchema = z
  .object({
    platform: environmentPlatformSchema,
    arch: environmentArchSchema,
  })
  .strict()
  .superRefine((target, ctx) => {
    if (
      (target.platform === 'win32' || target.platform === 'linux') &&
      target.arch !== 'x64'
    )
      ctx.addIssue({
        code: 'custom',
        message: 'target: unsupported platform and architecture pair',
      })
  })

export const toolCatalogLicenseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    name: z.string().min(1).max(256),
    spdx: z.string().min(1).max(128),
    url: safeHttpsUrlSchema,
  })
  .strict()

export const toolCatalogSourceSchema = z
  .object({
    url: safeHttpsUrlSchema,
    publisher: z.string().trim().min(1).max(256),
    sha256: sha256Schema.optional(),
  })
  .strict()

export const toolCatalogProbeSchema = z
  .object({
    executables: z.array(safeExecutableSchema).min(1).max(16),
    args: z.array(safeArgumentSchema).max(16),
    versionPattern: z.string().min(1).max(512).refine(compilesRegex, {
      message: 'version: invalid version pattern',
    }),
  })
  .strict()
  .superRefine((probe, ctx) => {
    if (
      !probe.executables.every((executable) =>
        ALLOWED_PROBE_COMMANDS.has(commandKey(executable, probe.args)),
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['executables'],
        message: 'command: probe command is not in the static allowlist',
      })
  })

export const toolCatalogStrategySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    kind: z.enum([
      'package_manager',
      'version_manager',
      'direct_archive',
      'windows_installer',
      'macos_installer',
      'system_prompt',
      'bundled',
    ]),
    targets: z.array(toolTargetSchema).min(1).max(6),
    executable: safeExecutableSchema,
    args: z.array(safeArgumentSchema).max(32),
    source: toolCatalogSourceSchema,
    estimatedBytes: z.number().int().nonnegative().max(20_000_000_000),
    requiresElevation: z.boolean(),
    requiresSeparateConfirmation: z.boolean(),
  })
  .strict()
  .superRefine((strategy, ctx) => {
    if (
      !ALLOWED_STRATEGY_COMMANDS.has(
        commandKey(strategy.executable, strategy.args),
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['executable'],
        message: 'command: install command is not in the static allowlist',
      })
    if (
      (strategy.kind === 'direct_archive' ||
        strategy.kind === 'macos_installer' ||
        strategy.kind === 'windows_installer') &&
      !strategy.source.sha256
    )
      ctx.addIssue({
        code: 'custom',
        path: ['source', 'sha256'],
        message: 'digest: direct assets require SHA-256',
      })
    if (
      strategy.kind === 'windows_installer' &&
      !strategy.source.publisher.trim()
    )
      ctx.addIssue({
        code: 'custom',
        path: ['source', 'publisher'],
        message: 'publisher: Windows installers require a publisher',
      })
  })

export const toolCatalogEntrySchema = z
  .object({
    id: environmentToolIdSchema,
    displayName: z.string().min(1).max(128),
    category: z.enum(['base', 'project', 'large-prerequisite']),
    version: z
      .object({
        pinned: exactVersionSchema,
        requirement: versionRequirementSchema,
      })
      .strict()
      .superRefine((version, ctx) => {
        if (!versionSatisfies(version.pinned, version.requirement))
          ctx.addIssue({
            code: 'custom',
            path: ['pinned'],
            message: 'version: pinned release does not satisfy requirement',
          })
      }),
    licenseId: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    dependencies: z.array(environmentToolIdSchema).max(16),
    targets: z.array(toolTargetSchema).min(1).max(6),
    probe: toolCatalogProbeSchema,
    strategies: z.array(toolCatalogStrategySchema).min(1).max(16),
  })
  .strict()

type CatalogRelationsInput = {
  licenses: Array<{ id: string }>
  tools: Array<{
    id: string
    licenseId: string
    dependencies: string[]
    targets: Array<{ platform: string; arch: string }>
    strategies: Array<{
      id: string
      targets: Array<{ platform: string; arch: string }>
    }>
  }>
}

export const toolCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogId: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    release: z.string().min(1).max(128),
    licenses: z.array(toolCatalogLicenseSchema).min(1).max(64),
    tools: z.array(toolCatalogEntrySchema).min(1).max(64),
  })
  .strict()
  .superRefine((catalog, ctx) => validateCatalogRelations(catalog, ctx))

export type ToolCatalog = z.infer<typeof toolCatalogSchema>
export type ToolCatalogEntry = z.infer<typeof toolCatalogEntrySchema>
export type ToolCatalogStrategy = z.infer<typeof toolCatalogStrategySchema>

export interface LoadedToolCatalog {
  catalog: ToolCatalog
  revision: string
}

class ToolCatalogValidationError extends EnvironmentError {
  readonly reason: string

  constructor(reason: string, detail: string) {
    super('catalog_invalid', { detail })
    this.reason = reason
    this.message = `ToolCatalog 校验失败：${reason}`
  }
}

export function parseToolCatalog(value: unknown): LoadedToolCatalog {
  const parsed = toolCatalogSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const reason = catalogIssueReason(issue?.path ?? [], issue?.message ?? '')
    throw new ToolCatalogValidationError(reason, parsed.error.message)
  }
  const catalog = deepFreeze(structuredClone(parsed.data))
  return deepFreeze({ catalog, revision: toolCatalogRevision(catalog) })
}

export function toolCatalogRevision(value: unknown): string {
  return stableEnvironmentHash(value)
}

let bundledCatalog: LoadedToolCatalog | null = null

export function loadBundledToolCatalog(): LoadedToolCatalog {
  bundledCatalog ??= parseToolCatalog(bundledCatalogJson)
  return bundledCatalog
}

function validateCatalogRelations(
  catalog: CatalogRelationsInput,
  ctx: z.RefinementCtx,
): void {
  const licenseIds = new Set<string>()
  catalog.licenses.forEach((license, index) => {
    if (licenseIds.has(license.id))
      ctx.addIssue({
        code: 'custom',
        path: ['licenses', index, 'id'],
        message: `duplicate_license: duplicate license ${license.id}`,
      })
    licenseIds.add(license.id)
  })

  const toolIds = new Set<string>()
  catalog.tools.forEach((tool, index) => {
    if (toolIds.has(tool.id))
      ctx.addIssue({
        code: 'custom',
        path: ['tools', index, 'id'],
        message: `duplicate_tool: duplicate tool ${tool.id}`,
      })
    toolIds.add(tool.id)
  })
  const targetsByTool = new Map(
    catalog.tools.map((tool) => [
      tool.id,
      new Set(tool.targets.map((target) => targetKey(target))),
    ]),
  )
  catalog.tools.forEach((tool, toolIndex) => {
    if (!licenseIds.has(tool.licenseId))
      ctx.addIssue({
        code: 'custom',
        path: ['tools', toolIndex, 'licenseId'],
        message: `license: unknown license ${tool.licenseId}`,
      })
    const strategyIds = new Set<string>()
    const targets = new Set<string>()
    tool.targets.forEach((target, targetIndex) => {
      const key = targetKey(target)
      if (targets.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['tools', toolIndex, 'targets', targetIndex],
          message: `duplicate_target: duplicate target ${key}`,
        })
      targets.add(key)
    })
    const dependencies = new Set<string>()
    tool.dependencies.forEach((dependency, dependencyIndex) => {
      if (dependencies.has(dependency))
        ctx.addIssue({
          code: 'custom',
          path: ['tools', toolIndex, 'dependencies', dependencyIndex],
          message: `duplicate_dependency: duplicate dependency ${dependency}`,
        })
      dependencies.add(dependency)
      if (dependency === tool.id || !toolIds.has(dependency))
        ctx.addIssue({
          code: 'custom',
          path: ['tools', toolIndex, 'dependencies', dependencyIndex],
          message: `dependency: invalid dependency ${dependency}`,
        })
      else {
        const dependencyTargets = targetsByTool.get(dependency)
        for (const target of targets) {
          if (!dependencyTargets?.has(target))
            ctx.addIssue({
              code: 'custom',
              path: ['tools', toolIndex, 'dependencies', dependencyIndex],
              message: `dependency_target: ${dependency} does not support ${target}`,
            })
        }
      }
    })
    const coveredTargets = new Set<string>()
    tool.strategies.forEach((strategy, strategyIndex) => {
      if (strategyIds.has(strategy.id))
        ctx.addIssue({
          code: 'custom',
          path: ['tools', toolIndex, 'strategies', strategyIndex, 'id'],
          message: `duplicate_strategy: duplicate strategy ${strategy.id}`,
        })
      strategyIds.add(strategy.id)
      const strategyTargets = new Set<string>()
      for (const target of strategy.targets) {
        const key = targetKey(target)
        if (strategyTargets.has(key))
          ctx.addIssue({
            code: 'custom',
            path: ['tools', toolIndex, 'strategies', strategyIndex, 'targets'],
            message: `duplicate_target: duplicate strategy target ${key}`,
          })
        strategyTargets.add(key)
        coveredTargets.add(key)
        if (!targets.has(key))
          ctx.addIssue({
            code: 'custom',
            path: ['tools', toolIndex, 'strategies', strategyIndex, 'targets'],
            message: 'target: strategy target is not supported by the tool',
          })
      }
    })
    for (const target of targets) {
      if (!coveredTargets.has(target))
        ctx.addIssue({
          code: 'custom',
          path: ['tools', toolIndex, 'strategies'],
          message: `target_uncovered: no strategy supports ${target}`,
        })
    }
  })
  const dependencies = new Map(
    catalog.tools.map((tool) => [tool.id, tool.dependencies]),
  )
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (toolId: string): boolean => {
    if (visiting.has(toolId)) return true
    if (visited.has(toolId)) return false
    visiting.add(toolId)
    for (const dependency of dependencies.get(toolId) ?? []) {
      if (visit(dependency)) return true
    }
    visiting.delete(toolId)
    visited.add(toolId)
    return false
  }
  for (const [toolIndex, tool] of catalog.tools.entries()) {
    if (!visit(tool.id)) continue
    ctx.addIssue({
      code: 'custom',
      path: ['tools', toolIndex, 'dependencies'],
      message: `dependency_cycle: dependency cycle includes ${tool.id}`,
    })
    break
  }
}

function targetKey(target: { platform: string; arch: string }): string {
  return `${target.platform}/${target.arch}`
}

function catalogIssueReason(path: PropertyKey[], message: string): string {
  const prefix = message.split(':', 1)[0]?.trim()
  if (prefix && /^[a-z_]+$/.test(prefix)) return prefix
  const joined = path.map(String).join('.')
  if (joined === 'schemaVersion') return 'schema_version'
  if (joined.includes('dependencies')) return 'dependency'
  if (joined.includes('executable')) return 'executable'
  if (joined.includes('args')) return 'argument'
  if (joined.includes('url')) return 'url'
  if (joined.includes('publisher')) return 'publisher'
  if (joined.includes('sha256')) return 'digest'
  if (joined.includes('target') || joined.includes('arch')) return 'target'
  return 'catalog_schema'
}

function isSafeProcessField(value: string): boolean {
  return (
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    }) && !/[;&|`$<>]/.test(value)
  )
}

function isSafeExecutable(value: string): boolean {
  if (!isSafeProcessField(value)) return false
  const executable = value.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  return !new Set([
    'bash',
    'cmd',
    'cmd.exe',
    'csh',
    'dash',
    'fish',
    'ksh',
    'powershell',
    'powershell.exe',
    'pwsh',
    'pwsh.exe',
    'sh',
    'tcsh',
    'zsh',
  ]).has(executable)
}

const ALLOWED_PROBE_COMMANDS = new Set([
  commandKey('cargo', ['--version']),
  commandKey('git', ['--version']),
  commandKey('/usr/bin/git', ['--version']),
  commandKey('go', ['version']),
  commandKey('vswhere.exe', [
    '-latest',
    '-products',
    '*',
    '-property',
    'installationVersion',
  ]),
  commandKey('node', ['--version']),
  commandKey('npm', ['--version']),
  commandKey('npm.cmd', ['--version']),
  commandKey('python3', ['--version']),
  commandKey('python.exe', ['--version']),
  commandKey('rg', ['--version']),
  commandKey('rg.exe', ['--version']),
  commandKey('rustc', ['--version']),
  commandKey('rustc.exe', ['--version']),
  commandKey('rustup', ['--version']),
  commandKey('rustup.exe', ['--version']),
  commandKey('uv', ['--version']),
  commandKey('uv.exe', ['--version']),
  commandKey('volta', ['--version']),
  commandKey('volta.exe', ['--version']),
])

const ALLOWED_STRATEGY_COMMANDS = new Set([
  commandKey('rustup', ['component', 'add', 'cargo', '--toolchain', '1.97.0']),
  commandKey('brew', ['install', 'git']),
  commandKey('winget.exe', ['install', '--exact', '--id', 'Git.Git']),
  commandKey('pkexec', ['apt-get', 'install', '-y', 'git']),
  commandKey('go', ['version']),
  commandKey('winget.exe', [
    'install',
    '--exact',
    '--id',
    'Microsoft.VisualStudio.2022.BuildTools',
  ]),
  commandKey('volta', ['install', 'node@24.18.0']),
  commandKey('npm', ['--version']),
  commandKey('uv', ['python', 'install', '3.12.13']),
  commandKey('brew', ['install', 'ripgrep']),
  commandKey('winget.exe', [
    'install',
    '--exact',
    '--id',
    'BurntSushi.ripgrep.MSVC',
  ]),
  commandKey('pkexec', ['apt-get', 'install', '-y', 'ripgrep']),
  commandKey('rustup', [
    'toolchain',
    'install',
    '1.97.0',
    '--profile',
    'minimal',
  ]),
  commandKey('rustup', ['--version']),
  commandKey('uv', ['--version']),
  commandKey('volta', ['--version']),
])

function commandKey(executable: unknown, args: unknown): string {
  if (
    typeof executable !== 'string' ||
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === 'string')
  )
    return ''
  return JSON.stringify([executable.toLowerCase(), args])
}

function isValidVersionRequirement(value: string): boolean {
  const tokens = value.trim().split(/\s+/)
  return (
    tokens.length > 0 &&
    tokens.every((token) => /^(?:<=|>=|<|>|=)?\d+(?:\.\d+){2,3}$/.test(token))
  )
}

function compilesRegex(value: string): boolean {
  try {
    new RegExp(value)
    return true
  } catch {
    return false
  }
}

function isSafeCatalogUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      isNonPublicIpLiteral(host)
    )
      return false
    return Boolean(host)
  } catch {
    return false
  }
}

function isNonPublicIpLiteral(host: string): boolean {
  const family = isIP(host)
  if (family === 0) return false
  if (family === 6) {
    const [firstText = '', secondText = ''] = host.split(':')
    const first = Number.parseInt(firstText, 16)
    const second = Number.parseInt(secondText, 16)
    const isGlobalUnicast = first >= 0x2000 && first <= 0x3fff
    const isDocumentation = first === 0x2001 && second === 0x0db8
    return !isGlobalUnicast || isDocumentation
  }

  const octets = host.split('.').map(Number)
  const [first = -1, second = -1, third = -1] = octets
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  )
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child)
  }
  return value
}
