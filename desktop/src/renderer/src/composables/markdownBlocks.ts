// Block-wise Markdown rendering for streaming replies (FIX-04, UI-15).
//
// A growing reply is cut at its closed top-level blocks
// (`splitMarkdownBlocks`); closed blocks render and pass DOMPurify once, the
// tail (the last block, an unclosed fence or list included) re-renders whole
// on every update. The concatenated HTML equals the whole-document render
// (`renderMarkdown`); documents with reference definitions render whole.
// `MarkdownBlockView` applies a render to an element, keeping the DOM nodes
// of the closed blocks it already shows (so a selection in them survives).
import { renderMarkdown, splitMarkdownBlocks } from './useMarkdown'

export interface MarkdownBlock {
  readonly source: string
  /** Sanitized HTML of the block on its own. */
  readonly html: string
}

export interface MarkdownBlockRender {
  /** Closed blocks in order (empty when `whole`). */
  readonly blocks: readonly MarkdownBlock[]
  /** Source and sanitized HTML of the tail (the whole document when `whole`). */
  readonly tailSource: string
  readonly tail: string
  /** Rendered as one document (reference definitions). */
  readonly whole: boolean
  /** Leading closed blocks taken over unchanged from the previous render. */
  readonly reused: number
}

/**
 * Render `text` block by block. Closed blocks that `previous` already holds
 * (same position, same source) are reused as they are; a block that was the
 * previous tail reuses the tail's HTML; only the rest are rendered.
 */
export function renderMarkdownBlocks(
  text: string,
  previous?: MarkdownBlockRender | null,
): MarkdownBlockRender {
  const split = splitMarkdownBlocks(text)
  if (split === null)
    return {
      blocks: [],
      tailSource: text,
      tail: renderMarkdown(text),
      whole: true,
      reused: 0,
    }
  const before = previous?.whole === false ? previous : null
  const blocks: MarkdownBlock[] = []
  let reused = 0
  for (const source of split.closed) {
    const kept = before?.blocks[blocks.length]
    if (kept !== undefined && kept.source === source) {
      // Only an unbroken leading run keeps its DOM nodes.
      if (reused === blocks.length) reused++
      blocks.push(kept)
      continue
    }
    const html =
      before !== null && trimLines(before.tailSource) === source
        ? before.tail
        : renderMarkdown(source)
    blocks.push({ source, html })
  }
  const tail =
    before !== null && before.tailSource === split.tail
      ? before.tail
      : renderMarkdown(split.tail)
  return { blocks, tailSource: split.tail, tail, whole: false, reused }
}

/**
 * A tail without its trailing blank lines: the source it has once closed
 * (its HTML is the same — an open fence, whose blank lines count, never
 * closes into the same source).
 */
function trimLines(source: string): string {
  return source.replace(/\n+$/u, '')
}

/** The HTML a render stands for (equal to the whole-document render). */
export function markdownBlockHtml(render: MarkdownBlockRender): string {
  let html = ''
  for (const block of render.blocks) html += block.html
  return html + render.tail
}

function parseNodes(html: string): Node[] {
  const template = document.createElement('template')
  template.innerHTML = html
  return [...template.content.childNodes]
}

/**
 * Shows block renders in one element (no wrappers: the blocks' nodes are
 * the element's children, as with `v-html`). An update keeps the nodes of
 * the closed blocks it reuses and replaces the rest.
 */
export class MarkdownBlockView {
  private text: string | null = null
  private render: MarkdownBlockRender | null = null
  /** Child nodes per closed block, then the tail's. */
  private blockNodes: Node[][] = []
  private tailNodes: Node[] = []

  constructor(private readonly root: HTMLElement) {}

  /** Show `text`; false when nothing changed. */
  update(text: string): boolean {
    if (text === this.text) return false
    this.text = text
    const previous = this.render
    const next = renderMarkdownBlocks(text, previous)
    this.render = next
    if (next.whole) {
      this.root.innerHTML = next.tail
      this.blockNodes = []
      this.tailNodes = [...this.root.childNodes]
      return true
    }
    const keep = previous === null || previous.whole ? 0 : next.reused
    for (const nodes of this.blockNodes.slice(keep))
      for (const node of nodes) node.parentNode?.removeChild(node)
    for (const node of this.tailNodes) node.parentNode?.removeChild(node)
    this.blockNodes = this.blockNodes.slice(0, keep)
    if (previous === null || previous.whole) this.root.replaceChildren()
    const fragment = document.createDocumentFragment()
    for (const block of next.blocks.slice(keep)) {
      const nodes = parseNodes(block.html)
      this.blockNodes.push(nodes)
      fragment.append(...nodes)
    }
    this.tailNodes = parseNodes(next.tail)
    fragment.append(...this.tailNodes)
    this.root.append(fragment)
    return true
  }
}
