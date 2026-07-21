import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { THEMES, DEFAULT_THEME, isTheme, applyTheme } from './tokens'

function fakeDoc() {
  return { documentElement: { dataset: {} as Record<string, string> } }
}

function readThemeFile(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf-8')
}

function tokenKeys(css: string): string[] {
  return [...css.matchAll(/(--[\w-]+)(?=\s*:)/g)].map((m) => m[1])
}

describe('theme tokens', () => {
  it('defaults to dark and lists both themes', () => {
    expect(DEFAULT_THEME).toBe('dark')
    expect(THEMES).toEqual(['dark', 'light'])
  })

  it('validates theme names', () => {
    expect(isTheme('dark')).toBe(true)
    expect(isTheme('light')).toBe(true)
    expect(isTheme('paper')).toBe(false)
    expect(isTheme(undefined)).toBe(false)
  })

  it('applyTheme writes the theme to documentElement.dataset', () => {
    const doc = fakeDoc()
    const applied = applyTheme(doc as unknown as Document, 'light')
    expect(applied).toBe('light')
    expect(doc.documentElement.dataset.theme).toBe('light')
  })

  it('applyTheme falls back to the default for invalid names', () => {
    const doc = fakeDoc()
    const applied = applyTheme(doc as unknown as Document, 'paper' as never)
    expect(applied).toBe('dark')
    expect(doc.documentElement.dataset.theme).toBe('dark')
  })

  it('dark.css and light.css define identical token key sets', () => {
    const dark = tokenKeys(readThemeFile('dark.css'))
    const light = tokenKeys(readThemeFile('light.css'))
    expect(dark.length).toBeGreaterThan(0)
    expect([...dark].sort()).toEqual([...light].sort())
  })

  it('styles.css no longer carries :root token blocks', () => {
    const entry = readThemeFile('../styles.css')
    expect(entry).not.toContain(':root')
  })
})
