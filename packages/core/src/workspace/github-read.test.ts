import { describe, expect, it } from 'vitest'
import type { GhCommandRequest, GhCommandResult } from './git-pull-requests'
import {
  GITHUB_ISSUE_SEARCH_QUERY,
  GITHUB_ISSUE_VIEW_QUERY,
  PullRequestBrowserService,
  type GhRuntime,
} from './pull-request-browser'

const RUNTIME: GhRuntime = {
  executable: '/signed/gh',
  version: '2.73.0',
  env: { PATH: '/signed', HOME: '/Users/tester', GH_TOKEN: 'must-not-forward' },
}

function ok(
  stdout: string,
  extra: Partial<GhCommandResult> = {},
): GhCommandResult {
  return { exitCode: 0, stdout, stderr: '', ...extra }
}

function fail(stderr: string, exitCode = 1): GhCommandResult {
  return { exitCode, stdout: '', stderr }
}

function browser(respond: (request: GhCommandRequest) => GhCommandResult) {
  const calls: GhCommandRequest[] = []
  const service = new PullRequestBrowserService({
    cwd: '/state-root',
    resolveRuntime: async () => RUNTIME,
    run: async (request) => {
      calls.push(request)
      return respond(request)
    },
  })
  return { service, calls }
}

// Shapes captured from gh 2.73.0 (2026-09-30) with names replaced.
const ISSUE_SEARCH = {
  data: {
    search: {
      issueCount: 2,
      nodes: [
        {
          number: 12,
          title: '<img src=x onerror=alert(1)> crash on start',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/issues/12',
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-29T08:00:00Z',
          author: { login: 'octo-dev' },
          repository: { nameWithOwner: 'acme/widgets' },
          labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
          comments: { totalCount: 3 },
        },
        {
          number: 5,
          title: 'no url',
          repository: { nameWithOwner: 'acme/widgets' },
        },
      ],
    },
  },
}

const ISSUE_VIEW = {
  data: {
    repository: {
      issue: {
        number: 12,
        title: 'Crash on start',
        body: 'Steps:\n1. open',
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        url: 'https://github.com/acme/widgets/issues/12',
        createdAt: '2026-09-20T08:00:00Z',
        updatedAt: '2026-09-29T08:00:00Z',
        closedAt: '2026-09-29T08:00:00Z',
        author: null,
        repository: { nameWithOwner: 'acme/widgets' },
        labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
        assignees: { nodes: [{ login: 'octo-dev' }] },
        comments: {
          totalCount: 41,
          nodes: [
            {
              author: { login: 'helper' },
              body: 'Fixed in #13',
              createdAt: '2026-09-29T07:00:00Z',
              url: 'https://github.com/acme/widgets/issues/12#issuecomment-1',
            },
          ],
        },
      },
    },
  },
}

const RUNS = {
  total_count: 82,
  workflow_runs: [
    {
      id: 36566264518,
      name: 'ci',
      display_title: 'test: give the process tree time',
      status: 'completed',
      conclusion: 'failure',
      event: 'push',
      head_branch: 'main',
      head_sha: 'a'.repeat(40),
      run_number: 77,
      created_at: '2026-09-29T12:09:27Z',
      updated_at: '2026-09-29T12:20:00Z',
      html_url: 'https://github.com/acme/widgets/actions/runs/36566264518',
      actor: { login: 'octo-dev' },
    },
    { id: 'not-a-number', name: 'broken' },
  ],
}

const RUN = RUNS.workflow_runs[0]
const JOBS = {
  total_count: 1,
  jobs: [
    {
      id: 101,
      name: 'test (macos-latest)',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-09-29T12:10:00Z',
      completed_at: '2026-09-29T12:19:00Z',
      html_url:
        'https://github.com/acme/widgets/actions/runs/36566264518/job/101',
      steps: [
        {
          number: 1,
          name: 'Set up job',
          status: 'completed',
          conclusion: 'success',
        },
        {
          number: 2,
          name: 'make check',
          status: 'completed',
          conclusion: 'failure',
        },
      ],
    },
  ],
}

describe('GitHub issues through gh', () => {
  it('searches open issues with a static query and the text as one variable', async () => {
    const { service, calls } = browser(() => ok(JSON.stringify(ISSUE_SEARCH)))
    const result = await service.listIssues({
      filter: 'assigned',
      query: 'crash  start',
      limit: 20,
    })
    expect(calls[0]!.args).toEqual([
      'api',
      'graphql',
      '-f',
      `query=${GITHUB_ISSUE_SEARCH_QUERY}`,
      '-f',
      'q=is:issue is:open assignee:@me crash start',
      '-F',
      'n=20',
    ])
    expect(calls[0]!.env).not.toHaveProperty('GH_TOKEN')
    expect(result).toEqual({
      total: 2,
      items: [
        {
          repo: 'acme/widgets',
          number: 12,
          // Titles stay data: the renderer shows them as text.
          title: '<img src=x onerror=alert(1)> crash on start',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/issues/12',
          author: 'octo-dev',
          createdAt: '2026-09-20T08:00:00Z',
          updatedAt: '2026-09-29T08:00:00Z',
          labels: [{ name: 'bug', color: 'd73a4a' }],
          commentCount: 3,
        },
      ],
    })
  })

  it("lists issues in the account's own repositories", async () => {
    // involves:@me leaves out issues others opened in the account's repos.
    const { service, calls } = browser(() => ok(JSON.stringify(ISSUE_SEARCH)))
    await service.listIssues({ filter: 'owned' })
    expect(calls[0]!.args).toContain('q=is:issue is:open user:@me')
  })

  it('views one issue with its latest comments', async () => {
    const { service, calls } = browser(() => ok(JSON.stringify(ISSUE_VIEW)))
    const issue = await service.viewIssue({ repo: 'acme/widgets', number: 12 })
    expect(calls[0]!.args).toEqual([
      'api',
      'graphql',
      '-f',
      `query=${GITHUB_ISSUE_VIEW_QUERY}`,
      '-f',
      'owner=acme',
      '-f',
      'name=widgets',
      '-F',
      'number=12',
    ])
    expect(issue).toMatchObject({
      repo: 'acme/widgets',
      number: 12,
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      author: 'ghost',
      body: 'Steps:\n1. open',
      assignees: ['octo-dev'],
      commentCount: 41,
      comments: [
        {
          author: 'helper',
          body: 'Fixed in #13',
          createdAt: '2026-09-29T07:00:00Z',
        },
      ],
    })
  })

  it('rejects bad arguments before running gh', async () => {
    const { service, calls } = browser(() => ok('{}'))
    await expect(
      service.listIssues({ filter: 'everything' as never }),
    ).rejects.toMatchObject({
      code: 'pull_request_argument_invalid',
    })
    await expect(
      service.viewIssue({ repo: '-x/y', number: 1 }),
    ).rejects.toMatchObject({
      code: 'pull_request_argument_invalid',
    })
    expect(calls).toEqual([])
  })
})

describe('GitHub Actions runs through gh', () => {
  it('lists runs with an explicit GET and typed fields, dropping malformed rows', async () => {
    const { service, calls } = browser(() => ok(JSON.stringify(RUNS)))
    const result = await service.listRuns({
      repo: 'acme/widgets',
      branch: 'main',
      limit: 10,
    })
    expect(calls[0]!.args).toEqual([
      'api',
      '--method',
      'GET',
      'repos/acme/widgets/actions/runs',
      '-F',
      'per_page=10',
      '-f',
      'branch=main',
    ])
    expect(result).toEqual({
      total: 82,
      items: [
        {
          id: 36566264518,
          name: 'ci',
          title: 'test: give the process tree time',
          status: 'completed',
          conclusion: 'failure',
          event: 'push',
          branch: 'main',
          runNumber: 77,
          createdAt: '2026-09-29T12:09:27Z',
          updatedAt: '2026-09-29T12:20:00Z',
          url: 'https://github.com/acme/widgets/actions/runs/36566264518',
          actor: 'octo-dev',
        },
      ],
    })
  })

  it('views a run with its jobs and steps, read-only', async () => {
    const { service, calls } = browser((request) =>
      ok(
        JSON.stringify(
          request.args.includes(
            'repos/acme/widgets/actions/runs/36566264518/jobs',
          )
            ? JOBS
            : RUN,
        ),
      ),
    )
    const run = await service.viewRun({
      repo: 'acme/widgets',
      runId: 36566264518,
    })
    expect(calls.map((call) => call.args.slice(0, 4))).toEqual([
      ['api', '--method', 'GET', 'repos/acme/widgets/actions/runs/36566264518'],
      [
        'api',
        '--method',
        'GET',
        'repos/acme/widgets/actions/runs/36566264518/jobs',
      ],
    ])
    for (const call of calls) expect(call.args).toContain('GET')
    expect(run).toMatchObject({
      run: { id: 36566264518, conclusion: 'failure' },
      jobs: [
        {
          id: 101,
          name: 'test (macos-latest)',
          conclusion: 'failure',
          steps: [
            {
              number: 1,
              name: 'Set up job',
              status: 'completed',
              conclusion: 'success',
            },
            {
              number: 2,
              name: 'make check',
              status: 'completed',
              conclusion: 'failure',
            },
          ],
        },
      ],
    })
  })

  it('reports an empty repository as no runs and rejects unsafe branches', async () => {
    const { service } = browser(() =>
      ok(JSON.stringify({ total_count: 0, workflow_runs: [] })),
    )
    await expect(service.listRuns({ repo: 'acme/empty' })).resolves.toEqual({
      total: 0,
      items: [],
    })
    await expect(
      service.listRuns({ repo: 'acme/widgets', branch: '--help' }),
    ).rejects.toMatchObject({
      code: 'pull_request_argument_invalid',
    })
    await expect(
      service.viewRun({ repo: 'acme/widgets', runId: -1 }),
    ).rejects.toMatchObject({
      code: 'pull_request_argument_invalid',
    })
  })
})

describe('gh failures', () => {
  it.each<[string, GhCommandResult, string]>([
    [
      'not logged in',
      fail('To get started with GitHub CLI, please run:  gh auth login', 4),
      'pull_request_gh_unauthenticated',
    ],
    [
      'rate limited',
      fail('gh: API rate limit exceeded for user ID 1. (HTTP 403)'),
      'pull_request_rate_limited',
    ],
    [
      'secondary limit',
      fail('gh: You have exceeded a secondary rate limit (HTTP 429)'),
      'pull_request_rate_limited',
    ],
    [
      'no permission',
      fail('gh: Resource not accessible by personal access token (HTTP 403)'),
      'pull_request_forbidden',
    ],
    ['not found', fail('gh: Not Found (HTTP 404)'), 'pull_request_not_found'],
    ['timeout', fail('GitHub CLI 请求超时。'), 'pull_request_gh_failed'],
  ])('classifies %s', async (_name, result, code) => {
    const { service } = browser(() => result)
    await expect(
      service.listRuns({ repo: 'acme/widgets' }),
    ).rejects.toMatchObject({ code })
  })

  it('refuses output over the read cap', async () => {
    const { service } = browser(() => ok('{"data":', { stdoutTruncated: true }))
    await expect(service.listIssues({})).rejects.toMatchObject({
      code: 'pull_request_output_too_large',
    })
  })

  it('names the missing thing', async () => {
    const { service } = browser(() =>
      ok(JSON.stringify({ data: { repository: { issue: null } } })),
    )
    await expect(
      service.viewIssue({ repo: 'acme/widgets', number: 99 }),
    ).rejects.toMatchObject({
      code: 'pull_request_not_found',
      message: expect.stringContaining('Issue'),
    })
  })
})
