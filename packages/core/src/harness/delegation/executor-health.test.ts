/**
 * VER-03: what each Claude Code / Codex version did — the last version a
 * task ran on, version failures per version, rollbacks — in
 * `<delegations>/executor-health.json`, written by DelegationService as
 * runs settle, and the 退回 offer built from it. Temp folders only; the
 * runs are the service fixture's fake executor.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EXECUTOR_HEALTH_FILE,
  ExecutorHealthStore,
  VERSION_FAILURE_CODES,
  isVersionFailure,
  type ExecutorHealthFile,
} from './executor-health'
import { fixture, spec } from './service-test-fixture'
import { delegationTestDirectory } from './testing'
import {
  DelegationError,
  type ExecutorProbe,
  type NormalizedExecutorEvent,
} from './types'
import { WorkspaceOperationError } from '../../workspace/common'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})

function directory() {
  const d = delegationTestDirectory()
  cleanup.push(d.cleanup)
  return d.root
}

const read = (root: string): ExecutorHealthFile =>
  JSON.parse(readFileSync(join(root, EXECUTOR_HEALTH_FILE), 'utf8'))

describe('isVersionFailure', () => {
  it('2 · counts the version codes, and a start or turn failure only on an unverified Codex protocol', () => {
    expect([...VERSION_FAILURE_CODES].sort()).toEqual([
      'EXECUTOR_INCOMPATIBLE',
      'EXECUTOR_SELF_CHECK_FAILED',
    ])
    expect(isVersionFailure('EXECUTOR_INCOMPATIBLE')).toBe(true)
    expect(isVersionFailure('EXECUTOR_SELF_CHECK_FAILED')).toBe(true)
    for (const code of ['EXECUTOR_START_FAILED', 'EXECUTOR_TURN_FAILED']) {
      expect(isVersionFailure(code)).toBe(false)
      expect(isVersionFailure(code, { compatibility: 'verified' })).toBe(false)
      expect(isVersionFailure(code, { compatibility: 'unverified' })).toBe(true)
    }
    for (const code of [
      'WORKSPACE_GIT_FAILED',
      'AUTH_REQUIRED',
      'BUDGET_LIMIT',
      'ABORTED',
      'RUN_TIMEOUT',
      'OUTCOME_UNKNOWN',
    ])
      expect(
        isVersionFailure(code, { compatibility: 'unverified' }),
        code,
      ).toBe(false)
  })
})

describe('ExecutorHealthStore', () => {
  it('1 · a good run makes its version the last good one; a failure never does', () => {
    const root = directory()
    let now = 1_000
    const store = new ExecutorHealthStore(root, { now: () => now })
    store.recordFailure('claude-default', '2.1.281', {
      code: 'EXECUTOR_INCOMPATIBLE',
      reason: 'Claude Code 2.1.281 加载了未批准的扩展',
      runId: 'dgr-a',
    })
    expect(read(root).profiles['claude-default']!.lastGood).toBeUndefined()
    now = 2_000
    store.recordSuccess('claude-default', '2.1.281', 'dgr-b')
    now = 3_000
    store.recordSuccess('claude-default', '2.1.281', 'dgr-c')
    const file = read(root)
    expect(file.schemaVersion).toBe(1)
    expect(file.profiles['claude-default']).toMatchObject({
      lastGood: { version: '2.1.281', at: 3_000, runId: 'dgr-c' },
      versions: {
        '2.1.281': {
          firstSeenAt: 1_000,
          successes: 2,
          lastSuccessAt: 3_000,
          versionFailures: 1,
          lastFailure: {
            code: 'EXECUTOR_INCOMPATIBLE',
            reason: 'Claude Code 2.1.281 加载了未批准的扩展',
            at: 1_000,
            runId: 'dgr-a',
          },
        },
      },
    })
    // A new store reads what the last one wrote.
    expect(
      new ExecutorHealthStore(root).rollbackOffer('claude-default', '2.1.281'),
    ).toBeNull()
  })

  it('3 · 4 · offers the last good version when the installed one failed for its version, never the installed one itself', () => {
    const store = new ExecutorHealthStore(directory())
    // Never succeeded: nothing to go back to.
    store.recordFailure('claude-default', '2.1.310', {
      code: 'EXECUTOR_INCOMPATIBLE',
      reason: 'x',
      runId: 'dgr-0',
    })
    expect(store.rollbackOffer('claude-default', '2.1.310')).toBeNull()
    store.recordSuccess('claude-default', '2.1.281', 'dgr-1')
    // Installed is the last good one.
    expect(store.rollbackOffer('claude-default', '2.1.281')).toBeNull()
    // Not installed, or not checked.
    expect(store.rollbackOffer('claude-default', null)).toBeNull()
    // 2.1.310 failed for its version (twice).
    store.recordFailure('claude-default', '2.1.310', {
      code: 'EXECUTOR_INCOMPATIBLE',
      reason: 'x',
      runId: 'dgr-2',
    })
    expect(store.rollbackOffer('claude-default', '2.1.310')).toEqual({
      target: '2.1.281',
      because: '2.1.310 上 2 次任务因版本不兼容失败',
    })
    // A version that never failed is not offered a rollback.
    expect(store.rollbackOffer('claude-default', '2.1.312')).toBeNull()
    // Another profile has its own history.
    expect(store.rollbackOffer('codex-default', '2.1.310')).toBeNull()
  })

  it('3 · a version the self-check found incompatible is offered a rollback too (VER-04 writes it)', () => {
    const root = directory()
    writeFileSync(
      join(root, EXECUTOR_HEALTH_FILE),
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          'claude-default': {
            lastGood: { version: '2.1.310', at: 1, runId: 'dgr-1' },
            versions: {
              '2.1.310': { firstSeenAt: 1, successes: 1, versionFailures: 0 },
              '2.1.315': {
                firstSeenAt: 2,
                successes: 0,
                versionFailures: 0,
                selfCheck: {
                  backend: 'claude-code',
                  version: '2.1.315',
                  checkedAt: 2,
                  status: 'incompatible',
                  issues: [
                    {
                      code: 'mcp_server',
                      detail: '加载了 MCP server x',
                      blocking: true,
                    },
                  ],
                  modelCalls: 0,
                },
              },
            },
          },
        },
      }),
    )
    expect(
      new ExecutorHealthStore(root).rollbackOffer('claude-default', '2.1.315'),
    ).toEqual({
      target: '2.1.310',
      because: '2.1.315 自检不兼容：加载了 MCP server x',
    })
  })

  it('noteVersion says when the installed version changed, and from what', () => {
    const root = directory()
    const store = new ExecutorHealthStore(root, { now: () => 5 })
    expect(store.noteVersion('claude-default', '2.1.281')).toEqual({
      changed: true,
    })
    expect(store.noteVersion('claude-default', '2.1.281')).toEqual({
      changed: false,
      previous: '2.1.281',
    })
    expect(store.noteVersion('claude-default', '2.1.310')).toEqual({
      changed: true,
      previous: '2.1.281',
    })
    expect(read(root).profiles['claude-default']).toMatchObject({
      lastSeenVersion: '2.1.310',
      versions: {
        '2.1.281': { firstSeenAt: 5, successes: 0, versionFailures: 0 },
        '2.1.310': { firstSeenAt: 5, successes: 0, versionFailures: 0 },
      },
    })
  })

  it('markRolledBack remembers the version it left; upgrades skip it', () => {
    const root = directory()
    const store = new ExecutorHealthStore(root, { now: () => 42 })
    expect([...store.skipped('claude-default')]).toEqual([])
    store.markRolledBack('claude-default', '2.1.310')
    expect(read(root).profiles['claude-default']!.versions['2.1.310']).toEqual({
      firstSeenAt: 42,
      successes: 0,
      versionFailures: 0,
      rolledBackFrom: 42,
    })
    expect([...store.skipped('claude-default')]).toEqual(['2.1.310'])
    expect([
      ...new ExecutorHealthStore(root).skipped('claude-default'),
    ]).toEqual(['2.1.310'])
    expect([...store.skipped('codex-default')]).toEqual([])
  })

  it('9 · a damaged file counts as empty and is kept aside as .damaged-<ts> before the next write', () => {
    for (const damaged of [
      '{not json',
      JSON.stringify({ schemaVersion: 1, profiles: [] }),
      JSON.stringify({
        schemaVersion: 1,
        profiles: { 'claude-default': { versions: { '2.1.281': {} } } },
      }),
    ]) {
      const root = directory()
      const file = join(root, EXECUTOR_HEALTH_FILE)
      writeFileSync(file, damaged)
      const store = new ExecutorHealthStore(root, { now: () => 777 })
      expect(store.rollbackOffer('claude-default', '2.1.310')).toBeNull()
      // Reading alone changes nothing on disk.
      expect(readFileSync(file, 'utf8')).toBe(damaged)
      store.recordSuccess('claude-default', '2.1.281', 'dgr-1')
      expect(
        readFileSync(join(root, `${EXECUTOR_HEALTH_FILE}.damaged-777`), 'utf8'),
      ).toBe(damaged)
      expect(read(root).profiles['claude-default']!.lastGood).toEqual({
        version: '2.1.281',
        at: 777,
        runId: 'dgr-1',
      })
      // Kept once: the next write just writes.
      store.recordSuccess('claude-default', '2.1.281', 'dgr-2')
      expect(
        readdirSync(root).filter((name) => name.includes('.damaged-')),
      ).toHaveLength(1)
    }
  })

  it('a file a newer Emperor wrote is read-only here: never moved aside or rewritten', () => {
    const root = directory()
    const file = join(root, EXECUTOR_HEALTH_FILE)
    const newer = JSON.stringify({ schemaVersion: 2, profiles: {} })
    writeFileSync(file, newer)
    const store = new ExecutorHealthStore(root)
    store.recordSuccess('claude-default', '2.1.281', 'dgr-1')
    store.markRolledBack('claude-default', '2.1.310')
    expect(readFileSync(file, 'utf8')).toBe(newer)
    expect(readdirSync(root)).toEqual([EXECUTOR_HEALTH_FILE])
    // Still remembered in memory for this run of Emperor.
    expect([...store.skipped('claude-default')]).toEqual(['2.1.310'])
  })

  it('ignores what is not a release version, and keeps a failure reason short', () => {
    const root = directory()
    const store = new ExecutorHealthStore(root)
    store.recordSuccess('claude-default', 'latest', 'dgr-1')
    expect(existsSync(join(root, EXECUTOR_HEALTH_FILE))).toBe(false)
    store.recordFailure('claude-default', '2.1.310', {
      code: 'EXECUTOR_INCOMPATIBLE',
      reason: '第一行\n第二行' + 'x'.repeat(2000),
      runId: 'dgr-2',
    })
    const reason =
      read(root).profiles['claude-default']!.versions['2.1.310']!.lastFailure!
        .reason
    expect(reason.startsWith('第一行')).toBe(true)
    expect(reason).not.toContain('\n')
    expect(reason.length).toBeLessThanOrEqual(300)
  })

  it('a file it cannot write never throws: the run or the rollback goes on', () => {
    const root = join(directory(), 'missing', 'deeper')
    const store = new ExecutorHealthStore(root)
    expect(() =>
      store.recordSuccess('claude-default', '2.1.281', 'dgr-1'),
    ).not.toThrow()
    expect(store.rollbackOffer('claude-default', '2.1.281')).toBeNull()
  })
})

/** The fixture's executor as a given version; Codex by default. */
function versioned(
  f: ReturnType<typeof fixture>,
  probe: Partial<ExecutorProbe>,
) {
  vi.mocked(f.registry.requireAvailable).mockImplementation(async (p) => ({
    status: 'available',
    checkedAt: Date.now(),
    authVerified: false,
    capabilities: f.registry.capabilities(p.backend),
    ...probe,
  }))
  const health = new ExecutorHealthStore(f.root)
  // The fixture's options object is the service's own.
  f.options.health = health
  return health
}

async function settle(f: ReturnType<typeof fixture>, clientRequestId: string) {
  const record = await f.service.start(f.owner, { ...spec, clientRequestId })
  return f.service.wait(record.id, record.currentRunId!)
}

const health = (f: ReturnType<typeof fixture>) =>
  existsSync(join(f.root, EXECUTOR_HEALTH_FILE))
    ? read(f.root).profiles['codex-default']
    : undefined

function turn(
  status: 'completed' | 'failed',
  text: string | undefined,
  failureCode?: string,
) {
  return async function* (
    t: { runId: string },
    open: { delegationId: string; generation: number },
  ): AsyncIterable<NormalizedExecutorEvent> {
    yield {
      type: 'turn_finished',
      status,
      ...(text !== undefined ? { text } : {}),
      ...(failureCode ? { failureCode } : {}),
      delegationId: open.delegationId,
      runId: t.runId,
      generation: open.generation,
    } as NormalizedExecutorEvent
  }
}

describe('DelegationService records what each version did', () => {
  it('1 · a run that finishes with a final text writes lastGood with its own probe’s version', async () => {
    const f = fixture()
    cleanup.push(() => f.service.shutdown(), f.cleanup)
    versioned(f, { executableVersion: '0.163.0', compatibility: 'verified' })
    const run = await settle(f, 'good')
    expect(run.phase).toBe('completed')
    expect(health(f)).toMatchObject({
      lastGood: { version: '0.163.0', runId: run.id },
      versions: { '0.163.0': { successes: 1, versionFailures: 0 } },
    })
  })

  it('1 · a run that completes without any text is not a good run', async () => {
    const f = fixture(turn('completed', ''))
    cleanup.push(() => f.service.shutdown(), f.cleanup)
    versioned(f, { executableVersion: '0.163.0', compatibility: 'verified' })
    expect((await settle(f, 'empty')).phase).toBe('completed')
    expect(health(f)?.lastGood).toBeUndefined()
  })

  it('1 · 2 · a version failure counts against the version and never writes lastGood', async () => {
    const f = fixture()
    cleanup.push(() => f.service.shutdown(), f.cleanup)
    versioned(f, { executableVersion: '0.163.0', compatibility: 'verified' })
    vi.spyOn(f.adapter, 'open').mockRejectedValueOnce(
      new DelegationError(
        'EXECUTOR_INCOMPATIBLE',
        'unapproved plugin',
        'Codex 0.163.0 加载了未批准的扩展。',
      ),
    )
    const run = await settle(f, 'incompatible')
    expect(run).toMatchObject({
      phase: 'failed',
      failureCode: 'EXECUTOR_INCOMPATIBLE',
    })
    expect(health(f)).toMatchObject({
      versions: {
        '0.163.0': {
          successes: 0,
          versionFailures: 1,
          lastFailure: {
            code: 'EXECUTOR_INCOMPATIBLE',
            reason: 'Codex 0.163.0 加载了未批准的扩展。',
            runId: run.id,
          },
        },
      },
    })
    expect(health(f)?.lastGood).toBeUndefined()
  })

  it('2 · a turn failure counts only on an unverified protocol', async () => {
    const verified = fixture(turn('failed', 'boom', 'EXECUTOR_TURN_FAILED'))
    cleanup.push(() => verified.service.shutdown(), verified.cleanup)
    versioned(verified, {
      executableVersion: '0.163.0',
      compatibility: 'verified',
    })
    expect(await settle(verified, 'verified')).toMatchObject({
      phase: 'failed',
      failureCode: 'EXECUTOR_TURN_FAILED',
    })
    expect(health(verified)?.versions?.['0.163.0']?.versionFailures ?? 0).toBe(
      0,
    )
    const unverified = fixture(turn('failed', 'boom', 'EXECUTOR_TURN_FAILED'))
    cleanup.push(() => unverified.service.shutdown(), unverified.cleanup)
    versioned(unverified, {
      executableVersion: '0.165.0',
      compatibility: 'unverified',
    })
    await settle(unverified, 'unverified')
    expect(health(unverified)).toMatchObject({
      versions: { '0.165.0': { versionFailures: 1 } },
    })
  })

  it('2 · a failure that is not about the version (WORKSPACE_GIT_FAILED) is not counted', async () => {
    const f = fixture()
    cleanup.push(() => f.service.shutdown(), f.cleanup)
    versioned(f, { executableVersion: '0.163.0', compatibility: 'unverified' })
    f.prepare.mockRejectedValueOnce(
      new WorkspaceOperationError('git_command_failed', 'fatal: index'),
    )
    expect(await settle(f, 'git')).toMatchObject({
      phase: 'failed',
      failureCode: 'WORKSPACE_GIT_FAILED',
    })
    expect(health(f)?.versions?.['0.163.0']?.versionFailures ?? 0).toBe(0)
  })

  it('a run without a version from its probe records nothing', async () => {
    const f = fixture()
    cleanup.push(() => f.service.shutdown(), f.cleanup)
    versioned(f, {})
    expect((await settle(f, 'unknown')).phase).toBe('completed')
    expect(existsSync(join(f.root, EXECUTOR_HEALTH_FILE))).toBe(false)
  })
})
