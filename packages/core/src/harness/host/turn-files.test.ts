// File records on a real HarnessHost with a scripted model and a real Git
// project: the before snapshot waits for the first write, the end of the
// task lists the files (file tools and the shell alike), read-only tasks
// record nothing, undo restores and is recorded once, and a project
// outside Git counts the file tools only. UI-S15: a task — a message the
// user sent and every turn a subagent's or background job's result woke —
// is recorded once, when nothing of it runs any more, under its last turn.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LlmAdapter } from '../../llm/adapter'
import { LlmClient } from '../../llm/client'
import type { GenerateOptions, StreamChunk } from '../../llm/types'
import { HardenedGitRunner } from '../../workspace/git-runner'
import { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
import { TurnSnapshots } from '../../workspace/turn-snapshots'
import type { SandboxBackend } from '../sandbox/backend'
import {
  ScriptedAdapter,
  replyChunks,
  testRoute,
  type ScriptedReply,
} from '../testing'
import { HarnessHost } from './host'
import {
  TurnFileRecorder,
  callMayWriteFiles,
  type TurnFilesRecord,
} from './turn-files'

const hosts: HarnessHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

const passthroughBackend: SandboxBackend = {
  confine: (argv) => ({
    argv: [...argv],
    enforcement: 'full',
    denialSignatures: [],
    runnerFailureRules: [],
  }),
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  })
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function gitProject(root: string): string {
  const project = join(root, 'project')
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(join(project, 'README.md'), '# Readme\n')
  writeFileSync(join(project, 'src', 'a.ts'), 'one\n')
  git(project, 'init', '-q', '-b', 'main')
  git(project, 'add', '-A')
  git(project, 'commit', '-q', '-m', 'init')
  return project
}

interface SetupOptions {
  git?: boolean
  budgetMs?: number
  busy?: () => boolean
  others?: () => boolean
  /** Answers instead of the scripted replies (e.g. by session). */
  adapter?: LlmAdapter
  /**
   * How the recorder is wired: through `host.extend` (default; the host
   * closes open tasks when it closes) or only `install`ed, which leaves an
   * open task behind at close the way a crash does.
   */
  wiring?: 'extend' | 'install'
}

/** A host over `root` (an Emperor Home and its sessions), with a recorder. */
async function startHost(
  root: string,
  project: string,
  replies: ScriptedReply[],
  options: SetupOptions,
  existing?: string,
) {
  const adapter = new ScriptedAdapter(replies)
  const llm = new LlmClient({
    adapterFor: () => options.adapter ?? adapter,
  })
  llm.setRoutes([testRoute()], 'test-route')
  const host = await HarnessHost.create({
    root,
    stateRoot: join(root, 'home'),
    stateRootSource: 'explicit',
    emperorHomePrepared: false,
    llm,
    sandboxBackend: passthroughBackend,
    initializeMcp: false,
    defaultPreset: 'danger-full-access',
  })
  hosts.push(host)
  const sessionId =
    existing ??
    host.kept.sessionStore.create('t', {
      mode: 'build',
      project: { project_path: project },
    }).id
  const runner = new HardenedGitRunner({
    resolveRuntime: async () => ({
      executable: 'git',
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (item): item is [string, string] => item[1] !== undefined,
        ),
      ),
    }),
    run: async (request) => {
      const result = spawnSync(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        input: request.stdin,
        encoding: 'utf8',
      })
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout || '',
        stderr: result.stderr || result.error?.message || '',
      }
    },
  })
  const coordinator = new WorkspaceMutationCoordinator()
  const recorder = new TurnFileRecorder({
    snapshots: new TurnSnapshots({
      exec: (cwd, args, execOptions) => runner.execute(cwd, args, execOptions),
      tempDir: join(root, 'home', 'git', 'turns'),
    }),
    projectRoot: (id) => (id === sessionId ? project : null),
    workspaceRoot: (id) => host.sessionWorkspaceRoot(id),
    rootOf: (agent) => host.rootOf(agent),
    sessionLog: (id) => host.sessionLog(id),
    workspaceBusy: options.busy ?? (() => false),
    ...(options.others === undefined ? {} : { othersRunning: options.others }),
    runExclusive: (workspace, owner, action) =>
      coordinator.runExclusive(workspace, owner, action),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  })
  if (options.wiring === 'install') recorder.install(host)
  else host.extend({ turnFiles: recorder })
  return { host, adapter, recorder, coordinator, sessionId }
}

async function setup(replies: ScriptedReply[], options: SetupOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-turn-files-')))
  const project = options.git === false ? join(root, 'plain') : gitProject(root)
  mkdirSync(project, { recursive: true })
  const started = await startHost(root, project, replies, options)
  return { ...started, root, project }
}

function records(host: HarnessHost, sessionId: string): TurnFilesRecord[] {
  return (host.sessionLog(sessionId)?.events ?? [])
    .filter((event) => event.type === 'turn/files')
    .map((event) => event.data as TurnFilesRecord)
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const writeAndShell: ScriptedReply = {
  tools: [
    { name: 'write', args: { file_path: 'src/new.ts', content: 'x\n' } },
    {
      name: 'bash',
      args: {
        command: "printf 'y\\n' > shell.txt && rm README.md",
        description: 'Change two files',
      },
    },
  ],
}

describe('TurnFileRecorder', () => {
  it('lists what a turn changed, file tools and shell alike', async () => {
    const { host, recorder, project, sessionId } = await setup([
      writeAndShell,
      { text: 'done' },
      { text: 'just talking' },
    ])
    await host.submit({ sessionId, content: 'change things' })
    await waitFor(() => records(host, sessionId).length === 1)
    const [record] = records(host, sessionId)
    expect(record).toMatchObject({
      turn: 1,
      mode: 'git',
      status: 'recorded',
      files: [
        { path: 'README.md', status: 'deleted', additions: 0, deletions: 1 },
        { path: 'shell.txt', status: 'added', additions: 1, deletions: 0 },
        { path: 'src/new.ts', status: 'added', additions: 1, deletions: 0 },
      ],
      totals: { files: 3, additions: 2, deletions: 1 },
      snapshot: {
        before: expect.stringMatching(/^[0-9a-f]{40}$/),
        after: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    })
    expect(
      git(project, 'for-each-ref', '--format=%(refname)', 'refs/emperor/'),
    ).toBe(
      [
        `refs/emperor/turns/${sessionId}/1/after`,
        `refs/emperor/turns/${sessionId}/1/before`,
      ].join('\n'),
    )
    expect(
      (await recorder.diff({ sessionId, turn: 1, path: 'shell.txt' })).diff,
    ).toContain('+y')

    // A turn that only talks takes no snapshot and records nothing.
    await host.submit({ sessionId, content: 'and now?' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(records(host, sessionId)).toHaveLength(1)
  })

  it('undoes a turn once, keeping later edits', async () => {
    const { host, recorder, project, sessionId } = await setup([
      writeAndShell,
      { text: 'done' },
    ])
    await host.submit({ sessionId, content: 'change things' })
    await waitFor(() => records(host, sessionId).length === 1)
    writeFileSync(join(project, 'shell.txt'), 'the user kept this\n')
    const result = await recorder.revert({ sessionId, turn: 1 })
    expect(result).toEqual({
      turn: 1,
      reverted: ['README.md', 'src/new.ts'],
      skipped: [{ path: 'shell.txt', reason: 'changed-since' }],
    })
    expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('# Readme\n')
    expect(existsSync(join(project, 'src', 'new.ts'))).toBe(false)
    expect(readFileSync(join(project, 'shell.txt'), 'utf8')).toBe(
      'the user kept this\n',
    )
    const logged = host
      .sessionLog(sessionId)!
      .events.filter((event) => event.type === 'turn/files-reverted')
    expect(logged.map((event) => event.data)).toEqual([result])
    await expect(recorder.revert({ sessionId, turn: 1 })).rejects.toMatchObject(
      { code: 'turn_already_reverted' },
    )
  })

  it('notes another session running in the workspace during the turn', async () => {
    const { host, sessionId } = await setup([writeAndShell, { text: 'done' }], {
      others: () => true,
    })
    await host.submit({ sessionId, content: 'change things' })
    await waitFor(() => records(host, sessionId).length === 1)
    expect(records(host, sessionId)[0]).toMatchObject({ concurrent: true })
  })

  it('waits for a Git action from the review pane before undoing', async () => {
    const { host, recorder, project, sessionId, coordinator } = await setup([
      writeAndShell,
      { text: 'done' },
    ])
    await host.submit({ sessionId, content: 'change things' })
    await waitFor(() => records(host, sessionId).length === 1)
    let release!: () => void
    const held = coordinator.runExclusive(
      project,
      'renderer_git',
      () => new Promise<void>((done) => (release = done)),
    )
    let settled = false
    const undo = recorder.revert({ sessionId, turn: 1 }).then((result) => {
      settled = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    expect(existsSync(join(project, 'src', 'new.ts'))).toBe(true)
    release()
    await held
    expect((await undo).reverted).toContain('src/new.ts')
  })

  it('refuses to undo while an agent runs in the workspace', async () => {
    let busy = false
    const { host, recorder, sessionId } = await setup(
      [writeAndShell, { text: 'done' }],
      { busy: () => busy },
    )
    await host.submit({ sessionId, content: 'change things' })
    await waitFor(() => records(host, sessionId).length === 1)
    busy = true
    await expect(recorder.revert({ sessionId, turn: 1 })).rejects.toMatchObject(
      { code: 'workspace_agent_running' },
    )
    await expect(recorder.revert({ sessionId, turn: 7 })).rejects.toMatchObject(
      { code: 'turn_files_unavailable' },
    )
  })

  it('says a turn went unrecorded when the snapshot runs out of time', async () => {
    const { host, sessionId, project } = await setup(
      [writeAndShell, { text: 'done' }],
      { budgetMs: 0 },
    )
    await host.submit({ sessionId, content: 'change things' })
    await waitFor(() => records(host, sessionId).length === 1)
    expect(records(host, sessionId)[0]).toEqual({
      turn: 1,
      task: { firstTurn: 1, lastTurn: 1 },
      mode: 'git',
      status: 'skipped',
      skipReason: 'timeout',
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
    })
    expect(existsSync(join(project, 'shell.txt'))).toBe(true)
  })

  it('counts only the file tools outside Git', async () => {
    const { host, sessionId } = await setup(
      [
        {
          tools: [
            { name: 'write', args: { file_path: 'a.txt', content: 'a\n' } },
          ],
        },
        {
          tools: [
            { name: 'write', args: { file_path: 'a.txt', content: 'a\nb\n' } },
            {
              name: 'bash',
              args: { command: 'echo hi > shell.txt', description: 'Write' },
            },
          ],
        },
        { text: 'done' },
      ],
      { git: false },
    )
    await host.submit({ sessionId, content: 'write' })
    await waitFor(() => records(host, sessionId).length === 1)
    expect(records(host, sessionId)[0]).toEqual({
      turn: 1,
      task: { firstTurn: 1, lastTurn: 1 },
      mode: 'tools',
      status: 'recorded',
      // Created with one line, then one more: the second write adds one.
      files: [{ path: 'a.txt', status: 'added', additions: 2, deletions: 0 }],
      totals: { files: 1, additions: 2, deletions: 0 },
    })
  })

  it('forgets a session’s snapshots', async () => {
    const { host, recorder, project, sessionId } = await setup([
      writeAndShell,
      { text: 'done' },
    ])
    await host.submit({ sessionId, content: 'change things' })
    await waitFor(() => records(host, sessionId).length === 1)
    await recorder.forgetSession(sessionId)
    expect(
      git(project, 'for-each-ref', '--format=%(refname)', 'refs/emperor/'),
    ).toBe('')
  })
})

/** Answers the root from `root` and every subagent from `child`, in order. */
class RoutedAdapter implements LlmAdapter {
  constructor(
    private readonly root: () => ScriptedReply,
    private readonly child: () => ScriptedReply | Promise<ScriptedReply>,
  ) {}

  async *stream(
    _route: unknown,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    const reply = options.sessionId?.startsWith('sub-')
      ? await this.child()
      : this.root()
    if (typeof reply === 'function') {
      yield* await reply(options)
      return
    }
    if ('hang' in reply) throw new Error('no hanging replies here')
    yield* replyChunks(reply)
  }
}

function queue(
  replies: ScriptedReply[],
  fallback: ScriptedReply = { text: 'ok' },
) {
  const left = [...replies]
  return (): ScriptedReply => left.shift() ?? fallback
}

const write = (file_path: string, content = 'x\n') => ({
  name: 'write',
  args: { file_path, content },
})

/**
 * A file outside the project the test creates when a waiting command may
 * go on (no sleeps: the suite runs on a busy machine too).
 */
function gate(): { path: string; open(): void } {
  const path = join(mkdtempSync(join(tmpdir(), 'emperor-gate-')), 'open')
  return { path, open: () => writeFileSync(path, '') }
}
const after = (open: { path: string }, command: string) =>
  `while [ ! -e '${open.path}' ]; do sleep 0.05; done; ${command}`
const backgroundJob = (command: string) => ({
  name: 'bash',
  args: {
    command,
    description: 'Work in the background',
    run_in_background: true,
  },
})
const events = (host: HarnessHost, sessionId: string) =>
  host.sessionLog(sessionId)?.events ?? []
const turnEnds = (host: HarnessHost, sessionId: string) =>
  events(host, sessionId).filter((event) => event.type === 'turn/end').length
const paths = (record: TurnFilesRecord | undefined) =>
  record?.files.map((file) => `${file.status} ${file.path}`)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** A test with a scripted model, Git and background work: room to breathe. */
const SLOW = 60_000

describe('one record per task (UI-S15)', () => {
  it(
    '1 · 2 · 3 a turn its background job woke belongs to the task: no record until the task is over, then one for all of it',
    async () => {
      const job = gate()
      const { host, recorder, sessionId } = await setup([
        {
          tools: [
            write('a.txt', 'a\n'),
            backgroundJob(after(job, "printf 'j\\n' > job.txt")),
          ],
        },
        { text: 'started the job' },
        // Woken by the job's result.
        { tools: [write('b.txt', 'b\n')] },
        { text: 'all done' },
      ])
      await host.submit({
        sessionId,
        content: 'write a, then wait for the job',
      })
      // The first turn is over but its job still runs: no record yet.
      await pause(300)
      expect(turnEnds(host, sessionId)).toBe(1)
      expect(records(host, sessionId)).toEqual([])
      job.open()
      await waitFor(() => records(host, sessionId).length === 1, 30_000)
      expect(turnEnds(host, sessionId)).toBe(2)
      const [record] = records(host, sessionId)
      expect(record).toMatchObject({
        turn: 2,
        task: { firstTurn: 1, lastTurn: 2 },
        mode: 'git',
        status: 'recorded',
        totals: { files: 3, additions: 3, deletions: 0 },
      })
      // The job wrote between the turns: the task still counts it.
      expect(paths(record)).toEqual([
        'added a.txt',
        'added b.txt',
        'added job.txt',
      ])
      // 4 · 查看变更 covers the whole task, the first turn's file too.
      expect(
        (await recorder.diff({ sessionId, turn: 2, path: 'a.txt' })).diff,
      ).toContain('+a')
      await pause(200)
      expect(records(host, sessionId)).toHaveLength(1)
    },
    SLOW,
  )

  it(
    '1 · 3 a background subagent’s writes after the root’s turn ended count in the task',
    async () => {
      let release!: () => void
      const released = new Promise<void>((done) => (release = done))
      const adapter = new RoutedAdapter(
        queue([
          {
            tools: [
              {
                name: 'subagent',
                args: { description: 'writer', prompt: 'write the chapter' },
              },
            ],
          },
          { text: 'waiting for the writer' },
          // Woken by the subagent's result.
          { text: 'the chapter is in' },
        ]),
        (() => {
          const replies = queue([
            { tools: [write('chapter.md', '# One\n\nText\n')] },
            { text: 'written' },
          ])
          return async () => {
            await released
            return replies()
          }
        })(),
      )
      const { host, sessionId } = await setup([], { adapter })
      await host.submit({
        sessionId,
        content: 'have a subagent write a chapter',
      })
      expect(records(host, sessionId)).toEqual([])
      release()
      await waitFor(() => records(host, sessionId).length === 1, 30_000)
      const [record] = records(host, sessionId)
      expect(record).toMatchObject({
        turn: 2,
        task: { firstTurn: 1, lastTurn: 2 },
        totals: { files: 1, additions: 3, deletions: 0 },
      })
      expect(paths(record)).toEqual(['added chapter.md'])
    },
    SLOW,
  )

  it(
    '1 · a message inserted while the task runs does not start a task',
    async () => {
      const shell = gate()
      const { host, sessionId } = await setup([
        {
          tools: [
            write('a.txt'),
            {
              name: 'bash',
              args: { command: after(shell, 'true'), description: 'Wait' },
            },
          ],
        },
        { tools: [write('b.txt')] },
        { text: 'did both' },
      ])
      const first = host.submit({ sessionId, content: 'write a' })
      await waitFor(
        () =>
          events(host, sessionId).some(
            (event) => event.type === 'tool/call' && event.data.name === 'bash',
          ),
        30_000,
      )
      await host.submit({
        sessionId,
        content: 'also write b',
        delivery: 'interject',
      })
      shell.open()
      await first
      await waitFor(() => records(host, sessionId).length === 1, 30_000)
      await pause(200)
      expect(records(host, sessionId)).toHaveLength(1)
      expect(records(host, sessionId)[0]).toMatchObject({
        turn: 1,
        task: { firstTurn: 1, lastTurn: 1 },
      })
      expect(paths(records(host, sessionId)[0])).toEqual([
        'added a.txt',
        'added b.txt',
      ])
    },
    SLOW,
  )

  it(
    '1 · a new message ends the running task, even while its job still runs; the job’s wake belongs to the new task',
    async () => {
      const job = gate()
      const { host, project, sessionId } = await setup([
        {
          tools: [
            write('a.txt'),
            backgroundJob(after(job, "printf 'late\\n' > late.txt")),
          ],
        },
        { text: 'started' },
        // The user's next message: a new task.
        { tools: [write('c.txt')] },
        { text: 'wrote c' },
        // Woken by the first task's job, inside the second task.
        { text: 'the job finished' },
      ])
      await host.submit({ sessionId, content: 'write a and start the job' })
      await host.submit({ sessionId, content: 'now write c' })
      // The first task was recorded when the second began, its job waiting.
      await waitFor(() => records(host, sessionId).length >= 1, 30_000)
      expect(existsSync(join(project, 'late.txt'))).toBe(false)
      expect(records(host, sessionId)[0]).toMatchObject({
        turn: 1,
        task: { firstTurn: 1, lastTurn: 1 },
      })
      expect(paths(records(host, sessionId)[0])).toEqual(['added a.txt'])
      // The second task waits for the job, which wakes it once more.
      await pause(200)
      expect(records(host, sessionId)).toHaveLength(1)
      job.open()
      await waitFor(() => records(host, sessionId).length === 2, 30_000)
      expect(records(host, sessionId)[1]).toMatchObject({
        turn: 3,
        task: { firstTurn: 2, lastTurn: 3 },
      })
      expect(paths(records(host, sessionId)[1])).toEqual([
        'added c.txt',
        'added late.txt',
      ])
    },
    SLOW,
  )

  it(
    '1 · a goal’s rounds go on as one task, recorded once the goal stops',
    async () => {
      const { host, sessionId } = await setup([
        { tools: [write('round-1.txt')] },
        { text: 'round 1 done' },
        { tools: [write('round-2.txt')] },
        { text: 'round 2 done' },
      ])
      const agent = host.agentFor(sessionId)
      host.goals.create(agent, {
        objective: 'write two files',
        maxGoalRounds: 2,
      })
      await waitFor(
        () =>
          events(host, sessionId).filter((event) => event.type === 'goal/round')
            .length === 2,
        30_000,
      )
      await waitFor(() => records(host, sessionId).length === 1, 30_000)
      await pause(200)
      expect(records(host, sessionId)).toHaveLength(1)
      expect(records(host, sessionId)[0]).toMatchObject({
        turn: 2,
        task: { firstTurn: 1, lastTurn: 2 },
      })
      expect(paths(records(host, sessionId)[0])).toEqual([
        'added round-1.txt',
        'added round-2.txt',
      ])
    },
    SLOW,
  )

  it(
    '5 · 撤销 puts the whole task back and skips a file changed since',
    async () => {
      const job = gate()
      const { host, recorder, project, sessionId } = await setup([
        {
          tools: [
            write('a.txt', 'a\n'),
            backgroundJob(after(job, "printf 'j\\n' > job.txt")),
          ],
        },
        { text: 'started' },
        { tools: [write('b.txt', 'b\n')] },
        { text: 'done' },
      ])
      await host.submit({ sessionId, content: 'go' })
      job.open()
      await waitFor(() => records(host, sessionId).length === 1, 30_000)
      writeFileSync(join(project, 'b.txt'), 'the user kept this\n')
      const result = await recorder.revert({ sessionId, turn: 2 })
      expect(result).toEqual({
        turn: 2,
        reverted: ['a.txt', 'job.txt'],
        skipped: [{ path: 'b.txt', reason: 'changed-since' }],
      })
      expect(existsSync(join(project, 'a.txt'))).toBe(false)
      expect(existsSync(join(project, 'job.txt'))).toBe(false)
      expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe(
        'the user kept this\n',
      )
    },
    SLOW,
  )

  it(
    '7 · outside Git, the file tools of every turn of the task make one record',
    async () => {
      const job = gate()
      const { host, sessionId } = await setup(
        [
          {
            tools: [
              write('a.txt', 'a\n'),
              backgroundJob(after(job, "printf 'j\\n' > job.txt")),
            ],
          },
          { text: 'started' },
          { tools: [write('a.txt', 'a\nmore\n'), write('c.txt', 'c\n')] },
          { text: 'done' },
        ],
        { git: false },
      )
      await host.submit({ sessionId, content: 'go' })
      await pause(300)
      expect(records(host, sessionId)).toEqual([])
      job.open()
      await waitFor(() => records(host, sessionId).length === 1, 30_000)
      expect(records(host, sessionId)[0]).toEqual({
        turn: 2,
        task: { firstTurn: 1, lastTurn: 2 },
        mode: 'tools',
        status: 'recorded',
        files: [
          { path: 'a.txt', status: 'added', additions: 2, deletions: 0 },
          { path: 'c.txt', status: 'added', additions: 1, deletions: 0 },
        ],
        totals: { files: 2, additions: 3, deletions: 0 },
      })
    },
    SLOW,
  )
})

/** The event types of a session's log, from a fresh read of its file. */
function logged(host: HarnessHost, sessionId: string, type: string) {
  return (host.sessionLog(sessionId)?.events ?? []).filter(
    (event) => event.type === type,
  )
}

describe('a task cut short by quitting or a crash (UI-S15)', () => {
  it(
    'logs where the task began, with its snapshot held under a ref, at its first write',
    async () => {
      const job = gate()
      const { host, project, sessionId } = await setup([
        {
          tools: [
            write('a.txt', 'a\n'),
            backgroundJob(after(job, "printf 'j\\n' > job.txt")),
          ],
        },
        { text: 'started' },
        { text: 'done' },
      ])
      await host.submit({ sessionId, content: 'go' })
      const [started] = logged(host, sessionId, 'task/started')
      expect(started?.data).toMatchObject({
        firstTurn: 1,
        mode: 'git',
        before: { commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
      })
      expect(
        git(project, 'for-each-ref', '--format=%(refname)', 'refs/emperor/'),
      ).toBe(`refs/emperor/turns/${sessionId}/1/before`)
      job.open()
      await waitFor(() => records(host, sessionId).length === 1, 30_000)
      await waitFor(() => logged(host, sessionId, 'task/ended').length === 1)
      expect(logged(host, sessionId, 'task/ended')[0]?.data).toEqual({
        firstTurn: 1,
        lastTurn: 2,
      })
      // The held ref gave way to the record's pair.
      expect(
        git(project, 'for-each-ref', '--format=%(refname)', 'refs/emperor/'),
      ).toBe(
        [
          `refs/emperor/turns/${sessionId}/2/after`,
          `refs/emperor/turns/${sessionId}/2/before`,
        ].join('\n'),
      )
    },
    SLOW,
  )

  it(
    'quitting mid-task records it as if it had gone quiet',
    async () => {
      const job = gate()
      const { host, root, project, sessionId } = await setup([
        {
          tools: [
            write('a.txt', 'a\n'),
            backgroundJob(after(job, "printf 'j\\n' > job.txt")),
          ],
        },
        { text: 'started the job' },
      ])
      await host.submit({ sessionId, content: 'write a and start the job' })
      expect(records(host, sessionId)).toEqual([])
      // Quit while the job still runs (it is stopped with the host).
      await host.close()
      const reopened = await startHost(root, project, [], {}, sessionId)
      const reopenedLog = reopened.host.sessionLog(sessionId)!
      await pause(300)
      const recorded = reopenedLog.events.filter(
        (event) => event.type === 'turn/files',
      )
      expect(recorded.map((event) => event.data)).toMatchObject([
        { turn: 1, task: { firstTurn: 1, lastTurn: 1 }, mode: 'git' },
      ])
      expect(recorded[0]?.data).not.toHaveProperty('recovered')
      expect(paths(recorded[0]?.data as TurnFilesRecord)).toEqual([
        'added a.txt',
      ])
      expect(
        reopenedLog.events.filter((event) => event.type === 'task/ended'),
      ).toHaveLength(1)
      // Undo still works after the restart.
      const result = await reopened.recorder.revert({ sessionId, turn: 1 })
      expect(result.reverted).toEqual(['a.txt'])
      expect(existsSync(join(project, 'a.txt'))).toBe(false)
    },
    SLOW,
  )

  it(
    'a crash mid-task gets its record when the session is next opened, outside changes included',
    async () => {
      const job = gate()
      const first = await setup(
        [
          {
            tools: [
              write('a.txt', 'a\n'),
              backgroundJob(after(job, "printf 'j\\n' > job.txt")),
            ],
          },
          { text: 'started the job' },
        ],
        { wiring: 'install' },
      )
      await first.host.submit({ sessionId: first.sessionId, content: 'go' })
      // A crash: nothing closes the task; the log keeps task/started alone.
      await first.host.close()
      // Meanwhile the user changes the project outside Emperor.
      writeFileSync(join(first.project, 'outside.txt'), 'by hand\n')
      const reopened = await startHost(
        first.root,
        first.project,
        [],
        {},
        first.sessionId,
      )
      const log = () => reopened.host.sessionLog(first.sessionId)!.events
      expect(log().some((event) => event.type === 'task/started')).toBe(true)
      await waitFor(
        () => log().some((event) => event.type === 'task/ended'),
        30_000,
      )
      const recorded = log()
        .filter((event) => event.type === 'turn/files')
        .map((event) => event.data as TurnFilesRecord)
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({
        turn: 1,
        task: { firstTurn: 1, lastTurn: 1 },
        mode: 'git',
        status: 'recorded',
        recovered: true,
      })
      expect(paths(recorded[0])).toEqual(['added a.txt', 'added outside.txt'])
      const undone = await reopened.recorder.revert({
        sessionId: first.sessionId,
        turn: 1,
      })
      expect(undone.reverted).toEqual(['a.txt', 'outside.txt'])
      // Opening it again records nothing more.
      reopened.host.sessions.close(first.sessionId)
      const again = await startHost(
        first.root,
        first.project,
        [],
        {},
        first.sessionId,
      )
      await pause(300)
      const events = again.host.sessionLog(first.sessionId)!.events
      expect(
        events.filter((event) => event.type === 'turn/files'),
      ).toHaveLength(1)
      expect(
        events.filter((event) => event.type === 'task/ended'),
      ).toHaveLength(1)
    },
    SLOW,
  )

  it(
    'a crash in the middle of a turn: crash repair closes the turn, the task is recorded under it',
    async () => {
      const first = await setup(
        [{ tools: [write('a.txt', 'a\n')] }, { hang: true }],
        { wiring: 'install' },
      )
      void first.host
        .submit({ sessionId: first.sessionId, content: 'go' })
        .catch(() => undefined)
      await waitFor(
        () =>
          logged(first.host, first.sessionId, 'task/started').length === 1 &&
          existsSync(join(first.project, 'a.txt')),
        30_000,
      )
      // The process dies: the log on disk stops here, the turn still open.
      first.host.sessions.close(first.sessionId)
      await first.host.close()
      const reopened = await startHost(
        first.root,
        first.project,
        [],
        {},
        first.sessionId,
      )
      const log = () => reopened.host.sessionLog(first.sessionId)!.events
      await waitFor(
        () => log().some((event) => event.type === 'task/ended'),
        30_000,
      )
      const turnEnd = log().find((event) => event.type === 'turn/end')
      expect(turnEnd?.data).toMatchObject({
        turn: 1,
        reason: { kind: 'interrupted' },
      })
      const recorded = log().filter((event) => event.type === 'turn/files')
      expect(recorded.map((event) => event.data)).toMatchObject([
        { turn: 1, task: { firstTurn: 1, lastTurn: 1 }, recovered: true },
      ])
      expect(recorded[0]!.seq).toBeGreaterThan(turnEnd!.seq)
    },
    SLOW,
  )

  it(
    'outside Git, the file tools written before a crash are rebuilt from the log',
    async () => {
      const job = gate()
      const first = await setup(
        [
          {
            tools: [
              write('a.txt', 'a\n'),
              write('b.txt', 'b\nb\n'),
              backgroundJob(after(job, 'true')),
            ],
          },
          { text: 'started' },
        ],
        { git: false, wiring: 'install' },
      )
      await first.host.submit({ sessionId: first.sessionId, content: 'go' })
      expect(
        logged(first.host, first.sessionId, 'task/tool-write').map(
          (event) => event.data,
        ),
      ).toEqual([
        { firstTurn: 1, path: 'a.txt', created: true, added: 1, removed: 0 },
        { firstTurn: 1, path: 'b.txt', created: true, added: 2, removed: 0 },
      ])
      await first.host.close()
      const reopened = await startHost(
        first.root,
        first.project,
        [],
        { git: false },
        first.sessionId,
      )
      const log = () => reopened.host.sessionLog(first.sessionId)!.events
      await waitFor(
        () => log().some((event) => event.type === 'task/ended'),
        30_000,
      )
      expect(
        log()
          .filter((event) => event.type === 'turn/files')
          .map((event) => event.data),
      ).toEqual([
        {
          turn: 1,
          task: { firstTurn: 1, lastTurn: 1 },
          mode: 'tools',
          status: 'recorded',
          files: [
            { path: 'a.txt', status: 'added', additions: 1, deletions: 0 },
            { path: 'b.txt', status: 'added', additions: 2, deletions: 0 },
          ],
          totals: { files: 2, additions: 3, deletions: 0 },
        },
      ])
    },
    SLOW,
  )

  it(
    'an older log without the event opens as before',
    async () => {
      const first = await setup([{ text: 'just talking' }], {
        wiring: 'install',
      })
      await first.host.submit({ sessionId: first.sessionId, content: 'hi' })
      const log = first.host.sessionLog(first.sessionId)!
      // A record from before UI-S15: one turn, no task, no task/started.
      ;(log.append as (type: string, data: unknown) => void).call(
        log,
        'turn/files',
        {
          turn: 7,
          mode: 'git',
          status: 'recorded',
          files: [{ path: 'x', status: 'added', additions: 1, deletions: 0 }],
          totals: { files: 1, additions: 1, deletions: 0 },
        },
      )
      await first.host.close()
      const reopened = await startHost(
        first.root,
        first.project,
        [],
        {},
        first.sessionId,
      )
      const before = reopened.host.sessionLog(first.sessionId)!.events.length
      await pause(300)
      const events = reopened.host.sessionLog(first.sessionId)!.events
      expect(events).toHaveLength(before)
      expect(events.some((event) => event.type === 'task/started')).toBe(false)
    },
    SLOW,
  )
})

describe('calls that write the project (AGT-06)', () => {
  it('counts collect_agent with apply as a write, so the turn card can undo an apply', () => {
    expect(
      callMayWriteFiles({ name: 'collect_agent', arguments: { apply: true } }),
    ).toBe(true)
    expect(callMayWriteFiles({ name: 'collect_agent', arguments: {} })).toBe(
      false,
    )
    expect(callMayWriteFiles({ name: 'edit', arguments: {} })).toBe(true)
    expect(callMayWriteFiles({ name: 'read', arguments: {} })).toBe(false)
  })
})
