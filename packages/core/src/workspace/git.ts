import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import {
  resolveOwnedProject,
  WorkspaceOperationError,
  type ResolveWorkspaceProject,
} from './common'
import {
  GitRepositoryResolver,
  type GitRepositoryIdentity,
  type GitTransientState,
} from './git-repository'
import {
  HardenedGitRunner,
  sanitizeGitError,
  type GitCommandRequest,
  type GitCommandResult,
  type GitRuntime,
} from './git-runner'
import { GitWorktreeManager, type WorkspaceBindingStore } from './git-worktrees'
import {
  type GitOperationReceipt,
  GitOperationReceiptStore,
} from './git-receipts'
import {
  GitPullRequestService,
  type PullRequestContext,
} from './git-pull-requests'

export type {
  GitCommandRequest,
  GitCommandResult,
  GitRuntime,
} from './git-runner'

interface GitRepositoryContext {
  projectRoot: string
  repositoryRoot: string
  repositoryPrefix: string
  identity: GitRepositoryIdentity
}

export interface GitFileStatus {
  path: string
  originalPath?: string
  index: string
  worktree: string
  conflict: boolean
  untracked: boolean
  additions?: number
  deletions?: number
  binary?: boolean
}

export interface GitStatusResult {
  repository: {
    root: string
    commonDir: string
    worktreeRoot: string
    branch: string | null
    headOid: string | null
    defaultBranch: string | null
    detached: boolean
    unborn: boolean
    objectFormat: 'sha1' | 'sha256'
    transientState: GitTransientState
  }
  root: string
  branch: string | null
  head: string | null
  upstream: string | null
  detached: boolean
  ahead: number
  behind: number
  files: GitFileStatus[]
  summary: {
    changedFiles: number
    additions: number
    deletions: number
    untracked: number
    binary: number
  }
  truncated: boolean
  revision: string
}

export type ParsedPorcelainV2 = Omit<
  GitStatusResult,
  'repository' | 'root' | 'revision' | 'summary' | 'truncated'
>

export interface WorkspaceGitServiceOptions {
  resolveProject: ResolveWorkspaceProject
  resolveRuntime: (projectRoot: string) => Promise<GitRuntime>
  run: (request: GitCommandRequest) => Promise<GitCommandResult>
  checkpoint?: <T>(input: {
    sessionId: string
    projectRoot: string
    paths: string[]
    effect: () => Promise<T>
  }) => Promise<T>
  hasActiveWriter?: (sessionId: string) => boolean
  stateRoot?: string
  bindings?: WorkspaceBindingStore
  receipts?: GitOperationReceiptStore
  emitReceipt?: (
    sessionId: string,
    receipt: GitOperationReceipt,
  ) => Promise<void> | void
  resolveGhRuntime?: (projectRoot: string) => Promise<GitRuntime | null>
  runGh?: (request: GitCommandRequest) => Promise<GitCommandResult>
}

export class WorkspaceGitService {
  private readonly runner: HardenedGitRunner
  private readonly resolver: GitRepositoryResolver
  private readonly worktreeManager: GitWorktreeManager | null
  private readonly receipts: GitOperationReceiptStore | null
  private readonly pullRequests: GitPullRequestService

  constructor(private readonly options: WorkspaceGitServiceOptions) {
    this.runner = new HardenedGitRunner({
      resolveRuntime: options.resolveRuntime,
      run: options.run,
      ...(options.stateRoot
        ? { privateHome: resolve(options.stateRoot, 'git', 'runtime-home') }
        : {}),
    })
    this.resolver = new GitRepositoryResolver({
      execute: (cwd, args, commandOptions) =>
        this.runner.execute(cwd, args, commandOptions),
    })
    this.worktreeManager =
      options.stateRoot && options.bindings
        ? new GitWorktreeManager({
            stateRoot: options.stateRoot,
            bindings: options.bindings,
            resolver: this.resolver,
            execute: (cwd, args, commandOptions) =>
              this.runner.execute(cwd, args, commandOptions),
            hasActiveWriter: options.hasActiveWriter,
          })
        : null
    this.receipts = options.receipts ?? null
    this.pullRequests = new GitPullRequestService({
      resolveRuntime: options.resolveGhRuntime ?? (async () => null),
      run:
        options.runGh ??
        (async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'GitHub CLI unavailable',
        })),
      context: (sessionId) => this.pullRequestContext(sessionId),
      git: (cwd, args, commandOptions) =>
        this.command(cwd, args, commandOptions),
      record: (sessionId, receipt) => this.recordReceipt(sessionId, receipt),
    })
  }

  async repository(input: { sessionId: string }) {
    const scope = resolveOwnedProject(
      this.options.resolveProject,
      input.sessionId,
    )
    return await this.resolver.resolve(scope.projectRoot)
  }

  async log(input: {
    sessionId: string
    baseRef?: string
    limit?: number
  }): Promise<{
    commits: Array<{
      oid: string
      parents: string[]
      authoredAt: string
      author: string
      subject: string
    }>
    truncated: boolean
  }> {
    const scope = resolveOwnedProject(
      this.options.resolveProject,
      input.sessionId,
    )
    const context = await this.repositoryContext(scope.projectRoot)
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)))
    const ref = validateRef(input.baseRef || 'HEAD')
    const result = await this.command(context.repositoryRoot, [
      'log',
      '-z',
      `--max-count=${limit + 1}`,
      '--format=%H%x00%P%x00%aI%x00%an%x00%s',
      ref,
    ])
    const records = result.stdout.split('\0')
    const commits: Array<{
      oid: string
      parents: string[]
      authoredAt: string
      author: string
      subject: string
    }> = []
    for (let index = 0; index + 4 < records.length; index += 5) {
      const oid = records[index]?.trim()
      if (!oid) continue
      commits.push({
        oid,
        parents: (records[index + 1] || '').split(' ').filter(Boolean),
        authoredAt: records[index + 2] || '',
        author: records[index + 3] || '',
        subject: records[index + 4] || '',
      })
    }
    return {
      commits: commits.slice(0, limit),
      truncated: commits.length > limit || Boolean(result.stdoutTruncated),
    }
  }

  async status(input: { sessionId: string }): Promise<GitStatusResult> {
    const scope = resolveOwnedProject(
      this.options.resolveProject,
      input.sessionId,
    )
    const context = await this.repositoryContext(scope.projectRoot)
    const args = [
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
      '--untracked-files=all',
    ]
    if (context.repositoryPrefix) args.push('--', context.repositoryPrefix)
    const result = await this.command(context.repositoryRoot, args)
    const parsed = scopePorcelain(
      parsePorcelainV2(result.stdout),
      context.repositoryPrefix,
    )
    const lineChanges = await this.lineChangeSummary(context)
    const files = await this.attachLineChanges(
      context,
      parsed.files,
      lineChanges.files,
    )
    return {
      repository: {
        root: context.identity.worktreeRoot,
        commonDir: context.identity.commonDir,
        worktreeRoot: context.identity.worktreeRoot,
        branch: context.identity.branch,
        headOid: context.identity.headOid,
        defaultBranch: context.identity.defaultBranch,
        detached: context.identity.detached,
        unborn: context.identity.unborn,
        objectFormat: context.identity.objectFormat,
        transientState: context.identity.transientState,
      },
      root: context.projectRoot,
      ...parsed,
      branch: context.identity.branch,
      head: context.identity.headOid,
      detached: context.identity.detached,
      files,
      summary: {
        changedFiles: files.length,
        additions: files.reduce(
          (total, file) => total + (file.additions || 0),
          0,
        ),
        deletions: files.reduce(
          (total, file) => total + (file.deletions || 0),
          0,
        ),
        untracked: files.filter((file) => file.untracked).length,
        binary: files.filter((file) => file.binary).length,
      },
      truncated: Boolean(result.stdoutTruncated || lineChanges.truncated),
      revision: revisionFor(
        `${result.stdout}\0${context.identity.headOid || ''}\0${context.identity.transientState}\0${workingTreeFingerprint(context, files)}`,
      ),
    }
  }

  private async lineChangeSummary(context: GitRepositoryContext): Promise<{
    additions: number
    deletions: number
    files: Map<
      string,
      { additions: number; deletions: number; binary: boolean }
    >
    truncated: boolean
  }> {
    const args = ['diff', '--numstat', '-z', 'HEAD']
    if (context.repositoryPrefix) args.push('--', context.repositoryPrefix)
    const combined = await this.command(context.repositoryRoot, args, {
      allowedExitCodes: [0, 128],
    })
    if (combined.exitCode === 0)
      return {
        ...summarizeNumstat(parseNumstatByPath(combined.stdout), context),
        truncated: Boolean(combined.stdoutTruncated),
      }

    const stagedArgs = ['diff', '--cached', '--numstat', '-z']
    const worktreeArgs = ['diff', '--numstat', '-z']
    if (context.repositoryPrefix) {
      stagedArgs.push('--', context.repositoryPrefix)
      worktreeArgs.push('--', context.repositoryPrefix)
    }
    const [staged, worktree] = await Promise.all([
      this.command(context.repositoryRoot, stagedArgs),
      this.command(context.repositoryRoot, worktreeArgs),
    ])
    return {
      ...summarizeNumstat(
        mergeNumstatByPath(
          parseNumstatByPath(staged.stdout),
          parseNumstatByPath(worktree.stdout),
        ),
        context,
      ),
      truncated: Boolean(staged.stdoutTruncated || worktree.stdoutTruncated),
    }
  }

  private async attachLineChanges(
    context: GitRepositoryContext,
    files: GitFileStatus[],
    changes: Map<
      string,
      { additions: number; deletions: number; binary: boolean }
    >,
  ): Promise<GitFileStatus[]> {
    return files.map((file) => {
      const tracked = changes.get(file.path)
      if (tracked)
        return {
          ...file,
          additions: tracked.additions,
          deletions: tracked.deletions,
          binary: tracked.binary,
        }
      if (!file.untracked)
        return { ...file, additions: 0, deletions: 0, binary: false }
      const stats = untrackedFileStats(resolve(context.projectRoot, file.path))
      return { ...file, ...stats }
    })
  }

  async diff(input: {
    sessionId: string
    path?: string
    area: 'worktree' | 'staged' | 'compare'
    baseRef?: string
  }): Promise<{ content: string; truncated: boolean }> {
    const scope = resolveOwnedProject(
      this.options.resolveProject,
      input.sessionId,
    )
    const context = await this.repositoryContext(scope.projectRoot)
    const args = ['diff', '--no-ext-diff', '--no-color']
    if (input.area === 'staged') args.push('--cached')
    if (input.area === 'compare') {
      if (!input.baseRef) invalidGitArgument('缺少比较分支。')
      args.push(`${validateRef(input.baseRef)}...HEAD`)
    }
    if (input.path)
      args.push('--', repositoryPath(context, validatePath(input.path)))
    else if (context.repositoryPrefix) args.push('--', context.repositoryPrefix)
    const result = await this.command(context.repositoryRoot, args)
    const maxLength = 2 * 1024 * 1024
    return {
      content:
        result.stdout.length > maxLength
          ? result.stdout.slice(-maxLength)
          : result.stdout,
      truncated: Boolean(
        result.stdoutTruncated || result.stdout.length > maxLength,
      ),
    }
  }

  async branches(input: { sessionId: string }): Promise<{
    current: string | null
    branches: Array<{ name: string; head: string; upstream: string | null }>
  }> {
    const scope = resolveOwnedProject(
      this.options.resolveProject,
      input.sessionId,
    )
    const context = await this.repositoryContext(scope.projectRoot)
    const result = await this.command(context.repositoryRoot, [
      'for-each-ref',
      '--format=%(HEAD)%00%(refname:short)%00%(objectname)%00%(upstream:short)',
      'refs/heads',
    ])
    if (result.stdoutTruncated) gitOutputTooLarge('分支列表')
    const branches = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [marker, name = '', head = '', upstream = ''] = line.split('\0')
        return { marker, name, head, upstream: upstream || null }
      })
    return {
      current: branches.find((branch) => branch.marker === '*')?.name ?? null,
      branches: branches.map(({ name, head, upstream }) => ({
        name,
        head,
        upstream,
      })),
    }
  }

  async compare(input: {
    sessionId: string
    baseRef: string
    headRef?: string
  }): Promise<{
    ahead: number
    behind: number
    diff: string
    truncated: boolean
  }> {
    const scope = resolveOwnedProject(
      this.options.resolveProject,
      input.sessionId,
    )
    const context = await this.repositoryContext(scope.projectRoot)
    const base = validateRef(input.baseRef)
    const head = validateRef(input.headRef ?? 'HEAD')
    const counts = await this.command(context.repositoryRoot, [
      'rev-list',
      '--left-right',
      '--count',
      `${base}...${head}`,
    ])
    if (counts.stdoutTruncated) gitOutputTooLarge('分支比较结果')
    const [behind = 0, ahead = 0] = counts.stdout
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10) || 0)
    const diffArgs = [
      'diff',
      '--no-ext-diff',
      '--no-color',
      `${base}...${head}`,
    ]
    if (context.repositoryPrefix) diffArgs.push('--', context.repositoryPrefix)
    const diff = await this.command(context.repositoryRoot, diffArgs)
    const maxLength = 2 * 1024 * 1024
    return {
      ahead,
      behind,
      diff:
        diff.stdout.length > maxLength
          ? diff.stdout.slice(-maxLength)
          : diff.stdout,
      truncated: Boolean(
        diff.stdoutTruncated || diff.stdout.length > maxLength,
      ),
    }
  }

  async ignoredPaths(input: {
    sessionId: string
    paths: string[]
  }): Promise<Set<string>> {
    if (!input.paths.length) return new Set()
    const scope = resolveOwnedProject(
      this.options.resolveProject,
      input.sessionId,
    )
    const context = await this.repositoryContext(scope.projectRoot)
    const paths = input.paths
      .map(validatePath)
      .map((path) => repositoryPath(context, path))
    const result = await this.command(
      context.repositoryRoot,
      ['check-ignore', '-z', '--stdin'],
      {
        stdin: `${paths.join('\0')}\0`,
        allowedExitCodes: [0, 1],
      },
    )
    if (result.stdoutTruncated) gitOutputTooLarge('Git ignored 列表')
    return new Set(
      result.stdout
        .split('\0')
        .filter(Boolean)
        .map((path) => projectPath(context, path))
        .filter((path): path is string => path !== null),
    )
  }

  async stage(input: {
    sessionId: string
    paths: string[]
    expectedRevision: string
  }): Promise<GitStatusResult> {
    this.requireNoWriter(input.sessionId)
    const paths = validatePaths(input.paths)
    const current = await this.requireRevision(
      input.sessionId,
      input.expectedRevision,
    )
    const context = await this.repositoryContext(current.root)
    await this.command(context.repositoryRoot, [
      'add',
      '--',
      ...paths.map((path) => repositoryPath(context, path)),
    ])
    return this.status({ sessionId: input.sessionId })
  }

  async unstage(input: {
    sessionId: string
    paths: string[]
    expectedRevision: string
  }): Promise<GitStatusResult> {
    this.requireNoWriter(input.sessionId)
    const paths = validatePaths(input.paths)
    const current = await this.requireRevision(
      input.sessionId,
      input.expectedRevision,
    )
    const context = await this.repositoryContext(current.root)
    const expandedPaths = expandStatusPaths(current.files, paths)
    await this.command(context.repositoryRoot, [
      'reset',
      '--',
      ...expandedPaths.map((path) => repositoryPath(context, path)),
    ])
    return this.status({ sessionId: input.sessionId })
  }

  async discard(input: {
    sessionId: string
    paths: string[]
    expectedRevision: string
    confirmed: true
  }): Promise<GitStatusResult> {
    requireConfirmed(input.confirmed)
    this.requireNoWriter(input.sessionId)
    const paths = validatePaths(input.paths)
    const current = await this.requireRevision(
      input.sessionId,
      input.expectedRevision,
    )
    const selected = paths.map((path) => {
      const file = current.files.find((entry) => entry.path === path)
      if (!file) invalidGitArgument(`文件不在当前 Git 变更集中：${path}`)
      return file
    })
    const untracked = new Set(
      selected.filter((file) => file.untracked).map((file) => file.path),
    )
    const trackedPaths = paths.filter((path) => !untracked.has(path))
    const context = await this.repositoryContext(current.root)
    const effect = async () => {
      if (trackedPaths.length)
        await this.command(context.repositoryRoot, [
          'restore',
          '--worktree',
          '--',
          ...expandStatusPaths(current.files, trackedPaths).map((path) =>
            repositoryPath(context, path),
          ),
        ])
      for (const path of untracked)
        await rm(resolve(current.root, path), {
          force: false,
          recursive: true,
        })
    }
    if (this.options.checkpoint)
      await this.options.checkpoint({
        sessionId: input.sessionId,
        projectRoot: current.root,
        paths,
        effect,
      })
    else await effect()
    return this.status({ sessionId: input.sessionId })
  }

  async commit(input: {
    sessionId: string
    message: string
    expectedRevision: string
  }): Promise<GitStatusResult> {
    this.requireNoWriter(input.sessionId)
    const message = input.message.trim()
    if (!message || message.length > 10_000)
      invalidGitArgument('提交信息不合法。')
    const current = await this.requireRevision(
      input.sessionId,
      input.expectedRevision,
    )
    const context = await this.repositoryContext(current.root)
    this.requireStableRepository(context, '提交')
    await this.assertNoStagedOutsideScope(context)
    await this.command(context.repositoryRoot, ['commit', '-m', message])
    const next = await this.status({ sessionId: input.sessionId })
    await this.recordReceipt(input.sessionId, {
      action: 'commit',
      ...(next.branch ? { branch: next.branch } : {}),
      ...(next.head ? { commitOid: next.head } : {}),
      completedAt: Date.now(),
    })
    return next
  }

  async fetch(input: {
    sessionId: string
    confirmed: true
  }): Promise<GitStatusResult> {
    requireConfirmed(input.confirmed)
    const scope = resolveOwnedProject(
      this.options.resolveProject,
      input.sessionId,
    )
    const context = await this.repositoryContext(scope.projectRoot)
    await this.command(context.repositoryRoot, ['fetch', '--prune'], {
      network: true,
    })
    return this.status({ sessionId: input.sessionId })
  }

  async pull(input: {
    sessionId: string
    expectedRevision: string
    confirmed: true
  }): Promise<GitStatusResult> {
    requireConfirmed(input.confirmed)
    this.requireNoWriter(input.sessionId)
    const current = await this.requireRevision(
      input.sessionId,
      input.expectedRevision,
    )
    const context = await this.repositoryContext(current.root)
    this.requireRepositoryWideProject(context, '拉取')
    this.requireStableRepository(context, '拉取')
    await this.command(context.repositoryRoot, ['pull', '--ff-only'], {
      network: true,
    })
    const next = await this.status({ sessionId: input.sessionId })
    await this.recordReceipt(input.sessionId, {
      action: 'pull',
      ...(next.branch ? { branch: next.branch } : {}),
      ...(next.head ? { commitOid: next.head } : {}),
      completedAt: Date.now(),
    })
    return next
  }

  async push(input: {
    sessionId: string
    expectedRevision: string
    setUpstream?: boolean
    confirmed: true
  }): Promise<GitStatusResult> {
    requireConfirmed(input.confirmed)
    this.requireNoWriter(input.sessionId)
    const status = await this.requireRevision(
      input.sessionId,
      input.expectedRevision,
    )
    const context = await this.repositoryContext(status.root)
    this.requireStableRepository(context, '推送')
    const args = ['push']
    if (input.setUpstream) {
      if (!status.branch) invalidGitArgument('游离 HEAD 无法设置上游分支。')
      args.push('--set-upstream', 'origin', status.branch)
    }
    await this.command(context.repositoryRoot, args, { network: true })
    const next = await this.status({ sessionId: input.sessionId })
    const remote = await this.command(
      context.repositoryRoot,
      ['remote', 'get-url', 'origin'],
      { allowedExitCodes: [0, 2] },
    )
    await this.recordReceipt(input.sessionId, {
      action: 'push',
      ...(next.branch ? { branch: next.branch } : {}),
      ...(next.head ? { commitOid: next.head } : {}),
      ...(remoteHost(remote.stdout)
        ? { remoteHost: remoteHost(remote.stdout)! }
        : {}),
      completedAt: Date.now(),
    })
    return next
  }

  async createBranch(input: {
    sessionId: string
    name: string
    expectedRevision: string
    startPoint?: string
  }): Promise<GitStatusResult> {
    this.requireNoWriter(input.sessionId)
    const current = await this.requireRevision(
      input.sessionId,
      input.expectedRevision,
    )
    const context = await this.repositoryContext(current.root)
    this.requireStableRepository(context, '创建分支')
    const args = ['branch', validateRef(input.name)]
    if (input.startPoint) args.push(validateRef(input.startPoint))
    await this.command(context.repositoryRoot, args)
    return this.status({ sessionId: input.sessionId })
  }

  async switchBranch(input: {
    sessionId: string
    name: string
    expectedRevision: string
    confirmed: true
  }): Promise<GitStatusResult> {
    requireConfirmed(input.confirmed)
    this.requireNoWriter(input.sessionId)
    const current = await this.requireRevision(
      input.sessionId,
      input.expectedRevision,
    )
    const context = await this.repositoryContext(current.root)
    this.requireRepositoryWideProject(context, '切换分支')
    this.requireStableRepository(context, '切换分支')
    await this.command(context.repositoryRoot, [
      'switch',
      validateRef(input.name),
    ])
    const next = await this.status({ sessionId: input.sessionId })
    await this.recordReceipt(input.sessionId, {
      action: 'switch_branch',
      ...(next.branch ? { branch: next.branch } : {}),
      ...(next.head ? { commitOid: next.head } : {}),
      completedAt: Date.now(),
    })
    return next
  }

  async worktrees(input: { sessionId: string }) {
    const manager = this.requireWorktreeManager()
    const scope = resolveOwnedProject(
      this.options.resolveProject,
      input.sessionId,
    )
    return await manager.list(input.sessionId, scope.projectRoot)
  }

  async enterWorktree(input: {
    sessionId: string
    name?: string
    startPoint?: string
    expectedRevision: string
    confirmed: true
  }) {
    const manager = this.requireWorktreeManager()
    this.requireNoWriter(input.sessionId)
    const current = await this.requireRevision(
      input.sessionId,
      input.expectedRevision,
    )
    const worktree = await manager.enter({
      ...input,
      projectRoot: current.root,
    })
    await this.recordReceipt(input.sessionId, {
      action: 'create_worktree',
      ...(worktree.branch ? { branch: worktree.branch } : {}),
      ...(worktree.head ? { commitOid: worktree.head } : {}),
      completedAt: Date.now(),
    })
    return {
      worktree,
      status: await this.status({ sessionId: input.sessionId }),
    }
  }

  async exitWorktree(input: {
    sessionId: string
    action: 'keep' | 'remove'
    discardChanges: boolean
    expectedRevision: string
    confirmed: true
  }) {
    const manager = this.requireWorktreeManager()
    this.requireNoWriter(input.sessionId)
    const current = await this.requireRevision(
      input.sessionId,
      input.expectedRevision,
    )
    const result = await manager.exit({
      ...input,
      projectRoot: current.root,
    })
    if (input.action === 'remove')
      await this.recordReceipt(input.sessionId, {
        action: 'remove_worktree',
        completedAt: Date.now(),
      })
    return {
      result,
      status: await this.status({ sessionId: input.sessionId }),
    }
  }

  pullRequest(input: Parameters<GitPullRequestService['pullRequest']>[0]) {
    return this.pullRequests.pullRequest(input)
  }

  publishPreview(
    input: Parameters<GitPullRequestService['publishPreview']>[0],
  ) {
    return this.pullRequests.publishPreview(input)
  }

  publishPullRequest(
    input: Parameters<GitPullRequestService['publishPullRequest']>[0],
  ) {
    this.requireNoWriter(input.sessionId)
    return this.pullRequests.publishPullRequest(input)
  }

  readyPullRequest(
    input: Parameters<GitPullRequestService['readyPullRequest']>[0],
  ) {
    this.requireNoWriter(input.sessionId)
    return this.pullRequests.readyPullRequest(input)
  }

  mergePullRequest(
    input: Parameters<GitPullRequestService['mergePullRequest']>[0],
  ) {
    this.requireNoWriter(input.sessionId)
    return this.pullRequests.mergePullRequest(input)
  }

  closePullRequest(
    input: Parameters<GitPullRequestService['closePullRequest']>[0],
  ) {
    this.requireNoWriter(input.sessionId)
    return this.pullRequests.closePullRequest(input)
  }

  private async requireRevision(
    sessionId: string,
    expectedRevision: string,
  ): Promise<GitStatusResult> {
    const current = await this.status({ sessionId })
    if (current.truncated)
      throw new WorkspaceOperationError(
        'git_status_truncated',
        'Git 状态超过安全读取上限，不能执行写操作；请缩小项目范围或使用 Terminal。',
      )
    if (current.revision !== expectedRevision)
      throw new WorkspaceOperationError(
        'git_status_stale',
        '仓库状态已变化，请刷新后重试。',
      )
    return current
  }

  private async repositoryContext(
    projectRoot: string,
  ): Promise<GitRepositoryContext> {
    const identity = await this.resolver.resolve(projectRoot)
    return {
      projectRoot: identity.projectRoot,
      repositoryRoot: identity.worktreeRoot,
      repositoryPrefix: identity.repositoryPrefix,
      identity,
    }
  }

  private async assertNoStagedOutsideScope(
    context: GitRepositoryContext,
  ): Promise<void> {
    if (!context.repositoryPrefix) return
    const result = await this.command(context.repositoryRoot, [
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
      '--untracked-files=all',
    ])
    if (result.stdoutTruncated)
      throw new WorkspaceOperationError(
        'git_status_too_large',
        'Git 状态超过安全读取上限，无法安全提交。',
      )
    const outside = parsePorcelainV2(result.stdout).files.find(
      (file) =>
        !file.untracked &&
        file.index !== '.' &&
        file.index !== ' ' &&
        (!projectPath(context, file.path) ||
          Boolean(
            file.originalPath && !projectPath(context, file.originalPath),
          )),
    )
    if (outside)
      throw new WorkspaceOperationError(
        'git_staged_outside_project',
        '仓库中存在当前 Build 项目之外的暂存变更，请先在 Terminal 中处理。',
      )
  }

  private requireRepositoryWideProject(
    context: GitRepositoryContext,
    operation: string,
  ): void {
    if (!context.repositoryPrefix) return
    throw new WorkspaceOperationError(
      'git_repository_wide_operation',
      `当前 Build 项目是 Git 仓库子目录，不能从该会话${operation}整个仓库。请在仓库根项目或 Terminal 中操作。`,
    )
  }

  private requireStableRepository(
    context: GitRepositoryContext,
    operation: string,
  ): void {
    if (context.identity.transientState === 'none') return
    throw new WorkspaceOperationError(
      'git_transient_state',
      `仓库正在进行 ${context.identity.transientState}，不能${operation}。`,
    )
  }

  private requireNoWriter(sessionId: string): void {
    if (this.options.hasActiveWriter?.(sessionId))
      throw new WorkspaceOperationError(
        'git_active_writer',
        '当前 Agent 正在修改项目，该 Git 操作已暂停。',
      )
  }

  private requireWorktreeManager(): GitWorktreeManager {
    if (this.worktreeManager) return this.worktreeManager
    throw new WorkspaceOperationError(
      'git_worktree_unavailable',
      '当前运行实例未启用结构化 worktree 管理。',
    )
  }

  private async recordReceipt(
    sessionId: string,
    receipt: GitOperationReceipt,
  ): Promise<void> {
    this.receipts?.append(sessionId, receipt)
    await this.options.emitReceipt?.(sessionId, receipt)
  }

  private async pullRequestContext(
    sessionId: string,
  ): Promise<PullRequestContext> {
    const status = await this.status({ sessionId })
    return {
      cwd: status.repository.worktreeRoot,
      revision: status.revision,
      branch: status.branch,
      headOid: status.head,
      defaultBranch: status.repository.defaultBranch,
      upstream: status.upstream,
      ahead: status.ahead,
      transientState: status.repository.transientState,
      changedFiles: status.summary.changedFiles,
      truncated: status.truncated,
    }
  }

  private async command(
    projectRoot: string,
    args: string[],
    options: {
      stdin?: string
      allowedExitCodes?: number[]
      network?: boolean
    } = {},
  ): Promise<GitCommandResult> {
    return await this.runner.execute(projectRoot, args, options)
  }
}

export function parsePorcelainV2(raw: string): ParsedPorcelainV2 {
  let branch: string | null = null
  let head: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitFileStatus[] = []
  const records = raw.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length)
      head = value === '(initial)' ? null : value
      continue
    }
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length)
      branch = value === '(detached)' ? null : value
      continue
    }
    if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice('# branch.upstream '.length) || null
      continue
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record)
      if (match) {
        ahead = Number.parseInt(match[1] || '0', 10)
        behind = Number.parseInt(match[2] || '0', 10)
      }
      continue
    }
    if (record.startsWith('? ')) {
      files.push({
        path: record.slice(2),
        index: '?',
        worktree: '?',
        conflict: false,
        untracked: true,
      })
      continue
    }
    if (record.startsWith('! ')) continue
    if (record.startsWith('1 ')) {
      const fields = splitFields(record, 8)
      const xy = fields.values[1] || '..'
      files.push(statusFile(fields.rest, xy, false))
      continue
    }
    if (record.startsWith('2 ')) {
      const fields = splitFields(record, 9)
      const xy = fields.values[1] || '..'
      const originalPath = records[index + 1] || ''
      index += 1
      files.push({
        ...statusFile(fields.rest, xy, false),
        ...(originalPath ? { originalPath } : {}),
      })
      continue
    }
    if (record.startsWith('u ')) {
      const fields = splitFields(record, 10)
      const xy = fields.values[1] || 'UU'
      files.push(statusFile(fields.rest, xy, true))
    }
  }
  return {
    branch,
    head,
    upstream,
    detached: branch === null && head !== null,
    ahead,
    behind,
    files,
  }
}

function scopePorcelain(
  parsed: ParsedPorcelainV2,
  repositoryPrefix: string,
): ParsedPorcelainV2 {
  if (!repositoryPrefix) return parsed
  const context: Pick<
    GitRepositoryContext,
    'projectRoot' | 'repositoryRoot' | 'repositoryPrefix'
  > = {
    projectRoot: '',
    repositoryRoot: '',
    repositoryPrefix,
  }
  return {
    ...parsed,
    files: parsed.files.flatMap((file) => {
      const path = projectPath(context, file.path)
      if (path === null) return []
      const originalPath = file.originalPath
        ? projectPath(context, file.originalPath)
        : null
      return [
        {
          ...file,
          path,
          ...(originalPath ? { originalPath } : {}),
        },
      ]
    }),
  }
}

function repositoryPath(
  context: Pick<GitRepositoryContext, 'repositoryPrefix'>,
  projectRelativePath: string,
): string {
  return context.repositoryPrefix
    ? `${context.repositoryPrefix}/${projectRelativePath}`
    : projectRelativePath
}

function projectPath(
  context: Pick<GitRepositoryContext, 'repositoryPrefix'>,
  repositoryRelativePath: string,
): string | null {
  const portable = repositoryRelativePath.replaceAll('\\', '/')
  if (!context.repositoryPrefix) return portable
  const prefix = `${context.repositoryPrefix}/`
  return portable.startsWith(prefix) ? portable.slice(prefix.length) : null
}

function expandStatusPaths(
  files: GitFileStatus[],
  selectedPaths: string[],
): string[] {
  const expanded = new Set(selectedPaths)
  for (const path of selectedPaths) {
    const originalPath = files.find((file) => file.path === path)?.originalPath
    if (originalPath) expanded.add(originalPath)
  }
  return [...expanded]
}

function splitFields(
  record: string,
  fieldCount: number,
): { values: string[]; rest: string } {
  const values: string[] = []
  let position = 0
  for (let index = 0; index < fieldCount; index += 1) {
    const next = record.indexOf(' ', position)
    if (next < 0)
      return { values: [...values, record.slice(position)], rest: '' }
    values.push(record.slice(position, next))
    position = next + 1
  }
  return { values, rest: record.slice(position) }
}

function statusFile(
  path: string,
  xy: string,
  conflict: boolean,
): GitFileStatus {
  return {
    path,
    index: xy[0] || '.',
    worktree: xy[1] || '.',
    conflict,
    untracked: false,
  }
}

function revisionFor(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function parseNumstatByPath(
  raw: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const changes = new Map<
    string,
    { additions: number; deletions: number; binary: boolean }
  >()
  const records = raw.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const added = record.slice(0, firstTab)
    const deleted = record.slice(firstTab + 1, secondTab)
    let path = record.slice(secondTab + 1)
    if (!path) {
      index += 1
      const _originalPath = records[index] || ''
      index += 1
      path = records[index] || ''
    }
    if (!path) continue
    changes.set(path, {
      additions: /^\d+$/.test(added) ? Number(added) : 0,
      deletions: /^\d+$/.test(deleted) ? Number(deleted) : 0,
      binary: added === '-' || deleted === '-',
    })
  }
  return changes
}

function mergeNumstatByPath(
  ...maps: Array<
    Map<string, { additions: number; deletions: number; binary: boolean }>
  >
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const merged = new Map<
    string,
    { additions: number; deletions: number; binary: boolean }
  >()
  for (const map of maps)
    for (const [path, stats] of map) {
      const previous = merged.get(path)
      merged.set(path, {
        additions: (previous?.additions || 0) + stats.additions,
        deletions: (previous?.deletions || 0) + stats.deletions,
        binary: Boolean(previous?.binary || stats.binary),
      })
    }
  return merged
}

function summarizeNumstat(
  input: Map<string, { additions: number; deletions: number; binary: boolean }>,
  context: Pick<GitRepositoryContext, 'repositoryPrefix'>,
): {
  additions: number
  deletions: number
  files: Map<string, { additions: number; deletions: number; binary: boolean }>
} {
  const files = new Map<
    string,
    { additions: number; deletions: number; binary: boolean }
  >()
  for (const [repositoryRelativePath, stats] of input) {
    const path = projectPath(context, repositoryRelativePath)
    if (path !== null) files.set(path, stats)
  }
  return {
    additions: [...files.values()].reduce(
      (total, entry) => total + entry.additions,
      0,
    ),
    deletions: [...files.values()].reduce(
      (total, entry) => total + entry.deletions,
      0,
    ),
    files,
  }
}

function untrackedFileStats(path: string): {
  additions: number
  deletions: number
  binary: boolean
} {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
      return { additions: 0, deletions: 0, binary: true }
    const content = readFileSync(path)
    if (content.subarray(0, 8192).includes(0))
      return { additions: 0, deletions: 0, binary: true }
    const text = content.toString('utf8')
    const additions = text
      ? text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0)
      : 0
    return { additions, deletions: 0, binary: false }
  } catch {
    return { additions: 0, deletions: 0, binary: true }
  }
}

function workingTreeFingerprint(
  context: Pick<GitRepositoryContext, 'projectRoot'>,
  files: GitFileStatus[],
): string {
  return files
    .map((file) => {
      const path = resolve(context.projectRoot, file.path)
      try {
        const stat = lstatSync(path)
        if (stat.isSymbolicLink())
          return `${file.path}\0symlink\0${stat.size}\0${stat.mtimeMs}`
        if (!stat.isFile())
          return `${file.path}\0other\0${stat.size}\0${stat.mtimeMs}`
        const contentHash =
          stat.size <= 2 * 1024 * 1024
            ? createHash('sha256').update(readFileSync(path)).digest('hex')
            : `large:${stat.size}:${stat.mtimeMs}`
        return `${file.path}\0file\0${stat.mode}\0${contentHash}`
      } catch {
        return `${file.path}\0missing`
      }
    })
    .join('\0')
}

function remoteHost(value: string): string | null {
  const remote = value.trim()
  if (!remote) return null
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote))
      return new URL(remote).hostname || null
  } catch {
    return null
  }
  const scpLike = /^(?:[^@\s]+@)?([^:\s]+):/.exec(remote)
  return scpLike?.[1] || null
}

function validatePaths(paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 500)
    invalidGitArgument('必须选择 1–500 个文件。')
  return paths.map(validatePath)
}

function validatePath(path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path))
    invalidGitArgument('Git 文件路径不合法。')
  const portable = path.replaceAll('\\', '/')
  const normalized = normalize(portable)
  if (
    portable.startsWith('/') ||
    portable === '..' ||
    portable.startsWith('../') ||
    normalized === '..' ||
    normalized.startsWith(`..${sep}`) ||
    normalized.startsWith('../') ||
    normalized.startsWith('..\\')
  )
    invalidGitArgument('Git 文件路径不合法。')
  return portable
}

function validateRef(ref: string): string {
  if (
    !ref ||
    ref.length > 512 ||
    /[\0\r\n~^:?*[]/.test(ref) ||
    ref.startsWith('-')
  )
    invalidGitArgument('Git 引用名不合法。')
  return ref
}

function requireConfirmed(value: unknown): asserts value is true {
  if (value !== true)
    throw new WorkspaceOperationError(
      'git_confirmation_required',
      '该 Git 操作需要明确确认。',
    )
}

function invalidGitArgument(message: string): never {
  throw new WorkspaceOperationError('git_argument_invalid', message)
}

function gitOutputTooLarge(label: string): never {
  throw new WorkspaceOperationError(
    'git_output_too_large',
    `${label}超过安全读取上限，请通过 Terminal 处理。`,
  )
}

export function sanitizeGitMessage(message: string): string {
  return sanitizeGitError(message)
}
