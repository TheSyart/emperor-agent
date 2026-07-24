import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HardenedGitRunner } from './git-runner'

describe('HardenedGitRunner', () => {
  it('adds a non-interactive, hook-free and pager-free execution boundary', async () => {
    const calls: Array<{
      args: string[]
      env: Record<string, string>
    }> = []
    const runner = new HardenedGitRunner({
      resolveRuntime: async () => ({
        executable: '/signed/git',
        env: { PATH: '/signed', HOME: '/user', SECRET: 'drop-me' },
      }),
      run: async (request) => {
        calls.push({ args: request.args, env: request.env })
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    await runner.execute('/repo', ['status', '--porcelain=v2'])

    expect(calls[0]?.args[0]).toBe('--no-pager')
    expect(calls[0]?.args).toContain('core.hooksPath=/dev/null')
    expect(calls[0]?.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_CONFIG_NOSYSTEM: '1',
    })
    expect(calls[0]?.env.SECRET).toBeUndefined()
  })

  it('uses a private HOME and XDG root when the host supplies one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-git-home-'))
    let env: Record<string, string> = {}
    const runner = new HardenedGitRunner({
      privateHome: join(root, 'private'),
      resolveRuntime: async () => ({
        executable: '/signed/git',
        env: { PATH: '/signed', HOME: '/user', USERPROFILE: '/user' },
      }),
      run: async (request) => {
        env = request.env
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    await runner.execute('/repo', ['status'])

    const privateHome = join(root, 'private')
    expect(env).toMatchObject({
      HOME: privateHome,
      USERPROFILE: privateHome,
      XDG_CONFIG_HOME: join(privateHome, '.config'),
      XDG_CACHE_HOME: join(privateHome, '.cache'),
    })
  })

  it('rejects network subcommands unless the caller explicitly opens the network boundary', async () => {
    const runner = new HardenedGitRunner({
      resolveRuntime: async () => ({ executable: 'git', env: {} }),
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })
    await expect(runner.execute('/repo', ['push'])).rejects.toMatchObject({
      code: 'git_network_not_authorized',
    })
    await expect(
      runner.execute('/repo', ['push'], { network: true }),
    ).resolves.toMatchObject({ exitCode: 0 })
  })

  it('disables optional locks only for genuinely read-only worktree commands', async () => {
    const values: string[] = []
    const runner = new HardenedGitRunner({
      resolveRuntime: async () => ({ executable: 'git', env: {} }),
      run: async (request) => {
        values.push(request.env.GIT_OPTIONAL_LOCKS ?? '')
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    await runner.execute('/repo', ['worktree', 'list', '--porcelain'])
    await runner.execute('/repo', ['worktree', 'add', '/tmp/w', 'HEAD'])
    expect(values).toEqual(['0', '1'])
  })
})
