import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { delegationRepository } from '../../workspace/delegation-test-fixture'
import { SnapshotService } from '../../workspace/delegation-snapshot'
import { DelegationWorkspaceService } from '../../workspace/delegation-workspaces'
import { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
import { fixtureDelegationRecord, fixtureDelegationRun } from './testing'
import { DelegationReceipts } from './receipts'
export async function receiptFixture() {
  const f = delegationRepository(),
    mutations = new WorkspaceMutationCoordinator(),
    snapshots = new SnapshotService({
      runner: f.runner,
      tempRoot: join(f.root, 'tmp'),
      resources: mutations.resources,
    }),
    workspaces = new DelegationWorkspaceService({
      root: join(f.root, 'state'),
      runner: f.runner,
      snapshots,
      mutations,
    }),
    owner = fixtureDelegationRecord().owner
  const lease = await workspaces.prepare(owner, {
      cwd: f.repo,
      workspace: 'isolated-worktree',
      base: 'committed',
    }),
    record = {
      ...fixtureDelegationRecord(),
      cwd: lease.cwd,
      workspaceLeaseId: lease.id,
      effectivePermission: 'workspace-write' as const,
    },
    run = {
      ...fixtureDelegationRun(),
      phase: 'completed' as const,
      quiescent: true,
      summary: 'native report: tests passed',
    }
  const receipts = new DelegationReceipts({
    root: join(f.root, 'state'),
    runner: f.runner,
    mutations,
    resolve: () => ({ record, run, lease }),
  })
  return {
    ...f,
    mutations,
    lease,
    record,
    run,
    receipts,
    cleanup: () => rmSync(f.root, { recursive: true, force: true }),
  }
}
