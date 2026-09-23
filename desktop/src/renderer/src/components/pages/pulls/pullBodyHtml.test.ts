// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { externalHref, neutralizeRemoteImages } from './pullBodyHtml'

describe('neutralizeRemoteImages', () => {
  it('turns https images into links and drops other sources', () => {
    const html =
      '<p>before <img src="https://example.com/a.png" alt="截图"> after</p>' +
      '<p><img src="http://tracker.test/p.gif"><img src="x.png" alt=""></p>'
    const out = neutralizeRemoteImages(html)
    expect(out).not.toContain('<img')
    expect(out).toContain(
      '<a href="https://example.com/a.png" data-pr-image="" class="pr-md-image">图片：截图</a>',
    )
    expect(out).toContain('<span class="pr-md-image">图片：未命名</span>')
    expect(out).not.toContain('tracker.test')
  })

  it('leaves image-free html untouched', () => {
    const html = '<p><strong>hi</strong> <a href="https://x.test">x</a></p>'
    expect(neutralizeRemoteImages(html)).toBe(html)
  })

  it('is a no-op without a document', () => {
    expect(neutralizeRemoteImages('<img src="https://a">', null)).toBe(
      '<img src="https://a">',
    )
  })
})

describe('externalHref', () => {
  function anchor(href: string | null): HTMLAnchorElement {
    const a = document.createElement('a')
    if (href !== null) a.setAttribute('href', href)
    return a
  }

  it('accepts http(s) links only', () => {
    expect(externalHref(anchor('https://github.com/acme/x/pull/1'))).toBe(
      'https://github.com/acme/x/pull/1',
    )
    expect(externalHref(anchor('http://example.com'))).toBe(
      'http://example.com/',
    )
    expect(externalHref(anchor('docs/readme.md'))).toBeNull()
    expect(externalHref(anchor('#section'))).toBeNull()
    expect(externalHref(anchor('file:///etc/passwd'))).toBeNull()
    expect(externalHref(anchor('https://user:pw@example.com'))).toBeNull()
    expect(externalHref(anchor(null))).toBeNull()
    expect(externalHref(null)).toBeNull()
  })
})
