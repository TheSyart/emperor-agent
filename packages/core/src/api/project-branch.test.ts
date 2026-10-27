// MOD-03 (PLAN-V030): the Build home shows the branch of the project a
// draft is about to run in — before any session exists there, so it is read
// by project, and only for a project Emperor already knows.
import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeApi, tmp, type ApiFixture } from './test-helpers'

const fixtures: ApiFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0))
    await fixture.api.close().catch(() => {})
})

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  })
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args.join(' ')} failed`)
}

async function api() {
  const fixture = await makeApi()
  fixtures.push(fixture)
  return fixture.api
}

describe('projects.branch (MOD-03 3)', () => {
  it('reads the branch of a known project, and follows a switch', async () => {
    const core = await api()
    const repo = realpathSync(tmp('emperor-mod03-repo-'))
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'README.md'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
    const project = core.projects.resolve(repo)

    expect(
      await core.projects.branch({ projectId: project.project_id }),
    ).toEqual({ branch: 'main', detached: false })

    git(repo, 'switch', '-q', '-c', 'release/0.3')
    expect(
      await core.projects.branch({ projectId: project.project_id }),
    ).toEqual({ branch: 'release/0.3', detached: false })
  })

  it('has no branch for a folder outside Git or a project it does not know', async () => {
    const core = await api()
    const plain = realpathSync(tmp('emperor-mod03-plain-'))
    mkdirSync(join(plain, 'src'))
    const project = core.projects.resolve(plain)
    expect(await core.projects.branch({ projectId: project.project_id })).toBe(
      null,
    )
    expect(await core.projects.branch({ projectId: 'nope' })).toBe(null)
  })
})
