import { describe, it, expect } from 'vitest'
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  auditFile,
  auditTree,
  compareRatchet,
  retiredMatcher,
  totals,
  type RatchetTable,
} from './styleAuditRules'
import RATCHET from './style-audit-ratchet.json'
import RETIRED from './theme/retired-tokens.json'

// 样式收敛审计(PLAN-20260721-THEME-THINK):固化颜色/裸值收敛成果,防回归。
// 白名单:theme/*.css 是 token 定义文件,自身不受这些规则约束。

const SRC = new URL('.', import.meta.url).pathname

function collect(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(SRC, dir))) {
    const rel = join(dir, entry)
    const abs = join(SRC, rel)
    if (statSync(abs).isDirectory()) {
      out.push(...collect(rel, exts))
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(rel)
    }
  }
  return out
}

const STYLE_FILES = collect('styles', ['.css'])
const THEME_FILES = collect('theme', ['.css'])
const VUE_FILES = collect('components', ['.vue'])
const SCANNED = [...STYLE_FILES, ...THEME_FILES, ...VUE_FILES]

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf-8')
}

function styleBlocks(rel: string): string {
  return [...read(rel).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join('\n')
}

describe('style audit: color convergence', () => {
  it('no bare hex colors outside theme/*.css', () => {
    const offenders: string[] = []
    for (const rel of SCANNED) {
      const hits = read(rel).match(
        /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b/g,
      )
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no legacy alias utility classes (text-muted, border-line, bg-paper, ...)', () => {
    const aliasClass =
      /\b(?:text|bg|border|ring|ring-offset|shadow|divide|placeholder)-(?:muted|ink|line|paper|paper2|seal|jade|amber)\b/g
    const offenders: string[] = []
    for (const rel of SCANNED) {
      const hits = read(rel).match(aliasClass)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no var(--paper/--ink/--seal/--jade/--amber/--muted/--line/--paper-2) consumption', () => {
    // Exact retired names only: the DS-01 numbered primitives (--ink-50,
    // --paper-0, …) are a different family, kept inside theme/ by
    // theme/tokens.test.ts.
    const aliasVar =
      /var\(--(?:paper|paper-2|ink|muted|line|seal|jade|amber)(?![\w-])/g
    const offenders: string[] = []
    for (const rel of SCANNED) {
      const hits = read(rel).match(aliasVar)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no var(--fg-muted/--fg-subtle) consumption (use fg / text-secondary / text-tertiary)', () => {
    // grok 式文本层级已收敛:次级/三级文字一律 rgb(var(--fg) / var(--text-*)),
    // 实体 --fg-muted/--fg-subtle 已删除,禁止回流。
    const dead = /var\(--fg-(?:muted|subtle)\b/g
    const offenders: string[] = []
    for (const rel of SCANNED) {
      const hits = read(rel).match(dead)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no legacy text-fg-muted / text-fg-subtle Tailwind classes (use text-secondary/text-tertiary)', () => {
    const deadClass = /\b(?:text|bg|border)-fg-(?:muted|subtle)\b/g
    const offenders: string[] = []
    for (const rel of SCANNED) {
      const hits = read(rel).match(deadClass)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

describe('style audit: bare-value convergence (vue scoped)', () => {
  it('no bare px border-radius except 0/2px/999px in <style> blocks', () => {
    const re = /border-radius:\s*(?!0\b|2px\b|999px\b)\d+px/g
    const offenders: string[] = []
    for (const rel of VUE_FILES) {
      const hits = styleBlocks(rel).match(re)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no box-shadow with hardcoded rgb(0 0 0 / *) in <style> blocks', () => {
    const re = /box-shadow:[^;]*rgb\(0 0 0/g
    const offenders: string[] = []
    for (const rel of VUE_FILES) {
      const hits = styleBlocks(rel).match(re)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no bare px font-size in the 9-15px range in <style> blocks', () => {
    const re = /font-size:\s*(?:9|1[0-5])px\b/g
    const offenders: string[] = []
    for (const rel of VUE_FILES) {
      const hits = styleBlocks(rel).match(re)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no text-[Npx] arbitrary font-size classes in templates', () => {
    const re = /text-\[(?:9|1[0-5])px\]/g
    const offenders: string[] = []
    for (const rel of VUE_FILES) {
      const hits = read(rel).match(re)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

describe('style audit: bare-value convergence (styles/)', () => {
  it('no bare px border-radius except 0/999px', () => {
    const re = /border-radius:\s*(?!0\b|999px\b)\d+px/g
    const offenders: string[] = []
    for (const rel of STYLE_FILES) {
      const hits = read(rel).match(re)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no box-shadow with hardcoded rgb(0 0 0 / *)', () => {
    const re = /box-shadow:[^;]*rgb\(0 0 0/g
    const offenders: string[] = []
    for (const rel of STYLE_FILES) {
      const hits = read(rel).match(re)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no bare px font-size in the 9-15px range', () => {
    const re = /font-size:\s*(?:9|1[0-5])px\b/g
    const offenders: string[] = []
    for (const rel of STYLE_FILES) {
      const hits = read(rel).match(re)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no converged-range rounded-[Nrem]/[Npx] arbitrary radius classes', () => {
    // Δ≤2px 的值必须归位到 var(--radius-*);偏差更大的保留值登记于此白名单
    // (旧设置视图删除后已清空,只许保持为空或继续删减)。
    const KEEP = new Set<string>()
    const re = /rounded-\[(?!var\()[0-9.]+(?:rem|px)\]/g
    const offenders: string[] = []
    for (const rel of STYLE_FILES) {
      const hits = (read(rel).match(re) ?? []).filter((h) => !KEEP.has(h))
      if (hits.length)
        offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

// ── 统一性收敛(APPLE-UI-OVERHAUL)──────────────────────────────────────────
// 目的:让样式系统"高度规范、统一、可控",并防止再度失控。三类规则:
//   HARD  —— 现已为零,直接禁绝(z-index / blur / 布局属性过渡 / token 重定义)。
//   RATCHET —— 存量较大,记录每文件基线,只许降不许升,分阶段压到白名单-only。
// 材质 blur 一律经 var(--material-*/--glass-*)token;z-index 一律 var(--z-*)。

describe('style audit: unified tokens (hard rules, must stay zero)', () => {
  it('no magic z-index (use var(--z-*))', () => {
    const re = /z-index:\s*(?!var\(--z-)-?\d+/g
    const offenders: string[] = []
    for (const rel of SCANNED) {
      const hits = read(rel).match(re)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no one-off backdrop blur >= 4px (use material tiers)', () => {
    // 小数值(1-3px)是毛发级聚焦/柔光,合法;≥4px 必须走材质 token。
    // 仅扫描样式(styles/*.css + SFC <style> 块),不含 JS/TS 字符串。
    const re = /blur\((?!var\()([4-9]|\d{2,})(?:\.\d+)?px\)/g
    const offenders: string[] = []
    const targets = [
      ...STYLE_FILES.map((rel) => [rel, read(rel)] as const),
      ...VUE_FILES.map((rel) => [rel, styleBlocks(rel)] as const),
    ]
    for (const [rel, text] of targets) {
      const hits = text.match(re)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no layout-property transitions (animate transform/opacity only)', () => {
    const re =
      /transition:[^;{}]*\b(?:width|height|padding|padding-[a-z]+|margin|margin-[a-z]+|top|left|right|bottom|inset)\b[^;{}]*\d(?:ms|s)\b/g
    const offenders: string[] = []
    for (const rel of SCANNED) {
      const hits = read(rel).match(re)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('no foundation-token redefinition outside theme/*.css', () => {
    // theme/*.css 是 token 唯一事实源。其他文件给基础 token 赋值(--x: 值,
    // 值非 var( 开头)即视为重定义,防止 codex-v2 之祸复发。
    const re =
      /--(bg|fg|accent|brand|border|radius|space|shadow|material|glass|scrim|z-|duration|ease|tracking|leading|font-size)[a-z0-9-]*:\s*(?!var\()/g
    const offenders: string[] = []
    for (const rel of SCANNED) {
      if (rel.startsWith('theme/')) continue
      // a11y.css 的媒体查询 token 覆盖是合法机制,非重复定义。
      if (rel === 'styles/a11y.css') continue
      const hits = read(rel).match(re)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('every design token a style uses is defined somewhere', () => {
    // An undefined var() drops the declaration without an error, so a typo
    // like --fs-sm silently renders the inherited size (and a missing
    // --accent-* color the inherited color). The DS families count too:
    // a --font-sm shorthand once dropped a whole `font` declaration.
    const used =
      /var\((--(?:fs|lh|accent|label|bg|fg|border|radius|space|shadow|material|glass|scrim|mask|state|danger|warn|z|duration|ease|font|type|weight|r|surface|text|stroke|elev|control|icon|motion|row|brand|focus|attention|info|error|success)-?[a-z0-9-]*)/g
    const defined = new Set<string>()
    for (const rel of SCANNED)
      for (const m of read(rel).matchAll(
        /(--[a-z0-9-]+)\s*:|['"](--[a-z0-9-]+)['"]\s*:/g,
      ))
        defined.add(m[1] ?? m[2]) // CSS declarations and :style bindings
    const offenders: string[] = []
    const targets = [
      ...STYLE_FILES.map((rel) => [rel, read(rel)] as const),
      ...VUE_FILES.map((rel) => [rel, styleBlocks(rel)] as const),
    ]
    for (const [rel, text] of targets) {
      const missing = [...text.matchAll(used)]
        .map((m) => m[1])
        .filter((name) => !defined.has(name))
      if (missing.length)
        offenders.push(`${rel}: ${[...new Set(missing)].join(', ')}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

describe('style audit: ratchets (only-ever-decrease baselines)', () => {
  // 每文件允许的存量上限。规则:计数 > 基线 → 红;计数 ≤ 基线 → 绿。
  // 清理时把数字往下调,直到只剩白名单。新增文件不得出现(默认基线 0)。
  const IMPORTANT_BASELINE: Record<string, number> = {
    'styles/a11y.css': 4, // 全部带 audit-allow 注释(全局无障碍覆盖)
    'styles/workspace.css': 2, // .workspace-resizing 全局拖拽态(带 audit-allow)
  }

  it('!important count does not exceed baseline, and is audit-allow commented', () => {
    const offenders: string[] = []
    for (const rel of SCANNED) {
      const text = read(rel)
      const count = (text.match(/!important/g) ?? []).length
      const baseline = IMPORTANT_BASELINE[rel] ?? 0
      if (count > baseline)
        offenders.push(`${rel}: ${count} !important (baseline ${baseline})`)
      // 白名单外的 !important 必须紧邻 audit-allow 注释(向上 6 行内,
      // 允许注释写在选择器块上方;向下 1 行允许写在行内)。
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        if (!line.includes('!important')) return
        const windowText = [
          ...lines.slice(Math.max(0, i - 6), i),
          line,
          lines[i + 1] ?? '',
        ].join('\n')
        if (!/audit-allow:\s*important/.test(windowText))
          offenders.push(`${rel}:${i + 1} !important without audit-allow note`)
      })
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  // ── 无障碍降级单源规则(Stage6)──────────────────────────────────────────
  // 三条偏好信号集中写在 styles/a11y.css;样式/组件不得再出现散落的
  // prefers-reduced-motion 块(JS 弹簧由 useReducedMotion 门控,属另一条路径)。
  it('a11y.css centralizes all three preference signals', () => {
    const a11y = read('styles/a11y.css')
    const motion =
      /@media \(prefers-reduced-motion: reduce\) \{\n([\s\S]*?)\n\}/.exec(
        a11y,
      )?.[1]
    expect(motion).toBeTruthy()
    expect(motion).toContain('--duration-fast: 1ms')
    expect(motion).toContain('animation-duration: 1ms !important')
    expect(motion).toContain('transition-duration: 1ms !important')
    // 覆盖选择器必须与主题表同特异性(:root[data-theme]),否则主题声明按
    // 特异性胜出、覆盖静默失效(曾真实发生,Playwright 断言捕获)。
    expect(motion).toMatch(/:root\[data-theme='dark'\]/)
    const transparency =
      /@media \(prefers-reduced-transparency: reduce\) \{\n([\s\S]*?)\n\}/.exec(
        a11y,
      )?.[1]
    expect(transparency).toBeTruthy()
    expect(transparency).toContain('--material-1-alpha: 0.97')
    expect(transparency).toContain('--material-1-blur: 0px')
    expect(transparency).toContain('--glass-blur: 0px')
    expect(transparency).toMatch(/:root\[data-theme='dark'\]/)
    const contrast =
      /@media \(prefers-contrast: more\) \{\n([\s\S]*?)\n\}/.exec(a11y)?.[1]
    expect(contrast).toBeTruthy()
    expect(contrast).toContain('--border: 88 88 98')
  })

  it('no scattered prefers-reduced-motion blocks outside a11y.css', () => {
    const offenders: string[] = []
    for (const rel of STYLE_FILES) {
      if (rel === 'styles/a11y.css') continue
      if (read(rel).includes('prefers-reduced-motion')) {
        const lines = read(rel)
          .split('\n')
          .filter((line) => line.includes('prefers-reduced-motion'))
        offenders.push(`${rel}: ${lines.join(' | ')}`)
      }
    }
    for (const rel of VUE_FILES) {
      const blocks = styleBlocks(rel)
      if (blocks.includes('prefers-reduced-motion'))
        offenders.push(`${rel}: <style> contains prefers-reduced-motion`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  const SPACING_BASELINE: Record<string, number> = {
    // Stage6 收敛后:3-14px 裸间距全部吸附到 var(--space-*)(±2px 内),
    // 余值仅为不可吸附的定位偏移(-3px resizer、52px/348px 浮层锚点)。
    'styles/activity.css': 0,
    'styles/panels.css': 3,
    'styles/workspace.css': 0,
    'styles/surfaces/menus.css': 0,
    'styles/surfaces/panels.css': 0,
  }

  it('bare px spacing count does not exceed baseline (use var(--space-*))', () => {
    const re =
      /(?:margin|padding|gap|inset|top|left|right|bottom)(?:-[a-z]+)?:\s*-?(?!0\b|1px\b|2px\b)\d+px/g
    const offenders: string[] = []
    for (const rel of SCANNED) {
      const count = (read(rel).match(re) ?? []).length
      const baseline = SPACING_BASELINE[rel] ?? 0
      if (count > baseline)
        offenders.push(`${rel}: ${count} bare px (baseline ${baseline})`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

// ── DS-02: ratchets for controls, weights, borders, icons, layers, tokens ──
// styleAuditRules.ts counts each rule per file; style-audit-ratchet.json
// holds what each file may still have. A count above its allowance fails
// (a regression); a count below it fails too until the allowance is lowered
// (STYLE_AUDIT_TIGHTEN=1 rewrites the lowered numbers), so the ratchet only
// ever moves down. New files start at 0.

const DESKTOP = join(SRC, '../../..')
const REPO = join(DESKTOP, '..')
const RETIRED_NAMES = [
  ...Object.values(RETIRED.renames).flatMap((renames) => Object.keys(renames)),
  ...Object.keys(RETIRED.removed),
]

function rendererSources(): [string, string][] {
  const walk = (dir: string): string[] =>
    readdirSync(join(SRC, dir)).flatMap((name) => {
      const rel = dir ? join(dir, name) : name
      if (statSync(join(SRC, rel)).isDirectory()) return walk(rel)
      return /\.(?:vue|css|ts)$/.test(name) && !/\.(?:test|d)\.ts$/.test(name)
        ? [rel]
        : []
    })
  return walk('').map((rel) => [rel, read(rel)])
}

describe('style audit: DS-02 ratchets', () => {
  const sources = rendererSources()
  const actual = auditTree(sources, RETIRED_NAMES)
  const allowed = RATCHET.allowed as RatchetTable
  const matcher = retiredMatcher(RETIRED_NAMES)

  /** What adding one file would break (a new file is allowed nothing). */
  function violations(rel: string, text: string): string[] {
    const table: RatchetTable = {}
    for (const [rule, n] of Object.entries(auditFile(rel, text, matcher)))
      table[rule as keyof RatchetTable] = { [rel]: n }
    return compareRatchet(table, allowed).above
  }

  it('keeps every rule at its per-file allowance, which only goes down (test 1)', () => {
    const { above, below } = compareRatchet(actual, allowed)
    if (process.env.STYLE_AUDIT_TIGHTEN && below.length) {
      const tightened: RatchetTable = {}
      for (const [rule, files] of Object.entries(allowed))
        tightened[rule as keyof RatchetTable] = Object.fromEntries(
          Object.entries(files)
            .map(([file, max]): [string, number] => [
              file,
              Math.min(max, actual[rule as keyof RatchetTable]?.[file] ?? 0),
            ])
            .filter(([, n]) => n > 0),
        )
      writeFileSync(
        join(SRC, 'style-audit-ratchet.json'),
        `${JSON.stringify({ ...RATCHET, allowed: tightened }, null, 2)}\n`,
      )
      return
    }
    expect(above, `regressions:\n${above.join('\n')}`).toEqual([])
    expect(
      below,
      `lower these allowances in style-audit-ratchet.json (STYLE_AUDIT_TIGHTEN=1 does it):\n${below.join('\n')}`,
    ).toEqual([])
  })

  it('never allows more than the DS-02 baseline in total', () => {
    const baseline = RATCHET.baseline as Record<string, number>
    for (const [rule, n] of Object.entries(totals(allowed)))
      expect(n, rule).toBeLessThanOrEqual(baseline[rule] ?? 0)
  })

  it('fails on a bare <button> outside components/ui (test 2)', () => {
    const vue = '<template><button type="button">Go</button></template>\n'
    expect(violations('components/fixture/BareButton.vue', vue)).toEqual([
      'bare-button components/fixture/BareButton.vue: 1 (allowed 0)',
    ])
    expect(
      violations(
        'components/fixture/Controls.vue',
        '<template><input /><select></select><textarea /></template>\n',
      ),
    ).toHaveLength(3)
    // components/ui is where the controls are implemented.
    expect(violations('components/ui/FixtureButton.vue', vue)).toEqual([])
  })

  it('fails on font-weight: 510 (test 3)', () => {
    const vue = (weight: string) =>
      `<template><p class="x">a</p></template>\n<style scoped>\n.x {\n  font-weight: ${weight};\n}\n</style>\n`
    expect(violations('components/fixture/Weight.vue', vue('510'))).toEqual([
      'font-weight-bare components/fixture/Weight.vue: 1 (allowed 0)',
      'font-weight-off-scale components/fixture/Weight.vue: 1 (allowed 0)',
    ])
    expect(violations('components/fixture/Weight.vue', vue('600'))).toEqual([
      'font-weight-bare components/fixture/Weight.vue: 1 (allowed 0)',
    ])
    expect(
      violations('components/fixture/Weight.vue', vue('var(--weight-medium)')),
    ).toEqual([])
  })

  it('fails on @apply (test 4)', () => {
    expect(
      violations(
        'styles/fixture.css',
        '.x {\n  @apply flex items-center;\n}\n',
      ),
    ).toEqual(['apply styles/fixture.css: 1 (allowed 0)'])
  })

  it('fails on z-[70] and on bare z-index (test 5)', () => {
    expect(
      violations(
        'components/fixture/Layer.vue',
        '<template><div class="fixed z-[70]">a</div></template>\n',
      ),
    ).toEqual(['z-index components/fixture/Layer.vue: 1 (allowed 0)'])
    expect(
      violations('styles/fixture.css', '.x {\n  @apply z-[70];\n}\n'),
    ).toEqual([
      'apply styles/fixture.css: 1 (allowed 0)',
      'z-index styles/fixture.css: 1 (allowed 0)',
    ])
    expect(
      violations('styles/fixture.css', '.x {\n  z-index: 70;\n}\n'),
    ).toEqual(['z-index styles/fixture.css: 1 (allowed 0)'])
    expect(
      violations('styles/fixture.css', '.x {\n  z-index: var(--z-modal);\n}\n'),
    ).toEqual([])
  })

  it('flags the remaining rules on fixtures', () => {
    const style = (css: string) =>
      `<template><p class="x">a</p></template>\n<style scoped>\n.x {\n  ${css}\n}\n</style>\n`
    const rel = 'components/fixture/Rules.vue'
    expect(
      violations(rel, style('border: 1px solid rgb(var(--stroke-solid));')),
    ).toEqual([`border-1px-solid ${rel}: 1 (allowed 0)`])
    expect(
      violations(rel, style('box-shadow: 0 0 0 0.5px var(--hairline);')),
    ).toEqual([])
    expect(
      violations(
        rel,
        style('transition: grid-template-columns var(--motion-base);'),
      ),
    ).toEqual([`layout-transition ${rel}: 1 (allowed 0)`])
    expect(
      violations(
        rel,
        style(
          'transition: opacity var(--motion-base), transform var(--motion-base);',
        ),
      ),
    ).toEqual([])
    expect(violations(rel, style('color: rgb(var(--gold-500));'))).toEqual([
      `l1-token ${rel}: 1 (allowed 0)`,
    ])
    expect(violations(rel, style('color: rgb(var(--danger));'))).toEqual([
      `legacy-token ${rel}: 1 (allowed 0)`,
    ])
    const icon = (size: number) =>
      `<template><RefreshCw :size="${size}" /></template>\n<script setup lang="ts">\nimport { RefreshCw } from 'lucide-vue-next'\n</script>\n`
    expect(violations(rel, icon(13))).toEqual([
      `icon-size ${rel}: 1 (allowed 0)`,
    ])
    expect(violations(rel, icon(14))).toEqual([])
  })

  it.skip('has no Tailwind left: config, PostCSS plugin, dependency, directives (test 6)', () => {
    expect(existsSync(join(DESKTOP, 'tailwind.config.ts'))).toBe(false)
    const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'))
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty(
      'tailwindcss',
    )
    expect(
      readFileSync(join(DESKTOP, 'postcss.config.js'), 'utf8'),
    ).not.toMatch(/tailwind/)
    const offenders = sources
      .filter(([rel]) => !rel.endsWith('.ts'))
      .filter(([, text]) =>
        /@tailwind\b|@apply\b|(?<![\w-])theme\(|\banimate-spin\b/.test(text),
      )
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
    expect(totals(actual).apply).toBe(0)
  })

  it.skip('references no retired token name and has no alias layer (test 7)', () => {
    expect(existsSync(join(SRC, 'theme/legacy-aliases.css'))).toBe(false)
    expect(totals(actual)['legacy-token']).toBe(0)
  })

  it.skip('renames every retired name onto a token the theme defines', () => {
    const defined = new Set<string>()
    for (const file of THEME_FILES)
      for (const m of read(file).matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]!)
    for (const renames of Object.values(RETIRED.renames))
      for (const [old, next] of Object.entries(renames)) {
        expect(defined.has(next), `${old} → ${next}`).toBe(true)
        expect(defined.has(old), `${old} is still defined`).toBe(false)
      }
    for (const old of Object.keys(RETIRED.removed))
      expect(defined.has(old), `${old} is still defined`).toBe(false)
  })

  it.skip('animates no grid track, width or height, and has no z-[..] left', () => {
    // AppFrame's column widths change without animation (DS-02).
    expect(actual['layout-transition'] ?? {}).toEqual({})
    expect(actual['z-index'] ?? {}).toEqual({})
  })

  async function loadCodemod() {
    const url = pathToFileURL(join(REPO, 'scripts/codemods/tokens-v2.mjs')).href
    return (await import(/* @vite-ignore */ url)) as {
      transform: (source: string, file: string) => string
    }
  }

  it('codemods retired names, weights and icon sizes idempotently', async () => {
    const codemod = await loadCodemod()
    const sample = [
      '<template><RefreshCw :size="13" /><Plus :size="18" /></template>',
      '<script setup lang="ts">',
      "import { Plus, RefreshCw } from 'lucide-vue-next'",
      '</script>',
      '<style scoped>',
      '.a {',
      '  color: rgb(var(--fg) / var(--text-secondary));',
      '  background: var(--interactive-bg-hover);',
      '  border-radius: var(--radius-sm);',
      '  font-weight: 700;',
      '  transition: opacity var(--duration-ds-fast) var(--ease-in-out);',
      '}',
      '.b {',
      '  color: rgb(var(--fg));',
      '  font: 600 var(--fs-xs) / var(--lh-xs) var(--font-sans);',
      '}',
      '</style>',
      '',
    ].join('\n')
    const once = codemod.transform(sample, 'Sample.vue')
    expect(once).toContain('<RefreshCw :size="14" /><Plus :size="18" />')
    expect(once).toContain('color: rgb(var(--text-2));')
    expect(once).toContain('background: var(--surface-hover);')
    expect(once).toContain('border-radius: var(--r-sm);')
    expect(once).toContain('font-weight: var(--weight-semibold);')
    expect(once).toContain(
      'transition: opacity var(--motion-fast) var(--ease-standard);',
    )
    expect(once).toContain('color: rgb(var(--text-1));')
    expect(once).toContain('font: var(--weight-semibold) var(--fs-xs)')
    expect(codemod.transform(once, 'Sample.vue')).toBe(once)
  })

  it.skip('leaves the codemod nothing to change in the renderer', async () => {
    const codemod = await loadCodemod()
    const pending = sources
      .filter(([rel, text]) => codemod.transform(text, rel) !== text)
      .map(([rel]) => rel)
    expect(pending, 'run: node scripts/codemods/tokens-v2.mjs').toEqual([])
  })
})
