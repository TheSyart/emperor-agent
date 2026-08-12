import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  executionEnvironmentSnapshotSchema,
  stableEnvironmentHash,
  type ExecutionEnvironmentSnapshot as ExecutionEnvironmentSnapshotData,
  type EnvironmentPlatform,
  type EnvironmentToolId,
} from './models'
import type { EnvironmentProbeRequest, EnvironmentProbeStatus } from './probe'

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_ENV_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_ENV_ENTRIES = 512
const MAX_ENV_VALUE_BYTES = 64 * 1024

const POSIX_ENV_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'USER',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TERM',
] as const
const WINDOWS_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'USERNAME',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TERM',
] as const

export const executionEnvironmentSnapshotDataSchema =
  executionEnvironmentSnapshotSchema

const capturedEnvironment = new WeakMap<
  ExecutionEnvironment,
  Readonly<Record<string, string>>
>()

export class ExecutionEnvironment {
  readonly revision: string
  readonly catalogRevision: string
  readonly projectFingerprint: string
  readonly createdAt: string
  readonly platform: EnvironmentPlatform
  readonly pathEntries: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly toolPaths: Readonly<Partial<Record<EnvironmentToolId, string>>>
  readonly managedBinRoot: string | null
  readonly managedCommands: Readonly<Record<string, string>>
  readonly managedSources: Readonly<
    Record<string, { placement: 'managed' | 'external'; version: string }>
  >
  readonly emperorPaths: Readonly<{
    home: string
    skills: string
    environment: string
    scratch: string
  }> | null
  readonly caSource: 'user' | 'system_bundle' | 'none'

  constructor(
    data: ExecutionEnvironmentSnapshotData,
    privateEnv: Readonly<Record<string, string>>,
  ) {
    const parsed = executionEnvironmentSnapshotSchema.parse(data)
    this.revision = parsed.revision
    this.catalogRevision = parsed.catalogRevision
    this.projectFingerprint = parsed.projectFingerprint
    this.createdAt = parsed.createdAt
    this.platform = parsed.platform
    this.pathEntries = Object.freeze([...parsed.pathEntries])
    this.env = Object.freeze({ ...parsed.env })
    this.toolPaths = Object.freeze({ ...parsed.toolPaths })
    this.managedBinRoot = parsed.managedBinRoot ?? null
    this.managedCommands = Object.freeze({ ...(parsed.managedCommands ?? {}) })
    this.managedSources = Object.freeze(
      Object.fromEntries(
        Object.entries(parsed.managedSources ?? {}).map(([name, source]) => [
          name,
          Object.freeze({ ...source }),
        ]),
      ),
    )
    this.emperorPaths = parsed.emperorPaths
      ? Object.freeze({ ...parsed.emperorPaths })
      : null
    this.caSource = parsed.caSource ?? 'none'
    capturedEnvironment.set(
      this,
      normalizeCapturedEnvironment(privateEnv, parsed.platform),
    )
    Object.freeze(this)
  }

  selectEnv(names: readonly string[]): Readonly<Record<string, string>> {
    const source = capturedEnvironment.get(this) ?? {}
    const selected: Array<[string, string]> = []
    const seen = new Set<string>()
    for (const rawName of names) {
      const name = String(rawName ?? '').trim()
      if (!isSafeEnvName(name)) continue
      const key = this.platform === 'win32' ? name.toLowerCase() : name
      if (seen.has(key)) continue
      seen.add(key)
      const value =
        environmentValue(this.env, name, this.platform) ??
        environmentValue(source, name, this.platform)
      if (value !== undefined) selected.push([name, value])
    }
    return Object.freeze(Object.fromEntries(selected))
  }

  /** Trusted host-only copy; never serialized into prompts or runtime events. */
  hostProcessEnv(): Readonly<Record<string, string>> {
    return Object.freeze({ ...(capturedEnvironment.get(this) ?? {}) })
  }

  toJSON(): ExecutionEnvironmentSnapshotData {
    return {
      revision: this.revision,
      catalogRevision: this.catalogRevision,
      projectFingerprint: this.projectFingerprint,
      createdAt: this.createdAt,
      platform: this.platform,
      pathEntries: [...this.pathEntries],
      env: { ...this.env },
      toolPaths: { ...this.toolPaths },
      managedBinRoot: this.managedBinRoot,
      managedCommands: { ...this.managedCommands },
      managedSources: { ...this.managedSources },
      emperorPaths: this.emperorPaths ? { ...this.emperorPaths } : null,
      caSource: this.caSource,
    }
  }
}

export interface ExecutionEnvironmentProbe {
  getStatus(request: EnvironmentProbeRequest): Promise<EnvironmentProbeStatus>
}

export interface ExecutionEnvironmentServiceOptions {
  probe: ExecutionEnvironmentProbe
  env?:
    | Record<string, string | undefined>
    | (() => Record<string, string | undefined>)
  now?: () => Date
  managedBinRoot?: string | null
  managedRegistryFile?: string | null
  emperorHome?: string | null
  userSkillsRoot?: string | null
  environmentRoot?: string | null
  scratchRoot?: string | null
  systemCaBundle?: string | null
}

export class ExecutionEnvironmentService {
  private readonly probe: ExecutionEnvironmentProbe
  private readonly envProvider: () => Record<string, string | undefined>
  private readonly now: () => Date
  private readonly managedBinRoot: string | null
  private readonly managedRegistryFile: string | null
  private readonly emperorPaths: {
    home: string
    skills: string
    environment: string
    scratch: string
  } | null
  private readonly systemCaBundle: string | null | undefined

  constructor(opts: ExecutionEnvironmentServiceOptions) {
    this.probe = opts.probe
    const configuredEnv = opts.env
    this.envProvider =
      typeof configuredEnv === 'function'
        ? () => ({ ...configuredEnv() })
        : () => ({ ...(configuredEnv ?? process.env) })
    this.now = opts.now ?? (() => new Date())
    this.managedBinRoot = opts.managedBinRoot
      ? resolve(opts.managedBinRoot)
      : null
    this.managedRegistryFile = opts.managedRegistryFile
      ? resolve(opts.managedRegistryFile)
      : null
    this.emperorPaths =
      opts.emperorHome &&
      opts.userSkillsRoot &&
      opts.environmentRoot &&
      opts.scratchRoot
        ? {
            home: resolve(opts.emperorHome),
            skills: resolve(opts.userSkillsRoot),
            environment: resolve(opts.environmentRoot),
            scratch: resolve(opts.scratchRoot),
          }
        : null
    this.systemCaBundle =
      opts.systemCaBundle === undefined
        ? undefined
        : opts.systemCaBundle
          ? resolve(opts.systemCaBundle)
          : null
  }

  async create(
    request: EnvironmentProbeRequest,
  ): Promise<ExecutionEnvironment> {
    const rawEnv = this.envProvider()
    const probeEnv = this.managedBinRoot
      ? withPrependedPath(rawEnv, this.managedBinRoot, process.platform)
      : rawEnv
    const status = await this.probe.getStatus({
      ...request,
      envOverride: probeEnv,
    })
    const pathEntries = prependUniquePath(
      status.pathEntries,
      this.managedBinRoot,
      status.platform,
    )
    const path = pathEntries.join(status.platform === 'win32' ? ';' : ':')
    const trusted = withTrustedHostEnvironment(
      withPath(rawEnv, path, status.platform),
      status.platform,
      this.emperorPaths,
      this.systemCaBundle,
    )
    const privateEnv = normalizeCapturedEnvironment(
      trusted.env,
      status.platform,
    )
    const env = minimalEnvironment(privateEnv, status.platform, path)
    const toolPaths = Object.fromEntries(
      status.tools
        .filter(
          (tool) => tool.status === 'ready' && Boolean(tool.executablePath),
        )
        .map((tool) => [tool.id, tool.executablePath!]),
    ) as Partial<Record<EnvironmentToolId, string>>
    const managed = readManagedRegistry(
      this.managedRegistryFile,
      this.managedBinRoot,
    )
    const revision = stableEnvironmentHash({
      catalogRevision: status.catalogRevision,
      projectFingerprint: status.projectFingerprint,
      platform: status.platform,
      pathEntries,
      env,
      toolPaths,
      managed,
      privateEnvHash: stableEnvironmentHash(privateEnv),
      emperorPaths: this.emperorPaths,
      caSource: trusted.caSource,
    })
    return new ExecutionEnvironment(
      {
        revision,
        catalogRevision: status.catalogRevision,
        projectFingerprint: status.projectFingerprint,
        createdAt: this.now().toISOString(),
        platform: status.platform,
        pathEntries,
        env,
        toolPaths,
        managedBinRoot: this.managedBinRoot,
        managedCommands: managed.commands,
        managedSources: managed.sources,
        emperorPaths: this.emperorPaths,
        caSource: trusted.caSource,
      },
      privateEnv,
    )
  }

  async refresh(
    request: Omit<EnvironmentProbeRequest, 'forceRefresh'>,
  ): Promise<ExecutionEnvironment> {
    return await this.create({ ...request, forceRefresh: true })
  }
}

function withTrustedHostEnvironment(
  input: Record<string, string | undefined>,
  platform: EnvironmentPlatform,
  emperorPaths: {
    home: string
    skills: string
    environment: string
    scratch: string
  } | null,
  configuredSystemCa: string | null | undefined,
): {
  env: Record<string, string | undefined>
  caSource: 'user' | 'system_bundle' | 'none'
} {
  const env = { ...input }
  if (emperorPaths) {
    env.EMPEROR_HOME = emperorPaths.home
    env.EMPEROR_SKILLS_DIR = emperorPaths.skills
    env.EMPEROR_ENVIRONMENT_DIR = emperorPaths.environment
    env.EMPEROR_SCRATCH_DIR = emperorPaths.scratch
  }
  if (String(env.NODE_EXTRA_CA_CERTS ?? '').trim())
    return { env, caSource: 'user' }
  const candidate =
    configuredSystemCa === undefined
      ? platform === 'darwin'
        ? '/etc/ssl/cert.pem'
        : null
      : configuredSystemCa
  if (candidate && isRegularFile(candidate)) {
    env.NODE_EXTRA_CA_CERTS = candidate
    return { env, caSource: 'system_bundle' }
  }
  return { env, caSource: 'none' }
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function readManagedRegistry(
  registryFile: string | null,
  binRoot: string | null,
): {
  commands: Record<string, string>
  sources: Record<
    string,
    { placement: 'managed' | 'external'; version: string }
  >
} {
  const empty = { commands: {}, sources: {} }
  if (!registryFile || !binRoot || !existsSync(registryFile)) return empty
  try {
    const stat = lstatSync(registryFile)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024)
      return empty
    const parsed = JSON.parse(readFileSync(registryFile, 'utf8')) as unknown
    if (!isRecord(parsed)) return empty
    if (parsed.schemaVersion !== 1 || !isRecord(parsed.tools)) return empty
    const commands: Record<string, string> = {}
    const sources: Record<
      string,
      { placement: 'managed' | 'external'; version: string }
    > = {}
    for (const tool of Object.values(parsed.tools)) {
      if (!isRecord(tool)) continue
      const placement = tool.placement
      const version = String(tool.activeVersion ?? '').trim()
      if (
        (placement !== 'managed' && placement !== 'external') ||
        !version ||
        !isRecord(tool.commands)
      )
        continue
      for (const [name, rawEntry] of Object.entries(tool.commands)) {
        if (!isSafeCommandName(name)) continue
        const entry = String(rawEntry ?? '').trim()
        const executable =
          placement === 'managed'
            ? safeManagedCommandPath(binRoot, entry)
            : isAbsolute(entry)
              ? resolve(entry)
              : null
        if (!executable) continue
        commands[name] = executable
        sources[name] = { placement, version }
      }
    }
    return { commands, sources }
  } catch {
    return empty
  }
}

function safeManagedCommandPath(binRoot: string, entry: string): string | null {
  if (!isSafeCommandName(entry)) return null
  const root = resolve(binRoot)
  const candidate = resolve(join(root, entry))
  const rel = relative(root, candidate)
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) ? candidate : null
}

function isSafeCommandName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function prependUniquePath(
  entries: readonly string[],
  managedBinRoot: string | null,
  platform: EnvironmentPlatform,
): string[] {
  const values = managedBinRoot ? [managedBinRoot, ...entries] : [...entries]
  const seen = new Set<string>()
  return values.filter((entry) => {
    const key = platform === 'win32' ? entry.toLowerCase() : entry
    if (!entry || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function withPrependedPath(
  env: Record<string, string | undefined>,
  entry: string,
  platform: NodeJS.Platform,
): Record<string, string | undefined> {
  const current = environmentValueLoose(env, 'PATH', platform) ?? ''
  const delimiter = platform === 'win32' ? ';' : ':'
  return withPath(
    env,
    current ? `${entry}${delimiter}${current}` : entry,
    platform,
  )
}

function withPath(
  env: Record<string, string | undefined>,
  path: string,
  platform: NodeJS.Platform | EnvironmentPlatform,
): Record<string, string | undefined> {
  const output = { ...env }
  if (platform === 'win32') {
    const existing = Object.keys(output).find(
      (name) => name.toLowerCase() === 'path',
    )
    if (existing && existing !== 'PATH') delete output[existing]
  }
  output.PATH = path
  return output
}

function environmentValueLoose(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[name]
  const target = name.toLowerCase()
  return Object.entries(env).find(([key]) => key.toLowerCase() === target)?.[1]
}

function normalizeCapturedEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  platform: EnvironmentPlatform,
): Readonly<Record<string, string>> {
  const selected: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const [name, rawValue] of Object.entries(env).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (selected.length >= MAX_ENV_ENTRIES || !isSafeEnvName(name)) continue
    if (rawValue === undefined) continue
    const value = String(rawValue)
    if (Buffer.byteLength(value, 'utf8') > MAX_ENV_VALUE_BYTES) continue
    const key = platform === 'win32' ? name.toLowerCase() : name
    if (seen.has(key)) continue
    seen.add(key)
    selected.push([name, value])
  }
  return Object.freeze(Object.fromEntries(selected))
}

function minimalEnvironment(
  source: Readonly<Record<string, string>>,
  platform: EnvironmentPlatform,
  path: string,
): Record<string, string> {
  const output: Record<string, string> = { PATH: path }
  const names = platform === 'win32' ? WINDOWS_ENV_KEYS : POSIX_ENV_KEYS
  for (const name of names) {
    const value = environmentValue(source, name, platform)
    if (value !== undefined) output[name] = value
  }
  return output
}

function environmentValue(
  env: Readonly<Record<string, string>>,
  name: string,
  platform: EnvironmentPlatform,
): string | undefined {
  if (platform !== 'win32') return env[name]
  const target = name.toLowerCase()
  return Object.entries(env).find(([key]) => key.toLowerCase() === target)?.[1]
}

function isSafeEnvName(name: string): boolean {
  return (
    ENV_NAME_PATTERN.test(name) && !RESERVED_ENV_NAMES.has(name.toLowerCase())
  )
}
