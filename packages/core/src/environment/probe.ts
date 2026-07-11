import {
  constants,
  accessSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, posix, win32 } from 'node:path'
import { z } from 'zod'
import type { SkillManager, SkillRequirements, SkillStatus } from '../skills/manager'
import {
  type LoadedToolCatalog,
  type ToolCatalogEntry,
} from './catalog'
import { EnvironmentError } from './errors'
import {
  ENVIRONMENT_TOOL_IDS,
  environmentArchSchema,
  environmentPlatformSchema,
  environmentToolStateSchema,
  sha256Schema,
  stableEnvironmentHash,
  type EnvironmentArch,
  type EnvironmentPlatform,
  type EnvironmentToolId,
  type EnvironmentToolState,
} from './models'
import {
  buildEffectivePath,
  queryWindowsRegistryPaths,
  windowsEnvValue,
  type WindowsRegistryPaths,
} from './path'
import {
  ProjectEnvironmentDetector,
  type ProjectEcosystem,
  type ProjectEnvironmentDeclaration,
  type ProjectEnvironmentDetection,
} from './project-detector'
import {
  NodeEnvironmentProcessRunner,
  type EnvironmentProcessRunner,
} from './process-runner'
import { normalizeDetectedVersion, versionSatisfies } from './version'

const ECOSYSTEM_TOOLS: Record<ProjectEcosystem, EnvironmentToolId[]> = {
  node: ['volta', 'node', 'npm'],
  python: ['uv', 'python'],
  go: ['go'],
  rust: ['rustup', 'rust', 'cargo'],
}

const PRIMARY_RUNTIME: Partial<Record<EnvironmentToolId, ProjectEcosystem>> = {
  node: 'node',
  python: 'python',
  go: 'go',
  rust: 'rust',
}

const REQUIREMENT_ALIASES: Record<string, EnvironmentToolId> = {
  cargo: 'cargo',
  cl: 'msvc-build-tools',
  git: 'git',
  go: 'go',
  msbuild: 'msvc-build-tools',
  node: 'node',
  npm: 'npm',
  python: 'python',
  python3: 'python',
  rg: 'ripgrep',
  ripgrep: 'ripgrep',
  rust: 'rust',
  rustc: 'rust',
  rustup: 'rustup',
  uv: 'uv',
  volta: 'volta',
}
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROBE_ENV_KEYS = [
  'LANG',
  'LC_ALL',
  'USER',
  'USERNAME',
  'TEMP',
  'TMP',
  'SystemRoot',
  'USERPROFILE',
  'LOCALAPPDATA',
  'VOLTA_HOME',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'UV_PYTHON_INSTALL_DIR',
] as const

export interface SkillEnvironmentRequirement {
  skillName: string
  skillStatus: SkillStatus
  requirements: SkillRequirements
}

export interface SkillEnvironmentState {
  skillName: string
  status: 'ready' | 'blocked' | 'unsupported'
  requiredTools: EnvironmentToolId[]
  missing: string[]
  unsupported: string[]
}

const projectDeclarationSchema = z
  .object({
    ecosystem: z.enum(['node', 'python', 'go', 'rust']),
    detected: z.boolean(),
    status: z.enum([
      'absent',
      'default',
      'declared',
      'unsupported',
      'invalid',
    ]),
    source: z.string().max(256).nullable(),
    rawRequirement: z.string().max(512).nullable(),
    normalizedRequirement: z.string().max(512).nullable(),
    reason: z.string().max(1_000).nullable(),
  })
  .strict()

const projectDetectionSchema = z
  .object({
    projectRoot: z.string().min(1).max(4_096),
    fingerprint: sha256Schema,
    declarations: z
      .object({
        node: projectDeclarationSchema,
        python: projectDeclarationSchema,
        go: projectDeclarationSchema,
        rust: projectDeclarationSchema,
      })
      .strict(),
    files: z.array(z.string().min(1).max(256)).max(32),
    diagnostics: z.array(z.string().max(1_000)).max(64),
  })
  .strict()

const skillEnvironmentStateSchema = z
  .object({
    skillName: z.string().min(1).max(128),
    status: z.enum(['ready', 'blocked', 'unsupported']),
    requiredTools: z.array(z.enum(ENVIRONMENT_TOOL_IDS)).max(32),
    missing: z.array(z.string().max(512)).max(512),
    unsupported: z.array(z.string().max(512)).max(512),
  })
  .strict()

export const environmentProbeStatusSchema = z
  .object({
    cacheKey: sha256Schema,
    catalogRevision: sha256Schema,
    projectFingerprint: sha256Schema,
    project: projectDetectionSchema,
    platform: environmentPlatformSchema,
    arch: environmentArchSchema,
    pathEntries: z.array(z.string().min(1).max(4_096)).max(256),
    tools: z.array(environmentToolStateSchema).max(64),
    skills: z.array(skillEnvironmentStateSchema).max(256),
    diagnostics: z.array(z.string().max(1_000)).max(256),
  })
  .strict()

export type EnvironmentProbeStatus = z.infer<typeof environmentProbeStatusSchema>

export interface EnvironmentProbeRequest {
  projectRoot: string
  skillRequirements?: SkillEnvironmentRequirement[]
  forceRefresh?: boolean
  signal?: AbortSignal
}

export type EnvironmentExecutableResolver = (
  tool: ToolCatalogEntry,
  pathEntries: string[],
  platform: EnvironmentPlatform,
) => string | null

export interface EnvironmentProbeOptions {
  catalog: LoadedToolCatalog | (() => LoadedToolCatalog)
  platform?: EnvironmentPlatform
  arch?: EnvironmentArch
  env?:
    | Record<string, string | undefined>
    | (() => Record<string, string | undefined>)
  homeDir?: string
  runner?: EnvironmentProcessRunner
  resolveExecutable?: EnvironmentExecutableResolver
  windowsPathProvider?: () => Promise<WindowsRegistryPaths>
}

export class EnvironmentProbe {
  private readonly catalogProvider: () => LoadedToolCatalog
  private readonly platform: EnvironmentPlatform
  private readonly arch: EnvironmentArch
  private readonly envProvider: () => Record<string, string | undefined>
  private readonly configuredHomeDir: string | null
  private readonly runner: EnvironmentProcessRunner
  private readonly resolveExecutable: EnvironmentExecutableResolver
  private readonly windowsPathProvider?: () => Promise<WindowsRegistryPaths>
  private cache: { key: string; value: EnvironmentProbeStatus } | null = null

  constructor(opts: EnvironmentProbeOptions) {
    const catalog = opts.catalog
    this.catalogProvider =
      typeof catalog === 'function' ? catalog : () => catalog
    this.platform = validatePlatform(opts.platform ?? process.platform)
    this.arch = validateArch(opts.arch ?? process.arch)
    const configuredEnv = opts.env
    this.envProvider =
      typeof configuredEnv === 'function'
        ? () => ({ ...configuredEnv() })
        : () => ({ ...(configuredEnv ?? process.env) })
    this.configuredHomeDir = opts.homeDir ?? null
    this.runner = opts.runner ?? new NodeEnvironmentProcessRunner()
    this.resolveExecutable = opts.resolveExecutable ?? resolveCatalogExecutable
    this.windowsPathProvider = opts.windowsPathProvider
  }

  invalidate(): void {
    this.cache = null
  }

  async getStatus(request: EnvironmentProbeRequest): Promise<EnvironmentProbeStatus> {
    if (request.signal?.aborted) throw new EnvironmentError('cancelled')
    const loaded = this.catalogProvider()
    const env = this.envProvider()
    const homeDir =
      this.configuredHomeDir ?? env.HOME ?? env.USERPROFILE ?? homedir()
    const detector = new ProjectEnvironmentDetector({
      fallbacks: fallbackVersions(loaded),
    })
    const project = detector.detect(request.projectRoot)
    const skills = normalizeSkillRequirements(request.skillRequirements ?? [])
    const targetSupported = loaded.catalog.tools.some((tool) =>
      supportsTarget(tool, this.platform, this.arch),
    )
    let windowsPaths: WindowsRegistryPaths = {
      machinePath: '',
      userPath: '',
      diagnostics: [],
    }
    if (this.platform === 'win32' && targetSupported)
      windowsPaths = this.windowsPathProvider
        ? await this.windowsPathProvider()
        : await queryWindowsRegistryPaths(this.runner, env)
    const effectivePath = buildEffectivePath({
      platform: this.platform,
      envPath: windowsEnvValue(env, 'PATH'),
      homeDir,
      machinePath: windowsPaths.machinePath,
      userPath: windowsPaths.userPath,
      windowsEnv: env,
    })
    const requiredEnvNames = skills.flatMap((skill) => skill.requirements.env)
    const cacheKey = stableEnvironmentHash({
      catalogRevision: loaded.revision,
      projectFingerprint: project.fingerprint,
      platform: this.platform,
      arch: this.arch,
      pathEntries: effectivePath.entries,
      skills,
      probeEnvHash: stableEnvironmentHash(
        Object.fromEntries(
          PROBE_ENV_KEYS.map((name) => [
            name,
            environmentValue(env, name, this.platform) ?? null,
          ]),
        ),
      ),
      envPresence: Object.fromEntries(
        [...new Set(requiredEnvNames)].sort().map((name) => [
          name,
          Boolean(environmentValue(env, name, this.platform)?.trim()),
        ]),
      ),
    })
    if (!request.forceRefresh && this.cache?.key === cacheKey)
      return structuredClone(this.cache.value)

    const required = requiredTools(project, skills, loaded.catalog.tools)
    const processEnv = minimalProbeEnvironment(
      env,
      effectivePath.value,
      homeDir,
      this.platform,
    )
    const diagnostics = [
      ...project.diagnostics,
      ...windowsPaths.diagnostics,
    ]
    const tools = await mapWithConcurrency(
      loaded.catalog.tools,
      4,
      async (tool) => {
        const context = required.get(tool.id)
        return this.probeTool({
          tool,
          project,
          context,
          pathEntries: effectivePath.entries,
          processEnv,
          signal: request.signal,
        })
      },
    )
    if (request.signal?.aborted) throw new EnvironmentError('cancelled')
    for (const state of tools) {
      if (state.status === 'failed')
        diagnostics.push(`${state.id}: probe_failed`)
    }
    const skillStates = evaluateSkills(
      skills,
      tools,
      loaded.catalog.tools,
      env,
      this.platform,
    )
    const value = environmentProbeStatusSchema.parse({
      cacheKey,
      catalogRevision: loaded.revision,
      projectFingerprint: project.fingerprint,
      project,
      platform: this.platform,
      arch: this.arch,
      pathEntries: [...effectivePath.entries],
      tools,
      skills: skillStates,
      diagnostics: [...new Set(diagnostics)],
    })
    this.cache = { key: cacheKey, value: structuredClone(value) }
    return structuredClone(value)
  }

  private async probeTool(opts: {
    tool: ToolCatalogEntry
    project: ProjectEnvironmentDetection
    context: RequirementContext | undefined
    pathEntries: string[]
    processEnv: Record<string, string>
    signal?: AbortSignal
  }): Promise<EnvironmentToolState> {
    const { tool, context } = opts
    const targetStrategies = tool.strategies.filter((strategy) =>
      strategy.targets.some(
        (target) =>
          target.platform === this.platform && target.arch === this.arch,
      ),
    )
    const strategy = targetStrategies[0]
    const projectDeclaration = projectDeclarationForTool(tool.id, opts.project)
    const requiredVersion =
      projectDeclaration?.normalizedRequirement ?? tool.version.requirement
    const base = {
      id: tool.id,
      category: requirementCategory(tool, context),
      required: Boolean(context),
      reason: context?.reason ?? '当前项目未要求此工具',
      declarationSource: projectDeclaration?.source ?? null,
      requiredVersion,
      installStrategy: strategy?.id ?? null,
      sourceUrl: strategy?.source.url ?? null,
      requiresElevation: strategy?.requiresElevation ?? false,
      requiresSeparateConfirmation:
        strategy?.requiresSeparateConfirmation ?? false,
    } as const
    if (!supportsTarget(tool, this.platform, this.arch))
      return parseToolState({
        ...base,
        status: 'unsupported',
        detectedVersion: null,
        versionSummary: null,
        executablePath: null,
        reason: '当前平台或架构不受支持',
      })
    if (
      projectDeclaration &&
      (projectDeclaration.status === 'invalid' ||
        projectDeclaration.status === 'unsupported')
    )
      return parseToolState({
        ...base,
        status: 'unsupported',
        detectedVersion: null,
        versionSummary: null,
        executablePath: null,
        reason: '项目版本声明无法安全解释',
      })
    let executable: string | null
    try {
      executable = this.resolveExecutable(
        tool,
        opts.pathEntries,
        this.platform,
      )
    } catch {
      return parseToolState({
        ...base,
        status: 'failed',
        detectedVersion: null,
        versionSummary: null,
        executablePath: null,
        reason: '可执行文件解析失败',
      })
    }
    if (!executable)
      return parseToolState({
        ...base,
        status: 'missing',
        detectedVersion: null,
        versionSummary: null,
        executablePath: null,
      })
    if (
      this.platform === 'win32' &&
      tool.id === 'npm' &&
      /\.(?:cmd|bat)$/i.test(executable)
    ) {
      const detectedVersion = readWindowsNpmVersion(executable)
      return parseToolState({
        ...base,
        status: detectedVersion
          ? versionSatisfies(detectedVersion, requiredVersion)
            ? 'ready'
            : 'version_mismatch'
          : 'failed',
        detectedVersion,
        versionSummary: detectedVersion ? `npm ${detectedVersion}` : null,
        executablePath: executable,
        reason: detectedVersion ? base.reason : '无法读取 npm 安装元数据',
      })
    }
    let result
    try {
      result = await this.runner.run({
        executable,
        args: [...tool.probe.args],
        cwd: opts.project.projectRoot,
        env: opts.processEnv,
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
        signal: opts.signal,
      })
    } catch {
      return parseToolState({
        ...base,
        status: 'failed',
        detectedVersion: null,
        versionSummary: null,
        executablePath: executable,
        reason: '探测进程启动失败',
      })
    }
    if (result.status !== 'completed' || result.exitCode !== 0)
      return parseToolState({
        ...base,
        status: result.status === 'cancelled' ? 'blocked' : 'failed',
        detectedVersion: null,
        versionSummary: null,
        executablePath: executable,
        reason: `探测失败：${result.status}`,
      })
    const detected = extractVersion(
      `${result.stdout}\n${result.stderr}`,
      tool.probe.versionPattern,
    )
    if (!detected)
      return parseToolState({
        ...base,
        status: 'failed',
        detectedVersion: null,
        versionSummary: null,
        executablePath: executable,
        reason: '探测输出不包含可识别版本',
      })
    return parseToolState({
      ...base,
      status: versionSatisfies(detected.version, requiredVersion)
        ? 'ready'
        : 'version_mismatch',
      detectedVersion: detected.version,
      versionSummary: detected.summary,
      executablePath: executable,
    })
  }
}

interface RequirementContext {
  project: boolean
  skill: boolean
  reason: string
}

export function collectSkillEnvironmentRequirements(
  manager: SkillManager,
): SkillEnvironmentRequirement[] {
  return manager.listRecords().map((record) => {
    const validation = manager.validate({ name: record.name })
    return {
      skillName: record.name,
      skillStatus: validation.status,
      requirements: validation.requirements,
    }
  })
}

function requiredTools(
  project: ProjectEnvironmentDetection,
  skills: SkillEnvironmentRequirement[],
  catalog: ToolCatalogEntry[],
): Map<EnvironmentToolId, RequirementContext> {
  const required = new Map<EnvironmentToolId, RequirementContext>()
  const add = (
    id: EnvironmentToolId,
    source: 'base' | 'project' | 'skill',
    reason: string,
  ): void => {
    const current = required.get(id)
    required.set(id, {
      project: current?.project || source === 'project',
      skill: current?.skill || source === 'skill',
      reason: current ? `${current.reason}；${reason}` : reason,
    })
  }
  for (const tool of catalog) {
    if (tool.category === 'base') add(tool.id, 'base', '基础环境')
  }
  for (const [ecosystem, declaration] of Object.entries(
    project.declarations,
  ) as Array<[ProjectEcosystem, ProjectEnvironmentDeclaration]>) {
    if (!declaration.detected) continue
    for (const id of ECOSYSTEM_TOOLS[ecosystem])
      add(id, 'project', `${ecosystem} 项目环境`)
  }
  for (const skill of skills) {
    for (const name of [...skill.requirements.bins, ...skill.requirements.runtimes]) {
      const id = REQUIREMENT_ALIASES[name.toLowerCase()]
      if (id) add(id, 'skill', `Skill ${skill.skillName}`)
    }
  }
  const byId = new Map(catalog.map((tool) => [tool.id, tool]))
  const visitDependencies = (
    id: EnvironmentToolId,
    context: RequirementContext,
    seen: Set<EnvironmentToolId>,
  ): void => {
    if (seen.has(id)) return
    seen.add(id)
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      add(
        dependency,
        context.project ? 'project' : context.skill ? 'skill' : 'base',
        `${id} 的依赖`,
      )
      visitDependencies(dependency, required.get(dependency)!, seen)
    }
  }
  for (const [id, context] of [...required])
    visitDependencies(id, context, new Set())
  return required
}

function normalizeSkillRequirements(
  values: SkillEnvironmentRequirement[],
): SkillEnvironmentRequirement[] {
  return values
    .map((value) => ({
      skillName: String(value.skillName ?? '').trim().slice(0, 128),
      skillStatus: normalizeSkillStatus(value.skillStatus),
      requirements: {
        bins: normalizedList(value.requirements?.bins),
        runtimes: normalizedList(value.requirements?.runtimes),
        env: normalizedList(value.requirements?.env),
      },
    }))
    .filter((value) => value.skillName)
    .sort((left, right) => left.skillName.localeCompare(right.skillName))
}

function evaluateSkills(
  skills: SkillEnvironmentRequirement[],
  tools: EnvironmentToolState[],
  catalog: ToolCatalogEntry[],
  env: Record<string, string | undefined>,
  platform: EnvironmentPlatform,
): SkillEnvironmentState[] {
  const states = new Map(tools.map((tool) => [tool.id, tool]))
  const catalogById = new Map(catalog.map((tool) => [tool.id, tool]))
  return skills.map((skill) => {
    const requiredTools = new Set<EnvironmentToolId>()
    const unsupported: string[] = []
    for (const name of [...skill.requirements.bins, ...skill.requirements.runtimes]) {
      const id = REQUIREMENT_ALIASES[name.toLowerCase()]
      if (id) requiredTools.add(id)
      else unsupported.push(
        `${skill.requirements.bins.includes(name) ? 'bin' : 'runtime'}:${name}`,
      )
    }
    const addDependencies = (
      id: EnvironmentToolId,
      seen: Set<EnvironmentToolId>,
    ): void => {
      if (seen.has(id)) return
      seen.add(id)
      for (const dependency of catalogById.get(id)?.dependencies ?? []) {
        requiredTools.add(dependency)
        addDependencies(dependency, seen)
      }
    }
    for (const id of [...requiredTools]) addDependencies(id, new Set())
    const missing = [...requiredTools]
      .filter((id) => states.get(id)?.status !== 'ready')
      .map(String)
    for (const name of skill.requirements.env) {
      if (!ENV_NAME_PATTERN.test(name)) unsupported.push(`env:${name}`)
      else if (!environmentValue(env, name, platform)?.trim())
        missing.push(`env:${name}`)
    }
    if (skill.skillStatus !== 'active')
      missing.push(`skill:${skill.skillStatus}`)
    return {
      skillName: skill.skillName,
      status: unsupported.length
        ? 'unsupported'
        : missing.length
          ? 'blocked'
          : 'ready',
      requiredTools: [...requiredTools].sort(),
      missing: [...new Set(missing)].sort(),
      unsupported: [...new Set(unsupported)].sort(),
    }
  })
}

function environmentValue(
  env: Record<string, string | undefined>,
  name: string,
  platform: EnvironmentPlatform,
): string | undefined {
  if (!ENV_NAME_PATTERN.test(name)) return undefined
  return platform === 'win32'
    ? windowsEnvValue(env, name)
    : Object.hasOwn(env, name)
      ? env[name]
      : undefined
}

function fallbackVersions(
  loaded: LoadedToolCatalog,
): Record<ProjectEcosystem, string> {
  const pinned = (id: EnvironmentToolId): string =>
    loaded.catalog.tools.find((tool) => tool.id === id)?.version.pinned ?? ''
  return {
    node: pinned('node'),
    python: pinned('python'),
    go: pinned('go'),
    rust: pinned('rust'),
  }
}

function supportsTarget(
  tool: ToolCatalogEntry,
  platform: EnvironmentPlatform,
  arch: EnvironmentArch,
): boolean {
  return tool.targets.some(
    (target) => target.platform === platform && target.arch === arch,
  )
}

function projectDeclarationForTool(
  toolId: EnvironmentToolId,
  project: ProjectEnvironmentDetection,
): ProjectEnvironmentDeclaration | null {
  const ecosystem = PRIMARY_RUNTIME[toolId]
  if (!ecosystem) return null
  const declaration = project.declarations[ecosystem]
  return declaration.detected ? declaration : null
}

function requirementCategory(
  tool: ToolCatalogEntry,
  context: RequirementContext | undefined,
): EnvironmentToolState['category'] {
  if (tool.category === 'base') return 'base'
  if (context?.project) return 'project'
  if (context?.skill) return 'skill'
  return tool.category === 'large-prerequisite'
    ? 'large-prerequisite'
    : 'project'
}

function parseToolState(value: unknown): EnvironmentToolState {
  return environmentToolStateSchema.parse(value)
}

function extractVersion(
  output: string,
  pattern: string,
): { version: string; summary: string } | null {
  try {
    const match = new RegExp(pattern).exec(output.trim())
    const version = normalizeDetectedVersion(match?.[1] ?? '')
    if (!match || !version) return null
    return {
      version,
      summary: [...match[0]]
        .filter((character) => {
          const code = character.charCodeAt(0)
          return code >= 32 && code !== 127
        })
        .join('')
        .slice(0, 512),
    }
  } catch {
    return null
  }
}

export function resolveCatalogExecutable(
  tool: ToolCatalogEntry,
  pathEntries: string[],
  platform: EnvironmentPlatform,
): string | null {
  for (const candidate of tool.probe.executables) {
    const paths = executableCandidatePaths(candidate, pathEntries, platform)
    for (const path of paths) {
      try {
        if (!existsSync(path)) continue
        const stat = lstatSync(path)
        const canonical = stat.isSymbolicLink() ? realpathSync(path) : path
        if (!lstatSync(canonical).isFile()) continue
        if (platform !== 'win32') accessSync(canonical, constants.X_OK)
        return canonical
      } catch {
        continue
      }
    }
  }
  return null
}

export function readWindowsNpmVersion(shimPath: string): string | null {
  const root = dirname(shimPath)
  for (const path of [
    join(root, 'node_modules', 'npm', 'package.json'),
    join(root, '..', 'node_modules', 'npm', 'package.json'),
  ]) {
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024)
        continue
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const version = normalizeDetectedVersion(
        String((parsed as Record<string, unknown>).version ?? ''),
      )
      if (version) return version
    } catch {
      continue
    }
  }
  return null
}

function executableCandidatePaths(
  candidate: string,
  pathEntries: string[],
  platform: EnvironmentPlatform,
): string[] {
  if (platform !== 'win32')
    return posix.isAbsolute(candidate)
      ? [candidate]
      : pathEntries.map((entry) => posix.join(entry, candidate))
  if (candidate.includes('/') && !/^[A-Za-z]:[\\/]/.test(candidate)) return []
  const names = extname(candidate)
    ? [candidate]
    : [`${candidate}.exe`, `${candidate}.com`, `${candidate}.cmd`, candidate]
  if (win32.isAbsolute(candidate)) return names
  return pathEntries.flatMap((entry) =>
    names.map((name) => win32.join(entry, name)),
  )
}

function minimalProbeEnvironment(
  env: Record<string, string | undefined>,
  path: string,
  homeDir: string,
  platform: EnvironmentPlatform,
): Record<string, string> {
  const output: Record<string, string> = { PATH: path, HOME: homeDir }
  for (const key of PROBE_ENV_KEYS) {
    const value = environmentValue(env, key, platform)
    if (value) output[key] = value
  }
  return output
}

function normalizedList(values: unknown): string[] {
  const list = Array.isArray(values) ? values : []
  return [
    ...new Set(
      list
        .map((value) => String(value).trim().slice(0, 256))
        .filter(Boolean),
    ),
  ]
    .sort()
    .slice(0, 256)
}

function normalizeSkillStatus(value: unknown): SkillStatus {
  return value === 'active' ||
    value === 'blocked_pending_review' ||
    value === 'invalid'
    ? value
    : 'invalid'
}

function validatePlatform(platform: string): EnvironmentPlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux')
    return platform
  throw new EnvironmentError('unsupported_platform')
}

function validateArch(arch: string): EnvironmentArch {
  if (arch === 'arm64' || arch === 'x64') return arch
  throw new EnvironmentError('unsupported_arch')
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      output[index] = await operation(values[index]!, index)
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      worker,
    ),
  )
  return output
}
