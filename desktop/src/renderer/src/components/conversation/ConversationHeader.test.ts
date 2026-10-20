// @vitest-environment jsdom
// The conversation header's first row is a 46px bar whose bottom meets the
// workspace header's (UI-S01; UI-S11 brought back the system title bar, so
// it is no longer a window drag region).
// UI-S09: the 对话 | 轨迹 strip exists only while 显示轨迹 is on.
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, expect, it } from 'vitest'
import ConversationHeader from './ConversationHeader.vue'

let app: App | undefined
let root: HTMLDivElement

afterEach(() => {
  app?.unmount()
  root?.remove()
})

async function mount(props: { slim?: boolean; trajectory?: boolean } = {}) {
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(ConversationHeader, {
        crumbs: [{ id: 'c', label: '会话', current: true }],
        tab: 'chat',
        workspaceOpen: false,
        envCardOpen: false,
        ...props,
      }),
  })
  app.config.warnHandler = () => undefined
  app.mount(root)
  await nextTick()
}

it('makes its first row the 46px bar, in both phases', async () => {
  for (const slim of [false, true]) {
    await mount({ slim })
    const row = root.querySelector<HTMLElement>(
      '.conversation-header > .title-row',
    )!
    expect(row.hasAttribute('data-app-drag')).toBe(false)
    expect(row.querySelector('[aria-label="工作台"]')).not.toBeNull()
    app?.unmount()
    root.remove()
  }
  const source = (await import('./ConversationHeader.vue?raw')).default
  expect(source).toMatch(/\.title-row\s*\{[^}]*height:\s*var\(--shell-bar-h\)/)
})

it('UI-S09 · 1: without the trajectory the header is its top bar alone', async () => {
  await mount()
  const header = root.querySelector<HTMLElement>('.conversation-header')!
  expect(root.querySelector('[role="tablist"]')).toBeNull()
  expect(root.textContent).not.toContain('轨迹')
  expect([...header.children].map((child) => child.className)).toEqual([
    'title-row',
  ])
})

it('UI-S09 · 4: with the trajectory on, the 对话 | 轨迹 tabs come back', async () => {
  await mount({ trajectory: true })
  const tabs = [...root.querySelectorAll('[role="tab"]')].map((tab) =>
    tab.textContent?.trim(),
  )
  expect(tabs).toEqual(['对话', '轨迹'])
  // The hero header stays the toggles alone either way.
  app?.unmount()
  root.remove()
  await mount({ trajectory: true, slim: true })
  expect(root.querySelector('[role="tablist"]')).toBeNull()
})
