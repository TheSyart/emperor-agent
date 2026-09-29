// Per-turn file records on a real HarnessHost with a scripted model and a
// real Git project: the before snapshot waits for the first write, the
// turn's end lists the files (file tools and the shell alike), read-only
// turns record nothing, undo restores and is recorded once, and a project
// outside Git counts the file tools only.
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
import { LlmClient } from '../../llm/client'
import { HardenedGitRunner } from '../../workspace/git-runner'
import { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
import { TurnSnapshots } from '../../workspace/turn-snapshots'
import type { SandboxBackend } from '../sandbox/backend'
import { ScriptedAdapter, testRoute, type ScriptedReply } from '../testing'
import { HarnessHost } from './host'
import { TurnFileRecorder, type TurnFilesRecord } from './turn-files'

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

async function setup(
  replies: ScriptedReply[],
  options: {
    git?: boolean
    budgetMs?: number
    busy?: () => boolean
    others?: () => boolean
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-turn-files-')))
  const project = options.git === false ? join(root, 'plain') : gitProject(root)
  mkdirSync(project, { recursive: true })
  const adapter = new ScriptedAdapter(replies)
  const llm = new LlmClient({ adapterFor: () => adapter })
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
  const entry = host.kept.sessionStore.create('t', {
    mode: 'build',
    project: { project_path: project },
  })
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
    projectRoot: (sessionId) => (sessionId === entry.id ? project : null),
    workspaceRoot: (sessionId) => host.sessionWorkspaceRoot(sessionId),
    rootOf: (agent) => host.rootOf(agent),
    sessionLog: (sessionId) => host.sessionLog(sessionId),
    workspaceBusy: options.busy ?? (() => false),
    ...(options.others === undefined ? {} : { othersRunning: options.others }),
    runExclusive: (workspace, owner, action) =>
      coordinator.runExclusive(workspace, owner, action),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
  })
  recorder.install(host)
  return { host, adapter, recorder, project, coordinator, sessionId: entry.id }
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
