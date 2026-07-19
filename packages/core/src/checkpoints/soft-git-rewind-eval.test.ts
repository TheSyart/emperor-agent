import { describe, expect, it } from 'vitest'
import {
  SOFT_GIT_REWIND_EVALUATION_CASES,
  SOFT_GIT_REWIND_EVALUATION_DATASET_SHA256,
  decideSoftGitRewindEvaluationGate,
  softGitRewindGateReceipt,
  type SoftGitRewindEvaluationReport,
} from './soft-git-rewind-eval'

describe('soft Git rewind safety evaluation gate', () => {
  it('passes only the complete deterministic safety matrix and emits a runtime-bound receipt', () => {
    const report = passingReport()
    expect(decideSoftGitRewindEvaluationGate(report)).toEqual({
      passed: true,
      reasons: [],
    })
    expect(softGitRewindGateReceipt(report)).toEqual({
      passed: true,
      datasetSha256: SOFT_GIT_REWIND_EVALUATION_DATASET_SHA256,
      platform: process.platform,
      gitVersion: '2.55.0',
      stashVerified: true,
      rollbackVerified: true,
      conflictVetoVerified: true,
      forbiddenCommandScanVerified: true,
    })
  })

  it('rejects missing/failed cases, runtime metadata drift, or any forbidden command observation', () => {
    const missing = passingReport()
    missing.cases.pop()
    expect(decideSoftGitRewindEvaluationGate(missing)).toMatchObject({
      passed: false,
      reasons: expect.arrayContaining(['required_case_missing']),
    })

    const failed = passingReport()
    failed.cases[0]!.passed = false
    expect(decideSoftGitRewindEvaluationGate(failed)).toMatchObject({
      passed: false,
      reasons: expect.arrayContaining(['safety_case_failed']),
    })

    const forbidden = passingReport()
    forbidden.forbiddenCommandsObserved = ['reset --hard']
    expect(decideSoftGitRewindEvaluationGate(forbidden)).toMatchObject({
      passed: false,
      reasons: expect.arrayContaining(['forbidden_command_observed']),
    })

    const drift = passingReport()
    drift.datasetSha256 = 'b'.repeat(64)
    drift.gitVersion = 'not-a-version'
    expect(decideSoftGitRewindEvaluationGate(drift)).toMatchObject({
      passed: false,
      reasons: expect.arrayContaining([
        'dataset_mismatch',
        'runtime_identity_invalid',
      ]),
    })
    expect(softGitRewindGateReceipt(drift)).toBeNull()
  })
})

function passingReport(): SoftGitRewindEvaluationReport {
  return {
    schemaVersion: 1,
    datasetId: 'soft-git-rewind-safety-v1',
    datasetSha256: SOFT_GIT_REWIND_EVALUATION_DATASET_SHA256,
    platform: process.platform,
    gitVersion: '2.55.0',
    cases: SOFT_GIT_REWIND_EVALUATION_CASES.map((id) => ({
      id,
      passed: true,
      durationMs: 10,
    })),
    forbiddenCommandsObserved: [],
  }
}
