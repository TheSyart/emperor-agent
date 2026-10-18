// SEC-01 (PLAN-V020, findings CORE-1): a repository's own config must not
// make Emperor's git run a program. Each case plants a command that would
// write a probe file, then runs the real git through HardenedGitRunner.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HardenedGitRunner,
  neutralGitConfigValue,
  parseConfigKeys,
  type GitCommandRequest,
} from './git-runner'

function realRun(request: GitCommandRequest) {
  const result = spawnSync(request.executable, request.args, {
    cwd: request.cwd,
    env: request.env,
    input: request.stdin,
    encoding: 'utf8',
  })
  return Promise.resolve({
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  })
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-git-config-'))
  const probe = join(root, '..', `${root.split('/').pop()}-probe`)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 't@example.com')
  git(root, 'config', 'user.name', 't')
  writeFileSync(join(root, 'a.txt'), 'one\n')
  git(root, 'add', 'a.txt')
  git(root, 'commit', '-q', '-m', 'init')
  return { root, probe, plant: `touch '${probe}'; cat` }
}

function runner(calls: string[][] = []) {
  return new HardenedGitRunner({
    resolveRuntime: async () => ({
      executable: 'git',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    }),
    run: (request) => {
      calls.push(request.args)
      return realRun(request)
    },
  })
}

describe('repository config cannot run programs through Emperor git', () => {
  it('ignores a clean filter on add -A', async () => {
    const { root, probe, plant } = repo()
    git(root, 'config', 'filter.x.clean', plant)
    writeFileSync(join(root, '.gitattributes'), '* filter=x\n')
    writeFileSync(join(root, 'b.txt'), 'two\n')
    await runner().execute(root, ['add', '-A'])
    expect(existsSync(probe)).toBe(false)
    expect(git(root, 'diff', '--cached', '--name-only')).toContain('b.txt')
  })

  it('keeps a required filter from failing the command', async () => {
    const { root, probe, plant } = repo()
    git(root, 'config', 'filter.lfsish.clean', plant)
    git(root, 'config', 'filter.lfsish.required', 'true')
    writeFileSync(join(root, '.gitattributes'), '*.bin filter=lfsish\n')
    writeFileSync(join(root, 'c.bin'), 'binary\n')
    await runner().execute(root, ['add', '-A'])
    expect(existsSync(probe)).toBe(false)
  })

  it('ignores a diff textconv driver', async () => {
    const { root, probe, plant } = repo()
    git(root, 'config', 'diff.x.textconv', `sh -c "${plant}" --`)
    writeFileSync(join(root, '.gitattributes'), '*.txt diff=x\n')
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    await runner().execute(root, ['diff'])
    expect(existsSync(probe)).toBe(false)
  })

  it('ignores an attribute-selected external diff command', async () => {
    const { root, probe } = repo()
    git(root, 'config', 'diff.x.command', `touch '${probe}'`)
    writeFileSync(join(root, '.gitattributes'), '*.txt diff=x\n')
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    const result = await runner().execute(root, ['diff'])
    expect(existsSync(probe)).toBe(false)
    expect(result.stdout).toContain('+changed')
  })

  it('does not sign with a planted gpg program', async () => {
    const { root, probe } = repo()
    git(root, 'config', 'commit.gpgSign', 'true')
    git(root, 'config', 'gpg.program', `/bin/sh -c "touch '${probe}'"`)
    const tree = git(root, 'write-tree')
    await runner().execute(root, ['commit-tree', tree, '-m', 'snapshot'])
    expect(existsSync(probe)).toBe(false)
  })

  it('also neutralizes keys that arrive through include.path', async () => {
    const { root, probe, plant } = repo()
    const extra = join(root, '.git', 'extra.conf')
    writeFileSync(extra, `[filter "y"]\n\tclean = ${plant}\n`)
    git(root, 'config', 'include.path', extra)
    writeFileSync(join(root, '.gitattributes'), '* filter=y\n')
    writeFileSync(join(root, 'd.txt'), 'four\n')
    await runner().execute(root, ['add', '-A'])
    expect(existsSync(probe)).toBe(false)
  })

  it('scans nothing outside a repository', async () => {
    const calls: string[][] = []
    const outside = mkdtempSync(join(tmpdir(), 'emperor-no-repo-'))
    await runner(calls).execute(outside, ['--version'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('protocol.ext.allow=never')
  })

  it('parses null-separated config output', () => {
    expect(
      parseConfigKeys('filter.x.clean\ntouch p\0core.sshcommand\nevil\0'),
    ).toEqual(['filter.x.clean', 'core.sshcommand'])
    expect(parseConfigKeys('')).toEqual([])
  })

  it('maps each executing key to a value that disables it', () => {
    expect(neutralGitConfigValue('filter.x.required')).toBe('false')
    expect(neutralGitConfigValue('commit.gpgsign')).toBe('false')
    expect(neutralGitConfigValue('core.fsmonitor')).toBe('false')
    expect(neutralGitConfigValue('core.pager')).toBe('cat')
    expect(neutralGitConfigValue('remote.origin.uploadpack')).toBe(
      'git-upload-pack',
    )
    expect(neutralGitConfigValue('filter.x.clean')).toBe('')
    expect(neutralGitConfigValue('diff.x.textconv')).toBe('cat')
    expect(neutralGitConfigValue('credential.helper')).toBe('')
  })
})
