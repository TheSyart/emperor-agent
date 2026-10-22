// KRN-11 (PLAN-V020, finding CORE-8): a Build session that enters a managed
// worktree works there — bash, the file tools, the sandbox's writable root,
// the turn's file record and 审查 all follow it; the model is told; leaving
// the worktree moves everything back; a restart keeps the session in it.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScriptedReply } from '../harness/testing'
import type { CoreApi } from './core-api'
import { makeApi, tmp, waitFor, type ApiFixture } from './test-helpers'

const fixtures: ApiFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0))
    await fixture.api.close().catch(() => {})
})

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
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

function repository(): string {
  const root = realpathSync(tmp('emperor-krn11-repo-'))
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'base')
  return root
}

const bash = (command: string): ScriptedReply => ({
  tools: [{ name: 'bash', args: { command, description: 'Show the cwd' } }],
})
const write = (file_path: string, content: string): ScriptedReply => ({
  tools: [{ name: 'write', args: { file_path, content } }],
})

async function setup(
  replies: ScriptedReply[],
  options: { stateRoot?: string; root?: string; repo?: string } = {},
) {
  const fixture = await makeApi({
    replies,
    ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
    ...(options.root ? { root: options.root } : {}),
  })
  fixtures.push(fixture)
  const repo = options.repo ?? repository()
  return { ...fixture, repo }
}

function buildSession(api: CoreApi, repo: string): string {
  return String(
    api.sessions.create({ title: 'KRN-11', mode: 'build', project_path: repo })
      .id,
  )
}

async function enter(api: CoreApi, sessionId: string, name = 'feature') {
  const { revision } = await api.git.status({ sessionId })
  const { worktree } = await api.git.enterWorktree({
    sessionId,
    name,
    expectedRevision: revision,
    confirmed: true,
  })
  return realpathSync(worktree.path)
}

async function exit(api: CoreApi, sessionId: string) {
  const { revision } = await api.git.status({ sessionId })
  await api.git.exitWorktree({
    sessionId,
    action: 'keep',
    discardChanges: false,
    expectedRevision: revision,
    confirmed: true,
  })
}

/** Text of the last tool result of the session. */
function lastToolResult(api: CoreApi, sessionId: string): string {
  const events = api.host.sessionLog(sessionId)!.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'tool/result')
      return JSON.stringify(event.data.message.content)
  }
  throw new Error('no tool result')
}

function cwdChanges(api: CoreApi, sessionId: string) {
  return api.host
    .sessionLog(sessionId)!
    .events.filter((event) => event.type === 'working-directory/change')
    .map((event) => event.data)
}

// Real git, worktrees and turns: seconds per case, more under a full run.
describe(
  'a session in a managed worktree (KRN-11)',
  { timeout: 60_000 },
  () => {
    it('1 · bash runs in the worktree once the session entered it', async () => {
      const { api, repo } = await setup([
        bash('pwd'),
        { text: 'before' },
        bash('pwd'),
        { text: 'after' },
      ])
      const sessionId = buildSession(api, repo)
      await api.chat.submit({ sessionId, content: 'where?' })
      expect(lastToolResult(api, sessionId)).toContain(repo)

      const worktree = await enter(api, sessionId)
      expect(worktree).not.toBe(repo)
      expect(cwdChanges(api, sessionId)).toEqual([
        { from: repo, to: worktree, reason: 'worktree-enter' },
      ])
      await api.chat.submit({ sessionId, content: 'and now?' })
      expect(lastToolResult(api, sessionId)).toContain(worktree)
    })

    it('2 · the write tool writes inside the worktree', async () => {
      const { api, repo } = await setup([
        { text: 'ready' },
        write('notes/plan.md', '# Plan\n'),
        { text: 'written' },
      ])
      const sessionId = buildSession(api, repo)
      await api.chat.submit({ sessionId, content: 'hi' })
      const worktree = await enter(api, sessionId)
      await api.chat.submit({ sessionId, content: 'write the plan' })
      expect(readFileSync(join(worktree, 'notes/plan.md'), 'utf8')).toBe(
        '# Plan\n',
      )
      expect(existsSync(join(repo, 'notes/plan.md'))).toBe(false)
    })

    it('3 · writing into the original checkout is refused by the sandbox', async () => {
      const original = repository()
      const target = join(original, 'escaped.md')
      const { api, repo, stateRoot } = await setup(
        [write(target, 'x\n'), { text: 'tried' }],
        { repo: original },
      )
      const sessionId = buildSession(api, repo)
      const worktree = await enter(api, sessionId)
      // The temp folder is writable in workspace-write, and the fixture repo
      // lives there; a real project does not, so move it out of the way.
      const previous = process.env.TMPDIR
      const elsewhere = join(stateRoot, 'private-tmp')
      mkdirSync(elsewhere, { recursive: true })
      process.env.TMPDIR = elsewhere
      try {
        await api.chat.submit({ sessionId, content: 'write outside' })
      } finally {
        if (previous === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = previous
      }
      expect(existsSync(target)).toBe(false)
      expect(lastToolResult(api, sessionId)).toMatch(/sandbox/i)
      const agent = api.host.agentFor(sessionId)
      expect(
        realpathSync(
          api.host.sandbox.resolve({ session: agent.session }).workspaceRoot,
        ),
      ).toBe(worktree)
    })

    it('4 · the turn’s file record covers the worktree, and undo works', async () => {
      const { api, repo } = await setup([
        { text: 'ready' },
        write('CHANGES.md', 'made in the worktree\n'),
        { text: 'done' },
      ])
      const sessionId = buildSession(api, repo)
      await api.chat.submit({ sessionId, content: 'hi' })
      const worktree = await enter(api, sessionId)
      await api.chat.submit({ sessionId, content: 'add a changelog' })
      const records = () =>
        api.host
          .sessionLog(sessionId)!
          .events.filter((event) => event.type === 'turn/files')
      // The record is written after the turn ends; a busy machine takes longer.
      await waitFor(() => records().length > 0, 30_000)
      const record = records().at(-1)!.data as {
        turn: number
        mode: string
        status: string
        files: Array<{ path: string; status: string }>
      }
      expect(record).toMatchObject({ mode: 'git', status: 'recorded' })
      expect(record.files).toEqual([
        expect.objectContaining({ path: 'CHANGES.md', status: 'added' }),
      ])
      expect(existsSync(join(worktree, 'CHANGES.md'))).toBe(true)
      expect(existsSync(join(repo, 'CHANGES.md'))).toBe(false)

      await api.workspace.revertTurn({ sessionId, turn: record.turn })
      expect(existsSync(join(worktree, 'CHANGES.md'))).toBe(false)
    })

    it('5 · 审查 lists the same changes', async () => {
      const { api, repo } = await setup([
        { text: 'ready' },
        write('src/new.ts', 'export {}\n'),
        { text: 'done' },
      ])
      const sessionId = buildSession(api, repo)
      await api.chat.submit({ sessionId, content: 'hi' })
      await enter(api, sessionId)
      await api.chat.submit({ sessionId, content: 'add a file' })
      const status = await api.git.status({ sessionId })
      expect(JSON.stringify(status)).toContain('src/new.ts')
      expect(git(repo, 'status', '--porcelain')).toBe('')
    })

    it('6 · the model is told its working directory changed', async () => {
      const { api, repo, adapter } = await setup([
        { text: 'one' },
        { text: 'two' },
      ])
      const sessionId = buildSession(api, repo)
      await api.chat.submit({ sessionId, content: 'first' })
      const worktree = await enter(api, sessionId)
      await api.chat.submit({ sessionId, content: 'second' })
      const request = adapter.requests.filter(
        (item) => item.purpose !== 'session-title',
      )
      // The runtime-context snapshot is plain text inside the request.
      const texts = JSON.stringify(request.at(-1)!.messages)
      const inText = (value: string) => JSON.stringify(value).slice(1, -1)
      expect(texts).toContain(
        inText(`Working directory: ${JSON.stringify(worktree)}`),
      )
      expect(texts).toContain('managed git worktree')
      expect(texts).toContain(inText(JSON.stringify(repo)))
      // The first request still named the checkout.
      expect(JSON.stringify(request[0]!.messages)).toContain(
        inText(`Working directory: ${JSON.stringify(repo)}`),
      )
    })

    it('7 · leaving the worktree moves the session back', async () => {
      const { api, repo } = await setup([
        { text: 'ready' },
        bash('pwd'),
        { text: 'back' },
      ])
      const sessionId = buildSession(api, repo)
      await api.chat.submit({ sessionId, content: 'hi' })
      const worktree = await enter(api, sessionId)
      await exit(api, sessionId)
      expect(cwdChanges(api, sessionId)).toEqual([
        { from: repo, to: worktree, reason: 'worktree-enter' },
        { from: worktree, to: repo, reason: 'worktree-exit' },
      ])
      await api.chat.submit({ sessionId, content: 'where now?' })
      const pwd = lastToolResult(api, sessionId)
      expect(pwd).toContain(repo)
      expect(pwd).not.toContain(worktree)
    })

    it('8 · after a restart the session is still in the worktree', async () => {
      const first = await setup([{ text: 'ready' }])
      const sessionId = buildSession(first.api, first.repo)
      await first.api.chat.submit({ sessionId, content: 'hi' })
      const worktree = await enter(first.api, sessionId)
      await first.api.close()
      fixtures.splice(fixtures.indexOf(first), 1)

      const second = await setup([bash('pwd'), { text: 'still there' }], {
        root: first.root,
        stateRoot: first.stateRoot,
        repo: first.repo,
      })
      await second.api.chat.submit({ sessionId, content: 'where?' })
      expect(lastToolResult(second.api, sessionId)).toContain(worktree)
      expect(
        realpathSync(second.api.host.sessionWorkspaceRoot(sessionId)),
      ).toBe(worktree)
    })

    it('a session that enters before its first turn starts in the worktree', async () => {
      const { api, repo } = await setup([bash('pwd'), { text: 'here' }])
      const sessionId = buildSession(api, repo)
      const worktree = await enter(api, sessionId)
      await api.chat.submit({ sessionId, content: 'where?' })
      expect(lastToolResult(api, sessionId)).toContain(worktree)
    })

    it('a Chat session and a Build session outside a worktree log no change', async () => {
      const { api, repo } = await setup([{ text: 'a' }, { text: 'b' }])
      const build = buildSession(api, repo)
      const chat = String(api.sessions.create({ title: 'chat' }).id)
      await api.chat.submit({ sessionId: build, content: 'x' })
      await api.chat.submit({ sessionId: chat, content: 'y' })
      expect(cwdChanges(api, build)).toEqual([])
      expect(cwdChanges(api, chat)).toEqual([])
      expect(api.host.sessionWorkspaceRoot(build)).toBe(repo)
    })
  },
)
