/**
 * Retention and storage usage (KRN-12; CORE-37, the Core part of SUB-18).
 *
 * `sweep()` runs at Core startup (in the background) and from 设置 › 高级 ›
 * 存储 「清理」. Each step is independent: a failure is reported in
 * `errors`, never thrown.
 * - sessions: trashed sessions past their 30 days go through the session
 *   service (subagent sessions, spill and turn snapshots with them, KRN-03).
 * - spill: a loose file under `<home>/spill` (shell output, a result saved
 *   without a session) or a `session-<hash>` folder no session owns — live or
 *   trashed, subagent sessions included — once nothing in it changed for 30
 *   days. A session's own folder goes when the session is purged.
 * - memory versions: snapshot files the index no longer lists.
 * - delegations: the isolated runtime home (HOME, CODEX_HOME, …) of a
 *   delegation that is idle or closed and whose conversation no longer
 *   exists; a home no delegation knows after 30 days; `dlg-probe-*` homes of
 *   older builds (each held a token copy) and temp leftovers (`indexes`,
 *   `snapshot-temp`, `artifact-temp`) after a day. Result worktrees and the
 *   `refs/emperor/delegations/*` refs in the user's repository are AGT-06's.
 * Removal never follows a symbolic link (a Codex home links the user's own
 * auth.json; the link goes, the file stays).
 *
 * `usage()` walks Emperor Home once and sums allocated bytes (`du`'s
 * measure: blocks, hard links once, links not followed) by category.
 */
import { lstat, readdir, rm } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { PROBE_RUNTIME_ID } from '../harness/delegation/runtime'
import { spillSessionDir } from '../harness/tools/spill'
import { SESSION_TRASH_DIR } from '../session-log/store'
import type { RuntimePaths } from '../runtime/paths'

const DAY = 24 * 60 * 60 * 1000
/** Orphan spill, and a delegation home nothing knows, after this. */
export const ORPHAN_MAX_AGE_MS = 30 * DAY
const TEMP_MAX_AGE_MS = DAY
const DELEGATION_TEMP_ROOTS = ['indexes', 'snapshot-temp', 'artifact-temp']
const TRASH_DIR = SESSION_TRASH_DIR

export const STORAGE_CATEGORIES = [
  'sessions',
  'attachments',
  'spill',
  'memoryVersions',
  'ledger',
  'delegations',
  'other',
] as const
export type StorageCategoryId = (typeof STORAGE_CATEGORIES)[number]

export interface StorageUsage {
  /** Emperor Home. */
  root: string
  /** Allocated bytes of everything under it. */
  total: number
  categories: Array<{ id: StorageCategoryId; bytes: number }>
  measuredAt: number
}

export interface RetentionTally {
  removed: number
  /** Allocated bytes of what was removed. */
  bytes: number
}

export interface RetentionReport {
  sessions: RetentionTally
  spill: RetentionTally
  memoryVersions: RetentionTally
  delegations: RetentionTally
  freedBytes: number
  errors: string[]
}

export interface RetentionDelegation {
  id: string
  rootSessionId: string
  availability: 'idle' | 'active' | 'needs_recovery' | 'closed'
}

export type RetentionPaths = Pick<
  RuntimePaths,
  | 'stateRoot'
  | 'sessionsRoot'
  | 'memoryRoot'
  | 'attachmentsRoot'
  | 'mediaRoot'
  | 'tokensFile'
  | 'delegationsRoot'
>

export interface RetentionOptions {
  paths: RetentionPaths
  memoryVersions?: { pruneOrphans(): RetentionTally }
  /** Every delegation the runtime knows (its runtime home is named by id). */
  delegations?: () => readonly RetentionDelegation[]
  sessions?: {
    /** Trashed sessions past their retention, about to be purged. */
    expired(): string[]
    /** Purge them; returns the ids purged. */
    purgeExpired(): Promise<string[]>
  }
  now?: () => number
}

interface Measured {
  bytes: number
  /** Latest mtime of the path and everything under it. */
  newest: number
}

export class RetentionService {
  private running: Promise<RetentionReport> | null = null

  constructor(private readonly options: RetentionOptions) {}

  private get spillRoot(): string {
    return join(this.options.paths.stateRoot, 'spill')
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** One sweep at a time: a second caller shares the one running. */
  sweep(): Promise<RetentionReport> {
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<RetentionReport> {
    const report: RetentionReport = {
      sessions: tally(),
      spill: tally(),
      memoryVersions: tally(),
      delegations: tally(),
      freedBytes: 0,
      errors: [],
    }
    const step = async (name: string, work: () => Promise<void>) => {
      try {
        await work()
      } catch (error) {
        report.errors.push(
          `${name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    // Sessions first: a purged session's spill folder is then an orphan.
    await step('sessions', () => this.purgeSessions(report.sessions))
    await step('spill', () => this.sweepSpill(report.spill))
    await step('memory versions', async () => {
      const swept = this.options.memoryVersions?.pruneOrphans()
      if (swept) {
        report.memoryVersions.removed += swept.removed
        report.memoryVersions.bytes += swept.bytes
      }
    })
    await step('delegations', () => this.sweepDelegations(report.delegations))
    report.freedBytes =
      report.sessions.bytes +
      report.spill.bytes +
      report.memoryVersions.bytes +
      report.delegations.bytes
    return report
  }

  private async purgeSessions(out: RetentionTally): Promise<void> {
    const sessions = this.options.sessions
    if (!sessions) return
    const trash = join(this.options.paths.sessionsRoot, TRASH_DIR)
    const sizes = new Map<string, number>()
    for (const id of sessions.expired())
      sizes.set(id, (await measure(join(trash, id))).bytes)
    for (const id of await sessions.purgeExpired()) {
      out.removed += 1
      out.bytes += sizes.get(id) ?? 0
    }
  }

  private async sweepSpill(out: RetentionTally): Promise<void> {
    const names = await entries(this.spillRoot)
    if (names.length === 0) return
    const owned = new Set(
      this.sessionIds().map((id) => basename(spillSessionDir('', id))),
    )
    const cutoff = this.now() - ORPHAN_MAX_AGE_MS
    for (const name of names)
      if (!owned.has(name))
        await removeIfOlder(join(this.spillRoot, name), cutoff, out)
  }

  private async sweepDelegations(out: RetentionTally): Promise<void> {
    const root = this.options.paths.delegationsRoot
    const now = this.now()
    const known = this.options.delegations
      ? new Map(this.options.delegations().map((item) => [item.id, item]))
      : null
    const runtime = join(root, 'runtime')
    for (const profile of await entries(runtime)) {
      for (const id of await entries(join(runtime, profile))) {
        const home = join(runtime, profile, id)
        if (id === PROBE_RUNTIME_ID) continue
        if (id.startsWith('dlg-probe-')) {
          await removeIfOlder(home, now - TEMP_MAX_AGE_MS, out)
          continue
        }
        if (known === null) continue
        const delegation = known.get(id)
        if (delegation === undefined)
          await removeIfOlder(home, now - ORPHAN_MAX_AGE_MS, out)
        else if (
          (delegation.availability === 'idle' ||
            delegation.availability === 'closed') &&
          !this.sessionExists(delegation.rootSessionId)
        )
          await removeIfOlder(home, Number.POSITIVE_INFINITY, out)
      }
    }
    for (const temp of DELEGATION_TEMP_ROOTS)
      for (const name of await entries(join(root, temp)))
        await removeIfOlder(join(root, temp, name), now - TEMP_MAX_AGE_MS, out)
  }

  /** Every session with a folder, live or trashed (subagent sessions too). */
  private sessionIds(): string[] {
    const root = this.options.paths.sessionsRoot
    return [...namesSync(root), ...namesSync(join(root, TRASH_DIR))]
  }

  private sessionExists(id: string): boolean {
    if (!id || id.startsWith('.') || /[\\/]/.test(id)) return false
    const root = this.options.paths.sessionsRoot
    return existsSync(join(root, id)) || existsSync(join(root, TRASH_DIR, id))
  }

  async usage(): Promise<StorageUsage> {
    const paths = this.options.paths
    const owners = new Map<string, StorageCategoryId>([
      [resolve(paths.sessionsRoot), 'sessions'],
      [resolve(paths.attachmentsRoot), 'attachments'],
      [resolve(paths.mediaRoot), 'attachments'],
      [resolve(this.spillRoot), 'spill'],
      [resolve(paths.memoryRoot, 'versions'), 'memoryVersions'],
      [resolve(dirname(paths.tokensFile)), 'ledger'],
      [resolve(paths.delegationsRoot), 'delegations'],
    ])
    const bytes = Object.fromEntries(
      STORAGE_CATEGORIES.map((id) => [id, 0]),
    ) as Record<StorageCategoryId, number>
    const seen = new Set<string>()
    const walk = async (path: string, inherited: StorageCategoryId) => {
      let st
      try {
        st = await lstat(path)
      } catch {
        return
      }
      if (!st.isDirectory() && st.nlink > 1) {
        const key = `${st.dev}:${st.ino}`
        if (seen.has(key)) return
        seen.add(key)
      }
      const category = owners.get(path) ?? inherited
      bytes[category] += st.blocks * 512
      if (!st.isDirectory()) return
      const names = await entries(path).catch(() => [])
      await Promise.all(names.map((name) => walk(join(path, name), category)))
    }
    const root = resolve(paths.stateRoot)
    await walk(root, 'other')
    const categories = STORAGE_CATEGORIES.map((id) => ({
      id,
      bytes: bytes[id],
    }))
    return {
      root,
      total: categories.reduce((sum, item) => sum + item.bytes, 0),
      categories,
      measuredAt: this.now(),
    }
  }
}

function tally(): RetentionTally {
  return { removed: 0, bytes: 0 }
}

/** A folder's entries; none when it does not exist. */
async function entries(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Visible subfolder names (no dot folders such as `.trash`). */
function namesSync(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

async function measure(path: string): Promise<Measured> {
  let st
  try {
    st = await lstat(path)
  } catch {
    return { bytes: 0, newest: 0 }
  }
  const out = { bytes: st.blocks * 512, newest: st.mtimeMs }
  if (!st.isDirectory()) return out
  for (const name of await entries(path).catch(() => [])) {
    const inner = await measure(join(path, name))
    out.bytes += inner.bytes
    out.newest = Math.max(out.newest, inner.newest)
  }
  return out
}

/** Remove `path` (never following a link) when nothing in it is newer than `cutoff`. */
async function removeIfOlder(
  path: string,
  cutoff: number,
  out: RetentionTally,
): Promise<void> {
  const measured = await measure(path)
  if (measured.newest >= cutoff) return
  await rm(path, { recursive: true, force: true })
  out.removed += 1
  out.bytes += measured.bytes
}
