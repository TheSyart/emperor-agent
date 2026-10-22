/**
 * One Codex login shared with the user's own Codex (AGT-03, SUB-6).
 *
 * The isolated CODEX_HOME must not hold a forked copy of the user's refresh
 * token: a refresh in the isolated process rotates the token on the server and
 * would leave the user's own Codex with a dead copy (logged out). Instead the
 * isolated `auth.json` is a symlink to the user's file, so a refresh lands in
 * the one place every Codex reads.
 *
 * - Codex 0.153 writes auth.json in place and follows the link (checked with a
 *   hermetic `codex login --with-api-key` against a fake CODEX_HOME). The
 *   Seatbelt boundary grants writes to exactly that one file.
 * - A future Codex might write a temporary file and rename it over the link.
 *   The lease below notices that within seconds and at the end of the run,
 *   copies a successor token back to the user's file under the lock, and
 *   restores the link.
 * - An exclusive lock (`<user auth.json>.lock`) is held for the lifetime of an
 *   isolated Codex process, so at most one isolated process can refresh at a
 *   time. The user's own Codex does not know this lock; that is the same as
 *   running Codex in two terminals.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs'
import { durableReplaceSync } from '../../store/persistence'
import { DelegationError, type CodexAuthLink } from './types'

export type { CodexAuthLink } from './types'

/**
 * - `linked`: the isolated file already is the link.
 * - `relinked`: the link was (re)created; no token was involved.
 * - `copied-back`: a newer token from a replaced link reached the user file.
 * - `discarded`: a replaced or forked copy was not a successor and was dropped.
 * - `deferred` (prepare only): an old forked copy waits for the locked lease.
 */
export type CodexAuthOutcome =
  'linked' | 'relinked' | 'copied-back' | 'discarded'

/** App-server flags: never the Keychain; credentials stay in auth.json. */
export const CODEX_FILE_CREDENTIALS = [
  '-c',
  'cli_auth_credentials_store="file"',
] as const

const MAX_AUTH_BYTES = 1024 * 1024
/** Longer than the longest allowed run (120 min): a lock this old is stale. */
const STALE_LOCK_MS = 3 * 60 * 60_000

export function codexAuthLockPath(link: CodexAuthLink): string {
  return link.source + '.lock'
}

/** The real path Seatbelt checks when Codex writes through the link. */
export function codexAuthWritableFile(link: CodexAuthLink): string {
  try {
    return realpathSync(link.source)
  } catch {
    return link.source
  }
}

interface AuthFile {
  raw: string
  refresh?: string
  account?: string
  lastRefresh?: number
}

function readAuth(path: string): AuthFile | undefined {
  try {
    if (statSync(path).size > MAX_AUTH_BYTES) return undefined
    const raw = readFileSync(path, 'utf8')
    const value = JSON.parse(raw) as Record<string, unknown>
    const tokens = (value.tokens ?? {}) as Record<string, unknown>
    const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    const at =
      typeof value.last_refresh === 'string'
        ? Date.parse(value.last_refresh)
        : NaN
    return {
      raw,
      refresh: text(tokens.refresh_token),
      account: text(tokens.account_id),
      ...(Number.isFinite(at) ? { lastRefresh: at } : {}),
    }
  } catch {
    return undefined
  }
}

const digest = (value: string | undefined) =>
  value === undefined
    ? undefined
    : createHash('sha256').update(value).digest('hex')

function lstat(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

function isOurLink(link: CodexAuthLink): boolean {
  const entry = lstat(link.isolated)
  if (!entry?.isSymbolicLink()) return false
  try {
    return readlinkSync(link.isolated) === link.source
  } catch {
    return false
  }
}

function placeLink(link: CodexAuthLink): void {
  const entry = lstat(link.isolated)
  if (entry?.isDirectory())
    rmSync(link.isolated, { recursive: true, force: true })
  const temporary = `${link.isolated}.link-${process.pid}-${randomUUID()}`
  symlinkSync(link.source, temporary)
  try {
    // rename replaces a regular file or a foreign link without following it.
    renameSync(temporary, link.isolated)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Prepare-time linking, without the lock: never reads or moves a token. A
 * regular file (a copy forked by an older build, possibly refreshed since) is
 * left for {@link acquireCodexAuth}, which settles it under the lock.
 */
export function linkCodexAuth(
  link: CodexAuthLink,
): CodexAuthOutcome | 'deferred' {
  if (isOurLink(link)) return 'linked'
  if (lstat(link.isolated)?.isFile()) return 'deferred'
  placeLink(link)
  return 'relinked'
}

/** API key or custom-provider mode: the isolated home holds no auth.json. */
export function removeCodexAuth(isolated: string): void {
  if (lstat(isolated)?.isDirectory()) return
  rmSync(isolated, { force: true })
}

/**
 * Under the lock: restore the link, first copying a successor token back.
 * `baseline` is the digest of the user's refresh token when the isolated
 * process started; without one (an old forked copy), the copy must be newer
 * by `last_refresh`.
 */
function settle(
  link: CodexAuthLink,
  baseline: string | undefined,
): { outcome: CodexAuthOutcome; baseline?: string } {
  if (isOurLink(link)) return { outcome: 'linked' }
  const entry = lstat(link.isolated)
  let outcome: CodexAuthOutcome = 'relinked',
    next: string | undefined
  if (entry?.isFile()) {
    const mine = readAuth(link.isolated),
      theirs = readAuth(link.source)
    const successor =
      !!mine?.refresh &&
      !!mine.account &&
      !!theirs?.refresh &&
      theirs.account === mine.account &&
      mine.refresh !== theirs.refresh &&
      (baseline !== undefined
        ? digest(theirs.refresh) === baseline
        : mine.lastRefresh !== undefined &&
          theirs.lastRefresh !== undefined &&
          mine.lastRefresh > theirs.lastRefresh)
    if (successor) {
      durableReplaceSync(codexAuthWritableFile(link), mine.raw, {
        fileMode: 0o600,
      })
      outcome = 'copied-back'
      next = digest(mine.refresh)
    } else outcome = 'discarded'
  }
  placeLink(link)
  return { outcome, ...(next ? { baseline: next } : {}) }
}

export interface CodexAuthLease {
  readonly link: CodexAuthLink
  /** Restore the link now if Codex replaced it (also runs periodically). */
  check(): CodexAuthOutcome
  /** Final check, then release the lock. Idempotent. */
  release(): Promise<void>
}

const held = new Set<string>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** One attempt to take the file lock; true when this process now holds it. */
function tryLock(path: string, token: string): boolean {
  if (held.has(path)) return false
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new DelegationError(
          'AUTH_LOCK_FAILED',
          'the Codex login lock could not be created',
        )
      let stale = false
      try {
        const stat = statSync(path),
          age = Date.now() - stat.mtimeMs
        let owner: { pid?: unknown } = {}
        try {
          owner = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }
        } catch {
          // Half-written by a holder that crashed while creating it.
          stale = age > 10_000
        }
        if (typeof owner.pid === 'number')
          stale =
            age > STALE_LOCK_MS ||
            // Not held by this process now: left by an earlier lease of ours.
            owner.pid === process.pid ||
            !alive(owner.pid)
      } catch {
        // Removed between open and stat: try again.
        continue
      }
      if (!stale) return false
      try {
        unlinkSync(path)
      } catch {
        /* Another waiter reclaimed it first. */
      }
      continue
    }
    try {
      writeSync(
        fd,
        JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }) +
          '\n',
      )
    } finally {
      closeSync(fd)
    }
    held.add(path)
    return true
  }
  return false
}

function unlock(path: string, token: string): void {
  held.delete(path)
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown }
    if (owner.token === token) unlinkSync(path)
  } catch {
    /* Already gone or reclaimed. */
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    function abort() {
      clearTimeout(timer)
      reject(
        new DelegationError('ABORTED', 'stopped while waiting for Codex login'),
      )
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Take the Codex login lock for one isolated process, settle any forked or
 * replaced copy, and watch the link until release. With `wait: false`,
 * returns undefined when another isolated process holds the lock.
 */
export async function acquireCodexAuth(
  link: CodexAuthLink,
  options: {
    signal?: AbortSignal
    wait?: boolean
    pollMs?: number
    checkMs?: number
  } = {},
): Promise<CodexAuthLease | undefined> {
  const path = codexAuthLockPath(link),
    token = randomUUID()
  for (;;) {
    if (options.signal?.aborted)
      throw new DelegationError(
        'ABORTED',
        'stopped while waiting for Codex login',
      )
    if (tryLock(path, token)) break
    if (options.wait === false) return undefined
    await sleep(options.pollMs ?? 250, options.signal)
  }
  let baseline: string | undefined,
    released: Promise<void> | undefined,
    touched = Date.now()
  try {
    const first = settle(link, undefined)
    baseline = first.baseline ?? digest(readAuth(link.source)?.refresh)
  } catch (error) {
    unlock(path, token)
    throw error
  }
  const check = (): CodexAuthOutcome => {
    const result = settle(link, baseline)
    if (result.baseline) baseline = result.baseline
    else if (result.outcome === 'linked')
      // Through the intact link the user file is the current truth, whether
      // our process or the user's own Codex wrote it.
      baseline = digest(readAuth(link.source)?.refresh)
    if (Date.now() - touched > 60_000) {
      touched = Date.now()
      try {
        utimesSync(path, new Date(), new Date())
      } catch {
        /* The age check is only a fallback for dead holders. */
      }
    }
    return result.outcome
  }
  const timer = setInterval(() => {
    try {
      check()
    } catch {
      /* Retried on the next tick and at release. */
    }
  }, options.checkMs ?? 2000)
  timer.unref()
  return {
    link,
    check,
    release() {
      released ??= (async () => {
        clearInterval(timer)
        try {
          check()
        } finally {
          unlock(path, token)
        }
      })()
      return released
    },
  }
}
