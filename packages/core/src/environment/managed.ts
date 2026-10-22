import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { replaceFileAtomic } from '../skills/manager'
import type { SkillManager } from '../skills/manager'
import { EnvironmentStore } from './store'

const MAX_METADATA_BYTES = 2 * 1024 * 1024
const PLAN_ID_PATTERN = /^managed_plan_[a-f0-9]{16,48}$/
const SAFE_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type ManagedEnvironmentRecipeKind =
  'python_venv' | 'npm_prefix' | 'verified_archive'
export type ManagedEnvironmentPlacement = 'managed' | 'external'
export type ManagedEnvironmentRecipeTrust =
  'installed_skill_source' | 'user_url_digest' | 'signed_tool_catalog'
export type ManagedEnvironmentDataRootMode = 'managed' | 'external_disclosed'

export interface ManagedEnvironmentInstallSource {
  kind: 'skill' | 'url'
  value: string
  resolvedUrl: string
  digest: string
  repository: string | null
  ref: string | null
}

export interface ManagedEnvironmentInstallCandidate {
  candidateId: string
  relativeRoot: string
  recipeKind: ManagedEnvironmentRecipeKind
  toolId: string
  version: string
  publisher: string
  license: string
  entrypoints: string[]
  potentialInstallScripts: string[]
  dataRootMode: ManagedEnvironmentDataRootMode
  dataRootEnvironmentVariable: string | null
  commandEntries: Record<string, string>
  placement: ManagedEnvironmentPlacement
  externalCommandAvailable: boolean
}

export interface ManagedEnvironmentInstallPreview {
  planId: string
  createdAt: string
  expiresAt: string
  digest: string
  placement: ManagedEnvironmentPlacement
  recipeTrust: ManagedEnvironmentRecipeTrust
  source: ManagedEnvironmentInstallSource
  estimatedBytes: number
  candidates: ManagedEnvironmentInstallCandidate[]
}

export interface ManagedEnvironmentVerification {
  command: string
  exitCode: number
  output: string
}

export interface ManagedEnvironmentInstallResult {
  jobId: string
  planId: string
  toolId: string
  version: string
  placement: ManagedEnvironmentPlacement
  status: 'active'
  commands: string[]
  dataRootMode: ManagedEnvironmentDataRootMode
  verification: ManagedEnvironmentVerification
  receipt: string
}

export interface ManagedEnvironmentServiceOptions {
  stateRoot: string
  skillManager: SkillManager
  now?: () => Date
  platform?: NodeJS.Platform
  onInstallEvent?: (
    event: ManagedEnvironmentInstallEvent,
  ) => void | Promise<void>
}

export interface ManagedEnvironmentInstallEvent {
  phase: 'started' | 'completed' | 'failed'
  jobId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  toolId: string
  source: 'skill' | 'url'
  placement: ManagedEnvironmentPlacement
  recipeTrust: ManagedEnvironmentRecipeTrust
  errorCode: string | null
}

interface ManagedRegistry {
  schemaVersion: 1
  tools: Record<string, ManagedRegistryTool>
}

interface ManagedRegistryTool {
  toolId: string
  placement: ManagedEnvironmentPlacement
  activeVersion: string | null
  activeKey: string | null
  sourceDigest: string
  recipeTrust: ManagedEnvironmentRecipeTrust
  dataRootMode: ManagedEnvironmentDataRootMode
  dataRootEnvironmentVariable: string | null
  commands: Record<string, string>
  commandTargets?: Record<string, string>
  versions: Record<
    string,
    {
      root: string
      version: string
      digest: string
      status: 'healthy' | 'failed'
      installedAt: string
    }
  >
  updatedAt: string
}

interface ManagedJobRecord {
  schemaVersion: 1
  jobId: string
  planId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  toolId: string
  version: string
  placement: ManagedEnvironmentPlacement
  recipeTrust: ManagedEnvironmentRecipeTrust
  sourceDigest: string
  sourceKind: 'skill' | 'url'
  createdAt: string
  updatedAt: string
  error: string | null
}

export class ManagedEnvironmentService {
  readonly stateRoot: string
  readonly store: EnvironmentStore
  private readonly now: () => Date
  private readonly platform: NodeJS.Platform
  private readonly onInstallEvent: (
    event: ManagedEnvironmentInstallEvent,
  ) => void | Promise<void>
  private readonly controllers = new Map<string, AbortController>()

  constructor(opts: ManagedEnvironmentServiceOptions) {
    this.stateRoot = resolve(opts.stateRoot)
    if (this.stateRoot !== opts.skillManager.stateRoot)
      throw new Error('Managed Environment and Skill roots must match')
    this.now = opts.now ?? (() => new Date())
    this.platform = opts.platform ?? process.platform
    this.onInstallEvent = opts.onInstallEvent ?? (() => undefined)
    this.store = new EnvironmentStore(this.stateRoot)
    this.store.initialize()
    this.ensureManagedLayout()
  }

  async initialize(): Promise<{ interrupted: string[] }> {
    this.ensureManagedLayout()
    this.repairActiveCommands()
    const interrupted: string[] = []
    for (const planId of this.managedPlanIds()) {
      const job = this.readJob(planId)
      if (!job || job.status !== 'running') continue
      const updated = {
        ...job,
        status: 'interrupted' as const,
        updatedAt: this.now().toISOString(),
        error: 'application restarted during managed installation',
      }
      this.writeJob(planId, updated)
      await this.emitInstallEvent({
        phase: 'failed',
        jobId: job.jobId,
        status: 'interrupted',
        toolId: job.toolId,
        source: job.sourceKind ?? 'url',
        placement: job.placement,
        recipeTrust: job.recipeTrust,
        errorCode: 'managed_install_interrupted',
      })
      interrupted.push(job.jobId)
    }
    this.cleanupExpiredPreviews()
    return { interrupted }
  }

  async status(): Promise<{
    schemaVersion: 1
    tools: ManagedRegistry['tools']
    jobs: ManagedJobRecord[]
  }> {
    const jobs = this.managedPlanIds()
      .map((planId) => this.readJob(planId))
      .filter((job): job is ManagedJobRecord => Boolean(job))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return {
      schemaVersion: 1,
      tools: structuredClone(this.readRegistry().tools),
      jobs,
    }
  }

  async cancel(input: {
    jobId: string
    sessionId: string
  }): Promise<{ cancelled: boolean }> {
    requiredSessionId(input.sessionId)
    const controller = this.controllers.get(String(input.jobId ?? '').trim())
    if (!controller) return { cancelled: false }
    controller.abort('managed environment installation cancelled')
    return { cancelled: true }
  }

  private activateCommand(command: string, executable: string): string {
    if (!SAFE_COMMAND_PATTERN.test(command))
      throw new Error('unsafe managed command name')
    mkdirSync(this.store.paths.bin, { recursive: true, mode: 0o700 })
    if (this.platform === 'win32') {
      const filename = `${command}.cmd`
      const target = join(this.store.paths.bin, filename)
      const temp = `${target}.tmp-${randomBytes(6).toString('hex')}`
      writeFileSync(temp, `@echo off\r\n"${executable}" %*\r\n`, {
        flag: 'wx',
        mode: 0o700,
      })
      replaceFileAtomic(temp, target)
      return filename
    }
    const target = join(this.store.paths.bin, command)
    const temp = `${target}.tmp-${randomBytes(6).toString('hex')}`
    symlinkSync(executable, temp)
    replaceFileAtomic(temp, target)
    return command
  }

  private repairActiveCommands(): void {
    const registry = this.readRegistry()
    for (const tool of Object.values(registry.tools)) {
      if (
        tool.placement !== 'managed' ||
        !tool.activeVersion ||
        !tool.commandTargets
      )
        continue
      for (const [command, relativeTarget] of Object.entries(
        tool.commandTargets,
      )) {
        if (!SAFE_COMMAND_PATTERN.test(command)) continue
        try {
          const executable = safeChild(this.store.paths.root, relativeTarget)
          if (!existsSync(executable) || !lstatSync(executable).isFile())
            continue
          this.activateCommand(command, executable)
        } catch {
          // A corrupt entry remains inactive and visible through Diagnostics.
        }
      }
    }
  }

  private ensureManagedLayout(): void {
    for (const path of [
      join(this.store.paths.jobs, 'managed'),
      join(this.store.paths.receipts, 'managed'),
    ])
      mkdirSync(path, { recursive: true, mode: 0o700 })
  }

  private managedPlanIds(): string[] {
    const root = join(this.store.paths.jobs, 'managed')
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && PLAN_ID_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
  }

  private planRoot(planId: string): string {
    if (!PLAN_ID_PATTERN.test(planId))
      throw new Error('invalid managed plan id')
    return safeChild(join(this.store.paths.jobs, 'managed'), planId)
  }

  private readPreview(planId: string): {
    schemaVersion: 1
    sessionId: string
    preview: ManagedEnvironmentInstallPreview
  } {
    const value = readJsonObject(join(this.planRoot(planId), 'preview.json'))
    if (
      value.schemaVersion !== 1 ||
      typeof value.sessionId !== 'string' ||
      !isRecord(value.preview)
    )
      throw new Error('managed environment preview state is invalid')
    return value as unknown as {
      schemaVersion: 1
      sessionId: string
      preview: ManagedEnvironmentInstallPreview
    }
  }

  private writeJob(planId: string, job: ManagedJobRecord): void {
    atomicWriteJson(join(this.planRoot(planId), 'job.json'), job)
  }

  private readJob(planId: string): ManagedJobRecord | null {
    const path = join(this.planRoot(planId), 'job.json')
    if (!existsSync(path)) return null
    const value = readJsonObject(path)
    return value.schemaVersion === 1 && typeof value.jobId === 'string'
      ? (value as unknown as ManagedJobRecord)
      : null
  }

  private readRegistry(): ManagedRegistry {
    if (!existsSync(this.store.paths.registry))
      return { schemaVersion: 1, tools: {} }
    const value = readJsonObject(this.store.paths.registry)
    if (value.schemaVersion !== 1 || !isRecord(value.tools))
      throw new Error('managed environment registry is invalid')
    return value as unknown as ManagedRegistry
  }

  private cleanupExpiredPreviews(): void {
    const now = this.now().getTime()
    for (const planId of this.managedPlanIds().slice(0, 500)) {
      try {
        const root = this.planRoot(planId)
        if (existsSync(join(root, 'job.json'))) continue
        const { preview } = this.readPreview(planId)
        if (now >= Date.parse(preview.expiresAt))
          rmSync(root, { recursive: true, force: true })
      } catch {
        // Corrupt preview roots remain inert for diagnostics.
      }
    }
  }

  private async emitInstallEvent(
    event: ManagedEnvironmentInstallEvent,
  ): Promise<void> {
    try {
      await this.onInstallEvent(structuredClone(event))
    } catch {
      // Observability must not change installation or recovery semantics.
    }
  }
}

function regularFileStat(path: string, maxBytes: number) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes)
    throw new Error('managed environment archive is unsafe')
  return stat
}

function readJsonObject(path: string): Record<string, unknown> {
  const text = readBoundedText(path)
  const parsed = JSON.parse(text) as unknown
  if (!isRecord(parsed)) throw new Error('expected JSON object')
  return parsed
}

function readBoundedText(path: string): string {
  const stat = regularFileStat(path, MAX_METADATA_BYTES)
  const content = readFileSync(path, 'utf8')
  if (Buffer.byteLength(content) !== stat.size)
    throw new Error('managed metadata changed while reading')
  return content
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
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

function safeChild(root: string, child: string): string {
  const boundary = resolve(root)
  const candidate = resolve(boundary, child)
  const rel = relative(boundary, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('managed environment path escapes its root')
  return candidate
}

function requiredSessionId(value: string): string {
  const sessionId = String(value ?? '').trim()
  if (!sessionId || sessionId.length > 256)
    throw new Error('managed environment session id is required')
  return sessionId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
