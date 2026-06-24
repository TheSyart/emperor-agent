import { describe, expect, it } from 'vitest'
import { resolveAppIconPath } from './icon'

describe('resolveAppIconPath', () => {
  it('resolves the dev icon from the electron main output directory', () => {
    expect(
      resolveAppIconPath({
        dirname: '/repo/desktop/out/main',
        isPackaged: false,
        resourcesPath: '/ignored',
      }),
    ).toBe('/repo/desktop/build/icon.png')
  })

  it('resolves the packaged icon from Electron resources', () => {
    expect(
      resolveAppIconPath({
        dirname: '/Applications/Emperor Agent.app/Contents/Resources/app.asar/out/main',
        isPackaged: true,
        resourcesPath: '/Applications/Emperor Agent.app/Contents/Resources',
      }),
    ).toBe('/Applications/Emperor Agent.app/Contents/Resources/icon.png')
  })
})
