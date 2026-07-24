import { devNull } from 'node:os'
import { WorkspaceOperationError } from './common'
import type { GitOperationReceipt } from './git-receipts'
import {
  sanitizeGitError,
  type GitCommandResult,
  type GitRuntime,
} from './git-runner'

export interface PullRequestSummary {
  number: number
  url: string
  state: string
  draft: boolean
  mergeable: string
  headRefName: string
  baseRefName: string
  checks: Array<{ name: string; conclusion: string; status: string }>
}

export interface PullRequestContext {
  cwd: string
  revision: string
  branch: string | null
  headOid: string | null
  defaultBranch: string | null
  upstream: string | null
  ahead: number
  transientState:
    'none' | 'merge' | 'rebase' | 'cherry_pick' | 'revert' | 'bisect'
  changedFiles: number
  truncated: boolean
}

interface GhCommandRequest {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

interface GhCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface GitPullRequestServiceOptions {
  resolveRuntime: (cwd: string) => Promise<GitRuntime | null>
  run: (request: GhCommandRequest) => Promise<GhCommandResult>
  context: (sessionId: string) => Promise<PullRequestContext>
  git?: (
    cwd: string,
    args: string[],
    options?: { allowedExitCodes?: number[] },
  ) => Promise<GitCommandResult>
  record: (
    sessionId: string,
    receipt: GitOperationReceipt,
  ) => Promise<void> | void
}

export class GitPullRequestService {
  constructor(private readonly options: GitPullRequestServiceOptions) {}

  async pullRequest(input: {
    sessionId: string
  }): Promise<PullRequestSummary | null> {
    const context = await this.options.context(input.sessionId)
    return await this.view(context.cwd)
  }

  async publishPreview(input: {
    sessionId: string
    baseRef?: string
  }): Promise<{
    baseRef: string
    branch: string
    headOid: string
    commits: Array<{ oid: string; subject: string }>
    additions: number
    deletions: number
    binary: number
    changedFiles: number
    uncommittedFiles: number
  }> {
    const context = await this.options.context(input.sessionId)
    requireStableContext(context)
    if (!context.branch || !context.headOid)
      invalidState('当前分支没有可发布的提交。')
    const baseRef = validateRef(
      input.baseRef || context.defaultBranch || 'main',
    )
    const commits: Array<{ oid: string; subject: string }> = []
    let additions = 0
    let deletions = 0
    let binary = 0
    let changedFiles = 0
    if (this.options.git) {
      const log = await this.options.git(context.cwd, [
        'log',
        '-z',
        '--format=%H%x00%s',
        `${baseRef}...HEAD`,
      ])
      const records = log.stdout.split('\0')
      for (let index = 0; index + 1 < records.length; index += 2) {
        const oid = records[index]?.trim()
        if (oid) commits.push({ oid, subject: records[index + 1] || '' })
      }
      const diff = await this.options.git(context.cwd, [
        'diff',
        '--numstat',
        '-z',
        `${baseRef}...HEAD`,
      ])
      for (const record of diff.stdout.split('\0').filter(Boolean)) {
        const [added, deleted] = record.split('\t', 3)
        changedFiles += 1
        if (added === '-' || deleted === '-') binary += 1
        else {
          additions += Number.parseInt(added || '0', 10) || 0
          deletions += Number.parseInt(deleted || '0', 10) || 0
        }
      }
    }
    return {
      baseRef,
      branch: context.branch,
      headOid: context.headOid,
      commits,
      additions,
      deletions,
      binary,
      changedFiles,
      uncommittedFiles: context.changedFiles,
    }
  }

  async publishPullRequest(input: {
    sessionId: string
    title: string
    body: string
    draft: boolean
    expectedRevision: string
    confirmed: true
  }): Promise<PullRequestSummary> {
    requireConfirmed(input.confirmed)
    const context = await this.options.context(input.sessionId)
    requireRevision(context, input.expectedRevision)
    requireStableContext(context)
    if (!context.branch || !context.headOid)
      invalidState('当前分支没有可发布的提交。')
    if (!context.upstream || context.ahead > 0)
      throw new WorkspaceOperationError(
        'git_pr_push_required',
        '本地分支尚未完整推送，请先显式 Push。',
      )
    const title = boundedText(input.title, 256, 'PR 标题')
    const body = boundedText(input.body, 64 * 1024, 'PR 正文', true)
    const existing = await this.view(context.cwd)
    if (existing) {
      await this.gh(context.cwd, [
        'pr',
        'edit',
        String(existing.number),
        '--title',
        title,
        '--body',
        body,
      ])
    } else {
      await this.gh(context.cwd, [
        'pr',
        'create',
        '--base',
        context.defaultBranch || 'main',
        '--head',
        context.branch,
        '--title',
        title,
        '--body',
        body,
        ...(input.draft ? ['--draft'] : []),
      ])
    }
    const pullRequest = await this.view(context.cwd)
    if (!pullRequest)
      throw new WorkspaceOperationError(
        'git_pr_result_missing',
        'GitHub 未返回刚创建或更新的 Pull Request。',
      )
    await this.options.record(
      input.sessionId,
      receipt('publish_pr', pullRequest),
    )
    return pullRequest
  }

  async readyPullRequest(input: {
    sessionId: string
    number: number
    expectedRevision: string
    confirmed: true
  }): Promise<PullRequestSummary> {
    requireConfirmed(input.confirmed)
    const context = await this.options.context(input.sessionId)
    requireRevision(context, input.expectedRevision)
    requireStableContext(context)
    await this.gh(context.cwd, [
      'pr',
      'ready',
      String(validNumber(input.number)),
    ])
    const result = await this.view(context.cwd, input.number)
    if (!result) invalidState('Pull Request 不存在。')
    return result
  }

  async mergePullRequest(input: {
    sessionId: string
    number: number
    method: 'merge' | 'squash' | 'rebase'
    deleteBranch: boolean
    expectedRevision: string
    confirmed: true
  }): Promise<PullRequestSummary> {
    requireConfirmed(input.confirmed)
    const context = await this.options.context(input.sessionId)
    requireRevision(context, input.expectedRevision)
    requireStableContext(context)
    const current = await this.view(context.cwd, input.number)
    if (!current) invalidState('Pull Request 不存在。')
    if (current.mergeable !== 'MERGEABLE' || hasFailingChecks(current))
      throw new WorkspaceOperationError(
        'git_pr_not_mergeable',
        'Pull Request 尚不可合并，或必要检查未通过。',
      )
    await this.gh(context.cwd, [
      'pr',
      'merge',
      String(validNumber(input.number)),
      `--${input.method}`,
      ...(input.deleteBranch ? ['--delete-branch'] : []),
    ])
    const result = await this.view(context.cwd, input.number)
    if (!result) invalidState('合并后无法读取 Pull Request 状态。')
    await this.options.record(input.sessionId, receipt('merge_pr', result))
    return result
  }

  async closePullRequest(input: {
    sessionId: string
    number: number
    expectedRevision: string
    confirmed: true
  }): Promise<PullRequestSummary> {
    requireConfirmed(input.confirmed)
    const context = await this.options.context(input.sessionId)
    requireRevision(context, input.expectedRevision)
    requireStableContext(context)
    await this.gh(context.cwd, [
      'pr',
      'close',
      String(validNumber(input.number)),
    ])
    const result = await this.view(context.cwd, input.number)
    if (!result) invalidState('关闭后无法读取 Pull Request 状态。')
    await this.options.record(input.sessionId, receipt('close_pr', result))
    return result
  }

  private async view(
    cwd: string,
    number?: number,
  ): Promise<PullRequestSummary | null> {
    const result = await this.gh(
      cwd,
      [
        'pr',
        'view',
        ...(number ? [String(validNumber(number))] : []),
        '--json',
        'number,url,state,isDraft,mergeable,headRefName,baseRefName,statusCheckRollup',
      ],
      [0, 1],
    )
    if (result.exitCode === 1) {
      if (
        /no pull requests found|could not resolve to a pull request/i.test(
          result.stderr,
        )
      )
        return null
      throw new WorkspaceOperationError(
        'git_gh_failed',
        sanitizeGitError(result.stderr || result.stdout) ||
          'GitHub CLI 操作失败。',
      )
    }
    try {
      const value = JSON.parse(result.stdout) as Record<string, unknown>
      return {
        number: validNumber(Number(value.number)),
        url: safePullRequestUrl(String(value.url || '')),
        state: String(value.state || ''),
        draft: value.isDraft === true,
        mergeable: String(value.mergeable || ''),
        headRefName: String(value.headRefName || ''),
        baseRefName: String(value.baseRefName || ''),
        checks: Array.isArray(value.statusCheckRollup)
          ? value.statusCheckRollup.map((entry) => {
              const row = entry as Record<string, unknown>
              return {
                name: String(row.name || row.context || ''),
                conclusion: String(row.conclusion || ''),
                status: String(row.status || ''),
              }
            })
          : [],
      }
    } catch (error) {
      throw new WorkspaceOperationError(
        'git_gh_invalid_response',
        'GitHub CLI 返回了无效数据。',
        { cause: error },
      )
    }
  }

  private async gh(
    cwd: string,
    args: string[],
    allowedExitCodes: number[] = [0],
  ): Promise<GhCommandResult> {
    const runtime = await this.options.resolveRuntime(cwd)
    if (!runtime)
      throw new WorkspaceOperationError(
        'git_gh_unavailable',
        '当前签名执行环境中没有可用的 GitHub CLI；请先完成 ToolCatalog 审核并安装 gh。',
      )
    const result = await this.options.run({
      executable: runtime.executable,
      args,
      cwd,
      env: {
        ...selectEnv(runtime.env),
        GH_PROMPT_DISABLED: '1',
        GH_FORCE_TTY: '0',
        NO_COLOR: '1',
        PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: devNull,
      },
    })
    if (!allowedExitCodes.includes(result.exitCode))
      throw new WorkspaceOperationError(
        'git_gh_failed',
        sanitizeGitError(result.stderr || result.stdout) ||
          'GitHub CLI 操作失败。',
      )
    return result
  }
}

function selectEnv(env: Record<string, string>): Record<string, string> {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ])
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => allowed.has(key)),
  )
}

function requireStableContext(context: PullRequestContext): void {
  if (context.truncated)
    throw new WorkspaceOperationError(
      'git_status_truncated',
      'Git 状态超过安全读取上限，不能生成或变更 Pull Request。',
    )
  if (context.transientState === 'none') return
  throw new WorkspaceOperationError(
    'git_transient_state',
    `仓库正在进行 ${context.transientState}，不能操作 Pull Request。`,
  )
}

function requireRevision(
  context: PullRequestContext,
  expectedRevision: string,
): void {
  if (context.truncated)
    throw new WorkspaceOperationError(
      'git_status_truncated',
      'Git 状态超过安全读取上限，不能变更 Pull Request。',
    )
  if (context.revision === expectedRevision) return
  throw new WorkspaceOperationError(
    'git_status_stale',
    '仓库状态已变化，请刷新后重试。',
  )
}

function receipt(
  action: 'publish_pr' | 'merge_pr' | 'close_pr',
  pullRequest: PullRequestSummary,
): GitOperationReceipt {
  return {
    action,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
      state: pullRequest.state,
    },
    completedAt: Date.now(),
  }
}

function hasFailingChecks(pullRequest: PullRequestSummary): boolean {
  return pullRequest.checks.some(
    (check) =>
      check.status !== 'COMPLETED' ||
      !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion),
  )
}

function validNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1)
    throw new WorkspaceOperationError(
      'git_argument_invalid',
      'Pull Request 编号不合法。',
    )
  return value
}

function validateRef(value: string): string {
  if (
    !value ||
    value.length > 512 ||
    /[\0\r\n~^:?*[]/.test(value) ||
    value.startsWith('-')
  )
    throw new WorkspaceOperationError(
      'git_argument_invalid',
      'Git 引用不合法。',
    )
  return value
}

function safePullRequestUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') throw new Error('not https')
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    throw new WorkspaceOperationError(
      'git_gh_invalid_response',
      'GitHub CLI 返回了无效 Pull Request URL。',
    )
  }
}

function boundedText(
  value: string,
  max: number,
  label: string,
  allowEmpty = false,
): string {
  const text = value.trim()
  if ((!allowEmpty && !text) || text.length > max)
    throw new WorkspaceOperationError(
      'git_argument_invalid',
      `${label}不合法。`,
    )
  return text
}

function requireConfirmed(value: unknown): asserts value is true {
  if (value !== true)
    throw new WorkspaceOperationError(
      'git_confirmation_required',
      '该 Pull Request 操作需要明确确认。',
    )
}

function invalidState(message: string): never {
  throw new WorkspaceOperationError('git_pr_invalid_state', message)
}
