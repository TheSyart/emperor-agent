import hljs from 'highlight.js/lib/common'
import {
  escapeHtml,
  HIGHLIGHT_CHAR_CAP,
  languageForFile,
  splitHighlightedHtml,
} from '../workspace/fileHighlight'

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  rb: 'ruby',
  yml: 'yaml',
  md: 'markdown',
  html: 'xml',
  vue: 'xml',
  rs: 'rust',
  kt: 'kotlin',
  cs: 'csharp',
  toml: 'ini',
  jsonc: 'json',
}

/**
 * Resolve a markdown info string / language id / file path to a
 * highlight.js grammar, or undefined for plain text.
 */
export function resolveLanguage(
  lang: string | undefined,
  path?: string,
): string | undefined {
  const id = (lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (id) {
    const alias = LANG_ALIASES[id] ?? id
    if (hljs.getLanguage(alias)) return alias
  }
  if (path) {
    const byFile = languageForFile(path.split(/[\\/]/).pop() ?? path)
    if (byFile !== 'plaintext') return byFile
  }
  return undefined
}

/**
 * Highlight code into per-line balanced HTML (hljs spans, `.ds-hl` themed).
 * Returns undefined when the language is unknown or the text is too large, so
 * callers render plain text with identical geometry.
 */
export function highlightCodeLines(
  code: string,
  lang: string | undefined,
  path?: string,
): string[] | undefined {
  const language = resolveLanguage(lang, path)
  if (!language || code.length > HIGHLIGHT_CHAR_CAP) return undefined
  try {
    const { value } = hljs.highlight(code, { language, ignoreIllegals: true })
    return splitHighlightedHtml(value)
  } catch {
    return undefined
  }
}

/** Whole-block highlighted HTML, or escaped plain text. */
export function highlightCodeHtml(
  code: string,
  lang: string | undefined,
): {
  html: string
  highlighted: boolean
} {
  const lines = highlightCodeLines(code, lang)
  if (!lines) return { html: escapeHtml(code), highlighted: false }
  return { html: lines.join('\n'), highlighted: true }
}
