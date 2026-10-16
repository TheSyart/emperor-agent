import { expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { delegationRepository, fixtureGit } from './delegation-test-fixture'
import { SnapshotService } from './delegation-snapshot'
it('reports ignored dependency directories once rather than expanding their contents into the brief', async () => {
  const { root, repo, runner } = delegationRepository()
  mkdirSync(join(repo, 'ignored'))
  for (let i = 0; i < 10; i++)
    writeFileSync(join(repo, 'ignored', 'file-' + i), 'ignored')
  const snapshot = await new SnapshotService({
    runner,
    tempRoot: join(root, 'tmp'),
  }).capture({ id: 'dlg-ignored', cwd: repo, base: 'committed' })
  expect(snapshot.excluded).toContainEqual({
    path: 'ignored/',
    reason: 'ignored',
  })
  expect(
    snapshot.excluded.filter((e) => e.path.startsWith('ignored/')).length,
  ).toBe(1)
})
it('refuses a truncated Git inventory instead of calling an incomplete snapshot complete', async () => {
  const { root, repo, runner } = delegationRepository(),
    execute = runner.execute.bind(runner)
  vi.spyOn(runner, 'execute').mockImplementation(async (cwd, args, options) =>
    args.includes('ls-files')
      ? { exitCode: 0, stdout: 'partial\0', stderr: '', stdoutTruncated: true }
      : execute(cwd, args, options),
  )
  await expect(
    new SnapshotService({ runner, tempRoot: join(root, 'tmp') }).capture({
      id: 'dlg-truncated',
      cwd: repo,
      base: 'committed',
    }),
  ).rejects.toThrow('SNAPSHOT_LIMIT')
})
it('captures selected dirty tracked/untracked bytes without moving HEAD or user index', async () => {
  const { root, repo, runner } = delegationRepository()
  const head = fixtureGit(repo, 'rev-parse', 'HEAD')
  const index = readFileSync(join(repo, '.git', 'index'))
  writeFileSync(join(repo, 'src', 'a.txt'), 'dirty')
  writeFileSync(join(repo, 'selected.bin'), Buffer.from([0, 1, 255]))
  writeFileSync(join(repo, 'not-selected.txt'), 'no')
  writeFileSync(join(repo, '.env.local'), 'SECRET=fixture')
  const s = await new SnapshotService({
    runner,
    tempRoot: join(root, 'tmp'),
  }).capture({
    id: 'dlg-fixture',
    cwd: repo,
    base: 'snapshot',
    untracked: ['selected.bin'],
  })
  expect(fixtureGit(repo, 'show', s.commit + ':src/a.txt')).toBe('dirty')
  expect(s.included).toContain('selected.bin')
  expect(
    execFileSync('git', ['show', s.commit + ':selected.bin'], { cwd: repo }),
  ).toEqual(Buffer.from([0, 1, 255]))
  expect(s.excluded.map((e) => e.path)).toEqual(
    expect.arrayContaining(['.env.local', 'not-selected.txt']),
  )
  expect(fixtureGit(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(readFileSync(join(repo, '.git', 'index'))).toEqual(index)
  expect(fixtureGit(repo, 'rev-parse', s.ref!)).toBe(s.commit)
})
it('reports dangling symlinks rather than snapshotting a followed or invalid file', async () => {
  const { root, repo, runner } = delegationRepository()
  symlinkSync(join(root, 'missing'), join(repo, 'dangling'))
  const s = await new SnapshotService({
    runner,
    tempRoot: join(root, 'tmp'),
  }).capture({
    id: 'dlg-dangling',
    cwd: repo,
    base: 'snapshot',
    untracked: ['dangling'],
  })
  expect(s.excluded).toContainEqual({ path: 'dangling', reason: 'symlink' })
  expect(s.included).not.toContain('dangling')
})
it('requires an explicit snapshot for dirty committed base', async () => {
  const { root, repo, runner } = delegationRepository()
  writeFileSync(join(repo, 'src', 'a.txt'), 'changed')
  await expect(
    new SnapshotService({ runner, tempRoot: join(root, 'tmp') }).capture({
      id: 'dlg-fixture',
      cwd: repo,
      base: 'committed',
    }),
  ).rejects.toThrow('DIRTY_BASE_REQUIRES_SNAPSHOT')
})
it('reports escaping links, nested repositories, and ignored files without following them', async () => {
  const { root, repo, runner } = delegationRepository()
  symlinkSync(root, join(repo, 'escape'))
  mkdirSync(join(repo, 'nested', '.git'), { recursive: true })
  writeFileSync(join(repo, 'nested', 'a'), 'nested')
  writeFileSync(join(repo, '.env'), 'secret')
  const s = await new SnapshotService({
    runner,
    tempRoot: join(root, 'tmp'),
  }).capture({
    id: 'dlg-fixture',
    cwd: repo,
    base: 'snapshot',
    untracked: ['escape', 'nested/'],
  })
  expect(s.excluded).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'escape', reason: 'symlink' }),
      expect.objectContaining({ reason: 'nested-repository' }),
      expect.objectContaining({ path: '.env' }),
    ]),
  )
})
