// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { resetBrowserPreferencesForTest } from '../../composables/useBrowserPreferences'
import BrowserSettingsSection from './BrowserSettingsSection.vue'
import { createSettingsHeader, SETTINGS_HEADER_KEY } from './settingsHeader'

type Preferences = {
  enabled: boolean
  linkTarget: 'system' | 'builtin'
  showFullUrl: boolean
  history: boolean
}

let app: App | null = null
let container: HTMLDivElement | null = null
let stored: Preferences
let calls: Array<[string, unknown]> = []
let coreListeners: Array<(event: unknown) => void> = []

const context = {
  runSafely: vi.fn(async (task: () => Promise<void>) => await task()),
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

function mount(): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(BrowserSettingsSection) })
  app.provide(APP_CONTEXT_KEY, context as never)
  app.provide(SETTINGS_HEADER_KEY, createSettingsHeader())
  app.mount(container)
  return container
}

function control(root: HTMLElement, id: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`#${id}`)!
}

beforeEach(() => {
  resetBrowserPreferencesForTest()
  stored = {
    enabled: true,
    linkTarget: 'system',
    showFullUrl: true,
    history: true,
  }
  calls = []
  coreListeners = []
  ;(window as unknown as { emperor: unknown }).emperor = {
    invokeCore: async (key: string, input?: unknown) => {
      calls.push([key, input])
      if (key === 'browser.setPreferences')
        stored = { ...stored, ...(input as Partial<Preferences>) }
      return stored
    },
    onCoreEvent: (listener: (event: unknown) => void) => {
      coreListeners.push(listener)
      return () => undefined
    },
  }
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  delete (window as unknown as { emperor?: unknown }).emperor
})

describe('BrowserSettingsSection', () => {
  it('shows the stored settings: system browser for links by default', async () => {
    const root = mount()
    await settle()
    expect(calls[0]).toEqual(['browser.preferences', undefined])
    expect(control(root, 'browser-enabled').getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(control(root, 'browser-link-target').textContent).toContain(
      '系统默认浏览器',
    )
    expect(control(root, 'browser-full-url').getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  it('saves each change at once and disables the rest while the browser is off', async () => {
    const root = mount()
    await settle()
    control(root, 'browser-full-url').click()
    await settle()
    expect(calls).toContainEqual([
      'browser.setPreferences',
      { showFullUrl: false },
    ])
    expect(control(root, 'browser-full-url').getAttribute('aria-checked')).toBe(
      'false',
    )
    control(root, 'browser-enabled').click()
    await settle()
    expect(calls).toContainEqual(['browser.setPreferences', { enabled: false }])
    expect(control(root, 'browser-link-target').disabled).toBe(true)
    expect(control(root, 'browser-full-url').disabled).toBe(true)
  })

  it('follows a change another window made', async () => {
    const root = mount()
    await settle()
    for (const listener of coreListeners)
      listener({
        event: 'browser_preferences_changed',
        preferences: { ...stored, linkTarget: 'builtin' },
      })
    await settle()
    expect(control(root, 'browser-link-target').textContent).toContain(
      'Emperor 内置浏览器',
    )
  })
})
