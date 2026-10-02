import { describe, expect, it } from 'vitest'
import { protectedMacApp } from './protected-apps'

describe('macOS desktop target protection', () => {
  it('rejects Emperor, authorization, passwords and login windows by bundle ID', () => {
    for (const id of [
      'com.emperor.agent.desktop',
      'com.emperor.agent.desktop.helper.Renderer',
      'com.emperor.agent.desktop.computer-helper',
      'com.apple.SecurityAgent',
      'com.apple.CoreAuthUI',
      'com.apple.LocalAuthentication.UIAgent',
      'com.apple.Passwords',
      'com.apple.systempreferences',
      'com.apple.systempreferences.GeneralSettings',
      'com.apple.systempreferences.AppleIDSettings',
      'com.apple.HeadphoneSettings',
      'com.apple.loginwindow',
    ])
      expect(protectedMacApp(id)).toBe(true)
    expect(protectedMacApp('com.apple.TextEdit')).toBe(false)
    expect(protectedMacApp('com.emperor.agent.desktopish')).toBe(false)
    expect(protectedMacApp('com.apple.systempreferencesMalicious')).toBe(false)
  })

  it('treats terminal and automation apps as ordinary apps', () => {
    for (const id of [
      'com.apple.Terminal',
      'com.googlecode.iterm2',
      'com.apple.ScriptEditor2',
      'com.apple.shortcuts',
    ])
      expect(protectedMacApp(id)).toBe(false)
  })
})
