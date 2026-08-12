import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { replaceFileAtomic } from '../skills/manager'
import type { SkillManager } from '../skills/manager'
import type { ExecutionEnvironment } from './snapshot'
import { NodeHttpsAssetDownloader, type AssetDownloader } from './download'
import {
  managedEnvironmentOperationFingerprint,
  type ManagedEnvironmentInstallAuthorization,
  type OwnedProcessRequest,
  type OwnedProcessRunner,
} from './process-runner'
import { EnvironmentStore } from './store'
import { extractBoundedZip } from './zip'

const PREVIEW_TTL_MS = 10 * 60 * 1_000
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
const MAX_FILE_BYTES = 500 * 1024 * 1024
const MAX_FILES = 10_000
const MAX_METADATA_BYTES = 2 * 1024 * 1024
const PLAN_ID_PATTERN = /^managed_plan_[a-f0-9]{16,48}$/
const SAFE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
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
  processRunner: OwnedProcessRunner
  downloader?: AssetDownloader
  now?: () => Date
  idFactory?: () => string
  platform?: NodeJS.Platform
  onEnvironmentChanged?: () => void | Promise<void>
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
  private readonly skillManager: SkillManager
  private readonly processRunner: OwnedProcessRunner
  private readonly downloader: AssetDownloader
  private readonly now: () => Date
  private readonly idFactory: () => string
  private readonly platform: NodeJS.Platform
  private readonly onEnvironmentChanged: () => void | Promise<void>
  private readonly onInstallEvent: (
    event: ManagedEnvironmentInstallEvent,
  ) => void | Promise<void>
  private readonly controllers = new Map<string, AbortController>()

  constructor(opts: ManagedEnvironmentServiceOptions) {
    this.stateRoot = resolve(opts.stateRoot)
    if (this.stateRoot !== opts.skillManager.stateRoot)
      throw new Error('Managed Environment and Skill roots must match')
    this.skillManager = opts.skillManager
    this.processRunner = opts.processRunner
    this.downloader = opts.downloader ?? new NodeHttpsAssetDownloader()
    this.now = opts.now ?? (() => new Date())
    this.idFactory =
      opts.idFactory ??
      (() => `managed_plan_${randomBytes(12).toString('hex')}`)
    this.platform = opts.platform ?? process.platform
    this.onEnvironmentChanged = opts.onEnvironmentChanged ?? (() => undefined)
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

  async previewInstall(input: {
    source: { kind: 'skill' | 'url'; value: string }
    sessionId: string
    signal?: AbortSignal
    executionEnvironment?: ExecutionEnvironment
  }): Promise<ManagedEnvironmentInstallPreview> {
    this.cleanupExpiredPreviews()
    const sessionId = requiredSessionId(input.sessionId)
    const planId = this.idFactory()
    if (!PLAN_ID_PATTERN.test(planId))
      throw new Error('invalid managed environment plan id')
    const planRoot = this.planRoot(planId)
    if (existsSync(planRoot)) throw new Error('managed plan id collision')
    mkdirSync(planRoot, { recursive: false, mode: 0o700 })
    const archive = join(planRoot, 'archive.zip')
    try {
      const sourceResolution = await this.resolveSource(
        input.source,
        planRoot,
        input.signal,
      )
      await this.downloader.download({
        url: sourceResolution.resolvedUrl,
        destination: archive,
        maxBytes: MAX_ARCHIVE_BYTES,
        signal: input.signal ?? new AbortController().signal,
      })
      const stat = regularFileStat(archive, MAX_ARCHIVE_BYTES)
      const archiveDigest = sha256File(archive)
      if (
        sourceResolution.expectedDigest &&
        sourceResolution.expectedDigest !== archiveDigest
      )
        throw new Error('installed Skill source digest changed')
      this.cacheArchive(archive, archiveDigest)
      const extractedRoot = join(planRoot, 'extracted')
      const extracted = extractBoundedZip({
        archive,
        destination: extractedRoot,
        maxArchiveBytes: MAX_ARCHIVE_BYTES,
        maxFiles: MAX_FILES,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_UNPACKED_BYTES,
      })
      const candidates = decorateExternalCandidates(
        inspectCandidates(
          extractedRoot,
          extracted.files,
          sourceResolution.repository,
        ),
        input.executionEnvironment,
        this.store.paths.bin,
        this.platform,
      )
      if (!candidates.length)
        throw new Error(
          'archive contains no supported python_venv, npm_prefix, or verified_archive recipe',
        )
      const created = this.now()
      const source: ManagedEnvironmentInstallSource = {
        kind: input.source.kind,
        value: input.source.value,
        resolvedUrl: sourceResolution.resolvedUrl,
        digest: archiveDigest,
        repository: sourceResolution.repository,
        ref: sourceResolution.ref,
      }
      const base = {
        planId,
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + PREVIEW_TTL_MS).toISOString(),
        placement: candidates.every(
          (candidate) => candidate.placement === 'external',
        )
          ? ('external' as const)
          : ('managed' as const),
        recipeTrust: sourceResolution.recipeTrust,
        source,
        estimatedBytes: stat.size + extracted.totalBytes,
        candidates,
      }
      const preview: ManagedEnvironmentInstallPreview = {
        ...base,
        digest: stableHash({
          emperorHome: sha256(this.stateRoot),
          sessionId,
          source,
          placement: base.placement,
          recipeTrust: base.recipeTrust,
          candidates,
        }),
      }
      atomicWriteJson(join(planRoot, 'preview.json'), {
        schemaVersion: 1,
        sessionId,
        preview,
      })
      return structuredClone(preview)
    } catch (error) {
      rmSync(planRoot, { recursive: true, force: true })
      throw error
    }
  }

  async confirmInstall(input: {
    planId: string
    digest: string
    candidateId?: string
    sessionId: string
    permissionConfirmed: boolean
    executionEnvironment: ExecutionEnvironment
    signal?: AbortSignal
  }): Promise<ManagedEnvironmentInstallResult> {
    if (!input.permissionConfirmed)
      throw new Error(
        'managed environment installation confirmation is required',
      )
    if (!PLAN_ID_PATTERN.test(input.planId) || !isSha256(input.digest))
      throw new Error('invalid managed environment confirmation')
    const sessionId = requiredSessionId(input.sessionId)
    const stored = this.readPreview(input.planId)
    if (stored.sessionId !== sessionId)
      throw new Error('managed environment plan belongs to another session')
    const preview = stored.preview
    if (preview.digest !== input.digest)
      throw new Error('managed environment plan digest is stale')
    if (this.now().getTime() >= Date.parse(preview.expiresAt))
      throw new Error('managed environment plan expired')
    const archive = join(this.planRoot(input.planId), 'archive.zip')
    if (sha256File(archive) !== preview.source.digest)
      throw new Error('managed environment source archive changed')
    const candidate = selectCandidate(preview.candidates, input.candidateId)
    const currentCandidates = decorateExternalCandidates(
      inspectCandidates(
        join(this.planRoot(input.planId), 'extracted'),
        listRelativeFiles(join(this.planRoot(input.planId), 'extracted')),
        preview.source.repository,
      ),
      input.executionEnvironment,
      this.store.paths.bin,
      this.platform,
    )
    const current = currentCandidates.find(
      (item) => item.candidateId === candidate.candidateId,
    )
    if (!current || stableHash(current) !== stableHash(candidate))
      throw new Error('managed environment candidate changed after preview')
    const jobId = `managed_job_${randomBytes(12).toString('hex')}`
    const createdAt = this.now().toISOString()
    const job: ManagedJobRecord = {
      schemaVersion: 1,
      jobId,
      planId: preview.planId,
      status: 'running',
      toolId: candidate.toolId,
      version: candidate.version,
      placement: candidate.placement,
      recipeTrust: preview.recipeTrust,
      sourceDigest: preview.source.digest,
      sourceKind: preview.source.kind,
      createdAt,
      updatedAt: createdAt,
      error: null,
    }
    this.writeJob(preview.planId, job)
    await this.emitInstallEvent({
      phase: 'started',
      jobId,
      status: 'running',
      toolId: candidate.toolId,
      source: preview.source.kind,
      placement: candidate.placement,
      recipeTrust: preview.recipeTrust,
      errorCode: null,
    })
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    const forwardAbort = (): void => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', forwardAbort, { once: true })
    try {
      const installed = await this.installCandidate({
        preview,
        candidate,
        jobId,
        sessionId,
        executionEnvironment: input.executionEnvironment,
        signal: controller.signal,
      })
      const finished = this.now().toISOString()
      this.writeJob(preview.planId, {
        ...job,
        status: 'completed',
        updatedAt: finished,
      })
      const receiptRelative = `environment/receipts/managed/${jobId}.json`
      atomicWriteJson(join(this.stateRoot, receiptRelative), {
        schemaVersion: 1,
        ...installed,
        jobId,
        planId: preview.planId,
        source: preview.source,
        sourceDigest: preview.source.digest,
        recipeTrust: preview.recipeTrust,
        placement: installed.placement,
        startedAt: createdAt,
        finishedAt: finished,
      })
      await this.onEnvironmentChanged()
      await this.emitInstallEvent({
        phase: 'completed',
        jobId,
        status: 'completed',
        toolId: candidate.toolId,
        source: preview.source.kind,
        placement: installed.placement,
        recipeTrust: preview.recipeTrust,
        errorCode: null,
      })
      return {
        jobId,
        planId: preview.planId,
        toolId: candidate.toolId,
        version: candidate.version,
        placement: installed.placement,
        status: 'active',
        commands: candidate.entrypoints,
        dataRootMode: candidate.dataRootMode,
        verification: installed.verification,
        receipt: receiptRelative,
      }
    } catch (error) {
      const cancelled = controller.signal.aborted
      this.writeJob(preview.planId, {
        ...job,
        status: cancelled ? 'cancelled' : 'failed',
        updatedAt: this.now().toISOString(),
        error: safeError(error),
      })
      await this.emitInstallEvent({
        phase: 'failed',
        jobId,
        status: cancelled ? 'cancelled' : 'failed',
        toolId: candidate.toolId,
        source: preview.source.kind,
        placement: candidate.placement,
        recipeTrust: preview.recipeTrust,
        errorCode: cancelled
          ? 'managed_install_cancelled'
          : 'managed_install_failed',
      })
      throw error
    } finally {
      input.signal?.removeEventListener('abort', forwardAbort)
      this.controllers.delete(jobId)
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

  private async installCandidate(input: {
    preview: ManagedEnvironmentInstallPreview
    candidate: ManagedEnvironmentInstallCandidate
    jobId: string
    sessionId: string
    executionEnvironment: ExecutionEnvironment
    signal: AbortSignal
  }): Promise<{
    verification: ManagedEnvironmentVerification
    placement: ManagedEnvironmentPlacement
  }> {
    const candidate = input.candidate
    if (candidate.placement === 'external')
      return await this.registerExternalCandidate(input)
    const key = `${safeSegment(candidate.version)}-${input.preview.source.digest.slice(0, 12)}`
    const target = safeChild(
      this.store.paths.tools,
      `${candidate.toolId}/${key}`,
    )
    if (existsSync(target))
      throw new Error('managed environment immutable target already exists')
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    const extractedRoot = join(this.planRoot(input.preview.planId), 'extracted')
    const sourceRoot = safeChild(extractedRoot, candidate.relativeRoot || '.')
    const env = {
      ...input.executionEnvironment.hostProcessEnv(),
      ...input.executionEnvironment.env,
    }
    if (candidate.dataRootMode === 'managed') {
      const variable = candidate.dataRootEnvironmentVariable
      if (!variable) throw new Error('managed data root variable is missing')
      const dataRoot = safeChild(this.store.paths.data, candidate.toolId)
      mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
      env[variable] = dataRoot
    }
    try {
      if (candidate.recipeKind === 'python_venv') {
        const python =
          input.executionEnvironment.managedCommands.python ??
          input.executionEnvironment.toolPaths.python
        if (!python) throw new Error('python runtime is missing')
        await this.runAuthorized(
          input,
          python,
          ['-m', 'venv', target],
          sourceRoot,
          env,
        )
        const venvPython =
          this.platform === 'win32'
            ? join(target, 'Scripts', 'python.exe')
            : join(target, 'bin', 'python')
        await this.runAuthorized(
          input,
          venvPython,
          [
            '-m',
            'pip',
            '--disable-pip-version-check',
            '--no-input',
            'install',
            sourceRoot,
          ],
          sourceRoot,
          env,
        )
      } else if (candidate.recipeKind === 'npm_prefix') {
        const npm =
          input.executionEnvironment.managedCommands.npm ??
          input.executionEnvironment.toolPaths.npm
        if (!npm) throw new Error('npm runtime is missing')
        mkdirSync(target, { recursive: true, mode: 0o700 })
        await this.runAuthorized(
          input,
          npm,
          [
            'install',
            '--global',
            '--prefix',
            target,
            '--no-audit',
            '--no-fund',
            sourceRoot,
          ],
          sourceRoot,
          env,
        )
      } else {
        copyDirectory(sourceRoot, target)
      }
      const installedCommands = Object.fromEntries(
        Object.entries(candidate.commandEntries).map(([command, entry]) => {
          const path =
            candidate.recipeKind === 'python_venv' ||
            candidate.recipeKind === 'npm_prefix'
              ? this.platform === 'win32'
                ? candidate.recipeKind === 'python_venv'
                  ? safeChild(target, `Scripts/${entry}.exe`)
                  : safeChild(target, `${entry}.cmd`)
                : safeChild(target, `bin/${entry}`)
              : safeChild(target, entry)
          if (!existsSync(path) || !lstatSync(path).isFile())
            throw new Error(`installed command is missing: ${command}`)
          if (this.platform !== 'win32') chmodSync(path, 0o700)
          return [command, path]
        }),
      )
      const [primaryName, primaryExecutable] =
        Object.entries(installedCommands)[0]!
      const verificationArgs =
        primaryName === 'agent-reach' ? ['doctor', '--json'] : ['--version']
      const verificationResult = await this.runAuthorized(
        input,
        primaryExecutable,
        verificationArgs,
        target,
        env,
      )
      this.commitActivation({
        preview: input.preview,
        candidate,
        key,
        target,
        installedCommands,
      })
      return {
        placement: 'managed',
        verification: {
          command: `${primaryName} ${verificationArgs.join(' ')}`,
          exitCode: verificationResult.exitCode ?? 0,
          output: boundedOutput(
            verificationResult.stdout || verificationResult.stderr,
          ),
        },
      }
    } catch (error) {
      rmSync(target, { recursive: true, force: true })
      throw error
    }
  }

  private async runAuthorized(
    input: {
      preview: ManagedEnvironmentInstallPreview
      candidate: ManagedEnvironmentInstallCandidate
      sessionId: string
      signal: AbortSignal
    },
    executable: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ) {
    if (!isAbsolute(executable))
      throw new Error('managed installer executable must be absolute')
    const operationFingerprint = managedEnvironmentOperationFingerprint({
      executable,
      args,
      cwd,
    })
    const authorization: ManagedEnvironmentInstallAuthorization = {
      version: 1,
      toolName: 'manage_environment',
      operationFingerprint,
      source: 'managed_environment_install',
      planId: input.preview.planId,
      recipeDigest: input.preview.digest,
      toolId: input.candidate.toolId,
      toolVersion: input.candidate.version,
      emperorHomeDigest: sha256(this.stateRoot),
      sessionId: input.sessionId,
      authorizationId: input.preview.planId,
    }
    const request: OwnedProcessRequest = {
      executable,
      args,
      cwd,
      env,
      timeoutMs: 30 * 60 * 1_000,
      maxOutputBytes: 1024 * 1024,
      signal: input.signal,
      execution: { kind: 'host', authorization },
      owner: {
        kind: 'environment',
        id: input.preview.planId,
        sessionId: input.sessionId,
      },
    }
    const result = await this.processRunner.run(request)
    if (
      result.status !== 'completed' ||
      result.exitCode !== 0 ||
      result.containment.decision !== 'unsandboxed'
    )
      throw new Error(
        `managed install process failed: ${result.status}/${String(result.exitCode)} ${boundedOutput(result.stderr || result.error || '')}`,
      )
    return result
  }

  private async registerExternalCandidate(input: {
    preview: ManagedEnvironmentInstallPreview
    candidate: ManagedEnvironmentInstallCandidate
    sessionId: string
    executionEnvironment: ExecutionEnvironment
    signal: AbortSignal
  }): Promise<{
    verification: ManagedEnvironmentVerification
    placement: 'external'
  }> {
    const commands = resolveExternalCommands(
      input.candidate,
      input.executionEnvironment,
      this.store.paths.bin,
      this.platform,
    )
    if (!commands)
      throw new Error('external command changed after managed preview')
    const [primaryName, primaryExecutable] = Object.entries(commands)[0]!
    const env = {
      ...input.executionEnvironment.hostProcessEnv(),
      ...input.executionEnvironment.env,
    }
    if (input.candidate.dataRootMode === 'managed') {
      const variable = input.candidate.dataRootEnvironmentVariable
      if (!variable) throw new Error('managed data root variable is missing')
      const dataRoot = safeChild(this.store.paths.data, input.candidate.toolId)
      mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
      env[variable] = dataRoot
    }
    const cwd = this.planRoot(input.preview.planId)
    const versionResult = await this.runAuthorized(
      input,
      primaryExecutable,
      ['--version'],
      cwd,
      env,
    )
    const versionOutput = boundedOutput(
      versionResult.stdout || versionResult.stderr,
    )
    if (!outputContainsVersion(versionOutput, input.candidate.version))
      throw new Error('external command version does not match preview recipe')
    const verificationArgs =
      primaryName === 'agent-reach' ? ['doctor', '--json'] : ['--version']
    const verificationResult =
      primaryName === 'agent-reach'
        ? await this.runAuthorized(
            input,
            primaryExecutable,
            verificationArgs,
            cwd,
            env,
          )
        : versionResult
    this.commitExternalRegistration(input, commands)
    return {
      placement: 'external',
      verification: {
        command: `${primaryName} ${verificationArgs.join(' ')}`,
        exitCode: verificationResult.exitCode ?? 0,
        output: boundedOutput(
          verificationResult.stdout || verificationResult.stderr,
        ),
      },
    }
  }

  private commitExternalRegistration(
    input: {
      preview: ManagedEnvironmentInstallPreview
      candidate: ManagedEnvironmentInstallCandidate
    },
    commands: Record<string, string>,
  ): void {
    const registry = this.readRegistry()
    const previous = registry.tools[input.candidate.toolId]
    const key = `external-${input.preview.source.digest.slice(0, 12)}`
    registry.tools[input.candidate.toolId] = {
      toolId: input.candidate.toolId,
      placement: 'external',
      activeVersion: input.candidate.version,
      activeKey: key,
      sourceDigest: input.preview.source.digest,
      recipeTrust: input.preview.recipeTrust,
      dataRootMode: input.candidate.dataRootMode,
      dataRootEnvironmentVariable: input.candidate.dataRootEnvironmentVariable,
      commands,
      versions: {
        ...(previous?.versions ?? {}),
        [key]: {
          root: '',
          version: input.candidate.version,
          digest: input.preview.source.digest,
          status: 'healthy',
          installedAt: this.now().toISOString(),
        },
      },
      updatedAt: this.now().toISOString(),
    }
    atomicWriteJson(this.store.paths.registry, registry)
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

  private commitActivation(input: {
    preview: ManagedEnvironmentInstallPreview
    candidate: ManagedEnvironmentInstallCandidate
    key: string
    target: string
    installedCommands: Record<string, string>
  }): void {
    const previousRegistry = this.readRegistry()
    const registry = structuredClone(previousRegistry)
    const previous = previousRegistry.tools[input.candidate.toolId]
    const commands = Object.fromEntries(
      Object.keys(input.installedCommands).map((command) => [
        command,
        this.platform === 'win32' ? `${command}.cmd` : command,
      ]),
    )
    const commandTargets = Object.fromEntries(
      Object.entries(input.installedCommands).map(([command, executable]) => [
        command,
        relative(this.store.paths.root, executable).replace(/\\/g, '/'),
      ]),
    )
    registry.tools[input.candidate.toolId] = {
      toolId: input.candidate.toolId,
      placement: 'managed',
      activeVersion: input.candidate.version,
      activeKey: input.key,
      sourceDigest: input.preview.source.digest,
      recipeTrust: input.preview.recipeTrust,
      dataRootMode: input.candidate.dataRootMode,
      dataRootEnvironmentVariable: input.candidate.dataRootEnvironmentVariable,
      commands,
      commandTargets,
      versions: {
        ...(previous?.versions ?? {}),
        [input.key]: {
          root: relative(this.store.paths.root, input.target).replace(
            /\\/g,
            '/',
          ),
          version: input.candidate.version,
          digest: input.preview.source.digest,
          status: 'healthy',
          installedAt: this.now().toISOString(),
        },
      },
      updatedAt: this.now().toISOString(),
    }
    atomicWriteJson(this.store.paths.registry, registry)
    try {
      for (const [command, executable] of Object.entries(
        input.installedCommands,
      ))
        this.activateCommand(command, executable)
    } catch (error) {
      atomicWriteJson(this.store.paths.registry, previousRegistry)
      this.restoreCommandLinks(previous, Object.keys(input.installedCommands))
      throw error
    }
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

  private restoreCommandLinks(
    previous: ManagedRegistryTool | undefined,
    attemptedCommands: string[],
  ): void {
    const restored = new Set<string>()
    if (previous?.commandTargets) {
      for (const [command, relativeTarget] of Object.entries(
        previous.commandTargets,
      )) {
        try {
          const executable = safeChild(this.store.paths.root, relativeTarget)
          if (!existsSync(executable) || !lstatSync(executable).isFile())
            continue
          this.activateCommand(command, executable)
          restored.add(command)
        } catch {
          // The previous registry remains the source of truth for recovery.
        }
      }
    }
    for (const command of attemptedCommands) {
      if (restored.has(command)) continue
      const filename = this.platform === 'win32' ? `${command}.cmd` : command
      const target = join(this.store.paths.bin, filename)
      if (pathEntryExists(target)) rmSync(target, { force: true })
    }
  }

  private async resolveSource(
    source: { kind: 'skill' | 'url'; value: string },
    planRoot: string,
    signal?: AbortSignal,
  ): Promise<{
    resolvedUrl: string
    expectedDigest: string | null
    repository: string | null
    ref: string | null
    recipeTrust: ManagedEnvironmentRecipeTrust
  }> {
    const value = String(source.value ?? '').trim()
    if (!value) throw new Error('managed environment source is required')
    if (source.kind === 'skill') {
      const record = this.skillManager.resolve(value)
      if (
        !record ||
        record.source !== 'user' ||
        (record.status !== 'active' && record.status !== 'blocked')
      )
        throw new Error(
          'managed dependency source must be an installed user Skill',
        )
      const installation = readInstalledSkillSource(
        join(this.skillManager.userSkillsDir, 'installed.v1.json'),
        value,
      )
      return {
        resolvedUrl: installation.resolvedUrl,
        expectedDigest: installation.digest,
        repository: installation.repository,
        ref: installation.ref,
        recipeTrust: 'installed_skill_source',
      }
    }
    if (source.kind !== 'url')
      throw new Error('managed environment source kind must be skill or url')
    const url = safeSourceUrl(value)
    const github = parseGithubRepository(url)
    if (github) {
      const metadata = join(planRoot, 'github.json')
      const ref = await this.resolveGithubRef(github, metadata, signal)
      return {
        resolvedUrl: `https://codeload.github.com/${github.owner}/${github.repository}/zip/${ref}`,
        expectedDigest: null,
        repository: `${github.owner}/${github.repository}`,
        ref,
        recipeTrust: 'user_url_digest',
      }
    }
    if (!/\.(?:zip|skill)$/i.test(url.pathname))
      throw new Error(
        'managed environment URL must be a GitHub source or archive',
      )
    return {
      resolvedUrl: url.toString(),
      expectedDigest: null,
      repository: null,
      ref: null,
      recipeTrust: 'user_url_digest',
    }
  }

  private async resolveGithubRef(
    github: {
      owner: string
      repository: string
      refParts: string[]
      exactRef: boolean
    },
    metadata: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!github.refParts.length) {
      await this.downloader.download({
        url: `https://api.github.com/repos/${github.owner}/${github.repository}`,
        destination: metadata,
        maxBytes: MAX_METADATA_BYTES,
        signal: signal ?? new AbortController().signal,
      })
      const repository = readJsonObject(metadata)
      const ref = String(repository.default_branch ?? '').trim()
      rmSync(metadata, { force: true })
      if (!ref || ref.includes('..')) throw new Error('GitHub ref is invalid')
      return await this.resolveGithubCommit(
        github.owner,
        github.repository,
        ref,
        metadata,
        signal,
      )
    }
    const minimumSplit = github.exactRef ? github.refParts.length : 1
    for (
      let split = github.refParts.length;
      split >= minimumSplit;
      split -= 1
    ) {
      const ref = github.refParts.slice(0, split).join('/')
      if (!ref || ref.includes('..')) continue
      try {
        return await this.resolveGithubCommit(
          github.owner,
          github.repository,
          ref,
          metadata,
          signal,
        )
      } catch {
        rmSync(metadata, { force: true })
      }
    }
    throw new Error('GitHub ref could not be resolved')
  }

  private async resolveGithubCommit(
    owner: string,
    repository: string,
    ref: string,
    metadata: string,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.downloader.download({
      url: `https://api.github.com/repos/${owner}/${repository}/commits/${encodeURIComponent(ref)}`,
      destination: metadata,
      maxBytes: MAX_METADATA_BYTES,
      signal: signal ?? new AbortController().signal,
    })
    const commit = readJsonObject(metadata)
    rmSync(metadata, { force: true })
    const sha = String(commit.sha ?? '').toLowerCase()
    if (!/^[a-f0-9]{40,64}$/.test(sha))
      throw new Error('GitHub commit metadata is invalid')
    return sha
  }

  private cacheArchive(archive: string, digest: string): void {
    const downloads = this.store.paths.downloads
    mkdirSync(downloads, { recursive: true, mode: 0o700 })
    const cached = safeChild(downloads, `${digest}.zip`)
    if (existsSync(cached)) {
      if (sha256File(cached) === digest) return
      rmSync(cached, { force: true })
    }
    const temporary = safeChild(
      downloads,
      `.${digest}.tmp-${randomBytes(6).toString('hex')}`,
    )
    try {
      copyFileSync(archive, temporary, constants.COPYFILE_EXCL)
      if (this.platform !== 'win32') chmodSync(temporary, 0o600)
      if (sha256File(temporary) !== digest)
        throw new Error('managed environment download cache changed')
      renameSync(temporary, cached)
    } finally {
      rmSync(temporary, { force: true })
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

function inspectCandidates(
  extractedRoot: string,
  files: string[],
  repository: string | null,
): ManagedEnvironmentInstallCandidate[] {
  const candidates: ManagedEnvironmentInstallCandidate[] = []
  for (const file of files.sort()) {
    const root = dirname(file) === '.' ? '' : dirname(file)
    const absolute = safeChild(extractedRoot, file)
    if (basename(file) === 'emperor-environment.json') {
      const manifest = readJsonObject(absolute)
      if (manifest.schemaVersion !== 1 || !isRecord(manifest.commands))
        throw new Error('verified archive manifest is invalid')
      const commands = normalizeArchiveCommands(
        manifest.commands,
        extractedRoot,
        root,
      )
      candidates.push(
        candidate({
          root,
          recipeKind: 'verified_archive',
          toolId: String(manifest.toolId ?? ''),
          version: String(manifest.version ?? ''),
          publisher: String(manifest.publisher ?? repository ?? 'unknown'),
          license: String(manifest.license ?? 'unknown'),
          commandEntries: commands,
          potentialInstallScripts: [],
          dataRootMode:
            isRecord(manifest.dataRoot) && manifest.dataRoot.mode === 'managed'
              ? 'managed'
              : 'external_disclosed',
          dataRootEnvironmentVariable:
            isRecord(manifest.dataRoot) && manifest.dataRoot.mode === 'managed'
              ? safeEnvName(manifest.dataRoot.env)
              : null,
        }),
      )
      continue
    }
    if (basename(file) === 'pyproject.toml') {
      const parsed = parseToml(readBoundedText(absolute)) as Record<
        string,
        unknown
      >
      const project = asRecord(parsed.project)
      const scripts = asRecord(project.scripts)
      if (!Object.keys(scripts).length) continue
      const buildSystem = asRecord(parsed['build-system'])
      const backend = String(buildSystem['build-backend'] ?? '').trim()
      candidates.push(
        candidate({
          root,
          recipeKind: 'python_venv',
          toolId: String(project.name ?? ''),
          version: String(project.version ?? ''),
          publisher: repository ?? projectPublisher(project),
          license: projectLicense(project.license),
          commandEntries: Object.fromEntries(
            Object.keys(scripts).map((name) => [name, name]),
          ),
          potentialInstallScripts: backend
            ? [`python_build_backend:${backend}`]
            : [],
          dataRootMode: 'external_disclosed',
          dataRootEnvironmentVariable: null,
        }),
      )
      continue
    }
    if (basename(file) === 'package.json') {
      const pkg = readJsonObject(absolute)
      const bin =
        typeof pkg.bin === 'string'
          ? { [unscopedPackageName(String(pkg.name ?? ''))]: pkg.bin }
          : asRecord(pkg.bin)
      if (!Object.keys(bin).length) continue
      candidates.push(
        candidate({
          root,
          recipeKind: 'npm_prefix',
          toolId: String(pkg.name ?? ''),
          version: String(pkg.version ?? ''),
          publisher: repository ?? packagePublisher(pkg),
          license: String(pkg.license ?? 'unknown'),
          commandEntries: Object.fromEntries(
            Object.keys(bin).map((name) => [name, name]),
          ),
          potentialInstallScripts: Object.keys(asRecord(pkg.scripts))
            .filter((name) => /^(?:preinstall|install|postinstall)$/.test(name))
            .map((name) => `npm:${name}`),
          dataRootMode: 'external_disclosed',
          dataRootEnvironmentVariable: null,
        }),
      )
    }
  }
  const unique = new Map(
    candidates.map((item) => [
      `${item.recipeKind}:${item.relativeRoot}:${item.toolId}`,
      item,
    ]),
  )
  return [...unique.values()].sort((left, right) =>
    left.toolId.localeCompare(right.toolId),
  )
}

function decorateExternalCandidates(
  candidates: ManagedEnvironmentInstallCandidate[],
  executionEnvironment: ExecutionEnvironment | undefined,
  managedBinRoot: string,
  platform: NodeJS.Platform,
): ManagedEnvironmentInstallCandidate[] {
  return candidates.map((candidate) => {
    const available = Boolean(
      executionEnvironment &&
      resolveExternalCommands(
        candidate,
        executionEnvironment,
        managedBinRoot,
        platform,
      ),
    )
    return {
      ...candidate,
      placement: available ? 'external' : 'managed',
      externalCommandAvailable: available,
    }
  })
}

function resolveExternalCommands(
  candidate: ManagedEnvironmentInstallCandidate,
  executionEnvironment: ExecutionEnvironment,
  managedBinRoot: string,
  platform: NodeJS.Platform,
): Record<string, string> | null {
  const output: Record<string, string> = {}
  for (const command of candidate.entrypoints) {
    const executable = resolveExternalCommand(
      command,
      executionEnvironment.pathEntries,
      managedBinRoot,
      platform,
    )
    if (!executable) return null
    output[command] = executable
  }
  return output
}

function resolveExternalCommand(
  command: string,
  pathEntries: readonly string[],
  managedBinRoot: string,
  platform: NodeJS.Platform,
): string | null {
  if (!SAFE_COMMAND_PATTERN.test(command)) return null
  const managed = resolve(managedBinRoot)
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const entry of pathEntries) {
    if (resolve(entry) === managed) continue
    for (const suffix of suffixes) {
      const candidate = resolve(entry, `${command}${suffix}`)
      try {
        const stat = statSync(candidate)
        if (!stat.isFile()) continue
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Continue to the next trusted PATH entry.
      }
    }
  }
  return null
}

function candidate(input: {
  root: string
  recipeKind: ManagedEnvironmentRecipeKind
  toolId: string
  version: string
  publisher: string
  license: string
  commandEntries: Record<string, unknown> | Record<string, string>
  potentialInstallScripts: string[]
  dataRootMode: ManagedEnvironmentDataRootMode
  dataRootEnvironmentVariable: string | null
}): ManagedEnvironmentInstallCandidate {
  const toolId = normalizeToolId(input.toolId)
  const version = String(input.version ?? '').trim()
  if (!version || version.length > 256)
    throw new Error('managed recipe version is missing or invalid')
  const commandEntries: Record<string, string> = {}
  for (const [name, entry] of Object.entries(input.commandEntries)) {
    if (!SAFE_COMMAND_PATTERN.test(name))
      throw new Error('managed recipe command name is invalid')
    const value = String(entry ?? '').trim()
    if (!value || isAbsolute(value) || value.split(/[\\/]/).includes('..'))
      throw new Error('managed recipe command entry is invalid')
    commandEntries[name] = value
  }
  if (!Object.keys(commandEntries).length)
    throw new Error('managed recipe has no command entrypoint')
  const relativeRoot = input.root.replace(/\\/g, '/')
  return {
    candidateId: `candidate_${sha256(
      `${input.recipeKind}\0${relativeRoot}\0${toolId}`,
    ).slice(0, 20)}`,
    relativeRoot,
    recipeKind: input.recipeKind,
    toolId,
    version,
    publisher: String(input.publisher || 'unknown').slice(0, 256),
    license: String(input.license || 'unknown').slice(0, 256),
    entrypoints: Object.keys(commandEntries).sort(),
    potentialInstallScripts: [...input.potentialInstallScripts].sort(),
    dataRootMode: input.dataRootMode,
    dataRootEnvironmentVariable: input.dataRootEnvironmentVariable,
    commandEntries,
    placement: 'managed',
    externalCommandAvailable: false,
  }
}

function normalizeArchiveCommands(
  commands: Record<string, unknown>,
  extractedRoot: string,
  candidateRoot: string,
): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, rawEntry] of Object.entries(commands)) {
    const entry = String(rawEntry ?? '')
      .trim()
      .replace(/\\/g, '/')
    if (!SAFE_COMMAND_PATTERN.test(name) || !entry)
      throw new Error('verified archive command is invalid')
    const absolute = safeChild(
      extractedRoot,
      candidateRoot ? `${candidateRoot}/${entry}` : entry,
    )
    if (!existsSync(absolute) || !lstatSync(absolute).isFile())
      throw new Error('verified archive command entry is missing')
    output[name] = entry
  }
  return output
}

function readInstalledSkillSource(
  registryPath: string,
  skillName: string,
): {
  resolvedUrl: string
  digest: string
  repository: string | null
  ref: string | null
} {
  const registry = readJsonObject(registryPath)
  const skills = asRecord(registry.skills)
  const record = asRecord(skills[skillName])
  const source = asRecord(record.source)
  const resolvedUrl = String(source.resolvedUrl ?? '').trim()
  const digest = String(record.sourceDigest ?? '').trim()
  if (!resolvedUrl || !isSha256(digest))
    throw new Error('installed Skill has no verified dependency source')
  safeSourceUrl(resolvedUrl)
  return {
    resolvedUrl,
    digest,
    repository: String(source.repository ?? '').trim() || null,
    ref: String(source.ref ?? '').trim() || null,
  }
}

function parseGithubRepository(url: URL): {
  owner: string
  repository: string
  refParts: string[]
  exactRef: boolean
} | null {
  const host = url.hostname.toLowerCase()
  if (
    host !== 'github.com' &&
    host !== 'raw.githubusercontent.com' &&
    host !== 'codeload.github.com'
  )
    return null
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) throw new Error('GitHub source URL is incomplete')
  const owner = parts[0]!
  const repository = parts[1]!.replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error('GitHub repository path is invalid')
  let refParts: string[] = []
  let exactRef = false
  if (host === 'raw.githubusercontent.com') refParts = parts.slice(2)
  else if (host === 'codeload.github.com') {
    if (parts[2] !== 'zip') throw new Error('unsupported codeload URL')
    refParts = parts.slice(3)
    exactRef = true
  } else if (parts[2] === 'tree' || parts[2] === 'blob')
    refParts = parts.slice(3)
  else if (parts.length > 2) throw new Error('unsupported GitHub source URL')
  if (
    refParts.length > 32 ||
    refParts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        !/^[A-Za-z0-9._-]+$/.test(part),
    )
  )
    throw new Error('GitHub source path is invalid')
  return { owner, repository, refParts, exactRef }
}

function safeSourceUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('managed environment source URL is invalid')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error('managed environment source URL is unsafe')
  return url
}

function selectCandidate(
  candidates: ManagedEnvironmentInstallCandidate[],
  candidateId?: string,
): ManagedEnvironmentInstallCandidate {
  if (candidateId) {
    const selected = candidates.find((item) => item.candidateId === candidateId)
    if (!selected)
      throw new Error('managed environment candidate was not found')
    return selected
  }
  if (candidates.length !== 1)
    throw new Error('managed environment candidateId is required')
  return candidates[0]!
}

function copyDirectory(source: string, target: string): void {
  mkdirSync(target, { recursive: false, mode: 0o700 })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) copyDirectory(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
    else throw new Error('managed archive contains unsupported file type')
  }
}

function listRelativeFiles(root: string, current = root): string[] {
  const files: string[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...listRelativeFiles(root, path))
    else if (entry.isFile())
      files.push(relative(root, path).replace(/\\/g, '/'))
    else throw new Error('managed preview contains unsupported file type')
  }
  return files.sort()
}

function regularFileStat(path: string, maxBytes: number) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes)
    throw new Error('managed environment archive is unsafe')
  return stat
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
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

function normalizeToolId(value: string): string {
  const raw = String(value ?? '').trim()
  const packageId = raw.startsWith('@') ? raw.slice(1).replace('/', '-') : raw
  const normalized = packageId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 96)
  if (!normalized || !SAFE_ID_PATTERN.test(normalized))
    throw new Error('managed recipe tool id is invalid')
  return normalized
}

function unscopedPackageName(value: string): string {
  return value.startsWith('@') ? (value.split('/')[1] ?? '') : value
}

function safeSegment(value: string): string {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 96)
  if (!normalized) throw new Error('managed version path is invalid')
  return normalized
}

function safeEnvName(value: unknown): string {
  const name = String(value ?? '').trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))
    throw new Error('managed data root environment variable is invalid')
  return name
}

function projectLicense(value: unknown): string {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  return String(record.text ?? record.file ?? 'unknown')
}

function projectPublisher(project: Record<string, unknown>): string {
  const authors = Array.isArray(project.authors) ? project.authors : []
  const first = authors[0]
  return isRecord(first) ? String(first.name ?? 'unknown') : 'unknown'
}

function packagePublisher(pkg: Record<string, unknown>): string {
  if (typeof pkg.author === 'string') return pkg.author
  return String(asRecord(pkg.author).name ?? 'unknown')
}

function requiredSessionId(value: string): string {
  const sessionId = String(value ?? '').trim()
  if (!sessionId || sessionId.length > 256)
    throw new Error('managed environment session id is required')
  return sessionId
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

function sha256File(path: string): string {
  regularFileStat(path, MAX_ARCHIVE_BYTES)
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableHash(value: unknown): string {
  return sha256(JSON.stringify(sortJson(value)))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  )
}

function boundedOutput(value: string): string {
  return String(value ?? '').slice(0, 8_000)
}

function outputContainsVersion(output: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^0-9A-Za-z])v?${escaped}(?:$|[^0-9A-Za-z])`).test(
    output,
  )
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1_000,
  )
}
