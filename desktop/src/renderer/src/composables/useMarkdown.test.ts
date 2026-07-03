import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { sanitizeHtml, useMarkdown } from './useMarkdown'

function render(source: string): string {
  return useMarkdown(ref(source)).rendered.value
}

// 核验记录（Wave1.4）：markdown-it `html:false` + validateLink 已把下述载荷全部钝化
// （原样转义/拒绝成链/困在引号属性里），改造前即安全；DOMPurify 是防御纵深，
// 防的是未来配置漂移（如误开 html:true）而不是现存漏洞。
describe('useMarkdown rendering safety (Wave1.4)', () => {
  it('renders raw HTML injection attempts as escaped text, not tags', () => {
    const html = render('<img src=x onerror=alert(1)>')
    expect(html).not.toMatch(/<img[^>]*onerror/i)
  })

  it('refuses javascript: URLs as link targets', () => {
    const html = render('[click](javascript:alert(1))')
    expect(html).not.toMatch(/href\s*=\s*["']javascript:/i)
  })

  it('keeps normal markdown rendering intact', () => {
    const html = render('**bold** and [link](https://example.com) and `code`')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('<code>code</code>')
  })
})

describe('sanitizeHtml hardening layer (Wave1.4)', () => {
  it('strips event handlers from raw HTML', () => {
    const clean = sanitizeHtml('<img src="x" onerror="alert(1)">')
    expect(clean).not.toContain('onerror')
  })

  it('strips script tags entirely', () => {
    const clean = sanitizeHtml('<p>ok</p><script>alert(1)</script>')
    expect(clean).toContain('<p>ok</p>')
    expect(clean).not.toContain('<script')
  })

  it('strips javascript: hrefs while keeping the anchor text', () => {
    const clean = sanitizeHtml('<a href="javascript:alert(1)">x</a>')
    expect(clean).not.toContain('javascript:')
    expect(clean).toContain('x')
  })

  it('preserves markdown-it output unchanged', () => {
    const html = render('**bold** and [link](https://example.com)')
    expect(sanitizeHtml(html)).toBe(html)
  })
})
