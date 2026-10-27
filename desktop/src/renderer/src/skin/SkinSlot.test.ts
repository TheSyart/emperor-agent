// @vitest-environment jsdom
/**
 * BRD-05: SkinSlot — a decoration position. It shows the skin's picture
 * when the skin has one, as decoration only (no alt text, hidden from
 * assistive technology, not draggable, never a target), and nothing
 * otherwise; SkinExempt sets the base theme's values on its zone.
 */
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkinView } from '../../../shared/skin-contract'

const VIEW: SkinView = {
  id: 'zhupi',
  name: '朱批',
  author: '',
  license: '',
  description: '',
  official: true,
  base: 'light',
  tokens: { '--brand': '184 50 31' },
  reset: { light: { '--brand': '156 111 36', '--caret': '156 111 36' } },
  fonts: { heading: 'system' },
  slots: { hero: 'app://skin/zhupi/hero.webp?v=1' },
  preview: {},
}

const skinGet = vi.fn(async (id: string) =>
  id === 'zhupi' ? { ok: true, skin: VIEW } : { ok: false, missing: true },
)

let app: App | null = null
let container: HTMLDivElement | null = null

async function mount(render: () => ReturnType<typeof h>) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render })
  app.mount(container)
  await nextTick()
  return container
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  ;(window as unknown as { emperor?: unknown }).emperor = { skinGet }
})

afterEach(async () => {
  app?.unmount()
  container?.remove()
  app = null
  ;(await import('./skinState')).resetSkinForTests()
})

describe('SkinSlot', () => {
  it('shows the skin’s picture as decoration only', async () => {
    const state = await import('./skinState')
    const { default: SkinSlot } = await import('./SkinSlot.vue')
    state.initSkin()
    await state.selectSkin('zhupi')
    const root = await mount(() => h(SkinSlot, { name: 'hero', class: 'x' }))
    const img = root.querySelector('img')!
    expect(img.getAttribute('src')).toBe('app://skin/zhupi/hero.webp?v=1')
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('aria-hidden')).toBe('true')
    expect(img.getAttribute('draggable')).toBe('false')
    expect(img.dataset.skinSlot).toBe('hero')
    expect(img.classList.contains('x')).toBe(true)
  })

  it('renders nothing for a slot the skin leaves empty, or with decorations off', async () => {
    const state = await import('./skinState')
    const { default: SkinSlot } = await import('./SkinSlot.vue')
    state.initSkin()
    await state.selectSkin('zhupi')
    const root = await mount(() =>
      h('div', [
        h(SkinSlot, { name: 'sidebarFooter' }),
        h(SkinSlot, { name: 'hero' }),
      ]),
    )
    expect(root.querySelectorAll('img')).toHaveLength(1)
    state.setSkinDecorationsShown(false)
    await nextTick()
    expect(root.querySelectorAll('img')).toHaveLength(0)
  })

  it('asks main again when its picture does not load', async () => {
    const state = await import('./skinState')
    const { default: SkinSlot } = await import('./SkinSlot.vue')
    state.initSkin()
    await state.selectSkin('zhupi')
    const root = await mount(() => h(SkinSlot, { name: 'hero' }))
    skinGet.mockClear()
    root.querySelector('img')!.dispatchEvent(new Event('error'))
    await nextTick()
    expect(skinGet).toHaveBeenCalledWith('zhupi')
  })
})

describe('SkinExempt', () => {
  it('puts the base values on its zone without adding a box', async () => {
    const state = await import('./skinState')
    const { default: SkinExempt } = await import('./SkinExempt.vue')
    const root = await mount(() => h(SkinExempt, null, () => h('p', '正文')))
    const zone = root.querySelector<HTMLElement>('[data-skin-exempt]')!
    expect(zone.getAttribute('style')).toBeNull()
    state.initSkin()
    await state.selectSkin('zhupi')
    await nextTick()
    expect(zone.style.getPropertyValue('--brand')).toBe('156 111 36')
    expect(zone.style.getPropertyValue('--caret')).toBe('156 111 36')
    expect(zone.textContent).toBe('正文')
  })
})
