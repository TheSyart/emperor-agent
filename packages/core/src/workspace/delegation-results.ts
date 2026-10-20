/**
 * A write run's result and what becomes of it (AGT-06).
 *
 * - collect: the run's isolated workspace (a worktree of the user's
 *   repository, or a folder copy with a private Git directory) as a commit:
 *   its base plus what `git status` lists there; the files and lines it
 *   changed come from `git diff` between the two commits.
 * - apply: a three-way merge into the current workspace, file by file (the
 *   base, the project now, the result). It writes nothing when any file
 *   conflicts; otherwise it writes every file and records the before and
 *   after state of exactly those files, so 撤销 can put them back.
 * - cleanup: the result worktree (or copy) and its private refs go when the
 *   result is applied, discarded or its conversation is purged; an apply
 *   keeps only its undo record, under the conversation's change records.
 */
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { DelegationResult } from '../harness/delegation/types'
import { DelegationError } from '../harness/delegation/types'
import type { DelegationWorkspaceLease } from './delegation-workspaces'
import {
  commitChanges,
  placedGit,
  statusEntries,
  type PlacedGit,
} from './delegation-snapshot'
import type { HardenedGitRunner } from './git-runner'
import type { WorkspaceMutationCoordinator } from './mutation-coordinator'
import {
  TurnSnapshots,
  turnRefBase,
  type TurnFileEntry,
  type TurnRepository,
  type TurnRevertSkip,
} from './turn-snapshots'

export type ApplyOutcome =
  | {
      state: 'applied'
      files: TurnFileEntry[]
      totals: DelegationResult['totals']
      truncated?: true
      undo: { before: string; after: string }
    }
  | { state: 'conflicted'; conflicts: string[] }

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Emperor Agent',
  GIT_AUTHOR_EMAIL: 'delegation@localhost',
  GIT_COMMITTER_NAME: 'Emperor Agent',
  GIT_COMMITTER_EMAIL: 'delegation@localhost',
}

/** One side of a workspace: where its commands run and how. */
interface Side {
  /** The work tree's root (repository root, or the copy / folder). */
  root: string
  /** The project inside it ('' or `dir/`). */
  prefix: string
  /** The object store (the repository's common directory, or the copy's). */
  gitDir: string
  git: PlacedGit
  /** For TurnSnapshots: the same commands in the same place. */
  snapshots: TurnSnapshots
  place: TurnRepository
  /** Where result and undo refs are kept. */
  refs: {
    result: (runId: string) => string
    applied: (runId: string) => string
  }
}

interface Entry {
  path: string
  base: { mode: string; oid: string } | null
  result: { mode: string; oid: string } | null
}

export class DelegationResults {
  constructor(
    private readonly options: {
      root: string
      runner: HardenedGitRunner
      mutations: WorkspaceMutationCoordinator
      now?: () => number
    },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private temp(): string {
    const dir = join(this.options.root, 'apply-temp', randomUUID())
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  /** The child's side: its worktree or folder copy. */
  private child(lease: DelegationWorkspaceLease): Side | null {
    if (lease.cleaned || lease.status === 'released') return null
    if (lease.copy)
      return this.side(
        lease.path,
        '',
        lease.copy.gitDir,
        [`--git-dir=${lease.copy.gitDir}`, `--work-tree=${lease.path}`],
        (run) => `refs/emperor/runs/${run}`,
      )
    if (lease.mode !== 'isolated-worktree' || !lease.snapshot) return null
    const prefix = lease.snapshot.prefix ? lease.snapshot.prefix + '/' : ''
    return this.side(
      lease.path,
      prefix,
      lease.snapshot.commonDir,
      [],
      (run) => `refs/emperor/delegations/${lease.id}/runs/${run}`,
    )
  }

  /** The project's side: the user's repository, or the original folder. */
  private target(lease: DelegationWorkspaceLease, sessionId: string): Side {
    if (lease.copy)
      return this.side(
        lease.copy.source,
        '',
        lease.copy.gitDir,
        [`--git-dir=${lease.copy.gitDir}`, `--work-tree=${lease.copy.source}`],
        (run) => `refs/emperor/runs/${run}`,
        (run) => `refs/emperor/applied/${run}`,
      )
    if (!lease.snapshot)
      throw new DelegationError('NO_RESULT', 'this task has no result to apply')
    const prefix = lease.snapshot.prefix ? lease.snapshot.prefix + '/' : ''
    return this.side(
      lease.snapshot.repositoryRoot,
      prefix,
      lease.snapshot.commonDir,
      [],
      (run) => `refs/emperor/delegations/${lease.id}/runs/${run}`,
      (run) => `${turnRefBase(sessionId)}/applied/${run}`,
    )
  }

  private side(
    root: string,
    prefix: string,
    gitDir: string,
    args: string[],
    result: (runId: string) => string,
    applied: (runId: string) => string = result,
  ): Side {
    const runner = this.options.runner
    return {
      root,
      prefix,
      gitDir,
      git: placedGit(runner, root, args),
      snapshots: new TurnSnapshots({
        exec: (cwd, rest, options) =>
          runner.execute(cwd, [...args, ...rest], options),
        tempDir: join(this.options.root, 'indexes'),
      }),
      place: {
        projectRoot: prefix ? join(root, prefix) : root,
        worktreeRoot: root,
        prefix,
        indexPath: '',
      },
      refs: { result, applied },
    }
  }

  /** The run's result as a commit and a file list; null when it has none. */
  async collect(
    lease: DelegationWorkspaceLease,
    runId: string,
  ): Promise<DelegationResult | null> {
    const side = this.child(lease)
    if (!side || !existsSync(side.root)) return null
    const base = lease.copy?.base ?? lease.snapshot!.commit
    const head = lease.copy
      ? base
      : (await side.git(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    const changed = (await statusEntries(side.git))
      .filter((entry) => !entry.path.endsWith('/'))
      .map((entry) => entry.path)
      .filter((path) => {
        try {
          return !lstatSync(join(side.root, path)).isSymbolicLink()
        } catch {
          return true
        }
      })
    const { commit } = await commitChanges(side.git, {
      workTree: side.root,
      head,
      changed,
      tempRoot: join(this.options.root, 'indexes'),
      message: 'Emperor delegation result',
    })
    await side.git(['update-ref', side.refs.result(runId), commit])
    const changes = await side.snapshots.changes(
      side.place,
      { commit: base, tooLarge: {} },
      { commit, tooLarge: {} },
    )
    return {
      base,
      commit,
      files: changes.files,
      totals: changes.totals,
      ...(changes.truncated ? { truncated: true as const } : {}),
      state: 'ready',
      at: this.now(),
    }
  }

  /** The changed paths between base and result, repository-relative. */
  private async entries(
    side: Side,
    result: DelegationResult,
  ): Promise<Entry[]> {
    const raw = (
      await side.git([
        'diff-tree',
        '-r',
        '-z',
        '--no-renames',
        result.base,
        result.commit,
        ...(side.prefix ? ['--', side.prefix] : []),
      ])
    ).stdout.split('\0')
    const entries: Entry[] = []
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const meta = raw[i]!
      if (!meta.startsWith(':')) {
        i -= 1
        continue
      }
      const [baseMode, resultMode, baseOid, resultOid] = meta
        .slice(1)
        .split(' ')
      const zero = /^0+$/
      entries.push({
        path: raw[i + 1]!,
        base: zero.test(baseOid!) ? null : { mode: baseMode!, oid: baseOid! },
        result: zero.test(resultOid!)
          ? null
          : { mode: resultMode!, oid: resultOid! },
      })
    }
    return entries
  }

  /** The bytes of one object, in a private temporary directory. */
  private async object(side: Side, oid: string, dir: string): Promise<string> {
    const name = (
      await placedGit(this.options.runner, dir, [
        `--git-dir=${side.gitDir}`,
        `--work-tree=${dir}`,
      ])(['unpack-file', oid])
    ).stdout.trim()
    const written = resolve(dir, name)
    const rel = relative(dir, written)
    if (
      !name.startsWith('.merge_file_') ||
      rel.startsWith('..') ||
      rel.includes('/')
    )
      throw new DelegationError('APPLY_FAILED', 'Git wrote an unexpected file')
    return written
  }

  /**
   * Three-way merge into the project (AGT-06). Conflicts write nothing;
   * otherwise every file is written and its before/after kept for 撤销.
   */
  async apply(
    lease: DelegationWorkspaceLease,
    result: DelegationResult,
    input: { sessionId: string; runId: string; signal?: AbortSignal | null },
  ): Promise<ApplyOutcome> {
    const side = this.target(lease, input.sessionId)
    if (!existsSync(side.root))
      throw new DelegationError('TARGET_MISSING', 'the project folder is gone')
    return this.options.mutations.runExclusive(
      side.place.projectRoot,
      'agent',
      async () => {
        const entries = await this.entries(side, result)
        const conflicts: string[] = []
        const present: string[] = []
        const local = (path: string) => join(side.root, path)
        for (const entry of entries) {
          // Never write through a link: a folder on the way that became one
          // (or anything not a regular file) is the user's to sort out.
          if (linkedParent(side.root, entry.path)) {
            conflicts.push(entry.path)
            continue
          }
          let stat
          try {
            stat = lstatSync(local(entry.path))
          } catch {
            continue
          }
          if (!stat.isFile()) conflicts.push(entry.path)
          else present.push(entry.path)
        }
        const current = new Map<string, { mode: string; oid: string } | null>(
          entries.map((entry) => [entry.path, null]),
        )
        const hashed = await this.hash(side, present, true)
        present.forEach((path) => current.set(path, hashed.get(path)!))
        const dir = this.temp()
        try {
          const writes: {
            path: string
            to: { mode: string; oid: string } | null
            bytes?: string
          }[] = []
          for (const entry of entries) {
            if (conflicts.includes(entry.path)) continue
            const ours = current.get(entry.path) ?? null
            if (same(ours, entry.result)) continue
            if (same(ours, entry.base)) {
              writes.push({ path: entry.path, to: entry.result })
              continue
            }
            if (!ours || !entry.base || !entry.result) {
              conflicts.push(entry.path)
              continue
            }
            // Both sides changed a file: let Git merge the text.
            const mine = join(dir, randomUUID())
            copyFileSync(local(entry.path), mine)
            const merged = await side.git(
              [
                'merge-file',
                '-L',
                'project',
                '-L',
                'base',
                '-L',
                'result',
                mine,
                await this.object(side, entry.base.oid, dir),
                await this.object(side, entry.result.oid, dir),
              ],
              { allowedExitCodes: Array.from({ length: 256 }, (_, i) => i) },
            )
            if (merged.exitCode !== 0) {
              conflicts.push(entry.path)
              continue
            }
            writes.push({
              path: entry.path,
              // The project's mode, unless the result changed it.
              to: {
                mode:
                  entry.base.mode === entry.result.mode
                    ? ours.mode
                    : entry.result.mode,
                oid: '',
              },
              bytes: mine,
            })
          }
          if (conflicts.length)
            return {
              state: 'conflicted',
              conflicts: unprefixed(side, conflicts.sort()),
            }
          // Nothing moved since the plan (the lock keeps Emperor's own tools out).
          const recheck = await this.hash(
            side,
            writes.map((w) => w.path).filter((path) => current.get(path)),
            false,
          )
          const moved = writes
            .filter((w) => {
              const was = current.get(w.path) ?? null
              const now = recheck.get(w.path) ?? null
              if (!was) return existsSync(local(w.path))
              return !same(was, now)
            })
            .map((w) => w.path)
          if (moved.length)
            return {
              state: 'conflicted',
              conflicts: unprefixed(side, moved.sort()),
            }
          // Write.
          const installed: typeof writes = []
          try {
            for (const w of writes) {
              if (!w.to) rmSync(local(w.path), { force: true })
              else
                install(
                  local(w.path),
                  w.bytes ?? (await this.object(side, w.to.oid, dir)),
                  w.to.mode,
                )
              installed.push(w)
            }
          } catch (error) {
            for (const w of installed.reverse()) {
              const was = current.get(w.path) ?? null
              try {
                if (!was) rmSync(local(w.path), { force: true })
                else
                  install(
                    local(w.path),
                    await this.object(side, was.oid, dir),
                    was.mode,
                  )
              } catch {
                /* left for the user; the error says the apply failed */
              }
            }
            throw new DelegationError(
              'APPLY_FAILED',
              'writing the result failed and was rolled back: ' +
                (error instanceof Error ? error.message : String(error)),
            )
          }
          // What 撤销 needs: the files before and after, as two commits.
          const after = await this.hash(
            side,
            writes.filter((w) => w.to).map((w) => w.path),
            true,
          )
          const before = await this.record(
            side,
            writes.map((w) => [w.path, current.get(w.path) ?? null]),
            dir,
          )
          const afterCommit = await this.record(
            side,
            writes.map((w) => [w.path, w.to ? after.get(w.path)! : null]),
            dir,
          )
          await side.git([
            'update-ref',
            side.refs.applied(input.runId) + '/before',
            before,
          ])
          await side.git([
            'update-ref',
            side.refs.applied(input.runId) + '/after',
            afterCommit,
          ])
          const changes = await side.snapshots.changes(
            side.place,
            { commit: before, tooLarge: {} },
            { commit: afterCommit, tooLarge: {} },
          )
          return {
            state: 'applied',
            files: changes.files,
            totals: changes.totals,
            ...(changes.truncated ? { truncated: true as const } : {}),
            undo: { before, after: afterCommit },
          }
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      },
      input.signal,
    )
  }

  /** `path → {mode, oid}` of work-tree files (objects written with `write`). */
  private async hash(
    side: Side,
    paths: string[],
    write: boolean,
  ): Promise<Map<string, { mode: string; oid: string }>> {
    const out = new Map<string, { mode: string; oid: string }>()
    if (!paths.length) return out
    const oids = (
      await side.git(
        ['hash-object', ...(write ? ['-w'] : []), '--stdin-paths'],
        { stdin: paths.join('\n') + '\n' },
      )
    ).stdout
      .split('\n')
      .filter(Boolean)
    paths.forEach((path, i) => {
      const mode =
        lstatSync(join(side.root, path)).mode & 0o111 ? '100755' : '100644'
      out.set(path, { mode, oid: oids[i]! })
    })
    return out
  }

  /** A commit holding just these files (absent ones left out). */
  private async record(
    side: Side,
    files: [string, { mode: string; oid: string } | null][],
    dir: string,
  ): Promise<string> {
    const env = { GIT_INDEX_FILE: join(dir, randomUUID() + '.index') }
    const lines = files
      .filter(([, file]) => file)
      .map(([path, file]) => `${file!.mode} ${file!.oid}\t${path}`)
    if (lines.length)
      await side.git(['update-index', '-z', '--index-info'], {
        env,
        stdin: lines.join('\0') + '\0',
      })
    const tree = (await side.git(['write-tree'], { env })).stdout.trim()
    return (
      await side.git(['commit-tree', '--no-gpg-sign', tree], {
        stdin: 'Emperor applied delegation result\n',
        env: { ...env, ...IDENTITY },
      })
    ).stdout.trim()
  }

  /** 撤销: the applied files back as they were, where nobody changed them since. */
  async undo(
    lease: DelegationWorkspaceLease,
    result: DelegationResult,
    input: { sessionId: string },
  ): Promise<{ reverted: string[]; skipped: TurnRevertSkip[] }> {
    if (!result.undo)
      throw new DelegationError(
        'NOTHING_TO_UNDO',
        'this result was not applied',
      )
    const side = this.target(lease, input.sessionId)
    return this.options.mutations.runExclusive(
      side.place.projectRoot,
      'renderer_git',
      () =>
        side.snapshots.revert(
          side.place,
          result.undo!.before,
          result.undo!.after,
          result.files,
        ),
    )
  }

  /** One file's unified diff: result against its base, or what an apply changed. */
  async diff(
    lease: DelegationWorkspaceLease,
    result: DelegationResult,
    path: string,
    sessionId: string,
  ): Promise<{ path: string; diff: string; truncated: boolean }> {
    const file = result.files.find((entry) => entry.path === path)
    if (!file)
      throw new DelegationError(
        'UNKNOWN_FILE',
        'this file is not in the result',
      )
    if (result.undo) {
      const side = this.target(lease, sessionId)
      return {
        path,
        ...(await side.snapshots.fileDiff(
          side.place,
          result.undo.before,
          result.undo.after,
          file.path,
          file.oldPath,
        )),
      }
    }
    const side = this.child(lease)
    if (!side || !existsSync(side.place.projectRoot))
      throw new DelegationError('RESULT_GONE', 'the result was cleaned up')
    return {
      path,
      ...(await side.snapshots.fileDiff(
        side.place,
        result.base,
        result.commit,
        file.path,
        file.oldPath,
      )),
    }
  }

  /**
   * The result worktree (or folder copy) and its private refs go. An
   * applied copy keeps its private Git directory for 撤销 until the
   * conversation is purged.
   */
  async cleanup(
    lease: DelegationWorkspaceLease,
    input: { keepUndo?: boolean; refs?: string[]; worktrees?: string[] } = {},
  ): Promise<void> {
    if (lease.copy) {
      rmSync(lease.path, { recursive: true, force: true })
      if (!input.keepUndo)
        rmSync(lease.copy.gitDir, { recursive: true, force: true })
      return
    }
    const repository = lease.snapshot?.repositoryRoot
    const worktrees = [
      ...(lease.mode === 'isolated-worktree' ? [lease.path] : []),
      ...(input.worktrees ?? []),
    ]
    if (!repository || !existsSync(repository)) {
      for (const path of worktrees)
        rmSync(path, { recursive: true, force: true })
      return
    }
    const git = placedGit(this.options.runner, repository)
    for (const path of worktrees) {
      if (existsSync(path))
        await git(['worktree', 'remove', '--force', path], {
          allowedExitCodes: [0, 128],
        })
      rmSync(path, { recursive: true, force: true })
    }
    await git(['worktree', 'prune'], { allowedExitCodes: [0, 128] })
    const refs = [
      ...(
        await git([
          'for-each-ref',
          '--format=%(refname)',
          `refs/emperor/delegations/${lease.id}/`,
        ])
      ).stdout
        .split('\n')
        .filter(Boolean),
      ...(input.refs ?? []),
    ]
    if (refs.length)
      await git(['update-ref', '--stdin'], {
        stdin: refs.map((ref) => `delete ${ref}`).join('\n') + '\n',
      })
  }

  /** The conversation is purged: its results and undo records go too. */
  async forget(
    lease: DelegationWorkspaceLease,
    sessionId: string,
  ): Promise<void> {
    await this.cleanup(lease)
    const repository = lease.snapshot?.repositoryRoot
    if (!repository || !existsSync(repository)) return
    const git = placedGit(this.options.runner, repository)
    const refs = (
      await git([
        'for-each-ref',
        '--format=%(refname)',
        `${turnRefBase(sessionId)}/applied/`,
      ])
    ).stdout
      .split('\n')
      .filter(Boolean)
    if (refs.length)
      await git(['update-ref', '--stdin'], {
        stdin: refs.map((ref) => `delete ${ref}`).join('\n') + '\n',
      })
  }
}

function same(
  a: { mode: string; oid: string } | null,
  b: { mode: string; oid: string } | null,
): boolean {
  if (!a || !b) return a === b
  return a.oid === b.oid && (a.mode === '100755') === (b.mode === '100755')
}

function unprefixed(side: Side, paths: string[]): string[] {
  return paths.map((path) =>
    side.prefix && path.startsWith(side.prefix)
      ? path.slice(side.prefix.length)
      : path,
  )
}

/** A folder on the way to `path` is a link (or not a folder). */
function linkedParent(root: string, path: string): boolean {
  const parts = path.split('/').slice(0, -1)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return true
    } catch {
      return false
    }
  }
  return false
}

function install(path: string, from: string, mode: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), '.emperor-apply-' + randomUUID())
  try {
    writeFileSync(temporary, readFileSync(from), { flag: 'wx' })
    chmodSync(temporary, mode === '100755' ? 0o755 : 0o644)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
