import { describe, expect, it } from 'vitest'
import { HTML_CONVERT_MAX_CHARS, htmlToMarkdown } from './html-markdown'

describe('htmlToMarkdown', () => {
  it('converts content and drops what a reader never sees', () => {
    const result = htmlToMarkdown(
      `<html><head><title> A &lt;b&gt; title </title>
        <script>var close = "</div>"; document.write('<p>fake</p>')</script>
        <style>p { color: red }</style></head>
      <body><!-- <p>commented</p> -->
        <h2>Part</h2><p>See <a href="next">next</a> and <a href="#here">here</a>.</p>
        <pre><code class="language-ts">const a = 1 &lt; 2</code></pre>
        <p aria-hidden="true">aria hidden</p><input type="hidden" value="token">
        <img src="/logo.png" alt="Logo"><img src="data:image/png;base64,AA" alt="">
        <svg><text>vector text</text></svg>
      </body></html>`,
      { baseUrl: 'https://docs.example/guide/' },
    )
    expect(result).toMatchObject({
      title: 'A <b> title',
      sourceTruncated: false,
      plainText: false,
    })
    expect(result.markdown).toContain('## Part')
    expect(result.markdown).toContain(
      'See [next](https://docs.example/guide/next) and here.',
    )
    expect(result.markdown).toContain('```ts\nconst a = 1 < 2\n```')
    expect(result.markdown).toContain('![Logo](https://docs.example/logo.png)')
    for (const unseen of [
      'fake',
      'color: red',
      'commented',
      'aria hidden',
      'token',
      'vector text',
      'data:image',
    ])
      expect(result.markdown).not.toContain(unseen)
  })

  it('converts a bounded prefix of a huge page and reports the cut', () => {
    const paragraph = '<p>Some words in a paragraph.</p>'
    const html = `<body>${paragraph.repeat(40_000)}</body>`
    expect(html.length).toBeGreaterThan(HTML_CONVERT_MAX_CHARS)
    const started = Date.now()
    const result = htmlToMarkdown(html)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result.sourceTruncated).toBe(true)
    expect(result.markdown.length).toBeLessThan(HTML_CONVERT_MAX_CHARS)
    expect(result.markdown).not.toContain('<p')
  })

  it('returns plain text for pathological nesting instead of parsing it', () => {
    for (const html of [
      `<p>start</p>${'<div>'.repeat(5_000)}deep text${'</div>'.repeat(5_000)}`,
      `${'<table><tr><td>'.repeat(3_000)}cell`,
    ]) {
      const started = Date.now()
      const result = htmlToMarkdown(html)
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(result.plainText).toBe(true)
      expect(result.markdown).toMatch(/deep text|cell/)
    }
    // Flat tables without end tags are not deep.
    const flat = htmlToMarkdown(
      `<table>${'<tr><td>a<td>b'.repeat(2_000)}</table>`,
    )
    expect(flat.plainText).toBe(false)
  })

  it('survives unterminated markup', () => {
    expect(
      htmlToMarkdown(`<p>kept</p>${'<script>'.repeat(10_000)}`).markdown,
    ).toBe('kept')
    expect(htmlToMarkdown('<p class=a"b>after an odd quote</p>').markdown).toBe(
      'after an odd quote',
    )
    expect(htmlToMarkdown('<p>text</p><div title="never closed').markdown).toBe(
      'text',
    )
    expect(htmlToMarkdown('<title>untitled').title).toBe('untitled')
  })
})
