// REL-05: the renderer reads the running app's version over the preload
// bridge (main answers app.getVersion()).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAppVersion } from './appVersion'

function bridge(value: Record<string, unknown> | undefined) {
  vi.stubGlobal('window', value === undefined ? {} : { emperor: value })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('app version bridge (REL-05 test 5)', () => {
  it('is what main reports', async () => {
    const appVersion = vi.fn(async () => '0.2.0')
    bridge({ appVersion })

    expect(await readAppVersion()).toBe('0.2.0')
    expect(appVersion).toHaveBeenCalledOnce()
  })

  it('is null outside the desktop app or when main answers nothing usable', async () => {
    bridge(undefined)
    expect(await readAppVersion()).toBeNull()
    bridge({ version: '0.1.0' })
    expect(await readAppVersion()).toBeNull()
    bridge({ appVersion: async () => '' })
    expect(await readAppVersion()).toBeNull()
    bridge({ appVersion: async () => 42 })
    expect(await readAppVersion()).toBeNull()
    bridge({
      appVersion: async () => {
        throw new Error('no handler')
      },
    })
    expect(await readAppVersion()).toBeNull()
  })
})
