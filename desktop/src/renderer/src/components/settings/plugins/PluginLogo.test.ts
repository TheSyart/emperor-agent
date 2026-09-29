// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import PluginLogo from './PluginLogo.vue'

let app: App | null = null
afterEach(() => {
  app?.unmount()
  app = null
})

function mount(props: { name: string; logo?: string | null; size?: number }) {
  const host = document.createElement('div')
  app = createApp({ render: () => h(PluginLogo, props) })
  app.mount(host)
  return host
}

describe('PluginLogo', () => {
  it('shows the host image, and the monogram when it breaks', async () => {
    const host = mount({
      name: 'GitHub',
      logo: 'app://plugin-assets/managed/github/logo?v=1',
      size: 56,
    })
    const image = host.querySelector<HTMLImageElement>('img.plugin-logo')!
    expect(image.getAttribute('src')).toBe(
      'app://plugin-assets/managed/github/logo?v=1',
    )
    expect(image.getAttribute('aria-hidden')).toBe('true')
    image.dispatchEvent(new Event('error'))
    await nextTick()
    const tile = host.querySelector('.monogram')!
    expect(tile.textContent?.trim()).toBe('G')
    expect(host.querySelector('img')).toBeNull()
  })

  it('draws the monogram without a logo', () => {
    const host = mount({ name: 'computer use' })
    expect(host.querySelector('.monogram')!.textContent?.trim()).toBe('C')
  })
})
