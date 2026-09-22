import { describe, expect, it } from 'vitest'
import {
  buildDiffRows,
  contentLines,
  diffCopyText,
  diffFooter,
} from './diffRows'

describe('diffRows', () => {
  it('treats a trailing newline as a terminator', () => {
    expect(contentLines('')).toEqual([])
    expect(contentLines('a\n')).toEqual(['a'])
    expect(contentLines('a\n\n')).toEqual(['a', ''])
  })

  it('collapses long unchanged runs into gaps with 3 lines of context', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`)
    const after = [...before]
    after[10] = 'CHANGED'
    const result = buildDiffRows([
      { path: 'f.txt', oldText: before.join('\n'), newText: after.join('\n') },
    ])
    expect(result.rows.map((r) => `${r.kind}:${r.text}`)).toEqual([
      'path:f.txt',
      'gap:⋯',
      'ctx:l7',
      'ctx:l8',
      'ctx:l9',
      'del:l10',
      'add:CHANGED',
      'ctx:l11',
      'ctx:l12',
      'ctx:l13',
    ])
    const del = result.rows.find((r) => r.kind === 'del')
    expect(del?.oldNo).toBe(11)
    expect(result).toMatchObject({ added: 1, removed: 1, files: 1 })
  })

  it('uses a gap row for a second hunk in the same file and counts distinct files', () => {
    const result = buildDiffRows([
      { path: 'a', oldText: 'x', newText: 'y' },
      { path: 'a', oldText: 'p', newText: 'q' },
    ])
    expect(result.rows.map((r) => r.kind)).toEqual([
      'path',
      'del',
      'add',
      'gap',
      'del',
      'add',
    ])
    expect(diffFooter(result)).toBe('└ +2 -2 · 1 file')
    expect(diffCopyText(result.rows)).toBe('a\n- x\n+ y\n⋯\n- p\n+ q')
  })
})
