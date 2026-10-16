import { randomUUID, createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  realpathSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  constants,
} from 'node:fs'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import type { DelegationRecord, DelegationRunRecord } from './types'
import { DelegationError, TERMINAL_RUN_PHASES } from './types'
import type { DelegationWorkspaceLease } from '../../workspace/delegation-workspaces'
import type { HardenedGitRunner } from '../../workspace/git-runner'
import type { WorkspaceMutationCoordinator } from '../../workspace/mutation-coordinator'
import { SnapshotService } from '../../workspace/delegation-snapshot'
import { durableReplaceSync } from '../../store/persistence'
import {
  ArtifactStore,
  artifactTreeDigest,
  workspaceArtifacts,
  excludedArtifact,
  safeArtifactPath,
  ARTIFACT_TOTAL_LIMIT,
  ARTIFACT_FILE_LIMIT,
  sha256,
  type ArtifactFile,
} from './artifacts'
export type { ArtifactFile } from './artifacts'
export interface DelegationReceipt {
  schemaVersion: 1
  id: string
  runId: string
  delegationId: string
  backend: string
  version: string
  createdAt: number
  cwd: string
  originCwd: string
  leaseId: string
  baseCommit?: string
  baseTreeDigest: string
  resultTreeDigest: string
  baseFiles: ArtifactFile[]
  resultFiles: ArtifactFile[]
  changedFiles: {
    path: string
    oldPath?: string
    status: 'added' | 'modified' | 'deleted' | 'renamed'
    binary: boolean
  }[]
  excluded: { path: string; reason: string }[]
  patch?: string
  summary: string
  acceptance: 'unverified'
  unresolved: string[]
}
export class DelegationReceipts {
  readonly artifacts: ArtifactStore
  constructor(
    private readonly options: {
      root: string
      runner: HardenedGitRunner
      mutations: WorkspaceMutationCoordinator
      resolve: (runId: string) => {
        record: DelegationRecord
        run: DelegationRunRecord
        lease: DelegationWorkspaceLease
      }
    },
  ) {
    this.artifacts = new ArtifactStore(join(options.root, 'artifacts'))
  }
  private path(id: string): string {
    if (!/^drr-[a-f0-9-]+$/.test(id))
      throw new DelegationError('INVALID_ID', 'receipt identity required')
    return join(this.options.root, 'receipts', id + '.json')
  }
  private async baseFiles(
    lease: DelegationWorkspaceLease,
  ): Promise<ArtifactFile[]> {
    const archived = join(this.options.root, 'baselines', lease.id + '.json')
    if (existsSync(archived)) {
      const baseline = JSON.parse(readFileSync(archived, 'utf8')) as {
        schemaVersion: number
        leaseId: string
        cwd: string
        ownerDigest: string
        digest: string
        files: ArtifactFile[]
      }
      if (
        baseline.schemaVersion !== 1 ||
        baseline.leaseId !== lease.id ||
        baseline.cwd !== lease.cwd ||
        baseline.ownerDigest !== sha256(JSON.stringify(lease.owner)) ||
        !Array.isArray(baseline.files) ||
        artifactTreeDigest(baseline.files) !== baseline.digest
      )
        throw new DelegationError(
          'BASELINE_CORRUPT',
          'initial artifact baseline does not match its workspace owner',
        )
      for (const file of baseline.files) this.artifacts.read(file)
      return baseline.files
    }
    if (!lease.snapshot) {
      const path = join(this.options.root, 'baselines', lease.id + '.json')
      if (!existsSync(path))
        throw new DelegationError(
          'BASELINE_MISSING',
          'initial non-Git baseline was not recorded; source retained',
        )
      const files = JSON.parse(readFileSync(path, 'utf8')) as ArtifactFile[]
      for (const file of files) this.artifacts.read(file)
      return files
    }
    const { commit, commonDir, prefix } = lease.snapshot,
      files: ArtifactFile[] = []
    const listing = await this.options.runner.execute(
      lease.snapshot.repositoryRoot,
      ['ls-tree', '-r', '-z', commit, '--', prefix || '.'],
    )
    if (listing.stdoutTruncated)
      throw new DelegationError(
        'ARTIFACT_LIMIT',
        'base tree inventory was truncated',
      )
    const temp = join(this.options.root, 'artifact-temp', randomUUID())
    mkdirSync(temp, { recursive: true, mode: 0o700 })
    try {
      for (const entry of listing.stdout.split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t'),
          [mode, type, oid] = entry.slice(0, tab).split(' '),
          repoPath = entry.slice(tab + 1)
        if (tab < 0 || !oid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
          throw new DelegationError(
            'ARTIFACT_CORRUPT',
            'invalid base blob identity',
          )
        const path = prefix ? repoPath.slice(prefix.length + 1) : repoPath
        safeArtifactPath(path)
        if (
          type !== 'blob' ||
          !['100644', '100755'].includes(mode!) ||
          excludedArtifact(path)
        )
          continue
        // The original worktree usually still holds the pinned base bytes.
        // Verify the Git blob id before using them; changed/deleted files fall
        // back to the immutable object database without decoding binary stdout.
        const original = join(lease.snapshot.repositoryRoot, repoPath)
        let physical: Buffer | undefined,
          parent = lease.snapshot.repositoryRoot,
          safe = true
        for (const part of repoPath.split('/')) {
          parent = join(parent, part)
          if (!existsSync(parent) || lstatSync(parent).isSymbolicLink()) {
            safe = false
            break
          }
        }
        if (safe) {
          const stat = lstatSync(original)
          if (stat.isFile() && stat.size <= ARTIFACT_FILE_LIMIT) {
            const bytes = readFileSync(original),
              hash = createHash(oid.length === 64 ? 'sha256' : 'sha1')
                .update(`blob ${bytes.length}\0`)
                .update(bytes)
                .digest('hex')
            if (hash === oid) physical = bytes
          }
        }
        if (physical) {
          files.push(
            this.artifacts.put(
              path,
              physical,
              mode === '100755' ? 0o755 : 0o644,
            ),
          )
          if (
            files.length > 10000 ||
            files.reduce((n, f) => n + f.size, 0) > ARTIFACT_TOTAL_LIMIT
          )
            throw new DelegationError(
              'ARTIFACT_LIMIT',
              'base archive exceeds bounded collection limit',
            )
          continue
        }
        const size = Number(
          (
            await this.options.runner.execute(temp, [
              `--git-dir=${commonDir}`,
              `--work-tree=${temp}`,
              'cat-file',
              '-s',
              oid,
            ])
          ).stdout.trim(),
        )
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > ARTIFACT_FILE_LIMIT
        )
          throw new DelegationError(
            'ARTIFACT_LIMIT',
            'base blob exceeds bounded storage limit',
          )
        const unpack = await this.options.runner.execute(temp, [
          `--git-dir=${commonDir}`,
          `--work-tree=${temp}`,
          'unpack-file',
          oid,
        ])
        const unpacked = resolve(temp, unpack.stdout.trim()),
          rel = relative(temp, unpacked)
        if (
          isAbsolute(rel) ||
          rel.startsWith('..' + sep) ||
          !rel.startsWith('.merge_file_') ||
          !lstatSync(unpacked).isFile()
        )
          throw new DelegationError(
            'ARTIFACT_CORRUPT',
            'Git base blob escaped its private materialization directory',
          )
        try {
          files.push(
            this.artifacts.put(
              path,
              readFileSync(unpacked),
              mode === '100755' ? 0o755 : 0o644,
            ),
          )
        } finally {
          rmSync(unpacked, { force: true })
        }
        if (
          files.length > 10000 ||
          files.reduce((n, f) => n + f.size, 0) > ARTIFACT_TOTAL_LIMIT
        )
          throw new DelegationError(
            'ARTIFACT_LIMIT',
            'base archive exceeds bounded collection limit',
          )
      }
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
    return files
  }
  async collect(runId: string): Promise<DelegationReceipt> {
    const binding = this.options.resolve(runId),
      { record, run, lease } = binding
    if (!TERMINAL_RUN_PHASES.has(run.phase) || !run.quiescent)
      throw new DelegationError(
        'OUTCOME_UNKNOWN',
        'artifact collection requires proven process quiescence',
      )
    if (record.currentRunId && record.currentRunId !== runId)
      throw new DelegationError(
        'STALE_RUN',
        'later work cannot be collected as an earlier run',
      )
    return this.options.mutations.runExclusive(
      record.cwd,
      'agent',
      async () => {
        if (lease.snapshot) {
          try {
            const repository = realpathSync(
              (
                await this.options.runner.execute(record.cwd, [
                  'rev-parse',
                  '--show-toplevel',
                ])
              ).stdout.trim(),
            )
            const common = realpathSync(
              resolve(
                record.cwd,
                (
                  await this.options.runner.execute(record.cwd, [
                    'rev-parse',
                    '--git-common-dir',
                  ])
                ).stdout.trim(),
              ),
            )
            const expectedRoot =
              lease.mode === 'isolated-worktree'
                ? realpathSync(lease.path)
                : lease.snapshot.repositoryRoot
            if (
              repository !== expectedRoot ||
              common !== lease.snapshot.commonDir
            )
              throw new Error('Git ownership changed')
          } catch {
            throw new DelegationError(
              'GIT_BINDING_CHANGED',
              'workspace Git ownership changed; original artifacts retained',
            )
          }
        }
        const id = 'drr-' + randomUUID(),
          result = await workspaceArtifacts(
            record.cwd,
            this.artifacts,
            this.options.runner,
          ),
          baseFiles = await this.baseFiles(lease),
          base = new Map(baseFiles.map((f) => [f.path, f])),
          next = new Map(result.files.map((f) => [f.path, f])),
          changedFiles: DelegationReceipt['changedFiles'] = []
        const removed = baseFiles.filter((f) => !next.has(f.path)),
          added = result.files.filter((f) => !base.has(f.path)),
          renamed = new Set<string>()
        for (const file of added) {
          const old = removed.find(
            (b) => !renamed.has(b.path) && b.sha256 === file.sha256,
          )
          if (old) {
            renamed.add(old.path)
            changedFiles.push({
              path: file.path,
              oldPath: old.path,
              status: 'renamed',
              binary: file.binary,
            })
          } else
            changedFiles.push({
              path: file.path,
              status: 'added',
              binary: file.binary,
            })
        }
        for (const old of removed)
          if (!renamed.has(old.path))
            changedFiles.push({
              path: old.path,
              status: 'deleted',
              binary: old.binary,
            })
        for (const file of result.files) {
          const old = base.get(file.path)
          if (
            old &&
            (old.sha256 !== file.sha256 ||
              !!(old.mode & 0o111) !== !!(file.mode & 0o111))
          )
            changedFiles.push({
              path: file.path,
              status: 'modified',
              binary: file.binary || old.binary,
            })
        }
        let patch: string | undefined
        if (lease.snapshot && changedFiles.length) {
          const snapshots = new SnapshotService({
            runner: this.options.runner,
            tempRoot: join(this.options.root, 'snapshot-temp'),
            resources: this.options.mutations.resources,
          })
          const untracked = result.files.map((f) =>
            lease.snapshot!.prefix
              ? lease.snapshot!.prefix + '/' + f.path
              : f.path,
          )
          const snapshot = await snapshots.capture({
            id,
            cwd: record.cwd,
            base: 'snapshot',
            untracked,
          })
          const patchRoot = join(this.options.root, 'patches')
          mkdirSync(patchRoot, { recursive: true, mode: 0o700 })
          patch = join(patchRoot, id + '.patch')
          const paths = [
            ...new Set(
              changedFiles.flatMap((f) => [
                f.path,
                ...(f.oldPath ? [f.oldPath] : []),
              ]),
            ),
          ].map((p) =>
            lease.snapshot!.prefix ? lease.snapshot!.prefix + '/' + p : p,
          )
          await this.options.runner.execute(snapshot.repositoryRoot, [
            '--literal-pathspecs',
            'diff',
            '--binary',
            '--no-ext-diff',
            '--no-textconv',
            `--relative=${lease.snapshot.prefix}`,
            `--output=${patch}`,
            lease.snapshot.commit,
            snapshot.commit,
            '--',
            ...paths,
          ])
          if (lstatSync(patch).size > ARTIFACT_TOTAL_LIMIT)
            throw new DelegationError(
              'ARTIFACT_LIMIT',
              'binary diff exceeds bounded storage limit',
            )
        }
        const resultTreeDigest = artifactTreeDigest(result.files),
          after = await workspaceArtifacts(
            record.cwd,
            this.artifacts,
            this.options.runner,
          )
        if (artifactTreeDigest(after.files) !== resultTreeDigest)
          throw new DelegationError(
            'TREE_CHANGED',
            'workspace changed during artifact freeze',
          )
        const receipt: DelegationReceipt = {
          schemaVersion: 1,
          id,
          runId,
          delegationId: record.id,
          backend: record.backend,
          version:
            record.backend === 'claude-code'
              ? '2.1.281'
              : record.backend === 'codex'
                ? '0.153.4'
                : 'unknown',
          createdAt: Date.now(),
          cwd: record.cwd,
          originCwd: lease.snapshot
            ? join(lease.snapshot.repositoryRoot, lease.snapshot.prefix)
            : record.cwd,
          leaseId: lease.id,
          ...(lease.snapshot ? { baseCommit: lease.snapshot.commit } : {}),
          baseTreeDigest: artifactTreeDigest(baseFiles),
          resultTreeDigest,
          baseFiles,
          resultFiles: result.files,
          changedFiles: changedFiles.sort((a, b) =>
            a.path.localeCompare(b.path),
          ),
          excluded: result.excluded,
          ...(patch ? { patch } : {}),
          summary: run.summary ?? '',
          acceptance: 'unverified',
          unresolved: result.excluded
            .filter((x) => x.reason === 'unsupported-file')
            .map((x) => 'unsupported artifact: ' + x.path),
        }
        durableReplaceSync(this.path(id), JSON.stringify(receipt) + '\n')
        return receipt
      },
    )
  }
  get(id: string): DelegationReceipt {
    const value = JSON.parse(
      readFileSync(this.path(id), 'utf8'),
    ) as DelegationReceipt
    if (
      value.schemaVersion !== 1 ||
      value.id !== id ||
      !Array.isArray(value.baseFiles) ||
      !Array.isArray(value.resultFiles) ||
      artifactTreeDigest(value.baseFiles) !== value.baseTreeDigest ||
      artifactTreeDigest(value.resultFiles) !== value.resultTreeDigest
    )
      throw new DelegationError(
        'RECEIPT_CORRUPT',
        'receipt facts do not match their trees',
      )
    for (const file of [...value.baseFiles, ...value.resultFiles])
      this.artifacts.read(file)
    return value
  }
  readPatch(
    id: string,
    limit = 256 * 1024,
  ): { content: string; truncated: boolean } | null {
    const receipt = this.get(id)
    if (!receipt.patch) return null
    const expected = join(this.options.root, 'patches', id + '.patch')
    if (receipt.patch !== expected)
      throw new DelegationError(
        'RECEIPT_CORRUPT',
        'patch escaped its owned location',
      )
    const fd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile())
        throw new DelegationError(
          'RECEIPT_CORRUPT',
          'patch is not a regular file',
        )
      const size = Math.min(
        stat.size,
        Math.max(1, Math.min(256 * 1024, Math.floor(limit))),
      )
      const bytes = Buffer.alloc(size),
        length = readSync(fd, bytes, 0, size, 0)
      return {
        content: bytes.subarray(0, length).toString('utf8'),
        truncated: stat.size > length,
      }
    } finally {
      closeSync(fd)
    }
  }
  /** Trusted original Git binding, shared by source and projection verification. */
  verificationReadOnlyRoots(id: string, cwd: string): string[] {
    const receipt = this.get(id),
      { lease } = this.options.resolve(receipt.runId)
    const pointer = join(cwd, '.git')
    return [
      ...new Set([
        pointer,
        join(lease.path, '.git'),
        ...(lease.snapshot ? [lease.snapshot.commonDir] : []),
      ]),
    ]
  }
  async current(id: string): Promise<boolean> {
    const receipt = this.get(id),
      binding = this.options.resolve(receipt.runId)
    if (
      binding.record.id !== receipt.delegationId ||
      binding.record.cwd !== receipt.cwd ||
      (binding.record.currentRunId &&
        binding.record.currentRunId !== receipt.runId)
    )
      return false
    return (
      artifactTreeDigest(
        (
          await workspaceArtifacts(
            receipt.cwd,
            this.artifacts,
            this.options.runner,
          )
        ).files,
      ) === receipt.resultTreeDigest
    )
  }
  async treeDigestAt(cwd: string): Promise<string> {
    return artifactTreeDigest(
      (await workspaceArtifacts(cwd, this.artifacts, this.options.runner))
        .files,
    )
  }
  async filesAt(cwd: string): Promise<ArtifactFile[]> {
    return (await workspaceArtifacts(cwd, this.artifacts, this.options.runner))
      .files
  }
}
