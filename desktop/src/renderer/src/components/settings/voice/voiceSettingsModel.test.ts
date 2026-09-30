import { describe, expect, it } from 'vitest'
import type { DictationStatus } from '../../../api/dictation'
import { defaultDictationSettings } from '../../../dictation/settings'
import {
  deviceChoice,
  helperView,
  localeChoice,
  permissionView,
} from './voiceSettingsModel'

const status: DictationStatus = {
  supported: true,
  available: true,
  engine: 'sf-speech',
  permissions: { microphone: 'granted', speech: 'undetermined' },
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

describe('voice settings view', () => {
  it('describes each permission state and when System Settings helps', () => {
    expect(permissionView('microphone', 'granted')).toMatchObject({
      label: '已允许',
      tone: 'ok',
      canOpen: false,
    })
    expect(permissionView('speech', 'undetermined')).toMatchObject({
      label: '尚未询问',
      canOpen: false,
    })
    const denied = permissionView('speech', 'denied')
    expect(denied).toMatchObject({
      label: '已拒绝',
      tone: 'error',
      canOpen: true,
    })
    expect(denied.hint).toContain('语音识别')
    expect(permissionView('microphone', 'restricted')).toMatchObject({
      tone: 'warn',
      canOpen: false,
    })
    expect(permissionView('microphone', 'unknown').label).toBe('未知')
  })

  it('shows the helper as available, busy or missing with the reason', () => {
    expect(helperView(null).badge).toBe('检测中')
    expect(helperView(status)).toEqual({
      badge: '可用',
      tone: 'ok',
      description: '本机识别 · SFSpeechRecognizer',
    })
    expect(helperView({ ...status, active: true }).badge).toBe('听写中')
    expect(
      helperView({
        ...status,
        available: false,
        reason: 'Emperor Dictation Helper 无法启动',
      }),
    ).toEqual({
      badge: '不可用',
      tone: 'error',
      description: 'Emperor Dictation Helper 无法启动',
    })
  })

  it('offers the system default and the connected microphones only', () => {
    const choice = deviceChoice(status, defaultDictationSettings())
    expect(choice.options.map((option) => option.label)).toEqual([
      '系统默认（MacBook Pro麦克风）',
      'MacBook Pro麦克风',
      'USB 麦克风',
    ])
    expect(choice.options[0]!.value).toBe('')
    expect(choice.tone).toBeNull()
  })

  it('keeps a saved microphone that went away visible, marked', () => {
    const choice = deviceChoice(status, {
      ...defaultDictationSettings(),
      device: 'Headset-1',
      deviceName: 'AirPods',
    })
    expect(choice.options.at(-1)).toMatchObject({
      value: 'Headset-1',
      label: 'AirPods（未连接）',
    })
    expect(choice.tone).toBe('warn')
    expect(choice.description).toContain('系统默认')
    expect(
      deviceChoice({ ...status, devices: [] }, defaultDictationSettings()),
    ).toMatchObject({ tone: 'error' })
  })

  it('claims nothing about devices or languages while the helper is away', () => {
    const away: DictationStatus = {
      ...status,
      available: false,
      reason: 'Emperor Dictation Helper 无法启动',
      devices: [],
      locales: [],
      systemLocale: null,
    }
    const settings = {
      ...defaultDictationSettings(),
      device: 'USB-Mic-1',
      deviceName: 'USB 麦克风',
      locale: 'en-US',
    }
    const device = deviceChoice(away, settings)
    expect(device).toMatchObject({ tone: null })
    expect(device.description).toContain('听写组件可用后')
    expect(device.options.map((option) => option.label)).toEqual([
      '系统默认',
      'USB 麦克风',
    ])
    const locale = localeChoice(away, settings)
    expect(locale).toMatchObject({ tone: null })
    expect(locale.options.map((option) => option.label)).toEqual([
      '跟随系统',
      'en-US',
    ])
  })

  it('follows the system language by name, and lists on-device languages only', () => {
    const choice = localeChoice(status, defaultDictationSettings())
    expect(choice.options.map((option) => option.label)).toEqual([
      '跟随系统（中文（中国大陆））',
      '英语（美国）',
      '中文（中国大陆）',
    ])
    expect(choice.tone).toBeNull()
    const foreign = localeChoice(
      { ...status, systemLocale: 'ja-JP' },
      defaultDictationSettings(),
    )
    expect(foreign.options[0]!.label).toBe('跟随系统')
    expect(foreign.tone).toBe('warn')
  })

  it('marks a chosen language this Mac can no longer recognize', () => {
    const choice = localeChoice(status, {
      ...defaultDictationSettings(),
      locale: 'fr-FR',
    })
    expect(choice.options.at(-1)).toMatchObject({
      value: 'fr-FR',
      label: 'fr-FR（不能本机识别）',
    })
    expect(choice.tone).toBe('warn')
    expect(
      localeChoice({ ...status, locales: [] }, defaultDictationSettings()).tone,
    ).toBe('error')
  })
})
