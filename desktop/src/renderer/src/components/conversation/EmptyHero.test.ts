// @vitest-environment jsdom
// MOD-03 1: the empty session's headline and the line under it follow the
// mode — Chat greets by the profile's 称呼, Build asks for a project.
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, expect, it } from 'vitest'
import EmptyHero from './EmptyHero.vue'
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
