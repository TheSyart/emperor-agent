import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { THEMES, DEFAULT_THEME, isTheme, applyTheme } from './tokens'
import LEGACY_KEYS from './legacy-keys.json'

/**
 * DS-01: three token layers.
 *   L1 primitives.css      theme-agnostic raw values
 *   L2 semantic.*.css      what colours mean (dark default, light)
 *   L3 components.css      tokens owned by one component family
 *   legacy-aliases.css     pre-0.2 names → L2 (deleted by DS-02)
 */

function fakeDoc() {
  return { documentElement: { dataset: {} as Record<string, string> } }
}

function readThemeFile(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf-8')
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of stripComments(css).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out.set(m[1]!, m[2]!.replace(/\s+/g, ' ').trim())
  return out
}

function references(value: string): string[] {
  return [...value.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!)
}

const LAYER_FILES = [
  'primitives.css',
  'semantic.dark.css',
  'semantic.light.css',
  'components.css',
  'legacy-aliases.css',
]

describe('theme registry', () => {
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
})

describe('token layers (DS-01)', () => {
  const primitives = declarations(readThemeFile('primitives.css'))
  const dark = declarations(readThemeFile('semantic.dark.css'))
  const light = declarations(readThemeFile('semantic.light.css'))
  const components = declarations(readThemeFile('components.css'))
  const legacy = declarations(readThemeFile('legacy-aliases.css'))

  it('dark and light semantic tokens have the same key set', () => {
    expect(dark.size).toBeGreaterThan(40)
    expect([...dark.keys()].sort()).toEqual([...light.keys()].sort())
  })

  it.each(LAYER_FILES)(
    '%s parses as whole rules (no stray comment terminators)',
    (file) => {
      // A `*/` inside prose closes a comment early and silently drops rules.
      const css = stripComments(readThemeFile(file))
      const opens = css.match(/\{/g)?.length ?? 0
      const closes = css.match(/\}/g)?.length ?? 0
      expect(opens).toBeGreaterThan(0)
      expect(opens).toBe(closes)
      expect(css).not.toContain('*/')
    },
  )

  it('styles.css carries no :root token blocks', () => {
    expect(readThemeFile('../styles.css')).not.toContain(':root')
  })

  it('accounts for every pre-0.2 token name', () => {
    const defined = new Set([
      ...primitives.keys(),
      ...dark.keys(),
      ...components.keys(),
      ...legacy.keys(),
    ])
    const missing = (LEGACY_KEYS as string[]).filter((key) => !defined.has(key))
    expect(missing).toEqual([])
  })

  it('defines every token name in exactly one layer', () => {
    const owners = new Map<string, string[]>()
    for (const [file, table] of [
      ['primitives', primitives],
      ['semantic', dark],
      ['components', components],
      ['legacy', legacy],
    ] as const)
      for (const key of table.keys())
        owners.set(key, [...(owners.get(key) ?? []), file])
    const duplicated = [...owners].filter(([, files]) => files.length > 1)
    expect(duplicated).toEqual([])
  })

  it('keeps primitives raw and theme-agnostic', () => {
    const css = stripComments(readThemeFile('primitives.css'))
    expect(css).not.toContain('data-theme')
    for (const [key, value] of primitives)
      for (const ref of references(value))
        expect(primitives.has(ref), `${key} → ${ref}`).toBe(true)
  })

  it('lets semantic tokens reference only primitives or other semantic tokens', () => {
    for (const table of [dark, light])
      for (const [key, value] of table)
        for (const ref of references(value))
          expect(primitives.has(ref) || dark.has(ref), `${key} → ${ref}`).toBe(
            true,
          )
  })

  it('lets component tokens reference only semantic or other component tokens and scales', () => {
    const colourPrimitive = /^--(?:nb|ink|paper|gold)-/
    for (const [key, value] of components)
      for (const ref of references(value)) {
        expect(colourPrimitive.test(ref), `${key} → ${ref}`).toBe(false)
        expect(
          dark.has(ref) || components.has(ref) || primitives.has(ref),
          `${key} → ${ref}`,
        ).toBe(true)
      }
  })

  it('maps legacy names only onto semantic tokens or scales', () => {
    for (const [key, value] of legacy)
      for (const ref of references(value))
        expect(dark.has(ref) || primitives.has(ref), `${key} → ${ref}`).toBe(
          true,
        )
  })

  it('stores solid semantic colours as RGB triplets or var() references', () => {
    const translucent =
      /^--(?:surface-hover|surface-active|stroke-[1-4]|stroke-inverted|scrim|elev-)/
    for (const [key, value] of dark) {
      if (translucent.test(key)) continue
      expect(value, key).toMatch(/^(?:\d+ \d+ \d+|var\(--[\w-]+\))$/)
    }
  })

  it('keeps the target palette and scales in primitives', () => {
    expect(primitives.get('--ink-50')).toBe('20 20 19')
    expect(primitives.get('--gold-500')).toBe('212 170 94')
    expect(primitives.get('--paper-50')).toBe('246 245 242')
    expect(primitives.get('--r-md')).toBe('12px')
    expect(primitives.get('--type-body')).toBe('15px / 26px')
    expect(primitives.get('--motion-base')).toBe('200ms')
  })
})

describe('readability of the semantic palette (DS-01 tests 4 and 8)', () => {
  const primitives = declarations(readThemeFile('primitives.css'))
  const themes = {
    dark: declarations(readThemeFile('semantic.dark.css')),
    light: declarations(readThemeFile('semantic.light.css')),
  }

  function rgb(theme: 'dark' | 'light', key: string): [number, number, number] {
    let value = themes[theme].get(key) ?? primitives.get(key) ?? ''
    for (let i = 0; i < 6 && value.startsWith('var('); i++) {
      const ref = value.slice(4, -1)
      value = themes[theme].get(ref) ?? primitives.get(ref) ?? ''
    }
    const m = value.match(/^(\d+) (\d+) (\d+)$/)
    if (!m) throw new Error(`${theme} ${key} is not a solid colour: ${value}`)
    return [Number(m[1]), Number(m[2]), Number(m[3])]
  }

  function luminance([r, g, b]: [number, number, number]): number {
    const channel = (c: number) => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }

  function contrast(theme: 'dark' | 'light', fg: string, bg: string): number {
    const [a, b] = [luminance(rgb(theme, fg)), luminance(rgb(theme, bg))]
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }

  it.each(['dark', 'light'] as const)(
    'keeps %s text readable on panels and raised fills',
    (theme) => {
      for (const surface of ['--surface-base', '--surface-raised'])
        for (const text of ['--text-1', '--text-2']) {
          expect(
            contrast(theme, text, surface),
            `${text} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      expect(
        contrast(theme, '--text-3', '--surface-base'),
      ).toBeGreaterThanOrEqual(4.5)
      // Recorded exception: metadata on raised fills may sit at 4.3:1.
      expect(
        contrast(theme, '--text-3', '--surface-raised'),
      ).toBeGreaterThanOrEqual(4.3)
      expect(
        contrast(theme, '--text-link', '--surface-base'),
      ).toBeGreaterThanOrEqual(4.5)
    },
  )

  it('gives the light theme four distinct surfaces (canvas, panel, raised, selected)', () => {
    const values = [
      '--surface-canvas',
      '--surface-base',
      '--surface-raised',
      '--surface-selected',
    ].map((key) => rgb('light', key).join(' '))
    expect(new Set(values).size).toBe(4)
  })
})

describe('colour primitives stay out of component CSS (DS-01 test 6)', () => {
  const root = new URL('..', import.meta.url).pathname
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return files(path)
      return /\.(css|vue)$/.test(name) ? [path] : []
    })
  }

  it('never uses the target ink / paper / gold primitives outside theme/', () => {
    const offenders = files(root)
      .filter((path) => !relative(root, path).startsWith('theme/'))
      .filter((path) =>
        /var\(--(?:ink|paper|gold)-\d+/.test(readFileSync(path, 'utf8')),
      )
      .map((path) => relative(root, path))
    expect(offenders).toEqual([])
  })
})
