/**
 * VER-04: a version the self-check found incompatible is refused when a
 * task is dispatched, before any workspace is prepared; without a result
 * the task waits for a check (up to its limit), and a check that errs or
 * runs late never blocks. The service fixture's fake executor; the
 * self-check is a stand-in.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXECUTOR_HEALTH_FILE, ExecutorHealthStore } from './executor-health'
import type { SelfCheckResult } from './self-check'
import { fixture, spec } from './service-test-fixture'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})

const incompatible: SelfCheckResult = {
  backend: 'codex',
  version: '0.165.0',
  checkedAt: 1,
  status: 'incompatible',
  issues: [
    {
      code: 'protocol_unknown',
      detail:
        'Codex 0.165.0 的协议与 Emperor 验证过的 0.163.0 不同，可能不兼容。',
      blocking: true,
    },
  ],
  modelCalls: 0,
}

function setup(
  gate: (version: string | undefined) => Promise<SelfCheckResult | null>,
) {
  const f = fixture()
  cleanup.push(() => f.service.shutdown(), f.cleanup)
  vi.mocked(f.registry.requireAvailable).mockImplementation(async (p) => ({
    status: 'available',
    checkedAt: Date.now(),
    authVerified: false,
    capabilities: f.registry.capabilities(p.backend),
    executableVersion: '0.165.0',
    compatibility: 'verified',
  }))
  const calls: Array<string | undefined> = []
  // The fixture's options object is the service's own.
  f.options.selfCheck = {
    gate: async (_profile, version) => {
      calls.push(version)
      return gate(version)
    },
  }
  f.options.health = new ExecutorHealthStore(f.root)
  return { f, calls }
}

async function settle(f: ReturnType<typeof fixture>) {
  const record = await f.service.start(f.owner, spec)
  return f.service.wait(record.id, record.currentRunId!)
}

it('10 · an incompatible version fails at once with EXECUTOR_SELF_CHECK_FAILED; no workspace is prepared', async () => {
  const { f, calls } = setup(async () => incompatible)
  const run = await settle(f)
  expect(calls).toEqual(['0.165.0'])
  expect(run).toMatchObject({
    phase: 'failed',
    failureCode: 'EXECUTOR_SELF_CHECK_FAILED',
  })
  expect(run.summary).toBe(
    'Codex 0.165.0 自检不兼容：Codex 0.165.0 的协议与 Emperor 验证过的 0.163.0 不同，可能不兼容。可以在 设置 › 子智能体 退回上一个正常版本，或点「重新检查」。',
  )
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.adapter.opened).toHaveLength(0)
  // It counts against the version (VER-03), so 退回 can be offered.
  const health = JSON.parse(
    readFileSync(join(f.root, EXECUTOR_HEALTH_FILE), 'utf8'),
  )
  expect(health.profiles['codex-default'].versions['0.165.0']).toMatchObject({
    versionFailures: 1,
    lastFailure: { code: 'EXECUTOR_SELF_CHECK_FAILED' },
  })
})

it('11 · a check that ran late (null) or erred lets the task go on into its workspace', async () => {
  for (const answer of [
    null,
    { ...incompatible, status: 'error' as const, issues: [] },
    { ...incompatible, status: 'adapted' as const, issues: [] },
  ]) {
    const { f } = setup(async () => answer)
    const run = await settle(f)
    expect(run.phase).toBe('completed')
    expect(f.prepare).toHaveBeenCalledTimes(1)
  }
})

it('a self-check that throws never fails the task', async () => {
  const { f } = setup(async () => {
    throw new Error('boom')
  })
  expect((await settle(f)).phase).toBe('completed')
  expect(existsSync(join(f.root, EXECUTOR_HEALTH_FILE))).toBe(true)
})
