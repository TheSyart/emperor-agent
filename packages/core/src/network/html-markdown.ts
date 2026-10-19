/**
 * HTML → Markdown for `web_fetch`: turndown over its bundled DOM, behind a
 * linear lexical pre-pass.
 *
 * Core runs in the Electron main process, so conversion is synchronous work
 * on the app's event loop, and turndown's walk grows faster than linearly
 * with page size and nesting depth (measured on an M-series Mac: 2 MiB of
 * plain markup ≈ 2.3 s, 8 MiB ≈ 36 s; a 512 KiB table ≈ 1.2 s, 256 KiB ≈
 * 0.3 s, 256 KiB of prose ≈ 30 ms). The pre-pass therefore:
 *
 * - drops what never shows as page text (comments, `script`, `style`,
 *   `noscript`, `template`, `svg`, `iframe`, `object`, `canvas`) and takes
 *   the `<title>` out, skipping raw-text bodies without interpreting them;
 * - stops once the kept markup reaches the conversion budget
 *   ({@link HTML_CONVERT_MAX_CHARS}), so a 10 MiB page costs what 256 KiB
 *   does, and reports the cut;
 * - estimates element nesting (with the HTML parser's common implied end
 *   tags) and, past {@link HTML_CONVERT_MAX_DEPTH}, returns plain text
 *   instead of handing the parser a pathological tree.
 *
 * A converter failure falls back to the same plain text. Links and images
 * point at absolute http(s) URLs so the model can fetch them next.
 */

import { parseFragment } from 'parse5'
import TurndownService from 'turndown'

/** Kept HTML characters converted per page (the rest is reported as cut). */
export const HTML_CONVERT_MAX_CHARS = 256 * 1024
/** Estimated nesting depth above which a page is returned as plain text. */
export const HTML_CONVERT_MAX_DEPTH = 512

const TITLE_MAX_CHARS = 300

export interface HtmlToMarkdownOptions {
  /** Resolves relative links and images (the page's final URL). */
  baseUrl?: string
  maxChars?: number
  maxDepth?: number
}

export interface HtmlToMarkdownResult {
  /** The document `<title>`, entity-decoded and on one line. */
  title: string | null
  markdown: string
  /** The page's markup exceeded the conversion budget; its end is missing. */
  sourceTruncated: boolean
  /** Returned as plain text: nesting too deep, or the converter failed. */
  plainText: boolean
}

export function htmlToMarkdown(
  html: string,
  options: HtmlToMarkdownOptions = {},
): HtmlToMarkdownResult {
  const scan = scanHtml(html, options.maxChars ?? HTML_CONVERT_MAX_CHARS)
  const title = scan.title === null ? null : oneLine(decodeText(scan.title))
  const base = {
    title: title ? title.slice(0, TITLE_MAX_CHARS) : null,
    sourceTruncated: scan.truncated,
  }
  if (scan.depth > (options.maxDepth ?? HTML_CONVERT_MAX_DEPTH))
    return { ...base, markdown: plainText(scan.html), plainText: true }
  try {
    const markdown = converter(options.baseUrl)
      .turndown(scan.html)
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return { ...base, markdown, plainText: false }
  } catch {
    // Markup the pre-pass cannot model can still make the DOM walk throw
    // (deep recursion): the text is still worth returning.
    return { ...base, markdown: plainText(scan.html), plainText: true }
  }
}

// ── lexical pre-pass ───────────────────────────────────────────────────

/** Elements whose contents never appear as page text. */
const DROPPED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
  'canvas',
  'title',
])

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** Never counted: the parser keeps exactly one of each. */
const ROOTS = new Set(['html', 'head', 'body'])

const TABLE_PARTS = ['td', 'th', 'tr', 'tbody', 'thead', 'tfoot']

/** An opening tag closes these open elements first (HTML implied end tags). */
const IMPLIED_END: Record<string, readonly string[]> = {
  p: ['p'],
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
  optgroup: ['option', 'optgroup'],
  rt: ['rt', 'rp'],
  rp: ['rt', 'rp'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  tr: ['td', 'th', 'tr'],
  tbody: TABLE_PARTS,
  thead: TABLE_PARTS,
  tfoot: TABLE_PARTS,
}

/** How far down the open-element stack a closing tag may reach. */
const CLOSE_SEARCH = 32

interface Scan {
  html: string
  title: string | null
  depth: number
  truncated: boolean
}

function scanHtml(html: string, budget: number): Scan {
  const lower = html.toLowerCase()
  const kept: string[] = []
  let keptLength = 0
  let emitFrom = 0
  let cursor = 0
  let title: string | null = null
  const open: string[] = []
  let depth = 0
  const emit = (end: number): void => {
    if (end > emitFrom) {
      kept.push(html.slice(emitFrom, end))
      keptLength += end - emitFrom
    }
  }
  const skipTo = (index: number): void => {
    cursor = index
    emitFrom = index
  }

  while (cursor < html.length && keptLength + (cursor - emitFrom) < budget) {
    const start = html.indexOf('<', cursor)
    if (start === -1) {
      cursor = html.length
      break
    }
    if (html.startsWith('<!--', start)) {
      emit(start)
      const end = html.indexOf('-->', start + 4)
      skipTo(end === -1 ? html.length : end + 3)
      continue
    }
    let index = start + 1
    const closing = html.charCodeAt(index) === 47 // '/'
    if (closing) index += 1
    const nameStart = index
    while (index < html.length && isNameChar(html.charCodeAt(index))) index += 1
    if (index === nameStart || !isLetter(html.charCodeAt(nameStart))) {
      cursor = start + 1
      continue
    }
    const name = lower.slice(nameStart, index)
    const tagEnd = endOfTag(html, index)
    if (tagEnd === -1) {
      // An unterminated tag swallows the rest, as in a browser.
      emit(start)
      skipTo(html.length)
      break
    }
    if (!closing && DROPPED.has(name)) {
      emit(start)
      const close = closingTag(lower, name, tagEnd)
      if (name === 'title' && title === null)
        title = html.slice(tagEnd, close === -1 ? html.length : close)
      if (close === -1) {
        skipTo(html.length)
        break
      }
      const closeEnd = html.indexOf('>', close)
      skipTo(closeEnd === -1 ? html.length : closeEnd + 1)
      continue
    }
    if (closing) {
      for (
        let level = open.length - 1;
        level >= 0 && level >= open.length - CLOSE_SEARCH;
        level--
      ) {
        if (open[level] === name) {
          open.length = level
          break
        }
      }
    } else if (
      !VOID.has(name) &&
      !ROOTS.has(name) &&
      html.charCodeAt(tagEnd - 2) !== 47 // not `<x/>`
    ) {
      const implied = IMPLIED_END[name]
      if (implied)
        while (open.length > 0 && implied.includes(open[open.length - 1]!))
          open.pop()
      open.push(name)
      if (open.length > depth) depth = open.length
    }
    cursor = tagEnd
  }

  const truncated = cursor < html.length && emitFrom < html.length
  if (truncated) {
    // Cut at the budget, never inside a tag.
    const room = Math.max(0, budget - keptLength)
    let end = emitFrom + room
    const lastOpen = html.lastIndexOf('<', end)
    if (lastOpen >= emitFrom && html.lastIndexOf('>', end) < lastOpen)
      end = lastOpen
    emit(Math.max(emitFrom, end))
  } else emit(html.length)
  return { html: kept.join(''), title, depth, truncated }
}

/** Index just past the `>` ending a tag whose name ends at `from`, or -1. */
function endOfTag(html: string, from: number): number {
  let quote = 0
  let valueNext = false
  for (let index = from; index < html.length; index++) {
    const code = html.charCodeAt(index)
    if (quote !== 0) {
      if (code === quote) quote = 0
      continue
    }
    if (code === 62) return index + 1 // '>'
    if (code === 61) {
      // '=': a quote right after it (spaces allowed) opens a value.
      valueNext = true
      continue
    }
    if (valueNext) {
      if (
        code === 32 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      )
        continue
      if (code === 34 || code === 39) quote = code
      valueNext = false
    }
  }
  return -1
}

/** Index of `</name` (followed by a tag boundary) at or after `from`, or -1. */
function closingTag(lower: string, name: string, from: number): number {
  const needle = `</${name}`
  let found = lower.indexOf(needle, from)
  while (found !== -1) {
    const next = lower.charCodeAt(found + needle.length)
    if (Number.isNaN(next) || next === 62 || next === 47 || isSpace(next))
      return found
    found = lower.indexOf(needle, found + needle.length)
  }
  return -1
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isNameChar(code: number): boolean {
  return isLetter(code) || (code >= 48 && code <= 57) || code === 45
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13
}

// ── text helpers ───────────────────────────────────────────────────────

/** Decode character references the way an RCDATA element does. */
function decodeText(raw: string): string {
  const fragment = parseFragment(
    `<textarea>${raw.replace(/<\/textarea/gi, '')}</textarea>`,
  )
  const textarea = fragment.childNodes[0]
  if (!textarea || !('childNodes' in textarea)) return raw
  return textarea.childNodes
    .map((node) => ('value' in node ? String(node.value) : ''))
    .join('')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const BLOCK_TAG =
  /<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi

/** Text with paragraph breaks, for pages that cannot be converted. */
function plainText(html: string): string {
  const text = decodeText(
    html.replace(BLOCK_TAG, '\n').replace(/<[^>]*>/g, ' '),
  )
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── turndown ───────────────────────────────────────────────────────────

function converter(baseUrl: string | undefined): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  // The reader is a model, not a Markdown renderer: keep `_`, `*` and `[`
  // in identifiers and prose as the page wrote them.
  service.escape = (text: string) => text
  service.remove([...DROPPED, 'head', 'embed'] as TurndownService.Filter)
  service.addRule('emperorHidden', {
    filter: (node) => isHidden(node),
    replacement: () => '',
  })
  service.addRule('emperorLink', {
    filter: (node) =>
      node.nodeName === 'A' && Boolean(node.getAttribute('href')),
    replacement: (content, node) => {
      const href = linkTarget(
        (node as HTMLElement).getAttribute('href'),
        baseUrl,
      )
      const text = content.trim()
      if (!href || !text) return content
      return `[${text.replace(/\n+/g, ' ')}](${href})`
    },
  })
  service.addRule('emperorImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const image = node as HTMLElement
      const alt = oneLine(image.getAttribute('alt') ?? '')
      if (!alt) return ''
      const src = webUrl(image.getAttribute('src'), baseUrl)
      return src ? `![${alt.replace(/[[\]]/g, '')}](${src})` : alt
    },
  })
  service.addRule('emperorTableCell', {
    filter: ['th', 'td'],
    replacement: (content, node) => {
      const cell = node as HTMLElement
      const index = Array.prototype.indexOf.call(
        cell.parentNode?.childNodes ?? [],
        cell,
      )
      return `${index === 0 ? '| ' : ' '}${tableCell(content)} |`
    },
  })
  service.addRule('emperorTableRow', {
    filter: 'tr',
    replacement: (content, node) => {
      const row = node as HTMLTableRowElement
      return `\n${content}${isHeadingRow(row) ? `\n${separator(row)}` : ''}`
    },
  })
  service.addRule('emperorTableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: (content) => content,
  })
  service.addRule('emperorTable', {
    filter: 'table',
    replacement: (content) => `\n\n${content.replace(/^\n+/, '')}\n\n`,
  })
  return service
}

function isHidden(node: HTMLElement): boolean {
  if (node.nodeType !== 1) return false
  if (node.hasAttribute('hidden')) return true
  if (node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true
  if (
    node.nodeName === 'INPUT' &&
    node.getAttribute('type')?.toLowerCase() === 'hidden'
  )
    return true
  const style = node.getAttribute('style')
  if (!style) return false
  return style.split(';').some((declaration) => {
    const colon = declaration.indexOf(':')
    if (colon === -1) return false
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration
      .slice(colon + 1)
      .trim()
      .toLowerCase()
      .replace(/\s*!important$/, '')
    return (
      (property === 'display' && value === 'none') ||
      (property === 'visibility' &&
        (value === 'hidden' || value === 'collapse'))
    )
  })
}

function tableCell(content: string): string {
  return content.trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|')
}

function isHeadingRow(row: HTMLTableRowElement): boolean {
  const cells = Array.from(row.childNodes).filter(
    (child) => child.nodeName === 'TH' || child.nodeName === 'TD',
  )
  if (cells.length === 0 || cells.some((cell) => cell.nodeName !== 'TH'))
    return false
  const section = row.parentNode
  if (section?.nodeName === 'THEAD') return true
  const table = section?.nodeName === 'TABLE' ? section : section?.parentNode
  const first = (table as HTMLTableElement | null)?.querySelector?.('tr')
  return first === row
}

function separator(row: HTMLTableRowElement): string {
  const count = Array.from(row.childNodes).filter(
    (child) => child.nodeName === 'TH' || child.nodeName === 'TD',
  ).length
  return `|${' --- |'.repeat(count)}`
}

/** An absolute http(s) URL, or null. */
function webUrl(raw: string | null, base: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw.trim(), base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return markdownDestination(url.href)
  } catch {
    return null
  }
}

/** Where a link goes: absolute http(s) or mailto; same-page anchors drop. */
function linkTarget(
  raw: string | null,
  base: string | undefined,
): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw.trim(), base)
    if (url.protocol === 'mailto:') return markdownDestination(url.href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (base !== undefined && url.hash) {
      const page = new URL(base)
      page.hash = ''
      const target = new URL(url.href)
      target.hash = ''
      if (target.href === page.href) return null
    }
    return markdownDestination(url.href)
  } catch {
    return null
  }
}

function markdownDestination(href: string): string {
  return href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20')
}
