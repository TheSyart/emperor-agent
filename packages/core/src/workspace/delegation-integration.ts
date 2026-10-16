import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  DelegationReceipts,
  ArtifactFile,
} from '../harness/delegation/receipts'
import { sha256, safeArtifactPath } from '../harness/delegation/artifacts'
import { DelegationError } from '../harness/delegation/types'
import {
  criteriaDigest,
  type DelegationAcceptance,
} from '../harness/delegation/acceptance'
import { durableReplaceSync } from '../store/persistence'
import type { WorkspaceMutationCoordinator } from './mutation-coordinator'
import type { HardenedGitRunner } from './git-runner'
export interface IntegrationBase {
  cwd: string
  head: string | null
  indexDigest: string | null
  treeDigest: string
}
export interface IntegrationPreview {
  schemaVersion: 1
  id: string
  revision: number
  receiptId: string
  acceptanceId: string
  status: 'ready' | 'needs_user' | 'applied'
  cwd: string
  target: IntegrationBase
  digest: string
  treeDigest: string
  conflicts: string[]
  operations: { path: string; before?: ArtifactFile; after?: ArtifactFile }[]
  verificationId?: string
  reason?: string
}
export interface IntegrationAuthorization {
  source: 'human' | 'host-plan'
  taskScopeId: string
  previewDigest: string
}
export interface IntegrationReceipt {
  id: string
  previewId: string
  status: 'applied' | 'rolled_back' | 'needs_user'
  files: string[]
  error?: string
  rollbackSkipped?: string[]
}
function same(
  a: ArtifactFile | undefined,
  b: ArtifactFile | undefined,
): boolean {
  return !a || !b
    ? a === b
    : a.sha256 === b.sha256 && !!(a.mode & 0o111) === !!(b.mode & 0o111)
}
function previewDigest(preview: IntegrationPreview): string {
  return sha256(
    JSON.stringify({
      id: preview.id,
      receiptId: preview.receiptId,
      acceptanceId: preview.acceptanceId,
      cwd: preview.cwd,
      target: preview.target,
      treeDigest: preview.treeDigest,
      operations: preview.operations,
      verificationId: preview.verificationId ?? null,
    }),
  )
}
export class DelegationIntegration {
  constructor(
    private readonly options: {
      root: string
      receipts: DelegationReceipts
      acceptance: DelegationAcceptance
      mutations: WorkspaceMutationCoordinator
      runner: HardenedGitRunner
      scope: (runId: string) => string
      canApply?: (runId: string) => boolean
      beforeInstall?: (index: number, path: string) => void
    },
  ) {}
  private path(id: string): string {
    if (!/^dpi-[a-f0-9-]+$/.test(id))
      throw new DelegationError(
        'INVALID_ID',
        'integration preview identity required',
      )
    return join(this.options.root, 'integrations', id, 'preview.json')
  }
  private save(preview: IntegrationPreview): void {
    preview.digest = previewDigest(preview)
    durableReplaceSync(this.path(preview.id), JSON.stringify(preview) + '\n')
  }
  private filePath(root: string, path: string): string {
    safeArtifactPath(path)
    const canonical = realpathSync(root)
    if (canonical !== resolve(root))
      throw new DelegationError(
        'INTEGRATION_CONFLICT',
        'workspace root changed its canonical identity',
      )
    let current = canonical
    for (const part of path.split('/')) {
      current = join(current, part)
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new DelegationError(
            'INTEGRATION_CONFLICT',
            'target path changed into a symlink',
          )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return join(canonical, path)
  }
  private read(root: string, path: string): ArtifactFile | undefined {
    const absolute = this.filePath(root, path)
    if (!existsSync(absolute)) return undefined
    const stat = lstatSync(absolute)
    if (!stat.isFile())
      throw new DelegationError(
        'INTEGRATION_CONFLICT',
        'target is no longer a regular file',
      )
    return this.options.receipts.artifacts.put(
      path,
      readFileSync(absolute),
      stat.mode,
    )
  }
  private install(
    root: string,
    path: string,
    file: ArtifactFile | undefined,
  ): void {
    const absolute = this.filePath(root, path)
    if (!file) {
      rmSync(absolute, { force: true })
      return
    }
    mkdirSync(dirname(absolute), { recursive: true })
    const temporary = join(dirname(absolute), '.emperor-apply-' + randomUUID())
    try {
      writeFileSync(temporary, this.options.receipts.artifacts.read(file), {
        flag: 'wx',
        mode: file.mode,
      })
      chmodSync(temporary, file.mode)
      renameSync(temporary, absolute)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  async captureBase(cwd: string): Promise<IntegrationBase> {
    const canonical = realpathSync(cwd),
      probe = await this.options.runner.execute(
        canonical,
        ['rev-parse', '--show-toplevel'],
        { allowedExitCodes: [0, 128] },
      )
    let head: string | null = null,
      indexDigest: string | null = null
    if (probe.exitCode === 0) {
      head = (
        await this.options.runner.execute(canonical, [
          'rev-parse',
          '--verify',
          'HEAD',
        ])
      ).stdout.trim()
      const index = resolve(
        canonical,
        (
          await this.options.runner.execute(canonical, [
            'rev-parse',
            '--git-path',
            'index',
          ])
        ).stdout.trim(),
      )
      indexDigest = existsSync(index) ? sha256(readFileSync(index)) : 'missing'
    }
    return {
      cwd: canonical,
      head,
      indexDigest,
      treeDigest: await this.options.receipts.treeDigestAt(canonical),
    }
  }
  async previewIntegration(
    receiptId: string,
    expectedBase: IntegrationBase,
    acceptanceId: string,
  ): Promise<IntegrationPreview> {
    const receipt = this.options.receipts.get(receiptId),
      accepted = await this.options.acceptance.current(acceptanceId)
    if (
      accepted.receiptId !== receiptId ||
      accepted.state !== 'passed' ||
      !accepted.criteria?.commands.length
    )
      throw new DelegationError(
        'ACCEPTANCE_REQUIRED',
        'integration requires current host-verified criteria',
      )
    if (realpathSync(expectedBase.cwd) !== realpathSync(receipt.originCwd))
      throw new DelegationError(
        'PERMISSION_DENIED',
        'target is not the original workspace of this receipt',
      )
    return this.options.mutations.runExclusive(
      expectedBase.cwd,
      'agent',
      async () => {
        const target = await this.captureBase(expectedBase.cwd)
        if (JSON.stringify(target) !== JSON.stringify(expectedBase))
          throw new DelegationError(
            'INTEGRATION_CONFLICT',
            'target changed before preview',
          )
        const id = 'dpi-' + randomUUID(),
          directory = join(this.options.root, 'integrations', id),
          workspace = join(directory, 'workspace')
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        let cwd = workspace,
          contextRoot = target.cwd
        if (target.head) {
          const repositoryRoot = realpathSync(
              (
                await this.options.runner.execute(target.cwd, [
                  'rev-parse',
                  '--show-toplevel',
                ])
              ).stdout.trim(),
            ),
            commonDir = realpathSync(
              resolve(
                target.cwd,
                (
                  await this.options.runner.execute(target.cwd, [
                    'rev-parse',
                    '--git-common-dir',
                  ])
                ).stdout.trim(),
              ),
            ),
            lock = await this.options.mutations.resources.acquire({
              keys: ['git:' + commonDir],
              mode: 'exclusive',
              owner: id,
            })
          try {
            await this.options.runner.execute(repositoryRoot, [
              'worktree',
              'add',
              '--detach',
              '--no-checkout',
              workspace,
              target.head,
            ])
          } finally {
            lock.release()
          }
          contextRoot = repositoryRoot
          cwd = join(workspace, relative(repositoryRoot, target.cwd))
          mkdirSync(cwd, { recursive: true })
          const sourceIndex = resolve(
              target.cwd,
              (
                await this.options.runner.execute(target.cwd, [
                  'rev-parse',
                  '--git-path',
                  'index',
                ])
              ).stdout.trim(),
            ),
            previewIndex = resolve(
              cwd,
              (
                await this.options.runner.execute(cwd, [
                  'rev-parse',
                  '--git-path',
                  'index',
                ])
              ).stdout.trim(),
            )
          if (existsSync(sourceIndex)) {
            mkdirSync(dirname(previewIndex), { recursive: true })
            writeFileSync(previewIndex, readFileSync(sourceIndex), {
              mode: 0o600,
            })
          }
        } else mkdirSync(cwd, { recursive: true, mode: 0o700 })
        cwd = realpathSync(cwd)
        const targetFiles = await this.options.receipts.filesAt(target.cwd)
        const contextFiles =
          contextRoot === target.cwd
            ? targetFiles
            : await this.options.receipts.filesAt(contextRoot)
        for (const file of contextFiles)
          this.install(realpathSync(workspace), file.path, file)
        const base = new Map(
            receipt.baseFiles.map((file) => [file.path, file]),
          ),
          result = new Map(
            receipt.resultFiles.map((file) => [file.path, file]),
          ),
          current = new Map(targetFiles.map((file) => [file.path, file])),
          conflicts: string[] = [],
          operations: IntegrationPreview['operations'] = []
        for (const path of [
          ...new Set([...base.keys(), ...result.keys()]),
        ].sort()) {
          const before = base.get(path),
            after = result.get(path),
            ours = current.get(path)
          if (same(before, after) || same(ours, after)) continue
          let merged = after
          if (!same(ours, before)) {
            if (
              !before ||
              !after ||
              !ours ||
              before.binary ||
              after.binary ||
              ours.binary
            ) {
              conflicts.push(path)
              continue
            }
            const merge = join(directory, 'merge', randomUUID())
            mkdirSync(merge, { recursive: true, mode: 0o700 })
            const oursPath = join(merge, 'current'),
              basePath = join(merge, 'base'),
              resultPath = join(merge, 'result')
            writeFileSync(oursPath, this.options.receipts.artifacts.read(ours))
            writeFileSync(
              basePath,
              this.options.receipts.artifacts.read(before),
            )
            writeFileSync(
              resultPath,
              this.options.receipts.artifacts.read(after),
            )
            const command = await this.options.runner.execute(
              merge,
              [
                'merge-file',
                '--diff3',
                '-L',
                'current target',
                '-L',
                'delegation base',
                '-L',
                'external result',
                oursPath,
                basePath,
                resultPath,
              ],
              { allowedExitCodes: Array.from({ length: 128 }, (_, i) => i) },
            )
            if (command.exitCode !== 0) {
              conflicts.push(path)
              continue
            }
            merged = this.options.receipts.artifacts.put(
              path,
              readFileSync(oursPath),
              (ours.mode & ~0o111) | (after.mode & 0o111),
            )
          } else if (merged && ours)
            merged = {
              ...merged,
              mode: (ours.mode & ~0o111) | (merged.mode & 0o111),
            }
          this.install(cwd, path, merged)
          operations.push({
            path,
            ...(ours ? { before: ours } : {}),
            ...(merged ? { after: merged } : {}),
          })
        }
        const preview: IntegrationPreview = {
          schemaVersion: 1,
          id,
          revision: 1,
          receiptId,
          acceptanceId,
          status: 'needs_user',
          cwd,
          target,
          digest: '',
          treeDigest: await this.options.receipts.treeDigestAt(cwd),
          conflicts,
          operations,
        }
        if (conflicts.length) preview.reason = 'MERGE_CONFLICT'
        else {
          const verified = await this.options.acceptance.validateProjection(
            receiptId,
            { cwd, treeDigest: preview.treeDigest },
            accepted.criteria!,
            {
              source: 'host-plan',
              taskScopeId: this.options.scope(receipt.runId),
              criteriaDigest: criteriaDigest(accepted.criteria!),
              reviewedTreeDigest: accepted.treeDigest,
            },
          )
          preview.verificationId = verified.id
          if (verified.state === 'passed') preview.status = 'ready'
          else
            preview.reason =
              'PREVIEW_VERIFICATION_' + verified.state.toUpperCase()
        }
        this.save(preview)
        return preview
      },
    )
  }
  get(id: string): IntegrationPreview {
    const preview = JSON.parse(
      readFileSync(this.path(id), 'utf8'),
    ) as IntegrationPreview
    if (
      preview.schemaVersion !== 1 ||
      preview.id !== id ||
      preview.digest !== previewDigest(preview) ||
      !Array.isArray(preview.operations)
    )
      throw new DelegationError('PREVIEW_CORRUPT', 'integration facts changed')
    const root = realpathSync(
        join(this.options.root, 'integrations', id, 'workspace'),
      ),
      cwd = realpathSync(preview.cwd),
      rel = relative(root, cwd)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
      throw new DelegationError(
        'PREVIEW_CORRUPT',
        'integration workspace escaped its ownership root',
      )
    return preview
  }
  /** Interrupted writes require inspection; startup never replays or rolls back them. */
  reconcile(): { previewId: string; status: 'needs_user' }[] {
    const root = join(this.options.root, 'integrations')
    if (!existsSync(root)) return []
    const recovered: { previewId: string; status: 'needs_user' }[] = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^dpi-[a-f0-9-]+$/.test(entry.name)) continue
      const preview = this.get(entry.name)
      if (preview.reason !== 'APPLY_IN_PROGRESS') continue
      preview.status = 'needs_user'
      preview.reason = 'APPLY_INTERRUPTED'
      this.save(preview)
      recovered.push({ previewId: preview.id, status: 'needs_user' })
    }
    return recovered
  }
  async applyIntegration(
    previewId: string,
    expectedRevision: number,
    authorization: IntegrationAuthorization,
  ): Promise<IntegrationReceipt> {
    const preview = this.get(previewId),
      source = this.options.receipts.get(preview.receiptId)
    if (!this.options.canApply?.(source.runId))
      throw new DelegationError(
        'PERMISSION_DENIED',
        'current task permission does not authorize writing the target workspace',
      )
    if (
      !['human', 'host-plan'].includes(authorization.source) ||
      authorization.taskScopeId !== this.options.scope(source.runId) ||
      authorization.previewDigest !== preview.digest
    )
      throw new DelegationError(
        'PERMISSION_DENIED',
        'applying needs authorization for this exact preview and task scope',
      )
    if (preview.revision !== expectedRevision)
      throw new DelegationError('STALE_REVISION', 'preview revision changed')
    if (
      preview.status !== 'ready' ||
      !preview.verificationId ||
      (await this.options.acceptance.current(preview.verificationId)).state !==
        'passed' ||
      (await this.options.acceptance.current(preview.acceptanceId)).state !==
        'passed'
    )
      throw new DelegationError(
        'ACCEPTANCE_REQUIRED',
        'source and preview must remain verified',
      )
    if (realpathSync(preview.target.cwd) !== realpathSync(source.originCwd))
      throw new DelegationError(
        'PERMISSION_DENIED',
        'integration target no longer matches the source owner',
      )
    return this.options.mutations.runExclusive(
      preview.target.cwd,
      'agent',
      async () => {
        if (!this.options.canApply?.(source.runId))
          throw new DelegationError(
            'PERMISSION_DENIED',
            'target write permission was revoked while waiting',
          )
        const fresh = this.get(previewId)
        if (fresh.revision !== expectedRevision || fresh.status !== 'ready')
          throw new DelegationError(
            'STALE_REVISION',
            'preview was already consumed',
          )
        const current = await this.captureBase(preview.target.cwd)
        if (
          current.head !== preview.target.head ||
          current.indexDigest !== preview.target.indexDigest
        )
          throw new DelegationError(
            'INTEGRATION_CONFLICT',
            'target HEAD or index changed',
          )
        for (const operation of preview.operations)
          if (!same(this.read(current.cwd, operation.path), operation.before))
            throw new DelegationError(
              'INTEGRATION_CONFLICT',
              'target file changed since preview: ' + operation.path,
            )
        const receipt: IntegrationReceipt = {
            id: 'dir-' + randomUUID(),
            previewId,
            status: 'applied',
            files: [],
            rollbackSkipped: [],
          },
          installed: IntegrationPreview['operations'] = []
        preview.revision++
        preview.status = 'needs_user'
        preview.reason = 'APPLY_IN_PROGRESS'
        this.save(preview)
        durableReplaceSync(
          join(
            this.options.root,
            'integrations',
            previewId,
            'apply-intent.json',
          ),
          JSON.stringify({
            schemaVersion: 1,
            receipt,
            operations: preview.operations,
          }) + '\n',
        )
        try {
          for (let i = 0; i < preview.operations.length; i++) {
            const operation = preview.operations[i]!
            this.options.beforeInstall?.(i, operation.path)
            if (!this.options.canApply?.(source.runId))
              throw new DelegationError(
                'PERMISSION_DENIED',
                'target write permission was revoked during integration',
              )
            if (!same(this.read(current.cwd, operation.path), operation.before))
              throw new DelegationError(
                'INTEGRATION_CONFLICT',
                'target changed while applying: ' + operation.path,
              )
            this.install(current.cwd, operation.path, operation.after)
            installed.push(operation)
            receipt.files.push(operation.path)
          }
          preview.status = 'applied'
          delete preview.reason
        } catch (error) {
          receipt.status = 'rolled_back'
          receipt.error =
            error instanceof Error ? error.message : 'integration failed'
          for (const operation of installed.reverse()) {
            try {
              if (
                !same(this.read(current.cwd, operation.path), operation.after)
              ) {
                receipt.rollbackSkipped!.push(operation.path)
                continue
              }
              this.install(current.cwd, operation.path, operation.before)
            } catch {
              receipt.rollbackSkipped!.push(operation.path)
            }
          }
          if (receipt.rollbackSkipped!.length) receipt.status = 'needs_user'
          preview.reason =
            receipt.status === 'rolled_back'
              ? 'APPLY_ROLLED_BACK'
              : 'ROLLBACK_NEEDS_USER'
        }
        this.save(preview)
        durableReplaceSync(
          join(
            this.options.root,
            'integrations',
            previewId,
            receipt.id + '.json',
          ),
          JSON.stringify(receipt) + '\n',
        )
        return receipt
      },
    )
  }
}
