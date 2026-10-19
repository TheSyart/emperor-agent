// @vitest-environment jsdom
// UI-S01 (PLAN-V020): the conversation header's first row is the center
// panel's 46px top bar — a window drag region whose buttons stay clickable.
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, expect, it } from 'vitest'
import ConversationHeader from './ConversationHeader.vue'

let app: App | undefined
let root: HTMLDivElement

afterEach(() => {
  app?.unmount()
  root?.remove()
})

async function mount(slim = false) {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(ConversationHeader, {
        crumbs: [{ id: 'c', label: '会话', current: true }],
        tab: 'chat',
        workspaceOpen: false,
        envCardOpen: false,
        slim,
      }),
  })
  app.config.warnHandler = () => undefined
  app.mount(root)
  await nextTick()
}

it('makes its first row the 46px drag bar, in both phases', async () => {
  for (const slim of [false, true]) {
    await mount(slim)
    const row = root.querySelector<HTMLElement>(
      '.conversation-header > .title-row',
    )!
    expect(row.hasAttribute('data-app-drag')).toBe(true)
    expect(row.querySelector('[aria-label="工作台"]')).not.toBeNull()
    app?.unmount()
    root.remove()
  }
  const source = (await import('./ConversationHeader.vue?raw')).default
  expect(source).toMatch(/\.title-row\s*\{[^}]*height:\s*var\(--shell-bar-h\)/)
})
