import { randomBytes } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, extname, isAbsolute, join, resolve, win32 } from 'node:path'
import { z } from 'zod'
import { LEGACY_SKILL_STATE_FILE } from '../runtime/resources'
import {
  SkillManager,
  replaceFileAtomic,
  type SkillRequirements,
} from './manager'

const MAX_GITHUB_METADATA_BYTES = 1024 * 1024
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type SkillInstallSourceInput =
  { kind: 'local'; path: string } | { kind: 'url'; url: string }

export type SkillMissingRequirements = SkillRequirements

export type ResolvedSkillInstallSource =
  | {
      kind: 'local'
      path: string
      resolvedUrl: null
      repository: null
      ref: null
      requestedPath: null
    }
  | {
      kind: 'direct_https'
      path: null
      resolvedUrl: string
      repository: null
      ref: null
      requestedPath: null
    }
  | {
      kind: 'github_repo' | 'github_tree'
      path: null
      resolvedUrl: string
      repository: string
      ref: string
      requestedPath: string | null
    }

export interface SkillInstallScriptRisk {
  path: string
  type: string
}

export interface SkillInstallCandidate {
  candidateId: string
  name: string
  relativeRoot: string
  valid: boolean
  errors: string[]
  warnings: string[]
  fileCount: number
  files: string[]
  totalBytes: number
  digest: string
  scripts: SkillInstallScriptRisk[]
  externalCommands: string[]
  environmentVariables: string[]
  requirements: SkillRequirements
  missing: SkillMissingRequirements
}

export interface SkillInstallPreview {
  previewId: string
  createdAt: string
  expiresAt: string
  source: ResolvedSkillInstallSource
  digest: string
  archiveBytes: number
  unpackedBytes: number
  fileCount: number
  candidates: SkillInstallCandidate[]
}

export interface SkillInstallResult {
  name: string
  status: 'active' | 'blocked'
  digest: string
  source: ResolvedSkillInstallSource
  missing: SkillMissingRequirements
  installedAt: string
}

export interface SkillConfirmInstallInput {
  previewId: string
  digest: string
  candidateId?: string
  permissionConfirmed: boolean
}

export interface SkillInstallServiceOptions {
  manager: SkillManager
  stateRoot: string
  now?: () => Date
  resolveMissing?: (
    requirements: SkillRequirements,
  ) => Promise<SkillMissingRequirements>
  env?:
    | Record<string, string | undefined>
    | (() => Record<string, string | undefined>)
  platform?: NodeJS.Platform
}

export class SkillInstallService {
  private readonly manager: SkillManager
  private readonly resolveMissing: (
    requirements: SkillRequirements,
  ) => Promise<SkillMissingRequirements>
  constructor(opts: SkillInstallServiceOptions) {
    this.manager = opts.manager
    const stateRoot = resolve(opts.stateRoot)
    if (stateRoot !== this.manager.stateRoot)
      throw new Error('Skill install state root must match SkillManager')
    const configuredEnv = opts.env
    const envProvider =
      typeof configuredEnv === 'function'
        ? () => ({ ...configuredEnv() })
        : configuredEnv
          ? () => ({ ...configuredEnv })
          : () => ({ ...process.env })
    const platform = opts.platform ?? process.platform
    this.resolveMissing =
      opts.resolveMissing ??
      (async (requirements) =>
        defaultMissingRequirements(requirements, envProvider(), platform))
  }

  removeInstallationRecord(name: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(name))
      throw new Error('Invalid Skill installation record name')
    const registryPath = join(
      this.manager.userSkillsDirectory(),
      'installed.v1.json',
    )
    if (!pathEntryExists(registryPath)) return
    const raw = JSON.parse(
      readBoundedRegularFile(registryPath, MAX_GITHUB_METADATA_BYTES).toString(
        'utf8',
      ),
    ) as unknown
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Number((raw as Record<string, unknown>).schemaVersion) !== 1 ||
      !(raw as Record<string, unknown>).skills ||
      typeof (raw as Record<string, unknown>).skills !== 'object' ||
      Array.isArray((raw as Record<string, unknown>).skills)
    )
      throw new Error('Skill installation registry is invalid')
    const registry = raw as {
      schemaVersion: 1
      skills: Record<string, unknown>
    }
    if (!Object.prototype.hasOwnProperty.call(registry.skills, name)) return
    delete registry.skills[name]
    atomicWriteJson(registryPath, registry)
  }

  async reconcileBlocked(): Promise<{
    activated: string[]
    blocked: string[]
  }> {
    const activated: string[] = []
    const blocked: string[] = []
    for (const record of this.manager.listRecords()) {
      if (record.source !== 'user' || record.status !== 'blocked') continue
      const markerPath = join(record.root, LEGACY_SKILL_STATE_FILE)
      const marker = readInstallMarker(markerPath)
      if (!marker) continue
      const validation = this.manager.validateRecord(record)
      const missing = normalizeMissing(
        await this.resolveMissing(validation.requirements),
        validation.requirements,
      )
      if (hasMissing(missing)) {
        atomicWriteJson(markerPath, { ...marker, missing })
        blocked.push(record.name)
      } else {
        rmSync(markerPath, { force: true })
        activated.push(record.name)
      }
    }
    return { activated: activated.sort(), blocked: blocked.sort() }
  }
}

const missingRequirementsSchema = z
  .object({
    bins: z.array(z.string()),
    runtimes: z.array(z.string()),
    env: z.array(z.string()),
  })
  .strict()

function readBoundedRegularFile(path: string, maxBytes: number): Buffer {
  const pathStat = lstatSync(path, { bigint: true })
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.size > BigInt(maxBytes)
  )
    throw new Error('Skill archive must be a bounded regular file')
  const noFollow =
    typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const before = fstatSync(descriptor, { bigint: true })
    if (
      !before.isFile() ||
      before.size > BigInt(maxBytes) ||
      pathStat.dev !== before.dev ||
      pathStat.ino !== before.ino ||
      pathStat.size !== before.size ||
      pathStat.mtimeNs !== before.mtimeNs
    )
      throw new Error('Skill archive must be a bounded regular file')
    const content = readFileSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      after.size !== BigInt(content.byteLength)
    )
      throw new Error('Skill archive changed while reading')
    return content
  } finally {
    closeSync(descriptor)
  }
}

function normalizeMissing(
  value: SkillMissingRequirements,
  declared: SkillRequirements,
): SkillMissingRequirements {
  const parsed = missingRequirementsSchema.parse(value)
  return {
    bins: intersection(parsed.bins, declared.bins),
    runtimes: intersection(parsed.runtimes, declared.runtimes),
    env: intersection(parsed.env, declared.env),
  }
}

function intersection(values: string[], declared: string[]): string[] {
  const allowed = new Set(declared)
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => allowed.has(value)),
    ),
  ].sort()
}

function hasMissing(missing: SkillMissingRequirements): boolean {
  return Boolean(
    missing.bins.length || missing.runtimes.length || missing.env.length,
  )
}

function defaultMissingRequirements(
  requirements: SkillRequirements,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): SkillMissingRequirements {
  const pathEntries = String(env.PATH ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => isAbsolute(entry))
  const bins = requirements.bins.filter(
    (name) => !resolveExecutable(name, pathEntries, env, platform),
  )
  const runtimeExecutables: Record<string, string[]> = {
    node: ['node'],
    python: ['python3', 'python'],
    go: ['go'],
    rust: ['rustc'],
  }
  const runtimes = requirements.runtimes.filter((runtime) => {
    const executables = runtimeExecutables[runtime.toLowerCase()]
    return (
      !executables ||
      !executables.some((name) =>
        resolveExecutable(name, pathEntries, env, platform),
      )
    )
  })
  const missingEnv = requirements.env.filter(
    (name) => !SAFE_ENV_NAME.test(name) || !env[name],
  )
  return {
    bins: [...new Set(bins)].sort(),
    runtimes: [...new Set(runtimes)].sort(),
    env: [...new Set(missingEnv)].sort(),
  }
}

function resolveExecutable(
  name: string,
  pathEntries: string[],
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | null {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return null
  const extensions =
    platform === 'win32' && !extname(name)
      ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((entry) => /^\.[A-Za-z0-9]+$/.test(entry))
      : ['']
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate =
        platform === 'win32'
          ? win32.join(directory, `${name}${extension}`)
          : join(directory, `${name}${extension}`)
      try {
        const canonical = realpathSync(candidate)
        accessSync(canonical, constants.X_OK)
        const stat = lstatSync(canonical)
        if (!stat.isSymbolicLink() && stat.isFile()) return canonical
      } catch {
        // Continue through the bounded PATH candidates.
      }
    }
  }
  return null
}

function readInstallMarker(path: string): Record<string, unknown> | null {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) return null
    const value = JSON.parse(
      readBoundedRegularFile(path, 64 * 1024).toString('utf8'),
    ) as unknown
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).status !== 'blocked' ||
      (value as Record<string, unknown>).source !== 'skill_install'
    )
      return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    replaceFileAtomic(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
