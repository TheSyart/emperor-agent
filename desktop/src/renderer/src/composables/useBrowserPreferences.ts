import type { BrowserPreferences } from '@emperor/core/runtime-contract'
import { readonly, ref } from 'vue'
import { hasCoreBridge, invokeCore, onCoreEvent } from '../api/backend'

/**
 * The user's own built-in browser settings (设置 › 浏览器, settings.json ›
 * `browser`), shared by the settings section and BrowserPane (the address
 * bar, the history button; downloads follow them in main). One Core read on
 * first use;
 * `browser_preferences_changed` host events keep every reader current,
 * whichever window changed them.
 */
export const DEFAULT_BROWSER_PREFERENCES: Readonly<BrowserPreferences> = {
  linkTarget: 'system',
  localTarget: 'builtin',
  showFullUrl: true,
  history: true,
  downloadDirectory: null,
  askWhereToSave: false,
}

const preferences = ref<BrowserPreferences>({ ...DEFAULT_BROWSER_PREFERENCES })
let started = false

export function isBrowserPreferences(
  value: unknown,
): value is BrowserPreferences {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return (
    (data.linkTarget === 'system' || data.linkTarget === 'builtin') &&
    (data.localTarget === 'builtin' || data.localTarget === 'system') &&
    typeof data.showFullUrl === 'boolean' &&
    typeof data.history === 'boolean' &&
    (data.downloadDirectory === null ||
      typeof data.downloadDirectory === 'string') &&
    typeof data.askWhereToSave === 'boolean'
  )
}

function start(): void {
  if (started || !hasCoreBridge()) return
  started = true
  onCoreEvent((event) => {
    const data = event as { event?: unknown; preferences?: unknown } | null
    if (data?.event !== 'browser_preferences_changed') return
    if (isBrowserPreferences(data.preferences))
      preferences.value = { ...data.preferences }
  })
  void invokeCore('browser.preferences')
    .then((value) => {
      if (isBrowserPreferences(value)) preferences.value = { ...value }
    })
    .catch(() => {
      // Defaults stand in; a settings failure must not block chat.
    })
}

export function useBrowserPreferences() {
  start()
  return {
    preferences: readonly(preferences),
    /** Save a change; Core answers with the stored settings. */
    async update(change: Partial<BrowserPreferences>): Promise<void> {
      const saved = await invokeCore('browser.setPreferences', change)
      if (isBrowserPreferences(saved)) preferences.value = { ...saved }
    },
  }
}

/** Tests only: forget the loaded settings and the subscription. */
export function resetBrowserPreferencesForTest(): void {
  started = false
  preferences.value = { ...DEFAULT_BROWSER_PREFERENCES }
}
