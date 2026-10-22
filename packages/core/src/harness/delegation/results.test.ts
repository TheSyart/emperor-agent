/**
 * AGT-06 card tests at the service layer, over a real Git repository (or a
 * plain folder) with a scripted executor: the result a finished run leaves
 * (4), applying it as a three-way merge with undo (5), conflicts (6), a
 * folder outside Git (8), lease waits (9), cleanup (10), a stop that never
 * hangs on a workspace wait (11) and the 14-day cleanup prompt (12).
 */
import { afterEach, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resultsFixture, waitsForStop, writes } from './results-test-fixture'
import { workspaceMutationDomain } from '../../workspace/mutation-coordinator'
import {
  RESULT_CLEANUP_AFTER_MS,
  resultNeedsCleanup,
} from '../../runtime/agent-view'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
function fixture(input: Parameters<typeof resultsFixture>[0] = {}) {
  const f = resultsFixture(input)
  cleanups.push(async () => {
    await f.service.shutdown()
    f.cleanup()
  })
  return f
}
const CHILD_EDIT = {
  'src/a.txt': 'one\ntwo\nthree\nfour\nfive\n',
  'src/new.ts': 'export const n = 1\n',
}

it('4 · a finished write run leaves a result: files, lines added and removed, still unapplied', async () => {
  const f = fixture({
    script: writes({ ...CHILD_EDIT, 'README.md': null }),
  })
  const record = await f.start()
  const run = await f.settle(record.id)
  expect(run.phase).toBe('completed')
  const result = f.service.inspect(record.id).runs[run.id]!.result!
  expect(result).toMatchObject({
    state: 'ready',
    totals: { files: 3, additions: 3, deletions: 1 },
  })
  expect(result.files.map((file) => [file.path, file.status])).toEqual([
    ['README.md', 'deleted'],
    ['src/a.txt', 'modified'],
    ['src/new.ts', 'added'],
  ])
  // Nothing reached the project yet.
  expect(readFileSync(join(f.repo, 'src', 'a.txt'), 'utf8')).toBe(
    'one\ntwo\nthree\n',
  )
  // The parent hears about the result in the settlement notice.
  const notice = Object.values(f.service.inspect(record.id).outbox)[0]!
  expect(notice.text).toContain('3 files')
  expect(notice.text).toContain('apply')
})

it('5 · applying merges the result into the current workspace, keeping the user edits made meanwhile, and can be undone', async () => {
  const f = fixture({ script: writes(CHILD_EDIT) })
  const record = await f.start()
  const run = await f.settle(record.id)
  // The user kept working on another file after the dispatch.
  writeFileSync(join(f.repo, 'README.md'), 'readme, edited by the user\n')
  const applied = await f.service.applyResult(record.id, run.id, 'user')
  expect(applied).toMatchObject({ state: 'applied', by: 'user' })
  expect(readFileSync(join(f.repo, 'src', 'a.txt'), 'utf8')).toBe(
    CHILD_EDIT['src/a.txt'],
  )
  expect(readFileSync(join(f.repo, 'src', 'new.ts'), 'utf8')).toBe(
    CHILD_EDIT['src/new.ts'],
  )
  expect(readFileSync(join(f.repo, 'README.md'), 'utf8')).toBe(
    'readme, edited by the user\n',
  )
  expect(applied.undo).toBeDefined()
  const undone = await f.service.undoResult(record.id, run.id)
  expect(undone.state).toBe('reverted')
  expect(undone.reverted?.reverted.sort()).toEqual(['src/a.txt', 'src/new.ts'])
  expect(readFileSync(join(f.repo, 'src', 'a.txt'), 'utf8')).toBe(
    'one\ntwo\nthree\n',
  )
  expect(existsSync(join(f.repo, 'src', 'new.ts'))).toBe(false)
  expect(readFileSync(join(f.repo, 'README.md'), 'utf8')).toBe(
    'readme, edited by the user\n',
  )
})

it('5 · a text file both sides changed in different places merges cleanly', async () => {
  const f = fixture({
    script: writes({ 'src/a.txt': 'one\ntwo\nthree\nchild line\n' }),
  })
  const record = await f.start()
  const run = await f.settle(record.id)
  writeFileSync(join(f.repo, 'src', 'a.txt'), 'user line\none\ntwo\nthree\n')
  const applied = await f.service.applyResult(record.id, run.id, 'user')
  expect(applied.state).toBe('applied')
  expect(readFileSync(join(f.repo, 'src', 'a.txt'), 'utf8')).toBe(
    'user line\none\ntwo\nthree\nchild line\n',
  )
})

it('6 · a conflict lists the conflicting files, writes nothing and keeps the result', async () => {
  const f = fixture({ script: writes(CHILD_EDIT) })
  const record = await f.start()
  const run = await f.settle(record.id)
  writeFileSync(join(f.repo, 'src', 'a.txt'), 'the user rewrote this\n')
  const outcome = await f.service.applyResult(record.id, run.id, 'user')
  expect(outcome).toMatchObject({
    state: 'conflicted',
    conflicts: ['src/a.txt'],
  })
  expect(readFileSync(join(f.repo, 'src', 'a.txt'), 'utf8')).toBe(
    'the user rewrote this\n',
  )
  expect(existsSync(join(f.repo, 'src', 'new.ts'))).toBe(false)
  const lease = f.workspaces.get(
    f.service.inspect(record.id).record!.workspaceLeaseId,
  )
  expect(existsSync(lease.path)).toBe(true)
  expect(f.git('for-each-ref', 'refs/emperor/delegations/')).not.toBe('')
  // Once the user resolves it, applying again works.
  writeFileSync(join(f.repo, 'src', 'a.txt'), 'one\ntwo\nthree\n')
  expect((await f.service.applyResult(record.id, run.id, 'user')).state).toBe(
    'applied',
  )
})

it('8 · a write task in a folder outside Git runs in a copy, never blocks the main session, and applies back', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture({ kind: 'folder', script: writes(CHILD_EDIT, gate) })
  const record = await f.start()
  await f.reachesExecutor(record.id)
  expect(f.service.inspect(record.id).record!.workspaceLeaseId).not.toBe('')
  const cwd = f.service.inspect(record.id).record!.cwd
  expect(cwd).not.toBe(f.repo)
  // While the child works, a main-session write in the folder goes ahead.
  const main = await Promise.race([
    f.mutations.resources.acquire({
      keys: [workspaceMutationDomain(f.repo)],
      mode: 'exclusive',
      owner: 'main-write',
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
  ])
  expect(main).not.toBeNull()
  main?.release()
  release()
  const run = await f.settle(record.id)
  expect(readFileSync(join(f.repo, 'src', 'a.txt'), 'utf8')).toBe(
    'one\ntwo\nthree\n',
  )
  const applied = await f.service.applyResult(record.id, run.id, 'user')
  expect(applied.state).toBe('applied')
  expect(readFileSync(join(f.repo, 'src', 'new.ts'), 'utf8')).toBe(
    CHILD_EDIT['src/new.ts'],
  )
})

it('9 · a main-session write waiting on an exclusive child is told who holds the workspace after the notice delay, and stopping the child lets it go on', async () => {
  const f = fixture({ script: waitsForStop })
  const record = await f.start({ workspace: 'shared-exclusive' })
  await f.reachesExecutor(record.id)
  expect(f.mutations.hasActiveWriter(f.repo)).toBe(true)
  const notices: string[][] = []
  let ended = 0
  let noticed!: () => void
  const notice = new Promise<void>((resolve) => {
    noticed = resolve
  })
  const waiting = f.mutations.acquireWriterWithNotice(f.repo, 'call-write', {
    noticeMs: 50,
    onWait: (blockers) => {
      notices.push(blockers)
      noticed()
      return () => {
        ended++
      }
    },
  })
  await notice
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain(record.id)
  // 「停止它」
  await f.service.interrupt(record.id, record.currentRunId!)
  const lease = await waiting
  expect(ended).toBe(1)
  lease.release()
})

it('9 · the main session can stop waiting for the workspace', async () => {
  const f = fixture({ script: waitsForStop })
  const record = await f.start({ workspace: 'shared-exclusive' })
  await f.reachesExecutor(record.id)
  expect(f.mutations.hasActiveWriter(f.repo)).toBe(true)
  const stop = new AbortController()
  const waiting = f.mutations.acquireWriterWithNotice(f.repo, 'call-write', {
    signal: stop.signal,
  })
  stop.abort()
  await expect(waiting).rejects.toThrow()
  await f.service.interrupt(record.id, record.currentRunId!)
})

it('10 · applying deletes the result worktree and its private refs', async () => {
  const f = fixture({ script: writes(CHILD_EDIT) })
  const record = await f.start()
  const run = await f.settle(record.id)
  const lease = f.workspaces.get(
    record.id ? f.service.inspect(record.id).record!.workspaceLeaseId : '',
  )
  expect(existsSync(lease.path)).toBe(true)
  expect(f.git('for-each-ref', 'refs/emperor/delegations/')).not.toBe('')
  await f.service.applyResult(record.id, run.id, 'user')
  expect(existsSync(lease.path)).toBe(false)
  expect(f.git('for-each-ref', 'refs/emperor/delegations/')).toBe('')
  expect(f.git('worktree', 'list', '--porcelain')).not.toContain(lease.path)
  expect(f.service.inspect(record.id).record!.availability).toBe('closed')
})

it('10 · discarding deletes the result worktree and its refs and leaves the project alone', async () => {
  const f = fixture({ script: writes(CHILD_EDIT) })
  const record = await f.start()
  const run = await f.settle(record.id)
  const lease = f.workspaces.get(
    f.service.inspect(record.id).record!.workspaceLeaseId,
  )
  const discarded = await f.service.discardResult(record.id, run.id, 'user')
  expect(discarded.state).toBe('discarded')
  expect(existsSync(lease.path)).toBe(false)
  expect(f.git('for-each-ref', 'refs/emperor/delegations/')).toBe('')
  expect(readFileSync(join(f.repo, 'src', 'a.txt'), 'utf8')).toBe(
    'one\ntwo\nthree\n',
  )
})

it('10 · deleting the conversation for good removes what its results left', async () => {
  const f = fixture({ script: writes(CHILD_EDIT) })
  const record = await f.start()
  await f.settle(record.id)
  const lease = f.workspaces.get(
    f.service.inspect(record.id).record!.workspaceLeaseId,
  )
  await f.service.forgetRoot('root')
  expect(existsSync(lease.path)).toBe(false)
  expect(f.git('for-each-ref', 'refs/emperor/')).toBe('')
})

it('11 · stopping never hangs on a run that waits for the workspace', async () => {
  const f = fixture({ script: writes(CHILD_EDIT) })
  // A main-session write holds the project while the child prepares.
  const held = await f.mutations.acquireWriter(f.repo, 'call-long-bash')
  const record = await f.start()
  // No event marks the wait; poll the phase with room for a loaded machine.
  await expect
    .poll(
      () => f.service.inspect(record.id).runs[record.currentRunId!]!.phase,
      { timeout: 10_000 },
    )
    .toBe('preparing')
  const stopped = await Promise.race([
    f.service.shutdown().then(() => 'stopped'),
    new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 5000)),
  ])
  held.release()
  expect(stopped).toBe('stopped')
}, 15_000)

it('12 · an unhandled result asks to be cleaned up after 14 days', () => {
  const at = Date.UTC(2026, 9, 1)
  const result = {
    state: 'ready' as const,
    at,
  }
  expect(RESULT_CLEANUP_AFTER_MS).toBe(14 * 24 * 60 * 60 * 1000)
  expect(resultNeedsCleanup(result, at + RESULT_CLEANUP_AFTER_MS - 1)).toBe(
    false,
  )
  expect(resultNeedsCleanup(result, at + RESULT_CLEANUP_AFTER_MS)).toBe(true)
  expect(
    resultNeedsCleanup({ state: 'conflicted', at }, at + 15 * 86_400_000),
  ).toBe(true)
  for (const state of ['applied', 'discarded', 'reverted'] as const)
    expect(resultNeedsCleanup({ state, at }, at + 30 * 86_400_000)).toBe(false)
})

it('applying is refused while 验证后再应用 is on', async () => {
  const f = fixture({ script: writes(CHILD_EDIT) })
  f.config.verifyBeforeApply = true
  const record = await f.start()
  const run = await f.settle(record.id)
  await expect(
    f.service.applyResult(record.id, run.id, 'user'),
  ).rejects.toThrow('VERIFY_BEFORE_APPLY')
})

it('a run that changed nothing leaves an empty result and a Goal can move on', async () => {
  const f = fixture({ script: writes({}) })
  const record = await f.start()
  const run = await f.settle(record.id)
  expect(f.service.inspect(record.id).runs[run.id]!.result).toMatchObject({
    totals: { files: 0 },
  })
})

it('never writes through a folder that became a link in the project', async () => {
  const f = fixture({ script: writes(CHILD_EDIT) })
  const record = await f.start()
  const run = await f.settle(record.id)
  const { renameSync, symlinkSync, mkdirSync } = await import('node:fs')
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  renameSync(join(f.repo, 'src'), join(outside, 'src'))
  symlinkSync(join(outside, 'src'), join(f.repo, 'src'))
  const outcome = await f.service.applyResult(record.id, run.id, 'user')
  expect(outcome.state).toBe('conflicted')
  expect(outcome.conflicts).toEqual(['src/a.txt', 'src/new.ts'])
  expect(existsSync(join(outside, 'src', 'new.ts'))).toBe(false)
})

it('two applies at once: the second sees the first already done', async () => {
  const f = fixture({ script: writes(CHILD_EDIT) })
  const record = await f.start()
  const run = await f.settle(record.id)
  const [first, second] = await Promise.allSettled([
    f.service.applyResult(record.id, run.id, 'user'),
    f.service.applyResult(record.id, run.id, 'model'),
  ])
  expect(first).toMatchObject({
    status: 'fulfilled',
    value: { state: 'applied' },
  })
  expect(second).toMatchObject({ status: 'rejected' })
  expect(String((second as PromiseRejectedResult).reason)).toContain(
    'RESULT_SETTLED',
  )
  expect(f.service.inspect(record.id).runs[run.id]!.result!.totals.files).toBe(
    2,
  )
})
