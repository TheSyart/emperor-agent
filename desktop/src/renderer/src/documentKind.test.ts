import { describe, expect, it } from 'vitest'
import { documentGlyph, pathLinkLabel } from './documentKind'

describe('documentGlyph (E-track contract §4)', () => {
  it('sorts extensions into the contract categories', () => {
    const table: Record<string, string[]> = {
      document: ['md', 'markdown', 'mdx', 'txt', 'rtf', 'doc', 'docx', 'pages'],
      pdf: ['pdf'],
      data: [
        'json',
        'jsonc',
        'json5',
        'yaml',
        'yml',
        'toml',
        'csv',
        'tsv',
        'xml',
        'plist',
        'ini',
        'conf',
        'env',
      ],
      code: [
        'java',
        'kt',
        'kts',
        'c',
        'h',
        'cc',
        'cpp',
        'hpp',
        'm',
        'mm',
        'cs',
        'rb',
        'php',
        'sql',
        'scss',
        'less',
        'lua',
        'dart',
        'scala',
        'r',
      ],
      image: [
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'svg',
        'heic',
        'ico',
        'bmp',
        'tif',
        'tiff',
      ],
      sheet: ['xls', 'xlsx', 'numbers'],
      archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'dmg'],
    }
    for (const [kind, extensions] of Object.entries(table))
      for (const extension of extensions)
        expect(documentGlyph(`dir/name.${extension}`).kind, extension).toBe(
          kind,
        )
  })

  it('gives each common language one badge', () => {
    const badges: Record<string, string> = {
      ts: 'TS',
      tsx: 'TS',
      js: 'JS',
      mjs: 'JS',
      cjs: 'JS',
      jsx: 'JS',
      vue: 'VUE',
      py: 'PY',
      swift: 'SW',
      go: 'GO',
      rs: 'RS',
      sh: 'SH',
      bash: 'SH',
      zsh: 'SH',
      html: '<>',
      css: '#',
    }
    for (const [extension, badge] of Object.entries(badges))
      expect(documentGlyph(`a.${extension}`), extension).toMatchObject({
        kind: 'language',
        badge,
      })
    // Same language, same tone.
    expect(documentGlyph('a.tsx').tone).toBe(documentGlyph('a.ts').tone)
    expect(documentGlyph('a.zsh').tone).toBe(documentGlyph('a.sh').tone)
  })

  it('reads the last extension, any case, past a line or query', () => {
    expect(documentGlyph('dist/app.tar.gz').kind).toBe('archive')
    expect(documentGlyph('types/index.d.ts').badge).toBe('TS')
    expect(documentGlyph('README.MD').kind).toBe('document')
    expect(documentGlyph('src/app.ts#L12').badge).toBe('TS')
    expect(documentGlyph('file:///Users/a/Report.PDF').kind).toBe('pdf')
    expect(documentGlyph('/Users/a/b.png?raw=1').kind).toBe('image')
    expect(documentGlyph('.env').kind).toBe('data')
  })

  it('knows folders, web pages and everything else', () => {
    expect(documentGlyph('packages/core/').kind).toBe('folder')
    expect(documentGlyph('packages/core', { directory: true }).kind).toBe(
      'folder',
    )
    expect(documentGlyph('https://example.com/a.pdf').kind).toBe('web')
    for (const other of ['Makefile', 'LICENSE', 'a.xyz', '.gitignore'])
      expect(documentGlyph(other).kind, other).toBe('file')
  })
})

describe('pathLinkLabel', () => {
  it('shortens a label that is the path to the file name', () => {
    expect(pathLinkLabel('src/app.ts', 'src/app.ts')).toBe('app.ts')
    expect(pathLinkLabel('src/app.ts:12', 'src/app.ts#L12')).toBe('app.ts:12')
    expect(
      pathLinkLabel('packages/core/src/x.ts', '/repo/packages/core/src/x.ts'),
    ).toBe('x.ts')
    expect(pathLinkLabel('file:///Users/a/b.md', 'file:///Users/a/b.md')).toBe(
      'b.md',
    )
    expect(pathLinkLabel('docs/design/', 'docs/design/')).toBe('design')
    expect(pathLinkLabel('C:\\work\\a.txt', 'C:\\work\\a.txt')).toBe('a.txt')
  })

  it('keeps readable labels', () => {
    expect(pathLinkLabel('设计说明', 'docs/design.md')).toBeNull()
    expect(pathLinkLabel('app.ts', 'src/app.ts')).toBeNull()
    expect(pathLinkLabel('input/output', 'docs/io.md')).toBeNull()
    expect(pathLinkLabel('see src/app.ts', 'src/app.ts')).toBeNull()
  })
})
