/**
 * AGT-06 fixtures: a real Git repository (or a plain folder) with its own
 * HOME and no global Git config, and a DelegationService composed over the
 * real workspace and result services with a scripted executor. Never
 * touches the user's repositories, ~/.emperor, ~/.codex or ~/.claude.
 */
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { HardenedGitRunner } from '../../workspace/git-runner'
import { SnapshotService } from '../../workspace/delegation-snapshot'
import { DelegationWorkspaceService } from '../../workspace/delegation-workspaces'
import { DelegationResults } from '../../workspace/delegation-results'
import { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
import { DelegationService, type DelegationServiceOptions } from './service'
import { defaultExecutorConfig } from './config'
import { ExecutorRegistry } from './registry'
import { FakeExecutorAdapter, fixtureDelegationRecord } from './testing'
import type {
  DelegationOwner,
  DelegationStart,
  ExecutorOpenInput,
  ExecutorTurnInput,
  NormalizedExecutorEvent,
} from './types'

const identity = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}

/** A temp workspace: `home` stands in for HOME, global Git config is off. */
export function isolatedWorkspace(kind: 'git' | 'folder' = 'git') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-agt06-')))
  const home = join(root, 'home')
  const repo = join(root, kind === 'git' ? 'repo' : 'folder')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...identity,
  }
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env })
    if (r.status !== 0) throw new Error(r.stderr || r.stdout)
    return r.stdout.trim()
  }
  writeFileSync(join(repo, 'src', 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'README.md'), 'readme\n')
  writeFileSync(join(repo, '.gitignore'), '.env*\nignored/\n')
  if (kind === 'git') {
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('commit', '-qm', 'base')
  }
  const runner = new HardenedGitRunner({
    resolveRuntime: async () => ({
      executable: 'git',
      env: { PATH: process.env.PATH ?? '' },
    }),
    run: async (r) => {
      const p = spawnSync(r.executable, r.args, {
        cwd: r.cwd,
        env: r.env,
        input: r.stdin,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      return {
        exitCode: p.status ?? 1,
        stdout: p.stdout ?? '',
        stderr: p.stderr ?? '',
      }
    },
  })
  return {
    root,
    home,
    repo,
    git,
    runner,
    /** Blob objects in the repository's object database. */
    blobCount: () =>
      git('cat-file', '--batch-all-objects', '--batch-check=%(objecttype)')
        .split('\n')
        .filter((line) => line === 'blob').length,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

export type ResultScript = (
  turn: ExecutorTurnInput,
  open: ExecutorOpenInput,
) => AsyncIterable<NormalizedExecutorEvent>

/** A run that writes `files` into its workspace and completes. */
export function writes(
  files: Record<string, string | null>,
  gate?: Promise<void>,
): ResultScript {
  return async function* (turn, open) {
    await gate
    for (const [path, text] of Object.entries(files)) {
      const target = join(open.cwd, path)
      if (text === null) rmSync(target, { force: true })
      else {
        mkdirSync(join(target, '..'), { recursive: true })
        writeFileSync(target, text)
      }
    }
    yield {
      type: 'turn_finished',
      status: 'completed',
      text: 'changed ' + Object.keys(files).join(', '),
      delegationId: open.delegationId,
      runId: turn.runId,
      generation: open.generation,
    }
  }
}

/** Runs waiting in `waitsForStop`, ended by the session's interrupt. */
const stopWaiters = new Set<() => void>()
/** A run that waits until it is stopped (interrupt or abort). */
export const waitsForStop: ResultScript = async function* (turn, open) {
  await new Promise<void>((resolve) => {
    if (open.signal.aborted) resolve()
    open.signal.addEventListener('abort', () => resolve(), { once: true })
    stopWaiters.add(resolve)
  })
  yield {
    type: 'turn_finished',
    status: 'interrupted',
    delegationId: open.delegationId,
    runId: turn.runId,
    generation: open.generation,
  }
}

export function resultsFixture(
  input: {
    kind?: 'git' | 'folder'
    script?: ResultScript
    approve?: boolean
  } = {},
) {
  const w = isolatedWorkspace(input.kind ?? 'git')
  const state = join(w.root, 'delegations')
  const config = defaultExecutorConfig()
  config.profiles.forEach((p) => {
    p.enabled = true
  })
  const registry = new ExecutorRegistry()
  vi.spyOn(registry, 'requireAvailable').mockImplementation(async (p) => ({
    status: 'available',
    checkedAt: Date.now(),
    authVerified: false,
    capabilities: registry.capabilities(p.backend),
  }))
  let script: ResultScript = input.script ?? writes({})
  /** Delegations whose run reached the executor, and who waits for one. */
  const reached = new Set<string>()
  const reachWaiters = new Map<string, () => void>()
  const adapter = new FakeExecutorAdapter('codex', (turn, open) => {
    reached.add(open.delegationId)
    reachWaiters.get(open.delegationId)?.()
    return script(turn, open)
  })
  // A stop reaches a waiting script, as a real executor's turn would end.
  const open = adapter.open.bind(adapter)
  adapter.open = async (input) => {
    const session = await open(input)
    const interrupt = session.interrupt.bind(session)
    session.interrupt = async (turnId) => {
      for (const stop of stopWaiters) stop()
      stopWaiters.clear()
      return interrupt(turnId)
    }
    return session
  }
  const mutations = new WorkspaceMutationCoordinator()
  const workspaces = new DelegationWorkspaceService({
    root: state,
    runner: w.runner,
    mutations,
    snapshots: new SnapshotService({
      runner: w.runner,
      tempRoot: join(state, 'indexes'),
      resources: mutations.resources,
    }),
  })
  const results = new DelegationResults({
    root: state,
    runner: w.runner,
    mutations,
  })
  const owner: DelegationOwner = {
    ...fixtureDelegationRecord().owner,
    rootSessionId: 'root',
    parentAgentId: 'root',
  }
  const options: DelegationServiceOptions = {
    root: state,
    boundaryMarkerDir: join(state, 'markers'),
    config: () => config,
    registry,
    adapters: new Map([['codex', adapter]]),
    parent: () => ({
      cwd: w.repo,
      policy: { mode: 'workspace-write', workspaceRoot: w.repo },
    }),
    workspaces,
    results,
    mutations,
    runtime: async (_profile, id) => {
      const runtimeRoot = join(state, 'runtime', id),
        tempRoot = join(runtimeRoot, 'tmp')
      mkdirSync(tempRoot, { recursive: true })
      return {
        runtimeRoot,
        tempRoot,
        environment: { PATH: process.env.PATH ?? '' },
      }
    },
  }
  const service = new DelegationService(options)
  let request = 0
  const start = async (spec: Partial<DelegationStart> = {}) => {
    const record = await service.start(owner, {
      backend: 'codex',
      description: 'fixture change',
      prompt: 'change the files',
      context: 'isolated',
      workspace: 'isolated-worktree',
      base: 'snapshot',
      runInBackground: true,
      clientRequestId: 'request-' + ++request,
      ...spec,
    })
    return record
  }
  const settle = async (id: string) => {
    const record = service.inspect(id).record!
    return service.wait(id, record.currentRunId!)
  }
  /**
   * Wait until the run of `id` reaches its executor: its workspace is bound
   * and locked by then. Fails at once if the run ends first. No clock: on a
   * loaded machine the Git work before it takes as long as it takes.
   */
  const reachesExecutor = async (id: string): Promise<void> => {
    if (reached.has(id)) return
    const record = service.inspect(id).record!
    const started = new Promise<void>((resolve) => {
      reachWaiters.set(id, resolve)
    })
    const ended = service.wait(id, record.currentRunId!).then(
      (run) => `ended ${run.phase}`,
      (error: unknown) => `failed: ${String(error)}`,
    )
    const outcome = await Promise.race([started.then(() => null), ended])
    reachWaiters.delete(id)
    if (outcome !== null && !reached.has(id))
      throw new Error(`the run ${outcome} before it reached the executor`)
  }
  return {
    ...w,
    state,
    config,
    adapter,
    mutations,
    workspaces,
    results,
    owner,
    options,
    service,
    start,
    settle,
    reachesExecutor,
    setScript: (next: ResultScript) => {
      script = next
    },
  }
}
