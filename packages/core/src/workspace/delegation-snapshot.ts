import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { HardenedGitRunner } from './git-runner'
import { DelegationError } from '../harness/delegation/types'
import { DelegationResources } from '../harness/delegation/resources'
import { safeDelegationKey } from '../harness/delegation/fold'
export interface BaseSnapshot {
  originalHead: string
  commit: string
  repositoryRoot: string
  commonDir: string
  prefix: string
  manifestDigest: string
  included: string[]
  excluded: { path: string; reason: string }[]
  ref?: string
}
export interface SnapshotInput {
  id: string
  cwd: string
  base: 'committed' | 'snapshot'
  readOnly?: boolean
  untracked?: string[]
}
export class SnapshotService {
  readonly resources: DelegationResources
  constructor(
    private readonly options: {
      runner: HardenedGitRunner
      tempRoot: string
      resources?: DelegationResources
    },
  ) {
    this.resources = options.resources ?? new DelegationResources()
  }
  async capture(input: SnapshotInput): Promise<BaseSnapshot> {
    safeDelegationKey(input.id)
    const git: Pick<HardenedGitRunner, 'execute'> = {
      execute: async (cwd, args, options) => {
        const result = await this.options.runner.execute(cwd, args, options)
        if (result.stdoutTruncated)
          throw new DelegationError(
            'SNAPSHOT_LIMIT',
            'Git inventory was truncated; source completeness is unverified',
          )
        return result
      },
    }
    const cwd = realpathSync(input.cwd)
    const root = realpathSync(
      (await git.execute(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim(),
    )
    const common = realpathSync(
      resolve(
        cwd,
        (
          await git.execute(cwd, ['rev-parse', '--git-common-dir'])
        ).stdout.trim(),
      ),
    )
    const head = (
      await git.execute(root, ['rev-parse', '--verify', 'HEAD'])
    ).stdout.trim()
    const prefix = relative(root, cwd)
    const split = (s: string) => s.split('\0').filter(Boolean)
    const tracked = split(
      (await git.execute(root, ['ls-files', '-z', '--cached'])).stdout,
    )
    const untracked = split(
      (
        await git.execute(root, [
          'ls-files',
          '-z',
          '--others',
          '--exclude-standard',
        ])
      ).stdout,
    )
    const ignored = split(
      (
        await git.execute(root, [
          'ls-files',
          '-z',
          '--others',
          '--ignored',
          '--directory',
          '--exclude-standard',
        ])
      ).stdout,
    )
    const stages = split(
      (await git.execute(root, ['ls-files', '--stage', '-z'])).stdout,
    )
    const submodules = new Set(
      stages
        .filter((x) => x.startsWith('160000 '))
        .map((x) => x.slice(x.indexOf('\t') + 1)),
    )
    const selected = new Set(input.untracked ?? [])
    for (const path of selected)
      if (isAbsolute(path) || path.split(/[\\/]/).some((p) => p === '..'))
        throw new DelegationError(
          'INVALID_PATH',
          'snapshot selection escaped repository',
        )
    const excluded: { path: string; reason: string }[] = ignored.map(
      (path) => ({ path, reason: 'ignored' }),
    )
    const included: string[] = []
    for (const path of [...new Set([...tracked, ...untracked])].sort()) {
      const local = resolve(root, path),
        rel = relative(root, local)
      if (isAbsolute(rel) || rel.startsWith('..' + sep))
        throw new DelegationError(
          'INVALID_PATH',
          'repository returned an escaping path',
        )
      let reason: string | undefined
      if (submodules.has(path)) reason = 'submodule'
      let current = root
      for (const part of rel.split(sep)) {
        current = join(current, part)
        if (isSymlink(current)) {
          reason = 'symlink'
          break
        }
        if (current !== root && existsSync(join(current, '.git'))) {
          reason = 'nested-repository'
          break
        }
      }
      if (!reason && basename(path).startsWith('.env'))
        reason = 'excluded-secret-file'
      if (!reason && untracked.includes(path) && !selected.has(path))
        reason = 'unselected'
      if (reason) excluded.push({ path, reason })
      else included.push(path)
    }
    // Fingerprint both metadata and selected bytes so readonly evidence becomes stale on content drift.
    const digest = createHash('sha256').update(
      JSON.stringify({ head, included, excluded }),
    )
    for (const path of included) {
      digest.update(path)
      if (existsSync(join(root, path)) && lstatSync(join(root, path)).isFile())
        digest.update(readFileSync(join(root, path)))
      else digest.update('deleted')
    }
    const base: BaseSnapshot = {
      originalHead: head,
      commit: head,
      repositoryRoot: root,
      commonDir: common,
      prefix,
      manifestDigest: digest.digest('hex'),
      included,
      excluded,
    }
    if (input.readOnly) {
      if (input.base === 'snapshot')
        throw new DelegationError(
          'PERMISSION_DENIED',
          'readonly source cannot create a Git snapshot',
        )
      return base
    }
    const dirty = (
      await git.execute(root, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ])
    ).stdout
    if (input.base === 'committed') {
      if (dirty)
        throw new DelegationError(
          'DIRTY_BASE_REQUIRES_SNAPSHOT',
          'explicit snapshot base required for uncommitted input',
        )
      return base
    }
    if (included.length > 10000)
      throw new DelegationError(
        'SNAPSHOT_LIMIT',
        'snapshot file count exceeded',
      )
    const lease = await this.resources.acquire({
      keys: ['git:' + common],
      mode: 'exclusive',
      owner: input.id,
    })
    mkdirSync(this.options.tempRoot, { recursive: true, mode: 0o700 })
    const index = join(this.options.tempRoot, randomUUID() + '.index')
    const env = { GIT_INDEX_FILE: index }
    try {
      await git.execute(root, ['read-tree', head], { env })
      for (const entry of excluded)
        if (tracked.includes(entry.path))
          await git.execute(
            root,
            [
              '--literal-pathspecs',
              'update-index',
              '--force-remove',
              '--',
              entry.path,
            ],
            { env },
          )
      for (const path of included) {
        const absolute = join(root, path)
        if (!existsSync(absolute)) {
          await git.execute(
            root,
            [
              '--literal-pathspecs',
              'update-index',
              '--force-remove',
              '--',
              path,
            ],
            { env },
          )
          continue
        }
        const stat = lstatSync(absolute)
        if (!stat.isFile()) continue
        const oid = (
          await git.execute(root, [
            'hash-object',
            '--no-filters',
            '-w',
            '--',
            path,
          ])
        ).stdout.trim()
        await git.execute(
          root,
          [
            'update-index',
            '--add',
            '--cacheinfo',
            stat.mode & 0o111 ? '100755' : '100644',
            oid,
            path,
          ],
          { env },
        )
      }
      const tree = (
        await git.execute(root, ['write-tree'], { env })
      ).stdout.trim()
      const commit = (
        await git.execute(root, ['commit-tree', tree, '-p', head], {
          stdin: 'Emperor delegation base snapshot\n',
          env: {
            GIT_AUTHOR_NAME: 'Emperor Agent',
            GIT_AUTHOR_EMAIL: 'delegation@localhost',
            GIT_COMMITTER_NAME: 'Emperor Agent',
            GIT_COMMITTER_EMAIL: 'delegation@localhost',
          },
        })
      ).stdout.trim()
      const ref = 'refs/emperor/delegations/' + input.id + '/base'
      await git.execute(root, ['update-ref', ref, commit])
      return { ...base, commit, ref }
    } finally {
      rmSync(index, { force: true })
      rmSync(index + '.lock', { force: true })
      lease.release()
    }
  }
}
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
