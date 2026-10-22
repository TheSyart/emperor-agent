// @vitest-environment jsdom
// FIX-04 (UI-15): streaming Markdown renders block by block. Block
// boundaries come from closed top-level markdown-it blocks; the last block
// and anything after it is the tail, rendered whole. The result must equal
// the whole-document render at every point of a stream.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MarkdownBlockView,
  markdownBlockHtml,
  renderMarkdownBlocks,
  type MarkdownBlockRender,
} from './markdownBlocks'
import { renderMarkdown, splitMarkdownBlocks } from './useMarkdown'
import {
  longMarkdownReply,
  markdownSamples,
} from '../conversation/testing/streaming'

const purify = vi.hoisted(() => ({ inputs: [] as string[] }))
vi.mock('isomorphic-dompurify', async (original) => {
  const actual = await original<typeof import('isomorphic-dompurify')>()
  const real = actual.default
  return {
    ...actual,
    default: new Proxy(real, {
      get(target, key) {
        if (key !== 'sanitize') return Reflect.get(target, key)
        return (
          dirty: string,
          config?: Parameters<typeof real.sanitize>[1],
        ) => {
          purify.inputs.push(dirty)
          return real.sanitize(dirty, config ?? {})
        }
      },
    }),
  }
})

afterEach(() => {
  purify.inputs.length = 0
})

/** Prefix cut points of a stream: about `steps` of them, plus the end. */
function cuts(text: string, steps = 40): number[] {
  const step = Math.max(1, Math.floor(text.length / steps))
  const points: number[] = []
  for (let end = 1; end < text.length; end += step) points.push(end)
  points.push(text.length)
  return points
}

describe('splitMarkdownBlocks', () => {
  it('5 · keeps an unclosed code fence whole as the tail block', () => {
    const split = splitMarkdownBlocks(
      'intro\n\n- a\n- b\n\n```ts\nconst a = 1\nconst b',
    )
    expect(split).toEqual({
      closed: ['intro', '- a\n- b'],
      tail: '```ts\nconst a = 1\nconst b',
    })
    const render = renderMarkdownBlocks(
      'intro\n\n- a\n- b\n\n```ts\nconst a = 1\nconst b',
    )
    expect(render.tail).toBe(
      '<pre><code class="language-ts">const a = 1\nconst b</code></pre>\n',
    )
    expect(markdownBlockHtml(render)).toBe(
      renderMarkdown('intro\n\n- a\n- b\n\n```ts\nconst a = 1\nconst b'),
    )
  })

  it('never splits a list or a fence that is still the last block', () => {
    expect(splitMarkdownBlocks('- a\n- b\n\n  more of b')).toEqual({
      closed: [],
      tail: '- a\n- b\n\n  more of b',
    })
    expect(splitMarkdownBlocks('para\n\n```\none\n\ntwo')).toEqual({
      closed: ['para'],
      tail: '```\none\n\ntwo',
    })
    // A paragraph becomes a setext heading only while it is the tail.
    expect(splitMarkdownBlocks('done\n\nTitle\n===')).toEqual({
      closed: ['done'],
      tail: 'Title\n===',
    })
  })

  it('refuses documents with reference definitions (they reach back)', () => {
    expect(
      splitMarkdownBlocks('See [g].\n\n[g]: https://example.com\n\nmore'),
    ).toBeNull()
  })
})

describe('renderMarkdownBlocks', () => {
  it('4 · equals the whole-document render at every prefix of 100 samples', () => {
    const samples = markdownSamples(100)
    expect(samples).toHaveLength(100)
    let compared = 0
    let blockwise = 0
    for (const sample of samples) {
      let previous: MarkdownBlockRender | null = null
      for (const end of cuts(sample)) {
        const prefix = sample.slice(0, end)
        const render: MarkdownBlockRender = renderMarkdownBlocks(
          prefix,
          previous,
        )
        expect(markdownBlockHtml(render), JSON.stringify(prefix)).toBe(
          renderMarkdown(prefix),
        )
        if (!render.whole && render.blocks.length > 0) blockwise++
        compared++
        previous = render
      }
    }
    expect(compared).toBeGreaterThan(3000)
    // Most cuts really render block by block (not the whole-document fallback).
    expect(blockwise).toBeGreaterThan(compared / 2)
  })

  it('equals the whole render of a long reply streamed in small pieces', () => {
    const reply = longMarkdownReply(8_000)
    let previous: MarkdownBlockRender | null = null
    for (const end of cuts(reply, 200)) {
      const prefix = reply.slice(0, end)
      previous = renderMarkdownBlocks(prefix, previous)
      expect(markdownBlockHtml(previous)).toBe(renderMarkdown(prefix))
    }
  })

  it('sanitizes only new blocks: closed blocks once, the tail per update', () => {
    let render = renderMarkdownBlocks('one\n\ntwo\n\nthr')
    expect(purify.inputs).toHaveLength(3)
    purify.inputs.length = 0

    render = renderMarkdownBlocks('one\n\ntwo\n\nthree', render)
    expect(render.reused).toBe(2)
    expect(purify.inputs).toEqual(['<p>three</p>\n'])
    purify.inputs.length = 0

    // The tail closes: its last render is taken over, only the new tail runs.
    render = renderMarkdownBlocks('one\n\ntwo\n\nthree\n\nfo', render)
    expect(render.reused).toBe(2)
    expect(render.blocks.map((block) => block.source)).toEqual([
      'one',
      'two',
      'three',
    ])
    expect(purify.inputs).toEqual(['<p>fo</p>\n'])
  })
})

describe('MarkdownBlockView', () => {
  function reference(html: string): string {
    const element = document.createElement('div')
    element.innerHTML = html
    return element.innerHTML
  }

  it('builds the same DOM as the whole render while keeping closed blocks', () => {
    const root = document.createElement('div')
    const view = new MarkdownBlockView(root)
    const reply = longMarkdownReply(4_000)
    let firstBlock: Node | null = null
    for (const end of cuts(reply, 60)) {
      const prefix = reply.slice(0, end)
      view.update(prefix)
      expect(root.innerHTML).toBe(reference(renderMarkdown(prefix)))
      if (firstBlock === null && root.childNodes.length > 2)
        firstBlock = root.firstChild
    }
    expect(firstBlock).not.toBeNull()
    expect(root.firstChild).toBe(firstBlock)
  })

  it('falls back to a whole render and back to blocks again', () => {
    const root = document.createElement('div')
    const view = new MarkdownBlockView(root)
    view.update('a\n\n[x]: https://example.com\n\nuse [x]')
    expect(root.innerHTML).toBe(
      reference(renderMarkdown('a\n\n[x]: https://example.com\n\nuse [x]')),
    )
    view.update('plain\n\nblocks')
    expect(root.innerHTML).toBe(reference(renderMarkdown('plain\n\nblocks')))
  })
})
