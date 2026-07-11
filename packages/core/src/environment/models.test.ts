import { describe, expect, it } from 'vitest'
import {
  environmentInstallPlanSchema,
  environmentJobRecordSchema,
  environmentReceiptSchema,
  environmentToolStateSchema,
  stableEnvironmentHash,
} from './models'

const step = {
  stepId: 'step_git',
  toolId: 'git',
  strategyId: 'homebrew',
  dependsOn: [],
  status: 'planned',
  requiresElevation: false,
  requiresSeparateConfirmation: false,
}

describe('Environment domain schemas', () => {
  it('strictly validates tool state and install plans', () => {
    expect(
      environmentToolStateSchema.parse({
        id: 'git',
        category: 'base',
        required: true,
        reason: '基础文件能力',
        declarationSource: null,
        status: 'ready',
        detectedVersion: '2.50.1',
        versionSummary: 'git version 2.50.1',
        requiredVersion: '>=2.40.0',
        executablePath: '/usr/bin/git',
        installStrategy: null,
        sourceUrl: null,
        requiresElevation: false,
        requiresSeparateConfirmation: false,
      }),
    ).toMatchObject({ id: 'git', status: 'ready' })
    expect(() =>
      environmentToolStateSchema.parse({
        id: 'unknown',
        status: 'ready',
      }),
    ).toThrow()

    expect(
      environmentInstallPlanSchema.parse({
        planId: 'plan_01',
        catalogRevision: 'a'.repeat(64),
        projectFingerprint: 'b'.repeat(64),
        toolStateHash: 'c'.repeat(64),
        expiresAt: '2026-07-11T01:00:00.000Z',
        steps: [step],
        requiredLicenseIds: ['git-license'],
        warnings: [],
      }),
    ).toMatchObject({ planId: 'plan_01' })
  })

  it('validates persisted jobs without accepting unknown fields', () => {
    const job = {
      schemaVersion: 1,
      jobId: 'job_01',
      planId: 'plan_01',
      catalogRevision: 'a'.repeat(64),
      projectFingerprint: 'b'.repeat(64),
      status: 'planned',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
      currentStepId: null,
      steps: [step],
      error: null,
    }
    expect(environmentJobRecordSchema.parse(job)).toEqual(job)
    expect(() =>
      environmentJobRecordSchema.parse({ ...job, command: 'rm -rf /' }),
    ).toThrow()
    expect(() =>
      environmentJobRecordSchema.parse({
        ...job,
        error: {
          code: 'made_up',
          message: 'secret-token',
          action: 'execute_anything',
        },
      }),
    ).toThrow()
    expect(() =>
      environmentJobRecordSchema.parse({
        ...job,
        createdAt: '2026-02-30T00:00:00.000Z',
      }),
    ).toThrow()
    expect(() =>
      environmentJobRecordSchema.parse({
        ...job,
        createdAt: '2026-07-11T00:01:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      }),
    ).toThrow()
  })

  it('rejects receipts whose completion precedes their start', () => {
    const receipt = {
      schemaVersion: 1,
      jobId: 'job_01',
      planId: 'plan_01',
      catalogRevision: 'a'.repeat(64),
      appVersion: '0.1.0',
      runtimeRevision: 'b'.repeat(64),
      platform: 'darwin',
      arch: 'arm64',
      startedAt: '2026-07-11T00:01:00.000Z',
      finishedAt: '2026-07-11T00:00:00.000Z',
      status: 'completed',
      steps: [],
    }
    expect(() => environmentReceiptSchema.parse(receipt)).toThrow(/finishedAt/i)
    expect(() =>
      environmentReceiptSchema.parse({
        ...receipt,
        startedAt: '2026-07-11T00:00:00.000Z',
        steps: [
          {
            stepId: 'step_git',
            toolId: 'git',
            outcome: 'failed',
            detectedVersion: null,
            errorCode: 'made_up',
          },
        ],
      }),
    ).toThrow()
  })

  it('produces stable hashes independent of object key insertion order', () => {
    expect(stableEnvironmentHash({ a: 1, b: { y: 2, x: 3 } })).toBe(
      stableEnvironmentHash({ b: { x: 3, y: 2 }, a: 1 }),
    )
    expect(stableEnvironmentHash({ a: 1 })).toMatch(/^[a-f0-9]{64}$/)
  })
})
