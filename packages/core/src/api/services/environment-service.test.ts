import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBundledToolCatalog } from '../../environment/catalog'
import type {
  EnvironmentStepExecutionContext,
  EnvironmentStepExecutor,
} from '../../environment/jobs'
import type { EnvironmentProbeStatus } from '../../environment/probe'
import { SkillManager } from '../../skills/manager'
import { CoreEnvironmentService } from './environment-service'

const catalog = loadBundledToolCatalog()

describe('CoreEnvironmentService', () => {
  it('returns a bounded status payload and paginates redacted install logs', async () => {
    const fixture = createFixture()

    const payload = await fixture.service.getStatus({ forceRefresh: true })
    const plan = await fixture.service.createInstallPlan({ toolIds: ['git'] })
    const job = await fixture.service.install({
      planId: plan.planId,
      acceptedLicenseIds: plan.requiredLicenseIds,
      confirmedStepIds: plan.steps.map((step) => step.stepId),
    })
    const first = await fixture.service.getInstallLog({
      jobId: job.jobId,
      cursor: 0,
      limit: 1,
    })

    expect(payload).toMatchObject({
      status: {
        catalogRevision: catalog.revision,
        project: { projectRoot: fixture.projectRoot },
      },
      catalog: { revision: catalog.revision },
    })
    expect(payload.recentJobs).toEqual([])
    expect(first.records).toHaveLength(1)
    expect(first.nextCursor).toBe(1)
    expect(JSON.stringify(first)).not.toContain('token=secret')
  })

  it('emits only bounded lifecycle fields and reconciles blocked Skills after a successful change', async () => {
    const reconciled: string[] = []
    const fixture = createFixture({
      reconcileBlockedSkills: async () => {
        reconciled.push('done')
        return []
      },
    })
    const plan = await fixture.service.createInstallPlan({ toolIds: ['git'] })

    await fixture.service.install({
      planId: plan.planId,
      acceptedLicenseIds: plan.requiredLicenseIds,
      confirmedStepIds: plan.steps.map((step) => step.stepId),
    })

    expect(fixture.events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        'environment_install_started',
        'environment_install_progress',
        'environment_install_completed',
        'environment_changed',
      ]),
    )
    expect(reconciled).toEqual(['done'])
    expect(JSON.stringify(fixture.events)).not.toMatch(
      /token=secret|sourceUrl/i,
    )
    for (const event of fixture.events)
      expect(Object.keys(event)).toEqual(
        expect.not.arrayContaining(['command', 'args', 'url', 'env']),
      )
  })

  it('requires a matching job id for cancellation', async () => {
    const fixture = createFixture()

    await expect(
      fixture.service.cancelInstall({ jobId: 'job_missing' }),
    ).resolves.toEqual({ cancelled: false, job: null })
  })
})

function createFixture(
  opts: { reconcileBlockedSkills?: () => Promise<unknown> } = {},
) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-env-api-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'emperor-env-project-'))
  const events: Array<Record<string, unknown>> = []
  let ready = false
  const getStatus = async (): Promise<EnvironmentProbeStatus> => {
    const status = probeStatus(projectRoot, ready)
    return structuredClone(status)
  }
  const executor: EnvironmentStepExecutor = {
    execute: async (context: EnvironmentStepExecutionContext) => {
      await context.log({
        level: 'info',
        kind: 'download',
        message: 'https://example.com/tool?token=secret',
      })
      ready = true
      return { status: 'completed' }
    },
  }
  const service = new CoreEnvironmentService({
    stateRoot,
    catalog,
    probe: { getStatus: async () => await getStatus() },
    skillManager: new SkillManager({ stateRoot, runtimeRoot: stateRoot }),
    projectRoot: () => projectRoot,
    executor,
    appVersion: '0.1.0',
    runtimeRevision: 'f'.repeat(64),
    emitRuntime: async (event) => {
      events.push(event)
    },
    ...(opts.reconcileBlockedSkills
      ? { reconcileBlockedSkills: opts.reconcileBlockedSkills }
      : {}),
  })
  return { service, projectRoot, events }
}

function probeStatus(
  projectRoot: string,
  ready: boolean,
): EnvironmentProbeStatus {
  const projectFingerprint = 'a'.repeat(64)
  return {
    cacheKey: 'b'.repeat(64),
    catalogRevision: catalog.revision,
    projectFingerprint,
    project: {
      projectRoot,
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
    tools: catalog.catalog.tools.map((tool) => {
      const strategy = tool.strategies.find((item) =>
        item.targets.some(
          (target) => target.platform === 'darwin' && target.arch === 'arm64',
        ),
      )
      const isGit = tool.id === 'git'
      return {
        id: tool.id,
        category: tool.category,
        required: isGit,
        reason: isGit ? 'base requirement' : 'not required',
        declarationSource: null,
        status: isGit ? (ready ? 'ready' : 'missing') : 'ready',
        detectedVersion: ready || !isGit ? tool.version.pinned : null,
        versionSummary: ready || !isGit ? `${tool.id} ready` : null,
        requiredVersion: tool.version.requirement,
        executablePath: ready || !isGit ? `/tools/${tool.id}` : null,
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
