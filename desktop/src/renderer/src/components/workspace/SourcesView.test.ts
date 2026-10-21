// @vitest-environment jsdom
// UI-S13: the 来源 view of the workbench — every source of the chat window,
// grouped 你提供的 / 已查看 / 搜索命中, each with its path or address and,
// only when the transcript says so, what produced it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import type { ChatNode } from '../../conversation/types'
import type { DisplayResource } from '../conversation/resources/resourceModel'

const { openResourceImages } = vi.hoisted(() => ({
  openResourceImages: vi.fn(),
}))
vi.mock('../conversation/resources/resourceImages', () => ({
  openResourceImages,
}))
vi.mock('../../api/http', () => ({ core: async () => null }))

import SourcesView from './SourcesView.vue'
import type { SourcesViewState } from '../conversation/environment/sourcesModel'

let app: App | undefined
let element: HTMLDivElement | undefined
afterEach(() => {
  app?.unmount()
  element?.remove()
  openResourceImages.mockReset()
})

function source(
  id: string,
  provenance: DisplayResource['provenance'],
  patch: Partial<DisplayResource> = {},
): DisplayResource {
  return {
    id,
    kind: 'file',
    href: `/Users/alice/tankwar/${id}`,
    label: id,
    subtitle: `/Users/alice/tankwar/${id}`,
    sourceMessageId: 'm1',
    role: 'source',
    provenance,
    ...patch,
  }
}

const searchCall = {
  key: 'tool:s1',
  kind: 'tool',
  id: 's1',
  target: 'chat',
  anchorSeq: 3,
  visibility: 'visible',
  turn: 1,
  step: 1,
  data: {
    callId: 's1',
    name: 'web_search',
    argsRaw: JSON.stringify({ queries: ['three.js renderer resize'] }),
    turn: 1,
    step: 1,
    time: 0,
    status: 'settled',
    approvals: [],
  },
} as ChatNode

const hit = source('three.js 文档', 'discovered', {
  kind: 'web',
  href: 'https://threejs.org/docs/#api/en/renderers/WebGLRenderer',
  subtitle: 'threejs.org',
  uses: [
    { nodeKey: 'tool:s1', sourceMessageId: 's1', provenance: 'discovered' },
  ],
})
const image = source('screen.png', 'provided', {
  kind: 'image',
  href: 'attachment:a1',
  attachmentId: 'a1',
  subtitle: 'image/png',
})
const main = source('src/main.js', 'read', {
  uses: [
    { nodeKey: 'tool:r1', sourceMessageId: 'r1', provenance: 'read' },
    { nodeKey: 'tool:r2', sourceMessageId: 'r2', provenance: 'read' },
  ],
})
const index = source('index.html', 'read')

function mount(patch: Partial<SourcesViewState> = {}, onClose = vi.fn()) {
  const view: SourcesViewState = {
    sessionId: 's1',
    sources: [image, main, index, hit],
    nodes: new Map([[searchCall.key, searchCall]]),
    hasMore: false,
    ...patch,
  }
  element = document.createElement('div')
  document.body.append(element)
  app = createApp({ render: () => h(SourcesView, { view, onClose }) })
  app.mount(element)
  return onClose
}

const text = (el: Element | null | undefined) =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

describe('SourcesView (UI-S13)', () => {
  it('heads the view with 返回, 来源 and the count', async () => {
    const onClose = mount()
    await nextTick()
    const head = element!.querySelector('.sources-view .head')!
    expect(text(head.querySelector('.title'))).toBe('来源')
    expect(text(head.querySelector('.count'))).toBe('4')
    head.querySelector<HTMLButtonElement>('[aria-label="返回"]')!.click()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('groups the sources 你提供的 / 已查看 / 搜索命中, hiding empty groups', async () => {
    mount()
    await nextTick()
    const groups = [
      ...element!.querySelectorAll<HTMLElement>('[data-source-group]'),
    ]
    expect(
      groups.map((group) => text(group.querySelector('.section-title'))),
    ).toEqual(['你提供的 · 1', '已查看 · 2', '搜索命中 · 1'])
    app?.unmount()
    element?.remove()
    mount({ sources: [main] })
    await nextTick()
    expect(
      [...element!.querySelectorAll('[data-source-group]')].map((group) =>
        text(group.querySelector('.section-title')),
      ),
    ).toEqual(['已查看 · 1'])
  })

  it('writes each path or address, and only notes what the transcript says', async () => {
    mount()
    await nextTick()
    const entries = [
      ...element!.querySelectorAll<HTMLElement>('[data-source-entry]'),
    ]
    const lines = entries.map((entry) => ({
      title: text(entry.querySelector('.title')),
      location: text(entry.querySelector('.location')),
      mono: entry.querySelector('.location')?.classList.contains('mono'),
      note: text(entry.querySelector('.note')),
    }))
    expect(lines).toEqual([
      { title: 'screen.png', location: 'image/png', mono: false, note: '' },
      {
        title: 'src/main.js',
        location: '~/tankwar/src/main.js',
        mono: true,
        note: '2 处记录',
      },
      {
        title: 'index.html',
        location: '~/tankwar/index.html',
        mono: true,
        note: '',
      },
      {
        title: 'three.js 文档',
        location: 'threejs.org/docs/#api/en/renderers/WebGLRenderer',
        mono: true,
        note: '搜索「three.js renderer resize」',
      },
    ])
    // Nobody is said to have read anything.
    expect(element!.textContent).not.toContain('读过')
  })

  it('opens a source as the card does: an image in the lightbox, anything else in its detail', async () => {
    const details: unknown[] = []
    const listen = (event: Event) => details.push((event as CustomEvent).detail)
    window.addEventListener('emperor:resource-detail', listen)
    mount()
    await nextTick()
    const entries = element!.querySelectorAll<HTMLElement>(
      '[data-source-entry]',
    )
    entries[0]!.click()
    expect(openResourceImages).toHaveBeenCalledWith(
      image,
      's1',
      expect.arrayContaining([image]),
    )
    entries[3]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    window.removeEventListener('emperor:resource-detail', listen)
    expect(details).toEqual([{ resource: hit, sessionId: 's1' }])
  })

  it('says 已加载来源 while older history is not loaded', async () => {
    mount({ hasMore: true })
    await nextTick()
    expect(text(element!.querySelector('.sources-view .head .title'))).toBe(
      '已加载来源',
    )
  })
})
