/**
 * AGT-06 through the composed Core: a finished run's result reaches the
 * conversation as a `delegation/result` record, and 查看差异 / 应用到项目 /
 * 撤销 / 丢弃 run through `delegations.*` operations. A main-session write
 * that waits on a child's workspace says so after the notice delay.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeApi } from '../test-helpers'
import {
  FakeExecutorAdapter,
  fixtureDelegationRecord,
} from '../../harness/delegation/testing'
import {
  isolatedWorkspace,
  writes,
} from '../../harness/delegation/results-test-fixture'
import { workspaceMutationDomain } from '../../workspace/mutation-coordinator'

/** Waits on work that runs processes, Git or the file system: room for a
 * loaded CI runner instead of the 1 s default (FIX-17). */
const LOADED = { timeout: 10_000 }

const VIEW = { sessionId: null }
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})

async function composed() {
  const w = isolatedWorkspace('git')
  const { api, events } = await makeApi()
  cleanups.push(async () => {
    await api.close()
    w.cleanup()
  })
  vi.spyOn(
    api as unknown as {
      resolveGitRuntime: (cwd: string) => Promise<{
        executable: string
        gitVersion: string
        env: Record<string, string>
      }>
    },
    'resolveGitRuntime',
  ).mockResolvedValue({
    executable: 'git',
    gitVersion: 'fixture',
    env: { PATH: process.env.PATH ?? '' },
  })
  const root = String(
    api.sessions.create({
      title: 'results',
      mode: 'build',
      project_path: w.repo,
    }).id,
  )
  api.sessions.activate(root)
  api.control.setPermissionMode('workspace-write', root)
  vi.spyOn(api.executorRegistry, 'requireAvailable').mockImplementation(
    async (profile) => ({
      status: 'available',
      checkedAt: Date.now(),
      authVerified: false,
      capabilities: api.executorRegistry.capabilities(profile.backend),
    }),
  )
  const options = (
    api.delegationRuntime as unknown as {
      options: import('../../harness/delegation/service').DelegationServiceOptions
    }
  ).options
  options.runtime = async (_profile, id) => {
    const runtimeRoot = join(api.paths.delegationsRoot, 'test-runtime', id),
      tempRoot = join(runtimeRoot, 'tmp')
    mkdirSync(tempRoot, { recursive: true })
    return {
      runtimeRoot,
      tempRoot,
      environment: { PATH: process.env.PATH ?? '' },
    }
  }
  const config = api.executorConfig.read()
  config.profiles.find((p) => p.backend === 'codex')!.enabled = true
  await api.executors.configure({ expectedRevision: 0, config }, VIEW)
  let request = 0
  const run = async (files: Record<string, string | null>) => {
    options.adapters.set(
      'codex',
      new FakeExecutorAdapter('codex', writes(files)),
    )
    const record = await api.delegationRuntime.start(
      {
        ...fixtureDelegationRecord().owner,
        rootSessionId: root,
        parentAgentId: root,
        source: 'human',
      },
      {
        backend: 'codex',
        description: 'Codex 改文件',
        prompt: 'change files',
        context: 'isolated',
        workspace: 'isolated-worktree',
        base: 'snapshot',
        runInBackground: true,
        clientRequestId: 'request-' + ++request,
      },
    )
    const settled = await api.delegationRuntime.wait(
      record.id,
      record.currentRunId!,
    )
    return { record, run: settled }
  }
  const results = () =>
    (api.host.sessionLog(root)?.events ?? [])
      .filter((event) => event.type === 'delegation/result')
      .map((event) => event.data as unknown as Record<string, unknown>)
  return { ...w, api, events, root, run, results }
}

it('4 · 5 · a finished run shows its result in the conversation; 查看差异, 应用到项目 and 撤销 work through Core', async () => {
  const f = await composed()
  const { record, run } = await f.run({
    'src/a.txt': 'one\ntwo\nthree\nfour\n',
    'src/new.ts': 'export {}\n',
  })
  await vi.waitFor(() => expect(f.results().length).toBeGreaterThan(0), LOADED)
  expect(f.results().at(-1)).toMatchObject({
    delegation_id: record.id,
    run_id: run.id,
    backend: 'codex',
    title: 'Codex 改文件',
    state: 'ready',
    totals: { files: 2, additions: 2, deletions: 0 },
  })
  const diff = await f.api.delegations.diff({
    runId: run.id,
    sessionId: f.root,
    path: 'src/a.txt',
  })
  expect(diff.diff).toContain('+four')
  const applied = await f.api.delegations.apply({
    runId: run.id,
    sessionId: f.root,
  })
  expect(applied.state).toBe('applied')
  expect(readFileSync(join(f.repo, 'src', 'new.ts'), 'utf8')).toBe(
    'export {}\n',
  )
  await vi.waitFor(
    () =>
      expect(f.results().at(-1)).toMatchObject({
        state: 'applied',
        by: 'user',
      }),
    LOADED,
  )
  // After applying, 查看差异 shows what the apply changed in the project.
  expect(
    (
      await f.api.delegations.diff({
        runId: run.id,
        sessionId: f.root,
        path: 'src/a.txt',
      })
    ).diff,
  ).toContain('+four')
  const undone = await f.api.delegations.undo({
    runId: run.id,
    sessionId: f.root,
  })
  expect(undone.state).toBe('reverted')
  expect(existsSync(join(f.repo, 'src', 'new.ts'))).toBe(false)
  await vi.waitFor(
    () => expect(f.results().at(-1)).toMatchObject({ state: 'reverted' }),
    LOADED,
  )
}, 60_000)

it('10 · 丢弃 removes the result, and purging the conversation removes what is left', async () => {
  const f = await composed()
  const first = await f.run({ 'src/a.txt': 'discard me\n' })
  const firstLease = f.api.delegationRuntime.inspect(first.record.id).record!
  const discarded = await f.api.delegations.discard({
    runId: first.run.id,
    sessionId: f.root,
  })
  expect(discarded.state).toBe('discarded')
  expect(readFileSync(join(f.repo, 'src', 'a.txt'), 'utf8')).toBe(
    'one\ntwo\nthree\n',
  )
  expect(existsSync(firstLease.cwd)).toBe(false)
  // An applied result keeps only what 撤销 needs, under the conversation.
  const applied = await f.run({ 'src/c.txt': 'applied\n' })
  await f.api.delegations.apply({ runId: applied.run.id, sessionId: f.root })
  expect(f.git('for-each-ref', 'refs/emperor/delegations/')).toBe('')
  expect(f.git('for-each-ref', 'refs/emperor/turns/')).not.toBe('')
  const second = await f.run({ 'src/b.txt': 'pending\n' })
  const pending = f.api.delegationRuntime.inspect(second.record.id).record!
  expect(existsSync(pending.cwd)).toBe(true)
  f.api.sessions.create({ title: 'keep one' })
  await f.api.sessions.delete(f.root)
  // A deleted conversation can still come back: its result stays.
  expect(existsSync(pending.cwd)).toBe(true)
  await f.api.sessions.purgeDeleted(f.root)
  expect(existsSync(pending.cwd)).toBe(false)
  expect(f.git('for-each-ref', 'refs/emperor/')).toBe('')
}, 60_000)

it('9 · a main-session write that waits for a child holding the workspace is announced after the notice delay', async () => {
  const f = await composed()
  const { record } = await f.run({})
  const held = await f.api.workspaceMutations.resources.acquire({
    keys: [workspaceMutationDomain(f.repo)],
    mode: 'exclusive',
    owner: record.id,
  })
  f.api.workspaceWaitNoticeMs = 20
  const provider = (
    f.api.host.tools as unknown as {
      executionLeases: {
        acquire(call: unknown): Promise<{ release(): void } | undefined>
      }
    }
  ).executionLeases
  const agent = f.api.host.agentFor(f.root)
  const waiting = provider.acquire({
    name: 'write',
    agent,
    callId: 'call-write',
    arguments: { file_path: 'src/a.txt' },
    signal: new AbortController().signal,
  })
  await vi.waitFor(
    () =>
      expect(f.events).toContainEqual(
        expect.objectContaining({
          event: 'workspace_wait',
          session_id: f.root,
          call_id: 'call-write',
          delegation_id: record.id,
          waiting: true,
        }),
      ),
    LOADED,
  )
  held.release()
  ;(await waiting)?.release()
  expect(f.events).toContainEqual(
    expect.objectContaining({
      event: 'workspace_wait',
      call_id: 'call-write',
      waiting: false,
    }),
  )
}, 60_000)
