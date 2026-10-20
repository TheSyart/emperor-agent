// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive, ref } from 'vue'
import MarkdownHtml from './MarkdownHtml.vue'
import { renderMarkdown } from '../../../composables/useMarkdown'
import { createExpansionStore, provideChatContext } from '../chatContext'
import { closeImageViewer, imageViewer } from '../../ui/imageViewer'
import {
  LINK_STATUS_KEY,
  type LinkStatus,
  type LinkStatusSource,
} from './linkStatus'

function source(statuses: Record<string, LinkStatus | null>) {
  const asked: string[] = []
  const version = ref(0)
  const links: LinkStatusSource = {
    version,
    status: async (href) => {
      asked.push(href)
      return statuses[href] ?? null
    },
  }
  return { links, asked, version }
}

const TEXT = [
  '[gone.md](docs/gone.md)',
  '[docs](docs)',
  '[app.ts](src/app.ts)',
  '[web](https://example.com)',
].join(' ')

let container: HTMLDivElement | null = null
let mountedApp: ReturnType<typeof createApp> | null = null

afterEach(() => {
  closeImageViewer()
  mountedApp?.unmount()
  mountedApp = null
  container?.remove()
  container = null
})

function mount(
  props: { text: string; streaming?: boolean },
  links?: LinkStatusSource,
  sessionId = 's1',
) {
  const state = reactive({ streaming: false, ...props })
  container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    setup() {
      provideChatContext({
        actions: {
          inspect: () => undefined,
          openSubagent: () => undefined,
          editMessage: () => undefined,
        },
        expansion: createExpansionStore(),
        sessionId: () => sessionId,
      })
      return () => h(MarkdownHtml, { ...state })
    },
  })
  mountedApp = app
  if (links) app.provide(LINK_STATUS_KEY, links)
  app.mount(container)
  return { root: container, state }
}

async function flushPromises() {
  for (let index = 0; index < 5; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
}

function anchor(root: HTMLElement, href: string) {
  return root.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!
}

describe('MarkdownHtml document links', () => {
  it.each(['![太阳](sun.png)', '[sun.png](sun.png)'])(
    'opens the resolved reply image in the shared image viewer: %s',
    async (text) => {
      const { links } = source({})
      Object.assign(links, { image: async () => 'data:image/png;base64,c3Vu' })
      const { root } = mount({ text }, links)
      await flushPromises()
      const image = root.querySelector<HTMLImageElement>('img')!
      image.focus()
      image.click()
      await nextTick()
      expect(imageViewer.value?.owner).toBe('s1')
      expect(imageViewer.value?.items[0]?.src).toBe(
        'data:image/png;base64,c3Vu',
      )
    },
  )

  it.each(['Enter', ' '])(
    'opens a reply image with %j from the keyboard',
    async (key) => {
      const { links } = source({})
      Object.assign(links, { image: async () => 'data:image/png;base64,c3Vu' })
      const { root } = mount({ text: '![太阳](sun.png)' }, links)
      await flushPromises()
      const image = root.querySelector<HTMLImageElement>('img')!
      expect(image.tabIndex).toBe(0)
      expect(image.getAttribute('role')).toBe('button')
      image.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      await nextTick()
      expect(imageViewer.value?.items[0]?.name).toBe('太阳')
    },
  )

  it('does not open the viewer outside a session', async () => {
    const { links } = source({})
    Object.assign(links, { image: async () => 'data:image/png;base64,c3Vu' })
    const { root } = mount({ text: '![太阳](sun.png)' }, links, '')
    await flushPromises()
    root.querySelector<HTMLImageElement>('img')!.click()
    await nextTick()
    expect(imageViewer.value).toBeNull()
  })

  it('previews both local image syntax and ordinary image links while retaining the file link', async () => {
    const { links } = source({
      'sun.png': { state: 'file', path: '/p/sun.png' },
    })
    Object.assign(links, { image: async () => 'data:image/png;base64,c3Vu' })
    const { root } = mount(
      { text: '![太阳](sun.png)\n\n图片：[sun.png](sun.png)' },
      links,
    )
    await flushPromises()
    expect(
      root.querySelectorAll('img[src="data:image/png;base64,c3Vu"]'),
    ).toHaveLength(2)
    expect(anchor(root, 'sun.png')).not.toBeNull()
  })
  it('does not insert a stale image after the reply changes', async () => {
    const { links } = source({
      'sun.png': { state: 'file', path: '/p/sun.png' },
    })
    let resolve!: (value: string) => void
    Object.assign(links, {
      image: () =>
        new Promise<string>((r) => {
          resolve = r
        }),
    })
    const { root, state } = mount({ text: '[sun](sun.png)' }, links)
    await flushPromises()
    state.text = 'another reply'
    await flushPromises()
    resolve('data:image/png;base64,c3Vu')
    await flushPromises()
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent?.trim()).toBe('another reply')
  })
  it('keeps an unavailable image link usable without a broken local src', async () => {
    const { links } = source({
      'sun.png': { state: 'missing', path: '/p/sun.png' },
    })
    Object.assign(links, { image: async () => null })
    const { root } = mount({ text: '[sun](sun.png)' }, links)
    await flushPromises()
    expect(root.querySelector('img[src]')).toBeNull()
    expect(anchor(root, 'sun.png').dataset.mdState).toBe('missing')
  })
  it('marks missing files and folders once Core says so', async () => {
    const { links, asked } = source({
      'docs/gone.md': { state: 'missing', path: '/p/docs/gone.md' },
      'src/app.ts': { state: 'file', path: '/p/src/app.ts' },
    })
    const { root } = mount({ text: `${TEXT} [dir](lib/)` }, links)
    await flushPromises()
    // Web links are never asked about; `docs` has no extension, so no chip.
    expect(asked.sort()).toEqual(['docs/gone.md', 'lib/', 'src/app.ts'])
    const gone = anchor(root, 'docs/gone.md')
    expect(gone.dataset.mdState).toBe('missing')
    expect(gone.getAttribute('aria-disabled')).toBe('true')
    expect(gone.title).toBe('不存在：/p/docs/gone.md')
    const app = anchor(root, 'src/app.ts')
    expect(app.dataset.mdState).toBeUndefined()
    expect(app.title).toBe('/p/src/app.ts')
    expect(app.dataset.mdBadge).toBe('TS')
  })

  it('shows a folder icon for a directory Core finds', async () => {
    const { links } = source({
      'src/app.ts': { state: 'directory', path: '/p/src/app.ts' },
    })
    const { root } = mount({ text: '[app.ts](src/app.ts)' }, links)
    await flushPromises()
    const app = anchor(root, 'src/app.ts')
    expect(app.dataset.mdIcon).toBe('folder')
    expect(app.dataset.mdBadge).toBeUndefined()
  })

  it('waits for streaming to finish, and checks again when statuses change', async () => {
    const statuses: Record<string, LinkStatus | null> = {
      'docs/gone.md': { state: 'missing', path: '/p/docs/gone.md' },
    }
    const { links, asked, version } = source(statuses)
    const { root, state } = mount(
      { text: '[gone.md](docs/gone.md)', streaming: true },
      links,
    )
    await flushPromises()
    expect(asked).toEqual([])
    state.streaming = false
    await flushPromises()
    expect(anchor(root, 'docs/gone.md').dataset.mdState).toBe('missing')
    // The file appears (a turn ended): the link is no longer marked.
    statuses['docs/gone.md'] = { state: 'file', path: '/p/docs/gone.md' }
    version.value += 1
    await flushPromises()
    const gone = anchor(root, 'docs/gone.md')
    expect(gone.dataset.mdState).toBeUndefined()
    expect(gone.hasAttribute('aria-disabled')).toBe(false)
  })

  it('renders plainly without a source', async () => {
    const { root } = mount({ text: TEXT })
    await flushPromises()
    expect(anchor(root, 'docs/gone.md').dataset.mdState).toBeUndefined()
  })
})

describe('MarkdownHtml while streaming (FIX-04)', () => {
  it('7 · keeps completed blocks, and a selection in them, while the reply grows', async () => {
    const { root, state } = mount({
      text: 'First finished paragraph.\n\nSecond one is stre',
      streaming: true,
    })
    await nextTick()
    const html = root.querySelector<HTMLElement>('.ds-md-html')!
    const first = html.querySelector('p')!
    expect(first.textContent).toBe('First finished paragraph.')
    const range = document.createRange()
    range.selectNodeContents(first)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    state.text =
      'First finished paragraph.\n\nSecond one is streaming.\n\n- a list'
    await nextTick()
    state.text += '\n- grows'
    await nextTick()

    expect(html.querySelector('p')).toBe(first)
    expect(first.isConnected).toBe(true)
    expect(selection.toString()).toBe('First finished paragraph.')
    expect(html.querySelectorAll('li')).toHaveLength(2)
  })

  it('renders the same HTML as the whole document once the stream ends', async () => {
    const text =
      '# Title\n\nSome **bold** text.\n\n| a | b |\n| - | - |\n| 1 | 2 |'
    const { root, state } = mount({ text: text.slice(0, 20), streaming: true })
    await nextTick()
    state.text = text
    await nextTick()
    state.streaming = false
    await nextTick()
    const whole = document.createElement('div')
    whole.innerHTML = renderMarkdown(text)
    expect(root.querySelector('.ds-md-html')!.innerHTML).toBe(whole.innerHTML)
  })
})
