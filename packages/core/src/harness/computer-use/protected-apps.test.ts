import { describe, expect, it } from 'vitest'
import { highRiskMacApp, protectedMacApp } from './protected-apps'

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

  it('requires special treatment for terminal and automation apps', () => {
    expect(highRiskMacApp('com.apple.Terminal')).toBe(true)
    expect(highRiskMacApp('com.apple.ScriptEditor2')).toBe(true)
    expect(highRiskMacApp('com.apple.TextEdit')).toBe(false)
  })
})
