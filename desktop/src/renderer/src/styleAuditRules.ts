// DS-02 ratchet rules for style-audit.test.ts. Each rule counts offences per
// file; style-audit-ratchet.json holds the allowed count per rule and file,
// and the counts may only go down (the end goal is 0 everywhere).
import { parse } from 'vue/compiler-sfc'

export const RATCHET_RULES = [
  // Bare form controls outside components/ui (use Button, IconButton,
  // TextField, TextArea, Select, Checkbox, Switch, …).
  'bare-button',
  'bare-input',
  'bare-select',
  'bare-textarea',
  // font-weight written as a literal instead of var(--weight-*).
  'font-weight-bare',
  // font-weight outside 400 / 500 / 600 (bold, 510, 700, …).
  'font-weight-off-scale',
  // 1px solid borders (use the 0.5px --hairline shadow or a surface step).
  'border-1px-solid',
  // Icon :size outside 12 / 14 / 16 / 20.
  'icon-size',
  // Tailwind @apply.
  'apply',
  // Transitions on grid tracks, width or height (animate transform/opacity).
  'layout-transition',
  // z-[..] classes and z-index values that are not var(--z-*).
  'z-index',
  // L1 colour primitives and raw shadows used outside theme/.
  'l1-token',
  // References to retired token names (theme/retired-tokens.json).
  'legacy-token',
] as const

export type RatchetRule = (typeof RATCHET_RULES)[number]
export type RuleCounts = Partial<Record<RatchetRule, number>>
/** rule → file → count (only non-zero entries). */
export type RatchetTable = Partial<Record<RatchetRule, Record<string, number>>>

export const ICON_SIZES = new Set([12, 14, 16, 20])
export const FONT_WEIGHTS = new Set([400, 500, 600])

const CSS_WIDE = /^(?:inherit|initial|unset|revert|revert-layer)$/
const LAYOUT_PROPERTIES = new Set([
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'inline-size',
  'block-size',
  'flex',
  'flex-basis',
  'grid',
  'grid-template',
  'grid-template-columns',
  'grid-template-rows',
])
const L1_TOKEN =
  /var\(--(?:(?:ink|paper|gold)-\d+|(?:approval|state-ok|state-warn|shadow-lv[1-3])(?![\w-]))/g

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function escape(name: string): string {
  return name.replace(/[-]/g, '\\-')
}

/** Matches var(--name) / var(--name, …) and `--name:` declarations. */
export function retiredMatcher(retired: Iterable<string>): {
  references: RegExp
  definitions: RegExp
} {
  const names = [...retired]
    .map((name) => escape(name.replace(/^--/, '')))
    .sort((a, b) => b.length - a.length)
    .join('|')
  return {
    references: new RegExp(`var\\(\\s*--(?:${names})(?![\\w-])`, 'g'),
    definitions: new RegExp(`(?<![\\w-])--(?:${names})\\s*:`, 'g'),
  }
}

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0
}

/** Splits a top-level comma list (commas inside parentheses stay). */
function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth++
    if (char === ')') depth--
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

function fontWeightValue(value: string): { bare: boolean; offScale: boolean } {
  const v = value.replace(/!important/, '').trim()
  if (
    /^var\(--weight-(?:regular|medium|semibold)\)$/.test(v) ||
    CSS_WIDE.test(v)
  )
    return { bare: false, offScale: false }
  const numeric = /^\d+$/.test(v) ? Number(v) : null
  const offScale =
    numeric !== null
      ? !FONT_WEIGHTS.has(numeric)
      : /^(?:bold|bolder|lighter)$/.test(v)
  return { bare: true, offScale }
}

/** Rules over CSS text (a stylesheet or the <style> blocks of an SFC). */
export function auditCss(css: string): RuleCounts {
  const text = stripCssComments(css)
  let bare = 0
  let offScale = 0
  for (const m of text.matchAll(/(?<![\w-])font-weight\s*:\s*([^;}]+)/g)) {
    const result = fontWeightValue(m[1]!)
    if (result.bare) bare++
    if (result.offScale) offScale++
  }
  // A weight leading the `font` shorthand: `font: 600 13px/20px …`.
  for (const m of text.matchAll(
    /(?<![\w-])font\s*:\s*(\d{3}|bold|bolder|lighter)\s/g,
  )) {
    bare++
    if (fontWeightValue(m[1]!).offScale) offScale++
  }
  let layout = 0
  for (const m of text.matchAll(
    /(?<![\w-])transition(-property)?\s*:\s*([^;}]+)/g,
  )) {
    for (const item of splitTopLevel(m[2]!)) {
      const property = m[1] ? item : item.split(/\s+/)[0]!
      if (LAYOUT_PROPERTIES.has(property)) layout++
    }
  }
  let zIndex = count(text, /\bz-\[/g)
  for (const m of text.matchAll(/(?<![\w-])z-index\s*:\s*([^;}]+)/g)) {
    const v = m[1]!.trim()
    if (!/^var\(--z-[a-z]+\)$/.test(v) && v !== 'auto' && !CSS_WIDE.test(v))
      zIndex++
  }
  return {
    'font-weight-bare': bare,
    'font-weight-off-scale': offScale,
    'border-1px-solid':
      count(
        text,
        /(?<![\w-])border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?\s*:\s*1px\s+solid\b/g,
      ) +
      count(
        text,
        /(?<![\w-])border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?-width\s*:\s*1px\s*[;}]/g,
      ),
    apply: count(text, /@apply\b/g),
    'layout-transition': layout,
    'z-index': zIndex,
    'l1-token': count(text, L1_TOKEN),
  }
}

/** Rules over script text (TypeScript modules and SFC <script> blocks). */
export function auditScript(script: string): RuleCounts {
  return {
    'z-index':
      count(script, /\bzIndex\s*:\s*['"`]?-?\d/g) +
      count(script, /['"]z-index['"]\s*:\s*['"`]?-?\d/g),
    'l1-token': count(script, L1_TOKEN),
    'font-weight-bare': count(script, /\bfontWeight\s*:\s*['"`]?(?:\d|bold)/g),
  }
}

interface TemplateNode {
  type: number
  tag?: string
  tagType?: number
  props?: Array<{
    type: number
    name: string
    value?: { content: string }
    arg?: { content: string }
    exp?: { content: string }
  }>
  children?: TemplateNode[]
  branches?: TemplateNode[]
}

const BARE_CONTROLS: Record<string, RatchetRule> = {
  button: 'bare-button',
  input: 'bare-input',
  select: 'bare-select',
  textarea: 'bare-textarea',
}

/** Names imported from lucide-vue-next or the Ds icon set in an SFC. */
function iconImports(script: string): Set<string> {
  const names = new Set<string>()
  for (const m of script.matchAll(
    /import\s+(?:(\w+)|\{([^}]*)\})\s+from\s+['"]([^'"]+)['"]/g,
  )) {
    const source = m[3]!
    if (
      !/^lucide-vue-next$|(?:^|\/)icons(?:\/ds)?(?:\/Ds\w+\.vue)?$/.test(source)
    )
      continue
    if (m[1]) names.add(m[1])
    for (const part of (m[2] ?? '').split(','))
      if (part.trim())
        names.add(
          part
            .trim()
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        )
  }
  return names
}

/** Rules over an SFC template. `inUi`: the file lives in components/ui. */
export function auditTemplate(
  template: string,
  script: string,
  inUi: boolean,
): RuleCounts {
  const counts: RuleCounts = {}
  const bump = (rule: RatchetRule) => (counts[rule] = (counts[rule] ?? 0) + 1)
  const ast = parse(`<template>${template}</template>`).descriptor.template
    ?.ast as TemplateNode | undefined
  const icons = iconImports(script)
  const visit = (node: TemplateNode) => {
    if (node.type === 1 && node.tag) {
      const rule = BARE_CONTROLS[node.tag]
      if (rule && node.tagType === 0 && !inUi) bump(rule)
      if (icons.has(node.tag) || node.tag === 'component') {
        for (const prop of node.props ?? []) {
          const raw =
            prop.type === 6 && prop.name === 'size'
              ? prop.value?.content
              : prop.type === 7 && prop.arg?.content === 'size'
                ? prop.exp?.content
                : undefined
          if (raw !== undefined && /^\d+$/.test(raw.trim()))
            if (!ICON_SIZES.has(Number(raw.trim()))) bump('icon-size')
        }
      }
    }
    for (const child of node.children ?? []) visit(child)
    for (const branch of node.branches ?? []) visit(branch)
  }
  if (ast) visit(ast)
  const inline = auditCss(
    [...template.matchAll(/\bstyle="([^"]*)"/g)].map((m) => m[1]).join(';'),
  )
  for (const rule of [
    'font-weight-bare',
    'font-weight-off-scale',
    'border-1px-solid',
    'z-index',
  ] as const)
    counts[rule] = (counts[rule] ?? 0) + (inline[rule] ?? 0)
  counts['z-index'] = (counts['z-index'] ?? 0) + count(template, /\bz-\[/g)
  const bound = auditScript(template)
  counts['z-index'] += bound['z-index'] ?? 0
  counts['font-weight-bare'] =
    (counts['font-weight-bare'] ?? 0) + (bound['font-weight-bare'] ?? 0)
  return counts
}

export function splitSfc(source: string): {
  template: string
  scripts: string
  styles: string
} {
  const scripts: string[] = []
  const styles: string[] = []
  const template = source
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/g, (_, body: string) => {
      scripts.push(body)
      return ''
    })
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/g, (_, body: string) => {
      styles.push(body)
      return ''
    })
    .replace(/<!--[\s\S]*?-->/g, '')
  const outer = /<template\b[^>]*>([\s\S]*)<\/template>/.exec(template)
  return {
    template: outer ? outer[1]! : '',
    scripts: scripts.join('\n'),
    styles: styles.join('\n'),
  }
}

function merge(into: RuleCounts, from: RuleCounts): RuleCounts {
  for (const [rule, n] of Object.entries(from) as [RatchetRule, number][])
    if (n) into[rule] = (into[rule] ?? 0) + n
  return into
}

/**
 * Counts every rule for one renderer source file. `rel` is relative to
 * src/renderer/src. theme/ files are only checked for retired names (they
 * define the tokens the other rules point at).
 */
export function auditFile(
  rel: string,
  text: string,
  retired: { references: RegExp; definitions: RegExp },
): RuleCounts {
  const counts: RuleCounts = {}
  const legacy =
    count(text, retired.references) +
    (rel === 'theme/legacy-aliases.css' ? 0 : count(text, retired.definitions))
  if (rel.endsWith('.vue')) {
    const sfc = splitSfc(text)
    merge(counts, auditCss(sfc.styles))
    merge(counts, auditScript(sfc.scripts))
    merge(
      counts,
      auditTemplate(
        sfc.template,
        sfc.scripts,
        rel.startsWith('components/ui/'),
      ),
    )
    counts['l1-token'] =
      (counts['l1-token'] ?? 0) + count(sfc.template, L1_TOKEN)
  } else if (rel.endsWith('.css')) {
    if (!rel.startsWith('theme/')) merge(counts, auditCss(text))
  } else if (rel.endsWith('.ts')) {
    merge(counts, auditScript(text))
  }
  if (legacy) counts['legacy-token'] = legacy
  for (const rule of Object.keys(counts) as RatchetRule[])
    if (!counts[rule]) delete counts[rule]
  return counts
}

/** rule → file → count over a set of files. */
export function auditTree(
  files: Iterable<[rel: string, text: string]>,
  retired: Iterable<string>,
): RatchetTable {
  const matcher = retiredMatcher(retired)
  const table: RatchetTable = {}
  for (const [rel, text] of files)
    for (const [rule, n] of Object.entries(auditFile(rel, text, matcher)) as [
      RatchetRule,
      number,
    ][])
      (table[rule] ??= {})[rel] = n
  return table
}

export function totals(table: RatchetTable): Record<RatchetRule, number> {
  return Object.fromEntries(
    RATCHET_RULES.map((rule) => [
      rule,
      Object.values(table[rule] ?? {}).reduce((a, b) => a + b, 0),
    ]),
  ) as Record<RatchetRule, number>
}

/**
 * Compares actual counts with the ratchet. `above`: a file has more than
 * its allowance (a regression: fix it). `below`: a file has fewer (lower
 * the allowance in style-audit-ratchet.json so the ratchet stays tight).
 */
export function compareRatchet(
  actual: RatchetTable,
  ratchet: RatchetTable,
): { above: string[]; below: string[] } {
  const above: string[] = []
  const below: string[] = []
  for (const rule of RATCHET_RULES) {
    const got = actual[rule] ?? {}
    const allowed = ratchet[rule] ?? {}
    for (const file of new Set([
      ...Object.keys(got),
      ...Object.keys(allowed),
    ])) {
      const n = got[file] ?? 0
      const max = allowed[file] ?? 0
      if (n > max) above.push(`${rule} ${file}: ${n} (allowed ${max})`)
      else if (n < max)
        below.push(`${rule} ${file}: ${n} (ratchet says ${max})`)
    }
  }
  return { above, below }
}
