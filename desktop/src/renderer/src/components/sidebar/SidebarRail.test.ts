// @vitest-environment jsdom
// UI-S01 (PLAN-V020): the permanent 56px icon rail — its entries, the
// GitHub-gated Pull Request entry, the selected state and the drag region
// at its top where the traffic lights sit.
import { createApp, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SidebarRail from './SidebarRail.vue'

const mock = vi.hoisted(() => ({ context: {} as Record<string, unknown> }))
vi.mock('../../composables/useAppContext', () => ({
  useAppContext: () => mock.context,
}))

const github = (activation: string) => ({
  pluginId: 'github',
  effective: true,
  activation,
})

let app: App | undefined
let root: HTMLDivElement
let router: Router
let emitted: string[]

beforeEach(() => {
  mock.context = {
    boot: ref({ plugins: [github('active')] }),
    sessionId: ref('s1'),
  }
  emitted = []
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
})

async function mount(path = '/chat/s1', collapsed = false) {
  const view = { render: () => null }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat/:sessionId?', name: 'chat', component: view },
      {
        path: '/chat/:sessionId/trajectory',
        name: 'trajectory',
        component: view,
      },
      { path: '/scheduler', name: 'scheduler', component: view },
      { path: '/capabilities', name: 'capabilities', component: view },
      { path: '/explore', name: 'explore', component: view },
      { path: '/pulls', name: 'pulls', component: view },
    ],
  })
  await router.push(path)
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    render: () =>
      h(SidebarRail, {
        sidebarCollapsed: collapsed,
        'onNew-chat': () => emitted.push('new-chat'),
        onSearch: () => emitted.push('search'),
        'onToggle-sidebar': () => emitted.push('toggle-sidebar'),
      }),
  })
  app.config.warnHandler = () => undefined
  app.use(router)
  app.mount(root)
  await nextTick()
  return root
}

function labels(selector: string): string[] {
  return [...root.querySelectorAll<HTMLElement>(`${selector} button`)].map(
    (button) => button.getAttribute('aria-label') ?? '',
  )
}

function button(label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.getAttribute('aria-label') === label,
  )
  if (!found) throw new Error(`no rail button ${label}`)
  return found
}

it('lists new chat, search, sessions and the pages on top; notifications and settings at the foot', async () => {
  await mount()
  expect(labels('[data-rail-group="main"]')).toEqual([
    '新对话',
    '搜索',
    '会话',
    '定时任务',
    '能力',
    'Pull Request',
  ])
  expect(labels('[data-rail-group="foot"]')).toEqual(['通知', '设置'])
  // Every rail button is the 36px IconButton.
  for (const item of root.querySelectorAll('.app-rail button'))
    expect((item as HTMLElement).dataset.size).toBe('lg')
})

it('hides Pull Request while the GitHub plugin is unavailable (test 8)', async () => {
  mock.context.boot = ref({ plugins: [github('disabled')] })
  await mount()
  expect(labels('[data-rail-group="main"]')).not.toContain('Pull Request')
  app?.unmount()
  root.remove()
  mock.context.boot = ref({ plugins: [] })
  await mount()
  expect(labels('[data-rail-group="main"]')).not.toContain('Pull Request')
})

it('marks the entry of the current route selected', async () => {
  await mount('/chat/s1')
  expect(button('会话').hasAttribute('data-selected')).toBe(true)
  expect(button('会话').getAttribute('aria-current')).toBe('page')
  await router.push('/scheduler')
  await nextTick()
  expect(button('会话').hasAttribute('data-selected')).toBe(false)
  expect(button('定时任务').getAttribute('aria-current')).toBe('page')
  expect(root.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
})

it('opens pages, starts a chat, searches and toggles the sidebar from 会话', async () => {
  await mount('/chat/s1')
  button('能力').click()
  await vi.waitFor(() =>
    expect(router.currentRoute.value.name).toBe('capabilities'),
  )
  // Away from the conversation, 会话 goes back to it.
  button('会话').click()
  await vi.waitFor(() =>
    expect(router.currentRoute.value.fullPath).toBe('/chat/s1'),
  )
  expect(emitted).toEqual([])
  // On the conversation, it shows or hides the sidebar.
  button('会话').click()
  button('新对话').click()
  button('搜索').click()
  expect(emitted).toEqual(['toggle-sidebar', 'new-chat', 'search'])
})

it('says what 会话 does next and keeps its name', async () => {
  await mount('/chat/s1', true)
  expect(button('会话').getAttribute('aria-expanded')).toBe('false')
  app?.unmount()
  root.remove()
  await mount('/chat/s1', false)
  expect(button('会话').getAttribute('aria-expanded')).toBe('true')
})

it('reserves a drag region at its top for the traffic lights (tests 1–3)', async () => {
  await mount()
  const top = root.querySelector<HTMLElement>('.app-rail > .rail-top')!
  expect(top).not.toBeNull()
  expect(top.hasAttribute('data-app-drag')).toBe(true)
  // No control lives in the drag region.
  expect(top.querySelector('button, a, input, [tabindex]')).toBeNull()
  // The buttons sit outside it.
  for (const item of root.querySelectorAll('.app-rail button'))
    expect(item.closest('[data-app-drag]')).toBeNull()
})
