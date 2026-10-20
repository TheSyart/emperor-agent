/**
 * Shadow snapshots of a Git worktree for per-turn change records (E-track
 * contract §5, experiment E-R2).
 *
 * A snapshot is the working tree as `git add -A` sees it, written through a
 * copy of the user's index (`GIT_INDEX_FILE`), so the user's index and files
 * are never touched: untracked files are included, ignored ones are not,
 * and untracked files over the size limit are left out (`:(exclude)`) and
 * reported as too large. The tree is wrapped in a commit object; a recorded
 * turn keeps its two commits under `refs/emperor/turns/<session>/<turn>/`
 * (never pushed by a plain `git push`), the latest `keepTurns` per session.
 *
 * Undo restores a file only while it still equals the after snapshot, from
 * the before snapshot through another temporary index.
 */

import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import type { GitCommandResult } from './git-runner'

export type TurnFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface TurnFileEntry {
  /** Project-relative, POSIX separators. */
  path: string
  /** The old path of a rename. */
  oldPath?: string
  status: TurnFileStatus
  /** null for binary files and files too large to record. */
  additions: number | null
  deletions: number | null
  binary?: true
  /** An untracked file over the size limit: listed, content not recorded. */
  tooLarge?: true
}

export interface TurnChanges {
  files: TurnFileEntry[]
  totals: { files: number; additions: number; deletions: number }
  truncated: boolean
}

export interface TurnSnapshot {
  commit: string
  /** Untracked files left out for size: path → `size:mtime`. */
  tooLarge: Record<string, string>
}

/** Where a project sits in its Git worktree. */
export interface TurnRepository {
  projectRoot: string
  worktreeRoot: string
  /** The project folder inside the worktree: '' or `dir/`. */
  prefix: string
  /** The user's index (the worktree's own, for a linked worktree). */
  indexPath: string
}

export type TurnRevertSkip = {
  path: string
  reason: 'changed-since' | 'missing' | 'error'
}

export type GitExec = (
  cwd: string,
  args: string[],
  options?: {
    env?: Record<string, string>
    stdin?: string
    allowedExitCodes?: number[]
    timeoutMs?: number
  },
) => Promise<GitCommandResult>

export interface TurnSnapshotsOptions {
  exec: GitExec
  /** Where temporary index files live (never inside the repository). */
  tempDir: string
  /** Untracked files larger than this are left out (default 10 MB). */
  untrackedLimit?: number
  /** Recorded turns kept per session (default 50). */
  keepTurns?: number
  /** Files listed per turn (default 200). */
  listLimit?: number
  now?: () => number
}

export const TURN_SNAPSHOT_BUDGET_MS = 5_000
const DIFF_LIMIT = 2 * 1024 * 1024
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Emperor',
  GIT_AUTHOR_EMAIL: 'emperor@localhost',
  GIT_COMMITTER_NAME: 'Emperor',
  GIT_COMMITTER_EMAIL: 'emperor@localhost',
}

export class TurnSnapshotTimeout extends Error {
  constructor() {
    super('the turn snapshot ran past its time limit')
    this.name = 'TurnSnapshotTimeout'
  }
}

export class TurnSnapshots {
  private readonly exec: GitExec
  private readonly tempDir: string
  private readonly untrackedLimit: number
  private readonly keepTurns: number
  private readonly listLimit: number
  private readonly now: () => number

  constructor(options: TurnSnapshotsOptions) {
    this.exec = options.exec
    this.tempDir = options.tempDir
    this.untrackedLimit = options.untrackedLimit ?? 10 * 1024 * 1024
    this.keepTurns = options.keepTurns ?? 50
    this.listLimit = options.listLimit ?? 200
    this.now = options.now ?? Date.now
  }

  /** The project's place in its Git worktree; null outside Git. */
  async locate(projectRoot: string): Promise<TurnRepository | null> {
    const result = await this.exec(
      projectRoot,
      ['rev-parse', '--show-toplevel', '--git-path', 'index', '--show-prefix'],
      { allowedExitCodes: [0, 128] },
    )
    if (result.exitCode !== 0) return null
    const [top = '', index = '', prefix = ''] = result.stdout.split(/\r?\n/)
    if (!top.trim() || !index.trim()) return null
    return {
      projectRoot,
      worktreeRoot: top.trim(),
      prefix: prefix.trim(),
      indexPath: resolve(projectRoot, index.trim()),
    }
  }

  /** The project's files now, as a commit object (no ref yet). */
  async snapshot(
    place: TurnRepository,
    label: string,
    deadline: number,
  ): Promise<TurnSnapshot> {
    mkdirSync(this.tempDir, { recursive: true, mode: 0o700 })
    const index = join(
      this.tempDir,
      `turn-index-${randomBytes(8).toString('hex')}`,
    )
    try {
      if (existsSync(place.indexPath)) copyFileSync(place.indexPath, index)
      const env = { GIT_INDEX_FILE: index }
      const others = await this.timed(
        place.projectRoot,
        ['ls-files', '-z', '--others', '--exclude-standard', '--', '.'],
        deadline,
      )
      const tooLarge: Record<string, string> = {}
      for (const path of others.stdout.split('\0').filter(Boolean)) {
        try {
          const stat = lstatSync(join(place.projectRoot, path))
          if (stat.isFile() && stat.size > this.untrackedLimit)
            tooLarge[path] = `${stat.size}:${Math.floor(stat.mtimeMs)}`
        } catch {
          // gone since the listing
        }
      }
      const pathspecs = [
        '.',
        ...Object.keys(tooLarge).map((path) => `:(exclude,literal)${path}`),
      ]
      await this.timed(
        place.projectRoot,
        [
          'add',
          '-A',
          '--ignore-errors',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        deadline,
        { env, stdin: pathspecs.join('\0'), allowedExitCodes: [0, 1] },
      )
      const tree = (
        await this.timed(place.projectRoot, ['write-tree'], deadline, { env })
      ).stdout.trim()
      const commit = (
        await this.timed(
          place.projectRoot,
          ['commit-tree', tree, '-m', `emperor turn snapshot: ${label}`],
          deadline,
          { env: { ...env, ...IDENTITY } },
        )
      ).stdout.trim()
      return { commit, tooLarge }
    } finally {
      rmSync(index, { force: true })
      rmSync(`${index}.lock`, { force: true })
    }
  }

  /** What changed in the project between two snapshots. */
  async changes(
    place: TurnRepository,
    before: TurnSnapshot,
    after: TurnSnapshot,
  ): Promise<TurnChanges> {
    const diff = ['diff', '-z', '-M', '--relative', '--no-textconv']
    const [names, numbers] = await Promise.all([
      this.exec(place.projectRoot, [
        ...diff,
        '--name-status',
        before.commit,
        after.commit,
      ]),
      this.exec(place.projectRoot, [
        ...diff,
        '--numstat',
        before.commit,
        after.commit,
      ]),
    ])
    const counts = parseNumstat(numbers.stdout)
    const files: TurnFileEntry[] = parseNameStatus(names.stdout).map(
      (entry) => {
        const count = counts.get(entry.path)
        const binary = count === undefined || count.binary
        return {
          ...entry,
          additions: binary ? null : count.additions,
          deletions: binary ? null : count.deletions,
          ...(count?.binary ? { binary: true as const } : {}),
        }
      },
    )
    for (const [path, stamp] of Object.entries(after.tooLarge)) {
      const was = before.tooLarge[path]
      if (was === stamp) continue
      files.push({
        path,
        status: was === undefined ? 'added' : 'modified',
        additions: null,
        deletions: null,
        tooLarge: true,
      })
    }
    for (const path of Object.keys(before.tooLarge)) {
      if (path in after.tooLarge) continue
      const listed = files.find((file) => file.path === path)
      if (listed === undefined)
        files.push({
          path,
          status: 'deleted',
          additions: null,
          deletions: null,
          tooLarge: true,
        })
      // It shrank under the limit: the after snapshot has it, before not.
      else if (listed.status === 'added') {
        listed.status = 'modified'
        listed.additions = null
        listed.deletions = null
        listed.tooLarge = true
      }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const totals = {
      files: files.length,
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    }
    return {
      files: files.slice(0, this.listLimit),
      totals,
      truncated: files.length > this.listLimit,
    }
  }

  /** The unified diff of one file between two snapshot commits. */
  async fileDiff(
    place: TurnRepository,
    before: string,
    after: string,
    path: string,
    oldPath?: string,
  ): Promise<{ diff: string; truncated: boolean }> {
    const result = await this.exec(place.projectRoot, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '-M',
      '--relative',
      before,
      after,
      '--',
      ...(oldPath === undefined ? [] : [`:(literal)${oldPath}`]),
      `:(literal)${path}`,
    ])
    const truncated =
      result.stdoutTruncated === true || result.stdout.length > DIFF_LIMIT
    return {
      diff: result.stdout.slice(0, DIFF_LIMIT),
      truncated,
    }
  }

  /** Keep a recorded turn's snapshots; drop the session's oldest turns. */
  async keep(
    place: TurnRepository,
    sessionId: string,
    turn: number,
    before: TurnSnapshot,
    after: TurnSnapshot,
  ): Promise<void> {
    const base = refBase(sessionId)
    const existing = await this.sessionRefs(place, sessionId)
    const turns = new Set([...existing.keys(), turn])
    const dropped = [...turns]
      .sort((a, b) => b - a)
      .slice(this.keepTurns)
      .flatMap((old) => existing.get(old) ?? [])
    const commands = [
      `update ${base}/${turn}/before ${before.commit}`,
      `update ${base}/${turn}/after ${after.commit}`,
      ...dropped.map((ref) => `delete ${ref}`),
    ]
    await this.exec(place.worktreeRoot, ['update-ref', '--stdin'], {
      stdin: `${commands.join('\n')}\n`,
    })
  }

  /** A recorded turn's snapshot commits; null once dropped. */
  async refs(
    place: TurnRepository,
    sessionId: string,
    turn: number,
  ): Promise<{ before: string; after: string } | null> {
    const base = `${refBase(sessionId)}/${turn}`
    const result = await this.exec(place.worktreeRoot, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      `${base}/`,
    ])
    const oids = new Map(
      result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.split(' ') as [string, string]),
    )
    const before = oids.get(`${base}/before`)
    const after = oids.get(`${base}/after`)
    return before && after ? { before, after } : null
  }

  /** Delete every recorded turn of a session (and its applied results). */
  async dropSession(place: TurnRepository, sessionId: string): Promise<void> {
    const listed = await this.exec(place.worktreeRoot, [
      'for-each-ref',
      '--format=%(refname)',
      `${refBase(sessionId)}/`,
    ])
    const refs = listed.stdout.split(/\r?\n/).filter(Boolean)
    if (refs.length === 0) return
    await this.exec(place.worktreeRoot, ['update-ref', '--stdin'], {
      stdin: `${refs.map((ref) => `delete ${ref}`).join('\n')}\n`,
    })
  }

  /**
   * Put the listed files back as they were before the turn, each only while
   * it still equals the turn's end (else `changed-since`). Renames undo both
   * paths together. Large files that were never stored cannot be undone.
   */
  async revert(
    place: TurnRepository,
    before: string,
    after: string,
    entries: readonly TurnFileEntry[],
  ): Promise<{ reverted: string[]; skipped: TurnRevertSkip[] }> {
    const repoPath = (path: string) => `${place.prefix}${path}`
    const pathsOf = (entry: TurnFileEntry) =>
      entry.oldPath === undefined
        ? [repoPath(entry.path)]
        : [repoPath(entry.path), repoPath(entry.oldPath)]
    const all = [...new Set(entries.flatMap(pathsOf))]
    const [beforeTree, afterTree] = await Promise.all([
      this.lsTree(place, before, all),
      this.lsTree(place, after, all),
    ])
    const current = await this.currentBlobs(place, all, afterTree)
    const reverted: string[] = []
    const skipped: TurnRevertSkip[] = []
    const restore: string[] = []
    const remove: string[] = []
    for (const entry of entries) {
      const paths = pathsOf(entry)
      const stored = paths.every(
        (path) =>
          afterTree.get(path)?.mode !== '160000' &&
          beforeTree.get(path)?.mode !== '160000',
      )
      if (entry.tooLarge || !stored) {
        skipped.push({ path: entry.path, reason: 'error' })
        continue
      }
      const unchanged = paths.every(
        (path) => (afterTree.get(path)?.oid ?? null) === current.get(path),
      )
      if (!unchanged) {
        skipped.push({ path: entry.path, reason: 'changed-since' })
        continue
      }
      for (const path of paths) {
        if (beforeTree.has(path)) restore.push(path)
        else if (current.get(path) !== null) remove.push(path)
      }
      reverted.push(entry.path)
    }
    for (const path of remove)
      rmSync(join(place.worktreeRoot, path), { force: true })
    if (restore.length > 0) await this.checkout(place, before, restore)
    return { reverted: reverted.sort(), skipped }
  }

  private async checkout(
    place: TurnRepository,
    commit: string,
    paths: string[],
  ): Promise<void> {
    mkdirSync(this.tempDir, { recursive: true, mode: 0o700 })
    const index = join(
      this.tempDir,
      `turn-restore-${randomBytes(8).toString('hex')}`,
    )
    const env = { GIT_INDEX_FILE: index }
    try {
      await this.exec(place.worktreeRoot, ['read-tree', commit], { env })
      await this.exec(
        place.worktreeRoot,
        ['checkout-index', '-f', '-z', '--stdin'],
        { env, stdin: paths.join('\0') },
      )
    } finally {
      rmSync(index, { force: true })
      rmSync(`${index}.lock`, { force: true })
    }
  }

  /** `path → {mode, oid}` of the given worktree paths in a commit. */
  private async lsTree(
    place: TurnRepository,
    commit: string,
    paths: string[],
  ): Promise<Map<string, { mode: string; oid: string }>> {
    const entries = new Map<string, { mode: string; oid: string }>()
    if (paths.length === 0) return entries
    const result = await this.exec(place.worktreeRoot, [
      'ls-tree',
      '-z',
      '--full-tree',
      commit,
      '--',
      ...paths,
    ])
    for (const record of result.stdout.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t')
      const [mode = '', , oid = ''] = record.slice(0, tab).split(' ')
      entries.set(record.slice(tab + 1), { mode, oid })
    }
    return entries
  }

  /** The blob each path would have now; null when it is absent. */
  private async currentBlobs(
    place: TurnRepository,
    paths: string[],
    afterTree: Map<string, { mode: string; oid: string }>,
  ): Promise<Map<string, string | null>> {
    const blobs = new Map<string, string | null>()
    const files: string[] = []
    for (const path of paths) {
      const absolute = join(place.worktreeRoot, path)
      let stat
      try {
        stat = lstatSync(absolute)
      } catch {
        blobs.set(path, null)
        continue
      }
      if (stat.isSymbolicLink()) {
        const target = await this.exec(
          place.worktreeRoot,
          ['hash-object', '--no-filters', '--stdin'],
          { stdin: readlinkSync(absolute) },
        )
        blobs.set(path, target.stdout.trim())
      } else if (stat.isFile()) files.push(path)
      // A directory where the turn left a file: it changed since.
      else blobs.set(path, `not-a-file:${afterTree.get(path)?.oid ?? ''}`)
    }
    if (files.length > 0) {
      const result = await this.exec(place.worktreeRoot, [
        'hash-object',
        '--',
        ...files,
      ])
      const oids = result.stdout.split(/\r?\n/).filter(Boolean)
      files.forEach((path, index) => blobs.set(path, oids[index] ?? null))
    }
    return blobs
  }

  /** The session's recorded refs grouped by turn. */
  private async sessionRefs(
    place: TurnRepository,
    sessionId: string,
  ): Promise<Map<number, string[]>> {
    const base = refBase(sessionId)
    const result = await this.exec(place.worktreeRoot, [
      'for-each-ref',
      '--format=%(refname)',
      `${base}/`,
    ])
    const turns = new Map<number, string[]>()
    for (const ref of result.stdout.split(/\r?\n/).filter(Boolean)) {
      const turn = Number(ref.slice(base.length + 1).split('/')[0])
      if (!Number.isInteger(turn)) continue
      turns.set(turn, [...(turns.get(turn) ?? []), ref])
    }
    return turns
  }

  /** A command that must finish before `deadline`. */
  private async timed(
    cwd: string,
    args: string[],
    deadline: number,
    options: {
      env?: Record<string, string>
      stdin?: string
      allowedExitCodes?: number[]
    } = {},
  ): Promise<GitCommandResult> {
    const remaining = deadline - this.now()
    if (remaining <= 0) throw new TurnSnapshotTimeout()
    try {
      return await this.exec(cwd, args, { ...options, timeoutMs: remaining })
    } catch (error) {
      if (this.now() >= deadline) throw new TurnSnapshotTimeout()
      throw error
    }
  }
}

/**
 * Where a session's change records live: its turns, and the undo record of
 * each subagent result applied in it (`applied/<run>`, AGT-06).
 */
export function turnRefBase(sessionId: string): string {
  const segment = sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || '_'
  return `refs/emperor/turns/${segment}`
}
const refBase = turnRefBase

function parseNameStatus(output: string): Array<{
  path: string
  oldPath?: string
  status: TurnFileStatus
}> {
  const tokens = output.split('\0')
  const entries: Array<{
    path: string
    oldPath?: string
    status: TurnFileStatus
  }> = []
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index] ?? ''
    if (!code) {
      index += 1
      continue
    }
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[index + 1] ?? ''
      const path = tokens[index + 2] ?? ''
      entries.push(
        letter === 'R'
          ? { path, oldPath, status: 'renamed' }
          : { path, status: 'added' },
      )
      index += 3
      continue
    }
    const path = tokens[index + 1] ?? ''
    entries.push({
      path,
      status:
        letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified',
    })
    index += 2
  }
  return entries
}

function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const counts = new Map<
    string,
    { additions: number; deletions: number; binary: boolean }
  >()
  const tokens = output.split('\0')
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index] ?? ''
    if (!token) {
      index += 1
      continue
    }
    const [added = '', deleted = '', path = ''] = token.split('\t')
    const count = {
      additions: Number(added) || 0,
      deletions: Number(deleted) || 0,
      binary: added === '-',
    }
    if (path) {
      counts.set(path, count)
      index += 1
    } else {
      // A rename: the old and new paths follow as their own fields.
      counts.set(tokens[index + 2] ?? '', count)
      index += 3
    }
  }
  return counts
}
