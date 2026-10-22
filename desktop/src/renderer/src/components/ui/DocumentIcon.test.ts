// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import DocumentIcon from './DocumentIcon.vue'

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  app?.unmount()
  host?.remove()
})

function mount(
  path: string,
  options: { size?: number; directory?: boolean } = {},
) {
  const state = reactive({ path, ...options })
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(DocumentIcon, state) })
  app.mount(host)
  return { root: host, state }
}

describe('DocumentIcon', () => {
  // A language routed to the generic page/badge would lose the custom SVG.
  it('renders a distinct inline vector for a language and preserves its category', () => {
    const { root } = mount('src/app.ts')
    const icon = root.querySelector('[data-icon-id="typescript"]')
    expect(icon).not.toBeNull()
    expect(icon?.getAttribute('data-kind')).toBe('language')
    expect(icon?.getAttribute('data-tone')).toBe('blue')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(icon?.querySelector('svg')?.getAttribute('viewBox')).toBe(
      '0 0 24 24',
    )
    expect(icon?.querySelector('text')).toBeNull()
    expect(icon?.textContent?.trim()).toBe('')
  })

  // A stale computed selection would keep the previous file's vector.
  it('updates the icon when the file changes and honors directory overrides', async () => {
    const { root, state } = mount('draft.md', { size: 32, directory: false })
    expect(root.querySelector('[data-icon-id="markdown"]')).not.toBeNull()
    state.path = 'draft.pdf'
    await nextTick()
    expect(root.querySelector('[data-icon-id="pdf"]')).not.toBeNull()
    state.directory = true
    await nextTick()
    const icon = root.querySelector<HTMLElement>('[data-icon-id="folder"]')
    expect(icon?.getAttribute('data-kind')).toBe('folder')
    expect(icon?.style.width).toBe('32px')
    expect(icon?.style.height).toBe('32px')
  })

  // User-supplied names must only select trusted assets, never become markup.
  it('keeps hostile file names out of the rendered SVG', () => {
    const { root } = mount('<img src=x onerror=alert(1)>.unknown')
    const icon = root.querySelector<HTMLElement>('[data-icon-id="file"]')
    expect(icon).not.toBeNull()
    expect(icon?.style.width).toBe('15px')
    expect(root.querySelector('img, script, foreignObject')).toBeNull()
    expect(root.innerHTML).not.toContain('onerror')
  })
})
