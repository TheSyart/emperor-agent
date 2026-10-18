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
  it('routes local markdown images through owned previews instead of loading filesystem or bundle paths', () => {
    for (const path of [
      '/Users/me/sun.png',
      'images/sun.png',
      'file:///Users/me/sun.png',
    ]) {
      const html = render(`![太阳](${path})`)
      expect(html).toContain('data-md-image=')
      expect(html).not.toMatch(/\ssrc=/)
    }
    expect(render('![web](https://example.com/sun.png)')).toContain(
      'src="https://example.com/sun.png"',
    )
  })
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
  it('identifies GitHub objects and uses the individually drawn file vectors', () => {
    expect(render('[PR](https://github.com/a/b/pull/42)')).toContain(
      'data-resource-type="pull_request"',
    )
    expect(render('[config](a.yaml)')).toContain('data-md-custom-icon="yaml"')
    expect(render('[markdown](README.md)')).toContain(
      'data-md-custom-icon="markdown"',
    )
    expect(render('[config](a.yaml)')).toContain('--md-link-image:')
    expect(render('[config](a.yaml)')).toContain('data-md-color="true"')
    expect(render('[README](README.md)')).toContain('--md-link-ico:')
  })
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

  it('keeps long URLs, queries and fragments complete', () => {
    const url =
      'https://example.com/very/long/path/that/goes/on/and/on/and/on/forever/xyz?view=full#section'
    const html = render(url)
    expect(html).toContain(
      `>example.com${url.slice('https://example.com'.length)}</a>`,
    )
    expect(html).not.toContain('…</a>')
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

describe('document links (E-track contract §4)', () => {
  it('marks each link with its type icon', () => {
    expect(render('[a](src/app.ts)')).toMatch(
      /data-md-icon="language"[^>]*data-md-badge="TS"[^>]*data-md-tone="blue"/,
    )
    expect(render('[a](docs/guide.md)')).toContain('data-md-icon="document"')
    expect(render('[a](/Users/a/data.json)')).toContain('data-md-icon="data"')
    expect(render('[a](https://example.com)')).toContain('data-md-icon="web"')
    expect(render('[a](file:///Users/a/r.pdf)')).toContain('data-md-icon="pdf"')
  })

  it('treats a relative path ending in / as a folder link', () => {
    const html = render('[packages/core/](packages/core/)')
    expect(html).toContain('data-md-link="file"')
    expect(html).toContain('data-md-icon="folder"')
    expect(html).toContain('>core</a>')
  })

  it('shows only the file name when the label is the path', () => {
    expect(render('[src/app.ts](src/app.ts)')).toContain('>app.ts</a>')
    expect(render('[src/app.ts:12](src/app.ts#L12)')).toContain(
      '>app.ts:12</a>',
    )
    // A path written as code still becomes the plain file name.
    expect(render('[`src/app.ts`](src/app.ts)')).toContain('>app.ts</a>')
    expect(render('[设计说明](docs/design.md)')).toContain('>设计说明</a>')
    expect(render('[input/output](docs/io.md)')).toContain('>input/output</a>')
    // Web links keep their text.
    expect(render('[a/b](https://example.com/a/b)')).toContain('>a/b</a>')
  })

  it('keeps the full path for the hover title', () => {
    expect(render('[src/app.ts](src/app.ts)')).toContain('title="src/app.ts"')
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
    expect(classifyMdLink('README.md:12:3')).toBe('file')
    expect(classifyMdLink('javascript:12')).toBeNull()
  })
})

it('keeps CJK punctuation outside automatically linked URLs', () => {
  const html = render('参考 https://example.com/guide，再看说明。')
  expect(html).toContain('href="https://example.com/guide"')
  expect(html).toContain('</a>，再看说明。')
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
