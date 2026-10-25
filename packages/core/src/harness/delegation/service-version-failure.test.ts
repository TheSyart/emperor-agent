/**
 * VER-06: a run that failed for its version carries what the task card,
 * the external agent page and the parent need — the current version, the
 * last good one, the highest verified one, one Chinese line of why, and
 * which buttons apply — all from the health record and the run's own
 * probe, never parsed from an error string. Other failures carry nothing.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { externalTask } from '../../api/services/delegation-service'
import { ExecutorHealthStore } from './executor-health'
import type { SelfCheckResult } from './self-check'
import { fixture, spec } from './service-test-fixture'
import { DelegationError, type ExecutorProbe } from './types'
import { WorkspaceOperationError } from '../../workspace/common'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})

function setup(version: string, probe: Partial<ExecutorProbe> = {}) {
  const f = fixture()
  cleanup.push(() => f.service.shutdown(), f.cleanup)
  vi.mocked(f.registry.requireAvailable).mockImplementation(async (p) => ({
    status: 'available',
    checkedAt: Date.now(),
    authVerified: false,
    capabilities: f.registry.capabilities(p.backend),
    executableVersion: version,
    compatibility: 'verified',
    ...probe,
  }))
  const health = new ExecutorHealthStore(join(f.root, 'health'))
  // The fixture's options object is the service's own.
  f.options.health = health
  return { f, health }
}

const incompatible = (reason: string) =>
  new DelegationError('EXECUTOR_INCOMPATIBLE', 'refused', reason)

async function settle(f: ReturnType<typeof fixture>) {
  const record = await f.service.start(f.owner, spec)
  const run = await f.service.wait(record.id, record.currentRunId!)
  return { record, run, state: f.service.inspect(record.id) }
}

it('1 · 3 · EXECUTOR_INCOMPATIBLE carries the version context; a last good version offers 退回', async () => {
  const { f, health } = setup('0.165.0')
  health.recordSuccess('codex-default', '0.163.0', 'dgr-good')
  vi.spyOn(f.adapter, 'open').mockRejectedValueOnce(
    incompatible('Codex 0.165.0 的握手与 Emperor 验证过的不同。'),
  )
  const { run, state } = await settle(f)
  expect(run).toMatchObject({
    phase: 'failed',
    failureCode: 'EXECUTOR_INCOMPATIBLE',
    versionFailure: {
      backend: 'codex',
      profileId: 'codex-default',
      current: '0.165.0',
      lastGood: '0.163.0',
      verifiedMax: '0.163.0',
      reason: 'Codex 0.165.0 的握手与 Emperor 验证过的不同',
      actions: ['rollback', 'open_settings'],
    },
  })
  // The parent's conversation gets it with the run (delegation/projection).
  expect(externalTask(state, run)).toMatchObject({
    version_failure: run.versionFailure,
  })
})

it('2 · a failure that is not about the version (WORKSPACE_GIT_FAILED) carries none', async () => {
  const { f, health } = setup('0.165.0')
  health.recordSuccess('codex-default', '0.163.0', 'dgr-good')
  f.prepare.mockRejectedValueOnce(
    new WorkspaceOperationError('git_command_failed', 'fatal: index'),
  )
  const { run, state } = await settle(f)
  expect(run.failureCode).toBe('WORKSPACE_GIT_FAILED')
  expect(run.versionFailure).toBeUndefined()
  expect(externalTask(state, run)).not.toHaveProperty('version_failure')
})

it('4 · no last good version, an older one than verified: 装 the verified one', async () => {
  const { f } = setup('0.153.4')
  vi.spyOn(f.adapter, 'open').mockRejectedValueOnce(
    incompatible('Codex 0.153.4 的握手与 Emperor 验证过的不同。'),
  )
  const { run } = await settle(f)
  expect(run.versionFailure).toMatchObject({
    current: '0.153.4',
    verifiedMax: '0.163.0',
    actions: ['install_verified', 'open_settings'],
  })
  expect(run.versionFailure).not.toHaveProperty('lastGood')
})

it('newer than every verified one and nothing good before: only 打开设置 (no downgrade from here)', async () => {
  const { f } = setup('0.163.9')
  vi.spyOn(f.adapter, 'open').mockRejectedValueOnce(incompatible('x。'))
  const { run } = await settle(f)
  expect(run.versionFailure?.actions).toEqual(['open_settings'])
})

it('a self-check that did not finish adds 重新检查; a self-check refusal says so', async () => {
  const errored: SelfCheckResult = {
    backend: 'codex',
    version: '0.165.0',
    checkedAt: 1,
    status: 'error',
    issues: [{ code: 'timeout', detail: 't', blocking: false }],
    modelCalls: 0,
  }
  const { f, health } = setup('0.165.0')
  health.recordSelfCheck('codex-default', '0.165.0', errored)
  vi.spyOn(f.adapter, 'open').mockRejectedValueOnce(incompatible('x。'))
  const { run } = await settle(f)
  expect(run.versionFailure?.actions).toEqual(['open_settings', 'recheck'])

  const refused = setup('0.165.0')
  refused.health.recordSuccess('codex-default', '0.163.0', 'dgr-good')
  refused.f.options.selfCheck = {
    gate: async () => ({
      ...errored,
      status: 'incompatible',
      issues: [
        {
          code: 'protocol_unknown',
          detail: 'Codex 0.165.0 的握手与 Emperor 验证过的不同。',
          blocking: true,
        },
      ],
    }),
  }
  const { run: blocked } = await settle(refused.f)
  expect(blocked).toMatchObject({
    failureCode: 'EXECUTOR_SELF_CHECK_FAILED',
    versionFailure: {
      current: '0.165.0',
      lastGood: '0.163.0',
      reason:
        'Codex 0.165.0 自检不兼容：Codex 0.165.0 的握手与 Emperor 验证过的不同',
      actions: ['rollback', 'open_settings'],
    },
  })
})

it('a turn that failed on an unverified Codex protocol is a version failure too', async () => {
  const { f } = setup('0.163.2', {
    compatibility: 'unverified',
    protocolVersion: '0.163.0',
  })
  vi.spyOn(f.adapter, 'open').mockRejectedValueOnce(
    new DelegationError('EXECUTOR_START_FAILED', 'app-server exited'),
  )
  const { run } = await settle(f)
  expect(run.versionFailure).toMatchObject({
    current: '0.163.2',
    reason:
      'Codex 0.163.2 的协议与 Emperor 验证过的 0.163.0 不同，这次运行失败可能与此有关',
  })
})
