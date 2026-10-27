// @vitest-environment jsdom
// BRD-04: 设置 › 常规 ends with 关于 — 小单 in the robe, the name, one line
// of what Emperor is, and the 「单」 seal as its signature. 显示吉祥物 off
// takes the figure away; the seal stays (it is the signature, not a picture
// of the mascot).
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, expect, it } from 'vitest'
import AboutGroup from './AboutGroup.vue'
import {
  UI_PREFERENCES_STORAGE_KEY,
  reloadUiPreferences,
} from '../../composables/useUiPreferences'

let app: App | undefined
let root: HTMLDivElement | undefined

async function mount() {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({ render: () => h(AboutGroup) })
  app.mount(root)
  await nextTick()
  return root
}

beforeEach(() => {
  localStorage.removeItem(UI_PREFERENCES_STORAGE_KEY)
  reloadUiPreferences()
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
})

it('says who Emperor is, signed with the 单 seal', async () => {
  const about = await mount()
  const group = about.querySelector('[data-group="about"]')!
  expect(group.textContent).toContain('Emperor Agent')
  expect(group.textContent).toContain('你做决定，agent 们办事。')
  expect(
    group.querySelector('[data-about-seal]')!.getAttribute('src'),
  ).toContain('seal-dan')
  expect(
    group.querySelector('[data-about-figure]')!.getAttribute('src'),
  ).toContain('robe')
})

it('leaves 小单 out when 显示吉祥物 is off', async () => {
  localStorage.setItem(
    UI_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ showMascot: false }),
  )
  reloadUiPreferences()
  const about = await mount()
  expect(about.querySelector('[data-about-figure]')).toBeNull()
  expect(about.querySelector('[data-about-seal]')).not.toBeNull()
})
