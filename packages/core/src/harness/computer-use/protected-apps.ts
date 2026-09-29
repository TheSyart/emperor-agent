/** macOS targets the helper must also refuse (spec 01 §4.4). */
const EXACT = new Set([
  'com.apple.SecurityAgent',
  'com.apple.UserNotificationCenter',
  'com.apple.CoreAuthUI',
  // E-M12: on macOS 26 the Touch ID / password prompt of LocalAuthentication
  // is shown by coreautha, not CoreAuthUI.
  'com.apple.LocalAuthentication.UIAgent',
  'com.apple.keychainaccess',
  'com.apple.Passwords',
  'com.apple.systempreferences',
  'com.apple.HeadphoneSettings',
  'com.apple.loginwindow',
  'com.apple.ScreenSaver.Engine',
])

const HIGH_RISK = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'com.mitchellh.ghostty',
  'com.apple.ScriptEditor2',
  'com.apple.Automator',
  'com.apple.shortcuts',
])

export function protectedMacApp(appId: string): boolean {
  return (
    appId === 'com.emperor.agent.desktop' ||
    appId.startsWith('com.emperor.agent.desktop.') ||
    appId.startsWith('com.apple.systempreferences.') ||
    EXACT.has(appId)
  )
}

export function highRiskMacApp(appId: string): boolean {
  return HIGH_RISK.has(appId)
}
