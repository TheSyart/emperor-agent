/**
 * Global, read-only Pull Request browsing through the signed GitHub CLI.
 *
 * Not session- or project-scoped: every gh call names its repository
 * explicitly (`--repo`, GraphQL variables or search qualifiers) and runs with
 * cwd = stateRoot. Arguments are fixed argv arrays (shell:false); the only
 * caller-controlled values are the validated repository, PR number, search
 * text and page size, and they always travel as single argv elements
 * (GraphQL variables via `-f`/`-F`, never interpolated into the query text).
 * No operation here mutates GitHub state.
 */
import { WorkspaceOperationError } from './common'
import {
  ghProcessEnvironment,
  type GhCommandRequest,
  type GhCommandResult,
} from './git-pull-requests'
import { sanitizeGitError, type GitRuntime } from './git-runner'
import type { EnvironmentProcessRunner } from '../environment/process-runner'

export interface GhRuntime extends GitRuntime {
  /** Version the signed ToolCatalog probe detected, when known. */
  version?: string | null
}

export type PullRequestListFilter = 'all' | 'reviewing' | 'mine'
export type PullRequestChecksState = 'success' | 'failure' | 'pending'
export type PullRequestReviewDecision =
  'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
export type PullRequestBrowserUnavailableReason =
  'gh_missing' | 'gh_unauthenticated' | 'gh_failed'

export interface PullRequestBrowserStatus {
  available: boolean
  reason?: PullRequestBrowserUnavailableReason
  /** GitHub login of the authenticated gh account. */
  login?: string
  /** gh version from the signed ToolCatalog probe. */
  version?: string
  /** Sanitized gh failure detail, only for `reason: 'gh_failed'`. */
  message?: string
}

export interface PullRequestListItem {
  /** `owner/name`. */
  repo: string
  number: number
  title: string
  /** GitHub PullRequestState: OPEN | CLOSED | MERGED. */
  state: string
  isDraft: boolean
  url: string
  /** Author login; `ghost` for deleted accounts. */
  author: string
  createdAt: string
  updatedAt: string
  headRefName: string | null
  additions: number | null
  deletions: number | null
  /** Rollup of the head commit's checks and statuses; null when none ran. */
  checks: PullRequestChecksState | null
  reviewDecision: PullRequestReviewDecision | null
}

export interface PullRequestListResult {
  items: PullRequestListItem[]
  /** Total matches reported by GitHub search (may exceed `items.length`). */
  total: number
}

export interface PullRequestCheck {
  name: string
  /** CheckRun status (QUEUED, IN_PROGRESS, COMPLETED, ...); status contexts map to PENDING/COMPLETED. */
  status: string
  /** SUCCESS, FAILURE, NEUTRAL, ...; null while the check has not concluded. */
  conclusion: string | null
}

export interface PullRequestDetail {
  repo: string
  number: number
  title: string
  body: string
  state: string
  isDraft: boolean
  url: string
  author: string
  createdAt: string
  updatedAt: string
  headRefName: string
  baseRefName: string
  additions: number
  deletions: number
  changedFiles: number
  /** First {@link PULL_REQUEST_VIEW_FILE_LIMIT} changed files. */
  files: Array<{ path: string; additions: number; deletions: number }>
  /** Commit count. */
  commits: number
  /** First {@link PULL_REQUEST_VIEW_CHECK_LIMIT} checks of the head commit. */
  checks: PullRequestCheck[]
  reviewDecision: PullRequestReviewDecision | null
}

export interface PullRequestDiffResult {
  diff: string
  truncated: boolean
}

/**
 * Which open issues to list: involving the account (author, assignee,
 * mention or comment), in repositories the account owns (`involves:` leaves
 * those out when others opened them), assigned to it, opened by it, or
 * mentioning it.
 */
export type GitHubIssueListFilter =
  'involved' | 'owned' | 'assigned' | 'created' | 'mentioned'

export interface GitHubLabel {
  name: string
  /** Hex color without `#`, as GitHub stores it. */
  color: string
}

export interface GitHubIssueListItem {
  /** `owner/name`. */
  repo: string
  number: number
  title: string
  /** OPEN | CLOSED. */
  state: string
  url: string
  author: string
  createdAt: string
  updatedAt: string
  labels: GitHubLabel[]
  commentCount: number
}

export interface GitHubIssueListResult {
  items: GitHubIssueListItem[]
  total: number
}

export interface GitHubIssueComment {
  author: string
  body: string
  createdAt: string
}

export interface GitHubIssueDetail extends GitHubIssueListItem {
  body: string
  /** COMPLETED | NOT_PLANNED | REOPENED, when GitHub gives one. */
  stateReason: string | null
  closedAt: string | null
  assignees: string[]
  /** The latest {@link GITHUB_ISSUE_COMMENT_LIMIT} comments, oldest first. */
  comments: GitHubIssueComment[]
}

export interface GitHubRunListItem {
  id: number
  /** Workflow name. */
  name: string
  /** Commit or PR title the run shows. */
  title: string
  /** queued | in_progress | completed | … */
  status: string
  /** success | failure | cancelled | …; null until the run ends. */
  conclusion: string | null
  event: string
  branch: string | null
  runNumber: number | null
  createdAt: string
  updatedAt: string
  url: string
  actor: string
}

export interface GitHubRunListResult {
  items: GitHubRunListItem[]
  total: number
}

export interface GitHubRunJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  url: string | null
  steps: Array<{
    number: number
    name: string
    status: string
    conclusion: string | null
  }>
}

export interface GitHubRunDetail {
  run: GitHubRunListItem
  jobs: GitHubRunJob[]
}

export interface GitHubReadOptions {
  signal?: AbortSignal
}

export interface PullRequestBrowserOptions {
  /** Directory gh runs in; the Emperor Home, never a project. */
  cwd: string
  /** Signed-catalog gh runtime, or null when gh is not ready. */
  resolveRuntime: () => Promise<GhRuntime | null>
  run: (request: GhCommandRequest) => Promise<GhCommandResult>
  /**
   * How long a resolved runtime is reused by list/view/diff (default 30 s).
   * `status()` always resolves afresh and refreshes the cache.
   */
  runtimeCacheMs?: number
  now?: () => number
}

/** `owner/name`; the owner cannot start with `-`, so it never reads as a flag. */
export const PULL_REQUEST_REPO_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
export const PULL_REQUEST_QUERY_MAX_LENGTH = 200
export const PULL_REQUEST_LIST_DEFAULT_LIMIT = 30
export const PULL_REQUEST_LIST_MAX_LIMIT = 50
export const PULL_REQUEST_NUMBER_MAX = 1_000_000_000
export const PULL_REQUEST_DIFF_MAX_BYTES = 4 * 1024 * 1024
export const PULL_REQUEST_VIEW_FILE_LIMIT = 100
export const PULL_REQUEST_VIEW_CHECK_LIMIT = 100
export const GITHUB_ISSUE_COMMENT_LIMIT = 30
export const GITHUB_RUN_ID_MAX = Number.MAX_SAFE_INTEGER
/** Branch names Emperor passes to gh: no leading `-`, no whitespace or shell-significant characters. */
const GITHUB_BRANCH_PATTERN = /^(?!-)[A-Za-z0-9._/-]{1,200}$/

const ISSUE_FILTER_QUALIFIERS: Readonly<Record<GitHubIssueListFilter, string>> =
  {
    involved: 'involves:@me',
    owned: 'user:@me',
    assigned: 'assignee:@me',
    created: 'author:@me',
    mentioned: 'mentions:@me',
  }

type GhSubject = 'pull_request' | 'issue' | 'run'

const NOT_FOUND_MESSAGES: Readonly<Record<GhSubject, string>> = {
  pull_request: '找不到该 Pull Request，或当前账户无权访问该仓库。',
  issue: '找不到该 Issue，或当前账户无权访问该仓库。',
  run: '找不到该运行记录，或当前账户无权访问该仓库。',
}

const FILTER_QUALIFIERS: Readonly<Record<PullRequestListFilter, string>> = {
  all: 'involves:@me',
  reviewing: 'review-requested:@me',
  mine: 'author:@me',
}

/** Static GraphQL documents; user input only ever arrives as variables. */
export const PULL_REQUEST_SEARCH_QUERY = `query EmperorPullRequestSearch($q: String!, $n: Int!) {
  search(query: $q, type: ISSUE, first: $n) {
    issueCount
    nodes {
      ... on PullRequest {
        number
        title
        state
        isDraft
        url
        createdAt
        updatedAt
        headRefName
        additions
        deletions
        reviewDecision
        author { login }
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

export const PULL_REQUEST_VIEW_QUERY = `query EmperorPullRequestView($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      body
      state
      isDraft
      url
      createdAt
      updatedAt
      headRefName
      baseRefName
      additions
      deletions
      changedFiles
      reviewDecision
      author { login }
      repository { nameWithOwner }
      commits { totalCount }
      files(first: ${PULL_REQUEST_VIEW_FILE_LIMIT}) { nodes { path additions deletions } }
      headCommit: commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: ${PULL_REQUEST_VIEW_CHECK_LIMIT}) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`

export const GITHUB_ISSUE_SEARCH_QUERY = `query EmperorIssueSearch($q: String!, $n: Int!) {
  search(query: $q, type: ISSUE, first: $n) {
    issueCount
    nodes {
      ... on Issue {
        number
        title
        state
        url
        createdAt
        updatedAt
        author { login }
        repository { nameWithOwner }
        labels(first: 5) { nodes { name color } }
        comments { totalCount }
      }
    }
  }
}`

export const GITHUB_ISSUE_VIEW_QUERY = `query EmperorIssueView($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      body
      state
      stateReason
      url
      createdAt
      updatedAt
      closedAt
      author { login }
      repository { nameWithOwner }
      labels(first: 20) { nodes { name color } }
      assignees(first: 10) { nodes { login } }
      comments(last: ${GITHUB_ISSUE_COMMENT_LIMIT}) {
        totalCount
        nodes { author { login } body createdAt }
      }
    }
  }
}`

type JsonRecord = Record<string, unknown>

export class PullRequestBrowserService {
  private runtimeCache: { runtime: GhRuntime; at: number } | null = null

  constructor(private readonly options: PullRequestBrowserOptions) {}

  /** Never throws for gh problems; reports them as an unavailable reason. */
  async status(): Promise<PullRequestBrowserStatus> {
    let runtime: GhRuntime | null
    try {
      runtime = await this.resolveRuntime(true)
    } catch {
      runtime = null
    }
    if (!runtime) return { available: false, reason: 'gh_missing' }
    const version = runtime.version ? { version: runtime.version } : {}
    try {
      const result = await this.gh(runtime, [
        'api',
        '--method',
        'GET',
        'user',
        '--jq',
        '.login',
      ])
      const login = result.stdout.trim()
      if (!/^[A-Za-z0-9-]{1,39}$/.test(login))
        return {
          available: false,
          reason: 'gh_failed',
          message: 'GitHub CLI 返回了无效的账户信息。',
          ...version,
        }
      return { available: true, login, ...version }
    } catch (error) {
      const code = error instanceof WorkspaceOperationError ? error.code : ''
      if (code === 'pull_request_gh_unauthenticated')
        return { available: false, reason: 'gh_unauthenticated', ...version }
      return {
        available: false,
        reason: 'gh_failed',
        message:
          error instanceof WorkspaceOperationError
            ? error.message
            : 'GitHub CLI 操作失败。',
        ...version,
      }
    }
  }

  async list(
    input: {
      filter?: PullRequestListFilter
      query?: string
      limit?: number
    } = {},
  ): Promise<PullRequestListResult> {
    const filter = input.filter ?? 'all'
    if (!Object.hasOwn(FILTER_QUALIFIERS, filter))
      invalidArgument('Pull Request 筛选条件不合法。')
    const limit = validLimit(input.limit)
    const search = buildPullRequestSearch(filter, input.query)
    const runtime = await this.requireRuntime()
    const result = await this.gh(runtime, [
      'api',
      'graphql',
      '-f',
      `query=${PULL_REQUEST_SEARCH_QUERY}`,
      '-f',
      `q=${search}`,
      '-F',
      `n=${limit}`,
    ])
    const data = graphqlData(result)
    const searchResult = record(data.search)
    const nodes = Array.isArray(searchResult.nodes) ? searchResult.nodes : []
    const items = nodes
      .map((node) => listItem(record(node)))
      .filter((item): item is PullRequestListItem => item !== null)
    const total = nonNegativeInteger(searchResult.issueCount) ?? items.length
    return { items, total: Math.max(total, items.length) }
  }

  async view(
    input: {
      repo: string
      number: number
    },
    options: GitHubReadOptions = {},
  ): Promise<PullRequestDetail> {
    const { owner, name } = splitRepo(validRepo(input.repo))
    const number = validNumber(input.number)
    const runtime = await this.requireRuntime()
    const result = await this.gh(
      runtime,
      [
        'api',
        'graphql',
        '-f',
        `query=${PULL_REQUEST_VIEW_QUERY}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${number}`,
      ],
      options,
    )
    const data = graphqlData(result)
    const pullRequest = record(record(data.repository).pullRequest)
    const detail = pullRequestDetail(pullRequest)
    if (!detail) notFound()
    return detail
  }

  async diff(input: {
    repo: string
    number: number
  }): Promise<PullRequestDiffResult> {
    const repo = validRepo(input.repo)
    const number = validNumber(input.number)
    const runtime = await this.requireRuntime()
    const result = await this.gh(
      runtime,
      ['pr', 'diff', String(number), '--repo', repo, '--color', 'never'],
      { allowTruncated: true },
    )
    const bounded = boundedUtf8Prefix(
      result.stdout,
      PULL_REQUEST_DIFF_MAX_BYTES,
    )
    return {
      diff: bounded.text,
      truncated: Boolean(result.stdoutTruncated) || bounded.truncated,
    }
  }

  /** Open issues that involve the account, found through GitHub search. */
  async listIssues(
    input: {
      filter?: GitHubIssueListFilter
      query?: string
      limit?: number
    } = {},
  ): Promise<GitHubIssueListResult> {
    const filter = input.filter ?? 'involved'
    if (!Object.hasOwn(ISSUE_FILTER_QUALIFIERS, filter))
      invalidArgument('Issue 筛选条件不合法。')
    const limit = validLimit(input.limit)
    const text = sanitizePullRequestQuery(input.query)
    const search = [
      'is:issue',
      'is:open',
      ISSUE_FILTER_QUALIFIERS[filter],
      text,
    ]
      .filter(Boolean)
      .join(' ')
    const runtime = await this.requireRuntime()
    const result = await this.gh(
      runtime,
      [
        'api',
        'graphql',
        '-f',
        `query=${GITHUB_ISSUE_SEARCH_QUERY}`,
        '-f',
        `q=${search}`,
        '-F',
        `n=${limit}`,
      ],
      { subject: 'issue' },
    )
    const searchResult = record(graphqlData(result, 'issue').search)
    const items = records(searchResult.nodes)
      .map(issueListItem)
      .filter((item): item is GitHubIssueListItem => item !== null)
    const total = nonNegativeInteger(searchResult.issueCount) ?? items.length
    return { items, total: Math.max(total, items.length) }
  }

  async viewIssue(
    input: {
      repo: string
      number: number
    },
    options: GitHubReadOptions = {},
  ): Promise<GitHubIssueDetail> {
    const { owner, name } = splitRepo(validRepo(input.repo))
    const number = validNumber(input.number, 'Issue 编号不合法。')
    const runtime = await this.requireRuntime()
    const result = await this.gh(
      runtime,
      [
        'api',
        'graphql',
        '-f',
        `query=${GITHUB_ISSUE_VIEW_QUERY}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${number}`,
      ],
      { subject: 'issue', ...options },
    )
    const issue = issueDetail(
      record(record(graphqlData(result, 'issue').repository).issue),
    )
    if (!issue) notFound('issue')
    return issue
  }

  /** Recent GitHub Actions runs of one repository (REST, always an explicit GET). */
  async listRuns(input: {
    repo: string
    branch?: string
    limit?: number
  }): Promise<GitHubRunListResult> {
    const repo = validRepo(input.repo)
    const limit = validLimit(input.limit)
    if (
      input.branch !== undefined &&
      (typeof input.branch !== 'string' ||
        !GITHUB_BRANCH_PATTERN.test(input.branch) ||
        input.branch.includes('..'))
    )
      invalidArgument('分支名称不合法。')
    const runtime = await this.requireRuntime()
    const result = await this.gh(
      runtime,
      [
        'api',
        '--method',
        'GET',
        `repos/${repo}/actions/runs`,
        '-F',
        `per_page=${limit}`,
        ...(input.branch ? ['-f', `branch=${input.branch}`] : []),
      ],
      { subject: 'run' },
    )
    const payload = restData(result)
    const items = records(payload.workflow_runs)
      .map(runListItem)
      .filter((item): item is GitHubRunListItem => item !== null)
    const total = nonNegativeInteger(payload.total_count) ?? items.length
    return { items, total: Math.max(total, items.length) }
  }

  async viewRun(
    input: {
      repo: string
      runId: number
    },
    options: GitHubReadOptions = {},
  ): Promise<GitHubRunDetail> {
    const repo = validRepo(input.repo)
    const runId = input.runId
    if (
      typeof runId !== 'number' ||
      !Number.isInteger(runId) ||
      runId < 1 ||
      runId > GITHUB_RUN_ID_MAX
    )
      invalidArgument('运行记录编号不合法。')
    const runtime = await this.requireRuntime()
    const runResult = await this.gh(
      runtime,
      ['api', '--method', 'GET', `repos/${repo}/actions/runs/${runId}`],
      { subject: 'run', ...options },
    )
    const run = runListItem(restData(runResult))
    if (!run) notFound('run')
    const jobsResult = await this.gh(
      runtime,
      [
        'api',
        '--method',
        'GET',
        `repos/${repo}/actions/runs/${runId}/jobs`,
        '-F',
        'per_page=100',
      ],
      { subject: 'run', ...options },
    )
    const jobs = records(restData(jobsResult).jobs)
      .map(runJob)
      .filter((job): job is GitHubRunJob => job !== null)
    return { run, jobs }
  }

  private async resolveRuntime(fresh: boolean): Promise<GhRuntime | null> {
    const now = (this.options.now ?? Date.now)()
    const ttl = this.options.runtimeCacheMs ?? 30_000
    const cached = this.runtimeCache
    if (!fresh && cached && now - cached.at >= 0 && now - cached.at < ttl)
      return cached.runtime
    const runtime = await this.options.resolveRuntime()
    this.runtimeCache = runtime ? { runtime, at: now } : null
    return runtime
  }

  private async requireRuntime(): Promise<GhRuntime> {
    const runtime = await this.resolveRuntime(false)
    if (!runtime)
      throw new WorkspaceOperationError(
        'pull_request_gh_missing',
        '当前签名执行环境中没有可用的 GitHub CLI；请在诊断中安装 gh。',
      )
    return runtime
  }

  private async gh(
    runtime: GhRuntime,
    args: string[],
    options: {
      allowTruncated?: boolean
      subject?: GhSubject
      signal?: AbortSignal
    } = {},
  ): Promise<GhCommandResult> {
    if (options.signal?.aborted)
      throw new WorkspaceOperationError('cancelled', 'GitHub 读取已取消。')
    const result = await this.options.run({
      executable: runtime.executable,
      args,
      cwd: this.options.cwd,
      env: ghProcessEnvironment(runtime.env),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (result.exitCode !== 0)
      throw ghFailure(result, options.subject ?? 'pull_request')
    if (result.stdoutTruncated && !options.allowTruncated)
      throw new WorkspaceOperationError(
        'pull_request_output_too_large',
        'GitHub CLI 返回的数据超过安全读取上限。',
      )
    return result
  }
}

/**
 * Adapts the signed-environment process runner to gh's result shape: a 60 s
 * timeout, a 4 MiB output cap that keeps the *head* of stdout (reported as
 * `stdoutTruncated` with exit code 0 so `diff` can return a bounded prefix),
 * and readable stderr for timeouts and spawn errors.
 */
export function createGhCommandRunner(
  runner: EnvironmentProcessRunner,
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
): (request: GhCommandRequest) => Promise<GhCommandResult> {
  return async (request) => {
    const result = await runner.run({
      executable: request.executable,
      args: [...request.args],
      cwd: request.cwd,
      env: request.env,
      timeoutMs: limits.timeoutMs ?? 60_000,
      ...(request.signal ? { signal: request.signal } : {}),
      maxOutputBytes: limits.maxOutputBytes ?? PULL_REQUEST_DIFF_MAX_BYTES,
    })
    const stdoutCapped =
      result.status === 'output_limit' &&
      result.stdoutTruncated === true &&
      result.stderrTruncated !== true
    return {
      exitCode: stdoutCapped
        ? 0
        : (result.exitCode ?? (result.status === 'completed' ? 0 : 1)),
      stdout: result.stdout,
      stderr:
        result.stderr ||
        result.error ||
        (result.status === 'timeout' ? 'GitHub CLI 请求超时。' : ''),
      stdoutTruncated: result.stdoutTruncated === true,
    }
  }
}

/**
 * The GitHub search string: always `is:pr is:open`, the filter's `@me`
 * qualifier, then the sanitized user text. Exported for tests.
 */
export function buildPullRequestSearch(
  filter: PullRequestListFilter,
  query?: string,
): string {
  const text = sanitizePullRequestQuery(query)
  return ['is:pr', 'is:open', FILTER_QUALIFIERS[filter], text]
    .filter(Boolean)
    .join(' ')
}

/** Trim and collapse whitespace; reject control characters and oversize text. */
export function sanitizePullRequestQuery(query: unknown): string {
  if (query === undefined || query === null) return ''
  if (typeof query !== 'string') invalidArgument('搜索内容不合法。')
  if (
    query.length > PULL_REQUEST_QUERY_MAX_LENGTH ||
    hasControlCharacter(query)
  )
    invalidArgument('搜索内容不合法。')
  return query.trim().replace(/\s+/g, ' ')
}

export function validRepo(value: unknown): string {
  const repo = typeof value === 'string' ? value : ''
  const name = repo.split('/')[1] ?? ''
  if (!PULL_REQUEST_REPO_PATTERN.test(repo) || name === '.' || name === '..')
    invalidArgument('仓库名称不合法。')
  return repo
}

function validNumber(
  value: unknown,
  message = 'Pull Request 编号不合法。',
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > PULL_REQUEST_NUMBER_MAX
  )
    invalidArgument(message)
  return value
}

function validLimit(value: unknown): number {
  if (value === undefined || value === null)
    return PULL_REQUEST_LIST_DEFAULT_LIMIT
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > PULL_REQUEST_LIST_MAX_LIMIT
  )
    invalidArgument('Pull Request 数量上限不合法。')
  return value
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = '', name = ''] = repo.split('/')
  return { owner, name }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return true
  }
  return false
}

function ghFailure(
  result: GhCommandResult,
  subject: GhSubject = 'pull_request',
): WorkspaceOperationError {
  const output = `${result.stderr}\n${result.stdout}`
  if (
    result.exitCode === 4 ||
    /gh auth login|authentication required|not logged in|HTTP 401|bad credentials|requires authentication/i.test(
      output,
    )
  )
    return new WorkspaceOperationError(
      'pull_request_gh_unauthenticated',
      'GitHub CLI 尚未登录；请在终端运行 gh auth login。',
    )
  // Rate limits answer 403 or 429, so they come before the plain 403.
  if (/rate limit|HTTP 429/i.test(output))
    return new WorkspaceOperationError(
      'pull_request_rate_limited',
      'GitHub 暂时限流，请稍后再试。',
    )
  if (
    /HTTP 403|Resource not accessible|must have (?:admin|push) (?:rights|access)|\bForbidden\b/i.test(
      output,
    )
  )
    return new WorkspaceOperationError(
      'pull_request_forbidden',
      '当前账户没有读取这个仓库的权限。',
    )
  if (
    /Could not resolve to an? (?:Repository|PullRequest|Issue)|"type"\s*:\s*"NOT_FOUND"|HTTP 404|no pull requests? found|\bNot Found\b/i.test(
      output,
    )
  )
    return new WorkspaceOperationError(
      'pull_request_not_found',
      NOT_FOUND_MESSAGES[subject],
    )
  const detail = sanitizeGitError(result.stderr || result.stdout)
    .replace(/\s+/g, ' ')
    .slice(0, 500)
  return new WorkspaceOperationError(
    'pull_request_gh_failed',
    detail || 'GitHub CLI 操作失败。',
  )
}

function graphqlData(
  result: GhCommandResult,
  subject: GhSubject = 'pull_request',
): JsonRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    throw new WorkspaceOperationError(
      'pull_request_invalid_response',
      'GitHub CLI 返回了无效数据。',
      { cause: error },
    )
  }
  const payload = record(parsed)
  if (Array.isArray(payload.errors) && payload.errors.length)
    throw ghFailure({ ...result, exitCode: 1 }, subject)
  if (!isRecord(payload.data))
    throw new WorkspaceOperationError(
      'pull_request_invalid_response',
      'GitHub CLI 返回了无效数据。',
    )
  return payload.data
}

/** A REST response body; gh prints the JSON as it came. */
function restData(result: GhCommandResult): JsonRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    throw new WorkspaceOperationError(
      'pull_request_invalid_response',
      'GitHub CLI 返回了无效数据。',
      { cause: error },
    )
  }
  if (!isRecord(parsed))
    throw new WorkspaceOperationError(
      'pull_request_invalid_response',
      'GitHub CLI 返回了无效数据。',
    )
  return parsed
}

function labels(value: unknown): GitHubLabel[] {
  return records(record(value).nodes)
    .map((label) => ({ name: text(label.name), color: text(label.color) }))
    .filter((label) => label.name)
}

function issueListItem(node: JsonRecord): GitHubIssueListItem | null {
  const repo = text(record(node.repository).nameWithOwner)
  const number = positiveInteger(node.number)
  const url = safeGithubUrl(node.url)
  if (!PULL_REQUEST_REPO_PATTERN.test(repo) || number === null || !url)
    return null
  return {
    repo,
    number,
    title: text(node.title),
    state: text(node.state),
    url,
    author: text(record(node.author).login) || 'ghost',
    createdAt: text(node.createdAt),
    updatedAt: text(node.updatedAt),
    labels: labels(node.labels),
    commentCount: nonNegativeInteger(record(node.comments).totalCount) ?? 0,
  }
}

function issueDetail(node: JsonRecord): GitHubIssueDetail | null {
  const base = issueListItem(node)
  if (!base) return null
  const comments = record(node.comments)
  const latest = records(comments.nodes).map((comment) => ({
    author: text(record(comment.author).login) || 'ghost',
    body: text(comment.body),
    createdAt: text(comment.createdAt),
  }))
  return {
    ...base,
    body: text(node.body),
    stateReason: text(node.stateReason) || null,
    closedAt: text(node.closedAt) || null,
    assignees: records(record(node.assignees).nodes)
      .map((assignee) => text(assignee.login))
      .filter(Boolean),
    commentCount: nonNegativeInteger(comments.totalCount) ?? latest.length,
    comments: latest,
  }
}

function runListItem(node: JsonRecord): GitHubRunListItem | null {
  const id = positiveInteger(node.id)
  const url = safeGithubUrl(node.html_url)
  if (id === null || !url) return null
  return {
    id,
    name: text(node.name),
    title: text(node.display_title),
    status: text(node.status),
    conclusion: text(node.conclusion) || null,
    event: text(node.event),
    branch: text(node.head_branch) || null,
    runNumber: positiveInteger(node.run_number),
    createdAt: text(node.created_at),
    updatedAt: text(node.updated_at),
    url,
    actor: text(record(node.actor).login) || 'ghost',
  }
}

function runJob(node: JsonRecord): GitHubRunJob | null {
  const id = positiveInteger(node.id)
  if (id === null) return null
  return {
    id,
    name: text(node.name),
    status: text(node.status),
    conclusion: text(node.conclusion) || null,
    startedAt: text(node.started_at) || null,
    completedAt: text(node.completed_at) || null,
    url: safeGithubUrl(node.html_url),
    steps: records(node.steps).map((step) => ({
      number: nonNegativeInteger(step.number) ?? 0,
      name: text(step.name),
      status: text(step.status),
      conclusion: text(step.conclusion) || null,
    })),
  }
}

function listItem(node: JsonRecord): PullRequestListItem | null {
  const repo = text(record(node.repository).nameWithOwner)
  const number = positiveInteger(node.number)
  const url = safeGithubUrl(node.url)
  if (!PULL_REQUEST_REPO_PATTERN.test(repo) || number === null || !url)
    return null
  return {
    repo,
    number,
    title: text(node.title),
    state: text(node.state),
    isDraft: node.isDraft === true,
    url,
    author: text(record(node.author).login) || 'ghost',
    createdAt: text(node.createdAt),
    updatedAt: text(node.updatedAt),
    headRefName: text(node.headRefName) || null,
    additions: nonNegativeInteger(node.additions),
    deletions: nonNegativeInteger(node.deletions),
    checks: rollupState(node),
    reviewDecision: reviewDecision(node.reviewDecision),
  }
}

function pullRequestDetail(node: JsonRecord): PullRequestDetail | null {
  const repo = text(record(node.repository).nameWithOwner)
  const number = positiveInteger(node.number)
  const url = safeGithubUrl(node.url)
  if (!PULL_REQUEST_REPO_PATTERN.test(repo) || number === null || !url)
    return null
  const files = records(record(node.files).nodes)
    .map((file) => ({
      path: text(file.path),
      additions: nonNegativeInteger(file.additions) ?? 0,
      deletions: nonNegativeInteger(file.deletions) ?? 0,
    }))
    .filter((file) => file.path)
  return {
    repo,
    number,
    title: text(node.title),
    body: text(node.body),
    state: text(node.state),
    isDraft: node.isDraft === true,
    url,
    author: text(record(node.author).login) || 'ghost',
    createdAt: text(node.createdAt),
    updatedAt: text(node.updatedAt),
    headRefName: text(node.headRefName),
    baseRefName: text(node.baseRefName),
    additions: nonNegativeInteger(node.additions) ?? 0,
    deletions: nonNegativeInteger(node.deletions) ?? 0,
    changedFiles: nonNegativeInteger(node.changedFiles) ?? files.length,
    files,
    commits: nonNegativeInteger(record(node.commits).totalCount) ?? 0,
    checks: headCommitChecks(node),
    reviewDecision: reviewDecision(node.reviewDecision),
  }
}

function rollupState(node: JsonRecord): PullRequestChecksState | null {
  const commit = record(records(record(node.commits).nodes)[0]?.commit)
  const state = text(record(commit.statusCheckRollup).state)
  if (state === 'SUCCESS') return 'success'
  if (state === 'FAILURE' || state === 'ERROR') return 'failure'
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
  return null
}

function headCommitChecks(node: JsonRecord): PullRequestCheck[] {
  const commit = record(records(record(node.headCommit).nodes)[0]?.commit)
  const contexts = records(
    record(record(commit.statusCheckRollup).contexts).nodes,
  )
  return contexts
    .map((context): PullRequestCheck | null => {
      if (context.__typename === 'StatusContext') {
        const state = text(context.state)
        const pending = state === 'PENDING' || state === 'EXPECTED'
        return {
          name: text(context.context),
          status: pending ? 'PENDING' : 'COMPLETED',
          conclusion: pending ? null : state || null,
        }
      }
      if (context.__typename === 'CheckRun')
        return {
          name: text(context.name),
          status: text(context.status),
          conclusion: text(context.conclusion) || null,
        }
      return null
    })
    .filter((check): check is PullRequestCheck => Boolean(check?.name))
}

function reviewDecision(value: unknown): PullRequestReviewDecision | null {
  return value === 'APPROVED' ||
    value === 'CHANGES_REQUESTED' ||
    value === 'REVIEW_REQUIRED'
    ? value
    : null
}

function safeGithubUrl(value: unknown): string | null {
  try {
    const url = new URL(text(value))
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

/** Longest prefix within `maxBytes` UTF-8 bytes, cut on a code point boundary. */
function boundedUtf8Prefix(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false }
  let end = maxBytes
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function invalidArgument(message: string): never {
  throw new WorkspaceOperationError('pull_request_argument_invalid', message)
}

function notFound(subject: GhSubject = 'pull_request'): never {
  throw new WorkspaceOperationError(
    'pull_request_not_found',
    NOT_FOUND_MESSAGES[subject],
  )
}
