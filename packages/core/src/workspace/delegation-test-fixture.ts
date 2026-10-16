import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HardenedGitRunner } from './git-runner'
const identity = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}
export function fixtureGit(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...identity },
  })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}
export function delegationRepository() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'emperor-delegation-ws-')),
  )
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'a.txt'), 'base')
  writeFileSync(join(repo, '.gitignore'), '.env*\nignored/\n')
  fixtureGit(repo, 'init', '-q', '-b', 'main')
  fixtureGit(repo, 'add', '-A')
  fixtureGit(repo, 'commit', '-qm', 'base')
  return {
    root,
    repo,
    runner: new HardenedGitRunner({
      resolveRuntime: async () => ({
        executable: 'git',
        env: { PATH: process.env.PATH ?? '' },
      }),
      run: async (r) => {
        const p = spawnSync(r.executable, r.args, {
          cwd: r.cwd,
          env: r.env,
          input: r.stdin,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        })
        return {
          exitCode: p.status ?? 1,
          stdout: p.stdout ?? '',
          stderr: p.stderr ?? '',
        }
      },
    }),
  }
}
