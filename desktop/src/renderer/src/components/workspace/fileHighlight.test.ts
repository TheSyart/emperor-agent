import { describe, expect, it } from 'vitest'
import {
  escapeHtml,
  highlightFile,
  languageForFile,
  splitHighlightedHtml,
} from './fileHighlight'

function spansBalanced(line: string): boolean {
  const opens = line.match(/<span\b/g)?.length ?? 0
  const closes = line.match(/<\/span>/g)?.length ?? 0
  return opens === closes
}

describe('languageForFile', () => {
  it('maps extensions to hljs language ids', () => {
    expect(languageForFile('a.ts')).toBe('typescript')
    expect(languageForFile('App.vue')).toBe('xml')
    expect(languageForFile('index.html')).toBe('xml')
    expect(languageForFile('README.md')).toBe('markdown')
    expect(languageForFile('x.yml')).toBe('yaml')
    expect(languageForFile('Makefile')).toBe('makefile')
  })

  it('falls back to plaintext for unknown names', () => {
    expect(languageForFile('notes.xyz')).toBe('plaintext')
    expect(languageForFile('.gitignore')).toBe('plaintext')
    expect(languageForFile('LICENSE')).toBe('plaintext')
  })
})

describe('splitHighlightedHtml', () => {
  it('closes and reopens spans that straddle newlines', () => {
    const html = '<span class="hljs-comment">/* a\nb */</span>\nplain'
    const lines = splitHighlightedHtml(html)
    expect(lines).toEqual([
      '<span class="hljs-comment">/* a</span>',
      '<span class="hljs-comment">b */</span>',
      'plain',
    ])
    for (const line of lines) expect(spansBalanced(line)).toBe(true)
  })

  it('keeps nested spans balanced per line', () => {
    const html =
      '<span class="hljs-tag">&lt;<span class="hljs-name">div\nspan</span>&gt;</span>'
    const lines = splitHighlightedHtml(html)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(spansBalanced(line)).toBe(true)
  })
})

describe('highlightFile', () => {
  it('escapes html in the plaintext path', () => {
    expect(highlightFile('a.txt', '<b>&</b>')).toEqual({
      highlighted: false,
      lines: ['&lt;b&gt;&amp;&lt;/b&gt;'],
    })
  })

  it('escapes via escapeHtml consistently', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;',
    )
  })

  it('highlights known languages with balanced spans per line', () => {
    const out = highlightFile('a.js', 'const n = 1\n/* c\nstill */\n')
    expect(out.highlighted).toBe(true)
    expect(out.lines).toHaveLength(4)
    expect(out.lines[0]).toContain('hljs-keyword')
    for (const line of out.lines) expect(spansBalanced(line)).toBe(true)
  })

  it('skips highlighting beyond the size cap', () => {
    const big = 'x'.repeat(210 * 1024)
    const out = highlightFile('a.js', big)
    expect(out.highlighted).toBe(false)
    expect(out.lines.join('\n')).toBe(big)
  })

  it('returns an empty-state line for empty content', () => {
    expect(highlightFile('a.js', '')).toEqual({
      highlighted: false,
      lines: [''],
    })
  })
})
