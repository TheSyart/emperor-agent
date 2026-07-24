import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitRepositoryResolver } from './git-repository'
import { HardenedGitRunner } from './git-runner'
import { GitWorktreeManager, WorkspaceBindingStore } from './git-worktrees'

describe('GitWorktreeManager', () => {
  it('binds a session to an owned worktree and safely keeps it on exit', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'emperor-worktree-repo-'))
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-worktree-state-'))
    git(repository, ['init', '-q'])
    git(repository, ['config', 'user.email', 'test@example.com'])
    git(repository, ['config', 'user.name', 'Test'])
    writeFileSync(join(repository, 'README.md'), 'base\n')
    git(repository, ['add', '.'])
    git(repository, ['commit', '-qm', 'base'])
    const runner = realRunner()
    const resolver = new GitRepositoryResolver({
      execute: (cwd, args, options) => runner.execute(cwd, args, options),
    })
    const bindings = new WorkspaceBindingStore(stateRoot)
    const manager = new GitWorktreeManager({
      stateRoot,
      bindings,
      resolver,
      execute: (cwd, args, options) => runner.execute(cwd, args, options),
    })

    const entered = await manager.enter({
      sessionId: 'session-1',
      projectRoot: repository,
      name: 'feature',
      expectedRevision: 'revision',
      confirmed: true,
    })
    expect(bindings.resolve('session-1', repository)).toBe(entered.path)
    expect((await manager.list('session-1', repository)).owned).toHaveLength(1)

    await manager.exit({
      sessionId: 'session-1',
      projectRoot: repository,
      action: 'keep',
      discardChanges: false,
      expectedRevision: 'revision',
      confirmed: true,
    })
    expect(bindings.resolve('session-1', repository)).toBe(repository)
  })

  it('never removes an unowned path even when confirmed', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-worktree-state-'))
    const bindings = new WorkspaceBindingStore(stateRoot)
    const manager = new GitWorktreeManager({
      stateRoot,
      bindings,
      resolver: {
        resolve: async () => {
          throw new Error('should not resolve')
        },
      } as never,
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })

    await expect(
      manager.exit({
        sessionId: 'session-1',
        projectRoot: '/repo',
        action: 'remove',
        discardChanges: true,
        expectedRevision: 'revision',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'git_worktree_not_owned' })
  })

  it('fails closed instead of overwriting a corrupt subagent lease store', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-worktree-state-'))
    const subagentRoot = join(stateRoot, 'subagent-worktrees')
    mkdirSync(subagentRoot, { recursive: true })
    writeFileSync(join(subagentRoot, '.leases.json'), '{broken\n')
    const manager = new GitWorktreeManager({
      stateRoot,
      subagentWorktreeRoot: subagentRoot,
      bindings: new WorkspaceBindingStore(stateRoot),
      resolver: {
        resolve: async () => {
          throw new Error('resolver must not run')
        },
      } as never,
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })

    await expect(
      manager.acquireSubagent({
        taskId: 'subagent_1',
        sessionId: 'session-1',
        sourceRoot: '/repo',
      }),
    ).rejects.toMatchObject({ code: 'git_worktree_lease_corrupt' })
    expect(readFileSync(join(subagentRoot, '.leases.json'), 'utf8')).toBe(
      '{broken\n',
    )
  })

  it('rejects a forged session lease that points outside the managed root', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-worktree-state-'))
    const gitState = join(stateRoot, 'git')
    mkdirSync(gitState, { recursive: true })
    writeFileSync(
      join(gitState, 'worktree-leases.json'),
      JSON.stringify({
        version: 1,
        leases: [
          {
            version: 1,
            sessionId: 'session-1',
            id: 'worktree_forged',
            path: '/tmp/not-owned-by-emperor',
            branch: 'main',
            originalProjectRoot: '/repo',
            repositoryRoot: '/repo',
            commonDir: '/repo/.git',
            startHead: null,
            active: true,
            createdAt: Date.now(),
          },
        ],
      }),
    )

    expect(() =>
      new WorkspaceBindingStore(stateRoot).resolve('session-1', '/repo'),
    ).toThrow(expect.objectContaining({ code: 'git_worktree_lease_corrupt' }))
  })
})

function realRunner(): HardenedGitRunner {
  return new HardenedGitRunner({
    resolveRuntime: async () => ({
      executable: 'git',
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    }),
    run: async (request) => {
      const result = spawnSync(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        input: request.stdin,
        encoding: 'utf8',
      })
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
      }
    },
  })
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}
