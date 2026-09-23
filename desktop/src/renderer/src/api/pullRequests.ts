import type {
  PullRequestBrowserStatus,
  PullRequestDetail,
  PullRequestDiffResult,
  PullRequestListFilter,
  PullRequestListResult,
} from '@emperor/core/api'
import { core } from './http'

/**
 * Typed wrappers of the Core `pullRequests.*` operations (the Pull Request
 * page). Read-only and global: every call names its repository explicitly;
 * nothing here is session- or project-scoped. `status()` never rejects for
 * gh problems (it reports an unavailable reason); list / view / diff reject
 * with a coded Core error — read it with {@link pullRequestErrorInfo}.
 */

export type {
  PullRequestBrowserStatus,
  PullRequestBrowserUnavailableReason,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestDetail,
  PullRequestDiffResult,
  PullRequestListFilter,
  PullRequestListItem,
  PullRequestListResult,
  PullRequestReviewDecision,
} from '@emperor/core/api'

/** Core search text cap (`pullRequests.list` rejects longer queries). */
export const PULL_REQUEST_QUERY_MAX = 200
/** Core page-size ceiling for `pullRequests.list`. */
export const PULL_REQUEST_LIST_LIMIT_MAX = 50

export interface PullRequestRef {
  /** `owner/name`. */
  repo: string
  number: number
}

export async function getPullRequestStatus(): Promise<PullRequestBrowserStatus> {
  return core('pullRequests.status')
}

/** Open Pull Requests involving / awaiting review from / authored by the account. */
export async function listPullRequests(input: {
  filter: PullRequestListFilter
  query?: string
  limit?: number
}): Promise<PullRequestListResult> {
  const query = (input.query ?? '').trim().slice(0, PULL_REQUEST_QUERY_MAX)
  return core('pullRequests.list', {
    filter: input.filter,
    ...(query ? { query } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  })
}

export async function viewPullRequest(
  ref: PullRequestRef,
): Promise<PullRequestDetail> {
  return core('pullRequests.view', { repo: ref.repo, number: ref.number })
}

/** Unified diff, bounded to 4 MiB (`truncated` when cut). */
export async function getPullRequestDiff(
  ref: PullRequestRef,
): Promise<PullRequestDiffResult> {
  return core('pullRequests.diff', { repo: ref.repo, number: ref.number })
}

/** Core error codes of `pullRequests.*` failures. */
export type PullRequestErrorCode =
  | 'pull_request_argument_invalid'
  | 'pull_request_gh_missing'
  | 'pull_request_gh_unauthenticated'
  | 'pull_request_not_found'
  | 'pull_request_gh_failed'
  | 'pull_request_invalid_response'
  | 'pull_request_output_too_large'

/**
 * How the page reacts to a failure:
 * - `unavailable`: gh went missing / logged out — re-check `status()` and show
 *   the page-level empty state.
 * - `not_found`: the PR does not exist or the account cannot see it.
 * - `invalid`: a malformed repo / number / query (bad deep link).
 * - `failed`: anything else; retryable.
 */
export type PullRequestErrorKind =
  'unavailable' | 'not_found' | 'invalid' | 'failed'

export interface PullRequestErrorInfo {
  code: PullRequestErrorCode | null
  kind: PullRequestErrorKind
  /** One-line Chinese message for the UI. */
  message: string
}

const ERROR_MESSAGES: Readonly<Record<PullRequestErrorCode, string>> = {
  pull_request_argument_invalid: '请求的 Pull Request 参数不合法。',
  pull_request_gh_missing: '当前环境中没有可用的 GitHub CLI（gh）。',
  pull_request_gh_unauthenticated:
    'GitHub CLI 尚未登录，请在终端运行 gh auth login。',
  pull_request_not_found: '找不到该 Pull Request，或当前账户无权访问该仓库。',
  pull_request_gh_failed: 'GitHub CLI 操作失败。',
  pull_request_invalid_response: 'GitHub CLI 返回了无法识别的数据。',
  pull_request_output_too_large: 'GitHub 返回的数据超过了安全读取上限。',
}

const ERROR_KINDS: Readonly<
  Record<PullRequestErrorCode, PullRequestErrorKind>
> = {
  pull_request_argument_invalid: 'invalid',
  pull_request_gh_missing: 'unavailable',
  pull_request_gh_unauthenticated: 'unavailable',
  pull_request_not_found: 'not_found',
  pull_request_gh_failed: 'failed',
  pull_request_invalid_response: 'failed',
  pull_request_output_too_large: 'failed',
}

function isPullRequestErrorCode(value: unknown): value is PullRequestErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_MESSAGES, value)
}

/**
 * Read a rejected `pullRequests.*` call. `gh_failed` keeps Core's sanitized
 * gh detail (it names the actual problem); every other code uses the fixed
 * message above. Unknown errors (bridge down, IPC failure) are `failed`.
 */
export function pullRequestErrorInfo(error: unknown): PullRequestErrorInfo {
  const record =
    error && typeof error === 'object'
      ? (error as { code?: unknown; message?: unknown })
      : {}
  const detail = typeof record.message === 'string' ? record.message.trim() : ''
  if (!isPullRequestErrorCode(record.code))
    return {
      code: null,
      kind: 'failed',
      message: detail || '读取 Pull Request 失败。',
    }
  const code = record.code
  return {
    code,
    kind: ERROR_KINDS[code],
    message:
      code === 'pull_request_gh_failed' && detail
        ? detail
        : ERROR_MESSAGES[code],
  }
}
