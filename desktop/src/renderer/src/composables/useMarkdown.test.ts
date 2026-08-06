import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import {
  classifyMdLink,
  hrefToFilePath,
  sanitizeHtml,
  useMarkdown,
} from './useMarkdown'

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

  it('keeps file: hrefs and target on link chips', () => {
    const clean = sanitizeHtml(
      '<a href="file:///a/b.pdf" target="_blank" class="md-link-chip">f</a>',
    )
    expect(clean).toContain('href="file:///a/b.pdf"')
    expect(clean).toContain('target="_blank"')
  })
})

describe('link chips', () => {
  it('marks http(s) links as web chips with safe-open attrs', () => {
    const html = render('[t](https://example.com/p)')
    expect(html).toContain('class="md-link-chip"')
    expect(html).toContain('data-md-link="web"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('href="https://example.com/p"')
  })

  it('marks file:// links as file chips with a lowercased extension', () => {
    const html = render('[f](file:///Users/a%20b/report.pdf)')
    expect(html).toContain('data-md-link="file"')
    expect(html).toContain('data-md-ext="pdf"')
    expect(html).toContain('href="file:///Users/a%20b/report.pdf"')
  })

  it('marks POSIX absolute paths as file chips', () => {
    const html = render('[rel](/Users/a/b.md)')
    expect(html).toContain('data-md-link="file"')
    expect(html).toContain('data-md-ext="md"')
  })

  it('marks Windows drive paths as file chips (percent-decoded for classify)', () => {
    const html = render('[win](C:\\work\\a.txt)')
    expect(html).toContain('data-md-link="file"')
    expect(html).toContain('data-md-ext="txt"')
  })

  it('shortens bare autolinked URLs to host + path', () => {
    const html = render(
      'bare https://doc.dmxapi.cn/gpt-image-2-text-to-image.html end',
    )
    expect(html).toContain('>doc.dmxapi.cn/gpt-image-2-text-to-image.html</a>')
    expect(html).toContain('data-md-link="web"')
  })

  it('truncates very long autolinked URLs', () => {
    const html = render(
      'https://example.com/very/long/path/that/goes/on/and/on/and/on/forever/xyz',
    )
    expect(html).toContain('…</a>')
  })

  it('does not chip links inside code spans', () => {
    const html = render('`[c](https://e.com)` and `https://bare.com`')
    expect(html).not.toContain('md-link-chip')
    expect(html).toContain('<code>[c](https://e.com)</code>')
  })

  it('leaves mailto and in-page anchors as plain links', () => {
    expect(render('[m](mailto:a@b.c)')).not.toContain('md-link-chip')
    expect(render('[a](#sec)')).not.toContain('md-link-chip')
  })
})

describe('classifyMdLink', () => {
  it('classifies web, file, and non-chip links', () => {
    expect(classifyMdLink('https://a.com')).toBe('web')
    expect(classifyMdLink('http://a.com')).toBe('web')
    expect(classifyMdLink('file:///a/b.pdf')).toBe('file')
    expect(classifyMdLink('/Users/a/b.md')).toBe('file')
    expect(classifyMdLink('C:\\work\\a.txt')).toBe('file')
    expect(classifyMdLink('C:/work/a.txt')).toBe('file')
    expect(classifyMdLink('mailto:a@b.c')).toBeNull()
    expect(classifyMdLink('#anchor')).toBeNull()
    expect(classifyMdLink('relative/path.md')).toBe('file')
    expect(classifyMdLink('./src/main.ts#L42')).toBe('file')
  })
})

describe('hrefToFilePath', () => {
  it('decodes file:// URLs and strips the Windows drive slash', () => {
    expect(hrefToFilePath('file:///Users/a%20b/report.pdf')).toBe(
      '/Users/a b/report.pdf',
    )
    expect(hrefToFilePath('file:///C:/work/a.txt')).toBe('C:/work/a.txt')
  })

  it('decodes percent-encoded absolute paths', () => {
    expect(hrefToFilePath('/Users/a%20b/c.md')).toBe('/Users/a b/c.md')
    expect(hrefToFilePath('C:%5Cwork%5Ca.txt')).toBe('C:\\work\\a.txt')
  })
})
