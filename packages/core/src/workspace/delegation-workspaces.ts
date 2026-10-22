import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type {
  DelegationOwner,
  DelegationStart,
} from '../harness/delegation/types'
import { DelegationError } from '../harness/delegation/types'
import {
  placedGit,
  type SnapshotService,
  type BaseSnapshot,
} from './delegation-snapshot'
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
  /**
   * A folder outside Git that a child may write (AGT-06): it works in a
   * copy (`path`), a private Git directory keeps the copy's baseline
   * commit, and `source` is the folder a result applies back to.
   */
  copy?: { gitDir: string; base: string; source: string }
  /** Its result was applied, discarded or its conversation purged (AGT-06). */
  cleaned?: boolean
}
/** A copy refuses folders with more files than this (review in place instead). */
export const COPY_FILE_LIMIT = 10_000
/** Never copied into a child's folder copy. */
const COPY_EXCLUDES = ['.git', 'node_modules/', '.DS_Store', '.env*']
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
  /**
   * A non-Git folder's copy: the folder is read once (`git add` into a
   * private repository), the baseline committed there, and the copy
   * written from those objects, so the child never touches the folder.
   */
  private async copyFolder(
    id: string,
    source: string,
    path: string,
  ): Promise<DelegationWorkspaceLease['copy']> {
    const gitDir = join(this.options.root, 'workspaces', id + '.git')
    mkdirSync(path, { recursive: true, mode: 0o700 })
    await this.options.runner.execute(join(this.options.root, 'workspaces'), [
      'init',
      '-q',
      '--bare',
      gitDir,
    ])
    mkdirSync(join(gitDir, 'info'), { recursive: true })
    // Emperor's own state inside the folder is never part of the copy.
    const own = relative(source, realpathSync(this.options.root))
    const excludes = [
      ...COPY_EXCLUDES,
      ...(own && !own.startsWith('..') && !isAbsolute(own)
        ? ['/' + own.split(sep).join('/') + '/']
        : []),
    ]
    writeFileSync(join(gitDir, 'info', 'exclude'), excludes.join('\n') + '\n')
    const from = placedGit(this.options.runner, source, [
      `--git-dir=${gitDir}`,
      `--work-tree=${source}`,
    ])
    const tooMany = () =>
      new DelegationError(
        'COPY_LIMIT',
        `more than ${COPY_FILE_LIMIT} files to copy; review the folder in place (shared-readonly) instead`,
      )
    // Counted before anything is read.
    if (
      (await from(['ls-files', '-z', '--others', '--exclude-standard'])).stdout
        .split('\0')
        .filter(Boolean).length > COPY_FILE_LIMIT
    )
      throw tooMany()
    await from(['add', '-A', '--ignore-errors'], { allowedExitCodes: [0, 1] })
    const staged = (await from(['ls-files', '--stage', '-z'])).stdout
      .split('\0')
      .filter(Boolean)
    if (staged.length > COPY_FILE_LIMIT) throw tooMany()
    // Links and nested repositories are not copied (a link could lead out).
    const unsupported = staged
      .filter((line) => /^(120000|160000) /.test(line))
      .map((line) => line.slice(line.indexOf('\t') + 1))
    if (unsupported.length)
      await from(['update-index', '-z', '--force-remove', '--stdin'], {
        stdin: unsupported.join('\0') + '\0',
      })
    const tree = (await from(['write-tree'])).stdout.trim()
    const base = (
      await from(['commit-tree', '--no-gpg-sign', tree], {
        stdin: 'Emperor delegation folder baseline\n',
        env: {
          GIT_AUTHOR_NAME: 'Emperor Agent',
          GIT_AUTHOR_EMAIL: 'delegation@localhost',
          GIT_COMMITTER_NAME: 'Emperor Agent',
          GIT_COMMITTER_EMAIL: 'delegation@localhost',
        },
      })
    ).stdout.trim()
    await from(['update-ref', 'HEAD', base])
    const into = placedGit(this.options.runner, path, [
      `--git-dir=${gitDir}`,
      `--work-tree=${path}`,
    ])
    await into(['read-tree', base])
    // -u keeps the index's stat data for the copy: status stays cheap.
    await into(['checkout-index', '-a', '-f', '-u'])
    return { gitDir, base, source }
  }
  async prepare(
    owner: DelegationOwner,
    spec: Pick<DelegationStart, 'workspace' | 'base'> & {
      cwd: string
      readOnly?: boolean
      untracked?: string[]
      /** Stopping the run ends a wait for the workspace (AGT-06). */
      signal?: AbortSignal | null
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
    const isolated =
      spec.workspace === 'isolated-worktree'
        ? join(this.options.root, 'workspaces', id)
        : source
    let lease: DelegationWorkspaceLease = {
      id,
      revision: 1,
      owner: structuredClone(owner),
      cwd: source,
      path: isolated,
      mode: spec.workspace,
      status: 'preparing',
    }
    // Intent survives any Git operation or final-save failure; the paths go
    // with their result (applied, discarded, conversation purged; AGT-06).
    this.save(lease)
    const probe = await this.options.runner.execute(
      source,
      ['rev-parse', '--is-inside-work-tree'],
      { allowedExitCodes: [0, 128] },
    )
    if (probe.exitCode !== 0) {
      // Outside Git (AGT-06): a review reads the folder in place; a write
      // works in a copy, so the main session is never locked out.
      if (spec.workspace !== 'shared-readonly') {
        const path = join(this.options.root, 'workspaces', id)
        lease = { ...lease, path, cwd: path }
        this.save(lease)
        const copy = await this.copyFolder(id, source, path)
        lease = { ...lease, copy, revision: 2, status: 'ready' }
      } else lease = { ...lease, revision: 2, status: 'ready' }
      this.save(lease)
      return structuredClone(lease)
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
        : await this.options.mutations.runExclusive(
            source,
            'agent',
            capture,
            spec.signal,
          )
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
      const lock = await this.options.snapshots.resources.acquire(
        {
          keys: ['git:' + snapshot.commonDir],
          mode: 'exclusive',
          owner: id,
        },
        spec.signal,
      )
      try {
        mkdirSync(join(this.options.root, 'workspaces'), {
          recursive: true,
          mode: 0o700,
        })
        await this.options.runner.execute(snapshot.repositoryRoot, [
          'worktree',
          'add',
          '--detach',
          isolated,
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
          ? join(isolated, snapshot.prefix)
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
  /** Its directories are gone with its result (AGT-06): released for good. */
  retire(id: string): DelegationWorkspaceLease {
    return withPersistenceLockSync(this.path(id), () => {
      const lease = this.get(id)
      lease.status = 'released'
      lease.cleaned = true
      lease.revision++
      this.save(lease)
      return lease
    })
  }
}
