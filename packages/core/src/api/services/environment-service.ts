import { resolve } from 'node:path'
import type { LoadedToolCatalog } from '../../environment/catalog'
import { EnvironmentError } from '../../environment/errors'
import {
  EnvironmentInstallOrchestrator,
  type EnvironmentStepExecutor,
} from '../../environment/jobs'
import { LinuxEnvironmentAdapter } from '../../environment/linux-adapter'
import { MacEnvironmentAdapter } from '../../environment/macos-adapter'
import type {
  EnvironmentArch,
  EnvironmentInstallPlan,
  EnvironmentJobRecord,
  EnvironmentToolId,
} from '../../environment/models'
import {
  collectSkillEnvironmentRequirements,
  type EnvironmentProbeRequest,
  type EnvironmentProbeStatus,
} from '../../environment/probe'
import type { EnvironmentLogPage } from '../../environment/store'
import { WindowsEnvironmentAdapter } from '../../environment/windows-adapter'
import type { SkillManager } from '../../skills/manager'
import * as runtimeEvents from '../../runtime/events'

const RECENT_JOB_LIMIT = 20
const TERMINAL_JOB_STATUSES = new Set([
  'completed',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
])

export interface EnvironmentProbeLike {
  getStatus(request: EnvironmentProbeRequest): Promise<EnvironmentProbeStatus>
  invalidate?(): void
}

export interface CoreEnvironmentServiceOptions {
  stateRoot: string
  catalog: LoadedToolCatalog
  probe: EnvironmentProbeLike
  skillManager: SkillManager
  projectRoot: () => string
  appVersion: string
  runtimeRevision: string
  executor?: EnvironmentStepExecutor
  platform?: NodeJS.Platform
  arch?: string
  env?: Record<string, string | undefined>
  emitRuntime?: (event: Record<string, unknown>) => void | Promise<void>
  reconcileBlockedSkills?: () => Promise<unknown>
}

export interface CoreEnvironmentStatusPayload {
  status: EnvironmentProbeStatus
  catalog: {
    revision: string
    release: string
    licenses: Array<{
      id: string
      name: string
      spdx: string
      url: string
    }>
  }
  activeJob: EnvironmentJobRecord | null
  recentJobs: EnvironmentJobRecord[]
}

export interface CoreEnvironmentDiagnosticsSummary {
  [key: string]: unknown
  catalogRevision: string
  platform: EnvironmentProbeStatus['platform']
  arch: EnvironmentProbeStatus['arch']
  projectRoot: string
  required: number
  ready: number
  missing: number
  versionMismatch: number
  blockedSkills: number
  diagnostics: string[]
  activeJob: Pick<EnvironmentJobRecord, 'jobId' | 'status' | 'updatedAt'> | null
}

export class CoreEnvironmentService {
  readonly stateRoot: string
  readonly orchestrator: EnvironmentInstallOrchestrator
  private readonly catalog: LoadedToolCatalog
  private readonly probe: EnvironmentProbeLike
  private readonly skillManager: SkillManager
  private readonly projectRoot: () => string
  private readonly emitRuntime:
    ((event: Record<string, unknown>) => void | Promise<void>) | null
  private readonly reconcileBlockedSkills: () => Promise<unknown>
  private readonly startedJobs = new Set<string>()
  private readonly terminalJobs = new Set<string>()

  constructor(opts: CoreEnvironmentServiceOptions) {
    this.stateRoot = resolve(opts.stateRoot)
    this.catalog = opts.catalog
    this.probe = opts.probe
    this.skillManager = opts.skillManager
    this.projectRoot = opts.projectRoot
    this.emitRuntime = opts.emitRuntime ?? null
    this.reconcileBlockedSkills =
      opts.reconcileBlockedSkills ?? (async () => undefined)
    this.orchestrator = new EnvironmentInstallOrchestrator({
      stateRoot: this.stateRoot,
      catalog: this.catalog,
      getStatus: async ({ forceRefresh, projectRoot }) =>
        await this.probeStatus({
          forceRefresh,
          projectRoot: projectRoot ?? this.projectRoot(),
        }),
      executor:
        opts.executor ??
        platformExecutor({
          stateRoot: this.stateRoot,
          catalog: this.catalog,
          platform: opts.platform ?? process.platform,
          arch: opts.arch ?? process.arch,
          env: opts.env ?? process.env,
        }),
      appVersion: opts.appVersion,
      runtimeRevision: opts.runtimeRevision,
      onJobUpdate: async (job) => await this.onJobUpdate(job),
    })
  }

  async initialize(): Promise<EnvironmentJobRecord[]> {
    let recovered: EnvironmentJobRecord[] = []
    try {
      recovered = await this.orchestrator.recoverInterruptedJobs()
    } catch (error) {
      if (
        error instanceof EnvironmentError &&
        error.environmentCode === 'job_active'
      )
        return []
      throw error
    }
    try {
      await this.reconcileBlockedSkills()
    } catch {
      // A failed Skill recheck must not prevent the desktop from starting.
    }
    return recovered
  }

  async getStatus(
    input: { forceRefresh?: boolean } = {},
  ): Promise<CoreEnvironmentStatusPayload> {
    const status = await this.probeStatus({
      forceRefresh: Boolean(input.forceRefresh),
      projectRoot: this.projectRoot(),
    })
    const jobs = await this.orchestrator.store.listJobs()
    const recentJobs = jobs
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, RECENT_JOB_LIMIT)
    return {
      status,
      catalog: {
        revision: this.catalog.revision,
        release: this.catalog.catalog.release,
        licenses: this.catalog.catalog.licenses.map((license) => ({
          id: license.id,
          name: license.name,
          spdx: license.spdx,
          url: license.url,
        })),
      },
      activeJob:
        recentJobs.find((job) => !TERMINAL_JOB_STATUSES.has(job.status)) ??
        null,
      recentJobs,
    }
  }

  async createInstallPlan(input: {
    toolIds: EnvironmentToolId[]
  }): Promise<EnvironmentInstallPlan> {
    return await this.orchestrator.createPlan(input)
  }

  async install(input: {
    planId: string
    acceptedLicenseIds: string[]
    confirmedStepIds: string[]
  }): Promise<EnvironmentJobRecord> {
    return await this.orchestrator.install(input)
  }

  async cancelInstall(input: {
    jobId: string
  }): Promise<{ cancelled: boolean; job: EnvironmentJobRecord | null }> {
    const job = await this.orchestrator.cancelActiveInstall(input.jobId)
    return { cancelled: Boolean(job), job }
  }

  async getInstallLog(input: {
    jobId: string
    cursor?: number
    limit?: number
  }): Promise<EnvironmentLogPage> {
    const page = await this.orchestrator.store.readLog(input.jobId, {
      cursor: input.cursor,
      limit: input.limit,
    })
    return { ...page, badLines: page.badLines.slice(0, 20) }
  }

  async diagnosticsSummary(): Promise<CoreEnvironmentDiagnosticsSummary> {
    const payload = await this.getStatus()
    const required = payload.status.tools.filter((tool) => tool.required)
    return {
      catalogRevision: payload.status.catalogRevision,
      platform: payload.status.platform,
      arch: payload.status.arch,
      projectRoot: payload.status.project.projectRoot,
      required: required.length,
      ready: required.filter((tool) => tool.status === 'ready').length,
      missing: required.filter((tool) => tool.status === 'missing').length,
      versionMismatch: required.filter(
        (tool) => tool.status === 'version_mismatch',
      ).length,
      blockedSkills: payload.status.skills.filter(
        (skill) => skill.status === 'blocked',
      ).length,
      diagnostics: payload.status.diagnostics.slice(0, 50),
      activeJob: payload.activeJob
        ? {
            jobId: payload.activeJob.jobId,
            status: payload.activeJob.status,
            updatedAt: payload.activeJob.updatedAt,
          }
        : null,
    }
  }

  private async probeStatus(input: {
    forceRefresh: boolean
    projectRoot: string
  }): Promise<EnvironmentProbeStatus> {
    return await this.probe.getStatus({
      projectRoot: input.projectRoot,
      forceRefresh: input.forceRefresh,
      skillRequirements: collectSkillEnvironmentRequirements(this.skillManager),
    })
  }

  private async onJobUpdate(job: EnvironmentJobRecord): Promise<void> {
    if (
      !TERMINAL_JOB_STATUSES.has(job.status) &&
      !this.startedJobs.has(job.jobId)
    ) {
      this.startedJobs.add(job.jobId)
      await this.emit(
        runtimeEvents.environmentInstallStarted(eventOptions(job)),
      )
    }
    await this.emit(runtimeEvents.environmentInstallProgress(eventOptions(job)))
    if (
      !TERMINAL_JOB_STATUSES.has(job.status) ||
      this.terminalJobs.has(job.jobId)
    )
      return
    this.terminalJobs.add(job.jobId)
    const failed = job.status === 'failed' || job.status === 'interrupted'
    await this.emit(
      failed
        ? runtimeEvents.environmentInstallFailed(eventOptions(job))
        : runtimeEvents.environmentInstallCompleted(eventOptions(job)),
    )
    if (job.status !== 'completed' && job.status !== 'partial') return
    this.probe.invalidate?.()
    try {
      await this.reconcileBlockedSkills()
    } catch {
      // Environment state is authoritative even if a blocked Skill stays blocked.
    }
    await this.emit(
      runtimeEvents.environmentChanged({
        jobId: job.jobId,
        status: job.status,
        catalogRevision: job.catalogRevision,
        projectFingerprint: job.projectFingerprint,
      }),
    )
  }

  private async emit(event: Record<string, unknown>): Promise<void> {
    if (!this.emitRuntime) return
    try {
      await this.emitRuntime(event)
    } catch {
      // Runtime event delivery is observability-only.
    }
  }
}

function completedSteps(job: EnvironmentJobRecord): number {
  return job.steps.filter((step) => step.status === 'completed').length
}

function currentToolId(job: EnvironmentJobRecord): string | null {
  if (!job.currentStepId) return null
  return (
    job.steps.find((step) => step.stepId === job.currentStepId)?.toolId ?? null
  )
}

function eventOptions(job: EnvironmentJobRecord) {
  return {
    jobId: job.jobId,
    status: job.status,
    completedSteps: completedSteps(job),
    totalSteps: job.steps.length,
    toolId: currentToolId(job),
    stepId: job.currentStepId,
    errorCode: job.error?.code ?? null,
  }
}

function platformExecutor(opts: {
  stateRoot: string
  catalog: LoadedToolCatalog
  platform: NodeJS.Platform
  arch: string
  env: Record<string, string | undefined>
}): EnvironmentStepExecutor {
  const arch = supportedArch(opts.arch)
  const downloadsDir = resolve(opts.stateRoot, 'environment', 'downloads')
  const installRoot = resolve(opts.stateRoot, 'environment', 'tools')
  if (opts.platform === 'darwin')
    return new MacEnvironmentAdapter({
      catalog: opts.catalog,
      arch,
      env: opts.env,
      downloadsDir,
    })
  if (opts.platform === 'win32')
    return new WindowsEnvironmentAdapter({
      catalog: opts.catalog,
      arch,
      env: opts.env,
      downloadsDir,
      installRoot,
    })
  if (opts.platform === 'linux')
    return new LinuxEnvironmentAdapter({
      catalog: opts.catalog,
      arch,
      env: opts.env,
      downloadsDir,
      installRoot,
    })
  throw new EnvironmentError('unsupported_platform')
}

function supportedArch(value: string): EnvironmentArch {
  if (value === 'arm64' || value === 'x64') return value
  throw new EnvironmentError('unsupported_arch')
}
