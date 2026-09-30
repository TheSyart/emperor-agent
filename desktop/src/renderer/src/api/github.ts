import type {
  GitHubIssueDetail,
  GitHubIssueListFilter,
  GitHubIssueListResult,
  GitHubRunDetail,
  GitHubRunListResult,
} from '@emperor/core/api'
import { core } from './http'
import { PULL_REQUEST_QUERY_MAX } from './pullRequests'

/**
 * Typed wrappers of the Core `github.*` operations: the GitHub plugin's
 * read-only Issue and CI views. Each call names its repository; Core
 * refuses them with `github_plugin_disabled` while the plugin is off and
 * reports gh problems with the same codes as the Pull Request page.
 */

export type {
  GitHubIssueComment,
  GitHubIssueDetail,
  GitHubIssueListFilter,
  GitHubIssueListItem,
  GitHubIssueListResult,
  GitHubLabel,
  GitHubRunDetail,
  GitHubRunJob,
  GitHubRunListItem,
  GitHubRunListResult,
} from '@emperor/core/api'

export async function listGitHubIssues(input: {
  filter: GitHubIssueListFilter
  query?: string
  limit?: number
}): Promise<GitHubIssueListResult> {
  const query = (input.query ?? '').trim().slice(0, PULL_REQUEST_QUERY_MAX)
  return core('github.listIssues', {
    filter: input.filter,
    ...(query ? { query } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  })
}

export async function viewGitHubIssue(input: {
  repo: string
  number: number
}): Promise<GitHubIssueDetail> {
  return core('github.viewIssue', { repo: input.repo, number: input.number })
}

export async function listGitHubRuns(input: {
  repo: string
  branch?: string
  limit?: number
}): Promise<GitHubRunListResult> {
  return core('github.listRuns', {
    repo: input.repo,
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  })
}

export async function viewGitHubRun(input: {
  repo: string
  runId: number
}): Promise<GitHubRunDetail> {
  return core('github.viewRun', { repo: input.repo, runId: input.runId })
}
