/** Runtime event builders for host-side (non-session-log) events. */
import { describe, expect, it } from 'vitest'
import * as runtimeEvents from './events'

describe('runtime events (test_runtime_events.py)', () => {
  it('builds scheduler run event payloads with run/task correlation', () => {
    const job = { id: 'job-1', name: 'demo' }
    expect(runtimeEvents.schedulerRunStart(job).event).toBe(
      'scheduler_run_start',
    )
    expect(runtimeEvents.schedulerRunDone(job).event).toBe('scheduler_run_done')
    expect(runtimeEvents.schedulerRunCancelled(job).event).toBe(
      'scheduler_run_cancelled',
    )
    expect(
      runtimeEvents.schedulerRunSkipped(job, {
        run: { runId: 'run-1', taskId: 'task-1' },
        reason: 'capacity',
      }),
    ).toMatchObject({
      event: 'scheduler_run_skipped',
      run_id: 'run-1',
      task_id: 'task-1',
      reason: 'capacity',
    })
    expect(
      runtimeEvents.schedulerRunInterrupted(job, {
        run: { runId: 'run-2', taskId: 'task-2' },
        reason: 'shutdown',
      }),
    ).toMatchObject({
      event: 'scheduler_run_interrupted',
      run_id: 'run-2',
      task_id: 'task-2',
    })
    expect(runtimeEvents.schedulerRunError(job, { error: 'boom' }).error).toBe(
      'boom',
    )
  })

  it('bounds Environment events to identifiers, counts, and digests', () => {
    const event = runtimeEvents.environmentInstallProgress({
      jobId: 'job_1?token=secret',
      toolId: 'git; curl evil',
      stepId: 'step_1',
      status: 'running',
      completedSteps: -3,
      totalSteps: 99_999,
      errorCode: 'download_failed',
      installSource: 'skill',
      placement: 'managed',
      recipeTrust: 'installed_skill_source',
    })

    expect(event).toEqual({
      event: 'environment_install_progress',
      job_id: 'job_1tokensecret',
      tool_id: 'gitcurlevil',
      step_id: 'step_1',
      status: 'running',
      completed_steps: 0,
      total_steps: 10_000,
      error_code: 'download_failed',
      install_source: 'skill',
      placement: 'managed',
      recipe_trust: 'installed_skill_source',
    })
    expect(JSON.stringify(event)).not.toContain('token=secret')
  })

  it('drops the catalog digest when it is not a sha256 hex string', () => {
    expect(
      runtimeEvents.environmentChanged({
        jobId: 'job_1',
        status: 'ready',
        catalogRevision: 'a'.repeat(64),
        projectFingerprint: 'not-a-digest',
      }),
    ).toEqual({
      event: 'environment_changed',
      job_id: 'job_1',
      status: 'ready',
      catalog_revision: 'a'.repeat(64),
      project_fingerprint: '',
    })
  })
})
