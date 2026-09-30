/**
 * Main's synchronous copy of 设置 › 浏览器 (Core `browser.preferences`).
 * `will-download` has to pick a save path inside its callback, so it cannot
 * wait for Core: this copy is read once at startup and then kept current by
 * the `browser_preferences_changed` host events (CoreEventBridge.listen).
 * Link routing and the temporary history read it too. Values are repaired
 * the way Core stores them (`normalizeBrowserPreferences`).
 */

import {
  defaultBrowserPreferences,
  normalizeBrowserPreferences,
} from '@emperor/core/host-capabilities'
import type { BrowserPreferences } from '@emperor/core/runtime-contract'

export class BrowserPreferencesCache {
  private value: BrowserPreferences = defaultBrowserPreferences()
  private changes = 0

  /** The defaults until Core answered. */
  get current(): Readonly<BrowserPreferences> {
    return this.value
  }

  /** Read Core once; a change that arrives meanwhile wins over the read. */
  async load(read: () => Promise<unknown>): Promise<void> {
    const seen = this.changes
    let value: unknown
    try {
      value = await read()
    } catch {
      return
    }
    if (this.changes !== seen || !isRecord(value)) return
    this.value = normalizeBrowserPreferences(value)
  }

  /** A Core host event: only `browser_preferences_changed` counts. */
  observe(event: Record<string, unknown>): void {
    if (event.event !== 'browser_preferences_changed') return
    if (!isRecord(event.preferences)) return
    this.value = normalizeBrowserPreferences(event.preferences)
    this.changes += 1
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
