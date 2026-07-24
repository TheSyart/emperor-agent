import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { WorkspaceOperationError } from './common'
import type { GitCommandResult } from './git-runner'

export type GitTransientState =
  'none' | 'merge' | 'rebase' | 'cherry_pick' | 'revert' | 'bisect'

export interface GitRepositoryIdentity {
  root: string
  commonDir: string
  gitDir: string
  worktreeRoot: string
  projectRoot: string
  repositoryPrefix: string
  branch: string | null
  headOid: string | null
  defaultBranch: string | null
  detached: boolean
  unborn: boolean
  objectFormat: 'sha1' | 'sha256'
  transientState: GitTransientState
}

export interface GitRepositoryResolverOptions {
  execute: (
    cwd: string,
    args: string[],
    options?: { allowedExitCodes?: number[] },
  ) => Promise<GitCommandResult>
}

export class GitRepositoryResolver {
  constructor(private readonly options: GitRepositoryResolverOptions) {}

  async resolve(projectRoot: string): Promise<GitRepositoryIdentity> {
    const project = canonical(projectRoot)
    const basics = await this.options.execute(project, [
      'rev-parse',
      '--show-toplevel',
      '--absolute-git-dir',
      '--git-common-dir',
      '--is-bare-repository',
      '--show-object-format=storage',
    ])
    const values = basics.stdout.split(/\r?\n/).filter(Boolean)
    const rootRaw = values[0]
    const legacySingleValue = values.length === 1
    const gitDirRaw = legacySingleValue
      ? resolve(String(rootRaw || project), '.git')
      : values[1]
    const commonDirRaw = legacySingleValue ? gitDirRaw : values[2]
    const bareRaw = legacySingleValue ? 'false' : values[3]
    const objectFormatRaw = legacySingleValue ? 'sha1' : values[4]
    if (bareRaw === 'true') invalidRepository('裸仓库不能作为 Build 工作区。')
    const worktreeRoot = canonicalRequired(rootRaw)
    const gitDir = canonicalRequired(resolveGitPath(project, gitDirRaw))
    const commonDir = canonicalRequired(
      resolveGitPath(project, commonDirRaw || gitDirRaw),
    )
    const prefix = relative(worktreeRoot, project)
    if (escapes(prefix))
      invalidRepository('Build 项目不在 Git 工作树授权范围内。')
    if (existsSync(worktreeRoot) && !legacySingleValue)
      validateGitStorage(worktreeRoot, gitDir, commonDir)

    const branchResult = await this.options.execute(
      project,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      { allowedExitCodes: [0, 1] },
    )
    const headResult = await this.options.execute(
      project,
      ['rev-parse', '--verify', 'HEAD'],
      { allowedExitCodes: [0, 128] },
    )
    const defaultResult = await this.options.execute(
      project,
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      { allowedExitCodes: [0, 1] },
    )
    const branch =
      branchResult.exitCode === 0 ? branchResult.stdout.trim() || null : null
    const headOid =
      headResult.exitCode === 0 ? headResult.stdout.trim() || null : null
    const objectFormat = objectFormatRaw === 'sha256' ? 'sha256' : 'sha1'
    return {
      root: project,
      commonDir,
      gitDir,
      worktreeRoot,
      projectRoot: project,
      repositoryPrefix: prefix.split(sep).join('/'),
      branch,
      headOid,
      defaultBranch: normalizeDefaultBranch(defaultResult.stdout),
      detached: branch === null && headOid !== null,
      unborn: headOid === null,
      objectFormat,
      transientState: detectTransientState(gitDir, commonDir),
    }
  }
}

function validateGitStorage(
  worktreeRoot: string,
  gitDir: string,
  commonDir: string,
): void {
  if (!existsSync(gitDir) || !lstatSync(gitDir).isDirectory())
    invalidRepository('Git 元数据目录不存在。')
  if (!existsSync(commonDir) || !lstatSync(commonDir).isDirectory())
    invalidRepository('Git common directory 不存在。')
  if (!isWithin(commonDir, gitDir) && gitDir !== commonDir)
    invalidRepository('Git worktree 元数据与主仓库身份不一致。')

  const dotGit = resolve(worktreeRoot, '.git')
  if (!existsSync(dotGit)) invalidRepository('工作树缺少 .git 身份。')
  if (lstatSync(dotGit).isFile()) {
    const pointer = /^gitdir:\s*(.+)\s*$/i.exec(
      readFileSync(dotGit, 'utf8').trim(),
    )
    if (!pointer) invalidRepository('.git 指针格式无效。')
    const target = canonicalRequired(
      resolve(dirname(dotGit), pointer?.[1] || ''),
    )
    if (target !== gitDir) invalidRepository('.git 指针与 Git 解析结果不一致。')
    if (!existsSync(resolve(gitDir, 'HEAD')))
      invalidRepository('Git 指针目标缺少 HEAD。')
    const hasWorktreeLink = existsSync(resolve(gitDir, 'commondir'))
    const hasStandaloneObjects =
      gitDir === commonDir && existsSync(resolve(gitDir, 'objects'))
    if (!hasWorktreeLink && !hasStandaloneObjects)
      invalidRepository('Git 指针目标不是有效 worktree 或 submodule。')
  } else if (canonicalRequired(dotGit) !== gitDir) {
    invalidRepository('.git 目录与 Git 解析结果不一致。')
  }
}

function detectTransientState(
  gitDir: string,
  commonDir: string,
): GitTransientState {
  if (
    existsSync(resolve(gitDir, 'rebase-merge')) ||
    existsSync(resolve(gitDir, 'rebase-apply'))
  )
    return 'rebase'
  if (existsSync(resolve(gitDir, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(resolve(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry_pick'
  if (existsSync(resolve(gitDir, 'REVERT_HEAD'))) return 'revert'
  if (
    existsSync(resolve(gitDir, 'BISECT_LOG')) ||
    existsSync(resolve(commonDir, 'BISECT_LOG'))
  )
    return 'bisect'
  return 'none'
}

function normalizeDefaultBranch(value: string): string | null {
  const branch = value.trim().replace(/^origin\//, '')
  return branch || null
}

function resolveGitPath(cwd: string, value?: string): string {
  if (!value) invalidRepository('Git 返回了空的元数据路径。')
  return isAbsolute(value) ? value : resolve(cwd, value)
}

function canonical(path: string): string {
  const absolute = resolve(path)
  return existsSync(absolute) ? realpathSync(absolute) : absolute
}

function canonicalRequired(path?: string): string {
  if (!path || !isAbsolute(resolve(path)))
    invalidRepository('Git 返回了无效路径。')
  return canonical(path)
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return !escapes(path)
}

function escapes(path: string): boolean {
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

function invalidRepository(message: string): never {
  throw new WorkspaceOperationError('git_repository_invalid', message)
}
