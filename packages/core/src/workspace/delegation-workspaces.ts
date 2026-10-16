import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DelegationOwner,
  DelegationStart,
} from '../harness/delegation/types'
import { DelegationError } from '../harness/delegation/types'
import type { SnapshotService, BaseSnapshot } from './delegation-snapshot'
import type { HardenedGitRunner } from './git-runner'
import type { WorkspaceMutationCoordinator } from './mutation-coordinator'
import {
  durableReplaceSync,
  withPersistenceLockSync,
} from '../store/persistence'
import { safeDelegationKey } from '../harness/delegation/fold'
export interface DelegationWorkspaceLease {
  id: string
  revision: number
  owner: DelegationOwner
  cwd: string
  path: string
  mode: DelegationStart['workspace']
  status: 'preparing' | 'ready' | 'retained' | 'released'
  snapshot?: BaseSnapshot
}
export class DelegationWorkspaceService {
  constructor(
    private readonly options: {
      root: string
      runner: HardenedGitRunner
      snapshots: SnapshotService
      mutations: WorkspaceMutationCoordinator
      save?: (path: string, text: string) => void
    },
  ) {}
  private path(id: string): string {
    safeDelegationKey(id)
    return join(this.options.root, 'leases', id + '.json')
  }
  private save(lease: DelegationWorkspaceLease): void {
    const path = this.path(lease.id)
    mkdirSync(join(this.options.root, 'leases'), {
      recursive: true,
      mode: 0o700,
    })
    ;(this.options.save ?? durableReplaceSync)(
      path,
      JSON.stringify(lease) + '\n',
    )
  }
  get(id: string): DelegationWorkspaceLease {
    const value = JSON.parse(
      readFileSync(this.path(id), 'utf8'),
    ) as DelegationWorkspaceLease
    if (value.id !== id)
      throw new DelegationError(
        'OWNER_MISMATCH',
        'workspace lease identity mismatch',
      )
    return value
  }
  async prepare(
    owner: DelegationOwner,
    spec: Pick<DelegationStart, 'workspace' | 'base'> & {
      cwd: string
      readOnly?: boolean
      untracked?: string[]
    },
  ): Promise<DelegationWorkspaceLease> {
    if (
      spec.readOnly &&
      (spec.workspace !== 'shared-readonly' || spec.base === 'snapshot')
    )
      throw new DelegationError(
        'PERMISSION_DENIED',
        'readonly parent cannot prepare a writable worktree or snapshot',
      )
    const source = realpathSync(spec.cwd),
      id = 'dwl-' + randomUUID()
    const path =
      spec.workspace === 'isolated-worktree'
        ? join(this.options.root, 'workspaces', id)
        : source
    let lease: DelegationWorkspaceLease = {
      id,
      revision: 1,
      owner: structuredClone(owner),
      cwd: source,
      path,
      mode: spec.workspace,
      status: 'preparing',
    }
    // Intent survives any Git operation or final-save failure; no automatic deletion of these paths.
    this.save(lease)
    const probe = await this.options.runner.execute(
      source,
      ['rev-parse', '--is-inside-work-tree'],
      { allowedExitCodes: [0, 128] },
    )
    if (probe.exitCode !== 0) {
      if (spec.workspace === 'isolated-worktree')
        throw new DelegationError(
          'NOT_GIT_WORKSPACE',
          'non-Git writes require explicit shared-exclusive',
        )
      lease = { ...lease, revision: 2, status: 'ready' }
      this.save(lease)
      return lease
    }
    const capture = () =>
      this.options.snapshots.capture({
        id,
        cwd: source,
        base: spec.base,
        readOnly: spec.workspace === 'shared-readonly',
        untracked: spec.untracked,
      })
    const snapshot =
      spec.workspace === 'shared-readonly'
        ? await capture()
        : await this.options.mutations.runExclusive(source, 'agent', capture)
    if (spec.workspace === 'isolated-worktree') {
      if (
        snapshot.excluded.some((e) =>
          ['symlink', 'submodule', 'nested-repository'].includes(e.reason),
        )
      ) {
        this.save({ ...lease, snapshot, revision: lease.revision + 1 })
        throw new DelegationError(
          'UNSUPPORTED_WORKSPACE',
          'isolation excludes unsupported inputs: ' +
            JSON.stringify(
              snapshot.excluded.filter((e) =>
                ['symlink', 'submodule', 'nested-repository'].includes(
                  e.reason,
                ),
              ),
            ).slice(0, 8192),
        )
      }
      const lock = await this.options.snapshots.resources.acquire({
        keys: ['git:' + snapshot.commonDir],
        mode: 'exclusive',
        owner: id,
      })
      try {
        mkdirSync(join(this.options.root, 'workspaces'), {
          recursive: true,
          mode: 0o700,
        })
        await this.options.runner.execute(snapshot.repositoryRoot, [
          'worktree',
          'add',
          '--detach',
          path,
          snapshot.commit,
        ])
      } finally {
        lock.release()
      }
    }
    lease = {
      ...lease,
      cwd:
        spec.workspace === 'isolated-worktree'
          ? join(path, snapshot.prefix)
          : source,
      snapshot,
      status: 'ready',
      revision: 2,
    }
    this.save(lease)
    return structuredClone(lease)
  }
  retain(id: string): DelegationWorkspaceLease {
    return withPersistenceLockSync(this.path(id), () => {
      const lease = this.get(id)
      if (lease.status === 'released')
        throw new DelegationError(
          'WORKSPACE_RELEASED',
          'workspace lease already closed',
        )
      lease.status = 'retained'
      lease.revision++
      this.save(lease)
      return lease
    })
  }
  release(
    id: string,
    revision: number,
    owner: DelegationOwner,
  ): DelegationWorkspaceLease {
    return withPersistenceLockSync(this.path(id), () => {
      const lease = this.get(id)
      if (lease.revision !== revision)
        throw new DelegationError('STALE_REVISION', 'workspace lease changed')
      if (
        lease.owner.rootSessionId !== owner.rootSessionId ||
        lease.owner.parentAgentId !== owner.parentAgentId ||
        lease.owner.taskScopeId !== owner.taskScopeId
      )
        throw new DelegationError(
          'OWNER_MISMATCH',
          'workspace belongs to another task',
        )
      lease.status = 'released'
      lease.revision++
      this.save(lease)
      return lease
    })
  }
}
