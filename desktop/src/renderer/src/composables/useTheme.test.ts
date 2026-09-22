import { describe, it, expect } from 'vitest'
import {
  isThemePreference,
  nextTheme,
  readStoredPreference,
  readStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
} from './useTheme'

function storageWith(value: string | null) {
  return {
    getItem: (key: string) => (key === THEME_STORAGE_KEY ? value : null),
  } as unknown as Storage
}

describe('useTheme helpers', () => {
  it('toggles between dark and light', () => {
    expect(nextTheme('dark')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
  })

  it('reads a valid stored theme', () => {
    expect(readStoredTheme(storageWith('light'))).toBe('light')
    expect(readStoredTheme(storageWith('dark'))).toBe('dark')
  })

  it('falls back to default (dark) for missing or invalid stored value', () => {
    expect(readStoredTheme(storageWith(null))).toBe('dark')
    expect(readStoredTheme(storageWith('paper'))).toBe('dark')
  })

  it('keeps `system` as a stored preference', () => {
    expect(isThemePreference('system')).toBe(true)
    expect(isThemePreference('paper')).toBe(false)
    expect(readStoredPreference(storageWith('system'))).toBe('system')
  })

  it('tolerates storage that throws or is missing', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(readStoredPreference(throwing)).toBe('dark')
    expect(readStoredPreference(null)).toBe('dark')
  })

  it('resolves `system` through the OS dark-mode flag', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})
