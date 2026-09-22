// Bounded Markdown-to-text projection shared by trajectory consumers
// (ported from the dsh trajectory-preview). The Markdown grammar is the
// renderer's markdown-it, so the projection strips the markup the chat would
// draw; raw HTML stays literal, links keep their labels, images keep their
// alt text, and code keeps its source text.
import MarkdownIt from 'markdown-it'

const PREVIEW_SOURCE_CHARACTERS = 2_048
const PREVIEW_OUTPUT_CHARACTERS = 512

interface MarkdownToken {
  readonly type: string
  readonly content: string
  readonly children: readonly MarkdownToken[] | null
  /** Tight-list paragraphs are hidden: they separate nothing. */
  readonly hidden: boolean
}

let parser: MarkdownIt | null = null

function markdown(): MarkdownIt {
  parser ??= new MarkdownIt({ html: true, linkify: false })
  return parser
}

function inlineText(tokens: readonly MarkdownToken[]): string {
  let text = ''
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'code_inline':
      case 'html_inline':
        text += token.content
        break
      case 'softbreak':
      case 'hardbreak':
        text += '\n'
        break
      case 'image':
        text +=
          token.children === null ? token.content : inlineText(token.children)
        break
      default:
        if (token.children !== null) text += inlineText(token.children)
    }
  }
  return text
}

/**
 * Parse Markdown and remove its presentation markup, keeping raw HTML.
 * @param source - Markdown source.
 * @returns Plain text with blocks separated by blank lines.
 */
export function extractMarkdownPlainText(source: string): string {
  const tokens = markdown().parse(source, {}) as unknown as MarkdownToken[]
  let text = ''
  for (const token of tokens) {
    switch (token.type) {
      case 'inline':
        text += inlineText(token.children ?? []).replace(/[ \t]+/g, ' ')
        break
      case 'paragraph_close':
        if (!token.hidden) text += '\n\n'
        break
      case 'heading_close':
      case 'blockquote_close':
        text += '\n\n'
        break
      case 'fence':
      case 'code_block':
        text += `${token.content.trim()}\n\n`
        break
      case 'html_block':
        text += `${token.content.trim()}\n\n`
        break
      case 'list_item_close':
      case 'tr_close':
        text += '\n'
        break
      case 'th_close':
      case 'td_close':
        text += '\t'
        break
      default:
        break
    }
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Build a bounded one-line preview without parsing the complete Markdown document.
 * @param text - Untrusted message, reasoning, payload, or result text.
 * @returns A compact preview capped independently from the retained source.
 */
export function trajectoryPreviewText(text: string): string {
  const source = text.slice(0, PREVIEW_SOURCE_CHARACTERS)
  const compact = extractMarkdownPlainText(source).replace(/\s+/g, ' ').trim()
  const preview = compact.slice(0, PREVIEW_OUTPUT_CHARACTERS).trimEnd()
  return source.length < text.length || preview.length < compact.length
    ? `${preview}…`
    : preview
}
