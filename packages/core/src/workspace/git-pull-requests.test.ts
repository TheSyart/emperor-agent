import { describe, expect, it } from 'vitest'
import {
  GitPullRequestService,
  type PullRequestContext,
} from './git-pull-requests'

describe('GitPullRequestService', () => {
  it('returns an actionable error when signed gh is unavailable', async () => {
    const service = new GitPullRequestService({
      resolveRuntime: async () => null,
      run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      context: async () => context(),
      record: async () => undefined,
    })
    await expect(
      service.pullRequest({ sessionId: 'session-1' }),
    ).rejects.toMatchObject({ code: 'git_gh_unavailable' })
  })

  it('creates a PR with shell-free argv and emits a safe receipt', async () => {
    const calls: string[][] = []
    const receipts: unknown[] = []
    let viewed = false
    const service = new GitPullRequestService({
      resolveRuntime: async () => ({
        executable: '/signed/gh',
        env: { PATH: '/signed', GH_TOKEN: 'must-not-forward' },
      }),
      run: async (request) => {
        calls.push(request.args)
        if (request.args[0] === 'pr' && request.args[1] === 'view') {
          if (!viewed) {
            viewed = true
            return {
              exitCode: 1,
              stdout: '',
              stderr: 'no pull requests found',
            }
          }
          return {
            exitCode: 0,
            stdout:
              '{"number":7,"url":"https://github.com/acme/repo/pull/7","state":"OPEN","isDraft":true,"mergeable":"MERGEABLE","headRefName":"feature","baseRefName":"main","statusCheckRollup":[]}',
            stderr: '',
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      context: async () => context(),
      record: async (_sessionId, receipt) => {
        receipts.push(receipt)
      },
    })

    const result = await service.publishPullRequest({
      sessionId: 'session-1',
      title: 'Ship it',
      body: 'Details',
      draft: true,
      expectedRevision: 'a'.repeat(64),
      confirmed: true,
    })

    expect(calls).toContainEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'feature',
      '--title',
      'Ship it',
      '--body',
      'Details',
      '--draft',
    ])
    expect(result?.number).toBe(7)
    expect(receipts).toEqual([
      expect.objectContaining({
        action: 'publish_pr',
        pullRequest: expect.objectContaining({ number: 7 }),
      }),
    ])
  })

  it('fails closed before invoking gh for transient or truncated repositories', async () => {
    let calls = 0
    const service = new GitPullRequestService({
      resolveRuntime: async () => ({ executable: '/signed/gh', env: {} }),
      run: async () => {
        calls += 1
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      context: async (sessionId) =>
        sessionId === 'transient'
          ? context({ transientState: 'rebase' })
          : context({ truncated: true }),
      record: async () => undefined,
    })

    await expect(
      service.readyPullRequest({
        sessionId: 'transient',
        number: 7,
        expectedRevision: 'a'.repeat(64),
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'git_transient_state' })
    await expect(
      service.closePullRequest({
        sessionId: 'truncated',
        number: 7,
        expectedRevision: 'a'.repeat(64),
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'git_status_truncated' })
    expect(calls).toBe(0)
  })

  it('does not merge when required checks have not passed', async () => {
    const calls: string[][] = []
    const service = new GitPullRequestService({
      resolveRuntime: async () => ({ executable: '/signed/gh', env: {} }),
      run: async (request) => {
        calls.push(request.args)
        return {
          exitCode: 0,
          stdout:
            '{"number":7,"url":"https://github.com/acme/repo/pull/7","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","headRefName":"feature","baseRefName":"main","statusCheckRollup":[{"name":"test","status":"COMPLETED","conclusion":"FAILURE"}]}',
          stderr: '',
        }
      },
      context: async () => context(),
      record: async () => undefined,
    })

    await expect(
      service.mergePullRequest({
        sessionId: 'session-1',
        number: 7,
        method: 'squash',
        deleteBranch: true,
        expectedRevision: 'a'.repeat(64),
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'git_pr_not_mergeable' })
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(
      false,
    )
  })
})

function context(
  overrides: Partial<PullRequestContext> = {},
): PullRequestContext {
  return { ...baseContext(), ...overrides }
}

function baseContext(): PullRequestContext {
  return {
    cwd: '/repo',
    revision: 'a'.repeat(64),
    branch: 'feature',
    headOid: 'b'.repeat(40),
    defaultBranch: 'main',
    upstream: 'origin/feature',
    ahead: 0,
    transientState: 'none',
    changedFiles: 0,
    truncated: false,
  }
}
