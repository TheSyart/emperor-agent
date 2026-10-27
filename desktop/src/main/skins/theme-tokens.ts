/**
 * The renderer's theme tables as main reads them for skins (BRD-05):
 * primitives, the two semantic sets and the component tokens, each token
 * declared per theme the way the cascade picks it (`:root` < `:root[data-
 * theme=…]`, later wins), resolved through var() to the value the browser
 * computes. Pure: theme-sources.ts feeds it the real files.
 *
 * The allowlist is the semantic surfaces, text, strokes, brand and accent:
 * no sizes, spacing, radii, fonts, status colours (an error must look like
 * an error), elevation, the destructive hover or the solid lines a11y.css
 * raises for 「增强对比度」.
 */

export type ThemeName = 'light' | 'dark'
export type TokenKind = 'triplet' | 'colour'

export interface ThemeSources {
  primitives: string
  dark: string
  light: string
  components: string
}

export interface ThemeTokens {
  readonly allowlist: ReadonlyMap<string, TokenKind>
  /** The value the browser computes for `key` in `theme`, or null. */
  resolve(theme: ThemeName, key: string): string | null
  /** `key`'s colour as [r, g, b] when it resolves to a triplet. */
  triplet(theme: ThemeName, key: string): [number, number, number] | null
  /** `keys` and every token whose value is built on one of them. */
  dependents(theme: ThemeName, keys: Iterable<string>): Set<string>
}

const ALLOWED =
  /^--(?:surface-|text-|stroke-|hairline$|accent|brand$|focus-ring$|bubble-user$)/
const EXCLUDED = new Set([
  '--surface-hover-danger',
  '--stroke-solid',
  '--stroke-solid-strong',
])
const TRIPLET = /^(\d{1,3}) (\d{1,3}) (\d{1,3})$/

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

interface Declaration {
  value: string
  specificity: number
  order: number
}

/** key → value for one theme, from the given files in cascade order. */
function declarations(theme: ThemeName, files: string[]): Map<string, string> {
  const winners = new Map<string, Declaration>()
  let order = 0
  for (const file of files)
    for (const rule of stripComments(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      let specificity = 0
      for (const raw of rule[1]!.split(',')) {
        const selector = raw.trim().replace(/"/g, "'")
        if (selector === ':root') specificity = Math.max(specificity, 1)
        else if (selector === `:root[data-theme='${theme}']`)
          specificity = Math.max(specificity, 2)
      }
      if (!specificity) continue
      for (const m of rule[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        order += 1
        const previous = winners.get(m[1]!)
        if (!previous || previous.specificity <= specificity)
          winners.set(m[1]!, {
            value: m[2]!.replace(/\s+/g, ' ').trim(),
            specificity,
            order,
          })
      }
    }
  return new Map([...winners].map(([key, d]) => [key, d.value]))
}

/** The var() references of a value, fallbacks included. */
function references(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!)
}

/** Substitutes each var(--x[, fallback]) with what `lookup` resolves. */
function substitute(
  value: string,
  lookup: (key: string) => string | null,
): string | null {
  let out = ''
  let index = 0
  while (index < value.length) {
    const start = value.indexOf('var(', index)
    if (start < 0) {
      out += value.slice(index)
      break
    }
    out += value.slice(index, start)
    let depth = 0
    let end = start + 3
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++
      else if (value[end] === ')' && --depth === 0) break
    }
    if (end >= value.length) return null
    const inner = value.slice(start + 4, end)
    const comma = inner.indexOf(',')
    const key = (comma < 0 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim()
    const resolved =
      lookup(key) ?? (fallback === null ? null : substitute(fallback, lookup))
    if (resolved === null) return null
    out += resolved
    index = end + 1
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function createThemeTokens(sources: ThemeSources): ThemeTokens {
  const files = [
    sources.primitives,
    sources.dark,
    sources.light,
    sources.components,
  ]
  const tables: Record<ThemeName, Map<string, string>> = {
    light: declarations('light', files),
    dark: declarations('dark', files),
  }
  const cache: Record<ThemeName, Map<string, string | null>> = {
    light: new Map(),
    dark: new Map(),
  }

  function resolve(
    theme: ThemeName,
    key: string,
    seen = new Set<string>(),
  ): string | null {
    const cached = cache[theme].get(key)
    if (cached !== undefined) return cached
    const declared = tables[theme].get(key)
    if (declared === undefined || seen.has(key)) return null
    seen.add(key)
    const value = substitute(declared, (ref) => resolve(theme, ref, seen))
    seen.delete(key)
    cache[theme].set(key, value)
    return value
  }

  function triplet(
    theme: ThemeName,
    key: string,
  ): [number, number, number] | null {
    const m = TRIPLET.exec(resolve(theme, key) ?? '')
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }

  const semantic = declarations('dark', [sources.dark])
  const allowlist = new Map<string, TokenKind>()
  for (const key of semantic.keys()) {
    if (!ALLOWED.test(key) || EXCLUDED.has(key)) continue
    allowlist.set(key, triplet('light', key) ? 'triplet' : 'colour')
  }

  function dependents(theme: ThemeName, keys: Iterable<string>): Set<string> {
    const found = new Set<string>(
      [...keys].filter((key) => tables[theme].has(key)),
    )
    let grew = true
    while (grew) {
      grew = false
      for (const [key, value] of tables[theme])
        if (
          !found.has(key) &&
          references(value).some((ref) => found.has(ref))
        ) {
          found.add(key)
          grew = true
        }
    }
    return found
  }

  return {
    allowlist,
    resolve: (theme, key) => resolve(theme, key),
    triplet,
    dependents,
  }
}
