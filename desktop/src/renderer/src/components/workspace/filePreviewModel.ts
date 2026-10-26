/**
 * Pure helpers of the Files pane's previews (BUG-10): what a file is
 * called when it cannot be shown, when it changed, which names are
 * Markdown, SVG or a table, and CSV / TSV read into a table (RFC 4180
 * quoting: commas, quotes and line breaks inside quoted fields).
 */

/** Chinese names of the types people meet; anything else is `EXT 文件`. */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  zip: 'ZIP 压缩包',
  rar: 'RAR 压缩包',
  '7z': '7z 压缩包',
  gz: 'Gzip 压缩包',
  tgz: 'Gzip 压缩包',
  tar: 'TAR 归档',
  dmg: '磁盘映像',
  iso: '光盘映像',
  pkg: '安装包',
  app: '应用程序',
  exe: 'Windows 程序',
  command: '终端脚本',
  sh: 'Shell 脚本',
  pdf: 'PDF 文档',
  doc: 'Word 文档',
  docx: 'Word 文档',
  xls: 'Excel 表格',
  xlsx: 'Excel 表格',
  ppt: 'PowerPoint 演示文稿',
  pptx: 'PowerPoint 演示文稿',
  pages: 'Pages 文稿',
  numbers: 'Numbers 表格',
  key: 'Keynote 演示文稿',
  rtf: 'RTF 文档',
  odt: 'OpenDocument 文档',
  psd: 'Photoshop 文档',
  sketch: 'Sketch 文档',
  fig: 'Figma 文件',
  ttf: '字体',
  otf: '字体',
  woff: '字体',
  woff2: '字体',
  sqlite: 'SQLite 数据库',
  db: '数据库',
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLocaleLowerCase() : ''
}

export function fileTypeLabel(name: string): string {
  const extension = extensionOf(name)
  if (!extension) return '文件'
  return TYPE_LABELS[extension] ?? `${extension.toUpperCase()} 文件`
}

/** The few letters on the card's file glyph. */
export function fileBadge(name: string): string {
  const extension = extensionOf(name)
  return extension ? extension.slice(0, 4).toUpperCase() : '文件'
}

/** `512 B`, `84 KB`, `48.6 MB`, `1.2 GB`. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** `今天 14:20`, `昨天 09:05`, `10月16日 08:00`, `2025年12月31日 23:59`. */
export function formatFileTime(ms: number, now: number = Date.now()): string {
  const date = new Date(ms)
  const today = new Date(now)
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime()
  if (ms >= startOfToday) return `今天 ${time}`
  if (ms >= startOfToday - 86_400_000) return `昨天 ${time}`
  const year =
    date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}年`
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

export function isMarkdownName(name: string): boolean {
  return /(?:^|\.)(?:md|markdown|mdown|mkd)$/i.test(name)
}

export function isSvgName(name: string): boolean {
  return /\.svg$/i.test(name)
}

/** `,` for CSV, a tab for TSV, null for anything else. */
export function delimiterFor(name: string): ',' | '\t' | null {
  if (/\.csv$/i.test(name)) return ','
  if (/\.tsv$/i.test(name)) return '\t'
  return null
}

export interface DelimitedTable {
  header: string[]
  rows: string[][]
  /** Columns shown (at most maxColumns). */
  columns: number
  moreRows: boolean
  moreColumns: boolean
}

/** CSV / TSV into a header and rows: the first 2000 rows, 50 columns. */
export function parseDelimited(
  text: string,
  delimiter: ',' | '\t',
  limits: { maxRows?: number; maxColumns?: number } = {},
): DelimitedTable {
  const maxRows = limits.maxRows ?? 2000
  const maxColumns = limits.maxColumns ?? 50
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let moreRows = false
  let widest = 0
  const endRecord = () => {
    record.push(field)
    field = ''
    widest = Math.max(widest, record.length)
    records.push(record)
    record = []
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quoted) {
      if (char !== '"') field += char
      else if (text[index + 1] === '"') {
        field += '"'
        index += 1
      } else quoted = false
      continue
    }
    if (char === '"' && field === '') quoted = true
    else if (char === delimiter) {
      record.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      endRecord()
      // The header and maxRows rows; anything after means there is more.
      if (records.length > maxRows) {
        moreRows = text.slice(index + 1).trim().length > 0
        break
      }
    } else field += char
  }
  if (records.length <= maxRows && (field !== '' || record.length > 0))
    endRecord()
  const columns = Math.min(widest, maxColumns)
  const [header = [], ...rows] = records.map((row) => row.slice(0, maxColumns))
  return {
    header,
    rows,
    columns,
    moreRows,
    moreColumns: widest > maxColumns,
  }
}
