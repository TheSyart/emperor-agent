/**
 * AGT-06 card tests 1–3 and 8 at the workspace layer: a write task starts
 * from the workspace as it is now (uncommitted and untracked files
 * included, .gitignore respected), only the changed files become objects,
 * and a folder outside Git gets an isolated copy instead of a lock.
 */
import { afterEach, expect, it, vi } from 'vitest'
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { SnapshotService } from './delegation-snapshot'
import { DelegationWorkspaceService } from './delegation-workspaces'
import { WorkspaceMutationCoordinator } from './mutation-coordinator'
import { isolatedWorkspace } from '../harness/delegation/results-test-fixture'
import { fixtureDelegationRecord } from '../harness/delegation/testing'

const cleanups: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup(kind: 'git' | 'folder' = 'git') {
  const w = isolatedWorkspace(kind)
  cleanups.push(w.cleanup)
  const mutations = new WorkspaceMutationCoordinator()
  const state = join(w.root, 'delegations')
  const service = new DelegationWorkspaceService({
    root: state,
    runner: w.runner,
    mutations,
    snapshots: new SnapshotService({
      runner: w.runner,
      tempRoot: join(state, 'indexes'),
      resources: mutations.resources,
    }),
  })
  return {
    ...w,
    state,
    mutations,
    service,
    owner: fixtureDelegationRecord().owner,
  }
}

function childGit(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout
}

it('1 · a write task starts from the uncommitted workspace, new files included, and the child sees one consistent tree', async () => {
  const f = setup()
  writeFileSync(join(f.repo, 'src', 'a.txt'), 'one\ntwo (edited)\nthree\n')
  writeFileSync(join(f.repo, 'src', 'new.ts'), 'export const fresh = 1\n')
  f.git('rm', '-q', 'README.md')
  const lease = await f.service.prepare(f.owner, {
    cwd: f.repo,
    workspace: 'isolated-worktree',
    base: 'snapshot',
  })
  expect(lease.path).not.toBe(f.repo)
  expect(readFileSync(join(lease.cwd, 'src', 'a.txt'), 'utf8')).toBe(
    'one\ntwo (edited)\nthree\n',
  )
  expect(readFileSync(join(lease.cwd, 'src', 'new.ts'), 'utf8')).toBe(
    'export const fresh = 1\n',
  )
  expect(existsSync(join(lease.cwd, 'README.md'))).toBe(false)
  // The child's tree is exactly its base: nothing shows as changed there.
  expect(childGit(lease.cwd, 'status', '--porcelain')).toBe('')
  // The user's own work is untouched.
  expect(f.git('status', '--porcelain')).toContain('?? src/new.ts')
  expect(f.git('rev-parse', 'HEAD')).toBe(lease.snapshot!.originalHead)
})

it('1 · the committed base no longer refuses a dirty workspace: the child gets the last commit', async () => {
  const f = setup()
  writeFileSync(join(f.repo, 'src', 'a.txt'), 'dirty\n')
  const lease = await f.service.prepare(f.owner, {
    cwd: f.repo,
    workspace: 'isolated-worktree',
    base: 'committed',
  })
  expect(readFileSync(join(lease.cwd, 'src', 'a.txt'), 'utf8')).toBe(
    'one\ntwo\nthree\n',
  )
})

it('2 · files .gitignore covers (and secrets) stay out of the snapshot', async () => {
  const f = setup()
  mkdirSync(join(f.repo, 'ignored'))
  writeFileSync(join(f.repo, 'ignored', 'cache.bin'), 'cached')
  writeFileSync(join(f.repo, '.env.local'), 'SECRET=1')
  writeFileSync(join(f.repo, 'notes.md'), 'kept\n')
  const lease = await f.service.prepare(f.owner, {
    cwd: f.repo,
    workspace: 'isolated-worktree',
    base: 'snapshot',
  })
  const tree = f.git('ls-tree', '-r', '--name-only', lease.snapshot!.commit)
  expect(tree.split('\n')).toContain('notes.md')
  expect(tree).not.toContain('ignored/')
  expect(tree).not.toContain('.env.local')
  expect(existsSync(join(lease.cwd, 'ignored'))).toBe(false)
  expect(existsSync(join(lease.cwd, '.env.local'))).toBe(false)
  expect(lease.snapshot!.excluded).toContainEqual({
    path: 'ignored/',
    reason: 'ignored',
  })
})

it('3 · the snapshot writes objects only for the files git status lists, and copies nothing else', async () => {
  const f = setup()
  for (let i = 0; i < 40; i++)
    writeFileSync(join(f.repo, 'src', `file-${i}.txt`), `file ${i}\n`)
  f.git('add', '-A')
  f.git('commit', '-qm', 'forty files')
  writeFileSync(join(f.repo, 'src', 'file-3.txt'), 'changed 3\n')
  writeFileSync(join(f.repo, 'src', 'file-7.txt'), 'changed 7\n')
  writeFileSync(join(f.repo, 'added.txt'), 'added\n')
  const before = f.blobCount()
  const hashed: string[] = []
  const execute = f.runner.execute.bind(f.runner)
  vi.spyOn(f.runner, 'execute').mockImplementation(
    async (cwd, args, options) => {
      if (args.includes('hash-object'))
        hashed.push(
          ...(args.includes('--stdin-paths')
            ? String(options?.stdin ?? '')
                .split('\n')
                .filter(Boolean)
            : args.slice(args.indexOf('--') + 1)),
        )
      return execute(cwd, args, options)
    },
  )
  const lease = await f.service.prepare(f.owner, {
    cwd: f.repo,
    workspace: 'isolated-worktree',
    base: 'snapshot',
  })
  // Hashed: the three listed files, nothing else of the 43.
  expect(hashed.sort()).toEqual([
    'added.txt',
    'src/file-3.txt',
    'src/file-7.txt',
  ])
  expect(f.blobCount() - before).toBe(3)
  expect([...lease.snapshot!.included].sort()).toEqual([
    'added.txt',
    'src/file-3.txt',
    'src/file-7.txt',
  ])
  // No second copy of the workspace in Emperor's artifact store.
  const blobs = join(f.state, 'artifacts', 'blobs')
  expect(existsSync(blobs) ? readdirSync(blobs) : []).toEqual([])
})

it('3 · above 10,000 changed files the snapshot is refused with the committed base as the way out', async () => {
  const f = setup()
  mkdirSync(join(f.repo, 'many'))
  for (let i = 0; i <= 10_000; i++)
    writeFileSync(join(f.repo, 'many', `${i}.txt`), '')
  await expect(
    f.service.prepare(f.owner, {
      cwd: f.repo,
      workspace: 'isolated-worktree',
      base: 'snapshot',
    }),
  ).rejects.toThrow(/SNAPSHOT_LIMIT[\s\S]*committed/)
}, 60_000)

it('8 · a folder outside Git gets an isolated copy, not a lock on the main session', async () => {
  const f = setup('folder')
  writeFileSync(join(f.repo, '.env'), 'SECRET=1')
  const lease = await f.service.prepare(f.owner, {
    cwd: f.repo,
    workspace: 'isolated-worktree',
    base: 'snapshot',
  })
  expect(lease.cwd).not.toBe(f.repo)
  expect(lease.copy?.source).toBe(f.repo)
  expect(readFileSync(join(lease.cwd, 'src', 'a.txt'), 'utf8')).toBe(
    'one\ntwo\nthree\n',
  )
  expect(existsSync(join(lease.cwd, '.git'))).toBe(false)
  expect(existsSync(join(lease.cwd, '.env'))).toBe(false)
  // The child holds its copy; a main-session write to the folder goes on.
  const child = await f.mutations.acquireWriter(lease.cwd, 'dlg-child')
  const main = await Promise.race([
    f.mutations.resources.acquire({
      keys: [f.repo],
      mode: 'exclusive',
      owner: 'main-write',
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
  ])
  expect(main).not.toBeNull()
  main?.release()
  child.release()
})

it('8 · shared-exclusive on a folder outside Git also runs in a copy', async () => {
  const f = setup('folder')
  const lease = await f.service.prepare(f.owner, {
    cwd: f.repo,
    workspace: 'shared-exclusive',
    base: 'snapshot',
  })
  expect(lease.cwd).not.toBe(f.repo)
  expect(lease.copy?.source).toBe(f.repo)
})

it('a shared-readonly review of a folder outside Git reads it in place and copies nothing', async () => {
  const f = setup('folder')
  const lease = await f.service.prepare(f.owner, {
    cwd: f.repo,
    workspace: 'shared-readonly',
    base: 'committed',
    readOnly: true,
  })
  expect(lease.cwd).toBe(f.repo)
  expect(lease.copy).toBeUndefined()
  expect(existsSync(join(f.state, 'artifacts'))).toBe(false)
})
