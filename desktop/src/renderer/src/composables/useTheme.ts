import { ref } from 'vue'
import { applyTheme, DEFAULT_THEME, isTheme, type ThemeName } from '../theme/tokens'

export const THEME_STORAGE_KEY = 'emperor.theme'

export function nextTheme(current: ThemeName): ThemeName {
  return current === 'dark' ? 'light' : 'dark'
}

export function readStoredTheme(storage: Storage): ThemeName {
  const raw = storage.getItem(THEME_STORAGE_KEY)
  return isTheme(raw) ? raw : DEFAULT_THEME
}

const theme = ref<ThemeName>(DEFAULT_THEME)

// Singleton theme controller. Reads the persisted theme, applies it to the
// document root, and persists changes. Safe to call from multiple components.
export function useTheme() {
  function set(name: ThemeName) {
    theme.value = applyTheme(document, name)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme.value)
    } catch {
      // Persistence is best-effort; the in-memory theme still applies.
    }
  }

  function toggle() {
    set(nextTheme(theme.value))
  }

  function init() {
    set(readStoredTheme(localStorage))
  }

  return { theme, set, toggle, init }
}
