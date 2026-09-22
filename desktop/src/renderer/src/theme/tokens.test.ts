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

  it.each(['dark.css', 'light.css'])(
    '%s has no stray comment terminators (sheet must parse as one rule)',
    (f) => {
      // A `*/` inside prose (e.g. "border-l*/…") closes the header early and
      // silently drops the whole token table in the browser.
      const stripped = readThemeFile(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim()
      expect(stripped.startsWith(':root')).toBe(true)
      expect(stripped.match(/\{/g)).toHaveLength(1)
      expect(stripped.endsWith('}')).toBe(true)
    },
  )

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

  const DSH_KEYS = [
    /* dsh neutral-bluish scale */
    ...[
      '00',
      '50',
      '60',
      '75',
      '100',
      '150',
      '200',
      '300',
      '400',
      '500',
      '600',
      '700',
      '750',
      '800',
      '850',
      '875',
      '900',
      '950',
      '1000',
    ].map((step) => `--nb-${step}`),
    /* surfaces */
    '--bg-base',
    '--bg-layer-1',
    '--bg-layer-2',
    '--bg-layer-3',
    '--sidebar-fill',
    '--menu-fill',
    '--selector-fill',
    '--tip-fill',
    '--code-block-bg',
    '--code-banner-bg',
    '--inline-code-bg',
    '--tooltip-bg',
    '--toast-bg',
    /* translucent overlays */
    '--border-l1',
    '--border-l2',
    '--border-l3',
    '--border-l4',
    '--interactive-bg-hover',
    '--interactive-bg-active',
    '--mask-1',
    /* labels */
    '--label-primary',
    '--label-secondary',
    '--label-tertiary',
    '--label-caption',
    '--label-dimmed',
    /* gold accent family */
    '--accent-fill',
    '--accent-hover',
    '--accent-strong',
    '--accent-soft',
    '--bubble-user',
    '--focus-ring',
    /* states */
    '--approval',
    '--approval-strong',
    '--approval-soft',
    '--ok-soft',
    '--warn-soft',
    '--danger-soft',
    /* semantic state family (settings StatusBadge / diagnostics) */
    ...['ok', 'warn', 'error'].flatMap((tone) => [
      `--state-${tone}`,
      `--state-${tone}-soft`,
      `--state-${tone}-label`,
    ]),
    /* code highlight */
    '--code-keyword',
    '--code-string',
    '--code-function',
    '--code-comment',
    /* shadows / radii / type */
    '--shadow-lv1',
    '--shadow-lv2',
    '--shadow-lv3',
    '--radius-row',
    '--radius-cell',
    '--radius-card',
    '--radius-takeover',
    '--radius-composer',
    '--radius-modal',
    '--font-sans',
    '--font-mono',
    '--font-xs',
    '--font-s',
    '--font-base',
    '--font-md',
    '--font-code',
    '--ease-in-out',
    '--duration-ds',
  ]

  it.each(['dark.css', 'light.css'])('%s defines the dsh token set', (f) => {
    const keys = tokenKeys(readThemeFile(f))
    for (const required of DSH_KEYS) expect(keys).toContain(required)
  })

  it.each(['dark.css', 'light.css'])(
    '%s stores solid colors as RGB triplets or var() aliases',
    (f) => {
      const css = readThemeFile(f)
      const colorKeys = [
        '--nb-950',
        '--accent-fill',
        '--accent-soft',
        '--bubble-user',
        '--approval',
        '--code-keyword',
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
        '--bg-base',
        '--label-primary',
        '--state-ok',
        '--state-ok-soft',
        '--state-ok-label',
        '--state-warn',
        '--state-warn-soft',
        '--state-warn-label',
        '--state-error',
        '--state-error-soft',
        '--state-error-label',
      ]
      for (const key of colorKeys) {
        const re = new RegExp(
          `${key}:\\s*(?:\\d+ \\d+ \\d+|var\\(--[\\w-]+\\))\\s*;`,
        )
        expect(css, `${key} must be an RGB triplet or alias`).toMatch(re)
      }
    },
  )

  it('keeps legacy keys as aliases of the dsh tokens', () => {
    for (const f of ['dark.css', 'light.css']) {
      const css = readThemeFile(f)
      expect(css).toContain('--bg: var(--bg-base);')
      expect(css).toContain('--fg: var(--label-primary);')
      expect(css).toContain('--accent: var(--accent-fill);')
      expect(css).toContain('--shadow-lg: var(--shadow-lv3);')
      expect(css).toContain('--radius-lg: var(--radius-card);')
    }
  })

  it('applies the dsh palette with Emperor gold in place of dsh blue', () => {
    const dark = readThemeFile('dark.css')
    const light = readThemeFile('light.css')
    expect(dark).toContain('--bg-base: var(--nb-950);')
    expect(dark).toContain('--nb-950: 21 21 23;')
    expect(dark).toContain('--brand: 203 158 72;')
    expect(dark).toContain('--accent-fill: 214 172 92;')
    expect(light).toContain('--bg-base: var(--nb-00);')
    expect(light).toContain('--label-secondary: var(--nb-700);')
    expect(light).toContain('--brand: 155 111 35;')
    expect(light).toContain('--accent-fill: 170 122 38;')
    // No dsh deepseek blue survives in either table.
    for (const css of [dark, light]) {
      expect(css).not.toMatch(/65 118 230|103 158 254|86 134 254/)
    }
  })
})
