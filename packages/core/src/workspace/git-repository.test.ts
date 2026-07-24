import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitRepositoryResolver } from './git-repository'

describe('GitRepositoryResolver', () => {
  it('resolves linked worktree identity and transient state without assuming .git is a directory', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'emperor-repository-'))
    const worktree = `${repository}-worktree`
    git(repository, ['init', '-q'])
    git(repository, ['config', 'user.email', 'test@example.com'])
    git(repository, ['config', 'user.name', 'Test'])
    writeFileSync(join(repository, 'README.md'), 'base\n')
    git(repository, ['add', '.'])
    git(repository, ['commit', '-qm', 'base'])
    git(repository, ['worktree', 'add', '-q', '-b', 'feature', worktree])

    const resolver = new GitRepositoryResolver({
      execute: async (cwd, args) => command(cwd, args),
    })
    const identity = await resolver.resolve(worktree)

    expect(identity.worktreeRoot).toBe(realpathSync(worktree))
    expect(identity.commonDir).toBe(realpathSync(resolve(repository, '.git')))
    expect(identity.branch).toBe('feature')
    expect(identity.detached).toBe(false)
    expect(identity.objectFormat).toBe('sha1')
  })

  it('rejects a project whose .git pointer escapes to an unrelated directory', async () => {
    const project = mkdtempSync(join(tmpdir(), 'emperor-malicious-git-'))
    const unrelated = mkdtempSync(join(tmpdir(), 'emperor-unrelated-git-'))
    mkdirSync(join(unrelated, 'objects'))
    writeFileSync(join(project, '.git'), `gitdir: ${unrelated}\n`)
    const resolver = new GitRepositoryResolver({
      execute: async () => ({
        exitCode: 0,
        stdout: `${project}\n${unrelated}\n${unrelated}\nfalse\nsha1\n`,
        stderr: '',
      }),
    })

    await expect(resolver.resolve(project)).rejects.toMatchObject({
      code: 'git_repository_invalid',
    })
  })
})

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

function command(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return Promise.resolve({
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  })
}
