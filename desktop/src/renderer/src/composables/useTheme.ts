import { ref } from 'vue'
import {
  applyTheme,
  DEFAULT_THEME,
  isTheme,
  type ThemeName,
} from '../theme/tokens'

export const THEME_STORAGE_KEY = 'emperor.theme'

/**
 * What the user picked: an explicit theme or `system` (follow the OS
 * `prefers-color-scheme`). The document always carries a resolved
 * `ThemeName` in `data-theme`; `system` only lives in storage and here.
 */
export type ThemePreference = ThemeName | 'system'
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || isTheme(value)
}

export function nextTheme(current: ThemeName): ThemeName {
  return current === 'dark' ? 'light' : 'dark'
}

/** Stored preference; unreadable storage or junk falls back to the default. */
export function readStoredPreference(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): ThemePreference {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY)
    return isThemePreference(raw) ? raw : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/** Stored theme resolved to a concrete name (`system` → the OS theme). */
export function readStoredTheme(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): ThemeName {
  return resolveTheme(readStoredPreference(storage), systemPrefersDark())
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ThemeName {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

function systemQuery(): MediaQueryList | null {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return null
    return window.matchMedia(SYSTEM_DARK_QUERY)
  } catch {
    return null
  }
}

/** OS dark-mode flag; without matchMedia the default theme decides. */
export function systemPrefersDark(): boolean {
  const query = systemQuery()
  return query ? query.matches : DEFAULT_THEME === 'dark'
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const preference = ref<ThemePreference>(DEFAULT_THEME)
const theme = ref<ThemeName>(DEFAULT_THEME)
let systemListener: ((event: MediaQueryListEvent) => void) | null = null

function apply() {
  const resolved = resolveTheme(preference.value, systemPrefersDark())
  theme.value =
    typeof document === 'undefined' ? resolved : applyTheme(document, resolved)
}

function watchSystem() {
  if (systemListener) return
  const query = systemQuery()
  if (!query) return
  systemListener = () => {
    if (preference.value === 'system') apply()
  }
  try {
    query.addEventListener('change', systemListener)
  } catch {
    systemListener = null
  }
}

/**
 * Boot-time theme application (main.ts): read the stored preference with
 * storage failures tolerated, apply the resolved theme and start following
 * OS changes while the preference is `system`. Idempotent.
 */
export function initTheme(): ThemeName {
  preference.value = readStoredPreference(browserStorage())
  apply()
  watchSystem()
  return theme.value
}

// Singleton theme controller. `theme` is the resolved theme on the document,
// `preference` what the user chose (may be `system`). Safe to call from
// multiple components.
export function useTheme() {
  function set(name: ThemePreference) {
    preference.value = isThemePreference(name) ? name : DEFAULT_THEME
    apply()
    watchSystem()
    try {
      browserStorage()?.setItem(THEME_STORAGE_KEY, preference.value)
    } catch {
      // Persistence is best-effort; the in-memory theme still applies.
    }
  }

  /** Flip the visible theme; this pins an explicit preference. */
  function toggle() {
    set(nextTheme(theme.value))
  }

  function init() {
    initTheme()
  }

  return { theme, preference, set, toggle, init }
}
