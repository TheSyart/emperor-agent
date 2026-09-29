// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, reactive, ref } from 'vue'
import MarkdownHtml from './MarkdownHtml.vue'
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

afterEach(() => {
  container?.remove()
  container = null
})

function mount(
  props: { text: string; streaming?: boolean },
  links?: LinkStatusSource,
) {
  const state = reactive({ streaming: false, ...props })
  container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MarkdownHtml, { ...state }) })
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
