#!/usr/bin/env node
// DS-02 token codemod: rewrites retired design-token names to the tokens
// that replace them, one category at a time, in the desktop renderer
// sources (.vue, .css, .ts; tests are left alone).
//
//   node scripts/codemods/tokens-v2.mjs                 # every category
//   node scripts/codemods/tokens-v2.mjs --category radius,text
//   node scripts/codemods/tokens-v2.mjs --check         # exit 1 if anything would change
//   node scripts/codemods/tokens-v2.mjs --list          # categories, in run order
//   node scripts/codemods/tokens-v2.mjs path/to/File.vue …
//
// It is idempotent: a second run changes nothing, so it can be re-run after
// merging a branch that still uses the old names. The rename table is
// desktop/src/renderer/src/theme/retired-tokens.json (the style audit reads
// the same file); the value-changing renames are listed there under `snaps`.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const rendererRoot = join(repoRoot, 'desktop/src/renderer/src')
const tablePath = join(rendererRoot, 'theme/retired-tokens.json')
const table = JSON.parse(readFileSync(tablePath, 'utf8'))

function escapeName(name) {
  return name.replace(/[-]/g, '\\-')
}

/** var(--old) / var(--old, fallback) → var(--new …); longer names first. */
function renameCategory(renames) {
  const entries = Object.entries(renames).sort(
    ([a], [b]) => b.length - a.length,
  )
  const re = new RegExp(
    `var\\(\\s*(${entries.map(([old]) => escapeName(old)).join('|')})(?![\\w-])`,
    'g',
  )
  const map = new Map(entries)
  return (text) => text.replace(re, (_, old) => `var(${map.get(old)}`)
}

// rgb(var(--fg) / var(--text-secondary)) → rgb(var(--text-2)): the alpha
// text levels become the solid text tokens. Also accepts --text-1 as the
// base, in case the `text` category ran first on a merged file.
const ALPHA_TEXT = {
  primary: '--text-1',
  secondary: '--text-2',
  tertiary: '--text-3',
}
const ALPHA_OVERLAY = {
  'hover-bg-a': '--surface-hover',
  'active-bg-a': '--surface-active',
}
function textAlpha(text) {
  return text
    .replace(
      /rgb\(\s*var\(--(?:fg|text-1)\)\s*\/\s*var\(--text-(primary|secondary|tertiary)\)\s*\)/g,
      (_, level) => `rgb(var(${ALPHA_TEXT[level]}))`,
    )
    .replace(
      /rgb\(\s*var\(--(?:fg|text-1)\)\s*\/\s*var\(--(hover-bg-a|active-bg-a)\)\s*\)/g,
      (_, level) => `var(${ALPHA_OVERLAY[level]})`,
    )
}

// font-weight literals → var(--weight-*): 400/500/600 map exactly; other
// numbers snap to the nearest of the three (a tie rounds up); bold → 600,
// normal → 400. Only CSS (stylesheets and SFC <style> blocks).
const WEIGHTS = [
  [400, '--weight-regular'],
  [500, '--weight-medium'],
  [600, '--weight-semibold'],
]
function weightToken(value) {
  if (value === 'normal') return '--weight-regular'
  if (value === 'bold') return '--weight-semibold'
  const n = Number(value)
  let best = WEIGHTS[0]
  for (const candidate of WEIGHTS)
    if (Math.abs(candidate[0] - n) <= Math.abs(best[0] - n)) best = candidate
  return best[1]
}
function fontWeightCss(css) {
  return css
    .replace(
      /((?<![\w-])font-weight\s*:\s*)(\d{3}|bold|normal)(?=\s*(?:!important\s*)?[;}\n])/g,
      (_, head, value) => `${head}var(${weightToken(value)})`,
    )
    .replace(
      /((?<![\w-])font\s*:\s*)(\d{3}|bold)(?=\s)/g,
      (_, head, value) => `${head}var(${weightToken(value)})`,
    )
}

// Icon :size snaps to 12 / 14 / 16 / 20 where the nearest step is clear or
// a 1px tie rounds up (11→12, 13→14, 15→16, 19→20, 21/22→20). 18 (a 2px
// tie) and the large decorative sizes (≥ 24) are left to the UI tasks.
const ICON_SNAPS = {
  9: 12,
  10: 12,
  11: 12,
  13: 14,
  15: 16,
  17: 16,
  19: 20,
  21: 20,
  22: 20,
}
function iconNames(script) {
  const names = new Set(['component'])
  for (const m of script.matchAll(
    /import\s+(?:(\w+)|\{([^}]*)\})\s+from\s+['"]([^'"]+)['"]/g,
  )) {
    if (
      !/^lucide-vue-next$|(?:^|\/)icons(?:\/ds)?(?:\/Ds\w+\.vue)?$/.test(m[3])
    )
      continue
    if (m[1]) names.add(m[1])
    for (const part of (m[2] ?? '').split(','))
      if (part.trim())
        names.add(
          part
            .trim()
            .split(/\s+as\s+/)
            .pop()
            .trim(),
        )
  }
  return names
}
function iconSizeTemplate(template, script) {
  const names = iconNames(script)
  return template.replace(
    /<([A-Za-z][\w-]*)(\s[^<>]*?)?(\/?)>/g,
    (tag, name, attrs = '', close) => {
      if (!names.has(name) || !attrs) return tag
      const next = attrs.replace(
        /(\s:size=")(\d+)(")/g,
        (whole, head, value, tail) =>
          ICON_SNAPS[value] ? `${head}${ICON_SNAPS[value]}${tail}` : whole,
      )
      return `<${name}${next}${close}>`
    },
  )
}

export const CATEGORIES = [
  // Pattern categories run before the plain renames that would otherwise
  // rename their parts (--fg).
  ['text-alpha', { kind: 'all', run: textAlpha }],
  ...Object.entries(table.renames).map(([name, renames]) => [
    name,
    { kind: 'all', run: renameCategory(renames) },
  ]),
  ['font-weight', { kind: 'css', run: fontWeightCss }],
  ['icon-size', { kind: 'template', run: iconSizeTemplate }],
]

function mapSfc(source, { css, template }) {
  let out = source
  if (css)
    out = out.replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g,
      (_, open, body, close) => `${open}${css(body)}${close}`,
    )
  if (template) {
    const script = [...out.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .join('\n')
    out = out.replace(
      /(<template\b[^>]*>)([\s\S]*)(<\/template>)/,
      (_, open, body, close) => `${open}${template(body, script)}${close}`,
    )
  }
  return out
}

/** Applies the given categories (default: all, in order) to one file. */
export function transform(
  source,
  file,
  categories = CATEGORIES.map(([n]) => n),
) {
  const selected = new Set(categories)
  let out = source
  for (const [name, category] of CATEGORIES) {
    if (!selected.has(name)) continue
    if (category.kind === 'all') out = category.run(out)
    else if (category.kind === 'css') {
      if (file.endsWith('.css')) out = category.run(out)
      else if (file.endsWith('.vue')) out = mapSfc(out, { css: category.run })
    } else if (category.kind === 'template' && file.endsWith('.vue'))
      out = mapSfc(out, { template: category.run })
  }
  return out
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory())
      return name === 'node_modules' ? [] : walk(path)
    return /\.(?:vue|css|ts)$/.test(name) && !/\.test\.ts$/.test(name)
      ? [path]
      : []
  })
}

function main(argv) {
  const args = [...argv]
  const flag = (name) => {
    const i = args.indexOf(name)
    if (i < 0) return false
    args.splice(i, 1)
    return true
  }
  const option = (name) => {
    const i = args.indexOf(name)
    if (i < 0) return undefined
    const [, value] = args.splice(i, 2)
    return value
  }
  if (flag('--list')) {
    for (const [name] of CATEGORIES) console.log(name)
    return 0
  }
  const check = flag('--check')
  const requested = option('--category')
  const known = CATEGORIES.map(([n]) => n)
  const categories = requested ? requested.split(',') : known
  const unknown = categories.filter((name) => !known.includes(name))
  if (unknown.length) {
    console.error(`unknown category: ${unknown.join(', ')} (see --list)`)
    return 2
  }
  const files = (args.length ? args.map((p) => resolve(p)) : walk(rendererRoot))
    .filter((path) => path !== tablePath)
    .flatMap((path) => (statSync(path).isDirectory() ? walk(path) : [path]))
  const changed = []
  for (const path of files) {
    const before = readFileSync(path, 'utf8')
    const after = transform(before, path, categories)
    if (after === before) continue
    changed.push(relative(repoRoot, path))
    if (!check) writeFileSync(path, after)
  }
  const verb = check ? 'would change' : 'changed'
  console.log(
    `tokens-v2 [${categories.join(', ')}]: ${verb} ${changed.length} file(s)`,
  )
  for (const path of changed) console.log(`  ${path}`)
  return check && changed.length ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = main(process.argv.slice(2))
