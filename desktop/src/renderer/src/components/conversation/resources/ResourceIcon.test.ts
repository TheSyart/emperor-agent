// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { core } from '../../../api/http'
import { setUiPreference } from '../../../composables/useUiPreferences'
import ResourceIcon from './ResourceIcon.vue'
import MarkdownHtml from '../parts/MarkdownHtml.vue'
import { provideChatContext, createExpansionStore } from '../chatContext'
import { displayResource } from './resourceModel'
vi.mock('../../../api/http', () => ({ core: vi.fn() }))
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII='
let cleanup = () => {}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}
function mount(content: () => ReturnType<typeof h>) {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup() {
      provideChatContext({
        actions: { inspect() {}, openSubagent() {}, editMessage() {} },
        expansion: createExpansionStore(),
        sessionId: () => 'icon-test',
      })
      return content
    },
  })
  app.mount(root)
  cleanup = () => {
    app.unmount()
    root.remove()
  }
  return root
}
describe('website identity icons', () => {
  // These cases exercise real site icons, which are opt-in (W-3).
  beforeEach(() => setUiPreference('siteIconService', true))
  afterEach(() => setUiPreference('siteIconService', true))
  it('ignores an old-session response after switching and a response after unmount', async () => {
    let finish!: (value: unknown) => void
    const session = ref('old-icon-session')
    const newIcon = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='
    vi.mocked(core).mockImplementation((async (
      op: string,
      input: { sessionId: string },
    ) => {
      if (op === 'references.resolve') return { id: input.sessionId }
      return input.sessionId === 'old-icon-session'
        ? new Promise<unknown>((resolve) => {
            finish = resolve
          })
        : { state: 'ready', dataUrl: newIcon }
    }) as typeof core)
    const root = mount(() =>
      h(ResourceIcon, {
        resource: displayResource('https://switch-icon.example', '', 'm1')!,
        sessionId: session.value,
      }),
    )
    await flush()
    session.value = 'new-icon-session'
    await flush()
    expect(root.querySelector('img')?.getAttribute('src')).toBe(newIcon)
    finish({ state: 'ready', dataUrl: PNG })
    await flush()
    expect(root.querySelector('img')?.getAttribute('src')).toBe(newIcon)
    cleanup()
    expect(root.isConnected).toBe(false)
  })
  it('renders a real site icon in resource components without opening details', async () => {
    vi.mocked(core).mockImplementation((async (op: string) =>
      op === 'references.resolve'
        ? { id: 'opaque-icon' }
        : { state: 'ready', dataUrl: PNG }) as typeof core)
    const root = mount(() =>
      h(ResourceIcon, {
        resource: displayResource(
          'https://component.example',
          'Website',
          'm1',
        )!,
      }),
    )
    await flush()
    expect(root.querySelector('img.site-icon')?.getAttribute('src')).toBe(PNG)
    expect(vi.mocked(core).mock.calls.map((c) => c[0])).toEqual([
      'references.resolve',
      'references.siteIcon',
    ])
  })
  it('hydrates markdown links with real raster icons and keeps their original text and URL', async () => {
    vi.mocked(core).mockImplementation((async (op: string) =>
      op === 'references.resolve'
        ? { id: 'opaque-markdown' }
        : { state: 'ready', dataUrl: PNG }) as typeof core)
    const root = mount(() =>
      h(MarkdownHtml, {
        text: '[完整名字](https://markdown.example/a?b=1)',
        sourceMessageId: 'm2',
      }),
    )
    await flush()
    const link = root.querySelector('a')!
    expect(link.dataset.siteIcon).toBe('ready')
    expect(link.querySelector('img.site-icon')?.getAttribute('src')).toBe(PNG)
    expect(link.textContent).toBe('完整名字')
    expect(link.getAttribute('href')).toBe('https://markdown.example/a?b=1')
  })
  it('keeps an inert fallback when icon lookup fails', async () => {
    vi.mocked(core).mockImplementation((async (op: string) =>
      op === 'references.resolve'
        ? { id: 'opaque-failure' }
        : { state: 'unavailable' }) as typeof core)
    const root = mount(() =>
      h(ResourceIcon, {
        resource: displayResource('https://offline-icon.example', '', 'm3')!,
      }),
    )
    await flush()
    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toBe('O')
  })
})
