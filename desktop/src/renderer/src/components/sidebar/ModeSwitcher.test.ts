// @vitest-environment jsdom
// MOD-02 (docs/design/modes.md § 切换): the brand row's 「Emperor Chat ▾」
// switcher — its menu, keyboard, label per mode and width, the badges, and
// the dot that only a waiting mode elsewhere lights.
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import ModeSwitcher from './ModeSwitcher.vue'
import type { AppMode, ModeActivity } from '../../runtime/appMode'

const idle = (): ModeActivity => ({ running: 0, waiting: false })

let app: App | undefined
let root: HTMLDivElement | undefined
const props = reactive<{
  mode: AppMode
  compact: boolean
  activity: Record<AppMode, ModeActivity>
}>({
  mode: 'chat',
  compact: false,
  activity: { chat: idle(), build: idle(), group: idle() },
})
const selected: AppMode[] = []

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

async function mount(initial: Partial<typeof props> = {}) {
  Object.assign(props, {
    mode: 'chat',
    compact: false,
    activity: { chat: idle(), build: idle(), group: idle() },
    ...initial,
  })
  selected.length = 0
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(ModeSwitcher, {
        ...props,
        onSelect: (mode: AppMode) => selected.push(mode),
      }),
  })
  app.mount(root)
  await settle()
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
  vi.useRealTimers()
})

const trigger = () =>
  root!.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const items = () => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
]
const item = (name: string) =>
  items().find((el) => el.textContent?.includes(name))!
const key = (target: HTMLElement, name: string) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: name, bubbles: true }),
  )

it('1 · opens on click, selects a mode, and closes on Esc or a click outside', async () => {
  await mount()
  expect(trigger().getAttribute('aria-expanded')).toBe('false')
  expect(menu()).toBeNull()

  trigger().click()
  await settle()
  expect(menu()).not.toBeNull()
  expect(trigger().getAttribute('aria-expanded')).toBe('true')
  expect(
    items().map((el) => el.querySelector('.mode-name')?.textContent),
  ).toEqual(['Chat', 'Build', 'Group'])
  expect(items().map((el) => el.getAttribute('aria-checked'))).toEqual([
    'true',
    'false',
    'false',
  ])
  // One Chinese line under each name, and the ⌘1–⌘3 keys.
  expect(item('Chat').textContent).toContain('对话：提问、写作、调研，不绑项目')
  expect(item('Build').textContent).toContain(
    '构建：在项目里写代码、调试和发布',
  )
  expect(item('Group').textContent).toContain(
    '群聊：联系人与群聊，多个 agent 协作',
  )
  expect(items().map((el) => el.querySelector('kbd')?.textContent)).toEqual([
    expect.stringMatching(/1$/),
    expect.stringMatching(/2$/),
    expect.stringMatching(/3$/),
  ])
  // The current mode takes the focus.
  expect(document.activeElement).toBe(item('Chat'))

  item('Build').click()
  await settle()
  expect(selected).toEqual(['build'])
  expect(menu()).toBeNull()
  expect(document.activeElement).toBe(trigger())

  trigger().click()
  await settle()
  key(document.activeElement as HTMLElement, 'Escape')
  await settle()
  expect(menu()).toBeNull()
  expect(document.activeElement).toBe(trigger())
  expect(selected).toEqual(['build'])

  trigger().click()
  await settle()
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  await settle()
  expect(menu()).toBeNull()
  expect(selected).toEqual(['build'])
})

it('2 · ↑ ↓ move the focus round the three modes; ↓ on the button opens the menu', async () => {
  await mount({ mode: 'build' })
  key(trigger(), 'ArrowDown')
  await settle()
  expect(menu()).not.toBeNull()
  expect(document.activeElement).toBe(item('Build'))
  key(document.activeElement as HTMLElement, 'ArrowDown')
  expect(document.activeElement).toBe(item('Group'))
  key(document.activeElement as HTMLElement, 'ArrowDown')
  expect(document.activeElement).toBe(item('Chat'))
  key(document.activeElement as HTMLElement, 'ArrowUp')
  expect(document.activeElement).toBe(item('Group'))
  key(document.activeElement as HTMLElement, 'Home')
  expect(document.activeElement).toBe(item('Chat'))
  key(document.activeElement as HTMLElement, 'End')
  expect(document.activeElement).toBe(item('Group'))
})

it('2 · names the button 「Emperor Chat / Build / Group ▾」, only the mode when narrow', async () => {
  await mount()
  const text = () => trigger().querySelector('.switcher-name')?.textContent
  expect(text()).toBe('Emperor Chat')
  expect(trigger().getAttribute('aria-label')).toBe('Emperor Chat')
  expect(trigger().querySelector('.switcher-chevron')).not.toBeNull()
  props.mode = 'build'
  await settle()
  expect(text()).toBe('Emperor Build')
  props.mode = 'group'
  await settle()
  expect(text()).toBe('Emperor Group')
  expect(trigger().getAttribute('aria-label')).toBe('Emperor Group')

  // Narrower than 248px: the mode name only; the full name in the tooltip
  // and the accessible name.
  vi.useFakeTimers()
  props.compact = true
  await nextTick()
  expect(text()).toBe('Group')
  expect(trigger().getAttribute('aria-label')).toBe('Emperor Group')
  trigger().dispatchEvent(new Event('pointerenter'))
  vi.advanceTimersByTime(600)
  await nextTick()
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Emperor Group',
  )
})

it('5 · shows 「N 个在运行」 and 「等你回答」 beside each mode', async () => {
  await mount({
    activity: {
      chat: idle(),
      build: { running: 2, waiting: false },
      group: { running: 1, waiting: true },
    },
  })
  trigger().click()
  await settle()
  const badges = (name: string) =>
    [...item(name).querySelectorAll('.ds-badge')].map((el) =>
      el.textContent?.trim(),
    )
  expect(badges('Chat')).toEqual([])
  expect(badges('Build')).toEqual(['2 个在运行'])
  expect(badges('Group')).toEqual(['1 个在运行', '等你回答'])
})

it('6 · only 「等你回答」 in another mode lights the dot on the mark', async () => {
  const dot = () => trigger().querySelector('.switcher-dot')
  await mount({
    mode: 'chat',
    activity: {
      chat: { running: 0, waiting: true },
      build: { running: 4, waiting: false },
      group: idle(),
    },
  })
  // Running elsewhere, or waiting in the mode on screen: no dot.
  expect(dot()).toBeNull()
  props.activity = {
    chat: idle(),
    build: idle(),
    group: { running: 0, waiting: true },
  }
  await settle()
  expect(dot()).not.toBeNull()
  expect(trigger().getAttribute('aria-label')).toBe(
    'Emperor Chat，其他模式等你回答',
  )
  props.mode = 'group'
  await settle()
  expect(dot()).toBeNull()
})
