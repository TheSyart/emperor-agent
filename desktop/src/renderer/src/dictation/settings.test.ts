// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DICTATION_SHORTCUT,
  DICTATION_SETTINGS_KEY,
  defaultDictationSettings,
  readDictationSettings,
  resetDictationSettingsForTest,
  useDictationSettings,
} from './settings'

afterEach(() => {
  localStorage.clear()
  resetDictationSettingsForTest()
  vi.restoreAllMocks()
})

describe('dictation settings', () => {
  it('starts from the system language, the default microphone and ⇧⌘D', () => {
    expect(readDictationSettings()).toEqual({
      locale: null,
      device: null,
      deviceName: null,
      shortcut: DEFAULT_DICTATION_SHORTCUT,
    })
    expect(DEFAULT_DICTATION_SHORTCUT).toBe('Shift+Command+D')
  })

  it('keeps choices across a restart', () => {
    const { update, settings } = useDictationSettings()
    expect(
      update({
        locale: 'en-US',
        device: 'USB-Mic-1',
        deviceName: 'USB 麦克风',
        shortcut: 'Control+Alt+D',
      }),
    ).toBe(true)
    expect(settings.value.locale).toBe('en-US')
    // A new window reads them back from storage.
    resetDictationSettingsForTest()
    expect(useDictationSettings().settings.value).toEqual({
      locale: 'en-US',
      device: 'USB-Mic-1',
      deviceName: 'USB 麦克风',
      shortcut: 'Control+Alt+D',
    })
  })

  it('shares one copy between the settings page and the editor', () => {
    const page = useDictationSettings()
    const editor = useDictationSettings()
    page.update({ locale: 'zh-CN' })
    expect(editor.settings.value.locale).toBe('zh-CN')
  })

  it('drops whatever it cannot trust, field by field', () => {
    localStorage.setItem(DICTATION_SETTINGS_KEY, 'not json')
    expect(readDictationSettings()).toEqual(defaultDictationSettings())
    localStorage.setItem(
      DICTATION_SETTINGS_KEY,
      JSON.stringify({
        locale: '../etc',
        device: 'USB-Mic-1',
        deviceName: 7,
        shortcut: 'D',
      }),
    )
    expect(readDictationSettings()).toEqual({
      ...defaultDictationSettings(),
      device: 'USB-Mic-1',
    })
  })

  it('still works when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { settings, update } = useDictationSettings()
    expect(settings.value).toEqual(defaultDictationSettings())
    expect(update({ locale: 'en-US' })).toBe(false)
    expect(settings.value.locale).toBe('en-US')
  })
})
