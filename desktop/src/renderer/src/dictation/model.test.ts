import { describe, expect, it } from 'vitest'
import type { DictationStatus } from '../api/dictation'
import {
  acceleratorMatches,
  dictationRequest,
  parseAccelerator,
  resolveDictationLocale,
  shortcutConflict,
} from './model'
import { defaultDictationSettings } from './settings'

const locales = [
  { id: 'en-GB', name: '英语（英国）' },
  { id: 'en-US', name: '英语（美国）' },
  { id: 'zh-CN', name: '中文（中国大陆）' },
]

const status: DictationStatus = {
  supported: true,
  available: true,
  engine: 'sf-speech',
  permissions: { microphone: 'granted', speech: 'granted' },
  devices: [
    { id: 'BuiltInMicrophoneDevice', name: 'MacBook Pro麦克风', default: true },
    { id: 'USB-Mic-1', name: 'USB 麦克风', default: false },
  ],
  locales,
  systemLocale: 'zh-Hans-US',
  active: false,
}

describe('dictation locale', () => {
  it('follows the system language the way the helper does', () => {
    expect(resolveDictationLocale(null, 'zh-Hans-US', locales)?.id).toBe(
      'zh-CN',
    )
    expect(resolveDictationLocale(null, 'en_GB', locales)?.id).toBe('en-GB')
    expect(resolveDictationLocale(null, 'en-AU', locales)?.id).toBe('en-GB')
    expect(
      resolveDictationLocale(null, 'en-GB-u-mu-celsius', locales)?.id,
    ).toBe('en-GB')
    expect(resolveDictationLocale(null, 'ja-JP', locales)).toBeNull()
  })

  it('never swaps a chosen language for another', () => {
    expect(resolveDictationLocale('en-US', 'zh-CN', locales)?.id).toBe('en-US')
    expect(resolveDictationLocale('en-AU', 'zh-CN', locales)).toBeNull()
    expect(resolveDictationLocale('en', 'zh-CN', locales)?.id).toBe('en-GB')
  })
})

describe('dictation request', () => {
  it('uses the saved microphone and language while this Mac has them', () => {
    expect(
      dictationRequest(
        {
          ...defaultDictationSettings(),
          device: 'USB-Mic-1',
          deviceName: 'USB 麦克风',
          locale: 'en-US',
        },
        status,
      ),
    ).toEqual({ device: 'USB-Mic-1', locale: 'en-US' })
    expect(dictationRequest(defaultDictationSettings(), status)).toEqual({
      device: null,
      locale: null,
    })
  })

  it('falls back to the defaults when a saved device or language went away', () => {
    expect(
      dictationRequest(
        {
          ...defaultDictationSettings(),
          device: 'Unplugged-Mic',
          deviceName: '耳机',
          locale: 'fr-FR',
        },
        status,
      ),
    ).toEqual({ device: null, locale: null })
  })
})

describe('dictation shortcut', () => {
  it('parses accelerators in any modifier order', () => {
    expect(parseAccelerator('Command+Shift+D')).toEqual({
      control: false,
      alt: false,
      shift: true,
      command: true,
      key: 'D',
    })
    expect(parseAccelerator('Shift+Cmd+d')).toEqual(
      parseAccelerator('Command+Shift+D'),
    )
    for (const bad of ['D', 'Shift+D', 'Command+', 'Command+Command+D', ''])
      expect(parseAccelerator(bad), bad).toBeNull()
  })

  it('matches a key press by physical key', () => {
    const press = {
      code: 'KeyD',
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      metaKey: true,
    }
    expect(acceleratorMatches(press, 'Command+Shift+D', true)).toBe(true)
    expect(
      acceleratorMatches(
        { ...press, shiftKey: false },
        'Command+Shift+D',
        true,
      ),
    ).toBe(false)
    expect(acceleratorMatches(press, 'nonsense', true)).toBe(false)
  })

  it('refuses app shortcuts and system shortcuts', () => {
    const context = { mac: true }
    expect(shortcutConflict('Command+Shift+D', context)).toBeNull()
    // The retired emergency stop's chord is free now.
    expect(shortcutConflict('Alt+Control+Command+.', context)).toBeNull()
    expect(shortcutConflict('Command+K', context)).toMatch(/搜索/)
    expect(shortcutConflict('Control+`', context)).toMatch(/终端/)
    expect(shortcutConflict('Command+Q', context)).toMatch(/退出/)
    // The app menu's 偏好设置… (SEC-05).
    expect(shortcutConflict('Command+,', context)).toMatch(/偏好设置/)
    expect(shortcutConflict('Command+Space', context)).toMatch(/聚焦/)
    expect(shortcutConflict('Control+Space', context)).toMatch(/输入法/)
    expect(shortcutConflict('Shift+D', context)).toMatch(/⌃|⌥|⌘/)
  })
})
