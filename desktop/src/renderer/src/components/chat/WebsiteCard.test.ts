// @vitest-environment jsdom
import { createApp } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebsiteCard from './WebsiteCard.vue'

let container: HTMLDivElement | null = null
let app: ReturnType<typeof createApp> | null = null

afterEach(() => {
  app?.unmount()
  container?.remove()
  container = null
  app = null
})

function mount(status: 'ready' | 'stopped') {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(WebsiteCard, {
    previewId: 'site-owned',
    title: 'Project preview',
    status,
  })
  app.mount(container)
  return container
}

describe('WebsiteCard', () => {
  it('dispatches only opaque preview IDs for in-app and external opening', () => {
    const inApp = vi.fn()
    const external = vi.fn()
    window.addEventListener('emperor:open-preview', inApp)
    window.addEventListener('emperor:open-preview-external', external)
    const root = mount('ready')

    root
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach((button) => button.click())

    expect((inApp.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      previewId: 'site-owned',
    })
    expect((external.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      previewId: 'site-owned',
    })
    window.removeEventListener('emperor:open-preview', inApp)
    window.removeEventListener('emperor:open-preview-external', external)
  })

  it('disables stale stopped previews', () => {
    const root = mount('stopped')
    expect(
      [...root.querySelectorAll<HTMLButtonElement>('button')].every(
        (button) => button.disabled,
      ),
    ).toBe(true)
  })
})
