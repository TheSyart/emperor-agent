import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { GitCommandResult, HardenedGitRunner } from './git-runner'
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
  /**
   * The changed and new files the snapshot carries (what `git status`
   * listed, AGT-06); every other file is the commit's own.
   */
  included: string[]
  excluded: { path: string; reason: string }[]
  ref?: string
}
export interface SnapshotInput {
  id: string
  cwd: string
  base: 'committed' | 'snapshot'
  readOnly?: boolean
  /**
   * Restricts the untracked files to this selection. Omitted: every
   * untracked file that .gitignore allows (AGT-06).
   */
  untracked?: string[]
  /** The ref that keeps the commit; default `refs/emperor/delegations/<id>/base`. */
  ref?: string
}
/** Above this many changed files a snapshot base is refused (AGT-06). */
export const SNAPSHOT_CHANGED_LIMIT = 10_000
/** An untracked file larger than this stays out of a snapshot. */
export const SNAPSHOT_FILE_LIMIT = 16 * 1024 * 1024
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Emperor Agent',
  GIT_AUTHOR_EMAIL: 'delegation@localhost',
  GIT_COMMITTER_NAME: 'Emperor Agent',
  GIT_COMMITTER_EMAIL: 'delegation@localhost',
}
/** One Git command in a place: `args` go after any `--git-dir`/`--work-tree`. */
export type PlacedGit = (
  args: string[],
  options?: {
    stdin?: string
    env?: Record<string, string>
    allowedExitCodes?: number[]
  },
) => Promise<GitCommandResult>
/** Commands that refuse a truncated inventory instead of trusting it. */
export function placedGit(
  runner: Pick<HardenedGitRunner, 'execute'>,
  cwd: string,
  prefix: string[] = [],
): PlacedGit {
  return async (args, options) => {
    const result = await runner.execute(cwd, [...prefix, ...args], options)
    if (result.stdoutTruncated)
      throw new DelegationError(
        'SNAPSHOT_LIMIT',
        'Git inventory was truncated; source completeness is unverified',
      )
    return result
  }
}
export interface StatusEntry {
  path: string
  untracked: boolean
}
/** `git status --porcelain=v1 -z` entries; a rename's source is consumed. */
export function parseStatus(stdout: string): StatusEntry[] {
  const tokens = stdout.split('\0')
  const entries: StatusEntry[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.length < 4) continue
    const xy = token.slice(0, 2)
    entries.push({ path: token.slice(3), untracked: xy === '??' })
    if (xy.includes('R') || xy.includes('C')) index++
  }
  return entries
}
/** The changed files of a work tree, as `git status` lists them (AGT-06). */
export async function statusEntries(git: PlacedGit): Promise<StatusEntry[]> {
  return parseStatus(
    (
      await git([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--no-renames',
      ])
    ).stdout,
  )
}
/**
 * Write a commit of `head` plus the given changed files of a work tree:
 * only these files are hashed into objects (one `hash-object` for all of
 * them), through a temporary index, so the user's index is never touched.
 * Files that no longer exist are removed; `remove` drops tracked paths.
 */
export async function commitChanges(
  git: PlacedGit,
  input: {
    workTree: string
    head: string
    changed: string[]
    remove?: string[]
    tempRoot: string
    message: string
  },
): Promise<{ commit: string; tree: string; written: number }> {
  mkdirSync(input.tempRoot, { recursive: true, mode: 0o700 })
  const index = join(input.tempRoot, randomUUID() + '.index')
  const env = { GIT_INDEX_FILE: index }
  const nullOid = '0'.repeat(input.head.length)
  try {
    await git(['read-tree', input.head], { env })
    const present: { path: string; mode: string }[] = []
    const lines: string[] = (input.remove ?? []).map(
      (path) => `0 ${nullOid}\t${path}`,
    )
    for (const path of input.changed) {
      let stat
      try {
        stat = lstatSync(join(input.workTree, path))
      } catch {
        stat = undefined
      }
      if (!stat?.isFile()) lines.push(`0 ${nullOid}\t${path}`)
      else present.push({ path, mode: stat.mode & 0o111 ? '100755' : '100644' })
    }
    if (present.length) {
      const oids = (
        await git(['hash-object', '-w', '--stdin-paths'], {
          stdin: present.map((file) => file.path).join('\n') + '\n',
        })
      ).stdout
        .split('\n')
        .filter(Boolean)
      if (oids.length !== present.length)
        throw new DelegationError(
          'SNAPSHOT_FAILED',
          'Git did not hash every changed file',
        )
      present.forEach((file, i) =>
        lines.push(`${file.mode} ${oids[i]}\t${file.path}`),
      )
    }
    if (lines.length)
      await git(['update-index', '-z', '--index-info'], {
        env,
        stdin: lines.join('\0') + '\0',
      })
    const tree = (await git(['write-tree'], { env })).stdout.trim()
    const commit = (
      await git(['commit-tree', '--no-gpg-sign', tree, '-p', input.head], {
        stdin: input.message + '\n',
        env: SNAPSHOT_IDENTITY,
      })
    ).stdout.trim()
    return { commit, tree, written: present.length }
  } finally {
    rmSync(index, { force: true })
    rmSync(index + '.lock', { force: true })
  }
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
  /**
   * The base a child starts from (AGT-06). `committed` is the last commit
   * as it is; `snapshot` is the work tree now: the last commit plus every
   * change and untracked file `git status` lists (.gitignore respected,
   * secrets and links left out). Only the listed files are read and
   * written as objects; nothing reads the whole workspace.
   */
  async capture(input: SnapshotInput): Promise<BaseSnapshot> {
    safeDelegationKey(input.id)
    const cwd = realpathSync(input.cwd)
    const git = placedGit(this.options.runner, cwd)
    const root = realpathSync(
      (await git(['rev-parse', '--show-toplevel'])).stdout.trim(),
    )
    const at = placedGit(this.options.runner, root)
    const common = realpathSync(
      resolve(
        cwd,
        (await git(['rev-parse', '--git-common-dir'])).stdout.trim(),
      ),
    )
    const head = (await at(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    const prefix = relative(root, cwd)
    const split = (s: string) => s.split('\0').filter(Boolean)
    const stages = split((await at(['ls-files', '--stage', '-z'])).stdout)
    const tracked = new Map(
      stages.map((line) => {
        const tab = line.indexOf('\t')
        return [line.slice(tab + 1), line.slice(0, line.indexOf(' '))]
      }),
    )
    const ignored = split(
      (
        await at([
          'ls-files',
          '-z',
          '--others',
          '--ignored',
          '--directory',
          '--exclude-standard',
        ])
      ).stdout,
    )
    const selected = input.untracked ? new Set(input.untracked) : undefined
    for (const path of selected ?? [])
      if (isAbsolute(path) || path.split(/[\\/]/).some((p) => p === '..'))
        throw new DelegationError(
          'INVALID_PATH',
          'snapshot selection escaped repository',
        )
    const excluded: { path: string; reason: string }[] = ignored.map(
      (path) => ({ path, reason: 'ignored' }),
    )
    const remove: string[] = []
    // What the commit itself carries that a child must not get or follow.
    for (const [path, mode] of tracked) {
      if (mode === '160000') excluded.push({ path, reason: 'submodule' })
      else if (mode === '120000') excluded.push({ path, reason: 'symlink' })
      else if (basename(path).startsWith('.env')) {
        excluded.push({ path, reason: 'excluded-secret-file' })
        remove.push(path)
      }
    }
    const changed: string[] = []
    const fingerprint: unknown[] = []
    for (const entry of await statusEntries(at)) {
      const path = entry.path.replace(/\/$/, '')
      if (tracked.get(path) === '160000') continue
      const local = resolve(root, path),
        rel = relative(root, local)
      if (isAbsolute(rel) || rel.startsWith('..' + sep))
        throw new DelegationError(
          'INVALID_PATH',
          'repository returned an escaping path',
        )
      let reason: string | undefined
      if (entry.path.endsWith('/')) reason = 'nested-repository'
      else if (path.includes('\n')) reason = 'unsupported-path'
      if (!reason) {
        let current = root
        for (const part of rel.split(sep)) {
          current = join(current, part)
          if (isSymlink(current)) {
            reason = 'symlink'
            break
          }
          if (current !== local && existsSync(join(current, '.git'))) {
            reason = 'nested-repository'
            break
          }
        }
      }
      if (!reason && basename(path).startsWith('.env'))
        reason = 'excluded-secret-file'
      if (!reason && entry.untracked && selected && !selected.has(path))
        reason = 'unselected'
      let size = -1,
        mtime = 0
      if (!reason) {
        try {
          const stat = lstatSync(local)
          size = stat.size
          mtime = stat.mtimeMs
          if (entry.untracked && stat.size > SNAPSHOT_FILE_LIMIT)
            reason = 'too-large'
        } catch {
          // deleted: removed from the snapshot
        }
      }
      if (reason) {
        if (!excluded.some((e) => e.path === path))
          excluded.push({ path, reason })
        if (tracked.has(path) && !remove.includes(path)) remove.push(path)
        continue
      }
      changed.push(path)
      fingerprint.push([path, size, mtime])
    }
    changed.sort()
    const snapshot: BaseSnapshot = {
      originalHead: head,
      commit: head,
      repositoryRoot: root,
      commonDir: common,
      prefix,
      // The commit, what changed on top of it (size and time) and what was
      // left out: content drift in a listed file shows on its next capture.
      manifestDigest: createHash('sha256')
        .update(JSON.stringify({ head, fingerprint, excluded }))
        .digest('hex'),
      included: changed,
      excluded,
    }
    if (input.readOnly) {
      if (input.base === 'snapshot')
        throw new DelegationError(
          'PERMISSION_DENIED',
          'readonly source cannot create a Git snapshot',
        )
      return snapshot
    }
    // The last commit as it is: uncommitted work stays out (and in place).
    if (input.base === 'committed') return { ...snapshot, included: [] }
    if (changed.length > SNAPSHOT_CHANGED_LIMIT)
      throw new DelegationError(
        'SNAPSHOT_LIMIT',
        `more than ${SNAPSHOT_CHANGED_LIMIT} changed files; start from the last commit instead (base "committed")`,
      )
    const lease = await this.resources.acquire({
      keys: ['git:' + common],
      mode: 'exclusive',
      owner: input.id,
    })
    try {
      const written = await commitChanges(at, {
        workTree: root,
        head,
        changed,
        remove,
        tempRoot: this.options.tempRoot,
        message: 'Emperor delegation base snapshot',
      })
      const ref = input.ref ?? 'refs/emperor/delegations/' + input.id + '/base'
      await at(['update-ref', ref, written.commit])
      return {
        ...snapshot,
        commit: written.commit,
        manifestDigest: createHash('sha256')
          .update(JSON.stringify({ head, tree: written.tree, excluded }))
          .digest('hex'),
        ref,
      }
    } finally {
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
