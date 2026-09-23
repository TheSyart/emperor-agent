import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getPullRequestDiff,
  getPullRequestStatus,
  listPullRequests,
  pullRequestErrorInfo,
  viewPullRequest,
} from './pullRequests'

function codedError(code: string, message = 'core message') {
  return Object.assign(new Error(message), { code })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pullRequestErrorInfo', () => {
  it.each([
    ['pull_request_gh_missing', 'unavailable'],
    ['pull_request_gh_unauthenticated', 'unavailable'],
    ['pull_request_not_found', 'not_found'],
    ['pull_request_argument_invalid', 'invalid'],
    ['pull_request_gh_failed', 'failed'],
    ['pull_request_invalid_response', 'failed'],
    ['pull_request_output_too_large', 'failed'],
  ])('%s → %s', (code, kind) => {
    const info = pullRequestErrorInfo(codedError(code))
    expect(info.code).toBe(code)
    expect(info.kind).toBe(kind)
    expect(info.message).toBeTruthy()
  })

  it('keeps the sanitized gh detail only for gh_failed', () => {
    expect(
      pullRequestErrorInfo(
        codedError('pull_request_gh_failed', 'HTTP 502 from api.github.com'),
      ).message,
    ).toBe('HTTP 502 from api.github.com')
    expect(
      pullRequestErrorInfo(codedError('pull_request_gh_failed', '')).message,
    ).toBe('GitHub CLI 操作失败。')
    expect(
      pullRequestErrorInfo(codedError('pull_request_not_found', 'raw detail'))
        .message,
    ).toBe('找不到该 Pull Request，或当前账户无权访问该仓库。')
  })

  it('treats unknown failures as retryable', () => {
    expect(pullRequestErrorInfo(new Error('IPC closed'))).toEqual({
      code: null,
      kind: 'failed',
      message: 'IPC closed',
    })
    expect(pullRequestErrorInfo(codedError('something_else', ''))).toEqual({
      code: null,
      kind: 'failed',
      message: '读取 Pull Request 失败。',
    })
    expect(pullRequestErrorInfo(null).kind).toBe('failed')
  })
})

describe('pullRequests wrappers', () => {
  function stubBridge(result: unknown = {}) {
    const invokeCore = vi.fn(async () => result)
    vi.stubGlobal('window', { emperor: { invokeCore } })
    return invokeCore
  }

  it('calls the four Core operations with trimmed, capped input', async () => {
    const invokeCore = stubBridge({ items: [], total: 0 })
    await getPullRequestStatus()
    await listPullRequests({ filter: 'mine', query: '  fix  ', limit: 50 })
    await listPullRequests({ filter: 'all', query: '   ' })
    await listPullRequests({ filter: 'reviewing', query: 'x'.repeat(300) })
    await viewPullRequest({ repo: 'acme/widgets', number: 7 })
    await getPullRequestDiff({ repo: 'acme/widgets', number: 7 })
    expect(invokeCore.mock.calls).toEqual([
      ['pullRequests.status'],
      ['pullRequests.list', { filter: 'mine', query: 'fix', limit: 50 }],
      ['pullRequests.list', { filter: 'all' }],
      ['pullRequests.list', { filter: 'reviewing', query: 'x'.repeat(200) }],
      ['pullRequests.view', { repo: 'acme/widgets', number: 7 }],
      ['pullRequests.diff', { repo: 'acme/widgets', number: 7 }],
    ])
  })

  it('rejects with the Core error code from an IPC error envelope', async () => {
    stubBridge({
      ok: false,
      error: { message: '未登录', code: 'pull_request_gh_unauthenticated' },
    })
    const error = await listPullRequests({ filter: 'all' }).catch((e) => e)
    expect(pullRequestErrorInfo(error).kind).toBe('unavailable')
  })
})
