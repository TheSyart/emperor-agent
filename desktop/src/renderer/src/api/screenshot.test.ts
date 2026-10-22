// UI-S04: the composer's + › 截图 over the preload bridge.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureScreenshot, screenshotSupported } from './screenshot'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function bridge(value: Record<string, unknown> | undefined) {
  vi.stubGlobal('window', value === undefined ? {} : { emperor: value })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('screenshot bridge', () => {
  it('exists only in the desktop app on macOS', () => {
    bridge(undefined)
    expect(screenshotSupported()).toBe(false)
    bridge({ platform: 'linux', captureScreenshot: async () => null })
    expect(screenshotSupported()).toBe(false)
    bridge({ platform: 'darwin' })
    expect(screenshotSupported()).toBe(false)
    bridge({ platform: 'darwin', captureScreenshot: async () => null })
    expect(screenshotSupported()).toBe(true)
  })

  it('turns the captured PNG into a file to attach', async () => {
    bridge({
      platform: 'darwin',
      captureScreenshot: async () => ({
        ok: true,
        name: '截图 2026-10-20 11.05.32.png',
        mime: 'image/png',
        data: PNG,
      }),
    })
    const file = await captureScreenshot()
    expect(file).toBeInstanceOf(File)
    expect(file?.name).toBe('截图 2026-10-20 11.05.32.png')
    expect(file?.type).toBe('image/png')
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(PNG)
  })

  it('answers null when the user cancelled or a capture is already open', async () => {
    for (const reason of ['cancelled', 'busy']) {
      bridge({
        platform: 'darwin',
        captureScreenshot: async () => ({ ok: false, reason, message: '' }),
      })
      expect(await captureScreenshot()).toBeNull()
    }
  })

  it('throws what went wrong otherwise', async () => {
    bridge({
      platform: 'darwin',
      captureScreenshot: async () => ({
        ok: false,
        reason: 'permission',
        message: '没有屏幕录制权限',
      }),
    })
    await expect(captureScreenshot()).rejects.toThrow('没有屏幕录制权限')
    bridge(undefined)
    await expect(captureScreenshot()).rejects.toThrow('截图只在')
  })
})
