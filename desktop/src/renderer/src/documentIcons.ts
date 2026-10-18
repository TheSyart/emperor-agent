/**
 * Hand-drawn 24 × 24 resource glyphs. The checked-in SVGs are the single
 * source for inline rendering, full-color CSS images and theme masks; filenames only select a glyph.
 */
import markdown from './assets/document-icons/markdown.svg?raw'
import text from './assets/document-icons/text.svg?raw'
import richtext from './assets/document-icons/richtext.svg?raw'
import word from './assets/document-icons/word.svg?raw'
import pages from './assets/document-icons/pages.svg?raw'
import pdf from './assets/document-icons/pdf.svg?raw'
import json from './assets/document-icons/json.svg?raw'
import yaml from './assets/document-icons/yaml.svg?raw'
import toml from './assets/document-icons/toml.svg?raw'
import csv from './assets/document-icons/csv.svg?raw'
import xml from './assets/document-icons/xml.svg?raw'
import config from './assets/document-icons/config.svg?raw'
import typescript from './assets/document-icons/typescript.svg?raw'
import javascript from './assets/document-icons/javascript.svg?raw'
import vue from './assets/document-icons/vue.svg?raw'
import python from './assets/document-icons/python.svg?raw'
import swift from './assets/document-icons/swift.svg?raw'
import go from './assets/document-icons/go.svg?raw'
import rust from './assets/document-icons/rust.svg?raw'
import shell from './assets/document-icons/shell.svg?raw'
import html from './assets/document-icons/html.svg?raw'
import css from './assets/document-icons/css.svg?raw'
import code from './assets/document-icons/code.svg?raw'
import image from './assets/document-icons/image.svg?raw'
import spreadsheet from './assets/document-icons/spreadsheet.svg?raw'
import archive from './assets/document-icons/archive.svg?raw'
import folder from './assets/document-icons/folder.svg?raw'
import web from './assets/document-icons/web.svg?raw'
import file from './assets/document-icons/file.svg?raw'
import audio from './assets/document-icons/audio.svg?raw'
import video from './assets/document-icons/video.svg?raw'
import { documentGlyph, type DocumentTone } from './documentKind'

const DRAWINGS = {
  markdown,
  text,
  richtext,
  word,
  pages,
  pdf,
  json,
  yaml,
  toml,
  csv,
  xml,
  config,
  typescript,
  javascript,
  vue,
  python,
  swift,
  go,
  rust,
  shell,
  html,
  css,
  code,
  image,
  spreadsheet,
  archive,
  folder,
  web,
  file,
  audio,
  video,
} as const

export type DocumentIconId = keyof typeof DRAWINGS

export interface DocumentIconAsset {
  readonly id: DocumentIconId
  readonly svg: string
  /** Encoded monochrome SVG data URL, safe inside a quoted CSS url(). */
  readonly mask: string
  /** Present for filled color art; render as an image, never as a mask. */
  readonly image?: string
  readonly tone?: DocumentTone
}

const TONES: Partial<Record<DocumentIconId, DocumentTone>> = {
  word: 'blue',
  pages: 'brand',
  pdf: 'danger',
  json: 'warn',
  yaml: 'accent',
  toml: 'brand',
  csv: 'ok',
  xml: 'cyan',
  typescript: 'blue',
  javascript: 'warn',
  vue: 'ok',
  python: 'cyan',
  swift: 'brand',
  go: 'cyan',
  rust: 'brand',
  shell: 'ok',
  html: 'brand',
  css: 'accent',
  image: 'accent',
  spreadsheet: 'ok',
  archive: 'warn',
  folder: 'warn',
  web: 'blue',
  audio: 'accent',
  video: 'brand',
}

function svgUrl(svg: string): string {
  // encodeURIComponent leaves apostrophes and parentheses intact. Encode
  // those too, so the URL works in both HTML attributes and CSS url().
  const encoded = encodeURIComponent(svg).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `data:image/svg+xml,${encoded}`
}

/** Public catalog for galleries and other resource surfaces. */
export const DOCUMENT_ICONS: readonly DocumentIconAsset[] = Object.entries(
  DRAWINGS,
).map(([id, source]) => {
  const iconId = id as DocumentIconId
  const svg = source.trim()
  return Object.freeze({
    id: iconId,
    svg,
    mask: svgUrl(svg.replaceAll('currentColor', '#000')),
    image: /#[0-9a-f]{3,8}\b/i.test(svg) ? svgUrl(svg) : undefined,
    tone: TONES[iconId],
  })
})

const BY_ID = new Map(DOCUMENT_ICONS.map((icon) => [icon.id, icon]))
const BY_EXTENSION = new Map<string, DocumentIconId>()
const EXTENSIONS: Array<[DocumentIconId, string]> = [
  ['markdown', 'md markdown mdx'],
  ['text', 'txt text'],
  ['richtext', 'rtf'],
  ['word', 'doc docx'],
  ['pages', 'pages'],
  ['pdf', 'pdf'],
  ['json', 'json jsonc json5'],
  ['yaml', 'yaml yml'],
  ['toml', 'toml'],
  ['csv', 'csv tsv'],
  ['xml', 'xml plist'],
  ['config', 'ini conf config cfg env'],
  ['typescript', 'ts tsx'],
  ['javascript', 'js mjs cjs jsx'],
  ['vue', 'vue'],
  ['python', 'py pyw'],
  ['swift', 'swift'],
  ['go', 'go'],
  ['rust', 'rs'],
  ['shell', 'sh bash zsh fish'],
  ['html', 'html htm'],
  ['css', 'css'],
  [
    'code',
    'java kt kts c h cc cpp hpp m mm cs rb php sql scss less lua dart scala r',
  ],
  ['image', 'png jpg jpeg gif webp svg heic ico bmp tif tiff avif'],
  ['spreadsheet', 'xls xlsx numbers ods'],
  ['archive', 'zip tar gz tgz bz2 xz 7z rar dmg'],
  ['audio', 'mp3 wav aac m4a ogg flac aiff opus'],
  ['video', 'mp4 mov m4v webm avi mkv'],
]
for (const [id, extensions] of EXTENSIONS)
  for (const extension of extensions.split(' ')) BY_EXTENSION.set(extension, id)

/** Select a trusted vector; user-controlled path text never enters the SVG. */
export function documentIcon(
  path: string,
  options: { directory?: boolean } = {},
): DocumentIconAsset {
  const kind = documentGlyph(path, options).kind
  let id: DocumentIconId = 'file'
  if (kind === 'folder' || kind === 'web') id = kind
  else {
    const name =
      path
        .replace(/^file:\/\//i, '')
        .replace(/[?#].*$/, '')
        .split(/[\\/]/)
        .pop()
        ?.replace(/:\d+(?::\d+)?$/, '')
        .toLowerCase() ?? ''
    const dot = name.lastIndexOf('.')
    id = /^\.env(?:\.|$)/.test(name)
      ? 'config'
      : (BY_EXTENSION.get(dot < 0 ? '' : name.slice(dot + 1)) ?? 'file')
  }
  return BY_ID.get(id)!
}
