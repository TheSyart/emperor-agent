// @vitest-environment jsdom
/**
 * BRD-05: SkinHost — the chosen skin's tokens as inline styles on the root
 * (card test 1, renderer side), a light-only skin holding the theme, the
 * exempt zones' values, the cache that avoids a flash at start-up, and
 * falling back to 御书房 when a skin's folder is gone (card test 9).
 */
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkinView } from '../../../shared/skin-contract'

const ZHUPI: SkinView = {
  id: 'zhupi',
  name: '朱批',
  author: 'Emperor',
  license: '',
  description: '',
  official: true,
  base: 'light',
  tokens: {
    '--surface-canvas': '246 239 225',
    '--brand': '184 50 31',
    '--stroke-2': 'rgb(90 50 20 / 0.14)',
  },
  reset: {
    light: {
      '--surface-canvas': '246 245 242',
      '--sidebar-fill': '246 245 242',
      '--brand': '156 111 36',
      '--stroke-2': 'rgb(0 0 0 / 0.12)',
      '--hairline': 'rgb(0 0 0 / 0.12)',
    },
  },
  fonts: { heading: 'songti' },
  slots: {
    hero: 'app://skin/zhupi/hero.webp?v=1',
    approved: 'app://skin/zhupi/seal.webp?v=1',
  },
  preview: {},
}

const YUSHUFANG: SkinView = {
  ...ZHUPI,
  id: 'yushufang',
  name: '御书房',
  base: 'auto',
  tokens: {},
  reset: { light: {}, dark: {} },
  fonts: { heading: 'system' },
  slots: { sidebarFooter: 'app://skin/yushufang/robe.webp?v=1' },
}

const PAPER: SkinView = {
  ...ZHUPI,
  id: 'paper',
  name: '宣纸',
  official: false,
}

type Module = typeof import('./skinState')
type Theme = typeof import('../composables/useTheme')
let skin: Module
let theme: Theme
let toasts: typeof import('../components/ui/toasts')
const skinGet = vi.fn()

async function load(): Promise<void> {
  vi.resetModules()
  toasts = await import('../components/ui/toasts')
  theme = await import('../composables/useTheme')
  skin = await import('./skinState')
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve()
  await nextTick()
}

const root = () => document.documentElement
const prop = (name: string) => root().style.getPropertyValue(name)

beforeEach(async () => {
  localStorage.clear()
  root().removeAttribute('style')
  delete root().dataset.skin
  skinGet.mockReset()
  skinGet.mockImplementation(async (id: string) => {
    const view = { zhupi: ZHUPI, yushufang: YUSHUFANG }[id]
    return view ? { ok: true, skin: view } : { ok: false, missing: true }
  })
  ;(window as unknown as { emperor?: unknown }).emperor = { skinGet }
  await load()
})

afterEach(() => {
  skin.resetSkinForTests()
  delete (window as unknown as { emperor?: unknown }).emperor
})

describe('SkinHost', () => {
  it('1 · writes a skin’s tokens and heading font on the root, and takes them back', async () => {
    theme.initTheme()
    skin.initSkin()
    await skin.selectSkin('zhupi')
    await nextTick()
    expect(root().dataset.skin).toBe('zhupi')
    expect(prop('--surface-canvas')).toBe('246 239 225')
    expect(prop('--stroke-2')).toBe('rgb(90 50 20 / 0.14)')
    expect(prop('--font-heading')).toContain('Songti SC')
    await skin.selectSkin('yushufang')
    await nextTick()
    expect(root().dataset.skin).toBe('yushufang')
    expect(prop('--surface-canvas')).toBe('')
    expect(prop('--font-heading')).toBe('')
    expect(root().getAttribute('style') ?? '').toBe('')
  })

  it('keeps the choice and the checked view for the next start', async () => {
    skin.initSkin()
    await skin.selectSkin('zhupi')
    const stored = JSON.parse(localStorage.getItem(skin.SKIN_STORAGE_KEY)!)
    expect(stored.id).toBe('zhupi')
    expect(stored.view.tokens['--brand']).toBe('184 50 31')
  })

  it('applies the cached skin before main answers (no flash), then refreshes it', async () => {
    localStorage.setItem(
      skin.SKIN_STORAGE_KEY,
      JSON.stringify({ id: 'zhupi', view: ZHUPI }),
    )
    let answer: (value: unknown) => void = () => undefined
    skinGet.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    )
    skin.initSkin()
    expect(prop('--surface-canvas')).toBe('246 239 225')
    answer({
      ok: true,
      skin: { ...ZHUPI, tokens: { '--brand': '170 40 20' } },
    })
    await settle()
    expect(prop('--brand')).toBe('170 40 20')
    expect(prop('--surface-canvas')).toBe('')
  })

  it('ignores a cached view that is not one main would send', async () => {
    localStorage.setItem(
      skin.SKIN_STORAGE_KEY,
      JSON.stringify({
        id: 'zhupi',
        view: { ...ZHUPI, tokens: { '--brand': 'url(https://evil.test/a)' } },
      }),
    )
    skinGet.mockImplementationOnce(() => new Promise(() => undefined))
    skin.initSkin()
    expect(prop('--brand')).toBe('')
  })

  it('starts on 御书房 when nothing was chosen', async () => {
    skin.initSkin()
    await settle()
    expect(skinGet).toHaveBeenCalledWith('yushufang')
    expect(skin.useSkin().skin.value?.id).toBe('yushufang')
    expect(skin.skinSlotUrl('sidebarFooter')).toBe(
      'app://skin/yushufang/robe.webp?v=1',
    )
  })

  it('shows no skin outside the desktop window (no bridge)', async () => {
    delete (window as unknown as { emperor?: unknown }).emperor
    await load()
    skin.initSkin()
    await settle()
    expect(skin.useSkin().skin.value).toBeNull()
    expect(root().dataset.skin).toBeUndefined()
    expect(skin.skinSlotUrl('sidebarFooter')).toBeNull()
  })
})

describe('9 · a skin whose folder is gone', () => {
  it('falls back to 御书房 and says so', async () => {
    localStorage.setItem(
      skin.SKIN_STORAGE_KEY,
      JSON.stringify({ id: 'paper', view: PAPER }),
    )
    skin.initSkin()
    expect(prop('--brand')).toBe('184 50 31')
    await settle()
    expect(skin.useSkin().skin.value?.id).toBe('yushufang')
    expect(prop('--brand')).toBe('')
    expect(JSON.parse(localStorage.getItem(skin.SKIN_STORAGE_KEY)!).id).toBe(
      'yushufang',
    )
    expect(toasts.visibleToasts.value.map((toast) => toast.message)).toEqual([
      '找不到皮肤「宣纸」，已换回「御书房」',
    ])
  })

  it('checks again when a picture fails to load', async () => {
    skin.initSkin()
    await skin.selectSkin('zhupi')
    skinGet.mockResolvedValueOnce({ ok: false, missing: true })
    await skin.verifySkin()
    await settle()
    expect(skin.useSkin().skin.value?.id).toBe('yushufang')
  })
})

describe('a skin with one look', () => {
  it('holds the theme it has and says why the toggle does nothing', async () => {
    localStorage.setItem('emperor.theme', 'dark')
    theme.initTheme()
    skin.initSkin()
    expect(root().dataset.theme).toBe('dark')
    await skin.selectSkin('zhupi')
    await nextTick()
    expect(root().dataset.theme).toBe('light')
    theme.useTheme().toggle()
    expect(root().dataset.theme).toBe('light')
    expect(toasts.visibleToasts.value.at(-1)?.message).toBe(
      '皮肤「朱批」只有浅色，换个皮肤才能用深色',
    )
    // The choice is kept for when the skin changes.
    expect(theme.useTheme().preference.value).toBe('dark')
    await skin.selectSkin('yushufang')
    await nextTick()
    expect(root().dataset.theme).toBe('dark')
  })

  it('goes back to the chosen theme when the skin changes', async () => {
    localStorage.setItem('emperor.theme', 'dark')
    theme.initTheme()
    skin.initSkin()
    await skin.selectSkin('zhupi')
    await nextTick()
    await skin.selectSkin('yushufang')
    await nextTick()
    expect(root().dataset.theme).toBe('dark')
  })
})

describe('exempt zones', () => {
  it('get the base theme’s values for what the skin changed', async () => {
    theme.initTheme()
    skin.initSkin()
    expect(skin.useSkinExempt().value).toEqual({})
    await skin.selectSkin('zhupi')
    await nextTick()
    expect(skin.useSkinExempt().value).toEqual(ZHUPI.reset.light)
    await skin.selectSkin('yushufang')
    await nextTick()
    expect(skin.useSkinExempt().value).toEqual({})
  })
})

describe('decorations', () => {
  it('can all be hidden in one place (显示吉祥物, BRD-04)', async () => {
    skin.initSkin()
    await skin.selectSkin('zhupi')
    expect(skin.skinSlotUrl('hero')).toBe('app://skin/zhupi/hero.webp?v=1')
    skin.setSkinDecorationsShown(false)
    expect(skin.skinSlotUrl('hero')).toBeNull()
  })
})
