import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HardenedGitRunner } from './git-runner'
import {
  TurnSnapshots,
  TurnSnapshotTimeout,
  type TurnSnapshot,
} from './turn-snapshots'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  })
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function snapshots(root: string): TurnSnapshots {
  const runner = new HardenedGitRunner({
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
        maxBuffer: 16 * 1024 * 1024,
      })
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout || '',
        stderr: result.stderr || result.error?.message || '',
      }
    },
  })
  return new TurnSnapshots({
    exec: (cwd, args, options) => runner.execute(cwd, args, options),
    tempDir: join(root, 'state'),
    untrackedLimit: 1024,
    keepTurns: 2,
  })
}

/** A repository with a few committed files and an ignored folder. */
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-turns-')))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, '.gitignore'), 'dist/\n')
  writeFileSync(join(repo, 'src', 'a.ts'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'src', 'b.ts'), 'bee\n')
  writeFileSync(join(repo, 'README.md'), '# Readme\n')
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho hi\n')
  chmodSync(join(repo, 'run.sh'), 0o755)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return { root, repo, turns: snapshots(root) }
}

function indexState(repo: string) {
  return {
    hash: createHash('sha256')
      .update(readFileSync(join(repo, '.git', 'index')))
      .digest('hex'),
    staged: git(repo, 'diff', '--cached', '--name-status'),
  }
}

const soon = () => Date.now() + 5_000

async function turn(
  turns: TurnSnapshots,
  projectRoot: string,
  change: () => void,
): Promise<{ before: TurnSnapshot; after: TurnSnapshot }> {
  const place = await turns.locate(projectRoot)
  if (place === null) throw new Error('not a repository')
  const before = await turns.snapshot(place, 'before', soon())
  change()
  const after = await turns.snapshot(place, 'after', soon())
  return { before, after }
}

describe('TurnSnapshots', () => {
  it('records a turn of edits and leaves the user index alone', async () => {
    const { repo, turns } = repository()
    // The user has something staged and something unstaged.
    writeFileSync(join(repo, 'README.md'), '# Readme\n\nstaged\n')
    git(repo, 'add', 'README.md')
    writeFileSync(join(repo, 'src', 'b.ts'), 'bee\nunstaged\n')
    const index = indexState(repo)
    const place = (await turns.locate(repo))!
    const { before, after } = await turn(turns, repo, () => {
      writeFileSync(join(repo, 'src', 'a.ts'), 'one\n2\nthree\nfour\n')
      writeFileSync(join(repo, 'src', 'new.ts'), 'fresh\n')
      rmSync(join(repo, 'run.sh'))
      renameSync(join(repo, 'src', 'b.ts'), join(repo, 'src', 'c.ts'))
      writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]))
      mkdirSync(join(repo, 'dist'))
      writeFileSync(join(repo, 'dist', 'out.js'), 'ignored\n')
    })
    const changes = await turns.changes(place, before, after)
    expect(changes.files).toEqual([
      {
        path: 'logo.bin',
        status: 'added',
        additions: null,
        deletions: null,
        binary: true,
      },
      { path: 'run.sh', status: 'deleted', additions: 0, deletions: 2 },
      { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 },
      {
        path: 'src/c.ts',
        oldPath: 'src/b.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
      },
      { path: 'src/new.ts', status: 'added', additions: 1, deletions: 0 },
    ])
    expect(changes.totals).toEqual({ files: 5, additions: 3, deletions: 3 })
    expect(changes.truncated).toBe(false)
    expect(indexState(repo)).toEqual(index)
  })

  it('leaves a large untracked file out of the snapshot and says so', async () => {
    const { repo, turns } = repository()
    const place = (await turns.locate(repo))!
    const big = 'x'.repeat(4096)
    const { before, after } = await turn(turns, repo, () => {
      writeFileSync(join(repo, 'big.log'), big)
    })
    const changes = await turns.changes(place, before, after)
    expect(changes.files).toEqual([
      {
        path: 'big.log',
        status: 'added',
        additions: null,
        deletions: null,
        tooLarge: true,
      },
    ])
    // Its content never reached the object store.
    const oid = git(repo, 'hash-object', 'big.log')
    const known = spawnSync('git', ['cat-file', '-e', oid], { cwd: repo })
    expect(known.status).not.toBe(0)
  })

  it('works inside a project folder of a larger repository', async () => {
    const { repo, turns } = repository()
    const project = join(repo, 'src')
    const place = (await turns.locate(project))!
    expect(place).toMatchObject({ worktreeRoot: repo, prefix: 'src/' })
    const { before, after } = await turn(turns, project, () => {
      writeFileSync(join(project, 'a.ts'), 'one\n')
      writeFileSync(join(repo, 'README.md'), 'outside the project\n')
    })
    const changes = await turns.changes(place, before, after)
    expect(changes.files.map((file) => file.path)).toEqual(['a.ts'])
    expect(
      await turns.fileDiff(place, before.commit, after.commit, 'a.ts'),
    ).toMatchObject({ diff: expect.stringContaining('-two'), truncated: false })
  })

  it('keeps the latest turns under refs/emperor and drops a session', async () => {
    const { repo, turns } = repository()
    const place = (await turns.locate(repo))!
    for (const number of [1, 2, 3]) {
      const { before, after } = await turn(turns, repo, () => {
        writeFileSync(join(repo, 'src', 'a.ts'), `turn ${number}\n`)
      })
      await turns.keep(place, 'abc123', number, before, after)
    }
    const refs = () =>
      git(repo, 'for-each-ref', '--format=%(refname)', 'refs/emperor/')
        .split('\n')
        .filter(Boolean)
    expect(refs()).toEqual([
      'refs/emperor/turns/abc123/2/after',
      'refs/emperor/turns/abc123/2/before',
      'refs/emperor/turns/abc123/3/after',
      'refs/emperor/turns/abc123/3/before',
    ])
    expect(await turns.refs(place, 'abc123', 3)).toMatchObject({
      before: expect.stringMatching(/^[0-9a-f]{40}$/),
      after: expect.stringMatching(/^[0-9a-f]{40}$/),
    })
    expect(await turns.refs(place, 'abc123', 1)).toBeNull()
    // Branches are untouched; the snapshots are not on any branch.
    expect(git(repo, 'branch', '--list')).toBe('* main')
    await turns.dropSession(place, 'abc123')
    expect(refs()).toEqual([])
  })

  it('undoes a turn file by file, skipping what changed since', async () => {
    const { repo, turns } = repository()
    const place = (await turns.locate(repo))!
    const index = indexState(repo)
    const { before, after } = await turn(turns, repo, () => {
      writeFileSync(join(repo, 'src', 'a.ts'), 'agent\n')
      writeFileSync(join(repo, 'src', 'new.ts'), 'fresh\n')
      rmSync(join(repo, 'run.sh'))
      renameSync(join(repo, 'src', 'b.ts'), join(repo, 'src', 'c.ts'))
      writeFileSync(join(repo, 'README.md'), 'agent readme\n')
    })
    const { files } = await turns.changes(place, before, after)
    // The user edits the README after the turn.
    writeFileSync(join(repo, 'README.md'), 'user readme\n')
    const result = await turns.revert(place, before.commit, after.commit, files)
    expect(result).toEqual({
      reverted: ['run.sh', 'src/a.ts', 'src/c.ts', 'src/new.ts'],
      skipped: [{ path: 'README.md', reason: 'changed-since' }],
    })
    expect(readFileSync(join(repo, 'src', 'a.ts'), 'utf8')).toBe(
      'one\ntwo\nthree\n',
    )
    expect(existsSync(join(repo, 'src', 'new.ts'))).toBe(false)
    expect(readFileSync(join(repo, 'src', 'b.ts'), 'utf8')).toBe('bee\n')
    expect(existsSync(join(repo, 'src', 'c.ts'))).toBe(false)
    expect(statSync(join(repo, 'run.sh')).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('user readme\n')
    expect(indexState(repo)).toEqual(index)
    expect(git(repo, 'status', '--porcelain')).toBe('M README.md')
  })

  it('refuses to undo a large file it never stored', async () => {
    const { repo, turns } = repository()
    const place = (await turns.locate(repo))!
    const { before, after } = await turn(turns, repo, () => {
      writeFileSync(join(repo, 'big.log'), 'x'.repeat(4096))
    })
    const { files } = await turns.changes(place, before, after)
    expect(
      await turns.revert(place, before.commit, after.commit, files),
    ).toEqual({ reverted: [], skipped: [{ path: 'big.log', reason: 'error' }] })
    expect(existsSync(join(repo, 'big.log'))).toBe(true)
  })

  it('gives up past its deadline and knows a folder outside Git', async () => {
    const { root, repo, turns } = repository()
    const place = (await turns.locate(repo))!
    await expect(
      turns.snapshot(place, 'late', Date.now() - 1),
    ).rejects.toBeInstanceOf(TurnSnapshotTimeout)
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(await turns.locate(plain)).toBeNull()
  })
})
