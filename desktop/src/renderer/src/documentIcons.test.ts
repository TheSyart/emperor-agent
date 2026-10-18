// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { DOCUMENT_ICONS, documentIcon } from './documentIcons'

describe('documentIcon', () => {
  // Mapping all document/data extensions to one glyph hides file type cues.
  it.each([
    ['notes.md', 'markdown'],
    ['notes.mdx', 'markdown'],
    ['notes.txt', 'text'],
    ['notes.rtf', 'richtext'],
    ['notes.docx', 'word'],
    ['notes.pages', 'pages'],
    ['notes.pdf', 'pdf'],
    ['data.jsonc', 'json'],
    ['data.yml', 'yaml'],
    ['data.toml', 'toml'],
    ['data.tsv', 'csv'],
    ['data.plist', 'xml'],
    ['.env', 'config'],
    ['.env.local', 'config'],
    ['settings.conf', 'config'],
    ['main.tsx', 'typescript'],
    ['main.mjs', 'javascript'],
    ['app.vue', 'vue'],
    ['main.py', 'python'],
    ['main.swift', 'swift'],
    ['main.go', 'go'],
    ['main.rs', 'rust'],
    ['install.zsh', 'shell'],
    ['index.html', 'html'],
    ['theme.css', 'css'],
    ['Main.java', 'code'],
    ['cover.heic', 'image'],
    ['budget.numbers', 'spreadsheet'],
    ['backup.tar.gz', 'archive'],
    ['audio.flac', 'audio'],
    ['demo.mov', 'video'],
    ['LICENSE', 'file'],
    ['unknown.foo', 'file'],
  ])('selects %s as %s', (path, id) => {
    expect(documentIcon(path).id).toBe(id)
  })

  // URL and directory precedence must survive extension-like folder names.
  it('normalizes file links and gives web/folders their own symbols', () => {
    expect(documentIcon('file:///Users/a/README.MD:12:3?raw=1#top').id).toBe(
      'markdown',
    )
    expect(documentIcon('C:\\repo\\MAIN.TS:42').id).toBe('typescript')
    expect(documentIcon('src/main.ts#L3').id).toBe('typescript')
    expect(documentIcon('https://example.com/report.pdf').id).toBe('web')
    expect(documentIcon('folder.json/').id).toBe('folder')
    expect(documentIcon('folder.json', { directory: true }).id).toBe('folder')
    expect(documentIcon('').id).toBe('file')
  })

  // CSS masks containing unescaped quotes or user input can break attributes.
  it('returns a standalone encoded monochrome mask derived from the trusted vector', () => {
    const icon = documentIcon('a" onload="alert(1).ts')
    expect(icon.tone).toBe('blue')
    expect(icon.mask).toMatch(/^data:image\/svg\+xml,/)
    expect(icon.mask).not.toMatch(/[\s"'<>]/)
    const decoded = decodeURIComponent(icon.mask.split(',')[1]!)
    expect(decoded).toBe(icon.svg.replaceAll('currentColor', '#000'))
    expect(decoded).not.toContain('alert')
  })
})

describe('DOCUMENT_ICONS trusted vector catalog', () => {
  // Replacing the catalog with external SVGs or one generic drawing
  // violates the local, individually drawn icon boundary used by v-html.
  it('provides distinct scalable drawings containing only inert SVG geometry', () => {
    expect(DOCUMENT_ICONS.length).toBeGreaterThanOrEqual(31)
    expect(new Set(DOCUMENT_ICONS.map((icon) => icon.id)).size).toBe(
      DOCUMENT_ICONS.length,
    )
    expect(new Set(DOCUMENT_ICONS.map((icon) => icon.svg)).size).toBe(
      DOCUMENT_ICONS.length,
    )
    const allowed = new Set([
      'svg',
      'g',
      'path',
      'rect',
      'circle',
      'ellipse',
      'line',
      'polyline',
      'polygon',
    ])
    for (const icon of DOCUMENT_ICONS) {
      const doc = new DOMParser().parseFromString(icon.svg, 'image/svg+xml')
      expect(doc.querySelector('parsererror'), icon.id).toBeNull()
      expect(doc.documentElement.getAttribute('viewBox'), icon.id).toBe(
        '0 0 24 24',
      )
      expect(
        doc.querySelector(
          'path, rect, circle, ellipse, line, polyline, polygon',
        ),
        icon.id,
      ).not.toBeNull()
      for (const element of doc.querySelectorAll('*')) {
        expect(
          allowed.has(element.localName),
          `${icon.id}: ${element.localName}`,
        ).toBe(true)
        for (const attribute of element.attributes) {
          expect(attribute.name, icon.id).not.toMatch(/^on|href|style/i)
          if (attribute.name === 'fill' || attribute.name === 'stroke')
            expect(attribute.value, icon.id).toMatch(
              /^(?:none|currentColor|#[0-9a-f]{3}|#[0-9a-f]{6})$/i,
            )
        }
      }
    }
  })
})

// Filled language plates must retain contrasting letters in Markdown;
// a monochrome CSS mask turns the entire tile into a blank square.
it('offers an encoded full-color image for filled icons and keeps theme masks for line icons', () => {
  const icon = documentIcon('src/main.ts')
  expect(icon.image).toMatch(/^data:image\/svg\+xml,/)
  const decoded = decodeURIComponent(icon.image!.split(',')[1]!)
  expect(decoded).toContain('#3178C6')
  expect(decoded).toContain('#fff')
  expect(documentIcon('README.md').image).toBeUndefined()
})
