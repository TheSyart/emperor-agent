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
const VUE_FILES = [
  ...collect('components', ['.vue']),
  ...collect('views', ['.vue']),
]
const SCANNED = [...STYLE_FILES, ...VUE_FILES]

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf-8')
}

describe('style audit: color convergence', () => {
  it('no bare hex colors outside theme/*.css', () => {
    const offenders: string[] = []
    for (const rel of SCANNED) {
      const hits = read(rel).match(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b/g)
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
