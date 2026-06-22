import { describe, it, expect } from 'vitest'
import { nextTheme, readStoredTheme, THEME_STORAGE_KEY } from './useTheme'

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
})
