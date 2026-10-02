import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const main = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const app = readFileSync(join(__dirname, '../renderer/src/App.vue'), 'utf8')

describe('Chrome 和 Edge wiring', () => {
  it('starts the extension folder upkeep once the bridge is up, and hands it to Settings', () => {
    expect(main).toContain('createBrowserExtensionService(')
    const started = main.indexOf('browserExtension?.start()')
    expect(started).toBeGreaterThan(main.indexOf('nmBridge.startOrDegrade()'))
    expect(main).toMatch(
      /registerDesktopCapabilityIpc\(\{[\s\S]*browserExtension[\s\S]*externalAttachedTabs:/,
    )
    expect(main).toContain('browserExtension?.dispose()')
  })

  it('shows 电脑操作 › Chrome 和 Edge when an extension asks to pair', () => {
    expect(main).toMatch(
      /event\.type !== 'pairing'[\s\S]{0,300}BROWSER_PAIRING_REQUEST_CHANNEL/,
    )
    expect(app).toMatch(
      /onBrowserPairingRequest\(\(\) => \{\s*void settingsRoute\.openSettings\('computer', 'chrome'\)/,
    )
  })
})
