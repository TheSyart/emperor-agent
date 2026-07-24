import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WorkspaceGitService,
  parsePorcelainV2,
  type GitCommandRequest,
} from './git'

describe('parsePorcelainV2', () => {
  it('parses branch metadata, ordinary, renamed, untracked and conflicted paths', () => {
    const raw = [
      '# branch.oid abcdef123456',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/a.ts',
      '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict.ts',
      '? 新文件.txt',
      '',
    ].join('\0')

    const parsed = parsePorcelainV2(raw)

    expect(parsed).toMatchObject({
      branch: 'main',
      head: 'abcdef123456',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
    })
    expect(parsed.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/a.ts',
          index: 'M',
          worktree: '.',
        }),
        expect.objectContaining({
          path: 'new name.ts',
          originalPath: 'old name.ts',
        }),
        expect.objectContaining({ path: 'conflict.ts', conflict: true }),
        expect.objectContaining({ path: '新文件.txt', untracked: true }),
      ]),
    )
  })
})

describe('WorkspaceGitService', () => {
  it('returns structured changed-file and numstat totals for Environment', async () => {
    const service = new WorkspaceGitService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: '/project' }),
      resolveRuntime: async () => ({ executable: '/usr/bin/git', env: {} }),
      run: async (request) => {
        if (gitSubcommand(request.args) === 'rev-parse')
          return { exitCode: 0, stdout: '/project\n', stderr: '' }
        if (gitSubcommand(request.args) === 'status')
          return {
            exitCode: 0,
            stdout: [
              '# branch.oid abc',
              '# branch.head main',
              '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/a.ts',
              '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/b.ts',
              '? image.png',
              '',
            ].join('\0'),
            stderr: '',
          }
        if (gitSubcommand(request.args) === 'diff')
          return {
            exitCode: 0,
            stdout: [
              '5\t2\tsrc/a.ts',
              '3\t4\tsrc/b.ts',
              '-\t-\timage.png',
              '',
            ].join('\0'),
            stderr: '',
          }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    await expect(service.status({ sessionId: 's1' })).resolves.toMatchObject({
      summary: {
        changedFiles: 3,
        additions: 8,
        deletions: 6,
        untracked: 1,
      },
    })
  })

  it('resolves the canonical repository root before status and diff operations', async () => {
    const calls: GitCommandRequest[] = []
    const service = new WorkspaceGitService({
      resolveProject: () => ({
        sessionId: 's1',
        projectRoot: '/repo/apps/web',
      }),
      resolveRuntime: async () => ({ executable: '/usr/bin/git', env: {} }),
      run: async (request) => {
        calls.push(request)
        if (gitSubcommand(request.args) === 'rev-parse')
          return { exitCode: 0, stdout: '/repo\n', stderr: '' }
        return {
          exitCode: 0,
          stdout: '# branch.oid abc\0# branch.head main\0',
          stderr: '',
        }
      },
    })

    const result = await service.status({ sessionId: 's1' })

    expect(result.root).toBe('/repo/apps/web')
    expect(
      calls.find((call) => gitSubcommand(call.args) === 'status')?.cwd,
    ).toBe('/repo')
    expect(
      calls.find((call) => gitSubcommand(call.args) === 'status')?.args,
    ).toContain('apps/web')
  })

  it('uses shell-free argv and rejects stale revisions before mutations', async () => {
    const calls: GitCommandRequest[] = []
    let status = '# branch.oid abc\0# branch.head main\0? a.txt\0'
    const service = new WorkspaceGitService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: '/project' }),
      resolveRuntime: async () => ({ executable: '/usr/bin/git', env: {} }),
      run: async (request) => {
        calls.push(request)
        if (gitSubcommand(request.args) === 'rev-parse')
          return { exitCode: 0, stdout: '/project\n', stderr: '' }
        if (gitSubcommand(request.args) === 'status')
          return { exitCode: 0, stdout: status, stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    const before = await service.status({ sessionId: 's1' })
    status = '# branch.oid def\0# branch.head main\0? b.txt\0'

    await expect(
      service.stage({
        sessionId: 's1',
        paths: ['a.txt'],
        expectedRevision: before.revision,
      }),
    ).rejects.toMatchObject({ code: 'git_status_stale' })
    expect(
      calls.filter((call) => gitSubcommand(call.args) === 'add'),
    ).toHaveLength(0)
  })

  it('changes revision when file content changes but porcelain status stays identical', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-git-revision-'))
    git(root, ['init'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'same.txt'), 'aaaa\n')
    git(root, ['add', 'same.txt'])
    git(root, ['commit', '-m', 'base'])
    writeFileSync(join(root, 'same.txt'), 'bbbb\n')
    const service = realGitService(root)
    const first = await service.status({ sessionId: 's1' })
    writeFileSync(join(root, 'same.txt'), 'cccc\n')
    const second = await service.status({ sessionId: 's1' })
    expect(first.files.map((file) => [file.path, file.worktree])).toEqual(
      second.files.map((file) => [file.path, file.worktree]),
    )
    expect(second.revision).not.toBe(first.revision)
  })

  it('separates paths with -- and sanitizes credential-bearing errors', async () => {
    const calls: GitCommandRequest[] = []
    const service = new WorkspaceGitService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: '/project' }),
      resolveRuntime: async () => ({ executable: '/usr/bin/git', env: {} }),
      run: async (request) => {
        calls.push(request)
        if (gitSubcommand(request.args) === 'rev-parse')
          return { exitCode: 0, stdout: '/project\n', stderr: '' }
        if (gitSubcommand(request.args) === 'status')
          return {
            exitCode: 0,
            stdout: '# branch.oid abc\0# branch.head main\0? --danger\0',
            stderr: '',
          }
        if (gitSubcommand(request.args) === 'add')
          return { exitCode: 0, stdout: '', stderr: '' }
        if (gitSubcommand(request.args) === 'diff')
          return { exitCode: 0, stdout: '', stderr: '' }
        return {
          exitCode: 1,
          stdout: '',
          stderr:
            'fatal: https://user:secret@example.com/repo.git failed Authorization: Bearer exposed-token password=also-secret',
        }
      },
    })
    const status = await service.status({ sessionId: 's1' })
    await service.stage({
      sessionId: 's1',
      paths: ['--danger'],
      expectedRevision: status.revision,
    })
    expect(
      calls.find((call) => gitSubcommand(call.args) === 'add')?.args.slice(-3),
    ).toEqual(['add', '--', '--danger'])

    await expect(
      service.fetch({ sessionId: 's1', confirmed: true }),
    ).rejects.toMatchObject({
      message: expect.not.stringMatching(/secret|exposed-token/),
    })
  })

  it('checks ignored files over stdin without a shell', async () => {
    const calls: GitCommandRequest[] = []
    const service = new WorkspaceGitService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: '/project' }),
      resolveRuntime: async () => ({ executable: '/usr/bin/git', env: {} }),
      run: async (request) => {
        calls.push(request)
        return {
          exitCode: 0,
          stdout:
            gitSubcommand(request.args) === 'rev-parse'
              ? '/project\n'
              : gitSubcommand(request.args) === 'check-ignore'
                ? 'dist/app.js\0'
                : '',
          stderr: '',
        }
      },
    })

    await expect(
      service.ignoredPaths({
        sessionId: 's1',
        paths: ['src/app.ts', 'dist/app.js'],
      }),
    ).resolves.toEqual(new Set(['dist/app.js']))
    const ignoredCall = calls.find(
      (call) => gitSubcommand(call.args) === 'check-ignore',
    )
    expect(ignoredCall?.args.slice(-3)).toEqual([
      'check-ignore',
      '-z',
      '--stdin',
    ])
    expect(ignoredCall?.stdin).toBe('src/app.ts\0dist/app.js\0')
  })

  it('keeps truncated status readable, fails closed on writes and marks bounded diffs', async () => {
    const service = new WorkspaceGitService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: '/project' }),
      resolveRuntime: async () => ({ executable: '/usr/bin/git', env: {} }),
      run: async (request) => {
        if (gitSubcommand(request.args) === 'rev-parse')
          return { exitCode: 0, stdout: '/project\n', stderr: '' }
        if (gitSubcommand(request.args) === 'status') {
          return {
            exitCode: 0,
            stdout: '# branch.oid abc\0# branch.head main\0',
            stderr: '',
            stdoutTruncated: true,
          }
        }
        return {
          exitCode: 0,
          stdout: 'x'.repeat(2 * 1024 * 1024 + 10),
          stderr: '',
          stdoutTruncated: true,
        }
      },
    })

    const status = await service.status({ sessionId: 's1' })
    expect(status.truncated).toBe(true)
    await expect(
      service.stage({
        sessionId: 's1',
        paths: ['a.txt'],
        expectedRevision: status.revision,
      }),
    ).rejects.toMatchObject({ code: 'git_status_truncated' })
    await expect(
      service.diff({ sessionId: 's1', area: 'worktree' }),
    ).resolves.toMatchObject({ truncated: true })
  })

  it('rejects portable and Windows-style path traversal before Git runs', async () => {
    const calls: GitCommandRequest[] = []
    const service = new WorkspaceGitService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: '/project' }),
      resolveRuntime: async () => ({ executable: '/usr/bin/git', env: {} }),
      run: async (request) => {
        calls.push(request)
        if (gitSubcommand(request.args) === 'rev-parse')
          return { exitCode: 0, stdout: '/project\n', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    await expect(
      service.diff({
        sessionId: 's1',
        path: '../secret',
        area: 'worktree',
      }),
    ).rejects.toMatchObject({ code: 'git_argument_invalid' })
    await expect(
      service.diff({
        sessionId: 's1',
        path: '..\\secret',
        area: 'worktree',
      }),
    ).rejects.toMatchObject({ code: 'git_argument_invalid' })
    expect(
      calls.filter((call) => gitSubcommand(call.args) === 'diff'),
    ).toHaveLength(0)
  })

  it('blocks index mutations while the session has an active writer', async () => {
    const calls: GitCommandRequest[] = []
    const service = new WorkspaceGitService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: '/project' }),
      resolveRuntime: async () => ({ executable: '/usr/bin/git', env: {} }),
      hasActiveWriter: () => true,
      run: async (request) => {
        calls.push(request)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    await expect(
      service.stage({
        sessionId: 's1',
        paths: ['file.txt'],
        expectedRevision: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'git_active_writer' })
    await expect(
      service.push({
        sessionId: 's1',
        expectedRevision: 'a'.repeat(64),
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'git_active_writer' })
    expect(calls).toHaveLength(0)
  })

  it('discards an exact untracked path without invoking a shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-git-discard-'))
    const target = join(root, 'new file.txt')
    writeFileSync(target, 'temporary\n')
    const status = '# branch.oid abc\0# branch.head main\0? new file.txt\0'
    const calls: GitCommandRequest[] = []
    const service = new WorkspaceGitService({
      resolveProject: () => ({ sessionId: 's1', projectRoot: root }),
      resolveRuntime: async () => ({ executable: '/usr/bin/git', env: {} }),
      run: async (request) => {
        calls.push(request)
        if (gitSubcommand(request.args) === 'rev-parse')
          return { exitCode: 0, stdout: `${root}\n`, stderr: '' }
        return { exitCode: 0, stdout: status, stderr: '' }
      },
    })
    const before = await service.status({ sessionId: 's1' })

    await service.discard({
      sessionId: 's1',
      paths: ['new file.txt'],
      expectedRevision: before.revision,
      confirmed: true,
    })

    expect(existsSync(target)).toBe(false)
    expect(calls.some((call) => gitSubcommand(call.args) === 'restore')).toBe(
      false,
    )
  })

  it('keeps a monorepo Build session inside its project subdirectory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-git-monorepo-'))
    const project = join(root, 'apps', 'web')
    const sibling = join(root, 'apps', 'api')
    mkdirSync(project, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(project, 'web.txt'), 'base\n')
    writeFileSync(join(sibling, 'api.txt'), 'base\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'base'])
    writeFileSync(join(project, 'web.txt'), 'changed\n')
    writeFileSync(join(sibling, 'api.txt'), 'changed\n')
    writeFileSync(join(sibling, 'outside.txt'), 'outside\n')
    const service = realGitService(project)

    const status = await service.status({ sessionId: 's1' })

    expect(status.root).toBe(realpathSync(project))
    expect(status.files.map((file) => file.path)).toEqual(['web.txt'])
    await service.stage({
      sessionId: 's1',
      paths: ['web.txt'],
      expectedRevision: status.revision,
    })
    git(root, ['add', 'apps/api/api.txt'])
    const refreshed = await service.status({ sessionId: 's1' })
    await expect(
      service.commit({
        sessionId: 's1',
        message: 'scoped commit',
        expectedRevision: refreshed.revision,
      }),
    ).rejects.toMatchObject({ code: 'git_staged_outside_project' })
    expect(existsSync(join(sibling, 'outside.txt'))).toBe(true)
  })

  it('allows a scoped commit when sibling changes are only untracked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-git-untracked-sibling-'))
    const project = join(root, 'apps', 'web')
    const sibling = join(root, 'apps', 'api')
    mkdirSync(project, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(project, 'web.txt'), 'base\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'base'])
    writeFileSync(join(project, 'web.txt'), 'changed\n')
    writeFileSync(join(sibling, 'new.txt'), 'untracked\n')
    const service = realGitService(project)
    const status = await service.status({ sessionId: 's1' })
    const staged = await service.stage({
      sessionId: 's1',
      paths: ['web.txt'],
      expectedRevision: status.revision,
    })

    await expect(
      service.commit({
        sessionId: 's1',
        message: 'scoped commit',
        expectedRevision: staged.revision,
      }),
    ).resolves.toMatchObject({ files: [] })
    expect(existsSync(join(sibling, 'new.txt'))).toBe(true)
  })

  it('rejects repository-wide pull and branch switching from a subproject', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-git-wide-operation-'))
    const project = join(root, 'apps', 'web')
    mkdirSync(project, { recursive: true })
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(project, 'web.txt'), 'base\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'base'])
    git(root, ['branch', 'other'])
    const service = realGitService(project)
    const status = await service.status({ sessionId: 's1' })

    await expect(
      service.pull({
        sessionId: 's1',
        expectedRevision: status.revision,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'git_repository_wide_operation' })
    await expect(
      service.switchBranch({
        sessionId: 's1',
        name: 'other',
        expectedRevision: status.revision,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'git_repository_wide_operation' })
    expect(gitOutput(root, ['branch', '--show-current'])).toBe('master')
  })

  it('unstages unborn and renamed paths', async () => {
    const unbornRoot = mkdtempSync(join(tmpdir(), 'emperor-git-unborn-'))
    git(unbornRoot, ['init', '-q'])
    writeFileSync(join(unbornRoot, 'first.txt'), 'first\n')
    const unborn = realGitService(unbornRoot)
    const before = await unborn.status({ sessionId: 's1' })
    const staged = await unborn.stage({
      sessionId: 's1',
      paths: ['first.txt'],
      expectedRevision: before.revision,
    })
    const unstaged = await unborn.unstage({
      sessionId: 's1',
      paths: ['first.txt'],
      expectedRevision: staged.revision,
    })
    expect(unstaged.files).toContainEqual(
      expect.objectContaining({ path: 'first.txt', untracked: true }),
    )

    const root = mkdtempSync(join(tmpdir(), 'emperor-git-rename-'))
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'old.txt'), 'base\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'base'])
    renameSync(join(root, 'old.txt'), join(root, 'new.txt'))
    git(root, ['add', '-A'])
    const service = realGitService(root)
    const renamed = await service.status({ sessionId: 's1' })
    expect(renamed.files).toContainEqual(
      expect.objectContaining({ path: 'new.txt', originalPath: 'old.txt' }),
    )
    const afterRenameUnstage = await service.unstage({
      sessionId: 's1',
      paths: ['new.txt'],
      expectedRevision: renamed.revision,
    })
    expect(
      afterRenameUnstage.files.some(
        (file) => !file.untracked && file.index !== '.' && file.index !== ' ',
      ),
    ).toBe(false)
  })

  it('marks a conflict resolved by staging its project-relative path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-git-conflict-'))
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'conflict.txt'), 'base\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'base'])
    git(root, ['switch', '-qc', 'other'])
    writeFileSync(join(root, 'conflict.txt'), 'other\n')
    git(root, ['commit', '-qam', 'other'])
    git(root, ['switch', '-q', 'master'])
    writeFileSync(join(root, 'conflict.txt'), 'main\n')
    git(root, ['commit', '-qam', 'main'])
    const merge = spawnSync('git', ['merge', 'other'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(merge.status).not.toBe(0)

    const service = realGitService(root)
    const conflicted = await service.status({ sessionId: 's1' })
    expect(conflicted.files).toContainEqual(
      expect.objectContaining({ path: 'conflict.txt', conflict: true }),
    )
    writeFileSync(join(root, 'conflict.txt'), 'resolved\n')
    const resolution = await service.status({ sessionId: 's1' })
    const resolved = await service.stage({
      sessionId: 's1',
      paths: ['conflict.txt'],
      expectedRevision: resolution.revision,
    })
    expect(resolved.files.some((file) => file.conflict)).toBe(false)
  })
})

function realGitService(projectRoot: string): WorkspaceGitService {
  return new WorkspaceGitService({
    resolveProject: (sessionId) => ({ sessionId, projectRoot }),
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
        stderr: result.stderr || result.error?.message || '',
      }
    },
  })
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args.join(' ')} failed`)
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function gitSubcommand(args: string[]): string {
  const configured = args.lastIndexOf('diff.trustExitCode=false')
  return args[configured + 1] || ''
}
