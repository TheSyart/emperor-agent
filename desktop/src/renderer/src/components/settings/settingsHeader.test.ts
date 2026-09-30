// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SettingsHeaderBar from './SettingsHeaderBar.vue'
import {
  SETTINGS_HEADER_KEY,
  createSettingsHeader,
  refreshAction,
  useSettingsHeader,
  useSettingsPages,
  type SettingsHeaderAction,
  type SettingsHeaderHost,
  type SettingsPages,
} from './settingsHeader'

let app: App | null = null
let container: HTMLDivElement | null = null

function mount(render: () => ReturnType<typeof h>, host?: SettingsHeaderHost) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(defineComponent({ render }))
  if (host) app.provide(SETTINGS_HEADER_KEY, host)
  app.mount(container)
  return container
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
})

describe('settings header registry', () => {
  it('collects actions from sections and drops them on unmount', async () => {
    const host = createSettingsHeader()
    const show = ref(true)
    const dirty = ref(false)
    const Section = defineComponent({
      setup() {
        useSettingsHeader({
          actions: () => [
            refreshAction(() => undefined),
            { id: 'save', label: '保存', disabled: !dirty.value },
          ],
        })
        return () => h('div')
      },
    })
    mount(() => (show.value ? h(Section) : h('div')), host)

    expect(host.actions.value.map((action) => action.id)).toEqual([
      'refresh',
      'save',
    ])
    expect(host.actions.value[1].disabled).toBe(true)
    dirty.value = true
    expect(host.actions.value[1].disabled).toBe(false)

    show.value = false
    await nextTick()
    expect(host.actions.value).toEqual([])
  })

  it('is a no-op outside a settings shell', () => {
    const Section = defineComponent({
      setup() {
        useSettingsHeader({ actions: [refreshAction(() => undefined)] })
        return () => h('p', 'ok')
      },
    })
    expect(mount(() => h(Section)).textContent).toBe('ok')
  })

  it('builds the standard refresh action', () => {
    const onClick = vi.fn()
    expect(refreshAction(onClick, { title: '刷新列表' })).toEqual({
      id: 'refresh',
      label: '刷新',
      kind: 'refresh',
      onClick,
      title: '刷新列表',
    })
  })
})

describe('SettingsHeaderBar', () => {
  it('renders kinds consistently and disables while a promise is pending', async () => {
    let resolve: () => void = () => {}
    const onRefresh = vi.fn(
      () => new Promise<void>((done) => (resolve = () => done())),
    )
    const onSave = vi.fn()
    const actions: SettingsHeaderAction[] = [
      refreshAction(onRefresh),
      { id: 'save', label: '保存', kind: 'primary', onClick: onSave },
    ]
    const root = mount(() => h(SettingsHeaderBar, { actions }))

    const refresh = root.querySelector<HTMLButtonElement>(
      '[data-action="refresh"]',
    )!
    const save = root.querySelector<HTMLButtonElement>('[data-action="save"]')!
    expect(refresh.getAttribute('aria-label')).toBe('刷新')
    expect(refresh.classList.contains('ds-icon-button')).toBe(true)
    expect(save.dataset.variant).toBe('primary')
    expect(save.dataset.size).toBe('sm')

    refresh.click()
    await nextTick()
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(refresh.disabled).toBe(true)
    expect(refresh.querySelector('.spinning')).not.toBeNull()
    resolve()
    await new Promise((done) => setTimeout(done, 0))
    await nextTick()
    expect(refresh.disabled).toBe(false)

    save.click()
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('opens a dropdown for menu actions and runs the picked item', async () => {
    const onPaste = vi.fn()
    const actions: SettingsHeaderAction[] = [
      {
        id: 'add',
        label: '新增',
        menu: [
          { id: 'paste', label: '粘贴 JSON', onSelect: onPaste },
          { id: 'url', label: '从 URL 导入', onSelect: vi.fn() },
        ],
      },
    ]
    const root = mount(() => h(SettingsHeaderBar, { actions }))
    const trigger = root.querySelector<HTMLButtonElement>(
      '[data-action="add"]',
    )!
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    trigger.click()
    await nextTick()
    await nextTick()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const item = document.body.querySelector<HTMLButtonElement>(
      '[data-menu-item="paste"]',
    )!
    item.click()
    await nextTick()
    expect(onPaste).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('settings sub pages', () => {
  it('names the open sub page only while the section declares it', async () => {
    const host = createSettingsHeader()
    const show = ref(true)
    let pages: SettingsPages | null = null
    const Section = defineComponent({
      setup() {
        pages = useSettingsPages({ chrome: 'Chrome 和 Edge', apps: '任意应用' })
        return () => h('div')
      },
    })
    mount(() => (show.value ? h(Section) : h('div')), host)

    expect(host.page.value).toBeNull()
    expect(host.trail.value).toBeNull()
    pages!.open('chrome')
    expect(pages!.page.value).toBe('chrome')
    expect(host.trail.value).toBe('Chrome 和 Edge')
    // A key the section did not declare is its main page.
    host.openPage('nope')
    expect(host.page.value).toBeNull()
    expect(host.trail.value).toBeNull()
    host.openPage('apps')
    pages!.back()
    expect(host.page.value).toBeNull()

    host.openPage('apps')
    show.value = false
    await nextTick()
    expect(host.trail.value).toBeNull()
  })

  it('follows the navigation the shell gives it', () => {
    const requested = ref<string | null>('chrome')
    const go = vi.fn((page: string | null) => {
      requested.value = page
    })
    const host = createSettingsHeader({ page: () => requested.value, go })
    const undeclare = host.registerPages(() => ({ chrome: 'Chrome 和 Edge' }))
    expect(host.trail.value).toBe('Chrome 和 Edge')
    host.back()
    expect(go).toHaveBeenLastCalledWith(null)
    expect(host.trail.value).toBeNull()
    host.openPage('chrome')
    expect(go).toHaveBeenLastCalledWith('chrome')
    undeclare()
    expect(host.page.value).toBeNull()
  })

  it('keeps the open sub page in memory outside a settings shell', async () => {
    let pages: SettingsPages | null = null
    const Section = defineComponent({
      setup() {
        pages = useSettingsPages({ detail: '详情' })
        return () => h('p', pages!.page.value ?? 'main')
      },
    })
    const root = mount(() => h(Section))
    expect(root.textContent).toBe('main')
    pages!.open('detail')
    await nextTick()
    expect(root.textContent).toBe('detail')
    pages!.back()
    await nextTick()
    expect(root.textContent).toBe('main')
  })
})
