/**
 * Finds Chrome/Edge and their profiles on this machine, and decides whether a
 * browser is still running (import must not touch a live profile). Discovery
 * reads Local State's `profile.info_cache`; running-detection reads the
 * `SingletonLock` symlink (`<host>-<pid>`) and confirms the pid is alive, so a
 * lock left behind by a crash reads as stale rather than running. The `readlink`
 * and `kill` seams are injectable; nothing here can raise a permission prompt.
 */
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  BrowserId,
  BrowserProfile,
  DiscoveredBrowser,
  RunningStatus,
} from './types'

/** Product name and user-data dir under `~/Library/Application Support`. */
const BROWSERS: Record<BrowserId, { name: string; support: string }> = {
  chrome: { name: 'Google Chrome', support: 'Google/Chrome' },
  edge: { name: 'Microsoft Edge', support: 'Microsoft Edge' },
}

const ORDER: readonly BrowserId[] = ['chrome', 'edge']

/** The macOS user-data directory for a browser under a given home. */
export function userDataDir(browser: BrowserId, homeDir: string): string {
  return join(
    homeDir,
    'Library',
    'Application Support',
    BROWSERS[browser].support,
  )
}

/**
 * Profiles from Local State's `profile.info_cache`, in the order the file
 * lists them. A missing or unparseable Local State yields `[]` (with the
 * reason surfaced to the caller as an empty list, never a throw).
 */
export function listProfiles(dir: string): BrowserProfile[] {
  const localState = join(dir, 'Local State')
  if (!existsSync(localState)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(localState, 'utf8'))
  } catch {
    return []
  }
  const cache = (parsed as { profile?: { info_cache?: unknown } })?.profile
    ?.info_cache
  if (!cache || typeof cache !== 'object') return []
  const profiles: BrowserProfile[] = []
  for (const [profileDir, info] of Object.entries(
    cache as Record<string, unknown>,
  )) {
    const name = (info as { name?: unknown })?.name
    profiles.push({
      dir: profileDir,
      name: typeof name === 'string' && name ? name : profileDir,
    })
  }
  return profiles
}

/** Chrome and Edge on this machine, each with installed-state and profiles. */
export function discoverBrowsers(
  deps: { homeDir?: string } = {},
): DiscoveredBrowser[] {
  const homeDir = deps.homeDir ?? homedir()
  return ORDER.map((browser) => {
    const dir = userDataDir(browser, homeDir)
    const installed = existsSync(dir)
    return {
      browser,
      name: BROWSERS[browser].name,
      userDataDir: dir,
      installed,
      profiles: installed ? listProfiles(dir) : [],
    }
  })
}

/** Parses the pid out of a `SingletonLock` target (`<host>-<pid>`). */
function lockPid(target: string): number | undefined {
  const dash = target.lastIndexOf('-')
  if (dash < 0) return undefined
  const pid = Number(target.slice(dash + 1))
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Whether the browser is running, judged from `SingletonLock`. No lock → not
 * running. A lock whose pid is gone (ESRCH) → stale (crash residue), so import
 * may proceed. A live pid (kill succeeds, or EPERM) → running. Anything else
 * is treated conservatively as running so import never touches a live profile.
 */
export function detectRunning(opts: {
  userDataDir: string
  readlink?: (path: string) => string
  kill?: (pid: number) => void
}): RunningStatus {
  const readlink = opts.readlink ?? readlinkSync
  const kill = opts.kill ?? ((pid: number) => void process.kill(pid, 0))
  let target: string
  try {
    target = readlink(join(opts.userDataDir, 'SingletonLock'))
  } catch {
    return { running: false, reason: 'no-lock' }
  }
  const pid = lockPid(target)
  if (pid === undefined) return { running: true, reason: 'unknown' }
  try {
    kill(pid)
    return { running: true, reason: 'running' }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH')
      return { running: false, reason: 'stale-lock' }
    // EPERM means the process exists but is not ours: still running.
    return { running: true, reason: 'running' }
  }
}
