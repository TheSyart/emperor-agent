// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationStatus } from '../../api/dictation'
import {
  DICTATION_SETTINGS_KEY,
  resetDictationSettingsForTest,
} from '../../dictation/settings'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import {
  createSettingsHeader,
  SETTINGS_HEADER_KEY,
  type SettingsHeaderHost,
} from './settingsHeader'
import VoiceSettingsSection from './VoiceSettingsSection.vue'

const { dictationStatus, openDictationPrivacy } = vi.hoisted(() => ({
  dictationStatus: vi.fn(),
  openDictationPrivacy: vi.fn(),
}))

vi.mock('../../api/dictation', () => ({
  dictationStatus,
  openDictationPrivacy,
}))

const ready: DictationStatus = {
  supported: true,
  available: true,
  engine: 'sf-speech',
  permissions: { microphone: 'granted', speech: 'granted' },
  devices: [
    { id: 'BuiltInMicrophoneDevice', name: 'MacBook Pro麦克风', default: true },
    { id: 'USB-Mic-1', name: 'USB 麦克风', default: false },
  ],
  locales: [
    { id: 'en-US', name: '英语（美国）' },
    { id: 'zh-CN', name: '中文（中国大陆）' },
  ],
  systemLocale: 'zh-Hans-US',
  active: false,
}

let app: App | null = null
let container: HTMLDivElement | null = null
let header: SettingsHeaderHost

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  header = createSettingsHeader()
  app = createApp({ render: () => h(VoiceSettingsSection) })
  app.provide(APP_CONTEXT_KEY, {
    runSafely: async (task: () => Promise<void>) => task(),
  } as never)
  app.provide(SETTINGS_HEADER_KEY, header)
  app.mount(container)
  await settle()
  return container
}

function unmount(): void {
  app?.unmount()
  app = null
  container?.remove()
  container = null
}

function row(root: HTMLElement, title: string): HTMLElement {
  const found = [
    ...root.querySelectorAll<HTMLElement>('.ds-settings-row'),
  ].find(
    (element) =>
      element.querySelector(':scope > .text .title')?.textContent?.trim() ===
      title,
  )
  if (!found) throw new Error(`no row ${title}`)
  return found
}

async function pick(root: HTMLElement, title: string, label: string) {
  const trigger = row(root, title).querySelector<HTMLButtonElement>(
    '.ds-select',
  )!
  trigger.click()
  await settle()
  const item = [
    ...document.body.querySelectorAll<HTMLButtonElement>(
      '[role="menu"] [role="menuitem"]',
    ),
  ].find((element) => element.textContent?.includes(label))
  if (!item) throw new Error(`no option ${label}`)
  item.click()
  await settle()
}

function saved(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(DICTATION_SETTINGS_KEY) ?? '{}')
}

beforeEach(() => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  dictationStatus.mockResolvedValue(ready)
  openDictationPrivacy.mockResolvedValue(true)
})

afterEach(() => {
  unmount()
  localStorage.clear()
  resetDictationSettingsForTest()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('VoiceSettingsSection', () => {
  it('says dictation is not supported on Windows and Linux', async () => {
    dictationStatus.mockResolvedValue({
      ...ready,
      supported: false,
      available: false,
      reason: '听写目前只支持 macOS',
      devices: [],
      locales: [],
      permissions: { microphone: 'unknown', speech: 'unknown' },
    })
    const root = await mount()
    expect(root.textContent).toContain('暂不支持')
    expect(root.textContent).toContain('听写目前只支持 macOS')
    expect(root.querySelector('.ds-select')).toBeNull()
  })

  it('shows why the helper is unavailable and checks again on refresh', async () => {
    dictationStatus.mockResolvedValueOnce({
      ...ready,
      available: false,
      reason: 'Emperor Dictation Helper 无法启动',
      engine: null,
      devices: [],
      locales: [],
      permissions: { microphone: 'unknown', speech: 'unknown' },
    })
    const root = await mount()
    const helper = row(root, '听写组件')
    expect(helper.textContent).toContain('不可用')
    expect(helper.textContent).toContain('Emperor Dictation Helper 无法启动')
    await header.actions.value.find((action) => action.id === 'refresh')!
      .onClick!()
    await settle()
    expect(dictationStatus).toHaveBeenCalledTimes(2)
    // Available again: the row has nothing to say any more.
    expect(() => row(root, '听写组件')).toThrow()
  })

  it('keeps quiet about a working helper and merges two granted permissions', async () => {
    const root = await mount()
    expect(() => row(root, '听写组件')).toThrow()
    expect(root.querySelector('[data-testid="dictation-helper"]')).toBeNull()
    const both = row(root, '麦克风和语音识别')
    expect(both.textContent).toContain('已允许')
    expect(() => row(root, '麦克风权限')).toThrow()
    expect(() => row(root, '语音识别权限')).toThrow()
  })

  it('checks again when the window comes back from System Settings', async () => {
    await mount()
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(dictationStatus).toHaveBeenCalledTimes(2)
  })

  it('shows both permissions, one row each, until both are granted', async () => {
    dictationStatus.mockResolvedValue({
      ...ready,
      permissions: { microphone: 'denied', speech: 'undetermined' },
    })
    const root = await mount()
    const microphone = row(root, '麦克风权限')
    expect(microphone.textContent).toContain('已拒绝')
    expect(row(root, '语音识别权限').textContent).toContain('尚未询问')
    expect(row(root, '语音识别权限').querySelector('button')).toBeNull()
    microphone.querySelector<HTMLButtonElement>('button')!.click()
    await settle()
    expect(openDictationPrivacy).toHaveBeenCalledWith('microphone')
  })

  it('follows the system language, and saves a language picked by hand', async () => {
    const root = await mount()
    const language = row(root, '识别语言')
    expect(language.querySelector('.ds-select')!.textContent).toContain(
      '跟随系统（中文（中国大陆））',
    )
    await pick(root, '识别语言', '英语（美国）')
    expect(saved()).toMatchObject({ locale: 'en-US' })
    await pick(root, '识别语言', '跟随系统')
    expect(saved()).toMatchObject({ locale: null })
  })

  it('saves the microphone with its name, and marks it when it went away', async () => {
    const root = await mount()
    await pick(root, '麦克风', 'USB 麦克风')
    expect(saved()).toMatchObject({
      device: 'USB-Mic-1',
      deviceName: 'USB 麦克风',
    })
    unmount()
    dictationStatus.mockResolvedValue({
      ...ready,
      devices: [ready.devices[0]!],
    })
    const again = await mount()
    const microphone = row(again, '麦克风')
    expect(microphone.textContent).toContain('USB 麦克风（未连接）')
    expect(microphone.textContent).toContain('先用系统默认')
  })

  it('refuses an Emperor shortcut, then saves a free one', async () => {
    const root = await mount()
    const shortcut = row(root, '快捷键')
    expect(shortcut.textContent).toContain('⇧⌘D')
    shortcut
      .querySelector<HTMLButtonElement>(
        '[data-testid="dictation-shortcut-edit"]',
      )!
      .click()
    await settle()
    const capture = root.querySelector<HTMLElement>(
      '[data-testid="dictation-shortcut-capture"]',
    )!
    capture.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        metaKey: true,
        bubbles: true,
      }),
    )
    await settle()
    expect(row(root, '快捷键').textContent).toContain('搜索')
    const save = () =>
      [...row(root, '快捷键').querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '保存',
      )!
    expect(save().disabled).toBe(true)
    capture.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'j',
        code: 'KeyJ',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    )
    await settle()
    expect(save().disabled).toBe(false)
    save().click()
    await settle()
    expect(saved()).toMatchObject({ shortcut: 'Shift+Command+J' })
    expect(row(root, '快捷键').textContent).toContain('⇧⌘J')
  })

  it('keeps the choices after a restart', async () => {
    const root = await mount()
    await pick(root, '识别语言', '英语（美国）')
    unmount()
    resetDictationSettingsForTest()
    const again = await mount()
    expect(
      row(again, '识别语言').querySelector('.ds-select')!.textContent,
    ).toContain('英语（美国）')
  })
})
