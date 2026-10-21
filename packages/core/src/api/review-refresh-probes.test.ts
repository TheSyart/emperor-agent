// FIX-08: a 审查 refresh (git.status, git.branches and git.worktrees at once)
// resolved the Git runtime for every Git command, and each resolution made
// the environment probe run every catalog tool's `--version` again — about
// 400 processes per refresh, so under load the pane stayed on 「正在读取 Git
// 状态…」. Once the tools are known, a refresh starts no probe at all.
import { spawnSync } from 'node:child_process'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { EnvironmentProbe } from '../environment/probe'
import { makeApi, tmp, type ApiFixture } from './test-helpers'

const fixtures: ApiFixture[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0))
    await fixture.api.close().catch(() => {})
})

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
  if (result.status !== 0) throw new Error(String(result.stderr))
}

it('a 审查 refresh probes the tools once, and the next one not at all', async () => {
  const probeTool = vi.spyOn(
    EnvironmentProbe.prototype as unknown as {
      probeTool: (...args: unknown[]) => Promise<unknown>
    },
    'probeTool',
  )
  const fixture = await makeApi({ replies: [] })
  fixtures.push(fixture)
  const repo = realpathSync(tmp('emperor-fix08-review-'))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  writeFileSync(join(repo, 'README.md'), 'changed\n')
  const sessionId = String(
    fixture.api.sessions.create({
      title: 'FIX-08',
      mode: 'build',
      project_path: repo,
    }).id,
  )
  const refresh = () =>
    Promise.all([
      fixture.api.git.status({ sessionId }),
      fixture.api.git.branches({ sessionId }),
      fixture.api.git.worktrees({ sessionId }),
    ])

  probeTool.mockClear()
  const [status] = await refresh()
  expect(status.files.map((file) => file.path)).toEqual(['README.md'])
  // The execution environment and the Git runtime check: two questions.
  const firstRefresh = probeTool.mock.calls.length
  const catalogSize = new Set(
    probeTool.mock.calls.map(
      (call) => (call[0] as { tool: { id: string } }).tool.id,
    ),
  ).size
  expect(firstRefresh).toBeLessThanOrEqual(2 * catalogSize)

  probeTool.mockClear()
  await refresh()
  await refresh()
  expect(probeTool).not.toHaveBeenCalled()
}, 60_000)
