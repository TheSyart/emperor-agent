import { describe, expect, it } from 'vitest'
import {
  delimiterFor,
  fileBadge,
  fileTypeLabel,
  formatFileSize,
  formatFileTime,
  isMarkdownName,
  isSvgName,
  parseDelimited,
} from './filePreviewModel'

// BUG-10: what the Files pane writes about a file it cannot show, and how
// it reads CSV / TSV into a table.

describe('file preview model (BUG-10)', () => {
  it('names a file by its type, with a short badge', () => {
    expect(fileTypeLabel('素材打包.zip')).toBe('ZIP 压缩包')
    expect(fileTypeLabel('需求说明.docx')).toBe('Word 文档')
    expect(fileTypeLabel('report.PDF')).toBe('PDF 文档')
    expect(fileTypeLabel('deck.key')).toBe('Keynote 演示文稿')
    expect(fileTypeLabel('setup.dmg')).toBe('磁盘映像')
    expect(fileTypeLabel('data.parquet')).toBe('PARQUET 文件')
    expect(fileTypeLabel('Makefile')).toBe('文件')
    expect(fileBadge('素材打包.zip')).toBe('ZIP')
    expect(fileBadge('archive.tar.gz')).toBe('GZ')
    expect(fileBadge('Makefile')).toBe('文件')
    expect(fileBadge('model.safetensors')).toBe('SAFE')
  })

  it('writes sizes as people read them', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(84 * 1024)).toBe('84 KB')
    expect(formatFileSize(48.6 * 1024 * 1024)).toBe('48.6 MB')
    expect(formatFileSize(1.2 * 1024 ** 3)).toBe('1.2 GB')
  })

  it('says when a file changed: today, yesterday, a date, a year', () => {
    const now = new Date(2026, 9, 25, 18, 0).getTime()
    expect(formatFileTime(new Date(2026, 9, 25, 14, 20).getTime(), now)).toBe(
      '今天 14:20',
    )
    expect(formatFileTime(new Date(2026, 9, 24, 9, 5).getTime(), now)).toBe(
      '昨天 09:05',
    )
    expect(formatFileTime(new Date(2026, 9, 16, 8, 0).getTime(), now)).toBe(
      '10月16日 08:00',
    )
    expect(formatFileTime(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe(
      '2025年12月31日 23:59',
    )
  })

  it('knows Markdown, SVG and the two table formats by name', () => {
    for (const name of ['a.md', 'a.markdown', 'A.MDOWN', 'a.mkd'])
      expect(isMarkdownName(name), name).toBe(true)
    expect(isMarkdownName('a.mdx')).toBe(false)
    expect(isSvgName('logo.SVG')).toBe(true)
    expect(delimiterFor('sales.csv')).toBe(',')
    expect(delimiterFor('sales.TSV')).toBe('\t')
    expect(delimiterFor('sales.txt')).toBeNull()
  })

  it('10 · reads quoted CSV fields, commas, quotes and line breaks in them', () => {
    const table = parseDelimited(
      '日期,渠道,备注\r\n10-21,京东,"满 199, 减 20"\n10-22,天猫,"说 ""好"""\n10-23,抖音,"两\n行"\n',
      ',',
    )
    expect(table.header).toEqual(['日期', '渠道', '备注'])
    expect(table.rows).toEqual([
      ['10-21', '京东', '满 199, 减 20'],
      ['10-22', '天猫', '说 "好"'],
      ['10-23', '抖音', '两\n行'],
    ])
    expect(table).toMatchObject({
      columns: 3,
      moreRows: false,
      moreColumns: false,
    })
    expect(parseDelimited('a\tb\n1\t2\n', '\t').rows).toEqual([['1', '2']])
  })

  it('10 · keeps the first 2000 rows and 50 columns', () => {
    const wide = Array.from({ length: 60 }, (_, index) => `c${index}`).join(',')
    const lines = [wide, ...Array.from({ length: 2100 }, (_, i) => `${i},x`)]
    const table = parseDelimited(lines.join('\n'), ',')
    expect(table.header).toHaveLength(50)
    expect(table.rows).toHaveLength(2000)
    expect(table.rows[1999]).toEqual(['1999', 'x'])
    expect(table).toMatchObject({
      columns: 50,
      moreRows: true,
      moreColumns: true,
    })
  })
})
