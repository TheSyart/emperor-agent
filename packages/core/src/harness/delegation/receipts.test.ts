import { expect, it } from 'vitest'
import {
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'
import { fixtureGit } from '../../workspace/delegation-test-fixture'
import { receiptFixture } from './receipt-test-fixture'
it('collects tracked edits, deletions, renames and untracked binary without changing the original HEAD/index/files', async () => {
  const f = await receiptFixture()
  try {
    const head = fixtureGit(f.repo, 'rev-parse', 'HEAD'),
      index = readFileSync(join(f.repo, '.git', 'index'))
    renameSync(
      join(f.lease.cwd, 'src/a.txt'),
      join(f.lease.cwd, 'src/renamed.txt'),
    )
    writeFileSync(join(f.lease.cwd, 'added.bin'), Buffer.from([0, 255, 128, 1]))
    writeFileSync(join(f.lease.cwd, 'new.txt'), 'new artifact')
    writeFileSync(join(f.lease.cwd, '.env.local'), 'PRIVATE_FIXTURE_SECRET')
    const receipt = await f.receipts.collect(f.run.id)
    expect(receipt.changedFiles).toContainEqual({
      path: 'src/renamed.txt',
      oldPath: 'src/a.txt',
      status: 'renamed',
      binary: false,
    })
    expect(
      receipt.changedFiles.find((p) => p.path === 'added.bin')?.binary,
    ).toBe(true)
    const binary = receipt.resultFiles.find((p) => p.path === 'added.bin')!
    expect(readFileSync(binary.blob)).toEqual(Buffer.from([0, 255, 128, 1]))
    expect(receipt.resultFiles.some((p) => p.path === '.env.local')).toBe(false)
    expect(receipt.excluded.some((p) => p.path === '.env.local')).toBe(true)
    expect(receipt.patch && readFileSync(receipt.patch, 'utf8')).toContain(
      'GIT binary patch',
    )
    expect(receipt.patch && readFileSync(receipt.patch, 'utf8')).not.toContain(
      'PRIVATE_FIXTURE_SECRET',
    )
    expect(fixtureGit(f.repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index)
    expect(readFileSync(join(f.repo, 'src/a.txt'), 'utf8')).toBe('base')
    expect(receipt.acceptance).toBe('unverified')
    expect(await f.receipts.current(receipt.id)).toBe(true)
    writeFileSync(join(f.lease.cwd, 'new.txt'), 'later edit')
    expect(await f.receipts.current(receipt.id)).toBe(false)
  } finally {
    f.cleanup()
  }
})
it('refuses to collect while the external process is not proven stopped', async () => {
  const f = await receiptFixture()
  f.run.quiescent = false
  try {
    await expect(f.receipts.collect(f.run.id)).rejects.toThrow(
      'OUTCOME_UNKNOWN',
    )
  } finally {
    f.cleanup()
  }
})
it('retains artifacts and refuses incomplete collection when a file exceeds the bounded artifact limit', async () => {
  const f = await receiptFixture(),
    large = join(f.lease.cwd, 'large.bin')
  writeFileSync(large, Buffer.alloc(17 * 1024 * 1024))
  try {
    await expect(f.receipts.collect(f.run.id)).rejects.toThrow('ARTIFACT_LIMIT')
    expect(existsSync(large)).toBe(true)
  } finally {
    f.cleanup()
  }
})
it('captures a non-Git baseline before shared writes and excludes nested private delegation state', async () => {
  const {
      delegationTestDirectory,
      fixtureDelegationRecord,
      fixtureDelegationRun,
    } = await import('./testing'),
    { DelegationWorkspaceService } =
      await import('../../workspace/delegation-workspaces'),
    { WorkspaceMutationCoordinator } =
      await import('../../workspace/mutation-coordinator'),
    { SnapshotService } = await import('../../workspace/delegation-snapshot'),
    { delegationRepository } =
      await import('../../workspace/delegation-test-fixture'),
    { DelegationReceipts } = await import('./receipts')
  const temp = delegationTestDirectory(),
    git = delegationRepository(),
    mutations = new WorkspaceMutationCoordinator(),
    state = join(temp.root, 'private-state')
  writeFileSync(join(temp.root, 'plain.txt'), 'initial non-Git input')
  try {
    const owner = fixtureDelegationRecord().owner,
      workspaces = new DelegationWorkspaceService({
        root: state,
        runner: git.runner,
        snapshots: new SnapshotService({
          runner: git.runner,
          tempRoot: join(state, 'tmp'),
        }),
        mutations,
      }),
      lease = await workspaces.prepare(owner, {
        cwd: temp.root,
        workspace: 'shared-exclusive',
        base: 'committed',
      }),
      // AGT-06: a write outside Git works in a copy of the folder.
      record = {
        ...fixtureDelegationRecord(),
        cwd: lease.cwd,
        workspaceLeaseId: lease.id,
      },
      run = {
        ...fixtureDelegationRun(),
        phase: 'completed' as const,
        quiescent: true,
      },
      receipts = new DelegationReceipts({
        root: state,
        runner: git.runner,
        mutations,
        resolve: () => ({ record, run, lease }),
      })
    expect(lease.cwd).not.toBe(temp.root)
    expect(existsSync(join(lease.cwd, 'private-state'))).toBe(false)
    writeFileSync(join(lease.cwd, 'plain.txt'), 'external changed input')
    const receipt = await receipts.collect(run.id)
    expect(receipt.originCwd).toBe(realpathSync(temp.root))
    expect(
      readFileSync(
        receipt.baseFiles.find((f) => f.path === 'plain.txt')!.blob,
        'utf8',
      ),
    ).toBe('initial non-Git input')
    expect(
      receipt.changedFiles.find((f) => f.path === 'plain.txt')?.status,
    ).toBe('modified')
    expect(
      receipt.resultFiles.some((f) => f.path.startsWith('private-state/')),
    ).toBe(false)
  } finally {
    temp.cleanup()
    const { rmSync } = await import('node:fs')
    rmSync(git.root, { recursive: true, force: true })
  }
})
it('binds nested project receipts to their execution prefix and original nested directory', async () => {
  const { delegationRepository } =
      await import('../../workspace/delegation-test-fixture'),
    { SnapshotService } = await import('../../workspace/delegation-snapshot'),
    { DelegationWorkspaceService } =
      await import('../../workspace/delegation-workspaces'),
    { WorkspaceMutationCoordinator } =
      await import('../../workspace/mutation-coordinator'),
    { DelegationReceipts } = await import('./receipts'),
    { fixtureDelegationRecord, fixtureDelegationRun } =
      await import('./testing'),
    { rmSync } = await import('node:fs')
  const f = delegationRepository(),
    mutations = new WorkspaceMutationCoordinator(),
    state = join(f.root, 'state'),
    owner = fixtureDelegationRecord().owner
  try {
    const workspaces = new DelegationWorkspaceService({
        root: state,
        runner: f.runner,
        snapshots: new SnapshotService({
          runner: f.runner,
          tempRoot: join(state, 'tmp'),
          resources: mutations.resources,
        }),
        mutations,
      }),
      lease = await workspaces.prepare(owner, {
        cwd: join(f.repo, 'src'),
        workspace: 'isolated-worktree',
        base: 'committed',
      }),
      record = {
        ...fixtureDelegationRecord(),
        cwd: lease.cwd,
        workspaceLeaseId: lease.id,
      },
      run = {
        ...fixtureDelegationRun(),
        phase: 'completed' as const,
        quiescent: true,
      },
      receipts = new DelegationReceipts({
        root: state,
        runner: f.runner,
        mutations,
        resolve: () => ({ record, run, lease }),
      })
    writeFileSync(join(lease.cwd, 'a.txt'), 'nested change')
    const receipt = await receipts.collect(run.id)
    expect(receipt.originCwd).toBe(join(f.repo, 'src'))
    expect(receipt.baseFiles.map((f) => f.path)).toEqual(['a.txt'])
    expect(receipt.changedFiles.map((f) => f.path)).toEqual(['a.txt'])
    expect(receipt.patch && readFileSync(receipt.patch, 'utf8')).toContain(
      'a/a.txt',
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
it('refuses a replaced Git pointer before writing snapshot objects into a different repository', async () => {
  const f = await receiptFixture(),
    { delegationRepository } =
      await import('../../workspace/delegation-test-fixture'),
    other = delegationRepository(),
    { rmSync } = await import('node:fs')
  try {
    writeFileSync(
      join(f.lease.path, '.git'),
      'gitdir: ' + join(other.repo, '.git') + '\n',
    )
    writeFileSync(join(f.lease.cwd, 'new.txt'), 'external result')
    await expect(f.receipts.collect(f.run.id)).rejects.toThrow(
      'GIT_BINDING_CHANGED',
    )
    expect(existsSync(join(other.repo, '.git/refs/emperor'))).toBe(false)
  } finally {
    f.cleanup()
    rmSync(other.root, { recursive: true, force: true })
  }
})
