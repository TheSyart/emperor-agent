// @vitest-environment jsdom
// MOD-03 1: the empty session's headline and the line under it follow the
// mode — Chat greets by the profile's 称呼, Build asks for a project.
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, expect, it } from 'vitest'
import EmptyHero from './EmptyHero.vue'
import {
  UI_PREFERENCES_STORAGE_KEY,
  reloadUiPreferences,
} from '../../composables/useUiPreferences'
import type { AppMode } from '../../runtime/appMode'

let app: App | undefined
let root: HTMLDivElement | undefined

async function mount(mode: AppMode | undefined, addressName: string | null) {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({ render: () => h(EmptyHero, { mode, addressName }) })
  app.mount(root)
  await nextTick()
  return {
    headline: root.querySelector('h1')!.textContent?.trim(),
    note: root.querySelector('.note')?.textContent?.trim() ?? null,
  }
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
})

it('1 · Chat greets by name and has no line under it', async () => {
  expect(await mount('chat', '安先生')).toEqual({
    headline: '安先生，今天想聊点什么？',
    note: null,
  })
})

it('1 · without a mode it is the Chat home', async () => {
  expect((await mount(undefined, null)).headline).toBe('今天想聊点什么？')
})

it('1 · Build asks for a project and says where sessions run', async () => {
  expect(await mount('build', '安先生')).toEqual({
    headline: '今天推进哪个项目？',
    note: '构建会话都在某个项目文件夹里运行，可以读写文件、跑命令。',
  })
})

it('BRD-04 · the first Build home shows 小单 on his throne above the words', async () => {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () => h(EmptyHero, { mode: 'build', scene: true }),
  })
  app.mount(root)
  await nextTick()
  const scene = root.querySelector<HTMLImageElement>('[data-hero-scene]')!
  expect(scene.getAttribute('src')).toContain('throne')
  // Decoration only: screen readers read the headline, not the picture.
  expect(scene.getAttribute('alt')).toBe('')
  expect(scene.closest('[aria-hidden="true"]')).not.toBeNull()
  // The mark stays out while the scene stands in for it.
  expect(root.querySelector('.brand-mark')).toBeNull()
  expect(root.querySelector('h1')!.textContent?.trim()).toBe(
    '今天推进哪个项目？',
  )
})

it('BRD-04 · no scene unless asked', async () => {
  await mount('build', null)
  expect(root!.querySelector('[data-hero-scene]')).toBeNull()
  expect(root!.querySelector('.brand-mark')).not.toBeNull()
})

it('BRD-06 · asks in court words while 宫廷用语 is on, without the 称呼', async () => {
  localStorage.setItem(
    UI_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ courtlyCopy: true }),
  )
  reloadUiPreferences()
  try {
    expect((await mount('chat', '安先生')).headline).toBe('朕今日要办何事？')
    app?.unmount()
    root?.remove()
    expect((await mount('group', null)).headline).toBe('今日宣谁议事？')
  } finally {
    localStorage.removeItem(UI_PREFERENCES_STORAGE_KEY)
    reloadUiPreferences()
  }
})

it('BRD-05 · shows the skin’s hero picture above the greeting, not for a contact', async () => {
  const state = await import('../../skin/skinState')
  ;(window as unknown as { emperor?: unknown }).emperor = {
    skinGet: async () => ({
      ok: true,
      skin: {
        id: 'richang',
        name: '日常',
        base: 'auto',
        tokens: {},
        reset: { light: {}, dark: {} },
        fonts: { heading: 'system' },
        slots: { hero: 'app://skin/richang/hoodie.webp?v=1' },
      },
    }),
  }
  try {
    state.initSkin()
    await state.selectSkin('richang')
    await mount('chat', null)
    const hero = root!.querySelector<HTMLImageElement>(
      'img[data-skin-slot="hero"]',
    )
    expect(hero?.getAttribute('src')).toBe('app://skin/richang/hoodie.webp?v=1')
    expect(root!.querySelector('.empty-hero')?.firstElementChild).toBe(hero)
    app?.unmount()
    root?.remove()
    root = document.createElement('div')
    document.body.append(root)
    app = createApp({
      render: () =>
        h(EmptyHero, {
          speaker: {
            id: 'c1',
            name: '架构师',
            avatar: { name: '架构师' },
          } as never,
        }),
    })
    app.mount(root)
    await nextTick()
    expect(root.querySelector('img[data-skin-slot]')).toBeNull()
  } finally {
    state.resetSkinForTests()
    delete (window as unknown as { emperor?: unknown }).emperor
  }
})

it('BRD-04 + BRD-05 · a skin’s picture stands in for the throne: never two 小单', async () => {
  const state = await import('../../skin/skinState')
  ;(window as unknown as { emperor?: unknown }).emperor = {
    skinGet: async () => ({
      ok: true,
      skin: {
        id: 'richang',
        name: '日常',
        base: 'auto',
        tokens: {},
        reset: { light: {}, dark: {} },
        fonts: { heading: 'system' },
        slots: { hero: 'app://skin/richang/hoodie.webp?v=1' },
      },
    }),
  }
  try {
    state.initSkin()
    await state.selectSkin('richang')
    root = document.createElement('div')
    document.body.append(root)
    app = createApp({
      render: () => h(EmptyHero, { mode: 'build', scene: true }),
    })
    app.mount(root)
    await nextTick()
    expect(root.querySelector('img[data-skin-slot="hero"]')).not.toBeNull()
    expect(root.querySelector('[data-hero-scene]')).toBeNull()
    // 显示吉祥物 off: neither picture.
    state.setSkinDecorationsShown(false)
    await nextTick()
    expect(root.querySelector('img[data-skin-slot="hero"]')).toBeNull()
  } finally {
    state.resetSkinForTests()
    delete (window as unknown as { emperor?: unknown }).emperor
  }
})
