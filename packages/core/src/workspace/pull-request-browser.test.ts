import { describe, expect, it } from 'vitest'
import type { GhCommandRequest, GhCommandResult } from './git-pull-requests'
import {
  buildPullRequestSearch,
  createGhCommandRunner,
  PULL_REQUEST_DIFF_MAX_BYTES,
  PULL_REQUEST_SEARCH_QUERY,
  PULL_REQUEST_VIEW_QUERY,
  PullRequestBrowserService,
  sanitizePullRequestQuery,
  type GhRuntime,
} from './pull-request-browser'
import type {
  EnvironmentProcessRequest,
  EnvironmentProcessResult,
} from '../environment/process-runner'

// Shapes captured from `gh api graphql` (gh 2.73.0, 2026-09) with repository
// names, titles, branches and logins replaced by placeholders.
const SEARCH_RESPONSE = {
  data: {
    search: {
      issueCount: 3,
      nodes: [
        {
          number: 96,
          title: 'Fix flaky upload retry',
          state: 'OPEN',
          isDraft: false,
          url: 'https://github.com/acme/widgets/pull/96',
          createdAt: '2026-09-11T10:07:08Z',
          updatedAt: '2026-09-11T10:07:08Z',
          headRefName: 'fix/upload-retry',
          additions: 43,
          deletions: 1,
          reviewDecision: null,
          author: { login: 'octo-dev' },
          repository: { nameWithOwner: 'acme/widgets' },
          commits: {
            nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }],
          },
        },
        {
          number: 1,
          title: 'Draft: new settings page',
          state: 'OPEN',
          isDraft: true,
          url: 'https://github.com/acme/console/pull/1',
          createdAt: '2026-06-20T17:00:08Z',
          updatedAt: '2026-06-22T12:39:02Z',
          headRefName: 'feat/settings',
          additions: 18813,
          deletions: 2686,
          reviewDecision: 'REVIEW_REQUIRED',
          author: null,
          repository: { nameWithOwner: 'acme/console' },
          commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        },
        {
          number: 7,
          title: 'Pending checks',
          state: 'OPEN',
          isDraft: false,
          url: 'https://github.com/acme/widgets/pull/7',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-02T00:00:00Z',
          headRefName: 'chore/deps',
          additions: 2,
          deletions: 2,
          reviewDecision: 'APPROVED',
          author: { login: 'renovate-bot' },
          repository: { nameWithOwner: 'acme/widgets' },
          commits: {
            nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }],
          },
        },
        // Issues matched by a malformed search collapse to empty objects.
        {},
      ],
    },
  },
}

const VIEW_RESPONSE = {
  data: {
    repository: {
      pullRequest: {
        number: 42,
        title: 'Release verification',
        body: 'Adds verification.\r\n\r\n- [x] tests',
        state: 'OPEN',
        isDraft: true,
        url: 'https://github.com/acme/widgets/pull/42',
        createdAt: '2026-05-19T15:38:59Z',
        updatedAt: '2026-05-19T15:44:38Z',
        headRefName: 'release/verify',
        baseRefName: 'main',
        additions: 719,
        deletions: 0,
        changedFiles: 8,
        reviewDecision: 'CHANGES_REQUESTED',
        author: { login: 'octo-dev' },
        repository: { nameWithOwner: 'acme/widgets' },
        commits: { totalCount: 3 },
        files: {
          nodes: [
            { path: 'src/verify.ts', additions: 8, deletions: 0 },
            { path: 'src/release.ts', additions: 2, deletions: 0 },
            { path: null, additions: 1, deletions: 1 },
          ],
        },
        headCommit: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: 'CheckRun',
                        name: 'build (ubuntu-latest)',
                        status: 'COMPLETED',
                        conclusion: 'SUCCESS',
                      },
                      {
                        __typename: 'CheckRun',
                        name: 'lint',
                        status: 'IN_PROGRESS',
                        conclusion: null,
                      },
                      {
                        __typename: 'StatusContext',
                        context: 'ci/legacy',
                        state: 'FAILURE',
                      },
                      {
                        __typename: 'StatusContext',
                        context: 'ci/pending',
                        state: 'PENDING',
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
}

const RUNTIME: GhRuntime = {
  executable: '/signed/gh',
  version: '2.101.0',
  env: {
    PATH: '/signed',
    HOME: '/Users/tester',
    APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
    GH_CONFIG_DIR: '/Users/tester/.config/gh',
    GH_TOKEN: 'must-not-forward',
    GITHUB_TOKEN: 'must-not-forward',
    GH_HOST: 'evil.example',
    GH_FORCE_TTY: '1',
  },
}

function ok(stdout: string, extra: Partial<GhCommandResult> = {}) {
  return { exitCode: 0, stdout, stderr: '', ...extra }
}

function browser(
  respond: (request: GhCommandRequest) => GhCommandResult,
  opts: {
    runtime?: GhRuntime | null
    now?: () => number
    resolveCount?: { value: number }
  } = {},
): { service: PullRequestBrowserService; calls: GhCommandRequest[] } {
  const calls: GhCommandRequest[] = []
  const service = new PullRequestBrowserService({
    cwd: '/state-root',
    resolveRuntime: async () => {
      if (opts.resolveCount) opts.resolveCount.value += 1
      return opts.runtime === undefined ? RUNTIME : opts.runtime
    },
    run: async (request) => {
      calls.push(request)
      return respond(request)
    },
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { service, calls }
}

describe('PullRequestBrowserService.status', () => {
  it('reports the gh login and catalog version with fixed argv', async () => {
    const { service, calls } = browser(() => ok('octo-dev\n'))
    await expect(service.status()).resolves.toEqual({
      available: true,
      login: 'octo-dev',
      version: '2.101.0',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      executable: '/signed/gh',
      args: ['api', 'user', '--jq', '.login'],
      cwd: '/state-root',
    })
  })

  it('filters the child environment to the gh allowlist', async () => {
    const { service, calls } = browser(() => ok('octo-dev\n'))
    await service.status()
    const env = calls[0]!.env
    expect(env).toMatchObject({
      PATH: '/signed',
      HOME: '/Users/tester',
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      GH_CONFIG_DIR: '/Users/tester/.config/gh',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      GIT_TERMINAL_PROMPT: '0',
    })
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_FORCE_TTY'])
      expect(env, key).not.toHaveProperty(key)
  })

  it('maps a missing runtime, missing login and gh failures to reasons', async () => {
    await expect(
      browser(() => ok(''), { runtime: null }).service.status(),
    ).resolves.toEqual({ available: false, reason: 'gh_missing' })

    const unauthenticated = browser(() => ({
      exitCode: 4,
      stdout: '',
      stderr:
        'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
    }))
    await expect(unauthenticated.service.status()).resolves.toEqual({
      available: false,
      reason: 'gh_unauthenticated',
      version: '2.101.0',
    })

    const badCredentials = browser(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 401: Bad credentials (https://api.github.com/user)',
    }))
    await expect(badCredentials.service.status()).resolves.toMatchObject({
      available: false,
      reason: 'gh_unauthenticated',
    })

    const network = browser(() => ({
      exitCode: 1,
      stdout: '',
      stderr:
        'error connecting to api.github.com via https://user:hunter2@proxy.example token=ghp_abcdefghijklmnopqrstuvwxyz',
    }))
    const failed = await network.service.status()
    expect(failed).toMatchObject({
      available: false,
      reason: 'gh_failed',
      version: '2.101.0',
    })
    expect(failed.message).toContain('error connecting to api.github.com')
    expect(failed.message).not.toContain('hunter2')
    expect(failed.message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz')

    await expect(browser(() => ok('')).service.status()).resolves.toMatchObject(
      { available: false, reason: 'gh_failed' },
    )
  })

  it('never lets a runtime resolution failure escape', async () => {
    const service = new PullRequestBrowserService({
      cwd: '/state-root',
      resolveRuntime: async () => {
        throw new Error('probe exploded')
      },
      run: async () => ok(''),
    })
    await expect(service.status()).resolves.toEqual({
      available: false,
      reason: 'gh_missing',
    })
  })
})

describe('PullRequestBrowserService.list', () => {
  it('runs one static GraphQL search with the search text as a single variable', async () => {
    const { service, calls } = browser(() =>
      ok(JSON.stringify(SEARCH_RESPONSE)),
    )
    const result = await service.list({
      filter: 'reviewing',
      query: '  label:bug   "upload retry" ',
      limit: 20,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cwd).toBe('/state-root')
    expect(calls[0]!.args).toEqual([
      'api',
      'graphql',
      '-f',
      `query=${PULL_REQUEST_SEARCH_QUERY}`,
      '-f',
      'q=is:pr is:open review-requested:@me label:bug "upload retry"',
      '-F',
      'n=20',
    ])
    expect(result.total).toBe(3)
    expect(result.items).toEqual([
      {
        repo: 'acme/widgets',
        number: 96,
        title: 'Fix flaky upload retry',
        state: 'OPEN',
        isDraft: false,
        url: 'https://github.com/acme/widgets/pull/96',
        author: 'octo-dev',
        createdAt: '2026-09-11T10:07:08Z',
        updatedAt: '2026-09-11T10:07:08Z',
        headRefName: 'fix/upload-retry',
        additions: 43,
        deletions: 1,
        checks: 'failure',
        reviewDecision: null,
      },
      {
        repo: 'acme/console',
        number: 1,
        title: 'Draft: new settings page',
        state: 'OPEN',
        isDraft: true,
        url: 'https://github.com/acme/console/pull/1',
        author: 'ghost',
        createdAt: '2026-06-20T17:00:08Z',
        updatedAt: '2026-06-22T12:39:02Z',
        headRefName: 'feat/settings',
        additions: 18813,
        deletions: 2686,
        checks: null,
        reviewDecision: 'REVIEW_REQUIRED',
      },
      expect.objectContaining({
        number: 7,
        checks: 'pending',
        reviewDecision: 'APPROVED',
        author: 'renovate-bot',
      }),
    ])
  })

  it('builds the filter qualifiers and defaults', async () => {
    expect(buildPullRequestSearch('all')).toBe('is:pr is:open involves:@me')
    expect(buildPullRequestSearch('mine', '')).toBe('is:pr is:open author:@me')
    expect(buildPullRequestSearch('reviewing', ' repo:acme/widgets ')).toBe(
      'is:pr is:open review-requested:@me repo:acme/widgets',
    )
    const { service, calls } = browser(() =>
      ok(JSON.stringify({ data: { search: { issueCount: 0, nodes: [] } } })),
    )
    await expect(service.list()).resolves.toEqual({ items: [], total: 0 })
    expect(calls[0]!.args.slice(-3)).toEqual([
      'q=is:pr is:open involves:@me',
      '-F',
      'n=30',
    ])
  })

  it('rejects invalid filters, limits and queries before running gh', async () => {
    const { service, calls } = browser(() => ok('{}'))
    for (const input of [
      { filter: 'everyone' as never },
      { filter: 'all' as const, limit: 0 },
      { filter: 'all' as const, limit: 51 },
      { filter: 'all' as const, limit: 1.5 },
      { filter: 'all' as const, query: 'x'.repeat(201) },
      { filter: 'all' as const, query: 'bug\nis:closed' },
      { filter: 'all' as const, query: 'bug\u0007' },
      { filter: 'all' as const, query: 42 as never },
    ])
      await expect(
        service.list(input),
        JSON.stringify(input),
      ).rejects.toMatchObject({ code: 'pull_request_argument_invalid' })
    expect(calls).toHaveLength(0)
    expect(sanitizePullRequestQuery(undefined)).toBe('')
    expect(sanitizePullRequestQuery('  修复   上传  ')).toBe('修复 上传')
    expect(() => sanitizePullRequestQuery('修复\t上传')).toThrow()
  })

  it('drops malformed nodes and unsafe URLs from the result', async () => {
    const { service } = browser(() =>
      ok(
        JSON.stringify({
          data: {
            search: {
              issueCount: 2,
              nodes: [
                {
                  ...SEARCH_RESPONSE.data.search.nodes[0],
                  url: 'javascript:alert(1)',
                },
                {
                  ...SEARCH_RESPONSE.data.search.nodes[0],
                  repository: { nameWithOwner: '../../etc' },
                },
              ],
            },
          },
        }),
      ),
    )
    await expect(service.list({ filter: 'all' })).resolves.toEqual({
      items: [],
      total: 2,
    })
  })

  it('maps gh and GraphQL failures to safe error codes', async () => {
    await expect(
      browser(() => ok(''), { runtime: null }).service.list({ filter: 'all' }),
    ).rejects.toMatchObject({ code: 'pull_request_gh_missing' })
    await expect(
      browser(() => ({
        exitCode: 4,
        stdout: '',
        stderr: 'To get started with GitHub CLI, please run:  gh auth login',
      })).service.list({ filter: 'all' }),
    ).rejects.toMatchObject({ code: 'pull_request_gh_unauthenticated' })
    await expect(
      browser(() => ok('not json')).service.list({ filter: 'all' }),
    ).rejects.toMatchObject({ code: 'pull_request_invalid_response' })
    await expect(
      browser(() =>
        ok(
          JSON.stringify({
            data: null,
            errors: [
              { type: 'RATE_LIMITED', message: 'API rate limit exceeded' },
            ],
          }),
        ),
      ).service.list({ filter: 'all' }),
    ).rejects.toMatchObject({ code: 'pull_request_gh_failed' })
    await expect(
      browser(() => ok('{"data":', { stdoutTruncated: true })).service.list({
        filter: 'all',
      }),
    ).rejects.toMatchObject({ code: 'pull_request_output_too_large' })
  })

  it('reuses a resolved runtime briefly but status always re-resolves', async () => {
    let now = 1_000
    const resolveCount = { value: 0 }
    const { service } = browser(
      (request) =>
        request.args[1] === 'user'
          ? ok('octo-dev\n')
          : ok(
              JSON.stringify({
                data: { search: { issueCount: 0, nodes: [] } },
              }),
            ),
      { now: () => now, resolveCount },
    )
    await service.status()
    await service.list({ filter: 'all' })
    await service.list({ filter: 'mine' })
    expect(resolveCount.value).toBe(1)
    now += 30_000
    await service.list({ filter: 'all' })
    expect(resolveCount.value).toBe(2)
    await service.status()
    expect(resolveCount.value).toBe(3)
  })
})

describe('PullRequestBrowserService.view', () => {
  it('passes owner, name and number as GraphQL variables and maps the detail', async () => {
    const { service, calls } = browser(() => ok(JSON.stringify(VIEW_RESPONSE)))
    const detail = await service.view({ repo: 'acme/widgets', number: 42 })
    expect(calls[0]!.args).toEqual([
      'api',
      'graphql',
      '-f',
      `query=${PULL_REQUEST_VIEW_QUERY}`,
      '-f',
      'owner=acme',
      '-f',
      'name=widgets',
      '-F',
      'number=42',
    ])
    expect(detail).toEqual({
      repo: 'acme/widgets',
      number: 42,
      title: 'Release verification',
      body: 'Adds verification.\r\n\r\n- [x] tests',
      state: 'OPEN',
      isDraft: true,
      url: 'https://github.com/acme/widgets/pull/42',
      author: 'octo-dev',
      createdAt: '2026-05-19T15:38:59Z',
      updatedAt: '2026-05-19T15:44:38Z',
      headRefName: 'release/verify',
      baseRefName: 'main',
      additions: 719,
      deletions: 0,
      changedFiles: 8,
      files: [
        { path: 'src/verify.ts', additions: 8, deletions: 0 },
        { path: 'src/release.ts', additions: 2, deletions: 0 },
      ],
      commits: 3,
      checks: [
        {
          name: 'build (ubuntu-latest)',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
        },
        { name: 'lint', status: 'IN_PROGRESS', conclusion: null },
        { name: 'ci/legacy', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'ci/pending', status: 'PENDING', conclusion: null },
      ],
      reviewDecision: 'CHANGES_REQUESTED',
    })
  })

  it('maps GraphQL not-found errors and null results to pull_request_not_found', async () => {
    await expect(
      browser(() => ({
        exitCode: 1,
        stdout:
          '{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND","path":["repository","pullRequest"],"message":"Could not resolve to a PullRequest with the number of 999999999."}]}',
        stderr:
          'gh: Could not resolve to a PullRequest with the number of 999999999.',
      })).service.view({ repo: 'acme/widgets', number: 999_999_999 }),
    ).rejects.toMatchObject({ code: 'pull_request_not_found' })
    await expect(
      browser(() =>
        ok(JSON.stringify({ data: { repository: { pullRequest: null } } })),
      ).service.view({ repo: 'acme/widgets', number: 5 }),
    ).rejects.toMatchObject({ code: 'pull_request_not_found' })
  })

  it('validates repository and number before running gh', async () => {
    const { service, calls } = browser(() => ok('{}'))
    for (const input of [
      { repo: 'acme', number: 1 },
      { repo: '-acme/widgets', number: 1 },
      { repo: 'acme/widgets --hostname evil', number: 1 },
      { repo: 'acme/..', number: 1 },
      { repo: 'acme/widgets', number: 0 },
      { repo: 'acme/widgets', number: 1_000_000_001 },
      { repo: 'acme/widgets', number: Number.NaN },
    ]) {
      await expect(service.view(input)).rejects.toMatchObject({
        code: 'pull_request_argument_invalid',
      })
      await expect(service.diff(input)).rejects.toMatchObject({
        code: 'pull_request_argument_invalid',
      })
    }
    expect(calls).toHaveLength(0)
  })
})

describe('PullRequestBrowserService.diff', () => {
  it('runs gh pr diff with --repo and no colour', async () => {
    const { service, calls } = browser(() =>
      ok('diff --git a/src/a.ts b/src/a.ts\n+added\n'),
    )
    await expect(
      service.diff({ repo: 'acme/widgets', number: 42 }),
    ).resolves.toEqual({
      diff: 'diff --git a/src/a.ts b/src/a.ts\n+added\n',
      truncated: false,
    })
    expect(calls[0]!.args).toEqual([
      'pr',
      'diff',
      '42',
      '--repo',
      'acme/widgets',
      '--color',
      'never',
    ])
    expect(calls[0]!.cwd).toBe('/state-root')
  })

  it('returns a bounded prefix when the runner capped the output', async () => {
    const capped = browser(() =>
      ok('diff --git a/x b/x\n+partial', { stdoutTruncated: true }),
    )
    await expect(
      capped.service.diff({ repo: 'acme/widgets', number: 1 }),
    ).resolves.toEqual({
      diff: 'diff --git a/x b/x\n+partial',
      truncated: true,
    })

    const oversized = `${'a'.repeat(PULL_REQUEST_DIFF_MAX_BYTES - 1)}é tail`
    const bounded = await browser(() => ok(oversized)).service.diff({
      repo: 'acme/widgets',
      number: 1,
    })
    expect(bounded.truncated).toBe(true)
    expect(Buffer.byteLength(bounded.diff)).toBeLessThanOrEqual(
      PULL_REQUEST_DIFF_MAX_BYTES,
    )
    expect(bounded.diff.endsWith('a')).toBe(true)
    expect(bounded.diff).not.toContain('\uFFFD')
  })

  it('maps a missing PR to pull_request_not_found', async () => {
    await expect(
      browser(() => ({
        exitCode: 1,
        stdout: '',
        stderr:
          'GraphQL: Could not resolve to a PullRequest with the number of 5. (repository.pullRequest)',
      })).service.diff({ repo: 'acme/widgets', number: 5 }),
    ).rejects.toMatchObject({ code: 'pull_request_not_found' })
  })
})

describe('createGhCommandRunner', () => {
  function runnerReturning(result: Partial<EnvironmentProcessResult>) {
    const requests: EnvironmentProcessRequest[] = []
    const run = createGhCommandRunner({
      run: async (request) => {
        requests.push(request)
        return {
          status: 'completed',
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
          error: null,
          ...result,
        }
      },
    })
    return { run, requests }
  }
  const request: GhCommandRequest = {
    executable: '/signed/gh',
    args: ['api', 'user'],
    cwd: '/state-root',
    env: { PATH: '/signed' },
  }

  it('bounds time and output and keeps argv shell-free', async () => {
    const { run, requests } = runnerReturning({ stdout: 'octo-dev\n' })
    await expect(run(request)).resolves.toEqual({
      exitCode: 0,
      stdout: 'octo-dev\n',
      stderr: '',
      stdoutTruncated: false,
    })
    expect(requests[0]).toEqual({
      executable: '/signed/gh',
      args: ['api', 'user'],
      cwd: '/state-root',
      env: { PATH: '/signed' },
      timeoutMs: 60_000,
      maxOutputBytes: PULL_REQUEST_DIFF_MAX_BYTES,
    })
  })

  it('treats a stdout cap as a truncated success and other stops as failures', async () => {
    await expect(
      runnerReturning({
        status: 'output_limit',
        exitCode: null,
        stdout: 'diff',
        stdoutTruncated: true,
      }).run(request),
    ).resolves.toMatchObject({ exitCode: 0, stdoutTruncated: true })
    await expect(
      runnerReturning({
        status: 'output_limit',
        exitCode: null,
        stderrTruncated: true,
      }).run(request),
    ).resolves.toMatchObject({ exitCode: 1 })
    await expect(
      runnerReturning({ status: 'timeout', exitCode: null }).run(request),
    ).resolves.toMatchObject({ exitCode: 1, stderr: 'GitHub CLI 请求超时。' })
    await expect(
      runnerReturning({
        status: 'spawn_error',
        exitCode: null,
        error: 'spawn /signed/gh ENOENT',
      }).run(request),
    ).resolves.toMatchObject({ exitCode: 1, stderr: 'spawn /signed/gh ENOENT' })
    await expect(
      runnerReturning({ exitCode: 4, stderr: 'gh auth login' }).run(request),
    ).resolves.toMatchObject({ exitCode: 4 })
  })
})
