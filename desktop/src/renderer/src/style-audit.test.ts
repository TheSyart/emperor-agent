import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
const VUE_FILES = [
  ...collect('components', ['.vue']),
  ...collect('views', ['.vue']),
]
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
    const aliasVar =
      /var\(--(?:paper|paper-2|ink|muted|line|seal|jade|amber)\b/g
    const offenders: string[] = []
    for (const rel of SCANNED) {
      const hits = read(rel).match(aliasVar)
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
    // Δ≤2px 的值必须归位到 var(--radius-*);偏差更大的保留值登记于此白名单。
    const KEEP = new Set([
      'rounded-[1.05rem]',
      'rounded-[1.1rem]',
      'rounded-[1.4rem]',
      'rounded-[1.45rem]',
      'rounded-[1.5rem]',
      'rounded-[1.6rem]',
      'rounded-[1.7rem]',
    ])
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

  const SPACING_BASELINE: Record<string, number> = {
    'styles/activity.css': 9,
    'styles/chat.css': 9,
    'styles/panels.css': 17,
    'styles/workspace.css': 129,
    // codex-v2.css 的 212 处裸间距随表面拆分迁到 surfaces/*(纯移动),按文件记录基线。
    'styles/surfaces/shell-base.css': 20,
    'styles/surfaces/messages.css': 16,
    'styles/surfaces/goal.css': 31,
    'styles/surfaces/composer.css': 8,
    'styles/surfaces/cards.css': 15,
    'styles/surfaces/decision.css': 32,
    'styles/surfaces/menus.css': 26,
    'styles/surfaces/panels.css': 15,
    'styles/surfaces/sidebar.css': 20,
    'styles/surfaces/settings.css': 22,
    'components/chat/QueueTray.vue': 4,
    'components/chat/ComposerLifecycleIndicator.vue': 2,
    'components/panels/FileCheckpointsSection.vue': 2,
    'components/panels/EnvironmentDiagnosticsSection.vue': 9,
    'components/panels/ModelPanel.vue': 18,
    'components/panels/HooksPanel.vue': 9,
    'components/panels/SkillsPanel.vue': 2,
    'components/panels/model/ModelEntryList.vue': 5,
    'components/commands/CommandCenterDialog.vue': 9,
    'views/PetView.vue': 7,
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

