/**
 * Where the Emperor extension is loaded in Chrome and Edge, read from each
 * profile's preference files: `extensions.settings.<id>` (in Secure
 * Preferences on macOS) gives the folder an unpacked extension was loaded
 * from (`path`) and why it is off (`disable_reasons`, or the older
 * `state`); `extensions.ui.developer_mode` is in Preferences. Chrome
 * writes these files about 10 s after a change, so the connection to
 * Emperor stays the main signal. Read only; files are re-parsed only when
 * their size or time changes.
 */
import * as nodeFs from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import type { DiscoveredBrowser } from '../browser-import/types'

export type ExtensionLoadState = 'none' | 'loaded' | 'disabled'

export interface ExtensionDetection {
  readonly browser: 'chrome' | 'edge'
  /** Google Chrome / Microsoft Edge. */
  readonly name: string
  /** The browser has run on this Mac (its user-data folder exists). */
  readonly present: boolean
  /** Loaded from Emperor's folder in at least one profile (on or off). */
  readonly extension: ExtensionLoadState
  /** Loaded from another folder (e.g. a checkout's desktop/extension). */
  readonly elsewhere: string | null
  /** 开发者模式 is on in at least one profile. */
  readonly developerMode: boolean
}

export type DetectFs = Pick<typeof nodeFs, 'stat' | 'readFile' | 'realpath'>

/** A real preference file is a few MB at most; never parse an unbounded one. */
const PREFERENCES_MAX_BYTES = 32 * 1024 * 1024
const FILES = ['Secure Preferences', 'Preferences'] as const

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function at(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) current = record(current)?.[key]
  return current
}

function disabled(entry: Record<string, unknown>): boolean {
  const reasons = entry.disable_reasons
  if (Array.isArray(reasons)) return reasons.length > 0
  if (typeof reasons === 'number') return reasons !== 0
  return entry.state === 0
}

export function createExtensionDetector(options: {
  extensionId: string
  /** Emperor's folder (`<stateRoot>/browser-extension`). */
  folder: string
  /** Chrome and Edge with their profiles (browser-discovery.ts). */
  discover: () => readonly DiscoveredBrowser[]
  fs?: DetectFs
}): () => Promise<ExtensionDetection[]> {
  const fs = options.fs ?? nodeFs
  const cache = new Map<string, { key: string; value: unknown }>()

  async function readJson(path: string): Promise<unknown> {
    try {
      const info = await fs.stat(path)
      if (!info.isFile() || info.size > PREFERENCES_MAX_BYTES) return null
      const key = `${info.size}:${info.mtimeMs}`
      const hit = cache.get(path)
      if (hit?.key === key) return hit.value
      const value: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
      cache.set(path, { key, value })
      return value
    } catch {
      return null
    }
  }

  async function real(path: string): Promise<string> {
    try {
      return await fs.realpath(path)
    } catch {
      return normalize(path)
    }
  }

  return async () => {
    const ours = await real(options.folder)
    const results: ExtensionDetection[] = []
    for (const browser of options.discover()) {
      let loaded = false
      let off = false
      let elsewhere: string | null = null
      let developerMode = false
      for (const profile of browser.installed ? browser.profiles : []) {
        // Profile folders are plain names (Default, Profile 1).
        if (!/^[\w .-]{1,64}$/.test(profile.dir) || profile.dir.includes('..'))
          continue
        const files = await Promise.all(
          FILES.map((file) =>
            readJson(join(browser.userDataDir, profile.dir, file)),
          ),
        )
        if (
          files.some(
            (prefs) => at(prefs, 'extensions', 'ui', 'developer_mode') === true,
          )
        )
          developerMode = true
        const entry = files
          .map((prefs) =>
            record(at(prefs, 'extensions', 'settings', options.extensionId)),
          )
          .find((item) => item !== null)
        // state 2: an uninstalled external extension Chrome still lists.
        if (!entry || entry.state === 2) continue
        const path = typeof entry.path === 'string' ? entry.path : ''
        if (path && isAbsolute(path) && (await real(path)) === ours) {
          if (disabled(entry)) off = true
          else loaded = true
        } else elsewhere ??= path && isAbsolute(path) ? path : ''
      }
      results.push({
        browser: browser.browser,
        name: browser.name,
        present: browser.installed,
        extension: loaded ? 'loaded' : off ? 'disabled' : 'none',
        elsewhere: elsewhere === '' ? null : elsewhere,
        developerMode,
      })
    }
    return results
  }
}
