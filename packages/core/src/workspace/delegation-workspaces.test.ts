import { expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SnapshotService } from './delegation-snapshot'
import { DelegationWorkspaceService } from './delegation-workspaces'
import { WorkspaceMutationCoordinator } from './mutation-coordinator'
import { delegationRepository, fixtureGit } from './delegation-test-fixture'
import { fixtureDelegationRecord } from '../harness/delegation/testing'
function setup(save?: (path: string, text: string) => void) {
  const f = delegationRepository()
  const service = new DelegationWorkspaceService({
    root: join(f.root, 'delegations'),
    runner: f.runner,
    snapshots: new SnapshotService({
      runner: f.runner,
      tempRoot: join(f.root, 'tmp'),
    }),
    mutations: new WorkspaceMutationCoordinator(),
    save,
  })
  return { ...f, service, owner: fixtureDelegationRecord().owner }
}
it('isolates paths and preserves repository subdirectory mapping', async () => {
  const { repo, owner, service } = setup()
  const a = await service.prepare(owner, {
    cwd: join(repo, 'src'),
    workspace: 'isolated-worktree',
    base: 'committed',
  })
  const b = await service.prepare(owner, {
    cwd: join(repo, 'src'),
    workspace: 'isolated-worktree',
    base: 'committed',
  })
  expect(a.path).not.toBe(b.path)
  expect(a.snapshot?.commit).toBe(b.snapshot?.commit)
  expect(a.cwd).toBe(join(a.path, 'src'))
  expect(readFileSync(join(a.cwd, 'a.txt'), 'utf8')).toBe('base')
})
it('retain and release preserve untracked binary output and refuse stale or foreign owners', async () => {
  const { repo, owner, service } = setup()
  let a = await service.prepare(owner, {
    cwd: repo,
    workspace: 'isolated-worktree',
    base: 'committed',
  })
  writeFileSync(join(a.path, 'result.bin'), Buffer.from([1, 255]))
  a = service.retain(a.id)
  expect(() => service.release(a.id, a.revision - 1, owner)).toThrow(
    'STALE_REVISION',
  )
  expect(() =>
    service.release(a.id, a.revision, { ...owner, parentAgentId: 'foreign' }),
  ).toThrow('OWNER_MISMATCH')
  service.release(a.id, a.revision, owner)
  expect(readFileSync(join(a.path, 'result.bin'))).toEqual(
    Buffer.from([1, 255]),
  )
})
it('readonly parent uses shared source and never writes Git refs/index/worktrees', async () => {
  const { repo, owner, service } = setup()
  const before = fixtureGit(repo, 'show-ref')
  const index = readFileSync(join(repo, '.git', 'index'))
  const a = await service.prepare(owner, {
    cwd: repo,
    workspace: 'shared-readonly',
    base: 'committed',
    readOnly: true,
  })
  expect(a.cwd).toBe(repo)
  expect(fixtureGit(repo, 'show-ref')).toBe(before)
  expect(readFileSync(join(repo, '.git', 'index'))).toEqual(index)
  await expect(
    service.prepare(owner, {
      cwd: repo,
      workspace: 'isolated-worktree',
      base: 'snapshot',
      readOnly: true,
    }),
  ).rejects.toThrow('PERMISSION_DENIED')
})
it('refuses unsupported isolation inputs', async () => {
  const { repo, owner, service } = setup()
  writeFileSync(join(repo, '.gitmodules'), '[submodule "x"]')
  fixtureGit(
    repo,
    'update-index',
    '--add',
    '--cacheinfo',
    '160000',
    fixtureGit(repo, 'rev-parse', 'HEAD'),
    'x',
  )
  await expect(
    service.prepare(owner, {
      cwd: repo,
      workspace: 'isolated-worktree',
      base: 'snapshot',
    }),
  ).rejects.toThrow('UNSUPPORTED_WORKSPACE')
})
it('writes durable ownership intent before creating worktree and preserves it on final save failure', async () => {
  let writes = 0
  const f = setup((path, text) => {
    if (++writes === 2) throw new Error('disk full')
    writeFileSync(path, text)
  })
  await expect(
    f.service.prepare(f.owner, {
      cwd: f.repo,
      workspace: 'isolated-worktree',
      base: 'committed',
    }),
  ).rejects.toThrow('disk full')
  const ids = readdirSync(join(f.root, 'delegations', 'leases'))
  expect(ids.length).toBe(1)
  const intent = JSON.parse(
    readFileSync(join(f.root, 'delegations', 'leases', ids[0]!), 'utf8'),
  )
  expect(intent.status).toBe('preparing')
  expect(existsSync(intent.path)).toBe(true)
})
