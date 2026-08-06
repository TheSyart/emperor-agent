import hljs from 'highlight.js/lib/common'

/** 字符数上限(非字节);超过则跳过高亮以防阻塞渲染。core 已将文本截断在 1MB。 */
export const HIGHLIGHT_CHAR_CAP = 200 * 1024

const EXT_TO_LANGUAGE: Record<string, string> = {
  html: 'xml',
  htm: 'xml',
  vue: 'xml',
  svg: 'xml',
  xml: 'xml',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  map: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cc',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sql: 'sql',
  swift: 'swift',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  env: 'ini',
  graphql: 'graphql',
  gql: 'graphql',
  diff: 'diff',
  patch: 'diff',
  mk: 'makefile',
}

const BASENAME_TO_LANGUAGE: Record<string, string> = {
  makefile: 'makefile',
  gnumakefile: 'makefile',
}

export interface HighlightedFile {
  highlighted: boolean
  /** 每行的 HTML——未高亮时为转义文本,高亮时为 hljs span。 */
  lines: string[]
}

export function languageForFile(name: string): string {
  const lower = name.toLowerCase()
  const byName = BASENAME_TO_LANGUAGE[lower]
  if (byName) return byName
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  return EXT_TO_LANGUAGE[ext] ?? 'plaintext'
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 按换行拆分 hljs HTML:行尾闭合仍开着的 span,下一行开头按原序重开,
 * 保证每个返回行标签平衡。逐行高亮会丢失多行注释/字符串状态,禁用。
 */
export function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = []
  const openTags: string[] = []
  for (const segment of html.split('\n')) {
    const line = openTags.join('') + segment
    for (const match of segment.matchAll(/<span\b[^>]*>|<\/span>/g)) {
      if (match[0] === '</span>') openTags.pop()
      else openTags.push(match[0])
    }
    lines.push(line + '</span>'.repeat(openTags.length))
  }
  return lines
}

export function highlightFile(name: string, content: string): HighlightedFile {
  if (!content) return { highlighted: false, lines: [''] }
  const language = languageForFile(name)
  if (language === 'plaintext' || content.length > HIGHLIGHT_CHAR_CAP) {
    return { highlighted: false, lines: content.split('\n').map(escapeHtml) }
  }
  try {
    const { value } = hljs.highlight(content, {
      language,
      ignoreIllegals: true,
    })
    return { highlighted: true, lines: splitHighlightedHtml(value) }
  } catch {
    return { highlighted: false, lines: content.split('\n').map(escapeHtml) }
  }
}
