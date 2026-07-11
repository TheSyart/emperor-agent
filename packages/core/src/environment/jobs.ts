import { randomUUID } from 'node:crypto'
import { constants, existsSync, lstatSync } from 'node:fs'
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { LoadedToolCatalog, ToolCatalogEntry } from './catalog'
import {
  EnvironmentError,
  environmentErrorDescriptor,
  type EnvironmentErrorCode,
} from './errors'
import {
  environmentIdSchema,
  environmentInstallPlanSchema,
  environmentInstallStepSchema,
  environmentJobRecordSchema,
  environmentToolIdSchema,
  stableEnvironmentHash,
  type EnvironmentInstallPlan,
  type EnvironmentInstallStep,
  type EnvironmentJobRecord,
  type EnvironmentReceipt,
  type EnvironmentToolId,
} from './models'
import type { EnvironmentProbeStatus } from './probe'
import { EnvironmentStore } from './store'

const PLAN_TTL_MS = 10 * 60 * 1_000
const MAX_PLAN_REGISTRY_SIZE = 128
const LOCK_STALE_MS = 30_000
const LOCK_HEARTBEAT_MS = 5_000

const createPlanInputSchema = z
  .object({
    toolIds: z.array(environmentToolIdSchema).min(1).max(64),
  })
  .strict()

const installInputSchema = z
  .object({
    planId: environmentIdSchema,
    acceptedLicenseIds: z.array(environmentIdSchema).max(64),
    confirmedStepIds: z.array(environmentIdSchema).max(128),
  })
  .strict()

export interface EnvironmentStepExecutionContext {
  step: Readonly<Omit<EnvironmentInstallStep, 'dependsOn'>> & {
    readonly dependsOn: readonly string[]
  }
  signal: AbortSignal
  log: (input: {
    level: 'debug' | 'info' | 'warn' | 'error'
    kind: string
    message: string
    details?: Record<string, unknown>
  }) => Promise<void>
}

export type EnvironmentStepExecutionResult =
  | { status: 'completed'; detectedVersion?: string | null }
  | { status: 'failed'; error?: EnvironmentError }
  | { status: 'cancelled' }
  | { status: 'awaiting_user' }

export interface EnvironmentStepExecutor {
  execute(
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult>
}

export interface EnvironmentInstallOrchestratorOptions {
  stateRoot: string
  catalog: LoadedToolCatalog
  getStatus: (opts: {
    forceRefresh: boolean
    projectRoot: string | null
  }) => Promise<EnvironmentProbeStatus>
  executor: EnvironmentStepExecutor
  appVersion: string
  runtimeRevision: string
  now?: () => Date
  idFactory?: (kind: 'plan' | 'job') => string
  lockStaleMs?: number
  onJobUpdate?: (job: EnvironmentJobRecord) => void | Promise<void>
}

interface RegisteredPlan {
  plan: EnvironmentInstallPlan
  projectRoot: string
}

interface ActiveInstall {
  jobId: string
  controller: AbortController
}

export class EnvironmentInstallOrchestrator {
  readonly stateRoot: string
  readonly store: EnvironmentStore
  private readonly catalog: LoadedToolCatalog
  private readonly getStatus: (opts: {
    forceRefresh: boolean
    projectRoot: string | null
  }) => Promise<EnvironmentProbeStatus>
  private readonly executor: EnvironmentStepExecutor
  private readonly appVersion: string
  private readonly runtimeRevision: string
  private readonly now: () => Date
  private readonly idFactory: (kind: 'plan' | 'job') => string
  private readonly lockStaleMs: number
  private readonly onJobUpdate:
    ((job: EnvironmentJobRecord) => void | Promise<void>) | null
  private readonly plans = new Map<string, RegisteredPlan>()
  private activeInstall: ActiveInstall | null = null

  constructor(opts: EnvironmentInstallOrchestratorOptions) {
    this.stateRoot = opts.stateRoot
    this.catalog = opts.catalog
    this.getStatus = opts.getStatus
    this.executor = opts.executor
    this.appVersion = opts.appVersion
    this.runtimeRevision = opts.runtimeRevision
    this.now = opts.now ?? (() => new Date())
    this.idFactory =
      opts.idFactory ??
      ((kind) => `${kind}_${randomUUID().replace(/-/g, '').slice(0, 16)}`)
    this.lockStaleMs = opts.lockStaleMs ?? LOCK_STALE_MS
    this.onJobUpdate = opts.onJobUpdate ?? null
    this.store = new EnvironmentStore(opts.stateRoot, {
      now: () => this.now().toISOString(),
    })
  }

  async createPlan(input: {
    toolIds: EnvironmentToolId[]
  }): Promise<EnvironmentInstallPlan> {
    const parsed = createPlanInputSchema.parse(input)
    if (
      parsed.toolIds.includes('msvc-build-tools') &&
      new Set(parsed.toolIds).size > 1
    )
      throw new EnvironmentError('confirmation_required')
    const status = await this.getStatus({
      forceRefresh: false,
      projectRoot: null,
    })
    this.assertCatalogBinding(status)
    const plan = buildInstallPlan({
      catalog: this.catalog,
      status,
      toolIds: parsed.toolIds,
      planId: this.idFactory('plan'),
      expiresAt: new Date(this.now().getTime() + PLAN_TTL_MS).toISOString(),
    })
    this.prunePlans()
    this.plans.set(plan.planId, {
      plan,
      projectRoot: status.project.projectRoot,
    })
    return structuredClone(plan)
  }

  async install(input: {
    planId: string
    acceptedLicenseIds: string[]
    confirmedStepIds: string[]
  }): Promise<EnvironmentJobRecord> {
    const parsed = installInputSchema.parse(input)
    const registered = this.plans.get(parsed.planId)
    if (!registered) throw new EnvironmentError('plan_stale')
    validateApprovals(registered.plan, parsed)
    this.store.initialize()
    const lock = await acquireJobLock(this.store.paths.lock, {
      staleMs: this.lockStaleMs,
      now: this.now,
    })
    if (!lock) throw new EnvironmentError('job_active')
    try {
      const existing = await this.activePersistedJob()
      if (existing) throw new EnvironmentError('job_active')
      const status = await this.getStatus({
        forceRefresh: true,
        projectRoot: registered.projectRoot,
      })
      validatePlanBindings(registered.plan, status, this.catalog, this.now())
      return await this.runJob(registered.plan, status)
    } finally {
      await lock.release()
    }
  }

  async cancelActiveInstall(
    expectedJobId?: string,
  ): Promise<EnvironmentJobRecord | null> {
    const active = this.activeInstall
    if (active) {
      if (expectedJobId && active.jobId !== expectedJobId) return null
      const job = await this.store.getJob(active.jobId)
      if (!job) return null
      const cancelling = environmentJobRecordSchema.parse({
        ...job,
        status: 'cancelling',
        updatedAt: this.now().toISOString(),
      })
      await this.store.saveJob(cancelling)
      await this.notifyJobUpdate(cancelling)
      active.controller.abort()
      return cancelling
    }
    const awaiting = (await this.store.listJobs()).find(
      (job) =>
        job.status === 'awaiting_user' &&
        (!expectedJobId || job.jobId === expectedJobId),
    )
    if (!awaiting) return null
    const cancelled = environmentJobRecordSchema.parse({
      ...awaiting,
      status: 'cancelled',
      updatedAt: this.now().toISOString(),
      currentStepId: null,
      steps: awaiting.steps.map((step) => ({
        ...step,
        status: step.status === 'completed' ? 'completed' : 'cancelled',
      })),
      error: safeError('cancelled'),
    })
    await this.store.saveJob(cancelled)
    await this.notifyJobUpdate(cancelled)
    await this.writeReceipt(
      cancelled,
      await this.getStatus({
        forceRefresh: true,
        projectRoot: awaiting.projectRoot,
      }),
    )
    return cancelled
  }

  async recoverInterruptedJobs(): Promise<EnvironmentJobRecord[]> {
    this.store.initialize()
    const lock = await acquireJobLock(this.store.paths.lock, {
      staleMs: this.lockStaleMs,
      now: this.now,
    })
    if (!lock) throw new EnvironmentError('job_active')
    try {
      return await this.recoverInterruptedJobsUnlocked()
    } finally {
      await lock.release()
    }
  }

  private async recoverInterruptedJobsUnlocked(): Promise<
    EnvironmentJobRecord[]
  > {
    const unfinished = (await this.store.listJobs()).filter((job) =>
      isUnfinishedStatus(job.status),
    )
    const recovered: EnvironmentJobRecord[] = []
    for (const job of unfinished) {
      const interrupted = environmentJobRecordSchema.parse({
        ...job,
        status: 'interrupted',
        updatedAt: this.now().toISOString(),
        currentStepId: null,
        steps: job.steps.map((step) => ({
          ...step,
          status:
            step.status === 'completed'
              ? 'completed'
              : step.status === 'failed' || step.status === 'blocked'
                ? step.status
                : 'cancelled',
        })),
        error: safeError('interrupted'),
      })
      await this.store.saveJob(interrupted)
      await this.notifyJobUpdate(interrupted)
      await this.writeReceipt(
        interrupted,
        await this.getStatus({
          forceRefresh: true,
          projectRoot: job.projectRoot,
        }),
      )
      await this.store.appendLog(job.jobId, {
        level: 'warn',
        kind: 'interrupted',
        message: 'Previous environment installation was interrupted.',
        details: {},
      })
      recovered.push(interrupted)
    }
    return recovered
  }

  private async runJob(
    plan: EnvironmentInstallPlan,
    initialStatus: EnvironmentProbeStatus,
  ): Promise<EnvironmentJobRecord> {
    const now = this.now().toISOString()
    let job = environmentJobRecordSchema.parse({
      schemaVersion: 1,
      jobId: this.idFactory('job'),
      planId: plan.planId,
      catalogRevision: plan.catalogRevision,
      projectFingerprint: plan.projectFingerprint,
      projectRoot: initialStatus.project.projectRoot,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      currentStepId: null,
      steps: plan.steps.map((step) => ({ ...step, status: 'planned' })),
      error: null,
    })
    const controller = new AbortController()
    this.activeInstall = { jobId: job.jobId, controller }
    try {
      await this.store.saveJob(job)
      await this.notifyJobUpdate(job)
      await this.store.appendLog(job.jobId, {
        level: 'info',
        kind: 'job_started',
        message: 'Environment installation started.',
        details: { planId: plan.planId },
      })
      for (const step of job.steps) {
        if (controller.signal.aborted) {
          job = await this.updateRemainingAsCancelled(job)
          break
        }
        const dependenciesReady = step.dependsOn.every(
          (dependency) =>
            job.steps.find((candidate) => candidate.stepId === dependency)
              ?.status === 'completed',
        )
        if (!dependenciesReady) {
          job = await this.updateStep(job, step.stepId, 'blocked')
          continue
        }
        job = await this.updateStep(job, step.stepId, 'running')
        let result: EnvironmentStepExecutionResult
        try {
          result = await this.executor.execute({
            step: Object.freeze({
              ...step,
              dependsOn: Object.freeze([...step.dependsOn]),
            }),
            signal: controller.signal,
            log: async (entry) =>
              await this.store.appendLog(job.jobId, {
                level: entry.level,
                kind: entry.kind,
                message: entry.message,
                details: entry.details ?? {},
              }),
          })
        } catch (error) {
          result = controller.signal.aborted
            ? { status: 'cancelled' }
            : {
                status: 'failed',
                error:
                  error instanceof EnvironmentError
                    ? error
                    : new EnvironmentError('installer_failed', {
                        cause: error,
                      }),
              }
        }
        if (result.status === 'awaiting_user') {
          job = await this.updateStep(job, step.stepId, 'awaiting_user')
          job = await this.updateJob(job, {
            status: 'awaiting_user',
            currentStepId: step.stepId,
          })
          return job
        }
        if (result.status === 'cancelled') {
          job = await this.updateStep(job, step.stepId, 'cancelled')
          job = await this.updateRemainingAsCancelled(job)
          break
        }
        if (result.status === 'failed') {
          job = await this.updateStep(job, step.stepId, 'failed')
          job = await this.updateJob(job, {
            error: safeError(
              result.error?.environmentCode ?? 'installer_failed',
            ),
          })
          continue
        }
        job = await this.updateStep(job, step.stepId, 'completed')
      }

      let status = initialStatus
      try {
        status = await this.getStatus({
          forceRefresh: true,
          projectRoot: job.projectRoot,
        })
      } catch {
        job = await this.updateJob(job, {
          status: 'failed',
          currentStepId: null,
          steps: job.steps.map((step) => ({
            ...step,
            status: step.status === 'completed' ? 'failed' : step.status,
          })),
          error: safeError('post_install_probe_failed'),
        })
        await this.writeReceipt(job, initialStatus)
        return job
      }
      const postProbeFailures = new Set(
        job.steps
          .filter(
            (step) =>
              step.status === 'completed' &&
              status.tools.find((tool) => tool.id === step.toolId)?.status !==
                'ready',
          )
          .map((step) => step.stepId),
      )
      if (postProbeFailures.size)
        job = await this.updateJob(job, {
          steps: job.steps.map((step) =>
            postProbeFailures.has(step.stepId)
              ? { ...step, status: 'failed' }
              : step,
          ),
          error: safeError('post_install_probe_failed'),
        })
      const effectiveStatus = terminalJobStatus(job, controller.signal.aborted)
      job = await this.updateJob(job, {
        status: effectiveStatus,
        currentStepId: null,
        error: job.error,
      })
      await this.writeReceipt(job, status)
      return job
    } finally {
      if (this.activeInstall?.jobId === job.jobId) this.activeInstall = null
    }
  }

  private async updateStep(
    job: EnvironmentJobRecord,
    stepId: string,
    status: EnvironmentInstallStep['status'],
  ): Promise<EnvironmentJobRecord> {
    return await this.updateJob(job, {
      currentStepId:
        status === 'running' || status === 'awaiting_user' ? stepId : null,
      steps: job.steps.map((step) =>
        step.stepId === stepId ? { ...step, status } : step,
      ),
    })
  }

  private async updateRemainingAsCancelled(
    job: EnvironmentJobRecord,
  ): Promise<EnvironmentJobRecord> {
    return await this.updateJob(job, {
      steps: job.steps.map((step) => ({
        ...step,
        status: step.status === 'planned' ? 'cancelled' : step.status,
      })),
      error: safeError('cancelled'),
      currentStepId: null,
    })
  }

  private async updateJob(
    job: EnvironmentJobRecord,
    patch: Partial<EnvironmentJobRecord>,
  ): Promise<EnvironmentJobRecord> {
    const updated = environmentJobRecordSchema.parse({
      ...job,
      ...patch,
      updatedAt: this.now().toISOString(),
    })
    await this.store.saveJob(updated)
    await this.notifyJobUpdate(updated)
    return updated
  }

  private async notifyJobUpdate(job: EnvironmentJobRecord): Promise<void> {
    if (!this.onJobUpdate) return
    try {
      await this.onJobUpdate(structuredClone(job))
    } catch {
      // Observability is isolated from the installation state machine.
    }
  }

  private async writeReceipt(
    job: EnvironmentJobRecord,
    status: EnvironmentProbeStatus,
  ): Promise<void> {
    const receipt: EnvironmentReceipt = {
      schemaVersion: 1,
      jobId: job.jobId,
      planId: job.planId,
      catalogRevision: job.catalogRevision,
      appVersion: this.appVersion,
      runtimeRevision: this.runtimeRevision,
      platform: status.platform,
      arch: status.arch,
      startedAt: job.createdAt,
      finishedAt: this.now().toISOString(),
      status: job.status,
      steps: job.steps.map((step) => ({
        stepId: step.stepId,
        toolId: step.toolId,
        outcome: receiptOutcome(step.status),
        detectedVersion:
          status.tools.find((tool) => tool.id === step.toolId)
            ?.detectedVersion ?? null,
        errorCode:
          step.status === 'failed'
            ? (job.error?.code ?? 'installer_failed')
            : step.status === 'cancelled'
              ? job.status === 'interrupted'
                ? 'interrupted'
                : 'cancelled'
              : null,
      })),
    }
    await this.store.saveReceipt(receipt)
  }

  private assertCatalogBinding(status: EnvironmentProbeStatus): void {
    if (status.catalogRevision !== this.catalog.revision)
      throw new EnvironmentError('plan_stale')
  }

  private prunePlans(): void {
    const now = this.now().getTime()
    for (const [id, registered] of this.plans) {
      if (Date.parse(registered.plan.expiresAt) < now) this.plans.delete(id)
    }
    while (this.plans.size >= MAX_PLAN_REGISTRY_SIZE) {
      const oldest = this.plans.keys().next().value as string | undefined
      if (!oldest) break
      this.plans.delete(oldest)
    }
  }

  private async activePersistedJob(): Promise<EnvironmentJobRecord | null> {
    return (
      (await this.store.listJobs()).find((job) =>
        isUnfinishedStatus(job.status),
      ) ?? null
    )
  }
}

function buildInstallPlan(opts: {
  catalog: LoadedToolCatalog
  status: EnvironmentProbeStatus
  toolIds: EnvironmentToolId[]
  planId: string
  expiresAt: string
}): EnvironmentInstallPlan {
  const tools = new Map(
    opts.catalog.catalog.tools.map((tool) => [tool.id, tool]),
  )
  const states = new Map(opts.status.tools.map((tool) => [tool.id, tool]))
  const requested = [...new Set(opts.toolIds)].sort()
  const ordered: ToolCatalogEntry[] = []
  const visited = new Set<EnvironmentToolId>()
  const visit = (toolId: EnvironmentToolId): void => {
    if (visited.has(toolId)) return
    visited.add(toolId)
    const tool = tools.get(toolId)
    const state = states.get(toolId)
    if (!tool || !state) throw new EnvironmentError('unsupported_requirement')
    for (const dependency of tool.dependencies) visit(dependency)
    if (state.status === 'ready') return
    if (state.status === 'unsupported' || state.status === 'blocked')
      throw new EnvironmentError('unsupported_requirement')
    ordered.push(tool)
  }
  for (const toolId of requested) visit(toolId)
  const included = new Set(ordered.map((tool) => tool.id))
  const steps = ordered.map((tool) => {
    const state = states.get(tool.id)!
    const strategy = tool.strategies.find(
      (candidate) =>
        candidate.id === state.installStrategy &&
        candidate.targets.some(
          (target) =>
            target.platform === opts.status.platform &&
            target.arch === opts.status.arch,
        ),
    )
    if (!strategy) throw new EnvironmentError('unsupported_requirement')
    return environmentInstallStepSchema.parse({
      stepId: `step_${tool.id}`,
      toolId: tool.id,
      strategyId: strategy.id,
      dependsOn: tool.dependencies
        .filter((dependency) => included.has(dependency))
        .map((dependency) => `step_${dependency}`),
      status: 'planned',
      requiresElevation: strategy.requiresElevation,
      requiresSeparateConfirmation: strategy.requiresSeparateConfirmation,
    })
  })
  return environmentInstallPlanSchema.parse({
    planId: opts.planId,
    catalogRevision: opts.catalog.revision,
    projectFingerprint: opts.status.projectFingerprint,
    toolStateHash: toolStateHash(opts.status),
    expiresAt: opts.expiresAt,
    steps,
    requiredLicenseIds: [...new Set(ordered.map((tool) => tool.licenseId))],
    warnings: steps.flatMap((step) => [
      ...(step.requiresElevation ? [`${step.toolId}: elevation_required`] : []),
      ...(step.requiresSeparateConfirmation
        ? [`${step.toolId}: separate_confirmation_required`]
        : []),
    ]),
  })
}

function validateApprovals(
  plan: EnvironmentInstallPlan,
  input: z.infer<typeof installInputSchema>,
): void {
  const required = new Set(plan.requiredLicenseIds)
  const accepted = new Set(input.acceptedLicenseIds)
  if (
    required.size !== accepted.size ||
    [...required].some((license) => !accepted.has(license))
  )
    throw new EnvironmentError('license_not_accepted')
  const stepIds = new Set(plan.steps.map((step) => step.stepId))
  if (input.confirmedStepIds.some((stepId) => !stepIds.has(stepId)))
    throw new EnvironmentError('confirmation_required')
  const confirmed = new Set(input.confirmedStepIds)
  if (
    plan.steps.some(
      (step) =>
        step.requiresSeparateConfirmation && !confirmed.has(step.stepId),
    )
  )
    throw new EnvironmentError('confirmation_required')
}

function validatePlanBindings(
  plan: EnvironmentInstallPlan,
  status: EnvironmentProbeStatus,
  catalog: LoadedToolCatalog,
  now: Date,
): void {
  if (
    Date.parse(plan.expiresAt) <= now.getTime() ||
    plan.catalogRevision !== catalog.revision ||
    status.catalogRevision !== plan.catalogRevision ||
    status.projectFingerprint !== plan.projectFingerprint ||
    toolStateHash(status) !== plan.toolStateHash
  )
    throw new EnvironmentError('plan_stale')
}

function toolStateHash(status: EnvironmentProbeStatus): string {
  return stableEnvironmentHash({
    platform: status.platform,
    arch: status.arch,
    tools: status.tools,
  })
}

function terminalJobStatus(
  job: EnvironmentJobRecord,
  cancelled: boolean,
): EnvironmentJobRecord['status'] {
  if (cancelled || job.steps.some((step) => step.status === 'cancelled'))
    return 'cancelled'
  const completed = job.steps.some((step) => step.status === 'completed')
  const failed = job.steps.some(
    (step) => step.status === 'failed' || step.status === 'blocked',
  )
  if (failed) return completed ? 'partial' : 'failed'
  return 'completed'
}

function receiptOutcome(
  status: EnvironmentInstallStep['status'],
): EnvironmentReceipt['steps'][number]['outcome'] {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'skipped'
}

function safeError(code: EnvironmentErrorCode): EnvironmentJobRecord['error'] {
  const descriptor = environmentErrorDescriptor(code)
  return {
    code,
    message: descriptor.message,
    action: descriptor.action as NonNullable<
      EnvironmentJobRecord['error']
    >['action'],
  }
}

function isUnfinishedStatus(status: EnvironmentJobRecord['status']): boolean {
  return (
    status === 'planned' ||
    status === 'running' ||
    status === 'awaiting_user' ||
    status === 'cancelling'
  )
}

interface JobLock {
  release(): Promise<void>
}

async function acquireJobLock(
  path: string,
  opts: { staleMs: number; now: () => Date },
): Promise<JobLock | null> {
  await mkdir(dirname(path), { recursive: true })
  const token = randomUUID()
  const acquire = async (): Promise<JobLock | null> => {
    try {
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      )
      const payload = () =>
        JSON.stringify({
          schemaVersion: 1,
          pid: process.pid,
          token,
          heartbeatAt: opts.now().toISOString(),
        })
      await handle.writeFile(payload(), 'utf8')
      const timer = setInterval(async () => {
        try {
          const next = payload()
          await handle.write(next, 0, 'utf8')
          await handle.truncate(Buffer.byteLength(next))
          await handle.sync()
        } catch {
          // The held descriptor remains authoritative until cleanup.
        }
      }, LOCK_HEARTBEAT_MS)
      timer.unref()
      return {
        release: async () => {
          clearInterval(timer)
          await handle.close().catch(() => {})
          try {
            const current = JSON.parse(await readFile(path, 'utf8')) as {
              token?: unknown
            }
            if (current.token === token) await unlink(path)
          } catch {
            // Never remove a lock whose ownership cannot be proven.
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return null
    }
  }
  const initial = await acquire()
  if (initial) return initial
  if (!(await reclaimAbandonedLock(path, opts))) return null
  return await acquire()
}

async function reclaimAbandonedLock(
  path: string,
  opts: { staleMs: number; now: () => Date },
): Promise<boolean> {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return false
    const info = await stat(path)
    const rawText = await readFile(path, 'utf8')
    let raw: { pid?: unknown; heartbeatAt?: unknown } = {}
    let malformed = false
    try {
      raw = JSON.parse(rawText) as typeof raw
    } catch {
      malformed = true
    }
    const pid =
      typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0
        ? raw.pid
        : null
    const heartbeat =
      typeof raw.heartbeatAt === 'string' ? Date.parse(raw.heartbeatAt) : NaN
    if (pid && processAlive(pid)) return false
    if (
      (malformed || !pid || !Number.isFinite(heartbeat)) &&
      opts.now().getTime() - info.mtimeMs <= opts.staleMs
    )
      return false
    const current = await stat(path)
    if (
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.size !== info.size ||
      current.mtimeMs !== info.mtimeMs ||
      (await readFile(path, 'utf8')) !== rawText
    )
      return false
    await unlink(path)
    return true
  } catch {
    return false
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
