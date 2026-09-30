import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectRunning,
  discoverBrowsers,
  listProfiles,
  userDataDir,
} from './browser-discovery'

const roots: string[] = []
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'bi-home-'))
  roots.push(home)
  return home
}

/** Writes a Local State with the given `profile.info_cache`. */
function writeLocalState(
  dir: string,
  cache: Record<string, { name: string }>,
): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'Local State'),
    JSON.stringify({ profile: { info_cache: cache } }),
  )
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('userDataDir', () => {
  it('points at the macOS Application Support dirs', () => {
    expect(userDataDir('chrome', '/Users/x')).toBe(
      '/Users/x/Library/Application Support/Google/Chrome',
    )
    expect(userDataDir('edge', '/Users/x')).toBe(
      '/Users/x/Library/Application Support/Microsoft Edge',
    )
  })
})

describe('listProfiles', () => {
  it('reads directory + display name from profile.info_cache', () => {
    const home = makeHome()
    const dir = userDataDir('chrome', home)
    writeLocalState(dir, {
      Default: { name: 'Person 1' },
      'Profile 1': { name: 'Work' },
    })
    expect(listProfiles(dir)).toEqual([
      { dir: 'Default', name: 'Person 1' },
      { dir: 'Profile 1', name: 'Work' },
    ])
  })

  it('returns [] when Local State is missing', () => {
    const home = makeHome()
    expect(listProfiles(userDataDir('chrome', home))).toEqual([])
  })

  it('returns [] when Local State is corrupt (no throw)', () => {
    const home = makeHome()
    const dir = userDataDir('chrome', home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Local State'), '{ not json')
    expect(listProfiles(dir)).toEqual([])
  })
})

describe('discoverBrowsers', () => {
  it('reports installed browsers with profiles, others as not installed', () => {
    const home = makeHome()
    writeLocalState(userDataDir('chrome', home), {
      Default: { name: 'Person 1' },
    })
    const found = discoverBrowsers({ homeDir: home })
    const chrome = found.find((b) => b.browser === 'chrome')!
    const edge = found.find((b) => b.browser === 'edge')!
    expect(chrome.installed).toBe(true)
    expect(chrome.name).toBe('Google Chrome')
    expect(chrome.profiles).toEqual([{ dir: 'Default', name: 'Person 1' }])
    expect(edge.installed).toBe(false)
    expect(edge.profiles).toEqual([])
  })
})

describe('detectRunning', () => {
  it('reports no-lock when SingletonLock is absent', () => {
    const home = makeHome()
    const dir = userDataDir('chrome', home)
    mkdirSync(dir, { recursive: true })
    expect(detectRunning({ userDataDir: dir })).toEqual({
      running: false,
      reason: 'no-lock',
    })
  })

  it('reports running when the lock names a live pid', () => {
    const home = makeHome()
    const dir = userDataDir('chrome', home)
    mkdirSync(dir, { recursive: true })
    symlinkSync(`${hostname()}-4321`, join(dir, 'SingletonLock'))
    const kill = (pid: number) => {
      expect(pid).toBe(4321)
      // alive: process.kill(pid, 0) returns without throwing
    }
    expect(detectRunning({ userDataDir: dir, kill })).toEqual({
      running: true,
      reason: 'running',
    })
  })

  it('reports stale-lock when the pid is gone (crash residue)', () => {
    const home = makeHome()
    const dir = userDataDir('chrome', home)
    mkdirSync(dir, { recursive: true })
    symlinkSync(`${hostname()}-999999`, join(dir, 'SingletonLock'))
    const kill = () => {
      const err = new Error('no such process') as NodeJS.ErrnoException
      err.code = 'ESRCH'
      throw err
    }
    expect(detectRunning({ userDataDir: dir, kill })).toEqual({
      running: false,
      reason: 'stale-lock',
    })
  })
})
