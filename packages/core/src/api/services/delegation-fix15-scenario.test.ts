/**
 * FIX-15 · 5: the user's scenario through the composed Core, with the real
 * Git runtime (no resolveGitRuntime mock), the real workspace service and
 * the real turn-files recorder; only the model and the executors are fakes.
 *
 * A Build session on a folder outside Git is created from the start page
 * with plan mode on (the FIX-13 draft path); the plan is approved; then in
 * one step the model starts eight local subagents and three external runs
 * (Codex, Claude Code, Codex; a review in place by default), and in the
 * next step three more that write (`shared-exclusive` / `snapshot`), while
 * the local ones still run. Every external run must get its workspace.
 */
import { afterEach, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  eventOf,
  makeApi,
  pendingInteractionId,
  waitFor,
} from '../test-helpers'
import { FakeExecutorAdapter } from '../../harness/delegation/testing'
import { replyChunks } from '../../harness/testing'
import type { GenerateOptions, StreamChunk } from '../../llm/types'
import type { DelegationServiceOptions } from '../../harness/delegation/service'
import { TERMINAL_RUN_PHASES } from '../../harness/delegation/types'
import { setCoreLogSink, type LogLine } from '../../util/log'

const VIEW = { sessionId: null }
const cleanups: (() => void | Promise<void>)[] = []
const lines: LogLine[] = []
afterEach(async () => {
  setCoreLogSink(null)
  lines.length = 0
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

/** A folder outside Git, shaped like the user's (two finished novels). */
function nonGitProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'fix15-project-'))
  for (const book of ['novel', 'novel-2']) {
    mkdirSync(join(root, book), { recursive: true })
    for (let n = 1; n <= 10; n++)
      writeFileSync(join(root, book, `ch${n}.md`), `# 第${n}章\n\n正文。\n`)
  }
  mkdirSync(join(root, 'tools'))
  writeFileSync(join(root, 'tools', 'novel.py'), 'print("verify")\n')
  writeFileSync(join(root, 'ch10-draft.md'), '# 草稿\n')
  return root
}

const LOCAL = 8

function subagent(
  id: string,
  description: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    name: 'subagent',
    args: {
      description,
      prompt: `${description}: write your chapter`,
      run_in_background: true,
      ...extra,
    },
  }
}

/** Codex and Claude Code: enabled, allowed, available; fake processes. */
async function fakeExecutors(api: Awaited<ReturnType<typeof makeApi>>['api']) {
  const config = api.executorConfig.read()
  for (const profile of config.profiles) profile.enabled = true
  await api.executors.configure({ expectedRevision: 0, config }, VIEW)
  for (const profile of config.profiles)
    api.host.delegationConsent.store?.grant(profile.id)
  vi.spyOn(api.executorRegistry, 'requireAvailable').mockImplementation(
    async (profile) => ({
      status: 'available',
      checkedAt: Date.now(),
      authVerified: true,
      capabilities: api.executorRegistry.capabilities(profile.backend),
    }),
  )
  const options = (
    api.delegationRuntime as unknown as { options: DelegationServiceOptions }
  ).options
  options.checkAuth = undefined
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
  const script: ConstructorParameters<typeof FakeExecutorAdapter>[1] =
    async function* (turn, open) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      yield {
        type: 'turn_finished',
        status: 'completed',
        text: 'chapter written',
        delegationId: open.delegationId,
        runId: turn.runId,
        generation: open.generation,
      }
    }
  options.adapters.set('codex', new FakeExecutorAdapter('codex', script))
  options.adapters.set(
    'claude-code',
    new FakeExecutorAdapter('claude-code', script),
  )
}

async function scenario(opts: { plan?: boolean } = {}) {
  setCoreLogSink((line) => lines.push(line))
  const project = nonGitProject()
  cleanups.push(() => rmSync(project, { recursive: true, force: true }))
  const { api, adapter, events, root } = await makeApi()
  cleanups.push(async () => {
    await api.close()
    rmSync(root, { recursive: true, force: true })
  })
  const main: Array<Parameters<typeof replyChunks>[0]> = [
    ...(opts.plan === false
      ? []
      : [
          {
            tools: [
              {
                id: 'plan',
                name: 'exit_plan_mode',
                args: { plan: '# 十章小说\n- 第 1 章 Codex，第 10 章 Claude' },
              },
            ],
          },
        ]),
    {
      tools: [
        subagent('ext-1', '第1章 codex', { backend: 'codex' }),
        subagent('ext-10', '第10章 claude', { backend: 'claude-code' }),
        ...Array.from({ length: LOCAL }, (_, i) =>
          subagent(`local-${i + 2}`, `第${i + 2}章`),
        ),
        subagent('ext-cover', '封面 codex', { backend: 'codex' }),
      ],
    },
    {
      tools: [
        subagent('ext-1b', '第1章 codex 写', {
          backend: 'codex',
          workspace: 'shared-exclusive',
          base: 'snapshot',
        }),
        subagent('ext-10b', '第10章 claude 写', {
          backend: 'claude-code',
          workspace: 'shared-exclusive',
          base: 'snapshot',
        }),
        subagent('ext-cover-b', '封面 codex 写', {
          backend: 'codex',
          workspace: 'shared-exclusive',
          base: 'snapshot',
        }),
      ],
    },
  ]
  // The children answer by their own session: a write into the project,
  // then a closing line; the root follows its script, then says ok.
  const childSteps = new Map<string, number>()
  const original = adapter.stream.bind(adapter)
  adapter.stream = async function* (route, options: GenerateOptions) {
    if (options.purpose === 'session-title') {
      yield* original(route, options)
      return
    }
    const sessionId = String(options.sessionId ?? '')
    let chunks: StreamChunk[]
    if (sessionId.startsWith('sub-')) {
      const step = (childSteps.get(sessionId) ?? 0) + 1
      childSteps.set(sessionId, step)
      await new Promise((resolve) => setTimeout(resolve, 150))
      chunks =
        step === 1
          ? replyChunks({
              tools: [
                {
                  name: 'write',
                  args: {
                    file_path: join(project, 'novel-3', `${sessionId}.md`),
                    content: '# 一章\n\n正文。\n',
                  },
                },
              ],
            })
          : replyChunks({ text: `${sessionId} 写完了` })
    } else {
      chunks = replyChunks(main.shift() ?? { text: 'ok' })
    }
    for (const chunk of chunks) yield chunk
  }

  await fakeExecutors(api)

  // The start page: a Build draft on the project, plan mode on (FIX-13).
  const submitted = api.chat.submit({
    content: '规划一本十章小说，十个代理并行写',
    sessionId: 'draft:fix15',
    clientDraftId: 'draft:fix15',
    draftSession: {
      mode: 'build',
      project: {
        project_id: 'proj_fix15',
        project_path: project,
        project_name: 'emperortest',
      },
      plan: opts.plan !== false,
      preset: 'danger-full-access',
    },
  })
  if (opts.plan !== false) {
    await waitFor(() => eventOf(events, 'plan_draft') !== undefined, 15_000)
    await api.control.approvePlan(pendingInteractionId(events, 'plan_draft'))
  }
  await submitted
  const created = eventOf(events, 'session_created') as {
    session: { id: string }
  }
  const sessionId = created.session.id
  const externals = () =>
    api.delegationRuntime
      .list()
      .filter((state) => state.record?.owner.rootSessionId === sessionId)
  await waitFor(
    () =>
      externals().length === 6 &&
      externals().every((state) =>
        Object.values(state.runs).every((run) =>
          TERMINAL_RUN_PHASES.has(run.phase),
        ),
      ),
    30_000,
  )
  await waitFor(
    () =>
      api.tasks
        .list({ sessionId })
        .filter((task) => task.kind === 'subagent')
        .every((task) => task.status !== 'running'),
    30_000,
  )
  return { api, events, project, sessionId, externals }
}

/** What each external run ended as, and why when it failed. */
function outcomes(
  states: ReturnType<Awaited<ReturnType<typeof scenario>>['externals']>,
) {
  return states.map((state) => {
    const run = Object.values(state.runs)[0]!
    return {
      backend: state.record!.backend,
      workspace: state.record!.startSpec!.workspace,
      phase: run.phase,
      failureCode: run.failureCode ?? null,
      summary: run.phase === 'completed' ? null : (run.summary ?? null),
      bound: Boolean(state.record!.workspaceLeaseId),
    }
  })
}

it('FIX-15 · 5 · a draft Build session outside Git, plan approved: eight local and six external subagents all get their workspace', async () => {
  const f = await scenario()
  const result = outcomes(f.externals())
  expect(
    result,
    JSON.stringify(
      lines.filter((line) => line.msg.startsWith('external run')),
      null,
      1,
    ),
  ).toEqual(
    result.map((r) => ({
      ...r,
      phase: 'completed',
      failureCode: null,
      summary: null,
      bound: true,
    })),
  )
  // Reviews read the folder in place; writes work in a copy of it.
  const leases = readdirSync(join(f.api.paths.delegationsRoot, 'leases')).map(
    (name) =>
      JSON.parse(
        readFileSync(join(f.api.paths.delegationsRoot, 'leases', name), 'utf8'),
      ) as { mode: string; status: string; path: string; revision: number },
  )
  expect(leases).toHaveLength(6)
  for (const lease of leases) expect(lease.revision).toBeGreaterThanOrEqual(2)
  expect(existsSync(join(f.project, '.git'))).toBe(false)
}, 90_000)

/**
 * FIX-15 · 6, the root cause. Each new (ad-hoc signed) build loses macOS's
 * Desktop-folder permission; on its first launch the environment check's
 * `--version` runs (their working directory is the project) are the first
 * to touch the folder, and macOS holds them until the user answers the
 * prompt. On 2026-10-22 the answer came after 104 s: the checks hit their
 * 5 s limit, Git read as failed, and that was kept for the whole session —
 * every external run on the project then failed preparing its workspace.
 */
it('FIX-15 · 6 · once the folder prompt is answered, external runs on the project get their workspace again', async () => {
  setCoreLogSink((line) => lines.push(line))
  const project = nonGitProject()
  cleanups.push(() => rmSync(project, { recursive: true, force: true }))
  const { api, root } = await makeApi()
  cleanups.push(async () => {
    await api.close()
    rmSync(root, { recursive: true, force: true })
  })
  await fakeExecutors(api)
  // The macOS prompt: while it is up, a check inside the project never
  // finishes (the runner reports what its 5 s limit reports).
  const inside = realpathSync(project)
  let held = true
  let clock = Date.now()
  const probe = api.host.kept.environmentProbe as unknown as {
    runner: {
      run: (request: { cwd: string }) => Promise<Record<string, unknown>>
    }
    now: () => number
  }
  const real = probe.runner
  probe.runner = {
    run: async (request) =>
      held && request.cwd.startsWith(inside)
        ? {
            status: 'timeout',
            exitCode: null,
            stdout: '',
            stderr: '',
            durationMs: 5_000,
            error: null,
          }
        : real.run(request),
  }
  probe.now = () => clock
  const sessionId = String(
    api.sessions.create({
      title: 'emperortest',
      mode: 'build',
      project_path: project,
    }).id,
  )
  api.sessions.activate(sessionId)
  api.control.setPermissionMode('danger-full-access', sessionId)
  // Launch: something asks about the project's Git while the prompt is up.
  await expect(api.git.status({ sessionId } as never)).rejects.toMatchObject({
    code: 'git_unavailable',
  })
  // The user allows the folder; the work starts minutes later.
  held = false
  clock += 3 * 60_000
  const record = await api.delegationRuntime.start(
    {
      rootSessionId: sessionId,
      parentAgentId: sessionId,
      taskScopeId: 'message:fix15',
      requiredForGoal: false,
      depth: 1,
      source: 'human',
    },
    {
      backend: 'codex',
      description: '第1章 codex',
      prompt: 'write chapter one',
      context: 'isolated',
      workspace: 'shared-readonly',
      base: 'committed',
      runInBackground: true,
      clientRequestId: 'fix15-after-prompt',
    },
  )
  const run = await api.delegationRuntime.wait(record.id, record.currentRunId!)
  expect(
    { phase: run.phase, failureCode: run.failureCode, summary: run.summary },
    JSON.stringify(lines.filter((line) => line.level !== 'debug')),
  ).toEqual({
    phase: 'completed',
    failureCode: undefined,
    summary: expect.any(String),
  })
  expect(
    api.delegationRuntime.inspect(record.id).record!.workspaceLeaseId,
  ).not.toBe('')
}, 60_000)

it('FIX-15 · 1 · Git unavailable says why, in the error and once in core.log', async () => {
  setCoreLogSink((line) => lines.push(line))
  const project = nonGitProject()
  cleanups.push(() => rmSync(project, { recursive: true, force: true }))
  const { api, root } = await makeApi()
  cleanups.push(async () => {
    await api.close()
    rmSync(root, { recursive: true, force: true })
  })
  const inside = realpathSync(project)
  const probe = api.host.kept.environmentProbe as unknown as {
    runner: {
      run: (request: { cwd: string }) => Promise<Record<string, unknown>>
    }
  }
  const real = probe.runner
  probe.runner = {
    run: async (request) =>
      request.cwd.startsWith(inside)
        ? {
            status: 'timeout',
            exitCode: null,
            stdout: '',
            stderr: '',
            durationMs: 5_000,
            error: null,
          }
        : real.run(request),
  }
  const sessionId = String(
    api.sessions.create({ title: 'p', mode: 'build', project_path: project })
      .id,
  )
  for (let n = 0; n < 3; n++)
    await expect(api.git.status({ sessionId } as never)).rejects.toMatchObject({
      code: 'git_unavailable',
      message: '当前签名执行环境中没有可用 Git（探测失败：timeout）。',
    })
  const logged = lines.filter((l) => l.msg === 'git runtime unavailable')
  expect(logged).toHaveLength(1)
  expect(logged[0]!.fields).toMatchObject({
    reason: '探测失败：timeout',
    git: { status: 'failed' },
  })
  // An external run on the project now says the same, where the user and
  // the main agent look: the run, its row (the projection's detail) and the
  // notice in the parent's inbox (3 · 4).
  await fakeExecutors(api)
  api.sessions.activate(sessionId)
  api.control.setPermissionMode('danger-full-access', sessionId)
  const record = await api.delegationRuntime.start(
    {
      rootSessionId: sessionId,
      parentAgentId: sessionId,
      taskScopeId: 'message:fix15',
      requiredForGoal: false,
      depth: 1,
      source: 'human',
    },
    {
      backend: 'codex',
      description: '第1章 codex',
      prompt: 'write chapter one',
      context: 'isolated',
      workspace: 'shared-readonly',
      base: 'committed',
      runInBackground: true,
      clientRequestId: 'fix15-held',
    },
  )
  const run = await api.delegationRuntime.wait(record.id, record.currentRunId!)
  const reason =
    '准备工作区失败：当前签名执行环境中没有可用 Git（探测失败：timeout）。'
  expect(run).toMatchObject({
    phase: 'failed',
    failureCode: 'WORKSPACE_GIT_UNAVAILABLE',
    summary: reason,
  })
  await waitFor(() =>
    (api.host.sessionLog(sessionId)?.events ?? []).some(
      (event) =>
        event.type === 'delegation/projection' &&
        (event.data as { task?: { detail?: string } }).task?.detail === reason,
    ),
  )
  await waitFor(() =>
    JSON.stringify(api.host.sessionLog(sessionId)?.events ?? []).includes(
      'execution=failed (WORKSPACE_GIT_UNAVAILABLE)',
    ),
  )
}, 60_000)
