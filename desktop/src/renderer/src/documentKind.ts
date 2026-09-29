/**
 * What a linked document is, from its path (E-track contract §4): the icon
 * category, and for common languages a short badge with a theme tone. Used
 * by document links in replies (useMarkdown) and the environment card's
 * sources. Pure; icons are drawn by the component that shows them.
 */

export type DocumentKind =
  | 'document'
  | 'pdf'
  | 'data'
  | 'language'
  | 'code'
  | 'image'
  | 'sheet'
  | 'archive'
  | 'folder'
  | 'web'
  | 'file'

/** Theme colour of a badge (a token, never a literal colour). */
export type DocumentTone =
  'blue' | 'warn' | 'ok' | 'cyan' | 'brand' | 'accent' | 'danger'

export interface DocumentGlyph {
  kind: DocumentKind
  /** Short text drawn as the icon (languages, PDF). */
  badge?: string
  tone?: DocumentTone
}

const KINDS: Array<[Exclude<DocumentKind, 'language'>, string]> = [
  ['document', 'md markdown mdx txt rtf doc docx pages'],
  ['data', 'json jsonc json5 yaml yml toml csv tsv xml plist ini conf env'],
  [
    'code',
    'java kt kts c h cc cpp hpp m mm cs rb php sql scss less lua dart scala r',
  ],
  ['image', 'png jpg jpeg gif webp svg heic ico bmp tif tiff'],
  ['sheet', 'xls xlsx numbers'],
  ['archive', 'zip tar gz tgz bz2 xz 7z rar dmg'],
]

const LANGUAGES: Array<[string, DocumentTone, string]> = [
  ['TS', 'blue', 'ts tsx'],
  ['JS', 'warn', 'js mjs cjs jsx'],
  ['VUE', 'ok', 'vue'],
  ['PY', 'cyan', 'py'],
  ['SW', 'brand', 'swift'],
  ['GO', 'cyan', 'go'],
  ['RS', 'brand', 'rs'],
  ['SH', 'ok', 'sh bash zsh'],
  ['<>', 'brand', 'html'],
  ['#', 'accent', 'css'],
]

const BY_EXTENSION = new Map<string, DocumentGlyph>([
  ['pdf', { kind: 'pdf', badge: 'PDF', tone: 'danger' }],
])
for (const [kind, extensions] of KINDS)
  for (const extension of extensions.split(' '))
    BY_EXTENSION.set(extension, { kind })
for (const [badge, tone, extensions] of LANGUAGES)
  for (const extension of extensions.split(' '))
    BY_EXTENSION.set(extension, { kind: 'language', badge, tone })

/** The path part of a link target: no `file://`, query or fragment. */
function targetPath(target: string): string {
  return target.replace(/^file:\/\//i, '').replace(/[?#].*$/, '')
}

function lastSegment(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
}

/** `:12` or `:12:3` after a file name. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/

export function documentGlyph(
  target: string,
  options: { directory?: boolean } = {},
): DocumentGlyph {
  if (/^https?:\/\//i.test(target)) return { kind: 'web' }
  const path = targetPath(target)
  if (options.directory || /[\\/]$/.test(path)) return { kind: 'folder' }
  const name = lastSegment(path).replace(LINE_SUFFIX, '')
  const dot = name.lastIndexOf('.')
  const glyph =
    dot < 0 ? undefined : BY_EXTENSION.get(name.slice(dot + 1).toLowerCase())
  return glyph ? { ...glyph } : { kind: 'file' }
}

/**
 * The file name to show for a link whose label is its path (`src/a.ts` →
 * `a.ts`, `src/a.ts:12` → `a.ts:12`); null when the label reads as words.
 */
export function pathLinkLabel(label: string, target: string): string | null {
  const text = label.trim()
  if (!text || /\s/.test(text) || !/[\\/]/.test(text)) return null
  const name = lastSegment(text.replace(/^file:\/\//i, ''))
  const bare = name.replace(LINE_SUFFIX, '')
  if (!bare || bare !== lastSegment(targetPath(target))) return null
  return name
}
