import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBundledToolCatalog } from './catalog'
import { EnvironmentError } from './errors'
import {
  EnvironmentInstallOrchestrator,
  type EnvironmentStepExecutionContext,
  type EnvironmentStepExecutionResult,
  type EnvironmentStepExecutor,
} from './jobs'
import type { EnvironmentToolId } from './models'
import type { EnvironmentProbeStatus } from './probe'
import { EnvironmentStore } from './store'

const CATALOG = loadBundledToolCatalog()
const RUNTIME_REVISION = 'f'.repeat(64)

function root(): string {
  return mkdtempSync(join(tmpdir(), 'emperor-environment-jobs-'))
}

function probeStatus(
  opts: {
    projectFingerprint?: string
    catalogRevision?: string
    ready?: Partial<Record<EnvironmentToolId, string>>
  } = {},
): EnvironmentProbeStatus {
  const projectFingerprint = opts.projectFingerprint ?? 'a'.repeat(64)
  const ready = opts.ready ?? {}
  return {
    cacheKey: 'b'.repeat(64),
    catalogRevision: opts.catalogRevision ?? CATALOG.revision,
    projectFingerprint,
    project: {
      projectRoot: '/workspace',
      fingerprint: projectFingerprint,
      declarations: Object.fromEntries(
        ['node', 'python', 'go', 'rust'].map((ecosystem) => [
          ecosystem,
          {
            ecosystem,
            detected: false,
            status: 'absent',
            source: null,
            rawRequirement: null,
            normalizedRequirement: null,
            reason: null,
          },
        ]),
      ) as EnvironmentProbeStatus['project']['declarations'],
      files: [],
      diagnostics: [],
    },
    platform: 'darwin',
    arch: 'arm64',
    pathEntries: ['/usr/bin'],
    tools: CATALOG.catalog.tools.map((tool) => {
      const version = ready[tool.id]
      const strategy = tool.strategies.find((entry) =>
        entry.targets.some(
          (target) => target.platform === 'darwin' && target.arch === 'arm64',
        ),
      )
      return {
        id: tool.id,
        category: tool.category,
        required: true,
        reason: 'test requirement',
        declarationSource: null,
        status: version ? 'ready' : 'missing',
        detectedVersion: version ?? null,
        versionSummary: version ? `${tool.id} ${version}` : null,
        requiredVersion: tool.version.requirement,
        executablePath: version ? `/tools/${tool.id}` : null,
        installStrategy: strategy?.id ?? null,
        sourceUrl: strategy?.source.url ?? null,
        requiresElevation: strategy?.requiresElevation ?? false,
        requiresSeparateConfirmation:
          strategy?.requiresSeparateConfirmation ?? false,
      }
    }),
    skills: [],
    diagnostics: [],
  }
}

class FakeExecutor implements EnvironmentStepExecutor {
  readonly calls: EnvironmentStepExecutionContext[] = []
  readonly outcomes = new Map<
    EnvironmentToolId,
    EnvironmentStepExecutionResult
  >()

  async execute(
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    this.calls.push(context)
    return (
      this.outcomes.get(context.step.toolId) ?? {
        status: 'completed',
        detectedVersion: CATALOG.catalog.tools.find(
          (tool) => tool.id === context.step.toolId,
        )!.version.pinned,
      }
    )
  }
}

function orchestrator(
  opts: {
    stateRoot?: string
    executor?: EnvironmentStepExecutor
    status?: (opts: {
      forceRefresh: boolean
      projectRoot: string | null
    }) => Promise<EnvironmentProbeStatus>
    now?: () => Date
    idFactory?: (kind: 'plan' | 'job') => string
    lockStaleMs?: number
    onJobUpdate?: (
      job: import('./models').EnvironmentJobRecord,
    ) => void | Promise<void>
  } = {},
): EnvironmentInstallOrchestrator {
  return new EnvironmentInstallOrchestrator({
    stateRoot: opts.stateRoot ?? root(),
    catalog: CATALOG,
    getStatus: opts.status ?? (async () => probeStatus()),
    executor: opts.executor ?? new FakeExecutor(),
    appVersion: '0.1.0',
    runtimeRevision: RUNTIME_REVISION,
    now: opts.now,
    idFactory: opts.idFactory,
    lockStaleMs: opts.lockStaleMs,
    onJobUpdate: opts.onJobUpdate,
  })
}

function accepted(plan: {
  requiredLicenseIds: string[]
  steps: Array<{ stepId: string }>
}) {
  return {
    acceptedLicenseIds: [...plan.requiredLicenseIds],
    confirmedStepIds: plan.steps.map((step) => step.stepId),
  }
}

describe('EnvironmentInstallOrchestrator plans', () => {
  it('builds a stable dependency-first ten-minute plan without executable inputs', async () => {
    const now = new Date('2026-07-11T00:00:00.000Z')
    const service = orchestrator({
      now: () => now,
      idFactory: (kind) => `${kind}_stable`,
    })

    const first = await service.createPlan({ toolIds: ['npm', 'git'] })
    const second = await service.createPlan({ toolIds: ['git', 'npm'] })

    expect(first.steps.map((step) => step.toolId)).toEqual([
      'git',
      'volta',
      'node',
      'npm',
    ])
    expect(second).toEqual(first)
    expect(first.expiresAt).toBe('2026-07-11T00:10:00.000Z')
    expect(first.requiredLicenseIds).toEqual([
      'git-gpl-2',
      'bsd-2-clause',
      'mit',
      'npm-artistic-2',
    ])
    expect(JSON.stringify(first)).not.toMatch(
      /"(?:command|args|url|targetPath)"/,
    )
  })

  it('rejects expired, catalog, project, and tool-state binding changes', async () => {
    let now = new Date('2026-07-11T00:00:00.000Z')
    let current = probeStatus()
    const service = orchestrator({
      now: () => now,
      status: async () => current,
    })

    const expired = await service.createPlan({ toolIds: ['git'] })
    now = new Date('2026-07-11T00:10:00.000Z')
    await expect(
      service.install({ planId: expired.planId, ...accepted(expired) }),
    ).rejects.toMatchObject({ environmentCode: 'plan_stale' })

    now = new Date('2026-07-11T00:00:00.000Z')
    const catalog = await service.createPlan({ toolIds: ['git'] })
    current = probeStatus({ catalogRevision: 'c'.repeat(64) })
    await expect(
      service.install({ planId: catalog.planId, ...accepted(catalog) }),
    ).rejects.toMatchObject({ environmentCode: 'plan_stale' })

    current = probeStatus()
    const project = await service.createPlan({ toolIds: ['git'] })
    current = probeStatus({ projectFingerprint: 'd'.repeat(64) })
    await expect(
      service.install({ planId: project.planId, ...accepted(project) }),
    ).rejects.toMatchObject({ environmentCode: 'plan_stale' })

    current = probeStatus()
    const tools = await service.createPlan({ toolIds: ['git'] })
    current = probeStatus({ ready: { ripgrep: '15.1.0' } })
    await expect(
      service.install({ planId: tools.planId, ...accepted(tools) }),
    ).rejects.toMatchObject({ environmentCode: 'plan_stale' })
  })

  it('accepts only plan ids, confirmations, and exact required licenses', async () => {
    const service = orchestrator()
    const plan = await service.createPlan({ toolIds: ['git'] })

    await expect(
      service.install({
        planId: plan.planId,
        acceptedLicenseIds: [],
        confirmedStepIds: plan.steps.map((step) => step.stepId),
      }),
    ).rejects.toMatchObject({ environmentCode: 'license_not_accepted' })
    await expect(
      service.install({
        planId: plan.planId,
        ...accepted(plan),
        command: 'rm -rf /',
      } as never),
    ).rejects.toThrow()
  })

  it('requires MSVC Build Tools to use an independent plan', async () => {
    let current = probeStatus()
    current = {
      ...current,
      platform: 'win32',
      arch: 'x64',
      tools: current.tools.map((tool) => {
        const catalogTool = CATALOG.catalog.tools.find(
          (entry) => entry.id === tool.id,
        )!
        const strategy = catalogTool.strategies.find((entry) =>
          entry.targets.some((target) => target.platform === 'win32'),
        )
        return {
          ...tool,
          installStrategy: strategy?.id ?? null,
          requiresElevation: strategy?.requiresElevation ?? false,
          requiresSeparateConfirmation:
            strategy?.requiresSeparateConfirmation ?? false,
        }
      }),
    }
    const service = orchestrator({ status: async () => current })

    await expect(
      service.createPlan({ toolIds: ['git', 'msvc-build-tools'] }),
    ).rejects.toMatchObject({ environmentCode: 'confirmation_required' })
    await expect(
      service.createPlan({ toolIds: ['msvc-build-tools'] }),
    ).resolves.toMatchObject({
      steps: [
        expect.objectContaining({
          toolId: 'msvc-build-tools',
          requiresSeparateConfirmation: true,
        }),
      ],
    })
  })
})

describe('EnvironmentInstallOrchestrator jobs', () => {
  it('publishes job changes without letting observer failures break installation', async () => {
    const updates: string[] = []
    const service = orchestrator({
      status: async () => probeStatus({ ready: { git: '2.55.0' } }),
      onJobUpdate: async (job) => {
        updates.push(`${job.status}:${job.currentStepId ?? ''}`)
        if (updates.length === 1) throw new Error('observer unavailable')
      },
    })
    const plan = await service.createPlan({ toolIds: ['git'] })

    const job = await service.install({
      planId: plan.planId,
      ...accepted(plan),
    })

    expect(job.status).toBe('completed')
    expect(updates[0]).toBe('running:')
    expect(updates.at(-1)).toBe('completed:')
  })

  it('continues unrelated steps and blocks only failed dependency branches', async () => {
    let current = probeStatus()
    let statusCalls = 0
    const refreshRequests: Array<{
      forceRefresh: boolean
      projectRoot: string | null
    }> = []
    const executor = new FakeExecutor()
    executor.outcomes.set('volta', {
      status: 'failed',
      error: new EnvironmentError('installer_failed'),
    })
    const service = orchestrator({
      executor,
      status: async (request) => {
        statusCalls += 1
        refreshRequests.push(request)
        if (statusCalls >= 3)
          current = probeStatus({ ready: { git: '2.55.0' } })
        return current
      },
    })
    const plan = await service.createPlan({ toolIds: ['npm', 'git'] })

    const job = await service.install({
      planId: plan.planId,
      ...accepted(plan),
    })

    expect(job.status).toBe('partial')
    expect(executor.calls.map((call) => call.step.toolId)).toEqual([
      'git',
      'volta',
    ])
    expect(job.steps.map((step) => [step.toolId, step.status])).toEqual([
      ['git', 'completed'],
      ['volta', 'failed'],
      ['node', 'blocked'],
      ['npm', 'blocked'],
    ])
    const receipt = await new EnvironmentStore(service.stateRoot).getReceipt(
      job.jobId,
    )
    expect(receipt?.status).toBe('partial')
    expect(receipt?.steps[0]).toMatchObject({
      toolId: 'git',
      outcome: 'completed',
      detectedVersion: '2.55.0',
    })
    expect(refreshRequests).toEqual([
      { forceRefresh: false, projectRoot: null },
      { forceRefresh: true, projectRoot: '/workspace' },
      { forceRefresh: true, projectRoot: '/workspace' },
    ])
  })

  it('requires explicit confirmation for separately confirmed steps', async () => {
    let current = probeStatus()
    current = {
      ...current,
      platform: 'win32',
      arch: 'x64',
      tools: current.tools.map((tool) =>
        tool.id === 'msvc-build-tools'
          ? {
              ...tool,
              installStrategy: 'winget',
              requiresSeparateConfirmation: true,
            }
          : tool,
      ),
    }
    const service = orchestrator({ status: async () => current })
    const plan = await service.createPlan({ toolIds: ['msvc-build-tools'] })

    await expect(
      service.install({
        planId: plan.planId,
        acceptedLicenseIds: plan.requiredLicenseIds,
        confirmedStepIds: [],
      }),
    ).rejects.toMatchObject({ environmentCode: 'confirmation_required' })
  })

  it('cancels an active step through its AbortSignal and persists cancellation', async () => {
    let started!: () => void
    const didStart = new Promise<void>((resolve) => {
      started = resolve
    })
    const executor: EnvironmentStepExecutor = {
      execute: async ({ signal }) => {
        started()
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        return { status: 'cancelled' }
      },
    }
    const service = orchestrator({ executor })
    const plan = await service.createPlan({ toolIds: ['git'] })
    const installing = service.install({
      planId: plan.planId,
      ...accepted(plan),
    })
    await didStart

    const cancelling = await service.cancelActiveInstall()
    const final = await installing

    expect(cancelling?.status).toBe('cancelling')
    expect(final.status).toBe('cancelled')
    expect(final.steps[0]?.status).toBe('cancelled')
  })

  it('persists awaiting_user without auto-resuming the plan', async () => {
    const executor = new FakeExecutor()
    executor.outcomes.set('go', { status: 'awaiting_user' })
    const service = orchestrator({ executor })
    const plan = await service.createPlan({ toolIds: ['go'] })

    const job = await service.install({
      planId: plan.planId,
      ...accepted(plan),
    })

    expect(job.status).toBe('awaiting_user')
    expect(job.steps[0]?.status).toBe('awaiting_user')
    await expect(
      new EnvironmentStore(service.stateRoot).getReceipt(job.jobId),
    ).resolves.toBeNull()
  })

  it('converges to a failed job and receipt when the post-install probe throws', async () => {
    let calls = 0
    const service = orchestrator({
      status: async () => {
        calls += 1
        if (calls >= 3) throw new Error('probe unavailable')
        return probeStatus()
      },
    })
    const plan = await service.createPlan({ toolIds: ['git'] })

    const job = await service.install({
      planId: plan.planId,
      ...accepted(plan),
    })

    expect(job).toMatchObject({
      status: 'failed',
      error: { code: 'post_install_probe_failed' },
      steps: [{ status: 'failed' }],
    })
    await expect(service.store.getJob(job.jobId)).resolves.toMatchObject({
      status: 'failed',
    })
    await expect(service.store.getReceipt(job.jobId)).resolves.toMatchObject({
      status: 'failed',
      steps: [{ outcome: 'failed', errorCode: 'post_install_probe_failed' }],
    })
  })

  it('enforces one cross-instance job for the shared state root', async () => {
    const stateRoot = root()
    let release!: () => void
    let started!: () => void
    const didStart = new Promise<void>((resolve) => {
      started = resolve
    })
    const latch = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = orchestrator({
      stateRoot,
      idFactory: (kind) => `${kind}_first`,
      executor: {
        execute: async () => {
          started()
          await latch
          return { status: 'completed' }
        },
      },
    })
    const second = orchestrator({
      stateRoot,
      idFactory: (kind) => `${kind}_second`,
    })
    const firstPlan = await first.createPlan({ toolIds: ['git'] })
    const secondPlan = await second.createPlan({ toolIds: ['git'] })
    const running = first.install({
      planId: firstPlan.planId,
      ...accepted(firstPlan),
    })
    await didStart

    await expect(second.recoverInterruptedJobs()).rejects.toMatchObject({
      environmentCode: 'job_active',
    })
    await expect(
      second.install({
        planId: secondPlan.planId,
        ...accepted(secondPlan),
      }),
    ).rejects.toMatchObject({ environmentCode: 'job_active' })
    release()
    await running
  })

  it('rejects a symlinked environment root before touching its lock path', async () => {
    const stateRoot = root()
    const outside = root()
    symlinkSync(outside, join(stateRoot, 'environment'))
    mkdirSync(join(outside, 'environment.lock'))
    const service = orchestrator({ stateRoot })
    const plan = await service.createPlan({ toolIds: ['git'] })

    await expect(
      service.install({ planId: plan.planId, ...accepted(plan) }),
    ).rejects.toThrow(/unsafe|symbolic/i)
  })

  it('reclaims a malformed stale lock left by an interrupted process', async () => {
    const service = orchestrator({ lockStaleMs: 0 })
    service.store.initialize()
    writeFileSync(service.store.paths.lock, '{broken', 'utf8')
    utimesSync(service.store.paths.lock, new Date(0), new Date(0))
    const plan = await service.createPlan({ toolIds: ['git'] })

    await expect(
      service.install({ planId: plan.planId, ...accepted(plan) }),
    ).resolves.toMatchObject({ planId: plan.planId })
  })

  it('marks unfinished jobs interrupted and writes a receipt from a fresh probe', async () => {
    const stateRoot = root()
    const store = new EnvironmentStore(stateRoot)
    await store.saveJob({
      schemaVersion: 1,
      jobId: 'job_interrupted',
      planId: 'plan_interrupted',
      catalogRevision: CATALOG.revision,
      projectFingerprint: 'a'.repeat(64),
      projectRoot: '/workspace',
      status: 'running',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:01.000Z',
      currentStepId: 'step_git',
      steps: [
        {
          stepId: 'step_git',
          toolId: 'git',
          strategyId: 'homebrew',
          dependsOn: [],
          status: 'running',
          requiresElevation: false,
          requiresSeparateConfirmation: false,
        },
      ],
      error: null,
    })
    const service = orchestrator({
      stateRoot,
      now: () => new Date('2026-07-11T00:05:00.000Z'),
      status: async () => probeStatus({ ready: { git: '2.55.0' } }),
    })

    const recovered = await service.recoverInterruptedJobs()

    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.status).toBe('interrupted')
    expect(recovered[0]?.steps[0]?.status).toBe('cancelled')
    const receipt = await store.getReceipt('job_interrupted')
    expect(receipt).toMatchObject({
      status: 'interrupted',
      steps: [
        {
          toolId: 'git',
          detectedVersion: '2.55.0',
          errorCode: 'interrupted',
        },
      ],
    })
  })
})
