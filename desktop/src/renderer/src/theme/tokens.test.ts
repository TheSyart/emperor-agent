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

  const REQUIRED_KEYS = [
    '--radius-xs',
    '--radius-md',
    '--radius-lg',
    '--radius-xl',
    '--shadow-color',
    '--shadow-sm',
    '--shadow-md',
    '--shadow-lg',
    '--font-size-2xs',
    '--font-size-xs',
    '--font-size-sm',
    '--font-size-md',
    '--font-size-lg',
    '--space-1',
    '--space-2',
    '--space-3',
    '--space-4',
    '--space-5',
    '--space-6',
    '--tone-cyan',
    '--tone-violet',
    '--tone-blue',
    /* grok 式文本层级(unitless alpha,驱动 fg/二级/三级文字) */
    '--text-primary',
    '--text-secondary',
    '--text-tertiary',
  ]

  it.each(['dark.css', 'light.css'])(
    '%s defines the full token ladder',
    (f) => {
      const keys = tokenKeys(readThemeFile(f))
      for (const required of REQUIRED_KEYS) {
        expect(keys).toContain(required)
      }
    },
  )

  it.each(['dark.css', 'light.css'])(
    '%s stores RGB colors as space-separated triplets',
    (f) => {
      const css = readThemeFile(f)
      const colorKeys = [
        '--bg',
        '--bg-elevated',
        '--bg-inset',
        '--fg',
        '--border',
        '--border-strong',
        '--accent',
        '--accent-fg',
        '--brand',
        '--danger',
        '--warn',
        '--ok',
        '--shadow-color',
        '--tone-cyan',
        '--tone-violet',
        '--tone-blue',
      ]
      for (const key of colorKeys) {
        const re = new RegExp(`${key}:\\s*(\\d+ \\d+ \\d+)\\s*;`)
        expect(css, `${key} must be an RGB triplet`).toMatch(re)
      }
    },
  )

  it('applies the unified canonical palette (codex-v2 values folded in)', () => {
    const dark = readThemeFile('dark.css')
    const light = readThemeFile('light.css')
    // codex-v2's :root block was the de-facto rendered palette; these lock it in
    // as the single source of truth after the token dedupe.
    expect(dark).toContain('--bg: 12 12 14;')
    expect(dark).toContain('--border-strong: 62 62 70;')
    expect(dark).toContain('--accent: 99 153 255;')
    expect(dark).toContain('--brand: 203 158 72;')
    expect(dark).toContain('--warn: 240 186 60;')
    expect(light).toContain('--bg: 252 252 253;')
    expect(light).toContain('--text-secondary: 0.55;')
    expect(light).toContain('--brand: 155 111 35;')
  })
})
