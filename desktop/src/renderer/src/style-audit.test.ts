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

describe('style audit: color convergence', () => {  it('no bare hex colors outside theme/*.css', () => {
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
